// reader/reader.js
// 閱讀器核心控制器 - 協調書庫 IndexedDB、五種解析器、TTS 語音朗讀、內置 AI 以及 UI 微交互

// Emulate chrome.storage.local for standalone web version (uses browser localStorage)
if (typeof chrome === 'undefined') {
  window.chrome = {};
}
if (!chrome.storage) {
  chrome.storage = {
    local: {
      get: (keys, callback) => {
        const res = {};
        const keysArray = Array.isArray(keys) ? keys : [keys];
        keysArray.forEach(k => {
          const val = localStorage.getItem(k);
          try {
            res[k] = val ? JSON.parse(val) : undefined;
          } catch (e) {
            res[k] = val;
          }
        });
        setTimeout(() => callback(res), 0);
      },
      set: (items, callback) => {
        Object.entries(items).forEach(([k, v]) => {
          localStorage.setItem(k, JSON.stringify(v));
        });
        if (callback) setTimeout(callback, 0);
      }
    }
  };
}

import { BookLibrary } from './library.js';
import { TTSEngine } from './tts.js';
import { AIEngine } from './ai.js';
import { initI18n, applyI18n, getMsg } from './i18n.js';

// 解析器導入
import { EpubParser } from './parsers/epub-parser.js';
import { Azw3Parser, decodeBase32 } from './parsers/azw3-parser.js';
import { TextParser } from './parsers/text-parser.js';
import { ComicParser } from './parsers/comic-parser.js';

// 全局實例
const library = new BookLibrary();
const tts = new TTSEngine();
const ai = new AIEngine();

// 狀態追蹤
let currentBook = null;
let currentChapterIndex = 0;
let prefetchedChapterCache = null; // 緩存背景預載的下一章 HTML 內容，避免重複讀取數據庫
let epubBookData = null; // 存儲 EPUB 解析後的對象
let comicParserInstance = null; // 漫畫解析實例
let isSavingProgress = false;
let selectedTextState = '';
let selectedTextRange = null;
let currentPageIndex = 0;
let ttsClickTimeout = null;
let currentPagesDisplayed = 'auto';
let currentPaperTexture = 'texture-classic';
let activeCoverUrls = [];
let activeResourceUrls = [];
let ttsOnlyEdge = false;
let pendingGoToLastPage = false;
let pendingGoToLastPageTimeout = null;
let isChangingChapter = false;
let lastChapterChangeTime = 0;

// 閱讀時間統計全局狀態
let readingSessionTimer = null;
let lastReadingHeartbeat = 0;
let lastUserActivityTime = 0;
const IDLE_TIMEOUT_MS = 60000; // 60秒無操作視為閒置


function clearCoverUrls() {
  activeCoverUrls.forEach(url => URL.revokeObjectURL(url));
  activeCoverUrls = [];
}

function clearResourceUrls() {
  activeResourceUrls.forEach(url => URL.revokeObjectURL(url));
  activeResourceUrls = [];
  if (epubBookData && epubBookData.resourceUrls) {
    epubBookData.resourceUrls.forEach(url => URL.revokeObjectURL(url));
    epubBookData.resourceUrls = [];
  }
  if (epubBookData && epubBookData.parser && epubBookData.parser.resourceUrls) {
    epubBookData.parser.resourceUrls.forEach(url => URL.revokeObjectURL(url));
    epubBookData.parser.resourceUrls = [];
  }
}



// ==================== 通用章節合併工具 ==================== */
// 將過短的結構性分隔章節（如「第一编」「Part I」等篇章引言）合併到下一個章節中。
// 適用於所有電子書格式（EPUB、AZW3、TXT、FB2 等）。
// 判定條件：(a) 可見文字 < 閾值  (b) 含標題元素 h1-h6  (c) 有後續章節
// 不合併：不含標題的短篇正文（詩歌、短篇小說等）
async function mergeShortChapters(chapters) {
  // 為了保持目錄（TOC）結構的 100% 完整與精確，我們不再主動合併短章節，直接返回原章節清單
  if (chapters && Array.isArray(chapters)) {
    chapters.forEach((ch, idx) => {
      if (!ch.cleanHref) {
        ch.cleanHref = ch.href ? ch.href.split('#')[0] : `chapter-${idx}`;
      }
    });
  }
  return chapters;
}

// ==================== 1. 初始化與事件綁定 ==================== */
document.addEventListener('DOMContentLoaded', async () => {
  // 0. 初始化歷史記錄狀態
  if (!history.state) {
    history.replaceState({ bookshelf: true }, '');
  }

  // 0.5 立即套用封面大小設定以防佈局抖動
  const savedWidth = localStorage.getItem('coverWidth') || '180';
  document.documentElement.style.setProperty('--cover-width', `${savedWidth}px`);

  // 1. 初始化多語言（載入後備翻譯字典 + 套用翻譯）
  await initI18n();

  // 2. 開啟資料庫並載入書架
  try {
    await library.open();
    await renderBookshelf();
  } catch (e) {
    alert(`${getMsg('failed_init_db')}: ${e.message}`);
  }

  // 3. 檢測內置 AI 支持
  await ai.checkAvailability();
  if (!ai.isSupported) {
    document.querySelectorAll('.ai-btn').forEach(btn => btn.style.display = 'none');
  }

  // 3.5 立即恢復主題設定（確保刷新頁面後主題不遺失）
  chrome.storage.local.get(['theme'], (res) => {
    if (res.theme) {
      const classesToRemove = Array.from(document.body.classList).filter(c => c.startsWith('theme-'));
      classesToRemove.forEach(c => document.body.classList.remove(c));
      document.body.classList.add(`theme-${res.theme}`);
    }
  });

  // 4. 綁定按鈕事件
  initUIEventBindings();
});

// UI 事件綁定
function initUIEventBindings() {
  // 註冊用戶活動監聽器，用於精確統計閱讀時間，防止掛機刷時長
  const recordActivity = () => {
    lastUserActivityTime = Date.now();
  };
  window.addEventListener('mousemove', recordActivity, { capture: true, passive: true });
  window.addEventListener('keydown', recordActivity, { capture: true, passive: true });
  window.addEventListener('mousedown', recordActivity, { capture: true, passive: true });
  window.addEventListener('touchstart', recordActivity, { capture: true, passive: true });
  window.addEventListener('scroll', recordActivity, { capture: true, passive: true });

  // 書庫行為
  const importBtn = document.getElementById('import-btn');
  const fileInput = document.getElementById('file-input');
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileSelect);

  // 備份與還原書庫
  const backupBtn = document.getElementById('backup-btn');
  const restoreBtn = document.getElementById('restore-btn');
  const restoreFileInput = document.getElementById('restore-file-input');
  if (backupBtn) {
    backupBtn.addEventListener('click', handleExportBackup);
  }
  if (restoreBtn && restoreFileInput) {
    restoreBtn.addEventListener('click', () => restoreFileInput.click());
    restoreFileInput.addEventListener('change', handleImportBackup);
  }

  // 閱讀統計按鈕與對話框
  const statsBtn = document.getElementById('stats-btn');
  if (statsBtn) {
    statsBtn.addEventListener('click', openGlobalStatsModal);
  }
  const closeStatsBtn = document.getElementById('close-stats-modal');
  const statsBackdrop = document.getElementById('stats-modal-backdrop');
  if (closeStatsBtn) {
    closeStatsBtn.addEventListener('click', closeStatsModal);
  }
  if (statsBackdrop) {
    statsBackdrop.addEventListener('click', closeStatsModal);
  }

  // 統計 Tab 切換
  const tabOverview = document.getElementById('stats-tab-overview');
  const tabBooks = document.getElementById('stats-tab-books');
  if (tabOverview && tabBooks) {
    tabOverview.addEventListener('click', () => switchStatsTab('overview'));
    tabBooks.addEventListener('click', () => switchStatsTab('books'));
  }

  // 統計書籍選擇器變更
  const statsBookSelect = document.getElementById('stats-book-select');
  if (statsBookSelect) {
    statsBookSelect.addEventListener('change', (e) => {
      renderBookStats(e.target.value);
    });
  }

  // 拖曳導入
  const dragOverlay = document.getElementById('drag-overlay');
  const libraryView = document.getElementById('library-view');

  window.addEventListener('dragenter', (e) => {
    if (document.getElementById('library-view').classList.contains('view-active')) {
      dragOverlay.style.display = 'flex';
    }
  });

  dragOverlay.addEventListener('dragleave', () => {
    dragOverlay.style.display = 'none';
  });

  dragOverlay.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  dragOverlay.addEventListener('drop', (e) => {
    e.preventDefault();
    dragOverlay.style.display = 'none';
    if (e.dataTransfer.files.length > 0) {
      handleImportFiles(e.dataTransfer.files);
    }
  });

  // 書籍搜尋
  document.getElementById('search-input').addEventListener('input', (e) => {
    renderBookshelf(e.target.value.trim());
  });

  // 封面大小調整
  const coverSizeSlider = document.getElementById('cover-size-slider');
  if (coverSizeSlider) {
    const savedWidth = localStorage.getItem('coverWidth') || '180';
    coverSizeSlider.value = savedWidth;
    coverSizeSlider.addEventListener('input', (e) => {
      const val = e.target.value;
      document.documentElement.style.setProperty('--cover-width', `${val}px`);
      localStorage.setItem('coverWidth', val);
    });
  }

  // 閱讀器頂部導航
  document.getElementById('close-reader-btn').addEventListener('click', closeCurrentBook);
  window.addEventListener('popstate', (e) => {
    if (!e.state || !e.state.bookId) {
      if (currentBook) {
        closeCurrentBook(false);
      }
    }
  });
  document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
  document.getElementById('tts-toggle').addEventListener('click', toggleTTSPanel);
  document.getElementById('settings-toggle').addEventListener('click', toggleSettingsPanel);

  // 閱讀設定變化
  const settingsPanel = document.getElementById('settings-panel');
  settingsPanel.querySelectorAll('.theme-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      settingsPanel.querySelectorAll('.theme-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      setTheme(dot.getAttribute('data-theme'));
    });
  });

  document.getElementById('font-family-select').addEventListener('change', (e) => {
    setFontFamily(e.target.value);
  });

  document.getElementById('font-size-slider').addEventListener('input', (e) => {
    setFontSize(e.target.value);
  });

  document.getElementById('line-height-slider').addEventListener('input', (e) => {
    setLineHeight(e.target.value);
  });

  document.getElementById('margin-width-slider').addEventListener('input', (e) => {
    setMargins(e.target.value);
  });

  document.getElementById('margin-top-slider').addEventListener('input', (e) => {
    setMarginTop(e.target.value);
  });

  document.getElementById('margin-bottom-slider').addEventListener('input', (e) => {
    setMarginBottom(e.target.value);
  });

  document.getElementById('page-padding-slider').addEventListener('input', (e) => {
    setPagePadding(e.target.value);
  });

  document.getElementById('pages-displayed-select').addEventListener('change', (e) => {
    setPagesDisplayed(e.target.value);
  });

  document.getElementById('tts-highlight-style-select').addEventListener('change', (e) => {
    setTtsHighlightStyle(e.target.value);
  });

  document.getElementById('paper-texture-select').addEventListener('change', (e) => {
    setPaperTexture(e.target.value);
  });

  document.getElementById('transition-effect-select').addEventListener('change', (e) => {
    setTransitionEffect(e.target.value);
  });

  // 版面排版模式切換
  document.getElementById('layout-scroll-btn').addEventListener('click', () => {
    toggleLayoutMode('scroll');
  });
  document.getElementById('layout-paginated-btn').addEventListener('click', () => {
    toggleLayoutMode('paginated');
  });

  // TTS 語音朗讀控制
  const ttsPlayBtn = document.getElementById('tts-play-btn');
  ttsPlayBtn.addEventListener('click', () => {
    if (tts.isPlaying) {
      if (tts.isPaused) {
        tts.resume();
      } else {
        tts.pause();
      }
    } else {
      // 從進度保存的句子索引開始朗讀
      const savedIndex = currentBook?.progress?.activeSentenceIndex || 0;
      tts.play(savedIndex);
      updatePlayPauseButtonIcon();
    }
  });

  document.getElementById('tts-stop-btn').addEventListener('click', () => {
    tts.stop();
  });

  document.getElementById('tts-prev-btn').addEventListener('click', () => tts.previous());
  document.getElementById('tts-next-btn').addEventListener('click', () => tts.next());

  document.getElementById('tts-speed-slider').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById('tts-speed-val').textContent = `${val.toFixed(1)}x`;
    tts.setRate(val);
    chrome.storage.local.set({ ttsRate: val });
    if (currentBook) {
      saveProgressDebounced({ ttsRate: val });
    }
  });

  document.getElementById('tts-voice-select').addEventListener('change', (e) => {
    const voiceName = e.target.value;
    tts.setVoice(voiceName);
    if (currentBook) {
      saveProgressDebounced({ ttsVoice: voiceName });
    }
  });

  const filterEdgeBtn = document.getElementById('tts-filter-edge-btn');
  if (filterEdgeBtn) {
    filterEdgeBtn.addEventListener('click', () => {
      ttsOnlyEdge = !ttsOnlyEdge;
      if (ttsOnlyEdge) {
        filterEdgeBtn.classList.add('active');
      } else {
        filterEdgeBtn.classList.remove('active');
      }
      chrome.storage.local.set({ ttsOnlyEdge: ttsOnlyEdge });
      
      const savedSelectedValue = document.getElementById('tts-voice-select').value;
      initTTSPanelVoices(currentBook ? currentBook.file.name : '');
      
      const voiceSelect = document.getElementById('tts-voice-select');
      if (voiceSelect && savedSelectedValue) {
        if (Array.from(voiceSelect.options).some(opt => opt.value === savedSelectedValue)) {
          voiceSelect.value = savedSelectedValue;
          tts.setVoice(savedSelectedValue);
        } else if (voiceSelect.options.length > 0) {
          const newVoiceName = voiceSelect.value;
          tts.setVoice(newVoiceName);
          if (currentBook) {
            saveProgressDebounced({ ttsVoice: newVoiceName });
          }
        }
      }
    });
  }

  let lastVoicesCount = 0;
  // TTS 引擎狀態同步
  tts.onStateChange = () => {
    updatePlayPauseButtonIcon();
    updateEdgeFilterButtonVisibility();
    
    if (tts.voices.length !== lastVoicesCount) {
      lastVoicesCount = tts.voices.length;
      initTTSPanelVoices(currentBook ? currentBook.file.name : '');
    }
  };

  tts.getNextChapterData = async (chapterIndex) => {
    if (epubBookData && chapterIndex < epubBookData.chapters.length - 1) {
      const nextIndex = chapterIndex + 1;
      const chapter = epubBookData.chapters[nextIndex];
      const html = await chapter.getContent();
      prefetchedChapterCache = { index: nextIndex, html };
      return { index: nextIndex, html };
    }
    return null;
  };

  tts.onChapterTransition = async (nextChapterIndex) => {
    const currentChapter = epubBookData && epubBookData.chapters[currentChapterIndex];
    const nextChapter = epubBookData && epubBookData.chapters[nextChapterIndex];
    if (currentChapter && nextChapter && currentChapter.cleanHref === nextChapter.cleanHref) {
      currentChapterIndex = nextChapterIndex;
      tts.currentChapterIndex = nextChapterIndex;
      syncTOCActiveState(nextChapterIndex);
      updateReaderTitle();
    } else {
      await loadChapter(nextChapterIndex, false, false, false, true);
    }
    updatePlayPauseButtonIcon();
  };

  tts.onSentenceStart = (index) => {
    // 同步播放按鈕狀態
    updatePlayPauseButtonIcon();

    // 朗讀句子時更新進度
    if (currentBook) {
      saveProgressDebounced({ activeSentenceIndex: index });
    }

    // 在翻頁模式下，如果朗讀的句子不在當前可見頁面上，則自動翻頁
    if (document.body.classList.contains('layout-paginated')) {
      const sentence = tts.sentences[index];
      if (sentence && sentence.element) {
        const rect = sentence.element.getBoundingClientRect();
        const content = document.getElementById('book-content');
        const contentRect = content.getBoundingClientRect();
        const { containerWidth, columnGap } = getPaginatedPagesInfo();
        
        if (containerWidth > 0) {
          const relativeLeft = rect.left - contentRect.left;
          const halfGap = columnGap > 0 ? columnGap / 2 : 5;
          // 計算該句子在哪個頁面
          const pageIndex = Math.floor((relativeLeft + halfGap) / (containerWidth + columnGap));
          if (pageIndex !== currentPageIndex) {
            if (pendingGoToLastPageTimeout) {
              clearTimeout(pendingGoToLastPageTimeout);
              pendingGoToLastPageTimeout = null;
            }
            pendingGoToLastPage = false;
            currentPageIndex = pageIndex;
            updatePageTranslate();
          }
        }
      }
    }
  };

  // 側邊欄切換標籤
  document.getElementById('tab-toc').addEventListener('click', () => {
    document.getElementById('tab-toc').classList.add('active');
    document.getElementById('tab-highlights').classList.remove('active');
    document.getElementById('sidebar-toc-container').classList.add('active');
    document.getElementById('sidebar-highlights-container').classList.remove('active');
    setTimeout(() => {
      const activeItem = document.querySelector('#toc-list .toc-item.active');
      if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 150);
  });

  document.getElementById('tab-highlights').addEventListener('click', () => {
    document.getElementById('tab-toc').classList.remove('active');
    document.getElementById('tab-highlights').classList.add('active');
    document.getElementById('sidebar-toc-container').classList.remove('active');
    document.getElementById('sidebar-highlights-container').classList.add('active');
    renderHighlightsList();
  });

  document.getElementById('close-sidebar-btn').addEventListener('click', () => {
    document.getElementById('reader-sidebar').classList.remove('active');
  });

  document.getElementById('add-bookmark-btn').addEventListener('click', handleAddBookmark);

  // 漫畫 CBZ 翻頁控制
  document.getElementById('comic-prev-btn').addEventListener('click', prevComicPage);
  document.getElementById('comic-next-btn').addEventListener('click', nextComicPage);

  // 文字選取菜單事件
  const bookContent = document.getElementById('book-content');
  bookContent.addEventListener('mouseup', handleTextSelection);
  bookContent.addEventListener('touchend', handleTextSelection);

  // 單擊句子直接從該句開始朗讀（帶延遲檢測選區，使用事件委託與坐標輔助定位）
  bookContent.addEventListener('click', (e) => {
    // 忽略點擊鏈接、按鈕、輸入框等交互元素
    if (e.target.closest('a') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) {
      return;
    }
    
    let targetSpan = e.target.closest('.tts-sentence');
    if (!targetSpan) {
      targetSpan = findClosestTTSSentence(e.clientX, e.clientY);
    }
    if (!targetSpan) return;

    e.stopPropagation();
    if (ttsClickTimeout) clearTimeout(ttsClickTimeout);
    ttsClickTimeout = setTimeout(() => {
      const selection = window.getSelection().toString().trim();
      if (selection.length === 0) {
        const sentenceIdx = parseInt(targetSpan.getAttribute('data-sentence-index'));
        tts.play(sentenceIdx);
      }
    }, 150);
  });

  // 劃線高亮按鈕事件
  document.querySelectorAll('.highlight-colors .color-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      const color = dot.getAttribute('data-color');
      handleAddHighlight(color);
    });
  });

  document.getElementById('selection-note-btn').addEventListener('click', openNoteDialog);
  document.getElementById('selection-tts-btn').addEventListener('click', speakSelection);
  document.getElementById('selection-ai-summary').addEventListener('click', triggerAISummary);
  document.getElementById('selection-ai-explain').addEventListener('click', triggerAIExplain);
  document.getElementById('selection-ai-translate').addEventListener('click', triggerAITranslate);

  // 筆記對話框
  document.getElementById('note-cancel-btn').addEventListener('click', () => {
    document.getElementById('note-dialog').style.display = 'none';
  });
  document.getElementById('note-save-btn').addEventListener('click', handleSaveNote);

  // AI 面板
  document.getElementById('close-ai-panel').addEventListener('click', () => {
    document.getElementById('ai-panel').style.display = 'none';
  });

  // 點擊空白處關閉所有下拉面板與選取菜單
  document.addEventListener('click', (e) => {
    const target = e.target;
    // 選取菜單：點擊菜單外部區域則隱藏
    const selectionMenu = document.getElementById('selection-menu');
    if (selectionMenu && selectionMenu.style.display !== 'none') {
      if (!target.closest('#selection-menu')) {
        selectionMenu.style.display = 'none';
      }
    }
    // 設定面板：點擊面板及其觸發按鈕外部則關閉
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel && settingsPanel.classList.contains('dropdown-active')) {
      if (!target.closest('#settings-panel') && !target.closest('#settings-toggle')) {
        settingsPanel.classList.remove('dropdown-active');
      }
    }
    // TTS 面板：點擊面板及其觸發按鈕外部則關閉
    const ttsPanel = document.getElementById('tts-panel');
    if (ttsPanel && ttsPanel.classList.contains('dropdown-active')) {
      if (!target.closest('#tts-panel') && !target.closest('#tts-toggle')) {
        ttsPanel.classList.remove('dropdown-active');
      }
    }
    // 側邊欄：點擊側邊欄及其觸發按鈕外部則關閉
    const sidebar = document.getElementById('reader-sidebar');
    if (sidebar && sidebar.classList.contains('active')) {
      if (!target.closest('#reader-sidebar') && !target.closest('#sidebar-toggle')) {
        sidebar.classList.remove('active');
      }
    }
  });

  // 鍵盤快捷鍵監聽
  window.addEventListener('keydown', handleKeyDown);

  // 左右翻頁按鈕監聽
  document.getElementById('page-prev-btn').addEventListener('click', () => {
    if (currentBook) {
      if (currentBook.format === 'cbz') {
        prevComicPage();
      } else {
        navigatePage('prev');
      }
    }
  });
  document.getElementById('page-next-btn').addEventListener('click', () => {
    if (currentBook) {
      if (currentBook.format === 'cbz') {
        nextComicPage();
      } else {
        navigatePage('next');
      }
    }
  });

  // 視窗大小改變監聽
  window.addEventListener('resize', () => {
    if (currentBook) {
      if (document.body.classList.contains('layout-paginated')) {
        applyLayoutDimensions();
        updatePageTranslate(false);
      }
    }
  });

  // 滾動自動保存進度與瀑布流加載
  window.addEventListener('scroll', () => {
    if (!document.getElementById('reader-view').classList.contains('view-active')) return;
    if (!currentBook || currentBook.format === 'cbz') return;

    const isPaginated = document.body.classList.contains('layout-paginated');
    const scrollTop = window.scrollY || window.pageYOffset;
    
    // 保存進度
    saveProgressDebounced({
      elementIndex: getTopVisibleElementIndex(),
      scrollTop: scrollTop
    });

    // 瀑布流模式下的自動載入與活躍章節檢測
    if (!isPaginated && epubBookData) {
      // 1. 自動載入下一章
      const thresholdBottom = 1200; // 距離底部 1200px 時預載
      const docHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
      if (docHeight - window.innerHeight - scrollTop < thresholdBottom) {
        appendNextChapterWaterfall();
      }

      // 2. 自動載入前一章
      const thresholdTop = 300; // 距離頂部 300px 且有前一章時開始預載
      if (scrollTop < thresholdTop) {
        prependPreviousChapterWaterfall();
      }

      // 3. 活躍章節檢測 (找出視窗內佔比最顯著的章節)
      const contentEl = document.getElementById('book-content');
      const wrappers = contentEl.querySelectorAll('.chapter-wrapper');
      let dominantWrapper = null;
      let maxIntersection = -Infinity;
      const viewportHeight = window.innerHeight;
      const viewportTop = scrollTop;
      const viewportBottom = viewportTop + viewportHeight;

      wrappers.forEach(wrapper => {
        const rect = wrapper.getBoundingClientRect();
        const top = rect.top + scrollTop;
        const bottom = rect.bottom + scrollTop;

        const intersectTop = Math.max(top, viewportTop);
        const intersectBottom = Math.min(bottom, viewportBottom);
        const intersectHeight = intersectBottom - intersectTop;

        if (intersectHeight > 0 && intersectHeight > maxIntersection) {
          maxIntersection = intersectHeight;
          dominantWrapper = wrapper;
        }
      });

      if (dominantWrapper) {
        const chapIdx = parseInt(dominantWrapper.getAttribute('data-chapter-index'), 10);
        if (chapIdx !== currentChapterIndex && !isChangingChapter) {
          currentChapterIndex = chapIdx;
          tts.currentChapterIndex = chapIdx;
          syncTOCActiveState(chapIdx);
          updateReaderTitle();
        }
      }
    }
  }, { passive: true });

"  // 滾輪在最頂部/最底部時切換章節 (附帶閾值過濾與 800ms 冷卻時間防抖)\n  window.addEventListener('wheel', (e) => {\n    if (!document.getElementById('reader-view').classList.contains('view-active')) return;\n    if (!currentBook || currentBook.format === 'cbz') return;\n    if (document.body.classList.contains('layout-paginated')) return;\n    if (isChangingChapter) return;\n    if (Date.now() - lastChapterChangeTime < 800) return;\n\n    const scrollTop = window.scrollY;\n    if (scrollTop <= 5 && e.deltaY < -15) {\n      // 在最頂部向上滾動 (加載上一章)\n      if (currentChapterIndex > 0) {\n        loadChapter(currentChapterIndex - 1, true);\n      }\n    } else {\n      const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;\n      const clientHeight = window.innerHeight;\n      if (scrollTop + clientHeight >= scrollHeight - 5 && e.deltaY > 15) {\n        // 在最底部向下滾動 (加載下一章)\n        if (epubBookData && currentChapterIndex < epubBookData.chapters.length - 1) {\n          loadChapter(currentChapterIndex + 1);\n        }\n      }\n    }\n  }, { passive: true });\n\n  // 觸控手勢在最頂部/最底部時切換章節 (適用於移動端，附帶冷卻時間與水平滑動過濾)\n  let touchStartY = 0;\n  let touchStartX = 0;\n  window.addEventListener('touchstart', (e) => {\n    if (!document.getElementById('reader-view').classList.contains('view-active')) return;\n    if (!currentBook || currentBook.format === 'cbz') return;\n    if (document.body.classList.contains('layout-paginated')) return;\n    touchStartY = e.touches[0].clientY;\n    touchStartX = e.touches[0].clientX;\n  }, { passive: true });\n\n  window.addEventListener('touchend', (e) => {\n    if (!document.getElementById('reader-view').classList.contains('view-active')) return;\n    if (!currentBook || currentBook.format === 'cbz') return;\n    if (document.body.classList.contains('layout-paginated')) return;\n    if (isChangingChapter) return;\
<truncated 2352 bytes>

// 創建一個章節包裹容器
function createChapterWrapper(index, cleanHref, html) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chapter-wrapper';
  wrapper.setAttribute('data-chapter-index', index);
  wrapper.setAttribute('data-clean-href', cleanHref || '');
  wrapper.innerHTML = html;
  
  // 清理干擾排版的樣式與損壞字符
  cleanUpBookInlineStyles(wrapper);
  cleanUpCorruptedCharacters(wrapper);
  
  // 對該容器中的文字進行 TTS 句子分段 (以便點擊朗讀，此處只包裝 span 不改變 TTS 播放狀態)
  tts.segmentContainer(wrapper);
  
  // 重新渲染高亮
  applySavedHighlightsToDOM(wrapper, index);
  
  // 處理內部跳轉鏈接 (EPUB)
  wrapper.querySelectorAll('[data-epub-href]').forEach(a => {
    a.addEventListener('click', (e) => {
      const targetHref = a.getAttribute('data-epub-href');
      const [targetCleanHref, hash] = targetHref.split('#');
      
      const targetIdx = epubBookData.chapters.findIndex(ch => ch.cleanHref === targetCleanHref);
      if (targetIdx > -1) {
        loadChapter(targetIdx, false, false, true, false, null, null, null, hash || null);
      }
    });
  });

  // 處理內部跳轉鏈接 (MOBI/AZW3 Kindle pos links)
  wrapper.querySelectorAll('a[href^="kindle:pos:fid:"]').forEach(a => {
    a.style.cursor = 'pointer';
    a.style.textDecoration = 'underline';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = a.getAttribute('href');
      const match = href.match(/kindle:pos:fid:([0-9A-Z]+):off:([0-9A-Z]+)/i);
      if (match && epubBookData && epubBookData.fragTable) {
        const fid = decodeBase32(match[1]);
        const entry = epubBookData.fragTable[fid];
        if (entry) {
          const offVal = decodeBase32(match[2]);
          const absTargetOffset = entry.offset + offVal;
          const targetSkeleton = entry.skeleton;
          let targetIdx = -1;
          
          const hasPos = epubBookData.chapters.some(ch => ch.pos !== undefined);
          if (hasPos) {
            for (let i = 0; i < epubBookData.chapters.length; i++) {
              const ch = epubBookData.chapters[i];
              if (ch.pos !== undefined && ch.pos <= absTargetOffset) {
                targetIdx = i;
              }
            }
          } else {
            for (let i = 0; i < epubBookData.chapters.length; i++) {
              const ch = epubBookData.chapters[i];
              if (ch.skeleton !== undefined && ch.skeleton <= targetSkeleton) {
                targetIdx = i;
              }
            }
          }
          if (targetIdx > -1) {
            if (targetIdx === currentChapterIndex) {
              const flowsStart = epubBookData.flowsStart || 0;
              const relativeByteOffset = absTargetOffset - flowsStart;
              if (relativeByteOffset > 0 && epubBookData.rawHtmlBytes) {
                const slice = epubBookData.rawHtmlBytes.subarray(0, Math.min(relativeByteOffset, epubBookData.rawHtmlBytes.length));
                const targetCharOffset = new TextDecoder('utf-8').decode(slice).length;
                
                const elements = wrapper.querySelectorAll('[data-char-offset]');
                let minDiff = Infinity;
                let bestElem = null;
                elements.forEach(el => {
                  const charOffset = parseInt(el.getAttribute('data-char-offset'), 10);
                  if (!isNaN(charOffset)) {
                    const diff = Math.abs(charOffset - targetCharOffset);
                    if (diff < minDiff) {
                      minDiff = diff;
                      bestElem = el;
                    }
                  }
                });
                if (bestElem && minDiff < 500) {
                  safeRestoreScrollToElementIndex(bestElem);
                }
              }
            } else {
              loadChapter(targetIdx, false, false, true, false, null, null, null, null, absTargetOffset);
            }
          }
        }
      }
    });
  });

  return wrapper;
}

// 瀑布流模式：向後載入並追加章節
async function appendNextChapterWaterfall() {
  if (isAppendingChapter || !epubBookData || !currentBook) return;
  const contentEl = document.getElementById('book-content');
  if (!contentEl) return;

  const wrappers = contentEl.querySelectorAll('.chapter-wrapper');
  if (wrappers.length === 0) return;

  const lastWrapper = wrappers[wrappers.length - 1];
  const lastIndex = parseInt(lastWrapper.getAttribute('data-chapter-index'), 10);
  const nextIndex = lastIndex + 1;

  if (nextIndex >= epubBookData.chapters.length) return;

  isAppendingChapter = true;
  
  const loadingPlaceholder = document.createElement('div');
  loadingPlaceholder.className = 'chapter-wrapper-loading';
  contentEl.appendChild(loadingPlaceholder);

  try {
    const nextChapter = epubBookData.chapters[nextIndex];
    let nextHtml;
    if (prefetchedChapterCache && prefetchedChapterCache.index === nextIndex) {
      nextHtml = prefetchedChapterCache.html;
      prefetchedChapterCache = null;
    } else {
      nextHtml = await nextChapter.getContent();
    }

    const wrapper = createChapterWrapper(nextIndex, nextChapter.cleanHref, nextHtml);
    
    if (loadingPlaceholder.parentNode) {
      loadingPlaceholder.parentNode.removeChild(loadingPlaceholder);
    }
    contentEl.appendChild(wrapper);

    // 若 TTS 當前正在播放且預載句子包含此章節，進行 DOM 同步
    if (tts.isPlaying && tts.sentences.some(s => s.chapterIndex === nextIndex)) {
      tts.syncDOM(wrapper, epubBookData);
    }
  } catch (e) {
    console.error("Failed to append next chapter in waterfall:", e);
    if (loadingPlaceholder.parentNode) {
      loadingPlaceholder.parentNode.removeChild(loadingPlaceholder);
    }
  } finally {
    isAppendingChapter = false;
  }
}

// 瀑布流模式：向前載入並插入前一章節，同時修正滾動高度避免跳動
async function prependPreviousChapterWaterfall() {
  if (isPrependingChapter || !epubBookData || !currentBook) return;
  const contentEl = document.getElementById('book-content');
  if (!contentEl) return;

  const wrappers = contentEl.querySelectorAll('.chapter-wrapper');
  if (wrappers.length === 0) return;

  const firstWrapper = wrappers[0];
  const firstIndex = parseInt(firstWrapper.getAttribute('data-chapter-index'), 10);
  const prevIndex = firstIndex - 1;

  if (prevIndex < 0) return;

  isPrependingChapter = true;

  const oldScrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
  const oldScrollY = window.scrollY;

  const loadingPlaceholder = document.createElement('div');
  loadingPlaceholder.className = 'chapter-wrapper-loading';
  contentEl.insertBefore(loadingPlaceholder, firstWrapper);

  try {
    const prevChapter = epubBookData.chapters[prevIndex];
    const prevHtml = await prevChapter.getContent();
    const wrapper = createChapterWrapper(prevIndex, prevChapter.cleanHref, prevHtml);

    if (loadingPlaceholder.parentNode) {
      loadingPlaceholder.parentNode.removeChild(loadingPlaceholder);
    }
    contentEl.insertBefore(wrapper, firstWrapper);

    const newScrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
    const heightDifference = newScrollHeight - oldScrollHeight;
    window.scrollTo(0, oldScrollY + heightDifference);

    // 若 TTS 當前正在播放且預載句子包含此章節，進行 DOM 同步
    if (tts.isPlaying && tts.sentences.some(s => s.chapterIndex === prevIndex)) {
      tts.syncDOM(wrapper, epubBookData);
    }
  } catch (e) {
    console.error("Failed to prepend previous chapter in waterfall:", e);
    if (loadingPlaceholder.parentNode) {
      loadingPlaceholder.parentNode.removeChild(loadingPlaceholder);
    }
  } finally {
    isPrependingChapter = false;
  }
}

  // 頁面生命週期變更時強制保存
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveReadingTime();
      forceSaveCurrentProgress();
    } else {
      // 返回頁面時重置計時起點，防止將後台掛起時間計入
      lastReadingHeartbeat = Date.now();
      lastUserActivityTime = Date.now();
    }
  });
  window.addEventListener('beforeunload', () => {
    saveReadingTime();
    forceSaveCurrentProgress();
  });

  tts.onPlaybackEnd = async () => {
    updatePlayPauseButtonIcon();
    // 自動播放下一章節/頁面
    if (currentBook) {
      if (epubBookData && currentChapterIndex < epubBookData.chapters.length - 1) {
        await loadChapter(currentChapterIndex + 1);
        tts.play(0);
        updatePlayPauseButtonIcon();
      }
    }
  };
}


// ==================== 2. 書庫管理與導入 ==================== */

// 處理選擇檔案
function handleFileSelect(e) {
  if (e.target.files.length > 0) {
    handleImportFiles(e.target.files);
  }
}

// 導入書籍
async function handleImportFiles(files) {
  for (const file of files) {
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    const formats = ['.epub', '.azw3', '.mobi', '.txt', '.md', '.fb2', '.cbz'];
    
    if (!formats.includes(ext)) {
      alert(`${getMsg('unsupported_format')}: ${file.name}`);
      continue;
    }

    try {
      let title = file.name.substring(0, file.name.lastIndexOf('.'));
      let author = getMsg('unknown_author');
      let cover = '';
      
      // 依格式調用對應的臨時 parser 以提取封面與元數據
      const format = ext.replace('.', '');
      
      if (format === 'epub') {
        const parser = new EpubParser(file);
        const res = await parser.parse();
        title = res.metadata.title;
        author = res.metadata.author;
        cover = res.metadata.cover;
      } else if (format === 'azw3' || format === 'mobi') {
        const parser = new Azw3Parser(file);
        const res = await parser.parse();
        title = res.metadata.title;
        author = res.metadata.author;
        cover = res.metadata.cover;
      } else {
        // TXT, Markdown, FB2, CBZ 漫畫
        if (format === 'cbz') {
          const parser = new ComicParser(file);
          const res = await parser.parse();
          title = res.metadata.title;
          author = res.metadata.author;
          cover = res.metadata.cover;
        } else {
          const parser = new TextParser(file, format);
          const res = await parser.parse();
          title = res.metadata.title;
          author = res.metadata.author;
          cover = res.metadata.cover;
        }
      }

      // 添加進資料庫
      await library.addBook({
        title,
        author,
        format,
        file, // 保存原始 Blob 檔案
        cover,
        size: file.size
      });

      await renderBookshelf();
    } catch (err) {
      console.error('Import failed:', err);
      alert(`${getMsg('parse_failed')}: ${file.name}\n${err.message}`);
    }
  }
}

// 渲染書櫃列表
async function renderBookshelf(searchQuery = '') {
  const shelf = document.getElementById('bookshelf-grid');
  const emptyState = document.getElementById('empty-library');
  shelf.innerHTML = '';
  
  // 清理舊的封面 Object URL，防記憶體洩漏
  clearCoverUrls();

  const books = await library.getAllBooks();
  
  // 過濾搜尋
  const filteredBooks = books.filter(b => {
    const q = searchQuery.toLowerCase();
    return b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q);
  });

  if (filteredBooks.length === 0) {
    emptyState.style.display = 'flex';
    shelf.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  shelf.style.display = 'grid';

  filteredBooks.forEach(book => {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.setAttribute('data-id', book.id);
    
    // 計算進度
    const percent = Math.round(book.progress?.percent || 0);

    card.innerHTML = `
      <button class="book-delete-btn" title="${getMsg('delete_book_title')}">
        <svg class="svg-icon svg-icon-sm" style="color: white;" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
      </button>
      <button class="book-export-btn" title="${getMsg('export_book_title')}">
        <svg class="svg-icon svg-icon-sm" style="color: white;" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
      </button>
      <button class="book-stats-btn" title="${getMsg('stats_btn_tooltip')}">
        <svg class="svg-icon svg-icon-sm" style="color: white;" viewBox="0 0 24 24">
          <line x1="18" y1="20" x2="18" y2="10"></line>
          <line x1="12" y1="20" x2="12" y2="4"></line>
          <line x1="6" y1="20" x2="6" y2="14"></line>
        </svg>
      </button>
      <div class="book-cover-container">
        <!-- 封面將在此動態注入 -->
      </div>
      <div class="book-info">
        <h3 class="book-title" title="${book.title}">${book.title}</h3>
        <p class="book-author" title="${book.author}">${book.author}</p>
        <div class="book-progress-wrapper">
          <div class="book-progress-info">
            <span>${getMsg('reading_progress', [percent])}</span>
            <span class="book-time-badge">${formatDuration(book.stats?.totalTime || 0)}</span>
          </div>
          <div class="book-progress-bar">
            <div class="book-progress-fill" style="width: ${percent}%;"></div>
          </div>
        </div>
      </div>
    `;

    // 動態加載封面
    const coverContainer = card.querySelector('.book-cover-container');
    let coverUrl = '';
    if (book.cover) {
      if (book.cover instanceof Blob) {
        coverUrl = URL.createObjectURL(book.cover);
        activeCoverUrls.push(coverUrl);
      } else if (typeof book.cover === 'string') {
        coverUrl = book.cover;
      }
    }

    if (coverUrl) {
      coverContainer.innerHTML = `
        <img class="book-cover" src="${coverUrl}" alt="${book.title}">
        <span class="book-format-badge">${book.format}</span>
      `;
    } else {
      coverContainer.innerHTML = `
        <div class="book-cover-placeholder">
          <div class="book-cover-placeholder-icon">
            <svg class="svg-icon svg-icon-lg" style="color: var(--text-muted);" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
          </div>
          <div style="font-size:10px; font-weight:600;">${book.format.toUpperCase()}</div>
        </div>
        <span class="book-format-badge">${book.format}</span>
      `;
    }

    // 動態綁定刪除事件 (遵循 CSP 安全政策，不使用 inline onclick)
    const deleteBtn = card.querySelector('.book-delete-btn');
    deleteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await deleteBookHandler(book.id);
    });

    // 動態綁定匯出事件
    const exportBtn = card.querySelector('.book-export-btn');
    exportBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await exportBookHandler(book.id);
    });

    // 動態綁定統計事件
    const statsCardBtn = card.querySelector('.book-stats-btn');
    if (statsCardBtn) {
      statsCardBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await openSingleBookStatsModal(book.id);
      });
    }

    card.addEventListener('click', () => openBook(book.id));
    shelf.appendChild(card);
  });
}

// 刪除書籍（全局函數，便於 HTML 觸發）
async function deleteBookHandler(id) {
  if (confirm(getMsg('confirm_delete_book'))) {
    await library.deleteBook(id);
    await renderBookshelf();
  }
}
window.deleteBookHandler = deleteBookHandler;

// 匯出書籍（全局函數）
async function exportBookHandler(id) {
  try {
    const book = await library.getBook(id);
    if (!book || !book.file) {
      alert('Book file not found.');
      return;
    }
    const blob = book.file;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ext = book.format ? book.format.toLowerCase() : 'epub';
    a.download = `${book.title}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export failed:', err);
    alert(`Failed to export book: ${err.message}`);
  }
}
window.exportBookHandler = exportBookHandler;

// ==================== 閱讀時間統計管理邏輯 ====================
function startReadingTracker(bookId) {
  stopReadingTracker();

  lastReadingHeartbeat = Date.now();
  lastUserActivityTime = Date.now();

  readingSessionTimer = setInterval(async () => {
    if (!currentBook) {
      stopReadingTracker();
      return;
    }

    const now = Date.now();
    const isUserActive = (now - lastUserActivityTime < IDLE_TIMEOUT_MS) || (tts && tts.isPlaying);

    if (isUserActive) {
      const elapsedSeconds = Math.round((now - lastReadingHeartbeat) / 1000);
      if (elapsedSeconds > 0) {
        try {
          await library.addReadingDuration(bookId, elapsedSeconds);
        } catch (e) {
          console.warn('[ReadingTracker] Failed to save reading stats:', e);
        }
      }
    }
    lastReadingHeartbeat = now;
  }, 10000);
}

function stopReadingTracker() {
  if (readingSessionTimer) {
    clearInterval(readingSessionTimer);
    readingSessionTimer = null;
  }
}

async function saveReadingTime() {
  if (currentBook) {
    const now = Date.now();
    const isUserActive = (now - lastUserActivityTime < IDLE_TIMEOUT_MS) || (tts && tts.isPlaying);
    if (isUserActive) {
      const elapsedSeconds = Math.round((now - lastReadingHeartbeat) / 1000);
      if (elapsedSeconds > 0) {
        try {
          await library.addReadingDuration(currentBook.id, elapsedSeconds);
        } catch (e) {
          console.warn('[ReadingTracker] Failed to save final stats:', e);
        }
      }
    }
    lastReadingHeartbeat = now;
  }
}


// ==================== 3. 閱讀器渲染與控制 ==================== */

// 打開書籍
async function openBook(id) {
  const book = await library.getBook(id);
  if (!book) return;

  // Push state to prevent back gesture from leaving the reader app
  if (!history.state || history.state.bookId !== id) {
    history.pushState({ bookId: id }, '');
  }

  // 清理舊的資源 Object URL 與預載快取
  clearResourceUrls();
  prefetchedChapterCache = null;

  currentBook = book;
  currentChapterIndex = book.progress?.chapterIndex || 0;

  // 1. 初始化界面 UI 顯示
  document.getElementById('library-view').classList.remove('view-active');
  document.getElementById('reader-view').classList.add('view-active');
  document.getElementById('reader-book-title').textContent = book.title;

  // 設定書籍格式與排版類別
  document.body.classList.remove('format-epub', 'format-azw3', 'format-mobi', 'format-txt', 'format-cbz', 'layout-paginated');
  document.body.classList.add(`format-${book.format}`);

  // 初始化閱讀設定樣式
  initThemeAndStyles();

  // 隱藏/顯示特定的控制按鈕
  document.getElementById('sidebar-toggle').style.display = book.format === 'cbz' ? 'none' : 'inline-flex';
  document.getElementById('tts-toggle').style.display = book.format === 'cbz' ? 'none' : 'inline-flex';
  document.getElementById('layout-mode-container').style.display = book.format === 'cbz' ? 'none' : 'flex';
  document.getElementById('comic-navigation').style.display = book.format === 'cbz' ? 'flex' : 'none';

  // 顯示加載動畫
  const contentEl = document.getElementById('book-content');
  contentEl.innerHTML = `<div class="ai-loading"><div class="ai-loading-spinner"></div><span>${getMsg('loading_book')}</span></div>`;

  try {
    // 2. 調用相應的解析器
    if (book.format === 'epub') {
      const parser = new EpubParser(book.file);
      epubBookData = await parser.parse();
      epubBookData.parser = parser; // 保存解析器實例以進行動態 URL 的清理
      epubBookData.chapters = await mergeShortChapters(epubBookData.chapters);
      renderTOC(epubBookData.chapters);
      await loadChapter(currentChapterIndex, false, true);
    } else if (book.format === 'azw3' || book.format === 'mobi') {
      const parser = new Azw3Parser(book.file);
      const res = await parser.parse();
      res.chapters = await mergeShortChapters(res.chapters);
      epubBookData = res; // 複用變量名以載入章節
      if (res.resourceUrls) {
        activeResourceUrls.push(...res.resourceUrls);
      }
      renderTOC(res.chapters);
      await loadChapter(currentChapterIndex, false, true);
    } else if (book.format === 'cbz') {
      comicParserInstance = new ComicParser(book.file);
      const res = await comicParserInstance.parse();
      // 漫畫沒有 TOC 側邊欄，直接渲染圖片
      await loadComicPage(currentBook.progress?.comicImageIndex || 0);
    } else {
      // TXT, Markdown, FB2
      const parser = new TextParser(book.file, book.format);
      const res = await parser.parse();
      res.chapters = await mergeShortChapters(res.chapters);
      epubBookData = res;
      renderTOC(res.chapters);
      await loadChapter(currentChapterIndex, false, true);
    }

    // 初始化 TTS 面板
    initTTSPanelVoices(book.file.name);
    
    // 載入高亮標記
    applySavedHighlightsToDOM();

    // 啟動閱讀時間追蹤
    startReadingTracker(book.id);

  } catch (err) {
    console.error('Failed to parse book:', err);
    contentEl.innerHTML = `<p style="color:red; padding:40px; text-align:center;">${getMsg('failed_load_book')}: ${err.message}</p>`;
  }
}

// 關閉閱讀器，返回書櫃
async function closeCurrentBook(triggerBack = true) {
  // 1. 停止 TTS 播放
  tts.stop();

  // 2. 停止閱讀計時並立即保存最後剩餘的時長
  await saveReadingTime();
  stopReadingTracker();

  // 3. 強制保存進度
  await forceSaveCurrentProgress();

  // 清理舊的資源 Object URL
  clearResourceUrls();

  // 3. 切換視圖
  document.getElementById('reader-view').classList.remove('view-active');
  document.getElementById('library-view').classList.add('view-active');
  
  // 重置變量與樣式類別
  document.body.classList.remove('format-epub', 'format-azw3', 'format-mobi', 'format-txt', 'format-cbz', 'layout-paginated');
  currentBook = null;
  epubBookData = null;
  comicParserInstance = null;
  prefetchedChapterCache = null;

  // 重新渲染書櫃
  await renderBookshelf();

  // If programmatic close, pop state to match browser history
  if (triggerBack && history.state && history.state.bookId) {
    history.back();
  }
}

// 渲染目錄
function renderTOC(chapters) {
  const tocList = document.getElementById('toc-list');
  tocList.innerHTML = '';
  
  chapters.forEach((ch, idx) => {
    if (ch.hiddenFromTOC) return;

    const li = document.createElement('li');
    li.className = 'toc-item';
    li.setAttribute('data-chapter-index', idx);
    li.textContent = ch.title;
    
    // Check if this visible item is the active one or the closest preceding non-hidden active one
    let isActive = false;
    if (idx === currentChapterIndex) {
      isActive = true;
    } else if (currentChapterIndex > idx && chapters[currentChapterIndex].hiddenFromTOC) {
      // Find the closest preceding non-hidden chapter index
      let targetIndex = currentChapterIndex;
      while (targetIndex >= 0 && chapters[targetIndex].hiddenFromTOC) {
        targetIndex--;
      }
      if (targetIndex === idx) {
        isActive = true;
      }
    }
    if (isActive) li.classList.add('active');
    
    // 根據目錄層級（depth）添加縮排與樣式類別
    if (ch.depth && ch.depth > 0) {
      li.style.paddingLeft = (15 + ch.depth * 15) + 'px';
      li.classList.add('toc-sub-item');
    }
    
    li.addEventListener('click', () => {
      document.getElementById('reader-sidebar').classList.remove('active');
      loadChapter(idx);
    });
    tocList.appendChild(li);
  });
}

function syncTOCActiveState(activeIndex) {
  let targetIndex = activeIndex;
  if (epubBookData && epubBookData.chapters) {
    while (targetIndex >= 0 && epubBookData.chapters[targetIndex].hiddenFromTOC) {
      targetIndex--;
    }
    if (targetIndex < 0) {
      targetIndex = epubBookData.chapters.findIndex(ch => !ch.hiddenFromTOC);
    }
  }

  const tocItems = document.querySelectorAll('#toc-list .toc-item');
  tocItems.forEach((item) => {
    const itemIndex = parseInt(item.getAttribute('data-chapter-index'), 10);
    if (itemIndex === targetIndex) {
      item.classList.add('active');
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      item.classList.remove('active');
    }
  });
}

// 清除書籍內置的干擾多欄排版的內聯樣式
function cleanUpBookInlineStyles(container) {
  const elements = container.querySelectorAll('[style]');
  const cssProperties = [
    'break-before', 'break-after',
    'page-break-before', 'page-break-after',
    'column-break-before', 'column-break-after',
    '-webkit-column-break-before', '-webkit-column-break-after',
    'column-span', '-webkit-column-span',
    '-epub-break-before', '-epub-break-after',
    '-epub-page-break-before', '-epub-page-break-after'
  ];

  elements.forEach(elem => {
    // 移除分頁、分欄、跨欄屬性
    cssProperties.forEach(prop => {
      elem.style.removeProperty(prop);
    });
    
    const tagName = elem.tagName.toLowerCase();
    if (tagName !== 'img' && tagName !== 'svg' && tagName !== 'image') {
      // 移除可能導致空白的高度限制
      elem.style.removeProperty('height');
      elem.style.removeProperty('min-height');
      elem.style.removeProperty('max-height');
      
      // 移除過大的 margin / padding，避免撐大版面
      const marginBot = elem.style.marginBottom;
      if (marginBot && (marginBot.includes('%') || marginBot.includes('vh') || parseFloat(marginBot) >= 4)) {
        elem.style.removeProperty('margin-bottom');
      }
      const marginTop = elem.style.marginTop;
      if (marginTop && (marginTop.includes('%') || marginTop.includes('vh') || parseFloat(marginTop) >= 4)) {
        elem.style.removeProperty('margin-top');
      }
      const paddingBot = elem.style.paddingBottom;
      if (paddingBot && (paddingBot.includes('%') || paddingBot.includes('vh') || parseFloat(paddingBot) >= 4)) {
        elem.style.removeProperty('padding-bottom');
      }
      const paddingTop = elem.style.paddingTop;
      if (paddingTop && (paddingTop.includes('%') || paddingTop.includes('vh') || parseFloat(paddingTop) >= 4)) {
        elem.style.removeProperty('padding-top');
      }
    }
  });
}

// 清理電子書中因轉檔或編碼問題產生的損壞字符（如黑方塊 ■ 佔位符）
function cleanUpCorruptedCharacters(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
  let node;
  const nodesToProcess = [];
  while (node = walker.nextNode()) {
    if (node.nodeValue.includes('■')) {
      nodesToProcess.push(node);
    }
  }
  
  nodesToProcess.forEach(node => {
    let val = node.nodeValue;
    
    // 1. 特殊詞彙替換
    val = val.replace(/■望塔/g, '瞭望塔');
    val = val.replace(/■望/g, '瞭望');
    val = val.replace(/idealistischen ■ sthetik/g, 'idealistischen Ästhetik');
    val = val.replace(/■ sthetik/g, 'Ästhetik');
    val = val.replace(/■sthetik/g, 'Ästhetik');
    val = val.replace(/·■/g, '·');
    
    // 2. 正則清理：英文縮寫、外文人名、單詞與中文/外文之間夾雜的損壞字符
    // 英文縮寫與英文單詞、縮寫之間 (例如 J.■F.)
    val = val.replace(/([A-Za-z0-9\.])■([A-Za-z0-9\.])/g, '$1 $2');
    // 縮寫點與中文之間 (例如 R.■罗蒂)
    val = val.replace(/(\.)■([\u4e00-\u9fa5])/g, '$1 $2');
    // 英文字母/數字與中文之間
    val = val.replace(/([A-Za-z0-9\.])■([\u4e00-\u9fa5])/g, '$1 $2');
    val = val.replace(/([\u4e00-\u9fa5])■([A-Za-z0-9\.])/g, '$1 $2');
    
    // 3. 兜底替換：其他所有殘留的 ■ 替換為空格
    val = val.replace(/■/g, ' ');
    
    node.nodeValue = val;
  });
}


// 封裝 View Transitions API 進行頁面與章節切換平滑過渡
function transitionPage(updateDOM, direction = 'forward') {
  if (!document.startViewTransition) {
    updateDOM();
    return Promise.resolve();
  }
  
  const htmlEl = document.documentElement;
  htmlEl.classList.remove('transition-dir-forward', 'transition-dir-backward');
  htmlEl.classList.add(`transition-dir-${direction}`);
  
  try {
    const transition = document.startViewTransition(updateDOM);
    transition.finished.finally(() => {
      htmlEl.classList.remove('transition-dir-forward', 'transition-dir-backward');
      // 過渡動畫結束後，重新整理與更新多欄排版寬度與定位，防止 Chrome/Edge 在動畫期間獲取錯誤的 clientRects
      if (document.body.classList.contains('layout-paginated')) {
        applyLayoutDimensions();
        updatePageTranslate(false);
        if (pendingGoToLastPageTimeout) {
          clearTimeout(pendingGoToLastPageTimeout);
          pendingGoToLastPageTimeout = null;
        }
        pendingGoToLastPage = false;
      }
    });
    return transition.updateCallbackDone;
  } catch (e) {
    const res = updateDOM();
    htmlEl.classList.remove('transition-dir-forward', 'transition-dir-backward');
    return res && typeof res.then === 'function' ? res : Promise.resolve();
  }
}

// 等待樣式表載入完成以確保佈局排版尺寸正確
function waitForStylesheets(container) {
  const links = container.querySelectorAll('link[rel="stylesheet"]');
  if (links.length === 0) return Promise.resolve();
  
  const promises = Array.from(links).map(link => {
    return new Promise(resolve => {
      link.addEventListener('load', resolve);
      link.addEventListener('error', resolve);
      // 安全超時以防加載事件未觸發
      setTimeout(resolve, 250);
    });
  });
  return Promise.all(promises);
}

// 尋找特定 hash 在相同 cleanHref 中最精確對應的章節索引
function findCorrectChapterIndexForHash(cleanHref, targetHash) {
  if (!epubBookData || !epubBookData.chapters) return -1;

  const chaptersWithSameHref = [];
  epubBookData.chapters.forEach((ch, idx) => {
    if (ch.cleanHref === cleanHref) {
      chaptersWithSameHref.push({ chapter: ch, index: idx });
    }
  });

  if (chaptersWithSameHref.length === 0) return -1;
  if (chaptersWithSameHref.length === 1) return chaptersWithSameHref[0].index;
  if (!targetHash) return chaptersWithSameHref[0].index;

  const contentEl = document.getElementById('book-content');
  if (!contentEl) return chaptersWithSameHref[0].index;

  const targetElem = document.getElementById(targetHash) || contentEl.querySelector(`[name="${targetHash.replace(/"/g, '\\"')}"]`);
  if (!targetElem) {
    return chaptersWithSameHref[0].index;
  }

  let bestIdx = chaptersWithSameHref[0].index;

  for (let i = 1; i < chaptersWithSameHref.length; i++) {
    const { chapter, index } = chaptersWithSameHref[i];
    if (!chapter.hash) continue;

    const chElem = document.getElementById(chapter.hash) || contentEl.querySelector(`[name="${chapter.hash.replace(/"/g, '\\"')}"]`);
    if (!chElem) continue;

    if (chElem === targetElem) {
      bestIdx = index;
    } else {
      const position = chElem.compareDocumentPosition(targetElem);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        bestIdx = index;
      }
    }
  }

  return bestIdx;
}

// 載入指定章節 (流式文本)
// 載入指定章節 (流式文本)
async function loadChapter(index, goToLastPage = false, restoreProgress = false, animate = true, isSeamless = false, targetPageIndex = null, targetElementIndex = null, targetSentenceIndex = null, targetHash = null, targetKindleOffset = null) {
  if (!epubBookData || index < 0 || index >= epubBookData.chapters.length) return;

  const isPaginated = document.body.classList.contains('layout-paginated');
  const origHtmlOverflow = document.documentElement.style.overflow;
  const origBodyOverflow = document.body.style.overflow;

  if (!isPaginated) {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }
  
  isChangingChapter = true;
  try {
    // 停止語音 (如果是無縫過渡，則不停止)
    if (!isSeamless) {
      tts.stop();
    }

  const chapter = epubBookData.chapters[index];
  const contentEl = document.getElementById('book-content');
  let activeHashElem = null;
  
  // 加載 HTML (優先使用背景預載快取)
  let rawHtml;
  if (prefetchedChapterCache && prefetchedChapterCache.index === index) {
    rawHtml = prefetchedChapterCache.html;
    prefetchedChapterCache = null; // 用完即清空
  } else {
    rawHtml = await chapter.getContent();
  }

  // 判斷過渡方向 (根據新舊章節索引)
  const direction = (index > currentChapterIndex) ? 'forward' : 'backward';

  const updateDOM = () => {
    contentEl.innerHTML = rawHtml;
    
    // 清除書籍內置的干擾多欄排版的內聯樣式
    cleanUpBookInlineStyles(contentEl);
    cleanUpCorruptedCharacters(contentEl);

    // 根據 targetHash 校正並取得最精確的子章節索引
    let finalIdx = index;
    if (targetHash) {
      const bestIdx = findCorrectChapterIndexForHash(chapter.cleanHref, targetHash);
      if (bestIdx > -1) {
        finalIdx = bestIdx;
      }
    }
    
    currentChapterIndex = finalIdx;
    tts.currentChapterIndex = finalIdx;
    
    // 高亮目錄項目
    syncTOCActiveState(finalIdx);

    // ** 關鍵步驟 **: 將章節內容拆分為句子並包裹為 span (傳入 epubBookData 以處理子章節邊界)
    if (isSeamless) {
      tts.syncDOM(contentEl, epubBookData);
    } else {
      tts.prepareContainer(contentEl, epubBookData);
    }

    // 同步 TTS 索引與進行背景預加載，以防切換至後台時快取未熱而中斷播放
    let targetSentenceIdx = 0;
    if (targetSentenceIndex !== null) {
      targetSentenceIdx = targetSentenceIndex;
    } else if (restoreProgress && currentBook && currentBook.progress && currentBook.progress.chapterIndex === finalIdx) {
      targetSentenceIdx = currentBook.progress.activeSentenceIndex || 0;
    }
    
    tts.currentIndex = Math.max(0, Math.min(targetSentenceIdx, tts.sentences.length - 1));
    if (!tts.isPlaying) {
      tts.startPrefetch(tts.currentIndex);
    }

    // 處理內部跳轉鏈接 (EPUB)
    contentEl.querySelectorAll('[data-epub-href]').forEach(a => {
      a.addEventListener('click', (e) => {
        const targetHref = a.getAttribute('data-epub-href');
        const [cleanHref, hash] = targetHref.split('#');
        
        // 檢查目標文件是否與當前載入的文件相同，若是，則直接在頁面內跳轉，避免重新加載章節
        const currentChapter = epubBookData && epubBookData.chapters[currentChapterIndex];
        if (currentChapter && currentChapter.cleanHref === cleanHref) {
          if (hash) {
            const hashElem = document.getElementById(hash) || contentEl.querySelector(`[name="${hash.replace(/"/g, '\\"')}"]`);
            if (hashElem) {
              safeRestoreScrollToElementIndex(hashElem);
              
              // 同步更新當前章節索引為對應的精確子章節
              const bestIdx = findCorrectChapterIndexForHash(cleanHref, hash);
              if (bestIdx > -1 && bestIdx !== currentChapterIndex) {
                currentChapterIndex = bestIdx;
                tts.currentChapterIndex = bestIdx;
                syncTOCActiveState(bestIdx);
                updateReaderTitle();
              }
            }
          } else {
            // 回到該文件頂部
            if (document.body.classList.contains('layout-paginated')) {
              currentPageIndex = 0;
              updatePageTranslate(false);
            } else {
              window.scrollTo(0, 0);
            }
            // 同步更新為該文件的第一個章節索引
            const targetIdx = epubBookData.chapters.findIndex(ch => ch.cleanHref === cleanHref);
            if (targetIdx > -1 && targetIdx !== currentChapterIndex) {
              currentChapterIndex = targetIdx;
              tts.currentChapterIndex = targetIdx;
              syncTOCActiveState(targetIdx);
              updateReaderTitle();
            }
          }
        } else {
          // 搜尋目標 cleanHref 對應的章節索引
          const targetIdx = epubBookData.chapters.findIndex(ch => ch.cleanHref === cleanHref);
          if (targetIdx > -1) {
            loadChapter(targetIdx, false, false, true, false, null, null, null, hash || null);
          }
        }
      });
    });

    // 處理內部跳轉鏈接 (MOBI/AZW3 Kindle pos links)
    contentEl.querySelectorAll('a[href^="kindle:pos:fid:"]').forEach(a => {
      a.style.cursor = 'pointer';
      a.style.textDecoration = 'underline';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const href = a.getAttribute('href');
        const match = href.match(/kindle:pos:fid:([0-9A-Z]+):off:([0-9A-Z]+)/i);
        if (match && epubBookData && epubBookData.fragTable) {
          const fid = decodeBase32(match[1]);
          const entry = epubBookData.fragTable[fid];
          if (entry) {
            const offVal = decodeBase32(match[2]);
            const absTargetOffset = entry.offset + offVal;
            const targetSkeleton = entry.skeleton;
            let targetIdx = -1;
            
            // 優先使用 pos (字節偏移量) 進行精確匹配章節
            const hasPos = epubBookData.chapters.some(ch => ch.pos !== undefined);
            if (hasPos) {
              for (let i = 0; i < epubBookData.chapters.length; i++) {
                const ch = epubBookData.chapters[i];
                if (ch.pos !== undefined && ch.pos <= absTargetOffset) {
                  targetIdx = i;
                }
              }
            } else {
              // 退回到原有 skeleton 匹配
              for (let i = 0; i < epubBookData.chapters.length; i++) {
                const ch = epubBookData.chapters[i];
                if (ch.skeleton !== undefined && ch.skeleton <= targetSkeleton) {
                  targetIdx = i;
                }
              }
            }
            if (targetIdx > -1) {
              if (targetIdx === currentChapterIndex) {
                // 若目標章節即為當前章節，直接在頁面內滾動定位，避免重新加載章節
                const flowsStart = epubBookData.flowsStart || 0;
                const relativeByteOffset = absTargetOffset - flowsStart;
                if (relativeByteOffset > 0 && epubBookData.rawHtmlBytes) {
                  const slice = epubBookData.rawHtmlBytes.subarray(0, Math.min(relativeByteOffset, epubBookData.rawHtmlBytes.length));
                  const targetCharOffset = new TextDecoder('utf-8').decode(slice).length;
                  
                  const elements = contentEl.querySelectorAll('[data-char-offset]');
                  let minDiff = Infinity;
                  let bestElem = null;
                  elements.forEach(el => {
                    const charOffset = parseInt(el.getAttribute('data-char-offset'), 10);
                    if (!isNaN(charOffset)) {
                      const diff = Math.abs(charOffset - targetCharOffset);
                      if (diff < minDiff) {
                        minDiff = diff;
                        bestElem = el;
                      }
                    }
                  });
                  if (bestElem && minDiff < 500) {
                    safeRestoreScrollToElementIndex(bestElem);
                  }
                }
              } else {
                loadChapter(targetIdx, false, false, true, false, null, null, null, null, absTargetOffset);
              }
            }
          }
        }
      });
    });

    // 監聽圖片載入事件以重算翻頁排版與偏移
    contentEl.querySelectorAll('img').forEach(img => {
      img.addEventListener('load', () => {
        if (document.body.classList.contains('layout-paginated')) {
          applyLayoutDimensions();
          updatePageTranslate(false);
        }
      });
    });

    // 監聽樣式表載入事件以重算翻頁排版與偏移（主要用於 MOBI/AZW3 載入動態樣式）
    contentEl.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      link.addEventListener('load', () => {
        if (document.body.classList.contains('layout-paginated')) {
          applyLayoutDimensions();
          updatePageTranslate(false);
        }
      });
    });

    // 監聽字體載入事件以重算翻頁排版與偏移，確保字體渲染完成後排版精確
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (document.body.classList.contains('layout-paginated')) {
          applyLayoutDimensions();
          updatePageTranslate(false);
        }
      });
    }

    // 應用佈局尺寸以確保新載入的內容能有正確的分欄樣式
    applyLayoutDimensions();

    // 還原章節內的滾動高度或段落定位
    const finalHash = targetHash || (chapter && chapter.hash);
    if (finalHash) {
      activeHashElem = document.getElementById(finalHash) || contentEl.querySelector(`[name="${finalHash.replace(/"/g, '\\"')}"]`);
    }

    if (pendingGoToLastPageTimeout) {
      clearTimeout(pendingGoToLastPageTimeout);
      pendingGoToLastPageTimeout = null;
    }
    pendingGoToLastPage = false;

    let kindleTargetElem = null;
    if (targetKindleOffset !== null && epubBookData && epubBookData.rawHtmlBytes) {
      const flowsStart = epubBookData.flowsStart || 0;
      const relativeByteOffset = targetKindleOffset - flowsStart;
      if (relativeByteOffset > 0) {
        const slice = epubBookData.rawHtmlBytes.subarray(0, Math.min(relativeByteOffset, epubBookData.rawHtmlBytes.length));
        const targetCharOffset = new TextDecoder('utf-8').decode(slice).length;
        
        const elements = contentEl.querySelectorAll('[data-char-offset]');
        let minDiff = Infinity;
        let bestElem = null;
        elements.forEach(el => {
          const charOffset = parseInt(el.getAttribute('data-char-offset'), 10);
          if (!isNaN(charOffset)) {
            const diff = Math.abs(charOffset - targetCharOffset);
            if (diff < minDiff) {
              minDiff = diff;
              bestElem = el;
            }
          }
        });
        if (bestElem && minDiff < 500) {
          kindleTargetElem = bestElem;
        }
      }
    }

    if (targetPageIndex !== null || targetElementIndex !== null || targetSentenceIndex !== null) {
      if (targetSentenceIndex !== null) {
        // 等待分欄佈局就緒後，直接定位到特定句子元素，實現完美精準的高亮/筆記定位
        const sentenceEl = document.querySelector(`[data-sentence-index="${targetSentenceIndex}"]`);
        if (sentenceEl) {
          safeRestoreScrollToElementIndex(sentenceEl);
        } else {
          // 若找不到該句子，降級到使用段落索引
          const targetIdx = targetElementIndex !== null ? targetElementIndex : 0;
          safeRestoreScrollToElementIndex(targetIdx);
        }
      } else if (document.body.classList.contains('layout-paginated') && targetPageIndex !== null && targetPageIndex >= 0) {
        currentPageIndex = targetPageIndex;
        updatePageTranslate(false);
      } else {
        const targetIdx = targetElementIndex !== null ? targetElementIndex : 0;
        safeRestoreScrollToElementIndex(targetIdx);
      }
    } else if (kindleTargetElem) {
      safeRestoreScrollToElementIndex(kindleTargetElem);
    } else if (activeHashElem) {
      // 點擊目錄子標題或章節錨點跳轉時，精確滾動/翻頁到該錨點元素
      safeRestoreScrollToElementIndex(activeHashElem);
    } else if (restoreProgress && currentBook.progress && currentBook.progress.chapterIndex === index) {
      if (document.body.classList.contains('layout-paginated') && typeof currentBook.progress.currentPageIndex === 'number') {
        currentPageIndex = currentBook.progress.currentPageIndex;
        updatePageTranslate(false);
      } else {
        const savedElementIdx = currentBook.progress.elementIndex || 0;
        safeRestoreScrollToElementIndex(savedElementIdx);
      }
    } else {
      if (document.body.classList.contains('layout-paginated')) {
        if (goToLastPage) {
          pendingGoToLastPage = true;
          currentPageIndex = getLastPageIndex();
          pendingGoToLastPageTimeout = setTimeout(() => {
            pendingGoToLastPage = false;
            pendingGoToLastPageTimeout = null;
          }, 1000);
        } else {
          currentPageIndex = 0;
        }
        updatePageTranslate(false);
      } else {
        if (goToLastPage) {
          const scrollToBottom = () => {
            window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 999999);
          };
          scrollToBottom();
          setTimeout(scrollToBottom, 30);
          setTimeout(scrollToBottom, 100);
          setTimeout(scrollToBottom, 250);
          setTimeout(scrollToBottom, 500);

          // 監聽圖片載入以持續修正底部高度
          const imgs = contentEl.querySelectorAll('img');
          imgs.forEach(img => {
            if (!img.complete) {
              img.addEventListener('load', scrollToBottom, { once: true });
            }
          });
        } else {
          window.scrollTo(0, 0);
        }
      }
    }

    // 重新渲染高亮
    applySavedHighlightsToDOM();

    // 更新閱讀比例百分比，並同步更新內存與異步寫入資料庫
    if (currentBook) {
      const totalChapters = epubBookData.chapters.length;
      let percent = ((index + 1) / totalChapters) * 100;
      if (document.body.classList.contains('layout-paginated')) {
        const { totalPages } = getPaginatedPagesInfo();
        const progressFraction = (index + (currentPageIndex / Math.max(1, totalPages))) / totalChapters;
        percent = Math.max(0, Math.min(100, Math.round(progressFraction * 100)));
      } else {
        percent = Math.max(0, Math.min(100, Math.round(percent)));
      }
      const progressUpdate = { 
        chapterIndex: index, 
        percent, 
        activeSentenceIndex: 0,
        currentPageIndex: document.body.classList.contains('layout-paginated') ? currentPageIndex : 0
      };
      currentBook.progress = { ...currentBook.progress, ...progressUpdate };
      updateReaderTitle();
      library.updateProgress(currentBook.id, progressUpdate);
    }

    return waitForStylesheets(contentEl).then(() => {
      if (document.body.classList.contains('layout-paginated')) {
        applyLayoutDimensions();
        updatePageTranslate(false);
      }
    });
  };

    // 執行 View Transition
    if (animate && document.startViewTransition) {
      await transitionPage(updateDOM, direction);
    } else {
      const res = updateDOM();
      if (res && typeof res.then === 'function') {
        await res;
      }
    }
  } finally {
    isChangingChapter = false;
    lastChapterChangeTime = Date.now();
    if (!isPaginated) {
      setTimeout(() => {
        document.documentElement.style.overflow = origHtmlOverflow;
        document.body.style.overflow = origBodyOverflow;
        // 確保在溢出屬性恢復後，滾動目標被正確應用
        if (goToLastPage) {
          window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 999999);
        } else if (!restoreProgress && !targetKindleOffset && !targetHash && !activeHashElem && targetElementIndex === null && targetSentenceIndex === null && targetPageIndex === null) {
          window.scrollTo(0, 0);
        }
      }, 150);
    }
  }
}



// 載入漫畫指定頁面
async function loadComicPage(index) {
  if (!comicParserInstance || index < 0 || index >= comicParserInstance.chapters.length) return;
  
  const contentEl = document.getElementById('book-content');
  contentEl.innerHTML = `<div class="ai-loading"><div class="ai-loading-spinner"></div><span>${getMsg('loading_page', [String(index + 1)])}</span></div>`;

  const chapter = comicParserInstance.chapters[index];
  const url = await chapter.getImageUrl();
  activeResourceUrls.push(url);

  const img = document.createElement('img');
  img.src = url;
  img.className = 'comic-page';
  
  contentEl.innerHTML = '';
  contentEl.appendChild(img);

  // 更新頁碼指示器
  document.getElementById('comic-page-indicator').textContent = `${index + 1} / ${comicParserInstance.pages.length}`;

  // 保存進度
  const percent = ((index + 1) / comicParserInstance.pages.length) * 100;
  const progressUpdate = { comicImageIndex: index, percent };
  await library.updateProgress(currentBook.id, progressUpdate);
  currentBook.progress = { ...currentBook.progress, ...progressUpdate };

  window.scrollTo(0, 0);
  updateReaderTitle();
}

function prevComicPage() {
  if (currentBook && currentBook.format === 'cbz') {
    const curIdx = currentBook.progress?.comicImageIndex || 0;
    if (curIdx > 0) loadComicPage(curIdx - 1);
  }
}

function nextComicPage() {
  if (currentBook && currentBook.format === 'cbz') {
    const curIdx = currentBook.progress?.comicImageIndex || 0;
    if (comicParserInstance && curIdx < comicParserInstance.pages.length - 1) {
      loadComicPage(curIdx + 1);
    }
  }
}

// 尋找離給定坐標最近的 TTS 句子節點（用於優化點擊朗讀）
function findClosestTTSSentence(x, y) {
  const elements = document.querySelectorAll('#book-content .tts-sentence');
  let closestEl = null;
  let minDistance = Infinity;

  elements.forEach(el => {
    const rect = el.getBoundingClientRect();
    
    // 如果點擊正好在元素邊界內，直接返回該元素
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      closestEl = el;
      minDistance = 0;
      return;
    }

    // 計算點到矩形的最小距離
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < minDistance) {
      minDistance = distance;
      closestEl = el;
    }
  });

  // 如果最接近的元素在 60px 範圍內，則採用
  return minDistance < 60 ? closestEl : null;
}


// ==================== 4. 進度保存與元素定位 ==================== */

// 獲取目前滾動到最頂部的 DOM 元素索引
// 獲取目前滾動到最頂部的 DOM 元素索引
function getTopVisibleElementIndex() {
  const contentEl = document.getElementById('book-content');
  if (!contentEl) return 0;
  
  let children = contentEl.querySelectorAll('p, blockquote, pre, h1, h2, h3, h4, h5, h6, li');
  if (children.length === 0) {
    children = contentEl.children;
  }
  if (!children || children.length === 0) return 0;

  const container = document.getElementById('reader-container');
  const isPaginated = document.body.classList.contains('layout-paginated');
  if (isPaginated && container) {
    const containerRect = container.getBoundingClientRect();
    const paddingLeft = parseFloat(window.getComputedStyle(container).paddingLeft) || 0;
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      // 在翻頁模式下，如果元素的右側超出了容器實質內容區域的左側（即在當前頁或當前頁之後），那就是當前可見的元素
      if (rect.right > containerRect.left + paddingLeft + 10) {
        return i;
      }
    }
  } else {
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      // 考慮到 Header 高度 64px，抓取在 Header 下方的第一個元素
      if (rect.bottom > 80) {
        return i;
      }
    }
  }
  return 0;
}

// 根據索引或 DOM 元素滾動到指定位置
function restoreScrollToElementIndex(target) {
  const contentEl = document.getElementById('book-content');
  if (!contentEl) return;
  
  let elem = null;
  if (typeof target === 'number') {
    let children = contentEl.querySelectorAll('p, blockquote, pre, h1, h2, h3, h4, h5, h6, li');
    if (children.length === 0) {
      children = contentEl.children;
    }
    if (children && children[target]) {
      elem = children[target];
    }
  } else if (target instanceof HTMLElement) {
    if (document.body.contains(target)) {
      elem = target;
    }
  }
  
  if (elem) {
    const isPaginated = document.body.classList.contains('layout-paginated');
    if (isPaginated) {
      // 在翻頁模式下，計算目標元素在哪個分頁
      const contentRect = contentEl.getBoundingClientRect();
      
      // 若目標元素寬高為 0 (如 collapsed 或者是空的 inline 錨點 span)，向上尋找有實質寬高/佈局大小的父級或祖先元素
      let rectEl = elem;
      let elemRect = rectEl.getBoundingClientRect();
      while ((elemRect.width === 0 || elemRect.height === 0) && rectEl.parentElement && rectEl.parentElement !== contentEl) {
        rectEl = rectEl.parentElement;
        elemRect = rectEl.getBoundingClientRect();
      }
      
      const { totalPages, containerWidth, columnGap, isReady } = getPaginatedPagesInfo();
      
      // 如果佈局尚未準備就緒，延後重試，以防止讀取到 0 寬度座標
      if (!isReady) {
        safeRestoreScrollToElementIndex(target);
        return;
      }
      
      const relLeft = elemRect.left - contentRect.left;
      const step = containerWidth + columnGap;
      const halfGap = columnGap > 0 ? columnGap / 2 : 5;
      let pageIdx = step > 0 ? Math.floor((relLeft + halfGap) / step) : 0;
      
      if (pendingGoToLastPageTimeout) {
        clearTimeout(pendingGoToLastPageTimeout);
        pendingGoToLastPageTimeout = null;
      }
      pendingGoToLastPage = false;
      currentPageIndex = Math.max(0, Math.min(pageIdx, totalPages - 1));
      
      updatePageTranslate(false);
    } else {
      elem.scrollIntoView({ block: 'start' });
      // 向上補償滾動 Header 的高度
      window.scrollBy(0, -70);
    }
  }
}

// 安全地滾動到指定元素或索引（延遲執行以確保瀏覽器完成佈局排版與分欄）
function safeRestoreScrollToElementIndex(target) {
  setTimeout(() => {
    restoreScrollToElementIndex(target);
  }, 120);
}

// 獲取翻頁模式的頁面與寬度資訊
function getPaginatedPagesInfo() {
  const container = document.getElementById('reader-container');
  const content = document.getElementById('book-content');
  if (!container || !content) return { totalPages: 1, containerWidth: 800, columnGap: 80, isReady: false };
  
  // 使用 CSS 實質內容寬度（排除 padding / margins），確保翻頁位移精確匹配列寬度
  let containerWidth = parseFloat(window.getComputedStyle(container).width);
  if (isNaN(containerWidth) || containerWidth <= 0) {
    containerWidth = container.clientWidth;
  }
  
  // 動態讀取 columnGap，如果未設置或為 normal，預設為 40，單頁時為 0
  let columnGap = parseFloat(window.getComputedStyle(content).columnGap) || 0;
  if (isNaN(columnGap)) {
    const isMobile = window.innerWidth < 768;
    columnGap = isMobile ? 0 : 80;
  }
  
  // 暫時重置 transform 以免影響 getBoundingClientRect() 計算
  const oldTransform = content.style.transform;
  content.style.transform = 'none';

  // 計算實際內容的最右端位置，以應對 scrollWidth 不準確（如瀏覽器多欄排版空列 Bug）的情況
  let actualWidth = 0;
  let hasChildren = content.children.length > 0;
  let hasLayoutVisibleChildren = false;

  if (hasChildren) {
    const contentRect = content.getBoundingClientRect();
    let maxRight = 0;
    for (let i = 0; i < content.children.length; i++) {
      const child = content.children[i];
      const tagName = child.tagName.toLowerCase();
      if (tagName === 'link' || tagName === 'meta' || tagName === 'title' || tagName === 'style' || tagName === 'script') {
        continue;
      }
      const rect = child.getBoundingClientRect();
      // 僅計算有實際寬高（可見）的元素，防止隱藏 of boilerplate tag 干擾寬度計算
      if (rect.width > 0 || rect.height > 0) {
        hasLayoutVisibleChildren = true;
        const relRight = rect.right - contentRect.left;
        if (relRight > maxRight) {
          maxRight = relRight;
        }
      }
    }
    actualWidth = maxRight;
  }
  
  // 雙重防線：若計算出的寬度無效，回退到 scrollWidth
  if (actualWidth <= 0) {
    actualWidth = content.scrollWidth;
  }
  
  // 還原 transform
  content.style.transform = oldTransform;
  
  const totalPages = Math.max(1, Math.ceil((actualWidth + columnGap) / (containerWidth + columnGap)));
  const isReady = containerWidth > 0 && (!hasChildren || hasLayoutVisibleChildren || actualWidth > 0);

  return { totalPages, containerWidth, columnGap, isReady };
}

function createClonedPageView(offset, clipSide = 'full') {
  const wrapper = document.createElement('div');
  wrapper.className = `cloned-page-wrapper clip-${clipSide}`;
  wrapper.style.position = 'absolute';
  wrapper.style.top = '0';
  wrapper.style.bottom = '0';
  wrapper.style.overflow = 'hidden';
  
  if (clipSide === 'full') {
    wrapper.style.left = '0';
    wrapper.style.width = '100%';
  } else if (clipSide === 'left') {
    wrapper.style.left = '0';
    wrapper.style.width = '50%';
  } else if (clipSide === 'right') {
    wrapper.style.left = '50%';
    wrapper.style.width = '50%';
  }
  
  // Clone book-content and keep the ID to preserve CSS rules
  const content = document.getElementById('book-content');
  const clone = content.cloneNode(true);
  clone.style.position = 'absolute';
  clone.style.top = '0';
  clone.style.height = '100%';
  clone.style.transition = 'none'; // 禁用動畫
  clone.style.transform = `translateX(-${offset}px)`;
  
  if (clipSide === 'right') {
    clone.style.left = '-100%';
    clone.style.width = '200%';
  } else if (clipSide === 'left') {
    clone.style.left = '0';
    clone.style.width = '200%';
  } else {
    clone.style.left = '0';
    clone.style.width = '100%';
  }
  
  wrapper.appendChild(clone);
  
  // 複製紙張底紋卡片作為背景
  const slideContainer = document.getElementById('page-texture-slide');
  if (slideContainer) {
    const originalCard = slideContainer.querySelector('.page-texture-card');
    if (originalCard) {
      const cardClone = originalCard.cloneNode(true);
      const paddingSlider = document.getElementById('page-padding-slider');
      const paperPad = paddingSlider ? (parseInt(paddingSlider.value) || 0) : 24;
      
      cardClone.style.left = `-${paperPad}px`;
      cardClone.style.width = `calc(100% + ${2 * paperPad}px)`;
      cardClone.style.top = `-${paperPad}px`;
      cardClone.style.bottom = `-${paperPad}px`;
      cardClone.style.height = `calc(100% + ${2 * paperPad}px)`;
      cardClone.style.position = 'absolute';
      cardClone.style.margin = '0';
      cardClone.style.zIndex = '-1'; // 置於文字下方
      wrapper.appendChild(cardClone);
    }
  }
  
  return wrapper;
}

function runCustom3DFlip(oldIndex, newIndex) {
  const container = document.querySelector('.reader-container');
  if (!container) return;
  
  const content = document.getElementById('book-content');
  if (!content) return;
  
  const direction = newIndex > oldIndex ? 'forward' : 'backward';
  const cols = parseInt(content.style.columnCount) || 1;
  
  const containerStyle = window.getComputedStyle(container);
  const paddingTop = parseFloat(containerStyle.paddingTop) || 0;
  const paddingBottom = parseFloat(containerStyle.paddingBottom) || 0;
  const paddingLeft = parseFloat(containerStyle.paddingLeft) || 0;
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  
  const { containerWidth: pageContainerWidth, columnGap } = getPaginatedPagesInfo();
  const oldOffset = oldIndex * (pageContainerWidth + columnGap);
  const newOffset = newIndex * (pageContainerWidth + columnGap);
  
  // 建立 3D 覆蓋容器
  const overlay = document.createElement('div');
  overlay.className = 'flipping-3d-overlay';
  overlay.style.position = 'absolute';
  overlay.style.top = `${paddingTop}px`;
  overlay.style.height = `${containerHeight}px`;
  overlay.style.left = `${paddingLeft}px`;
  overlay.style.width = `${containerWidth}px`;
  overlay.style.zIndex = '9999';
  overlay.style.pointerEvents = 'none';
  overlay.style.perspective = '2000px';
  container.appendChild(overlay);
  
  // 建立脊線陰影元素
  const spineShadow = document.createElement('div');
  spineShadow.className = 'flipping-spine-shadow';
  spineShadow.style.position = 'absolute';
  spineShadow.style.top = '0';
  spineShadow.style.bottom = '0';
  spineShadow.style.height = '100%';
  if (cols === 2) {
    spineShadow.style.left = '50%';
    spineShadow.style.width = '2px';
  } else {
    spineShadow.style.left = '0';
    spineShadow.style.width = '2px';
  }
  overlay.appendChild(spineShadow);

  // 立即更新主容器位置至新頁面（使翻開後底層內容已載入完畢）
  content.style.transform = `translateX(-${newOffset}px)`;
  updatePageTextureTranslate();
  
  if (cols === 1) {
    if (direction === 'forward') {
      const card = document.createElement('div');
      card.className = 'flipping-card cols-1-forward';
      card.style.position = 'absolute';
      card.style.left = '0';
      card.style.top = '0';
      card.style.width = '100%';
      card.style.height = '100%';
      card.style.transformStyle = 'preserve-3d';
      card.style.transformOrigin = 'left center';
      overlay.appendChild(card);
      
      const front = document.createElement('div');
      front.className = 'flipping-face flipping-front';
      front.style.position = 'absolute';
      front.style.left = '0';
      front.style.top = '0';
      front.style.width = '100%';
      front.style.height = '100%';
      front.style.backfaceVisibility = 'hidden';
      front.style.webkitBackfaceVisibility = 'hidden';
      front.appendChild(createClonedPageView(oldOffset, 'full'));
      card.appendChild(front);
      
      card.style.animation = 'flip-card-cols1-forward 0.65s cubic-bezier(0.25, 1, 0.5, 1) forwards';
      
    } else { // cols-1 backward
      const staticOverlay = createClonedPageView(oldOffset, 'full');
      overlay.appendChild(staticOverlay);
      
      const card = document.createElement('div');
      card.className = 'flipping-card cols-1-backward';
      card.style.position = 'absolute';
      card.style.left = '0';
      card.style.top = '0';
      card.style.width = '100%';
      card.style.height = '100%';
      card.style.transformStyle = 'preserve-3d';
      card.style.transformOrigin = 'left center';
      overlay.appendChild(card);
      
      const front = document.createElement('div');
      front.className = 'flipping-face flipping-front';
      front.style.position = 'absolute';
      front.style.left = '0';
      front.style.top = '0';
      front.style.width = '100%';
      front.style.height = '100%';
      front.style.backfaceVisibility = 'hidden';
      front.style.webkitBackfaceVisibility = 'hidden';
      front.appendChild(createClonedPageView(newOffset, 'full'));
      card.appendChild(front);
      
      card.style.animation = 'flip-card-cols1-backward 0.65s cubic-bezier(0.25, 1, 0.5, 1) forwards';
    }
    
  } else if (cols === 2) {
    if (direction === 'forward') {
      const leftStatic = createClonedPageView(oldOffset, 'left');
      overlay.appendChild(leftStatic);
      
      const card = document.createElement('div');
      card.className = 'flipping-card cols-2-forward';
      card.style.position = 'absolute';
      card.style.left = '50%';
      card.style.top = '0';
      card.style.width = '50%';
      card.style.height = '100%';
      card.style.transformStyle = 'preserve-3d';
      card.style.transformOrigin = 'left center'; // 脊線
      overlay.appendChild(card);
      
      const front = document.createElement('div');
      front.className = 'flipping-face flipping-front';
      front.style.position = 'absolute';
      front.style.left = '0';
      front.style.top = '0';
      front.style.width = '100%';
      front.style.height = '100%';
      front.style.backfaceVisibility = 'hidden';
      front.style.webkitBackfaceVisibility = 'hidden';
      front.appendChild(createClonedPageView(oldOffset, 'right'));
      card.appendChild(front);
      
      const back = document.createElement('div');
      back.className = 'flipping-face flipping-back';
      back.style.position = 'absolute';
      back.style.left = '0';
      back.style.top = '0';
      back.style.width = '100%';
      back.style.height = '100%';
      back.style.backfaceVisibility = 'hidden';
      back.style.webkitBackfaceVisibility = 'hidden';
      back.style.transform = 'rotateY(180deg)';
      back.appendChild(createClonedPageView(newOffset, 'left'));
      card.appendChild(back);
      
      card.style.animation = 'flip-card-cols1-forward 0.65s cubic-bezier(0.25, 1, 0.5, 1) forwards';
      
      // 翻頁至垂直時 (動畫中段 325ms) 隱藏左側靜態遮罩
      setTimeout(() => {
        leftStatic.style.display = 'none';
      }, 325);
      
    } else { // cols-2 backward
      const rightStatic = createClonedPageView(oldOffset, 'right');
      overlay.appendChild(rightStatic);
      
      const card = document.createElement('div');
      card.className = 'flipping-card cols-2-backward';
      card.style.position = 'absolute';
      card.style.left = '0';
      card.style.top = '0';
      card.style.width = '50%';
      card.style.height = '100%';
      card.style.transformStyle = 'preserve-3d';
      card.style.transformOrigin = 'right center'; // 脊線
      overlay.appendChild(card);
      
      const front = document.createElement('div');
      front.className = 'flipping-face flipping-front';
      front.style.position = 'absolute';
      front.style.left = '0';
      front.style.top = '0';
      front.style.width = '100%';
      front.style.height = '100%';
      front.style.backfaceVisibility = 'hidden';
      front.style.webkitBackfaceVisibility = 'hidden';
      front.appendChild(createClonedPageView(oldOffset, 'left'));
      card.appendChild(front);
      
      const back = document.createElement('div');
      back.className = 'flipping-face flipping-back';
      back.style.position = 'absolute';
      back.style.left = '0';
      back.style.top = '0';
      back.style.width = '100%';
      back.style.height = '100%';
      back.style.backfaceVisibility = 'hidden';
      back.style.webkitBackfaceVisibility = 'hidden';
      back.style.transform = 'rotateY(180deg)';
      back.appendChild(createClonedPageView(newOffset, 'right'));
      card.appendChild(back);
      
      card.style.animation = 'flip-card-cols2-backward 0.65s cubic-bezier(0.25, 1, 0.5, 1) forwards';
      
      setTimeout(() => {
        rightStatic.style.display = 'none';
      }, 325);
    }
  }
  
  // 清理覆蓋層
  setTimeout(() => {
    overlay.remove();
  }, 700);
}

let lastActivePageIndex = 0;

// 更新翻頁模式的水平位移
function updatePageTranslate(animate = true) {
  if (!document.body.classList.contains('layout-paginated')) return;
  
  const { totalPages, containerWidth, columnGap, isReady } = getPaginatedPagesInfo();
  // 限制 currentPageIndex 在範圍內，僅在佈局就緒後進行限制，避免在佈局尚未載入完成時將 index 誤剪裁為 0
  if (isReady) {
    if (pendingGoToLastPage) {
      currentPageIndex = totalPages - 1;
    } else {
      currentPageIndex = Math.max(0, Math.min(currentPageIndex, totalPages - 1));
    }
  }
  
  const content = document.getElementById('book-content');
  const offset = currentPageIndex * (containerWidth + columnGap);
  
  const oldIndex = lastActivePageIndex;
  lastActivePageIndex = currentPageIndex;
  
  if (!animate || oldIndex === currentPageIndex) {
    content.style.transform = `translateX(-${offset}px)`;
    updatePageTextureTranslate();
  } else {
    const isFlip = document.documentElement.classList.contains('transition-flip');
    const cols = content ? (parseInt(content.style.columnCount) || 1) : 1;
    
    if (isFlip && cols <= 2) {
      runCustom3DFlip(oldIndex, currentPageIndex);
    } else {
      const direction = (currentPageIndex > oldIndex) ? 'forward' : 'backward';
      transitionPage(() => {
        content.style.transform = `translateX(-${offset}px)`;
        updatePageTextureTranslate();
      }, direction);
    }
  }
  
  // 保存進度并計算精確百分比
  if (currentBook) {
    let percent = currentBook.progress?.percent || 0;
    if (epubBookData && epubBookData.chapters && epubBookData.chapters.length > 0) {
      const totalChapters = epubBookData.chapters.length;
      const progressFraction = (currentChapterIndex + (currentPageIndex / Math.max(1, totalPages))) / totalChapters;
      percent = Math.max(0, Math.min(100, Math.round(progressFraction * 100)));
    }
    
    saveProgressDebounced({
      chapterIndex: currentChapterIndex,
      elementIndex: getTopVisibleElementIndex(),
      currentPageIndex: currentPageIndex,
      percent: percent
    });
  }
  
  // 更新標題欄進度百分比
  updateReaderTitle();
}

// 獲取當前章節的最後一頁索引
function getLastPageIndex() {
  const { totalPages } = getPaginatedPagesInfo();
  return totalPages - 1;
}

// 頁面導航（翻頁）
function navigatePage(direction) {
  if (!document.body.classList.contains('layout-paginated')) return;
  
  if (pendingGoToLastPageTimeout) {
    clearTimeout(pendingGoToLastPageTimeout);
    pendingGoToLastPageTimeout = null;
  }
  pendingGoToLastPage = false;
  
  const { totalPages } = getPaginatedPagesInfo();
  
  if (direction === 'next') {
    if (currentPageIndex < totalPages - 1) {
      currentPageIndex++;
      updatePageTranslate();
    } else {
      // 載入下一章
      if (epubBookData && currentChapterIndex < epubBookData.chapters.length - 1) {
        loadChapter(currentChapterIndex + 1);
      }
    }
  } else if (direction === 'prev') {
    if (currentPageIndex > 0) {
      currentPageIndex--;
      updatePageTranslate();
    } else {
      // 載入前一章的最後一頁
      if (currentChapterIndex > 0) {
        loadChapter(currentChapterIndex - 1, true);
      }
    }
  }
}

// 防抖保存進度
let saveTimeout = null;
function saveProgressDebounced(update) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    if (currentBook) {
      await library.updateProgress(currentBook.id, update);
      // 更新內存狀態
      currentBook.progress = { ...currentBook.progress, ...update };
    }
  }, 1000);
}

// 頁面關閉時的強制立即保存
async function forceSaveCurrentProgress() {
  if (currentBook && !isSavingProgress) {
    isSavingProgress = true;
    const update = {};
    
    if (currentBook.format === 'cbz') {
      update.comicImageIndex = currentBook.progress?.comicImageIndex || 0;
      const totalPages = comicParserInstance ? comicParserInstance.pages.length : 1;
      update.percent = ((update.comicImageIndex + 1) / totalPages) * 100;
    } else {
      update.chapterIndex = currentChapterIndex;
      update.elementIndex = getTopVisibleElementIndex();
      update.scrollTop = window.scrollY;
      update.activeSentenceIndex = tts.currentIndex;
      if (document.body.classList.contains('layout-paginated')) {
        update.currentPageIndex = currentPageIndex;
      }
    }
    
    await library.updateProgress(currentBook.id, update);
    isSavingProgress = false;
  }
}

function updateReaderTitle() {
  if (!currentBook) return;
  const titleEl = document.getElementById('reader-book-title');
  if (!titleEl) return;

  let percent = 0;
  if (currentBook.format === 'cbz') {
    if (comicParserInstance && comicParserInstance.pages.length > 0) {
      const pageIdx = typeof currentBook.progress?.comicImageIndex === 'number' ? currentBook.progress.comicImageIndex : 0;
      percent = Math.round(((pageIdx + 1) / comicParserInstance.pages.length) * 100);
      percent = Math.max(0, Math.min(100, percent));
      titleEl.textContent = `${currentBook.title} - Page ${pageIdx + 1} / ${comicParserInstance.pages.length} (${percent}%)`;
      return;
    }
  } else {
    if (epubBookData && epubBookData.chapters && epubBookData.chapters.length > 0) {
      const totalChapters = epubBookData.chapters.length;
      const chapter = epubBookData.chapters[currentChapterIndex];
      const chapterTitle = chapter && chapter.title ? chapter.title.trim() : '';
      
      if (document.body.classList.contains('layout-paginated')) {
        const { totalPages } = getPaginatedPagesInfo();
        const progressFraction = (currentChapterIndex + (currentPageIndex / Math.max(1, totalPages))) / totalChapters;
        percent = Math.round(progressFraction * 100);
      } else {
        percent = Math.round(((currentChapterIndex + 1) / totalChapters) * 100);
      }
      percent = Math.max(0, Math.min(100, percent));
      
      if (chapterTitle) {
        titleEl.textContent = `${currentBook.title} - ${chapterTitle} (${percent}%)`;
      } else {
        titleEl.textContent = `${currentBook.title} (${percent}%)`;
      }
      return;
    }
  }
  
  titleEl.textContent = currentBook.title;
}


// ==================== 5. 樣式、主題與快捷鍵設定 ==================== */

function initThemeAndStyles() {
  // 從 Storage 讀取設定，否則採用預設值
  chrome.storage.local.get(['theme', 'fontSize', 'fontFamily', 'lineHeight', 'marginWidth', 'marginTop', 'marginBottom', 'layoutMode', 'pagesDisplayed', 'ttsHighlightStyle', 'ttsRate', 'paperTexture', 'pagePadding', 'transitionEffect', 'ttsOnlyEdge'], (res) => {
    setTheme(res.theme || 'sepia');
    setFontFamily(res.fontFamily || 'font-lxgw');
    setFontSize(res.fontSize || 19);
    setLineHeight(res.lineHeight || 1.5);
    setMargins(res.marginWidth || 5);
    setMarginTop(50); // 強制設定上方留白為 50px
    setMarginBottom(50); // 強制設定下方留白為 50px
    setPagePadding(40); // 強制設定紙張邊框留白為 40px
    
    // 是否僅顯示 Edge 語音
    ttsOnlyEdge = res.ttsOnlyEdge === true;
    updateEdgeFilterButtonVisibility();
    
    // 朗讀速度
    const savedRate = res.ttsRate || 1.0;
    tts.rate = savedRate;
    document.getElementById('tts-speed-slider').value = savedRate;
    document.getElementById('tts-speed-val').textContent = `${savedRate.toFixed(1)}x`;
    
    // 朗讀高亮樣式
    const highlightStyle = res.ttsHighlightStyle || 'highlight-style-yellow';
    tts.highlightStyle = highlightStyle;
    document.getElementById('tts-highlight-style-select').value = highlightStyle;
    
    // 顯示頁數
    const pagesDisplayed = res.pagesDisplayed || '2';
    setPagesDisplayed(pagesDisplayed);
    document.getElementById('pages-displayed-select').value = pagesDisplayed;

    // 紙張底紋
    const savedTexture = res.paperTexture || 'texture-aged';
    setPaperTexture(savedTexture);
    document.getElementById('paper-texture-select').value = savedTexture;

    // 翻頁動畫效果 (移除 3D Flip，若舊設定為 flip 則降級為 slide)
    let transitionEffect = res.transitionEffect || 'slide';
    if (transitionEffect === 'flip') {
      transitionEffect = 'slide';
    }
    setTransitionEffect(transitionEffect);
    document.getElementById('transition-effect-select').value = transitionEffect;

    toggleLayoutMode(res.layoutMode || 'paginated');

    // 反向初始化 UI 控制器值
    document.getElementById('font-family-select').value = res.fontFamily || 'font-lxgw';
    document.getElementById('font-size-slider').value = res.fontSize || 19;
    document.getElementById('line-height-slider').value = res.lineHeight || 1.5;
    document.getElementById('margin-width-slider').value = res.marginWidth || 5;
    document.getElementById('margin-top-slider').value = 50;
    document.getElementById('margin-bottom-slider').value = 50;
    document.getElementById('page-padding-slider').value = 40;
    
    document.querySelectorAll('.theme-dot').forEach(dot => {
      if (dot.getAttribute('data-theme') === (res.theme || 'sepia')) dot.classList.add('active');
      else dot.classList.remove('active');
    });
  });
}

function setTheme(theme) {
  const classesToRemove = Array.from(document.body.classList).filter(c => c.startsWith('theme-'));
  classesToRemove.forEach(c => document.body.classList.remove(c));
  document.body.classList.add(`theme-${theme}`);
  chrome.storage.local.set({ theme });
}

function setFontFamily(fontFamily) {
  const container = document.getElementById('reader-container');
  container.className = `reader-container ${fontFamily}`;
  chrome.storage.local.set({ fontFamily });
}

function setFontSize(size) {
  const topIdx = getTopVisibleElementIndex();
  document.getElementById('book-content').style.fontSize = `${size}px`;
  document.getElementById('font-size-val').textContent = `${size}px`;
  chrome.storage.local.set({ fontSize: size });
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

// 變更行距樣式並重算佈局
function setLineHeight(val) {
  const topIdx = getTopVisibleElementIndex();
  document.getElementById('book-content').style.lineHeight = val;
  document.getElementById('line-height-val').textContent = val;
  chrome.storage.local.set({ lineHeight: val });
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setMargins(val) {
  const topIdx = getTopVisibleElementIndex();
  const container = document.getElementById('reader-container');
  container.style.paddingLeft = `${val}%`;
  container.style.paddingRight = `${val}%`;
  document.getElementById('margin-width-val').textContent = `${val}%`;
  chrome.storage.local.set({ marginWidth: val });
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setMarginTop(val) {
  const topIdx = getTopVisibleElementIndex();
  const intVal = parseInt(val) || 40;
  document.getElementById('margin-top-val').textContent = `${intVal}px`;
  chrome.storage.local.set({ marginTop: intVal });
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setMarginBottom(val) {
  const topIdx = getTopVisibleElementIndex();
  const intVal = parseInt(val) || 40;
  document.getElementById('margin-bottom-val').textContent = `${intVal}px`;
  chrome.storage.local.set({ marginBottom: intVal });
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setPagePadding(val) {
  const topIdx = getTopVisibleElementIndex();
  const intVal = parseInt(val);
  const valEl = document.getElementById('page-padding-val');
  if (valEl) {
    valEl.textContent = `${intVal}px`;
  }
  chrome.storage.local.set({ pagePadding: intVal });
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setPagesDisplayed(val) {
  const topIdx = getTopVisibleElementIndex();
  currentPagesDisplayed = val || 'auto';
  chrome.storage.local.set({ pagesDisplayed: currentPagesDisplayed });
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setPaperTexture(texture) {
  currentPaperTexture = texture || 'texture-classic';
  // 移除所有 texture-* 類別
  const classesToRemove = Array.from(document.body.classList).filter(c => c.startsWith('texture-'));
  classesToRemove.forEach(c => document.body.classList.remove(c));
  document.body.classList.add(currentPaperTexture);
  chrome.storage.local.set({ paperTexture: currentPaperTexture });
}

function setTransitionEffect(effect) {
  const html = document.documentElement;
  // 移除所有 transition- 類別
  const classesToRemove = Array.from(html.classList).filter(c => c.startsWith('transition-'));
  classesToRemove.forEach(c => html.classList.remove(c));
  html.classList.add(`transition-${effect}`);
  chrome.storage.local.set({ transitionEffect: effect });
}

// 動態生成每頁紙張底紋覆蓋卡片，與 CSS 多欄分頁對齊
function updatePageTextureOverlay(cols, colWidth, colGap, sidePadding, topPadding, bottomPadding) {
  const overlay = document.getElementById('page-texture-overlay');
  if (!overlay) return;

  // 清空舊內容
  overlay.innerHTML = '';

  // 滾動模式不需要多卡片
  if (!document.body.classList.contains('layout-paginated')) return;

  const { totalPages } = getPaginatedPagesInfo();

  // 建立滑動容器（存放紙張卡片，隨翻頁滑動）
  const slideContainer = document.createElement('div');
  slideContainer.id = 'page-texture-slide';
  slideContainer.className = 'page-texture-slide';
  overlay.appendChild(slideContainer);

  // 建立靜態容器（存放書脊折痕，固定在螢幕中央）
  const staticContainer = document.createElement('div');
  staticContainer.id = 'page-crease-static';
  staticContainer.className = 'page-crease-static';
  overlay.appendChild(staticContainer);

  const paddingSlider = document.getElementById('page-padding-slider');
  const paperPad = paddingSlider ? (parseInt(paddingSlider.value) || 0) : 24; // 紙張四周留白大小 (px)

  // 為每個分頁頁面建立紙張卡片，放進滑動容器
  for (let i = 0; i < totalPages * cols; i++) {
    const card = document.createElement('div');
    card.className = 'page-texture-card';
    
    // 計算卡片 left/width/top/bottom，使其擴展到文字區域之外
    const left = sidePadding + i * (colWidth + colGap) - paperPad;
    const width = colWidth + 2 * paperPad;
    const top = topPadding - paperPad;
    const bottom = bottomPadding - paperPad;

    card.style.left = `${left}px`;
    card.style.width = `${width}px`;
    card.style.top = `${top}px`;
    card.style.bottom = `${bottom}px`;
    
    // 依據在跨頁中的相對位置給予邊緣陰影類別
    const positionInSpread = i % cols;
    if (positionInSpread === 0) {
      card.classList.add('card-left-edge');
    }
    if (positionInSpread === cols - 1) {
      card.classList.add('card-right-edge');
    }

    // 建立頁碼標籤 (當前頁碼 / 總頁數)
    const pageLabel = document.createElement('div');
    pageLabel.className = 'page-number-label';
    pageLabel.textContent = `${i + 1} / ${totalPages * cols}`;
    card.appendChild(pageLabel);
    
    slideContainer.appendChild(card);
  }

  // 在相鄰頁之間加入書脊折痕，放進靜態容器
  for (let i = 0; i < cols - 1; i++) {
    const crease = document.createElement('div');
    crease.className = 'page-spine-crease';
    
    // 折痕寬度等於 colGap，起始點為左欄右側，完美覆蓋相鄰紙張邊緣與中間縫隙
    const leftTextEnd = sidePadding + (i + 1) * colWidth + i * colGap;
    const top = topPadding - paperPad;
    const bottom = bottomPadding - paperPad;

    crease.style.left = `${leftTextEnd}px`;
    crease.style.width = `${colGap}px`;
    crease.style.top = `${top}px`;
    crease.style.bottom = `${bottom}px`;
    staticContainer.appendChild(crease);
  }

  // 同步更新滑動容器的位移
  updatePageTextureTranslate();
}

function updatePageTextureTranslate() {
  if (!document.body.classList.contains('layout-paginated')) return;
  const slideContainer = document.getElementById('page-texture-slide');
  if (!slideContainer) return;
  
  const { totalPages, containerWidth, columnGap } = getPaginatedPagesInfo();
  
  // 獲取當前欄數，用以計算正確的總卡片數
  const content = document.getElementById('book-content');
  const cols = content ? (parseInt(content.style.columnCount) || 1) : 1;
  
  // 雙重防禦自癒：若紙張卡片數量與最新排版總頁數不符，立即重新生成底紋卡片
  if (slideContainer.children.length !== totalPages * cols) {
    if (content) {
      applyLayoutDimensions();
      return; // applyLayoutDimensions 在重新生成卡片後會重新呼叫本函數
    }
  }
  
  const offset = currentPageIndex * (containerWidth + columnGap);
  slideContainer.style.transform = `translateX(-${offset}px)`;
}

function setTtsHighlightStyle(style) {
  tts.highlightStyle = style;
  chrome.storage.local.set({ ttsHighlightStyle: style });
  
  if (tts.isPlaying && tts.sentences.length > 0) {
    const current = tts.sentences[tts.currentIndex];
    if (current) {
      tts._highlightSentence(current);
    }
  }
}

function applyLayoutDimensions() {
  const content = document.getElementById('book-content');
  const container = document.getElementById('reader-container');
  if (!content || !container) return;

  const marginSlider = document.getElementById('margin-width-slider');
  const marginPercent = marginSlider ? parseInt(marginSlider.value) : 15;
  
  const marginTopSlider = document.getElementById('margin-top-slider');
  const topPaddingGap = marginTopSlider ? parseInt(marginTopSlider.value) : 40;
  const topPadding = topPaddingGap + 64; // Add 64px to clear the header
  
  const marginBottomSlider = document.getElementById('margin-bottom-slider');
  const bottomPadding = marginBottomSlider ? parseInt(marginBottomSlider.value) : 40;

  if (!document.body.classList.contains('layout-paginated')) {
    container.style.width = '';
    container.style.maxWidth = '';
    container.style.boxSizing = '';
    container.style.paddingLeft = `${marginPercent}%`;
    container.style.paddingRight = `${marginPercent}%`;
    container.style.setProperty('padding-top', `${topPadding}px`, 'important');
    container.style.setProperty('padding-bottom', `${bottomPadding}px`, 'important');
    container.style.setProperty('height', '', '');
    content.style.columnCount = '';
    content.style.columnWidth = '';
    content.style.columnGap = '';
    const pagesDisplayedContainer = document.getElementById('pages-displayed-container');
    if (pagesDisplayedContainer) pagesDisplayedContainer.style.display = 'none';
    const pagePaddingContainer = document.getElementById('page-padding-container');
    if (pagePaddingContainer) pagePaddingContainer.style.display = 'none';
    const transitionEffectContainer = document.getElementById('transition-effect-container');
    if (transitionEffectContainer) transitionEffectContainer.style.display = 'none';
    // 滾動模式下生成單頁底紋覆蓋
    updatePageTextureOverlay(1, container.clientWidth, 0, 0, 0, 0);
    return;
  }

  const pagesDisplayedContainer = document.getElementById('pages-displayed-container');
  if (pagesDisplayedContainer) pagesDisplayedContainer.style.display = 'block';
  const pagePaddingContainer = document.getElementById('page-padding-container');
  if (pagePaddingContainer) pagePaddingContainer.style.display = 'none'; // 保持隱藏以符合需求
  const transitionEffectContainer = document.getElementById('transition-effect-container');
  if (transitionEffectContainer) transitionEffectContainer.style.display = 'block';

  const viewportWidth = window.innerWidth;
  
  const gap = 80;
  container.style.boxSizing = 'content-box';
  
  // Set padding-top, padding-bottom and height dynamically with important
  container.style.setProperty('padding-top', `${topPadding}px`, 'important');
  container.style.setProperty('padding-bottom', `${bottomPadding}px`, 'important');
  container.style.setProperty('height', `calc(100vh - ${topPadding + bottomPadding}px)`, 'important');
  
  const availableWidth = viewportWidth * (1 - 2 * marginPercent / 100);

  let cols = 1;
  let containerWidthVal = availableWidth;
  let colWidthVal = availableWidth;
  let colGapVal = gap;
  let sidePadding = 40; // 電腦大螢幕預設內邊距，提供精緻的紙張頁邊

  if (viewportWidth < 768) {
    // 手機/窄螢幕：強制佔滿全部螢幕，單頁顯示，小內邊距
    sidePadding = 16;
    cols = 1;
    colGapVal = 0;
    containerWidthVal = viewportWidth - 2 * sidePadding;
    colWidthVal = containerWidthVal;
  } else {
    // 電腦大螢幕：根據用戶設定或自適應來決定分欄顯示的頁數
    if (currentPagesDisplayed === 'auto') {
      cols = (availableWidth >= 940) ? 2 : 1;
    } else {
      cols = parseInt(currentPagesDisplayed) || 1;
    }
    colGapVal = gap;
    
    // 對齊真實紙張邊框：減去兩側內邊距後計算分欄寬度
    const contentWidth = availableWidth - 2 * sidePadding;
    colWidthVal = (contentWidth - (cols - 1) * colGapVal) / cols;
    containerWidthVal = contentWidth;
  }

  // 動態綁定 cols-X 類別，供 CSS 樣式折痕 (Spine Crease) 使用
  const body = document.body;
  body.classList.remove('cols-1', 'cols-2', 'cols-3');
  body.classList.add(`cols-${cols}`);

  container.style.setProperty('padding-left', `${sidePadding}px`, 'important');
  container.style.setProperty('padding-right', `${sidePadding}px`, 'important');
  container.style.width = `${containerWidthVal}px`;
  container.style.maxWidth = '100%';
  content.style.columnCount = cols.toString();
  content.style.columnWidth = `${colWidthVal}px`;
  content.style.columnGap = `${colGapVal}px`;

  // 更新每頁紙張底紋覆蓋層
  updatePageTextureOverlay(cols, colWidthVal, colGapVal, sidePadding, topPadding, bottomPadding);
}

function updatePlayPauseButtonIcon() {
  const ttsPlayBtn = document.getElementById('tts-play-btn');
  if (!ttsPlayBtn) return;
  
  const isPlaying = tts.isPlaying && !tts.isPaused;
  if (isPlaying) {
    ttsPlayBtn.innerHTML = `<svg class="svg-icon" style="width: 24px; height: 24px; fill: currentColor;" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
    ttsPlayBtn.title = getMsg('tts_pause') || 'Pause';
  } else {
    ttsPlayBtn.innerHTML = `<svg class="svg-icon" style="width: 24px; height: 24px; margin-left: 2px; fill: currentColor;" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    ttsPlayBtn.title = getMsg('tts_play') || 'Play';
  }
}

function updateEdgeFilterButtonVisibility() {
  const filterBtn = document.getElementById('tts-filter-edge-btn');
  if (!filterBtn) return;

  const hasEdgeVoices = tts.voices.some(v => v.isEdge);
  const isWebFile = window.location.protocol === 'file:';

  if (isWebFile) {
    if (hasEdgeVoices) {
      filterBtn.style.display = '';
      if (ttsOnlyEdge) {
        filterBtn.classList.add('active');
      } else {
        filterBtn.classList.remove('active');
      }
    } else {
      filterBtn.style.display = 'none';
    }
  } else {
    // 非 file:// (插件版) 始終顯示
    filterBtn.style.display = '';
    if (ttsOnlyEdge) {
      filterBtn.classList.add('active');
    } else {
      filterBtn.classList.remove('active');
    }
  }
}

// 切換左右分欄翻頁 vs 連續上下滾動
function toggleLayoutMode(mode) {
  const content = document.getElementById('book-content');
  const scrollBtn = document.getElementById('layout-scroll-btn');
  const paginatedBtn = document.getElementById('layout-paginated-btn');

  const isPaginated = (mode === 'paginated');
  
  // CBZ 格式絕對不使用 layout-paginated
  const finalPaginated = isPaginated && !(currentBook && currentBook.format === 'cbz');
  document.body.classList.toggle('layout-paginated', finalPaginated);

  content.style.columnCount = '';
  content.style.columnGap = '';
  content.style.height = '';

  if (isPaginated) {
    scrollBtn.classList.remove('active');
    paginatedBtn.classList.add('active');
    
    const topIdx = getTopVisibleElementIndex();
    applyLayoutDimensions();
    restoreScrollToElementIndex(topIdx);
  } else {
    scrollBtn.classList.add('active');
    paginatedBtn.classList.remove('active');
    applyLayoutDimensions();
    content.style.transform = '';
    // 滾動模式下清空紙張底紋覆蓋層
    const overlay = document.getElementById('page-texture-overlay');
    if (overlay) overlay.innerHTML = '';
  }
  chrome.storage.local.set({ layoutMode: mode });
}

// 快捷鍵控制
function handleKeyDown(e) {
  if (!document.getElementById('reader-view').classList.contains('view-active')) return;

  if (e.code === 'Space') {
    // 空白鍵控制朗讀播放/暫停（避免在 Input 輸入時觸發）
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      document.getElementById('tts-play-btn').click();
    }
  } else if (e.code === 'ArrowLeft') {
    // 左方向鍵翻頁
    if (currentBook.format === 'cbz') prevComicPage();
    else if (document.body.classList.contains('layout-paginated')) {
      navigatePage('prev');
    } else if (currentChapterIndex > 0) {
      loadChapter(currentChapterIndex - 1);
    }
  } else if (e.code === 'ArrowRight') {
    // 右方向鍵翻頁
    if (currentBook.format === 'cbz') nextComicPage();
    else if (document.body.classList.contains('layout-paginated')) {
      navigatePage('next');
    } else if (epubBookData && currentChapterIndex < epubBookData.chapters.length - 1) {
      loadChapter(currentChapterIndex + 1);
    }
  }
}

// 面板顯示切換
function toggleSidebar() {
  const sidebar = document.getElementById('reader-sidebar');
  sidebar.classList.toggle('active');
  document.getElementById('settings-panel').classList.remove('dropdown-active');
  document.getElementById('tts-panel').classList.remove('dropdown-active');
  if (sidebar.classList.contains('active')) {
    setTimeout(() => {
      const activeItem = document.querySelector('#toc-list .toc-item.active');
      if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 150);
  }
}

function toggleSettingsPanel() {
  document.getElementById('settings-panel').classList.toggle('dropdown-active');
  document.getElementById('reader-sidebar').classList.remove('active');
  document.getElementById('tts-panel').classList.remove('dropdown-active');
}

function toggleTTSPanel() {
  document.getElementById('tts-panel').classList.toggle('dropdown-active');
  document.getElementById('reader-sidebar').classList.remove('active');
  document.getElementById('settings-panel').classList.remove('dropdown-active');
}


// ==================== 6. TTS 語音朗讀專屬配置 ==================== */

// 初始化播放面板語音下拉選單
function initTTSPanelVoices(filename) {
  // 檢測書籍語言
  let lang = 'en';
  if (currentBook || (tts && tts.sentences && tts.sentences.length > 0)) {
    // 優先從文件名、書籍標題及當前文本中抽樣檢測
    let sampleText = filename || '';
    if (currentBook) {
      if (currentBook.title) sampleText += ' ' + currentBook.title;
      if (currentBook.author) sampleText += ' ' + currentBook.author;
    }
    if (epubBookData && epubBookData.metadata) {
      if (epubBookData.metadata.title) sampleText += ' ' + epubBookData.metadata.title;
      if (epubBookData.metadata.author) sampleText += ' ' + epubBookData.metadata.author;
    }
    if (tts && tts.sentences && tts.sentences.length > 0) {
      sampleText += ' ' + tts.sentences.slice(0, 10).map(s => s.text || '').join('');
    } else {
      const bookContent = document.getElementById('book-content');
      if (bookContent) {
        sampleText += ' ' + bookContent.textContent.slice(0, 1000);
      }
    }
    
    if (/[\u4e00-\u9fa5]/.test(sampleText)) {
      lang = navigator.language.includes('TW') || navigator.language.includes('HK') ? 'zh-TW' : 'zh-CN';
    } else if (/[\u3040-\u309F\u30A0-\u30FF]/.test(sampleText)) {
      lang = 'ja';
    } else if (/[\uAC00-\uD7AF]/.test(sampleText)) {
      lang = 'ko';
    } else {
      lang = 'en';
    }
  } else {
    // 無書籍加載時，默認使用瀏覽器系統語言
    if (navigator.language.startsWith('zh')) {
      lang = navigator.language.includes('TW') || navigator.language.includes('HK') ? 'zh-TW' : 'zh-CN';
    } else if (navigator.language.startsWith('ja')) {
      lang = 'ja';
    } else if (navigator.language.startsWith('ko')) {
      lang = 'ko';
    } else {
      lang = 'en';
    }
  }

  const select = document.getElementById('tts-voice-select');
  if (!select) return;
  const currentSelected = select.value;
  select.innerHTML = '';

  let matchedVoices = tts.getVoicesForLanguage(lang);
  if (ttsOnlyEdge && matchedVoices.some(v => v.isEdge)) {
    matchedVoices = matchedVoices.filter(v => v.isEdge);
  }
  matchedVoices.forEach(voice => {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = `${voice.name} (${voice.lang})`;
    select.appendChild(opt);
  });

  // 優先保留當前已選中的語音，其次是之前保存的語音，最後是默認優先語音
  if (matchedVoices.length > 0) {
    if (currentSelected && matchedVoices.some(v => v.name === currentSelected)) {
      select.value = currentSelected;
      tts.setVoice(currentSelected);
    } else {
      const savedVoice = currentBook?.progress?.ttsVoice;
      if (savedVoice && matchedVoices.some(v => v.name === savedVoice)) {
        select.value = savedVoice;
        tts.setVoice(savedVoice);
      } else {
        select.value = matchedVoices[0].name;
        tts.setVoice(matchedVoices[0].name);
      }
    }
  }
}


// ==================== 7. 文字選取、高亮劃線與筆記功能 ==================== */

// 監聽文字選取
function handleTextSelection(e) {
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();
  const menu = document.getElementById('selection-menu');

  if (selectedText.length > 0) {
    selectedTextState = selectedText;
    selectedTextRange = selection.getRangeAt(0).cloneRange();

    // 獲取選取文字坐標以顯示選單
    const rect = selectedTextRange.getBoundingClientRect();
    menu.style.top = `${rect.top + window.scrollY - 55}px`;
    menu.style.left = `${rect.left + window.scrollX + (rect.width / 2) - (menu.offsetWidth / 2)}px`;
    menu.style.display = 'flex';
  } else {
    // 點擊空白處隱藏選單
    if (e.target.closest('#selection-menu') === null) {
      menu.style.display = 'none';
    }
  }
}

// 添加高亮劃線
async function handleAddHighlight(color) {
  if (!currentBook || !selectedTextState) return;

  const sentenceEl = selectedTextRange.startContainer.parentElement.closest('.tts-sentence');
  const sentenceIndex = sentenceEl ? parseInt(sentenceEl.getAttribute('data-sentence-index')) : 0;

  const note = {
    type: 'highlight',
    color,
    text: selectedTextState,
    chapterIndex: currentChapterIndex,
    sentenceIndex
  };

  await library.saveNote(currentBook.id, note);
  
  // 在頁面上即時繪製高亮
  highlightSelectionInDOM(color);
  
  // 隱藏選單
  document.getElementById('selection-menu').style.display = 'none';
  window.getSelection().removeAllRanges();
}

// 在 DOM 中包裹高亮標籤
function highlightSelectionInDOM(color) {
  try {
    const span = document.createElement('span');
    span.className = `highlight-${color}`;
    selectedTextRange.surroundContents(span);
  } catch (e) {
    // 如果選取跨越了多個 DOM 標籤節點，surroundContents 會報錯，此時降級高亮整個句子
    console.warn('Selection spans multiple tags, highlighting sentence instead:', e);
    const startParent = selectedTextRange.startContainer.parentElement.closest('.tts-sentence');
    if (startParent) {
      startParent.classList.add(`highlight-${color}`);
    }
  }
}

// 載入已存檔的高亮
function applySavedHighlightsToDOM() {
  if (!currentBook || !currentBook.notes) return;

  currentBook.notes.forEach(note => {
    if (note.chapterIndex === currentChapterIndex) {
      // 尋找對應的句子元素
      const sentenceEl = document.querySelector(`[data-sentence-index="${note.sentenceIndex}"]`);
      if (sentenceEl) {
        // 如果是 highlight，直接高亮整句
        sentenceEl.classList.add(`highlight-${note.color}`);
      }
    }
  });
}

// 筆記對話框
function openNoteDialog() {
  const dialog = document.getElementById('note-dialog');
  document.getElementById('note-text-preview').textContent = `"${selectedTextState}"`;
  document.getElementById('note-textarea').value = '';
  
  dialog.style.display = 'flex';
  document.getElementById('selection-menu').style.display = 'none';
}

// 保存筆記
async function handleSaveNote() {
  const text = document.getElementById('note-textarea').value.trim();
  if (!text) return;

  const sentenceEl = selectedTextRange.startContainer.parentElement.closest('.tts-sentence');
  const sentenceIndex = sentenceEl ? parseInt(sentenceEl.getAttribute('data-sentence-index')) : 0;

  const note = {
    type: 'note',
    text: selectedTextState,
    noteText: text, // 用戶輸入的註釋
    chapterIndex: currentChapterIndex,
    sentenceIndex
  };

  await library.saveNote(currentBook.id, note);
  
  // 顯示高亮代表有筆記
  highlightSelectionInDOM('yellow');

  document.getElementById('note-dialog').style.display = 'none';
  window.getSelection().removeAllRanges();
}

// 獲取多級章節標題
function getHierarchicalChapterTitle(chapters, index) {
  if (!chapters || index < 0 || index >= chapters.length) return "";
  const path = [];
  let current = chapters[index];
  path.unshift(current.title);
  
  let currentDepth = current.depth || 0;
  for (let i = index - 1; i >= 0; i--) {
    if (currentDepth === 0) break;
    const ch = chapters[i];
    const chDepth = ch.depth || 0;
    if (chDepth < currentDepth) {
      path.unshift(ch.title);
      currentDepth = chDepth;
    }
  }
  return path.join(" > ");
}
// 書籤添加
async function handleAddBookmark() {
  if (!currentBook) return;
  
  let chapterTitle = getMsg('chapter_label', [String(currentChapterIndex + 1)]);
  if (epubBookData && epubBookData.chapters) {
    chapterTitle = getHierarchicalChapterTitle(epubBookData.chapters, currentChapterIndex);
  }
  
  const topIdx = getTopVisibleElementIndex();
  let snippet = '';
  const contentEl = document.getElementById('book-content');
  if (contentEl) {
    let children = contentEl.querySelectorAll('p, blockquote, pre, h1, h2, h3, h4, h5, h6, li');
    if (children.length === 0) {
      children = contentEl.children;
    }
    if (children && children[topIdx]) {
      const text = children[topIdx].textContent.trim();
      if (text) {
        snippet = text.substring(0, 15) + (text.length > 15 ? "..." : "");
      }
    }
  }

  // 構造書籤顯示標題，包含段落預覽
  const title = `${chapterTitle}${snippet ? ' : "' + snippet + '"' : ''}`;

  const bookmark = {
    title,
    chapterIndex: currentChapterIndex,
    elementIndex: topIdx,
    currentPageIndex: currentPageIndex
  };

  await library.saveBookmark(currentBook.id, bookmark);
  renderHighlightsList();
}

// 渲染筆記與書籤列表
async function renderHighlightsList() {
  const bList = document.getElementById('bookmarks-list');
  const nList = document.getElementById('notes-list');
  bList.innerHTML = '';
  nList.innerHTML = '';

  const book = await library.getBook(currentBook.id);
  if (!book) return;

  // 1. 書籤
  if (book.bookmarks && book.bookmarks.length > 0) {
    book.bookmarks.forEach(b => {
      const li = document.createElement('li');
      li.className = 'sidebar-list-item';
      li.innerHTML = `
        <div class="list-item-title">${b.title}</div>
        <div class="list-item-meta">${new Date(b.createdAt).toLocaleString()}</div>
        <button class="book-delete-btn-sidebar">
          <svg class="svg-icon svg-icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      `;
      li.addEventListener('click', () => {
        document.getElementById('reader-sidebar').classList.remove('active');
        loadChapter(b.chapterIndex, false, false, true, false, b.currentPageIndex, b.elementIndex);
      });
      // 動態綁定刪除書籤事件 (解決 CSP 阻擋 inline onclick 問題)
      const delBtn = li.querySelector('.book-delete-btn-sidebar');
      delBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await deleteBookmarkHandler(b.bookmarkId);
      });
      bList.appendChild(li);
    });
  }

  // 2. 劃線筆記
  if (book.notes && book.notes.length > 0) {
    book.notes.forEach(n => {
      const li = document.createElement('li');
      li.className = 'sidebar-list-item';
      li.innerHTML = `
        <div class="list-item-title">
          ${n.type === 'note' ? `
            <svg class="svg-icon svg-icon-sm" style="margin-right:4px;" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg> ${getMsg('note_title')}
          ` : `
            <svg class="svg-icon svg-icon-sm" style="margin-right:4px;" viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg> ${getMsg('highlight_title')}
          `}
        </div>
        <div class="list-item-text">"${n.text}"</div>
        ${n.noteText ? `<div class="list-item-note">${n.noteText}</div>` : ''}
        <button class="book-delete-btn-sidebar">
          <svg class="svg-icon svg-icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      `;
      li.addEventListener('click', () => {
        document.getElementById('reader-sidebar').classList.remove('active');
        loadChapter(n.chapterIndex, false, false, true, false, null, null, n.sentenceIndex);
      });
      // 動態綁定刪除筆記事件 (解決 CSP 阻擋 inline onclick 問題)
      const delBtn = li.querySelector('.book-delete-btn-sidebar');
      delBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await deleteNoteHandler(n.noteId);
      });
      nList.appendChild(li);
    });
  }
}

// 刪除劃線筆記與書籤的事件處理
async function deleteBookmarkHandler(bookmarkId) {
  if (currentBook) {
    await library.deleteBookmark(currentBook.id, bookmarkId);
    await renderHighlightsList();
  }
}
window.deleteBookmarkHandler = deleteBookmarkHandler;

async function deleteNoteHandler(noteId) {
  if (currentBook) {
    await library.deleteNote(currentBook.id, noteId);
    await renderHighlightsList();
  }
}
window.deleteNoteHandler = deleteNoteHandler;

// 朗讀選中文字
function speakSelection() {
  if (selectedTextState) {
    if (typeof chrome !== 'undefined' && chrome.tts) {
      chrome.tts.stop();
      chrome.tts.speak(selectedTextState, {
        voiceName: tts.selectedVoice ? tts.selectedVoice.name : undefined,
        rate: tts.rate
      });
    } else if (tts.synth) {
      tts.synth.cancel();
      const utterance = new SpeechSynthesisUtterance(selectedTextState);
      if (tts.selectedVoice && tts.selectedVoice.rawVoice) {
        utterance.voice = tts.selectedVoice.rawVoice;
      }
      utterance.rate = tts.rate;
      tts.synth.speak(utterance);
    }
    document.getElementById('selection-menu').style.display = 'none';
  }
}


// ==================== 8. AI 伴侶流式調用 ==================== */

// 打開 AI 面板並顯示載入中
function showAILoading() {
  const panel = document.getElementById('ai-panel');
  const content = document.getElementById('ai-content');
  panel.style.display = 'flex';
  content.innerHTML = `
    <div class="ai-loading">
      <div class="ai-loading-spinner"></div>
      <span>${getMsg('ai_thinking')}</span>
    </div>
  `;
}

// 觸發 AI 摘要
async function triggerAISummary() {
  if (!selectedTextState) return;
  document.getElementById('selection-menu').style.display = 'none';
  showAILoading();
  
  try {
    await ai.summarize(selectedTextState, (chunk) => {
      document.getElementById('ai-content').textContent = chunk;
    });
  } catch (e) {
    document.getElementById('ai-content').innerHTML = `<p style="color:red;">${getMsg('error_prefix')}: ${e.message}</p>`;
  }
}

// 觸發 AI 釋義
async function triggerAIExplain() {
  if (!selectedTextState) return;
  document.getElementById('selection-menu').style.display = 'none';
  showAILoading();

  // 獲取選詞的上下文段落
  const parentPara = selectedTextRange.startContainer.parentElement.closest('p, div, li');
  const context = parentPara ? parentPara.textContent : selectedTextState;

  try {
    await ai.explainWord(selectedTextState, context, (chunk) => {
      document.getElementById('ai-content').textContent = chunk;
    });
  } catch (e) {
    document.getElementById('ai-content').innerHTML = `<p style="color:red;">${getMsg('error_prefix')}: ${e.message}</p>`;
  }
}

// 觸發 AI 翻譯
async function triggerAITranslate() {
  if (!selectedTextState) return;
  document.getElementById('selection-menu').style.display = 'none';
  showAILoading();

  // 檢測目標語言：如果是英文則翻譯成中文，否則翻譯成英文
  const hasChinese = /[\u4e00-\u9fa5]/.test(selectedTextState);
  const targetLang = hasChinese ? 'English' : 'Traditional Chinese';

  try {
    await ai.translate(selectedTextState, targetLang, (chunk) => {
      document.getElementById('ai-content').textContent = chunk;
    });
  } catch (e) {
    document.getElementById('ai-content').innerHTML = `<p style="color:red;">${getMsg('error_prefix')}: ${e.message}</p>`;
  }
}

// ==================== 備份與還原功能 ====================

// 將 Blob 轉為 DataURL (Base64)
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 將 DataURL 轉回 Blob
function dataURLtoBlob(dataurl) {
  try {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (e) {
    console.error('Failed to convert DataURL to Blob:', e);
    return null;
  }
}

// 導出書庫備份
async function handleExportBackup() {
  const backupBtn = document.getElementById('backup-btn');
  if (!backupBtn) return;
  const originalHtml = backupBtn.innerHTML;
  
  try {
    // 進入載入狀態
    backupBtn.disabled = true;
    backupBtn.innerHTML = `
      <span class="btn-icon">
        <svg class="svg-icon" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
      </span>
      <span>${getMsg('backing_up')}</span>
    `;

    // 1. 取得所有書籍
    const books = await library.getAllBooks();
    if (books.length === 0) {
      alert(getMsg('no_books'));
      return;
    }

    // 2. 將書籍的 Blob 檔案與 Cover 轉換成 Base64
    const serializedBooks = [];
    for (const book of books) {
      let fileDataUrl = '';
      if (book.file instanceof Blob) {
        fileDataUrl = await blobToDataUrl(book.file);
      }
      
      let coverDataUrl = '';
      if (book.cover instanceof Blob) {
        coverDataUrl = await blobToDataUrl(book.cover);
      } else if (typeof book.cover === 'string') {
        coverDataUrl = book.cover;
      }

      serializedBooks.push({
        id: book.id,
        title: book.title,
        author: book.author,
        format: book.format,
        fileDataUrl,
        cover: coverDataUrl,
        size: book.size,
        addedAt: book.addedAt,
        lastReadAt: book.lastReadAt,
        progress: book.progress,
        bookmarks: book.bookmarks || [],
        notes: book.notes || [],
        stats: book.stats || null
      });
    }

    // 3. 構造備份 JSON
    const backupPayload = {
      version: '1.0',
      backupAt: Date.now(),
      books: serializedBooks
    };

    const jsonString = JSON.stringify(backupPayload);
    const backupBlob = new Blob([jsonString], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(backupBlob);

    // 4. 觸發下載
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const filename = `edgereader_backup_${YYYY}${MM}${DD}_${hh}${mm}${ss}.json`;
    
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    alert(getMsg('backup_success'));
  } catch (err) {
    console.error('Backup failed:', err);
    alert(`${getMsg('backup_failed')}: ${err.message}`);
  } finally {
    backupBtn.disabled = false;
    backupBtn.innerHTML = originalHtml;
  }
}

// 導入書庫還原
function handleImportBackup(e) {
  const file = e.target.files[0];
  if (!file) return;

  const restoreBtn = document.getElementById('restore-btn');
  if (!restoreBtn) return;
  const originalHtml = restoreBtn.innerHTML;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      restoreBtn.disabled = true;
      restoreBtn.innerHTML = `
        <span class="btn-icon">
          <svg class="svg-icon" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
        </span>
        <span>${getMsg('restoring')}</span>
      `;

      const data = JSON.parse(event.target.result);
      if (!data || data.version !== '1.0' || !Array.isArray(data.books)) {
        alert(getMsg('invalid_backup_file'));
        return;
      }

      // 還原每一本書
      for (const b of data.books) {
        let fileBlob = null;
        if (b.fileDataUrl) {
          fileBlob = dataURLtoBlob(b.fileDataUrl);
        }

        let coverBlobOrString = b.cover;
        if (b.cover && b.cover.startsWith('data:')) {
          coverBlobOrString = dataURLtoBlob(b.cover);
        }

        const book = {
          id: b.id,
          title: b.title,
          author: b.author,
          format: b.format,
          file: fileBlob,
          cover: coverBlobOrString,
          size: b.size,
          addedAt: b.addedAt,
          lastReadAt: b.lastReadAt,
          progress: b.progress,
          bookmarks: b.bookmarks || [],
          notes: b.notes || [],
          stats: b.stats || null
        };

        await library.importBook(book);
      }

      await renderBookshelf();
      alert(getMsg('restore_success'));
    } catch (err) {
      console.error('Restore failed:', err);
      alert(`${getMsg('restore_failed')}: ${err.message}`);
    } finally {
      restoreBtn.disabled = false;
      restoreBtn.innerHTML = originalHtml;
      e.target.value = ''; // 允許重複導入同一個檔案
    }
  };

  reader.onerror = () => {
    alert(getMsg('restore_failed'));
  };

  reader.readAsText(file);
}


// ==================== 4. 數據統計面板控制邏輯 ====================

// 格式化讀取時間 (例如 "1h 23m" 或 "45m")
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return getMsg('stats_no_time') || 'Not started';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m`;
  }
  return `${seconds}s`;
}

// 渲染柱狀圖
function renderHourlyChart(containerId, hourlyData) {
  const chart = document.getElementById(containerId);
  if (!chart) return;
  chart.innerHTML = '';

  let maxVal = 0;
  for (let h = 0; h < 24; h++) {
    const val = hourlyData[h] || 0;
    if (val > maxVal) maxVal = val;
  }

  for (let h = 0; h < 24; h++) {
    const val = hourlyData[h] || 0;
    const heightPercent = maxVal > 0 ? (val / maxVal) * 100 : 0;
    
    const wrapper = document.createElement('div');
    wrapper.className = 'chart-bar-wrapper';

    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    if (val > 0) bar.classList.add('has-value');
    bar.style.height = `${Math.max(2, heightPercent)}%`;

    const label = document.createElement('span');
    label.className = 'chart-bar-label';
    if (h % 4 === 0) {
      label.textContent = String(h).padStart(2, '0');
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-bar-tooltip';
    tooltip.textContent = `${String(h).padStart(2, '0')}:00 - ${formatDuration(val)}`;

    wrapper.appendChild(tooltip);
    wrapper.appendChild(bar);
    wrapper.appendChild(label);
    chart.appendChild(wrapper);
  }
}

// 切換統計分頁
function switchStatsTab(tabName) {
  const tabOverview = document.getElementById('stats-tab-overview');
  const tabBooks = document.getElementById('stats-tab-books');
  const contentOverview = document.getElementById('stats-content-overview');
  const contentBooks = document.getElementById('stats-content-books');

  if (tabOverview && tabBooks && contentOverview && contentBooks) {
    if (tabName === 'overview') {
      tabOverview.classList.add('active');
      tabBooks.classList.remove('active');
      contentOverview.classList.add('active');
      contentBooks.classList.remove('active');
    } else {
      tabOverview.classList.remove('active');
      tabBooks.classList.add('active');
      contentOverview.classList.remove('active');
      contentBooks.classList.add('active');
    }
  }
}

// 打開統計彈窗 (全局)
async function openGlobalStatsModal() {
  const modal = document.getElementById('stats-modal');
  const backdrop = document.getElementById('stats-modal-backdrop');
  if (!modal || !backdrop) return;

  // 1. 獲取所有書籍計算全局統計
  const books = await library.getAllBooks();
  
  let totalSeconds = 0;
  let readBooksCount = 0;
  const activeDaysSet = new Set();
  const globalHourly = Array(24).fill(0);

  // 填充書籍下拉選擇器
  const bookSelect = document.getElementById('stats-book-select');
  if (bookSelect) {
    bookSelect.innerHTML = '';
    books.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.title;
      bookSelect.appendChild(opt);
    });
  }

  books.forEach(b => {
    const stats = b.stats || { totalTime: 0, readingDays: {}, hourlyDist: {} };
    totalSeconds += stats.totalTime || 0;
    if (stats.totalTime > 0) {
      readBooksCount++;
    }
    
    // 累加活躍天數
    if (stats.readingDays) {
      Object.keys(stats.readingDays).forEach(day => activeDaysSet.add(day));
    }
    
    // 累加小時分佈
    if (stats.hourlyDist) {
      for (let h = 0; h < 24; h++) {
        globalHourly[h] += (stats.hourlyDist[h] || 0);
      }
    }
  });

  // 2. 填充 UI 值
  document.getElementById('global-total-time').textContent = formatDuration(totalSeconds);
  document.getElementById('global-total-books').textContent = readBooksCount;
  document.getElementById('global-total-days').textContent = activeDaysSet.size;

  // 3. 繪製全局圖表
  renderHourlyChart('global-hourly-chart', globalHourly);

  // 4. 預設選中第一本書（若有）
  if (books.length > 0) {
    if (bookSelect) bookSelect.value = books[0].id;
    await renderBookStats(books[0].id);
  } else {
    // 空狀態處理
    document.getElementById('book-total-time').textContent = '0m';
    document.getElementById('book-total-days').textContent = '0';
    document.getElementById('book-daily-avg').textContent = '0m';
    renderHourlyChart('book-hourly-chart', Array(24).fill(0));
    document.getElementById('book-history-list').innerHTML = '';
  }

  // 顯示彈窗
  switchStatsTab('overview');
  backdrop.classList.add('active');
  modal.classList.add('active');
}

// 關閉統計彈窗
function closeStatsModal() {
  const modal = document.getElementById('stats-modal');
  const backdrop = document.getElementById('stats-modal-backdrop');
  if (modal && backdrop) {
    modal.classList.remove('active');
    backdrop.classList.remove('active');
  }
}

// 渲染單本書籍統計
async function renderBookStats(bookId) {
  const book = await library.getBook(bookId);
  if (!book) return;

  const stats = book.stats || { totalTime: 0, readingDays: {}, hourlyDist: {} };
  const totalTime = stats.totalTime || 0;
  const readingDays = stats.readingDays || {};
  const hourlyDist = stats.hourlyDist || {};

  const daysCount = Object.keys(readingDays).length;
  const dailyAvg = daysCount > 0 ? Math.round(totalTime / daysCount) : 0;

  // 填充數值
  document.getElementById('book-total-time').textContent = formatDuration(totalTime);
  document.getElementById('book-total-days').textContent = daysCount;
  document.getElementById('book-daily-avg').textContent = formatDuration(dailyAvg);

  // 繪製單本圖表
  const hourlyData = Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    hourlyData[h] = hourlyDist[h] || 0;
  }
  renderHourlyChart('book-hourly-chart', hourlyData);

  // 填充歷史清單
  const historyList = document.getElementById('book-history-list');
  if (historyList) {
    historyList.innerHTML = '';
    // 按日期降序排列
    const sortedDays = Object.keys(readingDays).sort((a, b) => b.localeCompare(a));
    if (sortedDays.length === 0) {
      historyList.innerHTML = `<div style="text-align:center; padding:20px; font-size:12px; color:var(--text-muted);">${getMsg('stats_no_time')}</div>`;
    } else {
      sortedDays.forEach(day => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
          <span class="history-date">${day}</span>
          <span class="history-duration">${formatDuration(readingDays[day])}</span>
        `;
        historyList.appendChild(item);
      });
    }
  }
}

// 打開單本統計的快捷跳轉
async function openSingleBookStatsModal(bookId) {
  await openGlobalStatsModal();
  const bookSelect = document.getElementById('stats-book-select');
  if (bookSelect) {
    bookSelect.value = bookId;
  }
  switchStatsTab('books');
  await renderBookStats(bookId);
}
window.openSingleBookStatsModal = openSingleBookStatsModal;
