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

// Pre-initialize mermaid to disable automatic scan on window load event
if (typeof mermaid !== 'undefined') {
  try {
    mermaid.initialize({
      startOnLoad: false,
      mindmap: {
        useMaxWidth: false,
        nodeSpacing: 120,
        rankSpacing: 90,
        padding: 15
      }
    });
  } catch (e) {
    console.warn('Failed to pre-initialize mermaid:', e);
  }
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
let bookChunksCache = []; // 緩存整本書的文本切片以供 RAG 檢索
let chapterTextsCache = []; // 緩存整本書的章節純文本以供精確搜尋
let isIndexingBook = false; // 標記是否正在背景建立書本索引
let currentSearchQuery = ''; // 儲存當前全書搜尋關鍵字
let comicParserInstance = null; // 漫畫解析實例
let isSavingProgress = false;
let isTTSAutoPageTurning = false;
let selectedTextState = '';
let activeSelectedTextContext = '';
let selectedTextRange = null;
let selectedNoteIdState = null; // 儲存當前選取的高亮/筆記的 ID
let currentPageIndex = 0;
let ttsClickTimeout = null;
let currentPagesDisplayed = 'auto';
let currentTTSLanguage = 'auto';
let ttsDefaultVoice = '';
let currentPaperTexture = 'texture-classic';
let activeCoverUrls = [];
let activeResourceUrls = [];
let ttsOnlyEdge = false;
let currentBookDetectedLanguage = ''; // 緩存當前書籍檢測到的語言，防止異步語音加載事件重新觸發時因時序差異而誤判
let marginWidthScroll = 5;
let marginWidthPaginated = 5;
let pendingGoToLastPage = false;
let pendingGoToLastPageTimeout = null;
let isChangingChapter = false;
let lastChapterChangeTime = 0;
let openBookRequestId = 0;
let openingBookId = null;

// AI 服务商配置管理全局状态
const DEFAULT_AI_PROFILES = [
  { id: 'builtin', name: 'Built-in AI (Gemini Nano)', provider: 'builtin', apiKey: '', endpoint: '', model: '' },
  { id: 'default_openai', name: 'OpenAI (Official)', provider: 'openai', apiKey: '', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'default_deepseek', name: 'DeepSeek', provider: 'openai', apiKey: '', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'default_gemini', name: 'Google Gemini API', provider: 'openai', apiKey: '', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { id: 'default_siliconflow', name: 'SiliconFlow (DeepSeek)', provider: 'openai', apiKey: '', endpoint: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'default_ollama', name: 'Ollama (Local)', provider: 'ollama', apiKey: '', endpoint: 'http://localhost:11434', model: 'llama3' },
  { id: 'default_lmstudio', name: 'LM Studio', provider: 'openai', apiKey: '', endpoint: 'http://localhost:1234/v1', model: 'meta-llama-3-8b-instruct' }
];
let aiProfilesList = [];
let activeAIProfileId = 'builtin';

// AI prompt templates global state
let aiPromptsTemplatesList = [];
let currentEditingPromptIndex = -1;
const DEFAULT_CUSTOM_ICON = `<svg class="svg-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg>`;
const AI_SUGGESTION_ICONS = {
  'ai_suggest_sum_chapter': `<svg class="svg-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
  'ai_suggest_chapter_map': `<svg class="svg-icon" viewBox="0 0 24 24"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3zM6 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z"></path><path d="M18 8h-3v8h3M6 8h3v8H6"></path></svg>`,
  'ai_suggest_book_map': `<svg class="svg-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>`,
  'ai_suggest_takeaways': `<svg class="svg-icon" viewBox="0 0 24 24"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>`,
  'ai_suggest_characters': `<svg class="svg-icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
  'ai_suggest_explain_concept': `<svg class="svg-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
  'ai_suggest_quiz': `<svg class="svg-icon" viewBox="0 0 24 24"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`
};

// 閱讀時間統計全局狀態
let readingSessionTimer = null;
let lastReadingHeartbeat = 0;
let lastUserActivityTime = 0;
const IDLE_TIMEOUT_MS = 60000; // 60秒無操作視為閒置

// 書庫資料夾與批量管理狀態
let currentFolder = null;
let isSelectMode = false;
const selectedBookIds = new Set();


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

function isBlobLike(value) {
  return value instanceof Blob || (value && typeof value === 'object' && typeof value.arrayBuffer === 'function' && typeof value.size === 'number');
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
  // 0.0 取得並綁定原生安全區域留白 (Safe Area Insets)
  const isCapacitor = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins;
  if (isCapacitor && window.Capacitor.Plugins.NativeTTS) {
    const updateSafeArea = async () => {
      try {
        const insets = await window.Capacitor.Plugins.NativeTTS.getSafeAreaInsets();
        if (insets && insets.top > 0) {
          document.documentElement.style.setProperty('--sat', `${insets.top}px`);
          document.documentElement.style.setProperty('--sab', `${insets.bottom}px`);
          document.documentElement.style.setProperty('--sal', `${insets.left}px`);
          document.documentElement.style.setProperty('--sar', `${insets.right}px`);
          console.log('[SafeArea] Dynamic Safe Area applied successfully:', insets);
          return true;
        }
      } catch (e) {
        console.warn('[SafeArea] Failed to update safe area insets:', e);
      }
      return false;
    };
    
    // 輪詢重試，等待原生 View 完成 Layout 計算 (避免初期 top 為 0 覆寫 CSS env)
    (async () => {
      for (let i = 0; i < 12; i++) {
        const success = await updateSafeArea();
        if (success) break;
        await new Promise(r => setTimeout(r, 100 + i * 50));
      }
    })();
    
    // 監聽旋轉與視窗大小變更
    window.addEventListener('resize', updateSafeArea);
    window.addEventListener('orientationchange', updateSafeArea);
  }

  // 0.0.1 自動化 TTS 調試測試
  if (isCapacitor && window.Capacitor.Plugins.NativeTTS) {
    setTimeout(async () => {
      console.log('[TTS-Test] Initiating automated downloadTTS test...');
      try {
        const secMsGec = await tts._generateSecMsGecToken();
        const connectionId = tts._generateConnectionId();
        const result = await window.Capacitor.Plugins.NativeTTS.downloadTTS({
          text: "测试测试，Edge TTS 是否可用。",
          voice: "zh-CN-XiaoxiaoNeural",
          connectionId: connectionId,
          secMsGec: secMsGec,
          dateStr: tts._dateToString()
        });
        console.log('[TTS-Test] Result received! base64 length:', result.audioBase64.length);
      } catch (err) {
        console.error('[TTS-Test] DownloadTTS failed with error:', err);
      }
    }, 4000);
  }

  // 0. 初始化歷史記錄狀態
  if (!history.state) {
    history.replaceState({ bookshelf: true }, '');
  }

  // Android 返回鍵統一處理函數
  // 返回 true 表示已由前端處理，返回 false 表示需要退出 app
  function handleAndroidBack() {
    // 優先關閉浮動面板/對話框
    const aboutDialog = document.getElementById('about-dialog');
    if (aboutDialog && aboutDialog.open) { aboutDialog.close(); return true; }
    const noteDialog = document.getElementById('note-dialog');
    if (noteDialog && noteDialog.style.display !== 'none') { noteDialog.style.display = 'none'; return true; }
    const sidebar = document.getElementById('reader-sidebar');
    if (sidebar && sidebar.classList.contains('active')) { sidebar.classList.remove('active'); return true; }
    const aiPanel = document.getElementById('ai-panel');
    if (aiPanel && aiPanel.style.display !== 'none') { aiPanel.style.display = 'none'; return true; }
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel && settingsPanel.classList.contains('active')) { settingsPanel.classList.remove('active'); return true; }
    const ttsPanel = document.getElementById('tts-panel');
    if (ttsPanel && ttsPanel.classList.contains('active')) { ttsPanel.classList.remove('active'); return true; }
    // 拖拽 overlay
    const dragOverlay = document.getElementById('drag-overlay');
    if (dragOverlay && dragOverlay.style.display !== 'none' && dragOverlay.style.display !== '') { dragOverlay.style.display = 'none'; return true; }

    // 如果在閱讀器中，返回書庫
    if (currentBook) {
      closeCurrentBook();
      return true;
    }
    
    // 已在書庫頁面，返回 false 讓原生層退出 app
    return false;
  }
  // 暴露給 Android 原生層調用（通過 evaluateJavascript）
  window.__handleAndroidBack = handleAndroidBack;

  // 0.1 從 manifest.json 讀取版本號，統一管理版本顯示
  if (!window.__APP_VERSION__) {
    try {
      // 嘗試多個路徑：在網頁版中 manifest.json 在上層目錄，在 Capacitor app 中可能在同層
      let manifestData = null;
      for (const path of ['../manifest.json', './manifest.json', 'manifest.json']) {
        try {
          const resp = await fetch(path);
          if (resp.ok) {
            manifestData = await resp.json();
            break;
          }
        } catch (e) { /* 嘗試下一個路徑 */ }
      }
      if (manifestData && manifestData.version) {
        window.__APP_VERSION__ = manifestData.version;
      }
    } catch (e) {
      console.warn('[Version] Failed to load manifest.json:', e);
    }
  }

  // 0.5 立即套用封面大小設定以防佈局抖動
  const savedWidth = localStorage.getItem('coverWidth') || '180';
  document.documentElement.style.setProperty('--cover-width', `${savedWidth}px`);

  // 0.6 立即套用 AI 面板大小設定以防佈局抖動
  const savedAIWidth = localStorage.getItem('aiPanelWidth') || '400px';
  document.documentElement.style.setProperty('--ai-panel-width', savedAIWidth);

  // 0.7 立即套用左側側邊欄大小設定以防佈局抖動
  const savedSidebarWidth = localStorage.getItem('sidebarWidth') || '360px';
  document.documentElement.style.setProperty('--sidebar-width', savedSidebarWidth);

  // 1. 初始化多語言（載入後備翻譯字典 + 套用翻譯）
  await initI18n();
  initAISuggestions();

  // 2. 開啟資料庫並載入書架
  try {
    await library.open();
    await renderBookshelf();
  } catch (e) {
    alert(`${getMsg('failed_init_db')}: ${e.message}`);
  }

  // 3. 初始化 AI 配置與檢測支持
  await initAISettings();
  await initTTSSettings();

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

  // 5. 初始化 AI 面板調整大小
  initAIResize();

  // 5.1 初始化左側側邊欄調整大小
  initSidebarResize();

  // 5.5 監聽 AI 面板的可見性，當面板顯示時立即渲染 Mermaid 圖表
  const aiPanel = document.getElementById('ai-panel');
  if (aiPanel) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'style') {
          const display = aiPanel.style.display;
          if (display === 'flex' || display === 'block') {
            renderMermaidBlocks();
          }
        }
      });
    });
    observer.observe(aiPanel, { attributes: true, attributeFilter: ['style'] });
  }
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

  // 資料夾與批量管理事件
  const createFolderBtn = document.getElementById('create-folder-btn');
  if (createFolderBtn) {
    createFolderBtn.addEventListener('click', () => {
      openFolderDialog();
    });
  }

  const batchManageBtn = document.getElementById('batch-manage-btn');
  if (batchManageBtn) {
    batchManageBtn.addEventListener('click', () => {
      toggleSelectMode(!isSelectMode);
    });
  }

  const batchCancelBtn = document.getElementById('batch-cancel-btn');
  if (batchCancelBtn) {
    batchCancelBtn.addEventListener('click', () => {
      toggleSelectMode(false);
    });
  }

  const batchMoveBtn = document.getElementById('batch-move-btn');
  if (batchMoveBtn) {
    batchMoveBtn.addEventListener('click', () => {
      if (selectedBookIds.size === 0) return;
      openFolderSelectDialog(async (folderName) => {
        for (const bookId of selectedBookIds) {
          await library.updateBookFolder(bookId, folderName);
        }
        toggleSelectMode(false);
        await renderBookshelf();
      });
    });
  }

  const batchDeleteBtn = document.getElementById('batch-delete-btn');
  if (batchDeleteBtn) {
    batchDeleteBtn.addEventListener('click', async () => {
      if (selectedBookIds.size === 0) return;
      if (confirm(`確定要刪除選中的 ${selectedBookIds.size} 本書籍嗎？`)) {
        for (const bookId of selectedBookIds) {
          await library.deleteBook(bookId);
        }
        toggleSelectMode(false);
        await renderBookshelf();
      }
    });
  }

  const breadcrumbBack = document.getElementById('breadcrumb-back-btn');
  if (breadcrumbBack) {
    breadcrumbBack.addEventListener('click', async () => {
      currentFolder = null;
      await renderBookshelf();
    });
    breadcrumbBack.addEventListener('dragover', (e) => {
      e.preventDefault();
      breadcrumbBack.classList.add('drag-over');
    });
    breadcrumbBack.addEventListener('dragleave', () => {
      breadcrumbBack.classList.remove('drag-over');
    });
    breadcrumbBack.addEventListener('drop', async (e) => {
      e.preventDefault();
      breadcrumbBack.classList.remove('drag-over');
      const bookId = e.dataTransfer.getData('text/plain');
      if (bookId) {
        await library.updateBookFolder(bookId, null);
        await renderBookshelf();
      }
    });
  }

  // 註冊新建/重命名資料夾對話框事件
  const folderDialogCancel = document.getElementById('folder-dialog-cancel');
  if (folderDialogCancel) {
    folderDialogCancel.addEventListener('click', () => {
      document.getElementById('folder-dialog').close();
    });
  }

  const folderDialog = document.getElementById('folder-dialog');
  if (folderDialog) {
    folderDialog.addEventListener('submit', (e) => {
      const input = document.getElementById('folder-name-input');
      const name = input.value.trim();
      if (name && folderDialogCallback) {
        folderDialogCallback(name);
      }
    });
  }

  // 註冊資料夾選擇對話框取消事件
  const folderSelectCancel = document.getElementById('folder-select-cancel');
  if (folderSelectCancel) {
    folderSelectCancel.addEventListener('click', () => {
      document.getElementById('folder-select-dialog').close();
    });
  }
 
  // 閱讀統計按鈕與對話框
  const statsBtn = document.getElementById('stats-btn');
  if (statsBtn) {
    statsBtn.addEventListener('click', openGlobalStatsModal);
  }

  const closeStatsBtn = document.getElementById('close-stats-modal');
  if (closeStatsBtn) {
    closeStatsBtn.addEventListener('click', closeStatsModal);
  }

  const statsBackdrop = document.getElementById('stats-modal-backdrop');
  if (statsBackdrop) {
    statsBackdrop.addEventListener('click', closeStatsModal);
  }

  // 書庫行為
  const importBtn = document.getElementById('import-btn');
  const fileInput = document.getElementById('file-input');
  const restoreFileInput = document.getElementById('restore-file-input');
  
  // Adjust accept attribute for Android devices to avoid file picker greying out files.
  // iOS requires public.data to select e-books, but Android WebView gets confused by custom mime types/extensions
  // and greys out files. We set it to '*/*' on Android, and validate extensions in handleImportFiles/handleImportBackup.
  if (fileInput && /android/i.test(navigator.userAgent)) {
    fileInput.setAttribute('accept', '*/*');
  }
  if (restoreFileInput && /android/i.test(navigator.userAgent)) {
    restoreFileInput.setAttribute('accept', '*/*');
  }

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileSelect);

  // 備份與還原書庫
  const backupBtn = document.getElementById('backup-btn');
  const restoreBtn = document.getElementById('restore-btn');
  if (backupBtn) {
    backupBtn.addEventListener('click', handleExportBackup);
  }
  if (restoreBtn && restoreFileInput) {
    restoreBtn.addEventListener('click', () => restoreFileInput.click());
    restoreFileInput.addEventListener('change', handleImportBackup);
  }

  // 更多操作下拉選單
  const moreActionsBtn = document.getElementById('more-actions-btn');
  const moreActionsDropdown = document.getElementById('more-actions-dropdown');
  if (moreActionsBtn && moreActionsDropdown) {
    moreActionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreActionsDropdown.classList.toggle('active');
    });
    document.addEventListener('click', (e) => {
      if (!moreActionsDropdown.contains(e.target)) {
        moreActionsDropdown.classList.remove('active');
      }
    });
    moreActionsDropdown.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        moreActionsDropdown.classList.remove('active');
      });
    });
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



  // 清理所有統計數據按鈕
  const clearAllStatsBtn = document.getElementById('clear-all-stats-btn');
  if (clearAllStatsBtn) {
    clearAllStatsBtn.addEventListener('click', async () => {
      if (confirm(getMsg('confirm_clear_all_stats') || '確定要清除所有書籍的閱讀統計數據嗎？此操作無法撤銷。')) {
        try {
          await library.clearAllStats();
          await openGlobalStatsModal();
        } catch (e) {
          console.error('Failed to clear all stats:', e);
          alert('清除統計數據失敗: ' + e.message);
        }
      }
    });
  }

  // 清理單本書統計按鈕
  const clearBookStatsBtn = document.getElementById('clear-book-stats-btn');
  if (clearBookStatsBtn) {
    clearBookStatsBtn.addEventListener('click', async () => {
      const statsBookSelect = document.getElementById('stats-book-select');
      if (!statsBookSelect) return;
      const selectedBookId = statsBookSelect.value;
      if (!selectedBookId) return;

      if (confirm(getMsg('confirm_clear_book_stats') || '確定要清除本書的閱讀統計數據吗？此操作無法撤銷。')) {
        try {
          await library.clearBookStats(selectedBookId);
          // 重新整理當前書籍統計
          await renderBookStats(selectedBookId);
          
          // 同步重新讀取並刷新全局統計
          const books = await library.getAllBooks();
          let totalSeconds = 0;
          let readBooksCount = 0;
          const activeDaysSet = new Set();
          const globalHourly = Array(24).fill(0);

          books.forEach(b => {
            const stats = b.stats || { readingDays: {}, hourlyDist: {} };
            const bookTotal = Object.values(stats.readingDays || {}).reduce((s, v) => s + v, 0);
            totalSeconds += bookTotal;
            if (bookTotal > 0) {
              readBooksCount++;
            }
            if (stats.readingDays) {
              Object.keys(stats.readingDays).forEach(day => activeDaysSet.add(day));
            }
            if (stats.hourlyDist) {
              for (let h = 0; h < 24; h++) {
                globalHourly[h] += (stats.hourlyDist[h] || 0);
              }
            }
          });

          const gTime = document.getElementById('global-total-time');
          const gBooks = document.getElementById('global-total-books');
          const gDays = document.getElementById('global-total-days');
          if (gTime) gTime.textContent = formatDuration(totalSeconds);
          if (gBooks) gBooks.textContent = readBooksCount;
          if (gDays) gDays.textContent = activeDaysSet.size;

          renderHourlyChart('global-hourly-chart', globalHourly);
        } catch (e) {
          console.error('Failed to clear book stats:', e);
          alert('清除統計數據失敗: ' + e.message);
        }
      }
    });
  }

  // 拖曳導入（僅桌面端有效）
  const dragOverlay = document.getElementById('drag-overlay');
  const libraryView = document.getElementById('library-view');
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  if (!isTouchDevice) {
    let dragEnterCounter = 0; // 追蹤 dragenter/dragleave 配對，防止子元素觸發導致閃爍
    
    window.addEventListener('dragenter', (e) => {
      if (document.getElementById('library-view').classList.contains('view-active')) {
        dragEnterCounter++;
        dragOverlay.style.display = 'flex';
      }
    });

    window.addEventListener('dragleave', (e) => {
      dragEnterCounter--;
      if (dragEnterCounter <= 0) {
        dragEnterCounter = 0;
        dragOverlay.style.display = 'none';
      }
    });

    window.addEventListener('drop', () => {
      dragEnterCounter = 0;
    });

    dragOverlay.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    dragOverlay.addEventListener('drop', (e) => {
      e.preventDefault();
      dragEnterCounter = 0;
      dragOverlay.style.display = 'none';
      if (e.dataTransfer.files.length > 0) {
        handleImportFiles(e.dataTransfer.files);
      }
    });
  }

  // 點擊 overlay 本身也可關閉（容錯：防止任何情況下卡住）
  if (dragOverlay) {
    dragOverlay.addEventListener('click', () => {
      dragOverlay.style.display = 'none';
    });
  }

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
  document.getElementById('search-toggle').addEventListener('click', toggleSearchSidebar);
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

  const pagePaddingSlider = document.getElementById('page-padding-slider');
  if (pagePaddingSlider) {
    pagePaddingSlider.addEventListener('input', (e) => {
      setPagePadding(e.target.value);
    });
  }

  const pagesDisplayedSelect = document.getElementById('pages-displayed-select');
  if (pagesDisplayedSelect) {
    pagesDisplayedSelect.addEventListener('change', (e) => {
      setPagesDisplayed(e.target.value);
    });
  }

  const ttsHighlightStyleSelect = document.getElementById('tts-highlight-style-select');
  if (ttsHighlightStyleSelect) {
    ttsHighlightStyleSelect.addEventListener('change', (e) => {
      setTtsHighlightStyle(e.target.value);
    });
  }

  const paperTextureSelect = document.getElementById('paper-texture-select');
  if (paperTextureSelect) {
    paperTextureSelect.addEventListener('change', (e) => {
      setPaperTexture(e.target.value);
    });
  }

  // AI 配置与服务商变动监听
  const profileSelect = document.getElementById('ai-profile-select');
  if (profileSelect) {
    profileSelect.addEventListener('change', (e) => {
      const profileId = e.target.value;
      activeAIProfileId = profileId;
      const activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (activeProfile) {
        loadActiveAIProfileToUI(activeProfile);
      }
    });
  }

  const profileNameInput = document.getElementById('ai-profile-name-input');
  if (profileNameInput) {
    profileNameInput.addEventListener('input', (e) => {
      const val = e.target.value;
      const activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (activeProfile && activeProfile.isCustom) {
        activeProfile.name = val;
        // 即时同步更新下拉选单中的文字
        const profileSelect = document.getElementById('ai-profile-select');
        if (profileSelect) {
          const activeOpt = profileSelect.querySelector(`option[value="${activeAIProfileId}"]`);
          if (activeOpt) activeOpt.textContent = val || getMsg('ai_profile_default_custom_name') || 'New Custom AI';
        }
      }
    });
  }

  const profileAddBtn = document.getElementById('ai-profile-add-btn');
  if (profileAddBtn) {
    profileAddBtn.addEventListener('click', () => {
      const newId = 'custom_' + Date.now();
      const defaultName = (getMsg('ai_profile_default_custom_name') || 'New Custom AI') + ' ' + (aiProfilesList.filter(p => p.isCustom).length + 1);
      const newProfile = {
        id: newId,
        name: defaultName,
        provider: 'openai',
        apiKey: '',
        endpoint: '',
        model: '',
        isCustom: true
      };
      aiProfilesList.push(newProfile);
      activeAIProfileId = newId;
      renderAIProfileOptions();
      loadActiveAIProfileToUI(newProfile);
      
      // 自动聚焦到名称输入框
      const nameInput = document.getElementById('ai-profile-name-input');
      if (nameInput) {
        nameInput.focus();
        nameInput.select();
      }
    });
  }

  const profileDeleteBtn = document.getElementById('ai-profile-delete-btn');
  if (profileDeleteBtn) {
    profileDeleteBtn.addEventListener('click', () => {
      const activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (!activeProfile || !activeProfile.isCustom) return;
      
      const confirmMsg = getMsg('confirm_delete_profile') || '确定要删除此 AI 配置吗？';
      if (confirm(confirmMsg)) {
        aiProfilesList = aiProfilesList.filter(p => p.id !== activeAIProfileId);
        // 回退到第一个配置 (通常是 builtin)
        activeAIProfileId = aiProfilesList[0] ? aiProfilesList[0].id : 'builtin';
        renderAIProfileOptions();
        const nextProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
        if (nextProfile) {
          loadActiveAIProfileToUI(nextProfile);
        }
      }
    });
  }

  const providerSelect = document.getElementById('ai-provider-select');
  if (providerSelect) {
    providerSelect.addEventListener('change', (e) => {
      const provider = e.target.value;
      const activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (activeProfile) {
        activeProfile.provider = provider;
        updateAIConfigPlaceholders(provider);
        updateAIConfigFieldsVisibility(provider);
      }
    });
  }

  const apiKeyInput = document.getElementById('ai-api-key-input');
  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', (e) => {
      const val = e.target.value;
      const activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (activeProfile) {
        activeProfile.apiKey = val;
      }
    });
  }

  const endpointInput = document.getElementById('ai-endpoint-input');
  if (endpointInput) {
    endpointInput.addEventListener('input', (e) => {
      const val = e.target.value;
      const activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (activeProfile) {
        activeProfile.endpoint = val;
      }
    });
  }

  const modelInput = document.getElementById('ai-model-input');
  if (modelInput) {
    modelInput.addEventListener('input', (e) => {
      const val = e.target.value;
      const activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (activeProfile) {
        activeProfile.model = val;
      }
    });
  }

  // TTS 設定變更監聽
  const ttsProviderSelect = document.getElementById('tts-provider-select');
  if (ttsProviderSelect) {
    ttsProviderSelect.addEventListener('change', (e) => {
      const provider = e.target.value;
      
      const endpointInput = document.getElementById('tts-endpoint-input');
      const modelInput = document.getElementById('tts-model-input');
      const apiKeyInput = document.getElementById('tts-api-key-input');
      if (provider === 'openai') {
        if (endpointInput) endpointInput.placeholder = 'https://api.openai.com/v1';
        if (modelInput) modelInput.placeholder = 'tts-1';
        if (apiKeyInput) apiKeyInput.placeholder = 'sk-...';
      } else if (provider === 'local') {
        if (endpointInput) endpointInput.placeholder = 'http://localhost:5000/v1';
        if (modelInput) modelInput.placeholder = 'tts-1';
        if (apiKeyInput) apiKeyInput.placeholder = getMsg('tts_api_key_optional') || 'Optional (e.g. for proxy auth)';
      }

      updateTTSConfigFieldsVisibility(provider);
      tts.configure({ provider });
      chrome.storage.local.set({ ttsProvider: provider }, () => {
        initTTSPanelVoices();
      });
    });
  }

  const ttsApiKeyInput = document.getElementById('tts-api-key-input');
  if (ttsApiKeyInput) {
    ttsApiKeyInput.addEventListener('input', (e) => {
      const val = e.target.value;
      tts.configure({ apiKey: val });
      chrome.storage.local.set({ ttsApiKey: val });
    });
  }

  const ttsEndpointInput = document.getElementById('tts-endpoint-input');
  if (ttsEndpointInput) {
    ttsEndpointInput.addEventListener('input', (e) => {
      const val = e.target.value;
      tts.configure({ endpoint: val });
      chrome.storage.local.set({ ttsEndpoint: val });
    });
  }

  const ttsModelInput = document.getElementById('tts-model-input');
  if (ttsModelInput) {
    ttsModelInput.addEventListener('input', (e) => {
      const val = e.target.value;
      tts.configure({ model: val });
      chrome.storage.local.set({ ttsModel: val });
    });
  }

  // TTS 獲取模型列表按鈕監聽
  const ttsFetchModelsBtn = document.getElementById('tts-fetch-models-btn');
  const ttsModelSelect = document.getElementById('tts-model-select');
  if (ttsFetchModelsBtn && ttsModelSelect && ttsModelInput) {
    ttsFetchModelsBtn.addEventListener('click', async () => {
      const provider = document.getElementById('tts-provider-select').value;
      const endpoint = document.getElementById('tts-endpoint-input').value;
      const apiKey = document.getElementById('tts-api-key-input').value;

      const originalText = ttsFetchModelsBtn.textContent;
      ttsFetchModelsBtn.textContent = getMsg('ai_fetching_models') || 'Fetching...';
      ttsFetchModelsBtn.disabled = true;

      try {
        const models = await tts.fetchModels(provider, endpoint, apiKey);
        if (models && models.length > 0) {
          ttsModelSelect.innerHTML = '';
          const placeholderOpt = document.createElement('option');
          placeholderOpt.value = '';
          placeholderOpt.textContent = '-- Select --';
          ttsModelSelect.appendChild(placeholderOpt);

          models.forEach(model => {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            ttsModelSelect.appendChild(opt);
          });
          ttsModelSelect.style.display = 'inline-block';
          ttsFetchModelsBtn.textContent = getMsg('ai_fetch_models_success') || 'Success';
          ttsFetchModelsBtn.style.color = '#34c759';
        } else {
          throw new Error('No models returned');
        }
      } catch (err) {
        console.error('Failed to fetch TTS models:', err);
        alert((getMsg('ai_fetch_models_fail') || 'Failed to fetch models') + ': ' + (err.message || err));
        ttsFetchModelsBtn.textContent = originalText;
        ttsFetchModelsBtn.style.color = '';
      } finally {
        ttsFetchModelsBtn.disabled = false;
        setTimeout(() => {
          ttsFetchModelsBtn.textContent = originalText;
          ttsFetchModelsBtn.style.color = '';
        }, 3000);
      }
    });

    ttsModelSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) {
        ttsModelInput.value = val;
        tts.configure({ model: val });
        chrome.storage.local.set({ ttsModel: val });
      }
    });
  }

  // AI 測試配置按鈕監聽
  const aiTestBtn = document.getElementById('ai-test-btn');
  const aiTestResult = document.getElementById('ai-test-result');
  if (aiTestBtn && aiTestResult) {
    aiTestBtn.addEventListener('click', async () => {
      const provider = document.getElementById('ai-provider-select').value;
      const apiKey = document.getElementById('ai-api-key-input').value;
      const endpoint = document.getElementById('ai-endpoint-input').value;
      const model = document.getElementById('ai-model-input').value;

      aiTestResult.style.display = 'block';
      aiTestResult.style.color = 'var(--text-color)';
      aiTestResult.textContent = getMsg('ai_test_testing') || 'Testing...';

      try {
        const response = await ai.testConnection(provider, endpoint, apiKey, model);
        aiTestResult.style.color = '#34c759'; // green color for success
        const preview = response.length > 30 ? response.substring(0, 30) + '...' : response;
        aiTestResult.textContent = `${getMsg('ai_test_success') || 'Success!'} (${preview})`;
        setTimeout(() => {
          aiTestResult.style.display = 'none';
        }, 5000);
      } catch (err) {
        aiTestResult.style.color = '#ff3b30'; // red color for error
        let errMsg = err.message || err;
        const endpointLower = (endpoint || '').toLowerCase();
        if (errMsg.includes('Failed to fetch') && (endpointLower.includes('127.0.0.1') || endpointLower.includes('localhost'))) {
          errMsg += ' (请确认 Ollama 已启动且配置了 OLLAMA_ORIGINS="*"；网页版因浏览器 Mixed Content 安全限制无法连结本地 HTTP，请改用 Chrome 插件版)';
        }
        aiTestResult.textContent = `${getMsg('ai_test_fail') || 'Failed'}: ${errMsg}`;
      }
    });
  }

  // AI 獲取模型列表按鈕監聽
  const aiFetchModelsBtn = document.getElementById('ai-fetch-models-btn');
  const aiModelSelect = document.getElementById('ai-model-select');
  const aiModelInput = document.getElementById('ai-model-input');
  if (aiFetchModelsBtn && aiModelSelect && aiModelInput) {
    aiFetchModelsBtn.addEventListener('click', async () => {
      const provider = document.getElementById('ai-provider-select').value;
      const endpoint = document.getElementById('ai-endpoint-input').value;
      const apiKey = document.getElementById('ai-api-key-input').value;

      const originalText = aiFetchModelsBtn.textContent;
      aiFetchModelsBtn.textContent = getMsg('ai_fetching_models') || 'Fetching...';
      aiFetchModelsBtn.disabled = true;

      try {
        const models = await ai.fetchModels(provider, endpoint, apiKey);
        if (models && models.length > 0) {
          aiModelSelect.innerHTML = '';
          const placeholderOpt = document.createElement('option');
          placeholderOpt.value = '';
          placeholderOpt.textContent = '-- Select --';
          aiModelSelect.appendChild(placeholderOpt);

          models.forEach(model => {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            aiModelSelect.appendChild(opt);
          });
          aiModelSelect.style.display = 'inline-block';
          aiFetchModelsBtn.textContent = getMsg('ai_fetch_models_success') || 'Success';
          aiFetchModelsBtn.style.color = '#34c759';
        } else {
          throw new Error('No models returned');
        }
      } catch (err) {
        console.error('Failed to fetch models:', err);
        let errMsg = err.message || err;
        const endpointLower = (endpoint || '').toLowerCase();
        if (errMsg.includes('Failed to fetch') && (endpointLower.includes('127.0.0.1') || endpointLower.includes('localhost'))) {
          errMsg += ' (请确认 Ollama 已启动且已设置 OLLAMA_ORIGINS="*" 并重启；若为 HTTPS 网页版，请换用 Chrome 插件版以避开 Mixed Content 限制)';
        }
        alert((getMsg('ai_fetch_models_fail') || 'Failed to fetch models') + ': ' + errMsg);
        aiFetchModelsBtn.textContent = originalText;
        aiFetchModelsBtn.style.color = '';
      } finally {
        aiFetchModelsBtn.disabled = false;
        setTimeout(() => {
          aiFetchModelsBtn.textContent = originalText;
          aiFetchModelsBtn.style.color = '';
        }, 3000);
      }
    });

    aiModelSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        aiModelInput.value = e.target.value;
        aiModelInput.dispatchEvent(new Event('input'));
      }
    });
  }

  // AI 保存配置按鈕監聽
  const aiSaveBtn = document.getElementById('ai-save-btn');
  if (aiSaveBtn) {
    aiSaveBtn.addEventListener('click', () => {
      const activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (activeProfile) {
        activeProfile.provider = document.getElementById('ai-provider-select').value;
        activeProfile.apiKey = document.getElementById('ai-api-key-input').value;
        activeProfile.endpoint = document.getElementById('ai-endpoint-input').value;
        activeProfile.model = document.getElementById('ai-model-input').value;
        if (activeProfile.isCustom) {
          const nameVal = document.getElementById('ai-profile-name-input').value.trim();
          activeProfile.name = nameVal || getMsg('ai_profile_default_custom_name') || 'New Custom AI';
          document.getElementById('ai-profile-name-input').value = activeProfile.name;
          renderAIProfileOptions();
        }

        // 配置 AI 引擎
        ai.configure({
          provider: activeProfile.provider,
          apiKey: activeProfile.apiKey,
          endpoint: activeProfile.endpoint,
          model: activeProfile.model
        });
      }

      const ttsProvider = document.getElementById('tts-provider-select').value;
      const ttsApiKey = document.getElementById('tts-api-key-input').value;
      const ttsEndpoint = document.getElementById('tts-endpoint-input').value;
      const ttsModel = document.getElementById('tts-model-input').value;
      const ttsLanguage = document.getElementById('tts-language-select').value;
      const ttsVoice = document.getElementById('tts-voice-input').value.trim();

      tts.configure({ provider: ttsProvider, apiKey: ttsApiKey, endpoint: ttsEndpoint, model: ttsModel });
      currentTTSLanguage = ttsLanguage;
      ttsDefaultVoice = ttsVoice;

      chrome.storage.local.set({ 
        aiProfiles: aiProfilesList,
        activeAIProfileId: activeAIProfileId,
        ttsProvider: ttsProvider,
        ttsApiKey: ttsApiKey,
        ttsEndpoint: ttsEndpoint,
        ttsModel: ttsModel,
        ttsLanguage: ttsLanguage,
        ttsDefaultVoice: ttsVoice
      }, () => {
        updateAIButtonsVisibility();
        initTTSPanelVoices();
        // 顯示已保存的反饋狀態
        const originalText = aiSaveBtn.textContent;
        aiSaveBtn.textContent = getMsg('ai_settings_saved') || 'Saved';
        aiSaveBtn.style.backgroundColor = '#34c759'; // green color for success
        setTimeout(() => {
          aiSaveBtn.textContent = originalText;
          aiSaveBtn.style.backgroundColor = ''; // restore original background
        }, 1500);
      });
    });
  }

  // AI 面板頂欄關閉按鈕監聽
  const closeAiPanelBtn = document.getElementById('close-ai-panel');
  if (closeAiPanelBtn) {
    closeAiPanelBtn.addEventListener('click', () => {
      document.getElementById('ai-panel').style.display = 'none';
      updateHeaderActiveStates();
    });
  }

  // AI 面板一鍵全書深度分析按鈕監聽
  const deepAnalysisBtn = document.getElementById('deep-analysis-btn');
  if (deepAnalysisBtn) {
    deepAnalysisBtn.addEventListener('click', async () => {
      if (!currentBook) {
        alert(getMsg('no_book_open') || '請先打開一本書！');
        return;
      }
      
      const chaptersCount = (epubBookData && epubBookData.chapters) ? epubBookData.chapters.length : 0;
      
      if (currentBook.bookSummary) {
        const reAnalyze = confirm((getMsg('confirm_reanalyze_book') || '這本書已經有深度分析報告了，確定要重新生成嗎？這將會消耗較多 API Token。')
          + `\n\n(提示：本電子書共有 ${chaptersCount} 個章節，重新生成將分析所有章節，約消耗 10万~20万 Token)`);
        if (!reAnalyze) {
          displayBookSummary(currentBook.bookSummary);
          return;
        }
      } else {
        const confirmAnalysis = confirm((getMsg('confirm_deep_analysis') || '「深度分析全書」將會分析本書，並消耗較多 API Token。是否繼續？')
          + `\n\n(提示：本電子書共有 ${chaptersCount} 個章節，將逐章生成摘要後進行全局分析，約消耗 10万~20万 Token)`);
        if (!confirmAnalysis) return;
      }
      
      await runDeepBookAnalysis();
    });
  }

  // AI 面板一鍵清空歷史記錄按鈕監聽
  const clearAIHistoryBtn = document.getElementById('clear-ai-history-btn');
  if (clearAIHistoryBtn) {
    clearAIHistoryBtn.addEventListener('click', async () => {
      if (!currentBook) return;
      const confirmMsg = getMsg('confirm_delete_all_chats') || '確定要清除本書的所有 AI 溝通記錄嗎？此操作無法撤銷。';
      if (confirm(confirmMsg)) {
        try {
          const updatedChats = await library.clearAllAIChats(currentBook.id);
          currentBook.aiChats = updatedChats;
          renderAIChatHistory();
        } catch (err) {
          console.error('Failed to clear AI history:', err);
          alert(getMsg('error_prefix') + ': ' + err.message);
        }
      }
    });
  }

  // 頂欄 AI 助手切換按鈕監聽
  const aiToggleBtn = document.getElementById('ai-toggle');
  if (aiToggleBtn) {
    aiToggleBtn.addEventListener('click', () => {
      const aiPanel = document.getElementById('ai-panel');
      if (aiPanel.style.display === 'flex' || aiPanel.style.display === 'block') {
        aiPanel.style.display = 'none';
      } else {
        aiPanel.style.display = 'flex';
        // 如果是空的，初始化歡迎詞
        const contentEl = document.getElementById('ai-content');
        if (contentEl.querySelectorAll('.ai-chat-group').length === 0 && !contentEl.querySelector('.ai-chat-bubble')) {
          contentEl.innerHTML = `
            <div class="ai-chat-bubble assistant-bubble">
              ${getMsg('ai_welcome_msg') || 'Hi! I am your AI Reading Assistant. How can I help you today?'}
            </div>
          `;
        }
        document.getElementById('ai-input').focus();
        
        // 關閉其他側邊欄和下拉面板
        document.getElementById('reader-sidebar').classList.remove('active');
        document.getElementById('settings-panel').classList.remove('dropdown-active');
        document.getElementById('tts-panel').classList.remove('dropdown-active');
      }
      updateHeaderActiveStates();
    });
  }

  // AI 聊天發送按鈕
  const aiSendBtn = document.getElementById('ai-send-btn');
  if (aiSendBtn) {
    aiSendBtn.addEventListener('click', () => {
      sendCustomAIQuery();
    });
  }

  // AI 聊天輸入框 Keydown 監聽 (Enter 送出, Shift+Enter 換行)
  const aiInput = document.getElementById('ai-input');
  if (aiInput) {
    aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCustomAIQuery();
      }
    });
    // 自動調整 textarea 高度
    aiInput.addEventListener('input', (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 80)}px`;
    });
  }

  // Toggle prompt suggestions drawer
  const toggleSuggestionsBtn = document.getElementById('ai-toggle-suggestions-btn');
  const suggestionsContainer = document.getElementById('ai-suggestions-container');
  if (toggleSuggestionsBtn && suggestionsContainer) {
    toggleSuggestionsBtn.addEventListener('click', () => {
      const isShow = suggestionsContainer.classList.toggle('show');
      toggleSuggestionsBtn.classList.toggle('active', isShow);
    });
  }

  // AI Prompt Edit Dialog event listeners
  const aiPromptForm = document.getElementById('ai-prompt-edit-form');
  const aiPromptCancel = document.getElementById('ai-prompt-dialog-cancel');
  const aiPromptDelete = document.getElementById('ai-prompt-dialog-delete');
  const aiPromptDialog = document.getElementById('ai-prompt-edit-dialog');

  if (aiPromptForm) {
    aiPromptForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('ai-prompt-name-input');
      const contentInput = document.getElementById('ai-prompt-content-input');
      if (!nameInput || !contentInput) return;
      
      const newLabel = nameInput.value.trim();
      const newPrompt = contentInput.value.trim();
      if (!newLabel || !newPrompt) return;
      
      if (currentEditingPromptIndex >= 0) {
        const item = aiPromptsTemplatesList[currentEditingPromptIndex];
        item.label = newLabel;
        item.prompt = newPrompt;
      } else {
        const newItem = {
          key: 'ai_suggest_custom_' + Date.now(),
          icon: DEFAULT_CUSTOM_ICON,
          label: newLabel,
          prompt: newPrompt,
          isDefault: false
        };
        aiPromptsTemplatesList.push(newItem);
      }
      
      chrome.storage.local.set({ aiPromptsTemplates: aiPromptsTemplatesList }, () => {
        initAISuggestions();
        aiPromptDialog.close();
      });
    });
  }

  if (aiPromptCancel) {
    aiPromptCancel.addEventListener('click', () => {
      if (aiPromptDialog) aiPromptDialog.close();
    });
  }

  if (aiPromptDelete) {
    aiPromptDelete.addEventListener('click', () => {
      if (currentEditingPromptIndex >= 0) {
        const confirmMsg = getMsg('confirm_delete_prompt') || 'Are you sure you want to delete this prompt template?';
        if (confirm(confirmMsg)) {
          aiPromptsTemplatesList.splice(currentEditingPromptIndex, 1);
          chrome.storage.local.set({ aiPromptsTemplates: aiPromptsTemplatesList }, () => {
            initAISuggestions();
            if (aiPromptDialog) aiPromptDialog.close();
          });
        }
      }
    });
  }

  if (aiPromptDialog) {
    aiPromptDialog.addEventListener('click', (e) => {
      if (e.target === aiPromptDialog) {
        aiPromptDialog.close();
      }
    });
  }

  // 版面排版模式切換
  const layoutScrollBtn = document.getElementById('layout-scroll-btn');
  if (layoutScrollBtn) {
    layoutScrollBtn.addEventListener('click', () => {
      toggleLayoutMode('scroll');
    });
  }
  const layoutPaginatedBtn = document.getElementById('layout-paginated-btn');
  if (layoutPaginatedBtn) {
    layoutPaginatedBtn.addEventListener('click', () => {
      toggleLayoutMode('paginated');
    });
  }

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
      // 從進度保存的句子索引或當前頁面第一個可見句子開始朗讀
      let savedIndex = 0;
      if (currentBook && currentBook.progress) {
        const savedTTSChapter = currentBook.progress.ttsChapterIndex;
        if (savedTTSChapter === currentChapterIndex) {
          // 保存的 TTS 章節與當前章節一致，直接恢復
          savedIndex = currentBook.progress.ttsActiveSentenceIndex || 0;
        } else if (savedTTSChapter !== undefined && savedTTSChapter !== null) {
          // 保存的 TTS 章節與當前視覺章節不同
          // 檢查是否屬於相同 cleanHref 的子章節（多個子章節共享同一頁面內容）
          const currentCleanHref = epubBookData && epubBookData.chapters[currentChapterIndex] ? epubBookData.chapters[currentChapterIndex].cleanHref : null;
          const savedCleanHref = epubBookData && epubBookData.chapters[savedTTSChapter] ? epubBookData.chapters[savedTTSChapter].cleanHref : null;
          if (currentCleanHref && savedCleanHref && currentCleanHref === savedCleanHref) {
            // 同一個 HTML 文件的不同子章節，可以直接恢復（sentences 中包含所有子章節的句子）
            savedIndex = currentBook.progress.ttsActiveSentenceIndex || 0;
          } else {
            // 完全不同的章節，使用當前可見位置
            savedIndex = getFirstVisibleSentenceIndex();
          }
        } else if (currentBook.progress.activeSentenceIndex !== undefined && currentBook.progress.chapterIndex === currentChapterIndex) {
          savedIndex = currentBook.progress.activeSentenceIndex || 0;
        } else {
          savedIndex = getFirstVisibleSentenceIndex();
        }
      }
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
      initTTSPanelVoices(currentBook ? (currentBook.file?.name || currentBook.title || '') : '');
      
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
  // TTS 進度心跳保存計時器：每 5 秒強制保存一次，防止 app 被殺時丟失進度
  let ttsProgressHeartbeatTimer = null;
  function startTTSProgressHeartbeat() {
    stopTTSProgressHeartbeat();
    ttsProgressHeartbeatTimer = setInterval(() => {
      if (tts.isPlaying && !tts.isPaused && currentBook) {
        saveTTSProgressImmediately();
      }
    }, 5000);
  }
  function stopTTSProgressHeartbeat() {
    if (ttsProgressHeartbeatTimer) {
      clearInterval(ttsProgressHeartbeatTimer);
      ttsProgressHeartbeatTimer = null;
    }
  }
  
  // TTS 引擎狀態同步
  tts.onStateChange = () => {
    updatePlayPauseButtonIcon();
    updateEdgeFilterButtonVisibility();
    
    // 當暫停或停止時，立即強制保存最新朗讀位置，不使用防抖，確保在後台或藍牙暫停時進度被即時寫入資料庫
    if (!tts.isPlaying || tts.isPaused) {
      saveTTSProgressImmediately();
      stopTTSProgressHeartbeat();
    } else {
      // 播放中：啟動心跳保存
      startTTSProgressHeartbeat();
    }
    
    if (tts.voices.length !== lastVoicesCount) {
      lastVoicesCount = tts.voices.length;
      initTTSPanelVoices(currentBook ? (currentBook.file?.name || currentBook.title || '') : '');
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
      await loadChapter(nextChapterIndex, false, false, false, true, null, null, null, null, null, true);
    }
    updatePlayPauseButtonIcon();
  };

  tts.onSentenceStart = (index) => {
    // 同步播放按鈕狀態
    updatePlayPauseButtonIcon();

    // 朗讀句子時更新進度 (儲存於獨立的 tts 進度欄位)
    // 使用立即保存而非防抖，確保每一句的位置都能即時持久化，
    // 防止後台被殺、藍牙暫停等場景下丟失最新進度
    if (currentBook) {
      const maxIdx = tts.sentences.length > 0 ? tts.sentences.length - 1 : 0;
      const safeIdx = Math.max(0, Math.min(index, maxIdx));
      const sentence = tts.sentences[safeIdx];
      if (sentence) {
        const relativeIdx = sentence.relativeIndex !== undefined ? sentence.relativeIndex : safeIdx;
        const sentenceChapter = sentence.chapterIndex !== undefined ? sentence.chapterIndex : currentChapterIndex;
        const progressUpdate = { 
          ttsActiveSentenceIndex: relativeIdx,
          ttsChapterIndex: sentenceChapter
        };
        // 立即寫入 IndexedDB（非防抖），確保 app 被殺時有最新位置
        library.updateProgress(currentBook.id, progressUpdate).catch(e => console.warn('[TTS] Progress save failed:', e));
        currentBook.progress = { ...currentBook.progress, ...progressUpdate };
      }
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
            
            isTTSAutoPageTurning = true;
            currentPageIndex = pageIndex;
            updatePageTranslate();
            isTTSAutoPageTurning = false;
          }
        }
      }
    }
  };

  // 側邊欄切換標籤
  document.getElementById('tab-toc').addEventListener('click', () => switchSidebarTab('toc'));
  document.getElementById('tab-highlights').addEventListener('click', () => switchSidebarTab('highlights'));
  document.getElementById('tab-search').addEventListener('click', () => switchSidebarTab('search'));

  document.getElementById('sidebar-search-btn').addEventListener('click', () => {
    const input = document.getElementById('sidebar-search-input');
    performBookSearch(input.value);
  });
  document.getElementById('sidebar-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      performBookSearch(e.target.value);
    }
  });

  document.getElementById('close-sidebar-btn').addEventListener('click', () => {
    document.getElementById('reader-sidebar').classList.remove('active');
    updateHeaderActiveStates();
  });

  document.getElementById('add-bookmark-btn').addEventListener('click', handleAddBookmark);

  // 漫畫 CBZ 翻頁控制
  document.getElementById('comic-prev-btn').addEventListener('click', prevComicPage);
  document.getElementById('comic-next-btn').addEventListener('click', nextComicPage);

  // 文字選取菜單事件
  const bookContent = document.getElementById('book-content');
  bookContent.addEventListener('mouseup', handleTextSelection);
  bookContent.addEventListener('touchend', handleTextSelection);

  // 監聽全局 selectionchange 事件，解決行動端長按選擇後需要滑動屏幕才彈出選單的 Bug
  let selectionChangeTimeout = null;
  document.addEventListener('selectionchange', () => {
    if (!currentBook) return;
    const readerView = document.getElementById('reader-view');
    if (readerView && readerView.classList.contains('view-active')) {
      if (selectionChangeTimeout) clearTimeout(selectionChangeTimeout);
      selectionChangeTimeout = setTimeout(() => {
        handleTextSelection();
      }, 250);
    }
  });

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
        tts.play(sentenceIdx, true);
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
  document.getElementById('selection-ai-ask').addEventListener('click', triggerAIAsk);

  // 清除選取上下文按鈕
  const aiClearContextBtn = document.getElementById('ai-clear-context-btn');
  if (aiClearContextBtn) {
    aiClearContextBtn.addEventListener('click', () => {
      activeSelectedTextContext = '';
      const badge = document.getElementById('ai-selection-context');
      if (badge) badge.style.display = 'none';
    });
  }
  document.getElementById('selection-delete-btn').addEventListener('click', async () => {
    if (selectedNoteIdState) {
      await deleteNoteHandler(selectedNoteIdState);
      document.getElementById('selection-menu').style.display = 'none';
      window.getSelection().removeAllRanges();
    }
  });

  // 筆記對話框
  document.getElementById('note-cancel-btn').addEventListener('click', () => {
    document.getElementById('note-dialog').style.display = 'none';
    window.getSelection().removeAllRanges();
  });
  document.getElementById('note-save-btn').addEventListener('click', handleSaveNote);

  // AI 面板
  document.getElementById('close-ai-panel').addEventListener('click', () => {
    document.getElementById('ai-panel').style.display = 'none';
    updateHeaderActiveStates();
  });
  const maxBtn = document.getElementById('maximize-ai-panel');
  if (maxBtn) {
    maxBtn.addEventListener('click', () => {
      const panel = document.getElementById('ai-panel');
      if (panel) {
        panel.classList.toggle('maximized');
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
          if (panel.classList.contains('maximized')) {
            if (typeof activeMindElixirs !== 'undefined') {
              activeMindElixirs.forEach(({ mind }) => {
                try {
                  mind.toCenter();
                } catch (e) {}
              });
            }
          }
        }, 100);
      }
    });
  }

  // 全局設置對話框
  const globalSettingsBtn = document.getElementById('global-settings-btn');
  const readerOpenSettingsBtn = document.getElementById('reader-open-settings-btn');
  const globalSettingsDialog = document.getElementById('global-settings-dialog');
  const closeGlobalSettingsBtn = document.getElementById('close-global-settings');
  const globalCoverWidthSlider = document.getElementById('global-cover-width-slider');
  const globalCoverWidthVal = document.getElementById('global-cover-width-val');

  if (globalSettingsDialog) {
    // 綁定打開
    if (globalSettingsBtn) {
      globalSettingsBtn.addEventListener('click', () => {
        const savedWidth = localStorage.getItem('coverWidth') || '180';
        if (globalCoverWidthSlider) globalCoverWidthSlider.value = savedWidth;
        if (globalCoverWidthVal) globalCoverWidthVal.textContent = `${savedWidth}px`;
        globalSettingsDialog.showModal();
      });
    }
    if (readerOpenSettingsBtn) {
      readerOpenSettingsBtn.addEventListener('click', () => {
        const settingsPanel = document.getElementById('settings-panel');
        if (settingsPanel) settingsPanel.classList.remove('active');
        
        const savedWidth = localStorage.getItem('coverWidth') || '180';
        if (globalCoverWidthSlider) globalCoverWidthSlider.value = savedWidth;
        if (globalCoverWidthVal) globalCoverWidthVal.textContent = `${savedWidth}px`;
        globalSettingsDialog.showModal();
      });
    }

    // 關閉按鈕
    if (closeGlobalSettingsBtn) {
      closeGlobalSettingsBtn.addEventListener('click', () => {
        globalSettingsDialog.close();
      });
    }

    // 點擊背景關閉
    globalSettingsDialog.addEventListener('click', (event) => {
      if (event.target === globalSettingsDialog) {
        globalSettingsDialog.close();
      }
    });

    // 封面大小滑動條監聽
    if (globalCoverWidthSlider) {
      globalCoverWidthSlider.addEventListener('input', (e) => {
        const val = e.target.value;
        if (globalCoverWidthVal) globalCoverWidthVal.textContent = `${val}px`;
        document.documentElement.style.setProperty('--cover-width', `${val}px`);
        localStorage.setItem('coverWidth', val);
      });
    }
  }

  // 關於對話框
  const aboutBtn = document.getElementById('about-btn');
  const aboutDialog = document.getElementById('about-dialog');
  const aboutCloseBtn = document.getElementById('about-dialog-close');
  if (aboutBtn && aboutDialog) {
    aboutBtn.addEventListener('click', () => {
      const versionDisplay = document.getElementById('about-version-display');
      if (versionDisplay) {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
          try {
            versionDisplay.textContent = 'v' + chrome.runtime.getManifest().version;
          } catch (e) {
            versionDisplay.textContent = 'v' + (window.__APP_VERSION__ || '');
          }
        } else {
          versionDisplay.textContent = 'v' + (window.__APP_VERSION__ || '');
        }
      }
      aboutDialog.showModal();
      checkForUpdates();
    });
  }
  if (aboutCloseBtn && aboutDialog) {
    aboutCloseBtn.addEventListener('click', () => {
      aboutDialog.close();
    });
  }
  if (aboutDialog) {
    aboutDialog.addEventListener('click', (event) => {
      if (event.target === aboutDialog) {
        aboutDialog.close();
      }
    });
  }

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
    let panelClosed = false;
    if (settingsPanel && settingsPanel.classList.contains('dropdown-active')) {
      if (!target.closest('#settings-panel') && !target.closest('#settings-toggle')) {
        settingsPanel.classList.remove('dropdown-active');
        panelClosed = true;
      }
    }
    // TTS 面板：點擊面板及其觸發按鈕外部則關閉
    const ttsPanel = document.getElementById('tts-panel');
    if (ttsPanel && ttsPanel.classList.contains('dropdown-active')) {
      if (!target.closest('#tts-panel') && !target.closest('#tts-toggle')) {
        ttsPanel.classList.remove('dropdown-active');
        panelClosed = true;
      }
    }
    // 側邊欄：點擊側邊欄及其觸發按鈕外部則關閉
    const sidebar = document.getElementById('reader-sidebar');
    if (sidebar && sidebar.classList.contains('active')) {
      if (!target.closest('#reader-sidebar') && !target.closest('#sidebar-toggle') && !target.closest('#search-toggle')) {
        sidebar.classList.remove('active');
        panelClosed = true;
      }
    }
    if (panelClosed) {
      updateHeaderActiveStates();
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
      updateReaderTitle();
    }
  });

  // 滾動自動保存進度
  window.addEventListener('scroll', () => {
    if (document.getElementById('reader-view').classList.contains('view-active')) {
      if (currentBook && currentBook.format !== 'cbz') {
        // 在垂直滾動模式下，如果當前物理文件包含多個子章節，滾動時自動校準 currentChapterIndex
        if (!document.body.classList.contains('layout-paginated') && epubBookData && epubBookData.chapters) {
          updateActiveSubChapterOnScroll();
        }

        // 更新標題欄進度百分比 (即時更新)
        updateReaderTitle();

        // 如果是由 TTS 觸發的自動滾動，則不覆寫用戶手動的閱讀進度
        if (tts.isAutoScrolling) {
          if (window.ttsAutoScrollTimeout) clearTimeout(window.ttsAutoScrollTimeout);
          window.ttsAutoScrollTimeout = setTimeout(() => {
            tts.isAutoScrolling = false;
          }, 1000); // 1秒安全回退防呆
          return;
        }

        // 保存進度 (防抖)
        const percent = calculateCurrentProgressPercent();
        saveProgressDebounced({
          chapterIndex: currentChapterIndex,
          elementIndex: getTopVisibleElementIndex(),
          scrollTop: window.scrollY,
          percent: percent
        });
      }
    }
  });

  // 檢測用戶手動交互以清除 TTS 自動滾動標記
  const resetAutoScroll = () => {
    tts.isAutoScrolling = false;
  };
  window.addEventListener('wheel', resetAutoScroll, { passive: true });
  window.addEventListener('touchstart', resetAutoScroll, { passive: true });
  window.addEventListener('mousedown', resetAutoScroll, { passive: true });
  window.addEventListener('keydown', resetAutoScroll, { passive: true });
  window.addEventListener('scrollend', resetAutoScroll, { passive: true });

  // 滾輪在最頂部/最底部時切換章節 (附帶閾值過濾與 800ms 冷卻時間防抖)
  window.addEventListener('wheel', (e) => {
    if (!document.getElementById('reader-view').classList.contains('view-active')) return;
    if (!currentBook || currentBook.format === 'cbz') return;
    if (document.body.classList.contains('layout-paginated')) return;
    if (isChangingChapter) return;
    if (Date.now() - lastChapterChangeTime < 800) return;

    const scrollTop = window.scrollY;
    if (scrollTop <= 5 && e.deltaY < -15) {
      // 在最頂部向上滾動 (加載上一章物理文件)
      if (currentChapterIndex > 0) {
        const currentHref = epubBookData.chapters[currentChapterIndex].cleanHref;
        let prevIdx = currentChapterIndex - 1;
        while (prevIdx >= 0 && epubBookData.chapters[prevIdx].cleanHref === currentHref) {
          prevIdx--;
        }
        if (prevIdx >= 0) {
          loadChapter(prevIdx, true, false, true, false, null, null, null, null, null, true);
        }
      }
    } else {
      const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
      const clientHeight = window.innerHeight;
      if (scrollTop + clientHeight >= scrollHeight - 5 && e.deltaY > 15) {
        // 在最底部向下滾動 (加載下一章物理文件)
        if (epubBookData && currentChapterIndex < epubBookData.chapters.length - 1) {
          const currentHref = epubBookData.chapters[currentChapterIndex].cleanHref;
          let nextIdx = currentChapterIndex + 1;
          while (nextIdx < epubBookData.chapters.length && epubBookData.chapters[nextIdx].cleanHref === currentHref) {
            nextIdx++;
          }
          if (nextIdx < epubBookData.chapters.length) {
            loadChapter(nextIdx, false, false, true, false, null, null, null, null, null, true);
          }
        }
      }
    }
  }, { passive: true });

  // 觸控手勢在最頂部/最底部時切換章節 (適用於移動端，附帶冷卻時間與水平滑動過濾)
  let touchStartY = 0;
  let touchStartX = 0;
  window.addEventListener('touchstart', (e) => {
    if (!document.getElementById('reader-view').classList.contains('view-active')) return;
    if (document.body.classList.contains('ai-active') || document.body.classList.contains('sidebar-active')) return;
    if (!currentBook || currentBook.format === 'cbz') return;
    if (document.body.classList.contains('layout-paginated')) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (!document.getElementById('reader-view').classList.contains('view-active')) return;
    if (document.body.classList.contains('ai-active') || document.body.classList.contains('sidebar-active')) return;
    if (!currentBook || currentBook.format === 'cbz') return;
    if (document.body.classList.contains('layout-paginated')) return;
    if (isChangingChapter) return;
    if (Date.now() - lastChapterChangeTime < 800) return;

    const touchEndY = e.changedTouches[0].clientY;
    const touchEndX = e.changedTouches[0].clientX;
    const diffY = touchEndY - touchStartY;
    const diffX = touchEndX - touchStartX;

    // 如果水平滑動幅度大於垂直滑動，視為水平操作（如側滑選單或翻頁手勢），不觸發垂直過渡
    if (Math.abs(diffX) > Math.abs(diffY)) return;

    const scrollTop = window.scrollY;
    if (scrollTop <= 5 && diffY > 60) {
      // 在最頂部向下拉（加載上一章物理文件）
      if (currentChapterIndex > 0) {
        const currentHref = epubBookData.chapters[currentChapterIndex].cleanHref;
        let prevIdx = currentChapterIndex - 1;
        while (prevIdx >= 0 && epubBookData.chapters[prevIdx].cleanHref === currentHref) {
          prevIdx--;
        }
        if (prevIdx >= 0) {
          loadChapter(prevIdx, true, false, true, false, null, null, null, null, null, true);
        }
      }
    } else {
      const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
      const clientHeight = window.innerHeight;
      if (scrollTop + clientHeight >= scrollHeight - 5 && diffY < -60) {
        // 在最底部向上拉（加載下一章物理文件）
        if (epubBookData && currentChapterIndex < epubBookData.chapters.length - 1) {
          const currentHref = epubBookData.chapters[currentChapterIndex].cleanHref;
          let nextIdx = currentChapterIndex + 1;
          while (nextIdx < epubBookData.chapters.length && epubBookData.chapters[nextIdx].cleanHref === currentHref) {
            nextIdx++;
          }
          if (nextIdx < epubBookData.chapters.length) {
            loadChapter(nextIdx, false, false, true, false, null, null, null, null, null, true);
          }
        }
      }
    }
  }, { passive: true });

  // 頁面生命週期變更時強制保存
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveReadingTime();
      saveTTSProgressImmediately();
      forceSaveCurrentProgress();
    } else {
      // 返回頁面時重置計時起點，防止將後台掛起時間計入
      lastReadingHeartbeat = Date.now();
      lastUserActivityTime = Date.now();
    }
  });
  window.addEventListener('beforeunload', () => {
    saveReadingTime();
    saveTTSProgressImmediately();
    forceSaveCurrentProgress();
  });

  tts.onPlaybackEnd = async () => {
    updatePlayPauseButtonIcon();
    // 自動播放下一章節/頁面
    if (currentBook) {
      if (epubBookData && currentChapterIndex < epubBookData.chapters.length - 1) {
        const nextIdx = currentChapterIndex + 1;
        const currentChapter = epubBookData.chapters[currentChapterIndex];
        const nextChapter = epubBookData.chapters[nextIdx];
        // 如果下一章與當前章節共享相同 cleanHref（子章節），僅更新章節索引而不重載
        if (currentChapter && nextChapter && currentChapter.cleanHref === nextChapter.cleanHref) {
          currentChapterIndex = nextIdx;
          tts.currentChapterIndex = nextIdx;
          syncTOCActiveState(nextIdx);
          updateReaderTitle();
          tts.play(0);
        } else {
          await loadChapter(nextIdx);
          tts.play(0);
        }
        updatePlayPauseButtonIcon();
      }
    }
  };
}


// ==================== 2. 書庫管理與導入 ==================== */

// 計算檔案 Hash 值 (為保證大檔案效能，採用「大小+頭尾分塊」的 SHA-256，並在非安全內容下提供 fallback)
async function computeFileHash(file) {
  const size = file.size;
  const name = file.name;
  const lastModified = file.lastModified || 0;
  
  // 如果 Web Crypto API 不可用 (例如在某些瀏覽器中的 file:/// 協議下)
  if (!window.crypto || !window.crypto.subtle) {
    console.warn('[computeFileHash] crypto.subtle is not available. Falling back to metadata-based hash.');
    const rawString = `${name}_${size}_${lastModified}`;
    let hash = 0;
    for (let i = 0; i < rawString.length; i++) {
      hash = (hash << 5) - hash + rawString.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    return 'fallback_' + Math.abs(hash).toString(16);
  }
  
  const chunkLimit = 128 * 1024; // 128KB
  
  let bufferToHash;
  if (size <= chunkLimit * 2) {
    bufferToHash = await file.arrayBuffer();
  } else {
    const firstBlob = file.slice(0, chunkLimit);
    const lastBlob = file.slice(size - chunkLimit, size);
    
    const [firstBuf, lastBuf] = await Promise.all([
      firstBlob.arrayBuffer(),
      lastBlob.arrayBuffer()
    ]);
    
    const combined = new Uint8Array(8 + firstBuf.byteLength + lastBuf.byteLength);
    const view = new DataView(combined.buffer);
    view.setFloat64(0, size);
    
    combined.set(new Uint8Array(firstBuf), 8);
    combined.set(new Uint8Array(lastBuf), 8 + firstBuf.byteLength);
    
    bufferToHash = combined.buffer;
  }
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', bufferToHash);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 處理選擇檔案
function handleFileSelect(e) {
  if (e.target.files.length > 0) {
    handleImportFiles(e.target.files);
  }
}

// 顯示重複導入確認對話框，返回 { action, applyAll }
function showDuplicateDialog(incomingBook, existingBook, isHashMatch) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('duplicate-dialog');
    
    // 獲取 UI 元素
    const descEl = document.getElementById('duplicate-dialog-desc');
    const newNameEl = document.getElementById('duplicate-new-name');
    const newMetaEl = document.getElementById('duplicate-new-meta');
    const existingNameEl = document.getElementById('duplicate-existing-name');
    const existingMetaEl = document.getElementById('duplicate-existing-meta');
    const checkboxAll = document.getElementById('duplicate-apply-all-checkbox');
    
    const btnReplace = document.getElementById('duplicate-replace-btn');
    const btnKeepBoth = document.getElementById('duplicate-keep-both-btn');
    const btnSkip = document.getElementById('duplicate-skip-btn');
    
    // 重設狀態
    checkboxAll.checked = false;
    
    // 設定文字說明與元數據
    if (isHashMatch) {
      descEl.textContent = getMsg('duplicate_desc_hash');
    } else {
      descEl.textContent = getMsg('duplicate_desc_name');
    }
    
    // 新增/待導入書籍的資訊
    newNameEl.textContent = `${incomingBook.title} (${incomingBook.format.toUpperCase()})`;
    newMetaEl.textContent = `${getMsg('author_title') || 'Author'}: ${incomingBook.author} | Size: ${(incomingBook.size / 1024 / 1024).toFixed(2)} MB`;
    
    // 書庫中已存在書籍的資訊
    existingNameEl.textContent = `${existingBook.title} (${existingBook.format.toUpperCase()})`;
    existingMetaEl.textContent = `${getMsg('author_title') || 'Author'}: ${existingBook.author} | Size: ${(existingBook.size / 1024 / 1024).toFixed(2)} MB`;
    
    // 綁定點擊事件
    function cleanup() {
      btnReplace.removeEventListener('click', onReplace);
      btnKeepBoth.removeEventListener('click', onKeepBoth);
      btnSkip.removeEventListener('click', onSkip);
      dialog.close();
    }
    
    function onReplace() {
      cleanup();
      resolve({ action: 'replace', applyAll: checkboxAll.checked });
    }
    
    function onKeepBoth() {
      cleanup();
      resolve({ action: 'keep_both', applyAll: checkboxAll.checked });
    }
    
    function onSkip() {
      cleanup();
      resolve({ action: 'skip', applyAll: checkboxAll.checked });
    }
    
    btnReplace.addEventListener('click', onReplace);
    btnKeepBoth.addEventListener('click', onKeepBoth);
    btnSkip.addEventListener('click', onSkip);
    
    // ESC 或其它關閉操作預設為 skip
    dialog.oncancel = (e) => {
      e.preventDefault();
      cleanup();
      resolve({ action: 'skip', applyAll: false });
    };
    
    // 國際化靜態文字手動初始化（以防 chrome.i18n 沒有翻譯完畢）
    const titleEl = dialog.querySelector('h3[data-i18n="duplicate_dialog_title"]');
    if (titleEl) titleEl.textContent = getMsg('duplicate_dialog_title');
    
    const lblNew = dialog.querySelector('div[data-i18n="duplicate_new_file"]');
    if (lblNew) lblNew.textContent = getMsg('duplicate_new_file');
    
    const lblEx = dialog.querySelector('div[data-i18n="duplicate_existing_book"]');
    if (lblEx) lblEx.textContent = getMsg('duplicate_existing_book');
    
    const lblAll = dialog.querySelector('span[data-i18n="duplicate_apply_all"]');
    if (lblAll) lblAll.textContent = getMsg('duplicate_apply_all');
    
    btnReplace.textContent = getMsg('duplicate_btn_replace');
    btnKeepBoth.textContent = getMsg('duplicate_btn_keep_both');
    btnSkip.textContent = getMsg('duplicate_btn_skip');
    
    dialog.showModal();
  });
}

// 導入書籍
async function handleImportFiles(files) {
  let duplicateActionAll = null; // 用於「套用到所有剩餘衝突」的全局變量

  // 1. 獲取所有現有書籍
  let existingBooks = await library.getAllBooks();

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
      let language = '';
      
      const format = ext.replace('.', '');
      
      // 解析元數據
      if (format === 'epub') {
        const parser = new EpubParser(file);
        const res = await parser.parse();
        title = res.metadata.title || title;
        author = res.metadata.author || author;
        cover = res.metadata.cover || '';
        language = res.metadata.language || '';
      } else if (format === 'azw3' || format === 'mobi') {
        const parser = new Azw3Parser(file);
        const res = await parser.parse();
        title = res.metadata.title || title;
        author = res.metadata.author || author;
        cover = res.metadata.cover || '';
        language = res.metadata.language || '';
      } else {
        if (format === 'cbz') {
          const parser = new ComicParser(file);
          const res = await parser.parse();
          title = res.metadata.title || title;
          author = res.metadata.author || author;
          cover = res.metadata.cover || '';
          language = res.metadata.language || '';
        } else {
          const parser = new TextParser(file, format);
          const res = await parser.parse();
          title = res.metadata.title || title;
          author = res.metadata.author || author;
          cover = res.metadata.cover || '';
          language = res.metadata.language || '';
        }
      }

      // 2. 計算待導入檔案的 Hash 值
      const incomingHash = await computeFileHash(file);
      const incomingBookData = {
        title,
        author,
        language,
        format,
        file,
        cover,
        size: file.size,
        fileHash: incomingHash
      };

      // 3. 校驗重複性
      let duplicateBook = null;
      let isHashMatch = false;

      // 優先精確比對 Hash
      for (const ex of existingBooks) {
        if (ex.fileHash) {
          if (ex.fileHash === incomingHash) {
            duplicateBook = ex;
            isHashMatch = true;
            break;
          }
        } else {
          // 如果沒有 Hash，但大小完全一致，動態計算舊書的 Hash 並存儲，以防後續誤判
          if (ex.size === file.size) {
            try {
              console.log(`[handleImportFiles] Dynamically computing hash for existing book "${ex.title}" due to size match.`);
              ex.fileHash = await computeFileHash(ex.file);
              await library.updateBook(ex); // 寫回資料庫
              if (ex.fileHash === incomingHash) {
                duplicateBook = ex;
                isHashMatch = true;
                break;
              }
            } catch (hashErr) {
              console.warn(`[handleImportFiles] Failed to compute hash for existing book "${ex.title}":`, hashErr);
            }
          }
        }
      }

      // 如果未比對到 Hash，再比對標題 (不分大小寫與空白)
      if (!duplicateBook) {
        const normalizedIncomingTitle = title.trim().toLowerCase();
        for (const ex of existingBooks) {
          const normalizedExistingTitle = (ex.title || '').trim().toLowerCase();
          if (normalizedExistingTitle === normalizedIncomingTitle) {
            duplicateBook = ex;
            isHashMatch = false;
            break;
          }
        }
      }

      // 4. 重複項處理
      let action = 'import'; // 默認直接導入
      if (duplicateBook) {
        if (duplicateActionAll) {
          action = duplicateActionAll;
        } else {
          // 彈出對話框讓用戶選擇
          const result = await showDuplicateDialog(incomingBookData, duplicateBook, isHashMatch);
          action = result.action;
          if (result.applyAll) {
            duplicateActionAll = action;
          }
        }
      }

      // 5. 執行對應動作
      if (action === 'skip') {
        console.log(`[handleImportFiles] Skipped importing duplicate book: ${title}`);
        continue;
      } else if (action === 'replace') {
        console.log(`[handleImportFiles] Replacing existing book: ${duplicateBook.title}`);
        await library.replaceBookContent(duplicateBook.id, incomingBookData);
        // 更新記憶體中的 existingBooks 列表
        const idx = existingBooks.findIndex(ex => ex.id === duplicateBook.id);
        if (idx !== -1) {
          existingBooks[idx] = { ...existingBooks[idx], ...incomingBookData };
        }
      } else {
        // 'import' 或 'keep_both' (生成新 ID 直接寫入)
        console.log(`[handleImportFiles] Importing book: ${title} (Action: ${action})`);
        const newBook = await library.addBook(incomingBookData);
        existingBooks.push(newBook); // 同步加入記憶體緩存
      }

    } catch (err) {
      console.error('Import failed:', err);
      alert(`${getMsg('parse_failed')}: ${file.name}\n${err.message}`);
    }
  }

  // 渲染新書櫃
  await renderBookshelf();
}

// 渲染書櫃列表
async function renderBookshelf(searchQuery = '') {
  const shelf = document.getElementById('bookshelf-grid');
  const emptyState = document.getElementById('empty-library');
  shelf.innerHTML = '';
  
  // 清理舊的封面 Object URL，防記憶體洩漏
  clearCoverUrls();

  // 更新麵包屑與標題 UI 顯示
  const titleMain = document.getElementById('library-title-main');
  const breadcrumb = document.getElementById('library-breadcrumb');
  const breadcrumbCurrent = document.getElementById('breadcrumb-current-folder');

  // 如果正在搜尋，不展示資料夾與麵包屑，直接顯示所有匹配書籍
  const isSearching = searchQuery.trim() !== '';

  if (currentFolder && !isSearching) {
    if (titleMain) titleMain.style.display = 'none';
    if (breadcrumb) {
      breadcrumb.style.display = 'flex';
      if (breadcrumbCurrent) breadcrumbCurrent.textContent = currentFolder;
    }
  } else {
    if (titleMain) titleMain.style.display = 'block';
    if (breadcrumb) breadcrumb.style.display = 'none';
  }

  const books = await library.getAllBooks();
  
  // 1. 計算每個資料夾內書籍的個數以及最近打開/添加時間
  const folderCounts = {};
  const folderMaxRead = {};
  const folderMaxAdded = {};

  books.forEach(b => {
    if (b.folder) {
      folderCounts[b.folder] = (folderCounts[b.folder] || 0) + 1;
      
      const lastRead = b.lastReadAt || 0;
      const added = b.addedAt || 0;
      
      if (!folderMaxRead[b.folder] || lastRead > folderMaxRead[b.folder]) {
        folderMaxRead[b.folder] = lastRead;
      }
      if (!folderMaxAdded[b.folder] || added > folderMaxAdded[b.folder]) {
        folderMaxAdded[b.folder] = added;
      }
    }
  });

  // 2. 獲取所有有效的自定義與包含書籍的資料夾，並按最近閱讀/添加時間排序
  const customFolders = getCustomFolders();
  const activeFolders = Array.from(new Set([...customFolders, ...Object.keys(folderCounts)]));
  
  activeFolders.sort((a, b) => {
    const readA = folderMaxRead[a] || 0;
    const readB = folderMaxRead[b] || 0;
    if (readB !== readA) {
      return readB - readA;
    }
    const addedA = folderMaxAdded[a] || 0;
    const addedB = folderMaxAdded[b] || 0;
    if (addedB !== addedA) {
      return addedB - addedA;
    }
    return a.localeCompare(b);
  });

  // 3. 依照搜尋條件和當前資料夾篩選書籍
  const filteredBooks = books.filter(b => {
    if (isSearching) {
      const q = searchQuery.toLowerCase();
      return b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q);
    } else {
      if (currentFolder) {
        return b.folder === currentFolder;
      } else {
        return !b.folder; // 根目錄僅展示未分類書籍
      }
    }
  });

  // 4. 建立混合的展示項目列表 (在根目錄且非搜尋狀態下混合資料夾與未分類書籍)
  const displayItems = [];
  if (!currentFolder && !isSearching) {
    activeFolders.forEach(folderName => {
      displayItems.push({
        type: 'folder',
        name: folderName,
        lastReadAt: folderMaxRead[folderName] || 0,
        addedAt: folderMaxAdded[folderName] || 0
      });
    });
    filteredBooks.forEach(book => {
      displayItems.push({
        type: 'book',
        data: book,
        lastReadAt: book.lastReadAt || 0,
        addedAt: book.addedAt || 0
      });
    });

    // 混合排序：按最後打開時間降序，再按添加時間降序
    displayItems.sort((a, b) => {
      if (b.lastReadAt !== a.lastReadAt) {
        return b.lastReadAt - a.lastReadAt;
      }
      if (b.addedAt !== a.addedAt) {
        return b.addedAt - a.addedAt;
      }
      const nameA = a.type === 'folder' ? a.name : a.data.title;
      const nameB = b.type === 'folder' ? b.name : b.data.title;
      return nameA.localeCompare(nameB);
    });
  } else {
    // 子目錄或搜尋狀態：僅展示篩選後的書籍
    filteredBooks.forEach(book => {
      displayItems.push({
        type: 'book',
        data: book,
        lastReadAt: book.lastReadAt || 0,
        addedAt: book.addedAt || 0
      });
    });
  }

  if (displayItems.length === 0 && (!currentFolder || isSearching)) {
    // 根目錄無內容或搜尋無內容
    if (shelf.children.length === 0) {
      emptyState.style.display = 'flex';
      shelf.style.display = 'none';
      return;
    }
  }

  emptyState.style.display = 'none';
  shelf.style.display = 'grid';

  displayItems.forEach(item => {
    if (item.type === 'folder') {
      const folderName = item.name;
      const folderCard = document.createElement('div');
      folderCard.className = 'folder-card';
      folderCard.setAttribute('data-folder-name', folderName);
      
      // 設置為拖曳釋放目標
      folderCard.addEventListener('dragover', (e) => {
        e.preventDefault();
        folderCard.classList.add('drag-over');
      });
      folderCard.addEventListener('dragleave', () => {
        folderCard.classList.remove('drag-over');
      });
      folderCard.addEventListener('drop', async (e) => {
        e.preventDefault();
        folderCard.classList.remove('drag-over');
        const bookId = e.dataTransfer.getData('text/plain');
        if (bookId) {
          await library.updateBookFolder(bookId, folderName);
          await renderBookshelf();
        }
      });

      const count = folderCounts[folderName] || 0;
      const folderBooks = books.filter(b => b.folder === folderName);
      
      const percentSum = folderBooks.reduce((sum, b) => sum + (b.progress?.percent || 0), 0);
      const avgPercent = folderBooks.length > 0 ? Math.round(percentSum / folderBooks.length) : 0;
      const booksCountText = getMsg('folder_books_count', [count]) || `${count} books`;
      
      let coverGridHtml = '';
      if (folderBooks.length > 0) {
        const topBooks = folderBooks.slice(0, 4);
        coverGridHtml = `<div class="folder-covers-grid">`;
        for (let i = 0; i < 4; i++) {
          if (i < topBooks.length) {
            const book = topBooks[i];
            let bookCoverUrl = '';
            if (book.cover) {
              if (isBlobLike(book.cover)) {
                bookCoverUrl = URL.createObjectURL(book.cover);
                activeCoverUrls.push(bookCoverUrl);
              } else if (typeof book.cover === 'string') {
                bookCoverUrl = book.cover;
              }
            }
            if (bookCoverUrl) {
              coverGridHtml += `<img class="folder-cover-item" src="${bookCoverUrl}" alt="${book.title}">`;
            } else {
              coverGridHtml += `
                <div class="folder-cover-placeholder">
                  <span>${book.format.toUpperCase()}</span>
                </div>
              `;
            }
          } else {
            coverGridHtml += `<div class="folder-cover-placeholder empty-cell"></div>`;
          }
        }
        coverGridHtml += `</div>`;
      } else {
        coverGridHtml = `
          <svg class="folder-icon-large" viewBox="0 0 24 24">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        `;
      }
      
      folderCard.innerHTML = `
        <button class="folder-action-btn folder-rename-btn" title="${getMsg('rename_folder') || '重命名'}">
          <svg class="svg-icon svg-icon-sm" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
        </button>
        <button class="folder-action-btn folder-delete-btn" title="${getMsg('delete_book_title') || '刪除'}">
          <svg class="svg-icon svg-icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
        <div class="folder-icon-container">
          ${coverGridHtml}
          <span class="folder-count-badge">${count}</span>
        </div>
        <div class="folder-info">
          <h3 class="folder-title" title="${folderName}">${folderName}</h3>
          <p class="folder-books-count">${booksCountText}</p>
          <div class="book-progress-wrapper">
            <div class="book-progress-info">
              <span>${getMsg('reading_progress', [avgPercent])}</span>
            </div>
            <div class="book-progress-bar">
              <div class="book-progress-fill" style="width: ${avgPercent}%;"></div>
            </div>
          </div>
        </div>
      `;

      // 點擊進入資料夾
      folderCard.addEventListener('click', async (e) => {
        if (e.target.closest('.folder-action-btn')) return;
        currentFolder = folderName;
        await renderBookshelf();
      });

      // 重命名事件
      folderCard.querySelector('.folder-rename-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openFolderDialog(folderName);
      });

      // 刪除事件
      folderCard.querySelector('.folder-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFolder(folderName);
      });

      shelf.appendChild(folderCard);
    } else if (item.type === 'book') {
      const book = item.data;
      const card = document.createElement('div');
      card.className = 'book-card';
      card.setAttribute('data-id', book.id);
      if (isSelectMode && selectedBookIds.has(book.id)) {
        card.classList.add('selected');
      }
      
      // 計算進度
      const percent = Math.round(book.progress?.percent || 0);
      const bookTotalTime = Object.values(book.stats?.readingDays || {}).reduce((s, v) => s + v, 0);

      card.innerHTML = `
        <div class="book-card-checkbox-overlay">
          <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </div>
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
              <span class="book-time-badge">${formatDuration(bookTotalTime)}</span>
            </div>
            <div class="book-progress-bar">
              <div class="book-progress-fill" style="width: ${percent}%;"></div>
            </div>
          </div>
        </div>
      `;

      // 拖曳事件綁定
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', (e) => {
        if (isSelectMode) {
          e.preventDefault();
          return;
        }
        card.classList.add('dragging');
        e.dataTransfer.setData('text/plain', book.id);
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
      });

      // 動態加載封面
      const coverContainer = card.querySelector('.book-cover-container');
      let coverUrl = '';
      if (book.cover) {
        if (isBlobLike(book.cover)) {
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

      // 動態綁定刪除事件
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

      // 點擊事件：多選模式下為選中切換，正常模式下打開書籍
      card.addEventListener('click', () => {
        if (isSelectMode) {
          toggleBookSelection(book.id, card);
        } else {
          openBook(book.id);
        }
      });
      
      shelf.appendChild(card);
    }
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
    const isUserActive = isReadingTimeActive(now);

    if (isUserActive) {
      // 限制每次 tick 最多計入 15 秒，防止主線程阻塞後一次性累計過多時間
      const elapsedSeconds = Math.min(Math.round((now - lastReadingHeartbeat) / 1000), 15);
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
    const isUserActive = isReadingTimeActive(now);
    if (isUserActive) {
      const elapsedSeconds = Math.min(Math.round((now - lastReadingHeartbeat) / 1000), 15);
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

function isReadingTimeActive(now = Date.now()) {
  const isVisibleReading = document.visibilityState === 'visible' && (now - lastUserActivityTime < IDLE_TIMEOUT_MS);
  const isTTSReading = tts && tts.isPlaying;
  return isVisibleReading || isTTSReading;
}


// ==================== 3. 閱讀器渲染與控制 ==================== */

// 打開書籍
async function openBook(id) {
  const readerView = document.getElementById('reader-view');
  if (openingBookId || (currentBook && currentBook.id === id && readerView && readerView.classList.contains('view-active'))) {
    return;
  }
  openingBookId = id;
  const requestId = ++openBookRequestId;
  const book = await library.getBook(id);
  if (!book || requestId !== openBookRequestId) {
    openingBookId = null;
    return;
  }

  // Push state to prevent back gesture from leaving the reader app
  if (!history.state || history.state.bookId !== id) {
    history.pushState({ bookId: id }, '');
  }

  // 清理舊的資源 Object URL 與預載快取
  clearResourceUrls();
  // 記憶體轉換：如果 book.file 是 Blob 但不是 File（即缺少 name 屬性），在記憶體中將其包裝為 File 物件，以供解析器使用（不寫回資料庫，防止 Safari IndexedDB 儲存 File 物件的失效 Bug）
  if (book.file && typeof File !== 'undefined' && !(book.file instanceof File)) {
    console.log('[openBook] Wrapping plain Blob file to File object in memory for book:', book.title);
    const fileName = book.title ? `${book.title}.${book.format}` : `${book.id}.${book.format}`;
    book.file = new File([book.file], fileName, { type: book.file.type });
  }

  currentBook = book;
  // 優先使用 TTS 朗讀章節位置（如果比視覺進度更新），確保重新打開書籍時定位到最近朗讀的位置
  const visualChapter = book.progress?.chapterIndex || 0;
  const ttsChapter = book.progress?.ttsChapterIndex;
  if (ttsChapter !== undefined && ttsChapter !== null && book.progress?.ttsActiveSentenceIndex !== undefined) {
    // TTS 有保存位置，使用 TTS 章節
    currentChapterIndex = ttsChapter;
  } else {
    currentChapterIndex = visualChapter;
  }

  // 1. 初始化界面 UI 顯示
  document.getElementById('library-view').classList.remove('view-active');
  document.getElementById('reader-view').classList.add('view-active');
  document.getElementById('reader-book-title').textContent = book.title;
  
  // 重置隱藏浮動面板，避免上一次閱讀時殘留顯示
  document.getElementById('selection-menu').style.display = 'none';
  document.getElementById('note-dialog').style.display = 'none';
  document.getElementById('ai-panel').style.display = 'none';
  
  // 關閉側邊欄並重置為目錄標籤，清理內容防止殘留上一本書的內容
  const sidebar = document.getElementById('reader-sidebar');
  if (sidebar) {
    sidebar.classList.remove('active');
    
    const tabToc = document.getElementById('tab-toc');
    const tabHighlights = document.getElementById('tab-highlights');
    const containerToc = document.getElementById('sidebar-toc-container');
    const containerHighlights = document.getElementById('sidebar-highlights-container');
    
    if (tabToc) tabToc.classList.add('active');
    if (tabHighlights) tabHighlights.classList.remove('active');
    if (containerToc) containerToc.classList.add('active');
    if (containerHighlights) containerHighlights.classList.remove('active');
  }
  
  const tocList = document.getElementById('toc-list');
  const bList = document.getElementById('bookmarks-list');
  const nList = document.getElementById('notes-list');
  if (tocList) tocList.innerHTML = '';
  if (bList) bList.innerHTML = '';
  if (nList) nList.innerHTML = '';

  updateHeaderActiveStates();
  renderAIChatHistory();

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
      if (requestId !== openBookRequestId) return;
      epubBookData.parser = parser; // 保存解析器實例以進行動態 URL 的清理
      epubBookData.chapters = await mergeShortChapters(epubBookData.chapters);
      renderTOC(epubBookData.chapters);
      await loadChapter(currentChapterIndex, false, true);
    } else if (book.format === 'azw3' || book.format === 'mobi') {
      const parser = new Azw3Parser(book.file);
      const res = await parser.parse();
      if (requestId !== openBookRequestId) return;
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
      if (requestId !== openBookRequestId) return;
      // 漫畫沒有 TOC 側邊欄，直接渲染圖片
      await loadComicPage(currentBook.progress?.comicImageIndex || 0);
    } else {
      // TXT, Markdown, FB2
      const parser = new TextParser(book.file, book.format);
      const res = await parser.parse();
      if (requestId !== openBookRequestId) return;
      res.chapters = await mergeShortChapters(res.chapters);
      epubBookData = res;
      renderTOC(res.chapters);
      await loadChapter(currentChapterIndex, false, true);
    }

    // 初始化 TTS 面板
    initTTSPanelVoices(book.file?.name || book.title || '', true);
    
    // 延遲 re-check：在移動端 iOS 上，tts.sentences 可能在首次檢測時尚未準備好（WebSpeech 異步加載）
    // 500ms 後重新確認語言檢測結果，若需要則更新
    const cachedLangAtOpen = currentBookDetectedLanguage;
    setTimeout(() => {
      if (currentBook && currentBook.id === book.id) {
        const recheckLang = detectBookLanguage(book.file?.name || book.title || '');
        if (recheckLang !== cachedLangAtOpen) {
          console.log(`[TTS] Delayed recheck: language changed from "${cachedLangAtOpen}" to "${recheckLang}"`);
          currentBookDetectedLanguage = recheckLang;
          initTTSPanelVoices(book.file?.name || book.title || '', true);
        }
      }
    }, 500);
    
    // 載入高亮標記
    applySavedHighlightsToDOM();
    
    // 預先渲染書籤與筆記列表，防止切換書籍時殘留舊書記錄
    await renderHighlightsList();

    // 啟動閱讀時間追蹤
    startReadingTracker(book.id);

    // 異步在背景建立全文檢索索引
    buildBookSearchIndex();
  } catch (err) {
    if (requestId === openBookRequestId) {
      console.error('Failed to parse book:', err);
      clearResourceUrls();
      contentEl.innerHTML = `<p style="color:red; padding:40px; text-align:center;">${getMsg('failed_load_book')}: ${err.message}</p>`;
    }
  } finally {
    if (openingBookId === id) openingBookId = null;
  }
}

// 關閉閱讀器，返回書櫃
async function closeCurrentBook(triggerBack = true) {
  openBookRequestId++;
  openingBookId = null;
  // 重置章節切換狀態與滾動锁定，防止關閉書本時因異常殘留導致書架或下次打開時無法滾動
  isChangingChapter = false;
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';

  // 1. 停止 TTS 播放
  tts.stop();

  // 2. 停止閱讀計時並立即保存最後剩餘的時長
  await saveReadingTime();
  stopReadingTracker();

  // 3. 強制保存進度
  await forceSaveCurrentProgress();

  // 清理舊的資源 Object URL
  clearResourceUrls();

  // 清理書本內容 (避免 CSS 洩漏影響書庫樣式)
  const contentEl = document.getElementById('book-content');
  if (contentEl) {
    contentEl.innerHTML = '';
  }

  // 3. 切換視圖
  window.scrollTo(0, 0);
  document.getElementById('reader-view').classList.remove('view-active');
  document.getElementById('library-view').classList.add('view-active');
  
  // 隱藏所有選取選單與對話框，防止關閉書本後殘留或下次打開時重疊
  document.getElementById('selection-menu').style.display = 'none';
  document.getElementById('note-dialog').style.display = 'none';
  document.getElementById('ai-panel').style.display = 'none';
  
  // 關閉側邊欄並重置為目錄標籤，清理 DOM 防止殘留內容
  const sidebar = document.getElementById('reader-sidebar');
  if (sidebar) {
    sidebar.classList.remove('active');
    
    const tabToc = document.getElementById('tab-toc');
    const tabHighlights = document.getElementById('tab-highlights');
    const tabSearch = document.getElementById('tab-search');
    const containerToc = document.getElementById('sidebar-toc-container');
    const containerHighlights = document.getElementById('sidebar-highlights-container');
    const containerSearch = document.getElementById('sidebar-search-container');
    
    if (tabToc) tabToc.classList.add('active');
    if (tabHighlights) tabHighlights.classList.remove('active');
    if (tabSearch) tabSearch.classList.remove('active');
    if (containerToc) containerToc.classList.add('active');
    if (containerHighlights) containerHighlights.classList.remove('active');
    if (containerSearch) containerSearch.classList.remove('active');
  }

  currentSearchQuery = '';
  clearSearchHighlights();
  const searchInput = document.getElementById('sidebar-search-input');
  if (searchInput) searchInput.value = '';
  const searchList = document.getElementById('search-results-list');
  if (searchList) searchList.innerHTML = '';
  const searchInfo = document.getElementById('sidebar-search-results-info');
  if (searchInfo) searchInfo.style.display = 'none';
  
  const tocList = document.getElementById('toc-list');
  const bList = document.getElementById('bookmarks-list');
  const nList = document.getElementById('notes-list');
  if (tocList) tocList.innerHTML = '';
  if (bList) bList.innerHTML = '';
  if (nList) nList.innerHTML = '';

  bookChunksCache = [];
  chapterTextsCache = [];
  isIndexingBook = false;
  updateHeaderActiveStates();
  
  // 觸發強制重繪/Reflow，防止瀏覽器因隱藏切換導致的 Flex 佈局高度崩塌/拉伸 Bug
  const appHeader = document.querySelector('.app-header');
  if (appHeader) {
    appHeader.style.display = 'none';
    appHeader.offsetHeight; // 讀取以觸發 reflow
    appHeader.style.display = '';
  }
  
  // 重置變量與樣式類別
  document.body.classList.remove('format-epub', 'format-azw3', 'format-mobi', 'format-txt', 'format-cbz', 'layout-paginated');
  currentBook = null;
  epubBookData = null;
  comicParserInstance = null;
  prefetchedChapterCache = null;
  currentBookDetectedLanguage = ''; // 清除語言緩存

  // 重新渲染書櫃
  await renderBookshelf();

  // If programmatic close, pop state to match browser history
  if (triggerBack && history.state && history.state.bookId) {
    history.back();
  }
}

// 渲染目錄
// 更新目錄的可見性（基於折疊狀態）
function updateTOCListVisibility() {
  const tocList = document.getElementById('toc-list');
  if (!tocList || !epubBookData || !epubBookData.chapters) return;
  const items = Array.from(tocList.querySelectorAll('.toc-item'));
  let hideBelowDepth = 999;
  
  items.forEach(itemLi => {
    const itemIdx = parseInt(itemLi.getAttribute('data-chapter-index'), 10);
    const chItem = epubBookData.chapters[itemIdx];
    const chDepth = chItem ? (chItem.depth || 0) : 0;
    
    if (chDepth >= hideBelowDepth) {
      itemLi.classList.add('collapsed-hidden');
    } else {
      itemLi.classList.remove('collapsed-hidden');
      hideBelowDepth = 999;
      if (itemLi.classList.contains('collapsed')) {
        hideBelowDepth = chDepth + 1;
      }
    }
  });
}

// 渲染目錄
function renderTOC(chapters) {
  const tocList = document.getElementById('toc-list');
  if (!tocList) return;
  tocList.innerHTML = '';
  
  chapters.forEach((ch, idx) => {
    if (ch.hiddenFromTOC) return;

    const li = document.createElement('li');
    li.className = 'toc-item';
    li.setAttribute('data-chapter-index', idx);
    
    // 建立文字容器
    const textSpan = document.createElement('span');
    textSpan.className = 'toc-text';
    textSpan.textContent = ch.title ? ch.title.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '') : '';
    
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
    const depth = ch.depth || 0;
    li.style.paddingLeft = (15 + depth * 15) + 'px';
    if (depth > 0) {
      li.classList.add('toc-sub-item');
    }
    
    // 判斷是否有子章節（下一個未隱藏章節的深度大於當前章節的深度）
    let hasChildren = false;
    let nextVisibleIdx = idx + 1;
    while (nextVisibleIdx < chapters.length && chapters[nextVisibleIdx].hiddenFromTOC) {
      nextVisibleIdx++;
    }
    if (nextVisibleIdx < chapters.length && (chapters[nextVisibleIdx].depth || 0) > depth) {
      hasChildren = true;
    }
    
    if (hasChildren) {
      const toggle = document.createElement('span');
      toggle.className = 'toc-toggle';
      toggle.innerHTML = '▼'; // 預設展開
      
      toggle.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止載入章節
        const isCollapsed = li.classList.toggle('collapsed');
        toggle.innerHTML = isCollapsed ? '▶' : '▼';
        updateTOCListVisibility();
      });
      li.appendChild(toggle);
    }
    
    li.appendChild(textSpan);
    
    li.addEventListener('click', () => {
      document.getElementById('reader-sidebar').classList.remove('active');
      updateHeaderActiveStates();
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

  const tocList = document.getElementById('toc-list');
  const tocItems = document.querySelectorAll('#toc-list .toc-item');
  
  // 自動展開當前選中章節的所有父級目錄，確保在折疊狀態下當前章節是可見的
  if (tocList && epubBookData && epubBookData.chapters && epubBookData.chapters[targetIndex]) {
    let currentDepth = epubBookData.chapters[targetIndex].depth || 0;
    let i = targetIndex - 1;
    let modified = false;
    
    while (i >= 0 && currentDepth > 0) {
      const ch = epubBookData.chapters[i];
      if (ch && !ch.hiddenFromTOC) {
        const depth = ch.depth || 0;
        if (depth < currentDepth) {
          const ancestorLi = tocList.querySelector(`.toc-item[data-chapter-index="${i}"]`);
          if (ancestorLi && ancestorLi.classList.contains('collapsed')) {
            ancestorLi.classList.remove('collapsed');
            const toggle = ancestorLi.querySelector('.toc-toggle');
            if (toggle) toggle.innerHTML = '▼';
            modified = true;
          }
          currentDepth = depth;
        }
      }
      i--;
    }
    
    if (modified) {
      updateTOCListVisibility();
    }
  }

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

// 在垂直滾動模式下，如果當前物理文件包含多個子章節，滾動時自動校準 currentChapterIndex
function updateActiveSubChapterOnScroll() {
  if (!epubBookData || !epubBookData.chapters || currentChapterIndex < 0) return;
  const currentChapter = epubBookData.chapters[currentChapterIndex];
  if (!currentChapter) return;

  const currentHref = currentChapter.cleanHref;
  // 找出所有物理文件相同的章節
  const siblingChapters = [];
  epubBookData.chapters.forEach((ch, idx) => {
    if (ch.cleanHref === currentHref) {
      siblingChapters.push({ chapter: ch, index: idx });
    }
  });

  if (siblingChapters.length <= 1) return;

  const contentEl = document.getElementById('book-content');
  if (!contentEl) return;

  let activeIdx = siblingChapters[0].index;
  let minTop = -Infinity; // 尋找在視口上方最近的元素

  siblingChapters.forEach(({ chapter, index }) => {
    if (!chapter.hash) {
      // 沒有 hash 的是整個物理文件的開頭
      const rect = contentEl.getBoundingClientRect();
      // 如果文件開頭在視口頂部上方，它是一個候選
      if (rect.top <= 80 && rect.top > minTop) {
        minTop = rect.top;
        activeIdx = index;
      }
      return;
    }

    const el = document.getElementById(chapter.hash) || contentEl.querySelector(`[name="${chapter.hash.replace(/"/g, '\\"')}"]`);
    if (el) {
      const rect = el.getBoundingClientRect();
      // 如果元素的 top 小於等於 80px（視口頂部附近），說明用戶已經滾過它或它在當前視口上方
      if (rect.top <= 80 && rect.top > minTop) {
        minTop = rect.top;
        activeIdx = index;
      }
    }
  });

  if (activeIdx !== currentChapterIndex && !isChangingChapter) {
    currentChapterIndex = activeIdx;
    tts.currentChapterIndex = activeIdx;
    syncTOCActiveState(activeIdx);
    updateReaderTitle();
  }
}

// 在左右翻頁模式下，如果當前物理文件包含多個子章節，翻頁時自動校準 currentChapterIndex
function updateActiveSubChapterOnPage() {
  if (!epubBookData || !epubBookData.chapters || currentChapterIndex < 0) return;
  const currentChapter = epubBookData.chapters[currentChapterIndex];
  if (!currentChapter) return;

  const currentHref = currentChapter.cleanHref;
  // 找出所有物理文件相同的章節
  const siblingChapters = [];
  epubBookData.chapters.forEach((ch, idx) => {
    if (ch.cleanHref === currentHref) {
      siblingChapters.push({ chapter: ch, index: idx });
    }
  });

  if (siblingChapters.length <= 1) return;

  const container = document.getElementById('reader-container');
  const contentEl = document.getElementById('book-content');
  if (!container || !contentEl) return;

  const containerRect = container.getBoundingClientRect();
  const paddingLeft = parseFloat(window.getComputedStyle(container).paddingLeft) || 0;
  const { containerWidth } = getPaginatedPagesInfo();
  
  // 視口右側邊界值 (在翻頁容器座標系中，即為可見區域的右邊界)
  const viewportRight = containerRect.left + paddingLeft + containerWidth;

  let activeIdx = siblingChapters[0].index;

  siblingChapters.forEach(({ chapter, index }) => {
    if (!chapter.hash) {
      // 沒有 hash 的是整個物理文件的開頭，自然在當前頁或之前
      return;
    }

    const el = document.getElementById(chapter.hash) || contentEl.querySelector(`[name="${chapter.hash.replace(/"/g, '\\"')}"]`);
    if (el) {
      const rect = el.getBoundingClientRect();
      // 如果元素的 left 小於視口右邊界減去一個微小的容差值 (e.g. 10px)，說明它已經出現在當前頁或更早的頁面中
      if (rect.left < viewportRight - 10) {
        activeIdx = index;
      }
    }
  });

  if (activeIdx !== currentChapterIndex && !isChangingChapter) {
    currentChapterIndex = activeIdx;
    tts.currentChapterIndex = activeIdx;
    syncTOCActiveState(activeIdx);
    updateReaderTitle();
  }
}

// 載入指定章節 (流式文本)
// 載入指定章節 (流式文本)
async function loadChapter(index, goToLastPage = false, restoreProgress = false, animate = true, isSeamless = false, targetPageIndex = null, targetElementIndex = null, targetSentenceIndex = null, targetHash = null, targetKindleOffset = null, ignoreChapterHash = false) {
  if (!epubBookData || index < 0 || index >= epubBookData.chapters.length) return;
  if (isChangingChapter) {
    console.warn("loadChapter ignored because a chapter change is already in progress.");
    return;
  }

  const isPaginated = document.body.classList.contains('layout-paginated');
  const origHtmlOverflow = document.documentElement.style.overflow;
  const origBodyOverflow = document.body.style.overflow;
  let activeHashElem = null;

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
  activeHashElem = null;
  
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
    } else if (restoreProgress && currentBook && currentBook.progress) {
      const savedTTSChapter = currentBook.progress.ttsChapterIndex;
      if (savedTTSChapter === finalIdx) {
        targetSentenceIdx = currentBook.progress.ttsActiveSentenceIndex || 0;
      } else if (savedTTSChapter !== undefined && savedTTSChapter !== null) {
        // 檢查是否為相同 cleanHref 的子章節
        const finalCleanHref = epubBookData && epubBookData.chapters[finalIdx] ? epubBookData.chapters[finalIdx].cleanHref : null;
        const savedCleanHref = epubBookData && epubBookData.chapters[savedTTSChapter] ? epubBookData.chapters[savedTTSChapter].cleanHref : null;
        if (finalCleanHref && savedCleanHref && finalCleanHref === savedCleanHref) {
          targetSentenceIdx = currentBook.progress.ttsActiveSentenceIndex || 0;
        }
      } else if (savedTTSChapter === undefined && currentBook.progress.chapterIndex === finalIdx) {
        targetSentenceIdx = currentBook.progress.activeSentenceIndex || 0;
      }
    }
    
    if (!isSeamless) {
      tts.currentIndex = Math.max(0, Math.min(targetSentenceIdx, tts.sentences.length - 1));
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
            loadChapter(targetIdx, false, false, true, false, null, null, null, hash || null, null, !hash);
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
    const finalHash = targetHash || ((chapter && !ignoreChapterHash) ? chapter.hash : null);
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
    } else if (goToLastPage) {
      if (document.body.classList.contains('layout-paginated')) {
        pendingGoToLastPage = true;
        currentPageIndex = getLastPageIndex();
        pendingGoToLastPageTimeout = setTimeout(() => {
          pendingGoToLastPage = false;
          pendingGoToLastPageTimeout = null;
        }, 1000);
        updatePageTranslate(false);
      } else {
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
      }
    } else if (activeHashElem) {
      // 點擊目錄子標題或章節錨點跳轉時，精確滾動/翻頁到該錨點元素
      safeRestoreScrollToElementIndex(activeHashElem);
    } else if (restoreProgress && currentBook.progress) {
      // 恢復閱讀位置：優先定位到 TTS 朗讀位置（句子級別），否則恢復視覺滾動位置
      const savedTTSChapter = currentBook.progress.ttsChapterIndex;
      const hasTTSPosition = savedTTSChapter !== undefined && savedTTSChapter !== null && currentBook.progress.ttsActiveSentenceIndex !== undefined;
      
      if (hasTTSPosition && (savedTTSChapter === index || (epubBookData && epubBookData.chapters[savedTTSChapter] && epubBookData.chapters[index] && epubBookData.chapters[savedTTSChapter].cleanHref === epubBookData.chapters[index].cleanHref))) {
        // 定位到 TTS 句子位置
        const ttsSentenceIdx = currentBook.progress.ttsActiveSentenceIndex || 0;
        const sentenceEl = document.querySelector(`[data-sentence-index="${ttsSentenceIdx}"]`);
        if (sentenceEl) {
          safeRestoreScrollToElementIndex(sentenceEl);
        } else if (currentBook.progress.chapterIndex === index) {
          const savedElementIdx = currentBook.progress.elementIndex || 0;
          safeRestoreScrollToElementIndex(savedElementIdx);
        } else {
          window.scrollTo(0, 0);
        }
      } else if (currentBook.progress.chapterIndex === index) {
        if (document.body.classList.contains('layout-paginated') && typeof currentBook.progress.currentPageIndex === 'number') {
          currentPageIndex = currentBook.progress.currentPageIndex;
          updatePageTranslate(false);
        } else {
          const savedElementIdx = currentBook.progress.elementIndex || 0;
          safeRestoreScrollToElementIndex(savedElementIdx);
        }
      } else {
        window.scrollTo(0, 0);
      }
    } else {
      if (document.body.classList.contains('layout-paginated')) {
        currentPageIndex = 0;
        updatePageTranslate(false);
      } else {
        window.scrollTo(0, 0);
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

// 獲取目前第一個可見句子的索引
function getFirstVisibleSentenceIndex() {
  if (!tts.sentences || tts.sentences.length === 0) return 0;
  
  const isPaginated = document.body.classList.contains('layout-paginated');
  if (isPaginated) {
    const { containerWidth, columnGap } = getPaginatedPagesInfo();
    const content = document.getElementById('book-content');
    if (content && containerWidth > 0) {
      const contentRect = content.getBoundingClientRect();
      const halfGap = columnGap > 0 ? columnGap / 2 : 5;
      for (let i = 0; i < tts.sentences.length; i++) {
        const sent = tts.sentences[i];
        if (sent.element) {
          const rect = sent.element.getBoundingClientRect();
          const relativeLeft = rect.left - contentRect.left;
          const pageIndex = Math.floor((relativeLeft + halfGap) / (containerWidth + columnGap));
          if (pageIndex === currentPageIndex) {
            return i;
          }
        }
      }
    }
  } else {
    for (let i = 0; i < tts.sentences.length; i++) {
      const sent = tts.sentences[i];
      if (sent.element) {
        const rect = sent.element.getBoundingClientRect();
        // 考慮到 Header 高度 80px
        if (rect.bottom > 80) {
          return i;
        }
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
    updateActiveSubChapterOnPage();
  } else {
    const isFlip = document.documentElement.classList.contains('transition-flip');
    const cols = content ? (parseInt(content.style.columnCount) || 1) : 1;
    
    if (isFlip && cols <= 2) {
      runCustom3DFlip(oldIndex, currentPageIndex);
      updateActiveSubChapterOnPage();
    } else {
      const direction = (currentPageIndex > oldIndex) ? 'forward' : 'backward';
      transitionPage(() => {
        content.style.transform = `translateX(-${offset}px)`;
        updatePageTextureTranslate();
        updateActiveSubChapterOnPage();
      }, direction);
    }
  }
  
  // 保存進度并計算精確百分比
  if (currentBook && !isTTSAutoPageTurning) {
    const percent = calculateCurrentProgressPercent();
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
        loadChapter(currentChapterIndex + 1, false, false, true, false, null, null, null, null, null, true);
      }
    }
  } else if (direction === 'prev') {
    if (currentPageIndex > 0) {
      currentPageIndex--;
      updatePageTranslate();
    } else {
      // 載入前一章的最後一頁
      if (currentChapterIndex > 0) {
        loadChapter(currentChapterIndex - 1, true, false, true, false, null, null, null, null, null, true);
      }
    }
  }
}

// 防抖保存進度
let saveTimeout = null;
function saveProgressDebounced(update) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      if (currentBook) {
        await library.updateProgress(currentBook.id, update);
        // 更新內存狀態
        currentBook.progress = { ...currentBook.progress, ...update };
      }
    } catch (e) {
      console.warn('[Progress] Debounced save failed:', e);
    }
  }, 1000);
}

// 立即保存 TTS 進度（無防抖，安全過渡校驗）
// 優先使用 currentlyPlayingIndex（實際正在播放的句子），而非 currentIndex（指向下一句的指標）
function saveTTSProgressImmediately() {
  if (currentBook) {
    let targetChapter = currentChapterIndex;
    // 優先使用「正在播放」的索引，避免 currentIndex 已指向下一句導致保存錯誤位置
    let targetSentence = tts.currentlyPlayingIndex >= 0 ? tts.currentlyPlayingIndex : tts.currentIndex;
    const maxIdx = tts.sentences.length > 0 ? tts.sentences.length - 1 : 0;
    
    if (tts.sentences.length === 0) return; // 沒有句子時不保存，避免覆蓋有效進度
    
    if (targetSentence >= tts.sentences.length) {
      // 溢位：代表當前章節已播完，保存最後一句的位置（而非嘗試跳到下一章）
      targetSentence = maxIdx;
    } else {
      targetSentence = Math.max(0, Math.min(targetSentence, maxIdx));
    }
    
    const sentence = tts.sentences[targetSentence];
    if (!sentence) return; // 防禦性檢查
    
    const relativeIdx = sentence.relativeIndex !== undefined ? sentence.relativeIndex : targetSentence;
    // 使用句子自身的 chapterIndex（精確到子章節），避免 currentChapterIndex 與實際播放位置不一致
    const sentenceChapter = sentence.chapterIndex !== undefined ? sentence.chapterIndex : targetChapter;
    
    const progressUpdate = {
      ttsActiveSentenceIndex: relativeIdx,
      ttsChapterIndex: sentenceChapter
    };
    
    library.updateProgress(currentBook.id, progressUpdate).catch(e => console.warn('[TTS] Immediate save failed:', e));
    currentBook.progress = { ...currentBook.progress, ...progressUpdate };
  }
}

// 頁面關閉時的強制立即保存
async function forceSaveCurrentProgress() {
  if (currentBook && !isSavingProgress) {
    // 取消待執行的防抖保存，防止之後觸發時用舊數據覆蓋本次強制保存
    if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
    
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
      
      // 優先使用「正在播放」的索引，避免 currentIndex 已指向下一句
      let targetSentence = tts.currentlyPlayingIndex >= 0 ? tts.currentlyPlayingIndex : tts.currentIndex;
      const maxIdx = tts.sentences.length > 0 ? tts.sentences.length - 1 : 0;
      
      if (tts.sentences.length > 0) {
        if (targetSentence >= tts.sentences.length) {
          targetSentence = maxIdx;
        } else {
          targetSentence = Math.max(0, Math.min(targetSentence, maxIdx));
        }
        
        const sentence = tts.sentences[targetSentence];
        if (sentence) {
          const relativeIdx = sentence.relativeIndex !== undefined ? sentence.relativeIndex : targetSentence;
          const sentenceChapter = sentence.chapterIndex !== undefined ? sentence.chapterIndex : currentChapterIndex;
          update.ttsActiveSentenceIndex = relativeIdx;
          update.ttsChapterIndex = sentenceChapter;
        }
      }
      
      if (document.body.classList.contains('layout-paginated')) {
        update.currentPageIndex = currentPageIndex;
      }
      update.percent = calculateCurrentProgressPercent();
    }
    
    await library.updateProgress(currentBook.id, update);
    isSavingProgress = false;
  }
}

// 計算目前閱讀位置在整本書的百分比
function calculateCurrentProgressPercent() {
  if (!currentBook) return 0;
  
  if (currentBook.format === 'cbz') {
    if (comicParserInstance && comicParserInstance.pages.length > 0) {
      const pageIdx = typeof currentBook.progress?.comicImageIndex === 'number' ? currentBook.progress.comicImageIndex : 0;
      const totalPages = comicParserInstance.pages.length;
      const percent = ((pageIdx + 1) / totalPages) * 100;
      return Math.max(0, Math.min(100, Math.round(percent)));
    }
    return 0;
  }
  
  if (epubBookData && epubBookData.chapters && epubBookData.chapters.length > 0) {
    const totalChapters = epubBookData.chapters.length;
    let progressFraction = 0;
    
    // 找出所有物理文件相同的章節（處理子章節/sibling）
    let siblingChapters = [];
    const currentChapter = epubBookData.chapters[currentChapterIndex];
    if (currentChapter) {
      const currentHref = currentChapter.cleanHref;
      epubBookData.chapters.forEach((ch, idx) => {
        if (ch.cleanHref === currentHref) {
          siblingChapters.push({ chapter: ch, index: idx });
        }
      });
    }
    
    const firstSiblingIndex = siblingChapters.length > 0 ? siblingChapters[0].index : Math.max(0, currentChapterIndex);
    const numSiblings = siblingChapters.length > 0 ? siblingChapters.length : 1;
    
    if (document.body.classList.contains('layout-paginated')) {
      const { totalPages } = getPaginatedPagesInfo();
      const pageFraction = currentPageIndex / Math.max(1, totalPages);
      progressFraction = (firstSiblingIndex + pageFraction * numSiblings) / totalChapters;
    } else {
      // 垂直滾動模式下的百分比計算
      let scrollFraction = 0;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      if (maxScroll > 0) {
        scrollFraction = window.scrollY / maxScroll;
      }
      progressFraction = (firstSiblingIndex + scrollFraction * numSiblings) / totalChapters;
    }
    
    return Math.max(0, Math.min(100, Math.round(progressFraction * 100)));
  }
  
  return 0;
}

// 動態調整標題文字，若超過兩行則進行中間省略，並在結尾保留百分比
function adjustTitleEllipsis(titleEl, mainText, percentText) {
  // 先設置為完整內容以測量
  titleEl.textContent = mainText + percentText;
  
  // 如果隱藏（高度為 0），則無法測量溢出，直接保留完整文字並返回
  if (titleEl.clientHeight === 0) {
    return;
  }
  
  // 如果沒有溢出，直接返回
  if (titleEl.scrollHeight <= titleEl.clientHeight) {
    return;
  }
  
  // 溢出時進行二分搜尋，尋找最長可容納的中間省略文字
  let left = 0;
  let right = Math.floor(mainText.length / 2);
  let bestText = mainText + percentText;
  
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const prefix = mainText.slice(0, mid);
    const suffix = mainText.slice(-mid);
    const candidate = prefix + '...' + suffix + percentText;
    
    titleEl.textContent = candidate;
    
    // 如果此長度不溢出
    if (titleEl.scrollHeight <= titleEl.clientHeight) {
      bestText = candidate;
      left = mid + 1; // 嘗試保留更多字元
    } else {
      right = mid - 1; // 需要移除更多字元
    }
  }
  
  titleEl.textContent = bestText;
}

function updateReaderTitle() {
  if (!currentBook) return;
  const titleEl = document.getElementById('reader-book-title');
  if (!titleEl) return;

  const percent = calculateCurrentProgressPercent();
  
  let mainText = currentBook.title;
  let percentText = ` (${percent}%)`;
  
  if (currentBook.format === 'cbz') {
    if (comicParserInstance && comicParserInstance.pages.length > 0) {
      const pageIdx = typeof currentBook.progress?.comicImageIndex === 'number' ? currentBook.progress.comicImageIndex : 0;
      mainText = `${currentBook.title} - Page ${pageIdx + 1} / ${comicParserInstance.pages.length}`;
    }
  } else {
    if (epubBookData && epubBookData.chapters && epubBookData.chapters.length > 0) {
      const chapter = epubBookData.chapters[currentChapterIndex];
      const chapterTitle = chapter && chapter.title ? chapter.title.trim() : '';
      
      if (chapterTitle) {
        mainText = `${currentBook.title} - ${chapterTitle}`;
      }
    }
  }
  
  adjustTitleEllipsis(titleEl, mainText, percentText);
}


// 檢測當前設備是否為移動端
function isMobileDevice() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  return isMobileUA || (isTouch && window.innerWidth <= 1024);
}

async function initAISettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['aiProfiles', 'activeAIProfileId', 'aiProvider', 'aiApiKey', 'aiEndpoint', 'aiModel', 'aiPromptsTemplates'], async (res) => {
      // 1. 载入并进行数据迁移
      if (res.aiProfiles && res.aiProfiles.length > 0) {
        aiProfilesList = res.aiProfiles;
        activeAIProfileId = res.activeAIProfileId || 'builtin';
      } else {
        // 没有多服务商配置，检查是否有旧的单一配置以进行迁移
        aiProfilesList = JSON.parse(JSON.stringify(DEFAULT_AI_PROFILES));
        if (res.aiProvider) {
          const migratedProfile = {
            id: 'migrated_custom',
            name: getMsg('ai_profile_migrated') || 'Migrated Profile',
            provider: res.aiProvider,
            apiKey: res.aiApiKey || '',
            endpoint: res.aiEndpoint || '',
            model: res.aiModel || '',
            isCustom: true
          };
          aiProfilesList.push(migratedProfile);
          activeAIProfileId = 'migrated_custom';
        } else {
          activeAIProfileId = 'builtin';
        }
      }

      // 2. 确保 activeAIProfileId 的配置是存在的，如果不存在则降级为 builtin
      let activeProfile = aiProfilesList.find(p => p.id === activeAIProfileId);
      if (!activeProfile) {
        activeProfile = aiProfilesList[0] || DEFAULT_AI_PROFILES[0];
        activeAIProfileId = activeProfile.id;
      }

      // 3. 配置 AI 引擎
      ai.configure({
        provider: activeProfile.provider,
        apiKey: activeProfile.apiKey,
        endpoint: activeProfile.endpoint,
        model: activeProfile.model
      });

      // 4. 初始化 UI 下拉选单与各项控制器
      renderAIProfileOptions();

      // 5. 载入当前 active profile 的值到输入框中
      loadActiveAIProfileToUI(activeProfile);

      // 6. 检测内置 AI 支持状态
      await ai.checkAvailability();

      // 7. 更新 AI 功能按钮可见度
      updateAIButtonsVisibility();

      // 8. 载入 AI 提示词模板
      if (res.aiPromptsTemplates && Array.isArray(res.aiPromptsTemplates)) {
        aiPromptsTemplatesList = res.aiPromptsTemplates;
        // 同步更新默认提示词：用最新的 locale 值覆盖对应的项目
        const latestDefaults = getAISuggestions();
        let needsSync = false;
        for (const defaultItem of latestDefaults) {
          const stored = aiPromptsTemplatesList.find(t => t.key === defaultItem.key);
          if (stored) {
            // 更新 label、prompt 并确保 isDefault 为 true
            if (stored.prompt !== defaultItem.prompt || stored.label !== defaultItem.label || !stored.isDefault) {
              stored.prompt = defaultItem.prompt;
              stored.label = defaultItem.label;
              stored.isDefault = true;
              needsSync = true;
            }
          } else {
            // 如果历史数据中缺失该默认提示词（如升级新增），则追加
            aiPromptsTemplatesList.push({
              key: defaultItem.key,
              icon: defaultItem.icon,
              label: defaultItem.label,
              prompt: defaultItem.prompt,
              isDefault: true
            });
            needsSync = true;
          }
        }
        if (needsSync) {
          chrome.storage.local.set({ aiPromptsTemplates: aiPromptsTemplatesList });
        }
      } else {
        // 首次加载，写入默认的提示词列表
        aiPromptsTemplatesList = getAISuggestions().map(item => ({
          key: item.key,
          icon: item.icon,
          label: item.label,
          prompt: item.prompt,
          isDefault: true
        }));
        chrome.storage.local.set({ aiPromptsTemplates: aiPromptsTemplatesList });
      }
      initAISuggestions();

      resolve();
    });
  });
}

function renderAIProfileOptions() {
  const profileSelect = document.getElementById('ai-profile-select');
  if (!profileSelect) return;
  profileSelect.innerHTML = '';
  aiProfilesList.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    // 如果是内置/预设的且有翻译，使用翻译，否则使用内嵌名称
    let displayName = p.name;
    if (p.id === 'builtin') displayName = getMsg('ai_profile_builtin') || getMsg('ai_provider_builtin') || p.name;
    else if (p.id === 'default_openai') displayName = getMsg('ai_profile_openai') || p.name;
    else if (p.id === 'default_deepseek') displayName = getMsg('ai_profile_deepseek') || p.name;
    else if (p.id === 'default_gemini') displayName = getMsg('ai_profile_gemini') || p.name;
    else if (p.id === 'default_siliconflow') displayName = getMsg('ai_profile_siliconflow') || p.name;
    else if (p.id === 'default_ollama') displayName = getMsg('ai_profile_ollama') || p.name;
    else if (p.id === 'default_lmstudio') displayName = getMsg('ai_profile_lmstudio') || p.name;
    opt.textContent = displayName;
    profileSelect.appendChild(opt);
  });
  profileSelect.value = activeAIProfileId;
}

function loadActiveAIProfileToUI(profile) {
  const providerSelect = document.getElementById('ai-provider-select');
  const apiKeyInput = document.getElementById('ai-api-key-input');
  const endpointInput = document.getElementById('ai-endpoint-input');
  const modelInput = document.getElementById('ai-model-input');
  const nameInput = document.getElementById('ai-profile-name-input');
  const nameContainer = document.getElementById('ai-profile-name-container');
  const deleteBtn = document.getElementById('ai-profile-delete-btn');

  if (providerSelect) providerSelect.value = profile.provider;
  if (apiKeyInput) apiKeyInput.value = profile.apiKey || '';
  if (endpointInput) endpointInput.value = profile.endpoint || '';
  if (modelInput) modelInput.value = profile.model || '';

  // 更新 placeholder
  updateAIConfigPlaceholders(profile.provider);

  // 根据是否为自定义 profile 显示/隐藏名称栏位和删除按钮
  if (profile.isCustom) {
    if (nameContainer) nameContainer.style.display = 'flex';
    if (nameInput) nameInput.value = profile.name;
    if (deleteBtn) {
      deleteBtn.style.display = 'inline-flex';
      deleteBtn.disabled = false;
    }
  } else {
    if (nameContainer) nameContainer.style.display = 'none';
    if (deleteBtn) {
      deleteBtn.style.display = 'none';
      deleteBtn.disabled = true;
    }
  }

  // 根据 provider 显示/隐藏对应的输入框容器
  updateAIConfigFieldsVisibility(profile.provider);
}

function updateAIConfigPlaceholders(provider) {
  const apiKeyInput = document.getElementById('ai-api-key-input');
  const endpointInput = document.getElementById('ai-endpoint-input');
  const modelInput = document.getElementById('ai-model-input');
  
  if (provider === 'openai') {
    if (endpointInput) endpointInput.placeholder = 'https://api.openai.com/v1';
    if (modelInput) modelInput.placeholder = 'gpt-4o-mini';
    if (apiKeyInput) apiKeyInput.placeholder = 'sk-...';
  } else if (provider === 'ollama') {
    if (endpointInput) endpointInput.placeholder = 'http://localhost:11434';
    if (modelInput) modelInput.placeholder = 'llama3';
    if (apiKeyInput) apiKeyInput.placeholder = getMsg('ai_api_key_optional') || 'Optional (e.g. for proxy auth)';
  }
}

function updateAIConfigFieldsVisibility(provider) {
  const apiKeyContainer = document.getElementById('ai-api-key-container');
  const endpointContainer = document.getElementById('ai-endpoint-container');
  const modelContainer = document.getElementById('ai-model-container');

  if (!apiKeyContainer || !endpointContainer || !modelContainer) return;

  if (provider === 'builtin') {
    apiKeyContainer.style.display = 'none';
    endpointContainer.style.display = 'none';
    modelContainer.style.display = 'none';
  } else if (provider === 'ollama' || provider === 'openai') {
    apiKeyContainer.style.display = 'flex';
    endpointContainer.style.display = 'flex';
    modelContainer.style.display = 'flex';
  }
}

async function initTTSSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['ttsProvider', 'ttsApiKey', 'ttsEndpoint', 'ttsModel', 'ttsLanguage', 'ttsDefaultVoice'], async (res) => {
      const provider = res.ttsProvider || 'edge';
      const apiKey = res.ttsApiKey || '';
      const endpoint = res.ttsEndpoint || '';
      const model = res.ttsModel || 'tts-1';
      currentTTSLanguage = res.ttsLanguage || 'auto';
      ttsDefaultVoice = res.ttsDefaultVoice || '';

      // 配置 TTS 引擎
      tts.configure({ provider, apiKey, endpoint, model });

      // 初始化 UI 控制項值
      const providerSelect = document.getElementById('tts-provider-select');
      const apiKeyInput = document.getElementById('tts-api-key-input');
      const endpointInput = document.getElementById('tts-endpoint-input');
      const modelInput = document.getElementById('tts-model-input');
      const languageSelect = document.getElementById('tts-language-select');
      const voiceInput = document.getElementById('tts-voice-input');

      if (providerSelect) providerSelect.value = provider;
      if (languageSelect) languageSelect.value = currentTTSLanguage;
      if (voiceInput) voiceInput.value = ttsDefaultVoice;
      if (apiKeyInput) {
        apiKeyInput.value = apiKey;
        if (provider === 'local') {
          apiKeyInput.placeholder = getMsg('tts_api_key_optional') || 'Optional (e.g. for proxy auth)';
        } else {
          apiKeyInput.placeholder = 'sk-...';
        }
      }
      if (endpointInput) {
        endpointInput.value = endpoint;
        if (provider === 'openai') {
          endpointInput.placeholder = 'https://api.openai.com/v1';
        } else if (provider === 'local') {
          endpointInput.placeholder = 'http://localhost:5000/v1';
        }
      }
      if (modelInput) {
        modelInput.value = model;
        if (provider === 'openai') {
          modelInput.placeholder = 'tts-1';
        } else if (provider === 'local') {
          modelInput.placeholder = 'tts-1';
        }
      }

      // 根據 provider 顯示/隱藏對應的輸入框容器
      updateTTSConfigFieldsVisibility(provider);

      resolve();
    });
  });
}

function updateTTSConfigFieldsVisibility(provider) {
  const apiKeyContainer = document.getElementById('tts-api-key-container');
  const endpointContainer = document.getElementById('tts-endpoint-container');
  const modelContainer = document.getElementById('tts-model-container');

  if (!apiKeyContainer || !endpointContainer || !modelContainer) return;

  if (provider === 'edge' || provider === 'system') {
    apiKeyContainer.style.display = 'none';
    endpointContainer.style.display = 'none';
    modelContainer.style.display = 'none';
  } else {
    apiKeyContainer.style.display = 'flex';
    endpointContainer.style.display = 'flex';
    modelContainer.style.display = 'flex';
  }
}

function updateAIButtonsVisibility() {
  document.querySelectorAll('.ai-btn').forEach(btn => btn.style.display = 'inline-flex');
}

function initThemeAndStyles() {
  // 從 Storage 讀取設定，否則採用預設值
  chrome.storage.local.get(['theme', 'fontSize', 'fontFamily', 'lineHeight', 'marginWidth', 'marginWidthScroll', 'marginWidthPaginated', 'marginTop', 'marginBottom', 'layoutMode', 'pagesDisplayed', 'ttsHighlightStyle', 'ttsRate', 'paperTexture', 'pagePadding', 'transitionEffect', 'ttsOnlyEdge', 'ttsSyncOffset'], (res) => {
    // 優先使用當前書籍個別的設定，其次使用全局設定，最後使用系統預設
    const getPref = (key, defaultVal) => {
      if (currentBook && currentBook.progress && currentBook.progress[key] !== undefined) {
        return currentBook.progress[key];
      }
      return res[key] !== undefined ? res[key] : defaultVal;
    };

    const resolvedTheme = getPref('theme', 'mint');
    const resolvedFontFamily = getPref('fontFamily', 'font-lxgw');
    const resolvedFontSize = getPref('fontSize', 19);
    const resolvedLineHeight = getPref('lineHeight', 1.5);
    
    // 桌面端上下滾動模式預設邊距為 2%，移動端及分頁模式預設為 5%
    const defaultScrollMargin = isMobileDevice() ? 5 : 2;
    const oldMarginWidth = getPref('marginWidth', 5);
    marginWidthScroll = getPref('marginWidthScroll', getPref('marginWidth', defaultScrollMargin));
    marginWidthPaginated = getPref('marginWidthPaginated', oldMarginWidth);

    setTheme(resolvedTheme, false);
    setFontFamily(resolvedFontFamily, false);
    setFontSize(resolvedFontSize, false);
    setLineHeight(resolvedLineHeight, false);
    
    // Determine which layoutMode is starting
    let layoutMode = getPref('layoutMode', 'paginated');
    if (isMobileDevice()) {
      layoutMode = 'scroll';
    }
    const activeMargin = (layoutMode === 'paginated') ? marginWidthPaginated : marginWidthScroll;
    setMargins(activeMargin, false);
    
    setMarginTop(50, false); // 強制設定上方留白為 50px
    setMarginBottom(50, false); // 強制設定下方留白為 50px
    setPagePadding(40, false); // 強制設定紙張邊框留白為 40px
    
    // 是否僅顯示 Edge 語音
    ttsOnlyEdge = res.ttsOnlyEdge === true;
    updateEdgeFilterButtonVisibility();
    
    // 朗讀速度
    let savedRate = getPref('ttsRate', 1.0);
    tts.setRate(savedRate);
    document.getElementById('tts-speed-slider').value = savedRate;
    document.getElementById('tts-speed-val').textContent = `${savedRate.toFixed(1)}x`;


    // 朗讀高亮樣式
    const highlightStyle = res.ttsHighlightStyle || 'highlight-style-yellow';
    tts.highlightStyle = highlightStyle;
    document.getElementById('tts-highlight-style-select').value = highlightStyle;
    
    // 顯示頁數
    const pagesDisplayed = getPref('pagesDisplayed', 'auto');
    setPagesDisplayed(pagesDisplayed, false);
    document.getElementById('pages-displayed-select').value = pagesDisplayed;

    // 紙張底紋
    const savedTexture = getPref('paperTexture', 'texture-aged');
    setPaperTexture(savedTexture, false);
    document.getElementById('paper-texture-select').value = savedTexture;

    // 翻頁動畫效果 (固定使用 slide 滑動效果)
    let transitionEffect = 'slide';
    setTransitionEffect(transitionEffect, false);

    // 版面排版模式初始化
    layoutMode = getPref('layoutMode', 'paginated');
    if (isMobileDevice()) {
      layoutMode = 'scroll';
      // 隱藏移動端的版面排版模式選擇容器
      const layoutRow = document.getElementById('layout-mode-container');
      if (layoutRow) {
        layoutRow.style.display = 'none';
      }
    }
    toggleLayoutMode(layoutMode, false); // 初始化時不寫入 storage

    // 反向初始化 UI 控制器值
    document.getElementById('font-family-select').value = resolvedFontFamily;
    document.getElementById('font-size-slider').value = resolvedFontSize;
    document.getElementById('line-height-slider').value = resolvedLineHeight;
    document.getElementById('margin-width-slider').value = (layoutMode === 'paginated') ? marginWidthPaginated : marginWidthScroll;
    document.getElementById('margin-top-slider').value = 50;
    document.getElementById('margin-bottom-slider').value = 50;
    document.getElementById('page-padding-slider').value = 40;
    
    document.querySelectorAll('.theme-dot').forEach(dot => {
      if (dot.getAttribute('data-theme') === resolvedTheme) dot.classList.add('active');
      else dot.classList.remove('active');
    });
  });
}

function setTheme(theme, writeToStorage = true) {
  const classesToRemove = Array.from(document.body.classList).filter(c => c.startsWith('theme-'));
  classesToRemove.forEach(c => document.body.classList.remove(c));
  document.body.classList.add(`theme-${theme}`);
  
  // Update active mind-elixir mindmaps to match theme
  if (typeof activeMindElixirs !== 'undefined') {
    const active = activeMindElixirs.filter(item => document.body.contains(item.container));
    activeMindElixirs.length = 0;
    activeMindElixirs.push(...active);

    const isDark = theme === 'dark' || theme === 'oled';
    const targetTheme = isDark ? MindElixir.DARK_THEME : MindElixir.THEME;
    activeMindElixirs.forEach(({ mind }) => {
      try {
        mind.changeTheme(targetTheme);
      } catch (err) {
        console.warn('Failed to update mind-elixir theme:', err);
      }
    });
  }

  if (writeToStorage) {
    chrome.storage.local.set({ theme });
    if (currentBook) {
      saveProgressDebounced({ theme });
    }
  }
}

function setFontFamily(fontFamily, writeToStorage = true) {
  const container = document.getElementById('reader-container');
  const classesToRemove = Array.from(container.classList).filter(c => c.startsWith('font-'));
  classesToRemove.forEach(c => container.classList.remove(c));
  container.classList.add(fontFamily);
  
  // 同步更新側邊欄的字型類別，使其與閱讀介面字型保持一致
  const sidebar = document.getElementById('reader-sidebar');
  if (sidebar) {
    const classesToRemove = Array.from(sidebar.classList).filter(c => c.startsWith('font-'));
    classesToRemove.forEach(c => sidebar.classList.remove(c));
    sidebar.classList.add(fontFamily);
  }

  if (writeToStorage) {
    chrome.storage.local.set({ fontFamily });
    if (currentBook) {
      saveProgressDebounced({ fontFamily });
    }
  }
}

function setFontSize(size, writeToStorage = true) {
  const topIdx = getTopVisibleElementIndex();
  document.getElementById('book-content').style.fontSize = `${size}px`;
  document.getElementById('font-size-val').textContent = `${size}px`;
  if (writeToStorage) {
    chrome.storage.local.set({ fontSize: size });
    if (currentBook) {
      saveProgressDebounced({ fontSize: size });
    }
  }
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

// 變更行距樣式並重算佈局
function setLineHeight(val, writeToStorage = true) {
  const topIdx = getTopVisibleElementIndex();
  const bookContent = document.getElementById('book-content');
  bookContent.style.lineHeight = val;
  bookContent.style.setProperty('--book-line-height', val);
  document.getElementById('line-height-val').textContent = val;
  if (writeToStorage) {
    chrome.storage.local.set({ lineHeight: val });
    if (currentBook) {
      saveProgressDebounced({ lineHeight: val });
    }
  }
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setMargins(val, writeToStorage = true) {
  const topIdx = getTopVisibleElementIndex();
  const container = document.getElementById('reader-container');
  container.style.paddingLeft = `${val}%`;
  container.style.paddingRight = `${val}%`;
  document.getElementById('margin-width-val').textContent = `${val}%`;
  
  const isPaginated = document.body.classList.contains('layout-paginated');
  if (isPaginated) {
    marginWidthPaginated = val;
  } else {
    marginWidthScroll = val;
  }
  
  if (writeToStorage) {
    const key = isPaginated ? 'marginWidthPaginated' : 'marginWidthScroll';
    const dataToSave = {};
    dataToSave[key] = val;
    chrome.storage.local.set(dataToSave);
    if (currentBook) {
      if (!currentBook.progress) currentBook.progress = {};
      currentBook.progress[key] = val;
      saveProgressDebounced(dataToSave);
    }
  }
  applyLayoutDimensions();
  if (isPaginated) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setMarginTop(val, writeToStorage = true) {
  const topIdx = getTopVisibleElementIndex();
  const intVal = parseInt(val) || 40;
  document.getElementById('margin-top-val').textContent = `${intVal}px`;
  if (writeToStorage) {
    chrome.storage.local.set({ marginTop: intVal });
    if (currentBook) {
      saveProgressDebounced({ marginTop: intVal });
    }
  }
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setMarginBottom(val, writeToStorage = true) {
  const topIdx = getTopVisibleElementIndex();
  const intVal = parseInt(val) || 40;
  document.getElementById('margin-bottom-val').textContent = `${intVal}px`;
  if (writeToStorage) {
    chrome.storage.local.set({ marginBottom: intVal });
    if (currentBook) {
      saveProgressDebounced({ marginBottom: intVal });
    }
  }
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setPagePadding(val, writeToStorage = true) {
  const topIdx = getTopVisibleElementIndex();
  const intVal = parseInt(val);
  const valEl = document.getElementById('page-padding-val');
  if (valEl) {
    valEl.textContent = `${intVal}px`;
  }
  if (writeToStorage) {
    chrome.storage.local.set({ pagePadding: intVal });
    if (currentBook) {
      saveProgressDebounced({ pagePadding: intVal });
    }
  }
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setPagesDisplayed(val, writeToStorage = true) {
  const topIdx = getTopVisibleElementIndex();
  currentPagesDisplayed = val || 'auto';
  if (writeToStorage) {
    chrome.storage.local.set({ pagesDisplayed: currentPagesDisplayed });
    if (currentBook) {
      saveProgressDebounced({ pagesDisplayed: currentPagesDisplayed });
    }
  }
  applyLayoutDimensions();
  if (document.body.classList.contains('layout-paginated')) {
    restoreScrollToElementIndex(topIdx);
  }
}

function setPaperTexture(texture, writeToStorage = true) {
  currentPaperTexture = texture || 'texture-classic';
  // 移除所有 texture-* 類別
  const classesToRemove = Array.from(document.body.classList).filter(c => c.startsWith('texture-'));
  classesToRemove.forEach(c => document.body.classList.remove(c));
  document.body.classList.add(currentPaperTexture);
  if (writeToStorage) {
    chrome.storage.local.set({ paperTexture: currentPaperTexture });
    if (currentBook) {
      saveProgressDebounced({ paperTexture: currentPaperTexture });
    }
  }
}

function setTransitionEffect(effect, writeToStorage = true) {
  const html = document.documentElement;
  // 移除所有 transition- 類別
  const classesToRemove = Array.from(html.classList).filter(c => c.startsWith('transition-'));
  classesToRemove.forEach(c => html.classList.remove(c));
  html.classList.add(`transition-${effect}`);
  if (writeToStorage) {
    chrome.storage.local.set({ transitionEffect: effect });
    if (currentBook) {
      saveProgressDebounced({ transitionEffect: effect });
    }
  }
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

  // 根據側邊欄/AI面板開啟狀態，動態計算剩餘的可用視窗寬度
  const readerView = document.getElementById('reader-view');
  let viewportWidth = window.innerWidth;
  if (readerView) {
    const computedStyle = window.getComputedStyle(readerView);
    const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(computedStyle.paddingRight) || 0;
    viewportWidth = window.innerWidth - paddingLeft - paddingRight;
  }
  
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
function toggleLayoutMode(mode, saveToStorage = true) {
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

  const activeMargin = isPaginated ? marginWidthPaginated : marginWidthScroll;
  const slider = document.getElementById('margin-width-slider');
  if (slider) {
    slider.value = activeMargin;
  }

  if (isPaginated) {
    scrollBtn.classList.remove('active');
    paginatedBtn.classList.add('active');
    
    const topIdx = getTopVisibleElementIndex();
    setMargins(activeMargin, false);
    restoreScrollToElementIndex(topIdx);
  } else {
    scrollBtn.classList.add('active');
    paginatedBtn.classList.remove('active');
    setMargins(activeMargin, false);
    content.style.transform = '';
    // 滾動模式下清空紙張底紋覆蓋層
    const overlay = document.getElementById('page-texture-overlay');
    if (overlay) overlay.innerHTML = '';
  }
  
  if (saveToStorage && !isMobileDevice()) {
    chrome.storage.local.set({ layoutMode: mode });
    if (currentBook) {
      saveProgressDebounced({ layoutMode: mode });
    }
  }
}

// 快捷鍵控制
function handleKeyDown(e) {
  if (!document.getElementById('reader-view').classList.contains('view-active')) return;

  // 如果焦點在輸入框、文本區域或可編輯區域中，不響應鍵盤快捷鍵
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
    return;
  }

  if (e.code === 'Space') {
    // 空白鍵控制朗讀播放/暫停
    e.preventDefault();
    document.getElementById('tts-play-btn').click();
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
  } else if (e.code === 'ArrowUp') {
    // 上方向鍵：在最頂部時加載上一章物理文件
    if (!document.body.classList.contains('layout-paginated')) {
      if (isChangingChapter) return;
      if (Date.now() - lastChapterChangeTime < 800) return;
      const scrollTop = window.scrollY;
      if (scrollTop <= 5 && currentChapterIndex > 0) {
        const currentHref = epubBookData.chapters[currentChapterIndex].cleanHref;
        let prevIdx = currentChapterIndex - 1;
        while (prevIdx >= 0 && epubBookData.chapters[prevIdx].cleanHref === currentHref) {
          prevIdx--;
        }
        if (prevIdx >= 0) {
          loadChapter(prevIdx, true, false, true, false, null, null, null, null, null, true);
        }
      }
    }
  } else if (e.code === 'ArrowDown') {
    // 下方向鍵：在最底部時加載下一章物理文件
    if (!document.body.classList.contains('layout-paginated')) {
      if (isChangingChapter) return;
      if (Date.now() - lastChapterChangeTime < 800) return;
      const scrollTop = window.scrollY;
      const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
      const clientHeight = window.innerHeight;
      if (scrollTop + clientHeight >= scrollHeight - 5 && epubBookData && currentChapterIndex < epubBookData.chapters.length - 1) {
        const currentHref = epubBookData.chapters[currentChapterIndex].cleanHref;
        let nextIdx = currentChapterIndex + 1;
        while (nextIdx < epubBookData.chapters.length && epubBookData.chapters[nextIdx].cleanHref === currentHref) {
          nextIdx++;
        }
        if (nextIdx < epubBookData.chapters.length) {
          loadChapter(nextIdx, false, false, true, false, null, null, null, null, null, true);
        }
      }
    }
  }
}

// 面板顯示切換
function toggleSidebar() {
  const sidebar = document.getElementById('reader-sidebar');
  const isTOCActive = document.getElementById('tab-toc') && document.getElementById('tab-toc').classList.contains('active');
  
  if (!sidebar.classList.contains('active')) {
    sidebar.classList.add('active');
    switchSidebarTab('toc');
  } else {
    if (isTOCActive) {
      sidebar.classList.remove('active');
    } else {
      switchSidebarTab('toc');
    }
  }
  document.getElementById('settings-panel').classList.remove('dropdown-active');
  document.getElementById('tts-panel').classList.remove('dropdown-active');
  updateHeaderActiveStates();
}

function toggleSearchSidebar() {
  console.log('[Reader] toggleSearchSidebar called');
  const sidebar = document.getElementById('reader-sidebar');
  const isSearchActive = document.getElementById('tab-search') && document.getElementById('tab-search').classList.contains('active');
  
  if (!sidebar.classList.contains('active')) {
    sidebar.classList.add('active');
    switchSidebarTab('search');
  } else {
    if (isSearchActive) {
      sidebar.classList.remove('active');
    } else {
      switchSidebarTab('search');
    }
  }
  document.getElementById('settings-panel').classList.remove('dropdown-active');
  document.getElementById('tts-panel').classList.remove('dropdown-active');
  updateHeaderActiveStates();
}

function switchSidebarTab(tabId) {
  const tabToc = document.getElementById('tab-toc');
  const tabHighlights = document.getElementById('tab-highlights');
  const tabSearch = document.getElementById('tab-search');
  
  const containerToc = document.getElementById('sidebar-toc-container');
  const containerHighlights = document.getElementById('sidebar-highlights-container');
  const containerSearch = document.getElementById('sidebar-search-container');
  
  if (tabToc) tabToc.classList.remove('active');
  if (tabHighlights) tabHighlights.classList.remove('active');
  if (tabSearch) tabSearch.classList.remove('active');
  
  if (containerToc) containerToc.classList.remove('active');
  if (containerHighlights) containerHighlights.classList.remove('active');
  if (containerSearch) containerSearch.classList.remove('active');
  
  if (tabId === 'toc') {
    if (tabToc) tabToc.classList.add('active');
    if (containerToc) containerToc.classList.add('active');
    setTimeout(() => {
      const activeItem = document.querySelector('#toc-list .toc-item.active');
      if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 150);
  } else if (tabId === 'highlights') {
    if (tabHighlights) tabHighlights.classList.add('active');
    if (containerHighlights) containerHighlights.classList.add('active');
    renderHighlightsList();
  } else if (tabId === 'search') {
    if (tabSearch) tabSearch.classList.add('active');
    if (containerSearch) containerSearch.classList.add('active');
    setTimeout(() => {
      const searchInput = document.getElementById('sidebar-search-input');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }, 150);
  }
  updateHeaderActiveStates();
}

function toggleSettingsPanel() {
  document.getElementById('settings-panel').classList.toggle('dropdown-active');
  document.getElementById('reader-sidebar').classList.remove('active');
  document.getElementById('tts-panel').classList.remove('dropdown-active');
  updateHeaderActiveStates();
}

function toggleTTSPanel() {
  const panel = document.getElementById('tts-panel');
  const willBeActive = !panel.classList.contains('dropdown-active');
  panel.classList.toggle('dropdown-active');
  document.getElementById('reader-sidebar').classList.remove('active');
  document.getElementById('settings-panel').classList.remove('dropdown-active');
  updateHeaderActiveStates();
  if (willBeActive && currentBook) {
    initTTSPanelVoices(currentBook.file?.name || currentBook.title || '', false);
  }
}

function updateHeaderActiveStates() {
  const sidebar = document.getElementById('reader-sidebar');
  const ttsPanel = document.getElementById('tts-panel');
  const settingsPanel = document.getElementById('settings-panel');
  const aiPanel = document.getElementById('ai-panel');

  const sidebarActive = sidebar && sidebar.classList.contains('active');
  const ttsActive = ttsPanel && ttsPanel.classList.contains('dropdown-active');
  const settingsActive = settingsPanel && settingsPanel.classList.contains('dropdown-active');
  const aiActive = aiPanel && (aiPanel.style.display === 'flex' || aiPanel.style.display === 'block');

  const tabSearch = document.getElementById('tab-search');
  const isSearchTabActive = tabSearch && tabSearch.classList.contains('active');
  const searchToggleActive = sidebarActive && isSearchTabActive;
  const sidebarToggleActive = sidebarActive && !isSearchTabActive;

  const searchToggle = document.getElementById('search-toggle');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const ttsToggle = document.getElementById('tts-toggle');
  const settingsToggle = document.getElementById('settings-toggle');
  const aiToggle = document.getElementById('ai-toggle');

  if (searchToggle) searchToggle.classList.toggle('active', searchToggleActive);
  if (sidebarToggle) sidebarToggle.classList.toggle('active', sidebarToggleActive);
  if (ttsToggle) ttsToggle.classList.toggle('active', ttsActive);
  if (settingsToggle) settingsToggle.classList.toggle('active', settingsActive);
  if (aiToggle) aiToggle.classList.toggle('active', aiActive);

  const wasSidebarActive = document.body.classList.contains('sidebar-active');
  const wasAIActive = document.body.classList.contains('ai-active');

  // Sync state classes to document body
  document.body.classList.toggle('sidebar-active', sidebarActive);
  document.body.classList.toggle('ai-active', aiActive);

  // 當側邊欄或 AI 面板的開啟狀態改變，且為分頁排版模式時，重新計算排版尺寸
  if (document.body.classList.contains('layout-paginated')) {
    if (wasSidebarActive !== sidebarActive || wasAIActive !== aiActive) {
      applyLayoutDimensions();
      // 因為有 350ms 的 CSS transition，在動畫結束後再次調用以確保完美對齊
      setTimeout(applyLayoutDimensions, 350);
    }
  }
}


// ==================== 5.5 版本檢查與下載區 ==================== */

const GITHUB_REPO = 'newfur/newfur.github.io';

function compareVersions(a, b) {
  const pa = (a || '').split('.').map(Number);
  const pb = (b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function checkForUpdates() {
  const statusEl = document.getElementById('about-update-status');
  const downloadSection = document.getElementById('about-download-section');
  if (!statusEl) return;

  statusEl.textContent = getMsg('checking_update') || 'Checking...';
  statusEl.style.color = 'var(--text-muted)';

  const currentVersion = window.__APP_VERSION__ || '';
  const isNativeApp = typeof window !== 'undefined' && (
    window.Capacitor ||
    window.location.protocol === 'capacitor:' ||
    window.location.protocol === 'app:' ||
    window.location.protocol === 'file:'
  );
  const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest;

  try {
    // 1. 從倉庫 manifest.json 讀取最新版本號（每次 push 即更新，不依賴 CI 是否完成構建）
    let latestVersion = '';
    try {
      const manifestResp = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/web-version/manifest.json?_t=${Date.now()}`);
      if (manifestResp.ok) {
        const manifestData = await manifestResp.json();
        latestVersion = manifestData.version || '';
      }
    } catch (e) {
      console.warn('[Update Check] Failed to fetch manifest from repo:', e);
    }

    // 2. 查詢最新 Release 以獲取可下載的版本號（CI 構建產物）
    let releaseVersion = '';
    try {
      const releaseResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });
      if (releaseResp.ok) {
        const release = await releaseResp.json();
        releaseVersion = (release.tag_name || '').replace(/^v/, '');
      }
    } catch (e) {
      console.warn('[Update Check] Failed to fetch latest release:', e);
    }

    // 3. 顯示版本狀態：以倉庫 manifest 為準判斷是否有新版本
    const checkVersion = latestVersion || releaseVersion;
    if (checkVersion && compareVersions(checkVersion, currentVersion) > 0) {
      statusEl.innerHTML = `<span style="color: var(--primary-color); font-weight: 500;">${getMsg('update_available') || 'New version'} v${checkVersion}</span>`;
    } else if (checkVersion) {
      statusEl.innerHTML = `<span style="color: #34c759;">${getMsg('up_to_date') || 'Up to date'}</span>`;
    } else {
      throw new Error('No version info available');
    }

    // 4. 設置下載區：下載連結指向已構建的 Release 版本；若 Release 尚未就緒則指向 Release 頁面
    if (downloadSection) {
      const apkBtn = document.getElementById('download-apk-btn');
      const offlineBtn = document.getElementById('download-offline-link');
      const chromeBtn = document.getElementById('download-chrome-btn');
      const releasesUrl = `https://github.com/${GITHUB_REPO}/releases`;

      if (releaseVersion) {
        const v = releaseVersion;
        if (apkBtn) apkBtn.href = `https://github.com/${GITHUB_REPO}/releases/download/v${v}/Raconteur-${v}.apk`;
        if (offlineBtn) offlineBtn.href = `https://github.com/${GITHUB_REPO}/releases/download/v${v}/Raconteur-Offline-${v}.html`;
        if (chromeBtn) chromeBtn.href = `https://github.com/${GITHUB_REPO}/releases/download/v${v}/Raconteur-Chrome-${v}.zip`;
      } else {
        // Release 尚未構建，全部指向 Release 頁面
        if (apkBtn) apkBtn.href = releasesUrl;
        if (offlineBtn) offlineBtn.href = releasesUrl;
        if (chromeBtn) chromeBtn.href = releasesUrl;
      }
      if (apkBtn) apkBtn.style.display = isExtension ? 'none' : '';
      if (offlineBtn) offlineBtn.style.display = isExtension ? 'none' : '';
      if (chromeBtn) chromeBtn.style.display = isNativeApp ? 'none' : '';
      downloadSection.style.display = 'block';
    }
  } catch (e) {
    console.warn('[Update Check] Failed:', e);
    const releasesUrl = `https://github.com/${GITHUB_REPO}/releases`;
    statusEl.innerHTML = `<a href="${releasesUrl}" target="_blank" style="color: var(--primary-color); text-decoration: underline; font-size: 12px;">${getMsg('view_releases') || 'View releases on GitHub'}</a>`;

    if (downloadSection) {
      const v = currentVersion;
      if (v) {
        const apkBtn = document.getElementById('download-apk-btn');
        const offlineBtn = document.getElementById('download-offline-link');
        const chromeBtn = document.getElementById('download-chrome-btn');
        if (apkBtn) { apkBtn.href = `${releasesUrl}`; apkBtn.style.display = isExtension ? 'none' : ''; }
        if (offlineBtn) { offlineBtn.href = `${releasesUrl}`; offlineBtn.style.display = isExtension ? 'none' : ''; }
        if (chromeBtn) { chromeBtn.href = `${releasesUrl}`; chromeBtn.style.display = isNativeApp ? 'none' : ''; }
        downloadSection.style.display = 'block';
      }
    }
  }
}


// ==================== 6. TTS 語音朗讀專屬配置 ==================== */

// 自動檢測書籍語言引擎 (多層精準判定：正文/標題統計分析 -> 內嵌元數據 -> 瀏覽器兜底)
function detectBookLanguage(filename = '') {
  // 1. 第一優先級：提取實際正文樣本與標題進行統計字符頻率分析（以實際文字為最高真理依據，防範元數據標籤錯誤）
  let contentSample = '';
  if (tts && tts.sentences && tts.sentences.length > 0) {
    // 優先使用 TTS 切分好的純文本句子
    contentSample = tts.sentences.slice(0, 30).map(s => s.text || '').join(' ');
  } else {
    // 從 DOM 提取，但必須過濾掉 loading 加載動畫、按鈕、腳本等 UI 干擾文字
    const bookContent = document.getElementById('book-content');
    if (bookContent) {
      const clone = bookContent.cloneNode(true);
      clone.querySelectorAll('.ai-loading, .loading-spinner, script, style, button, svg').forEach(el => el.remove());
      contentSample = (clone.textContent || '').trim().slice(0, 3000);
    }
  }

  // 僅在沒有正文樣本時，使用目錄標題作為語言檢測後備資料
  if (epubBookData && epubBookData.chapters && epubBookData.chapters.length > 0) {
    const chapterTitles = epubBookData.chapters.slice(0, 5).map(ch => ch.title || '').join(' ').trim();
    if (shouldAppendChapterTitles(contentSample, chapterTitles)) {
      contentSample += ' ' + chapterTitles;
    }
  }

  // 輔助標題樣本（排除默認佔位符如 "未知作者" / "Unknown Author"）
  let titleSample = '';
  if (currentBook) {
    if (currentBook.title) titleSample += ' ' + currentBook.title;
    const authorStr = currentBook.author || '';
    const currentUnknownAuthor = (typeof getMsg === 'function' ? getMsg('unknown_author') : '') || '未知作者';
    if (authorStr && authorStr !== '未知作者' && authorStr !== 'Unknown Author' && authorStr !== currentUnknownAuthor) {
      titleSample += ' ' + authorStr;
    }
  }
  if (filename && typeof filename === 'string') {
    // 移除副檔名和括號標籤
    const cleanFilename = filename.replace(/\.[a-z0-9]+$/i, '').replace(/\[.*?\]|\(.*?\)/g, '');
    titleSample += ' ' + cleanFilename;
  }

  const fullSample = (contentSample + ' ' + titleSample).trim();

  console.log(`[TTS detectBookLanguage] filename="${filename}" sentencesLen=${tts?.sentences?.length || 0} contentSampleLen=${contentSample.length} titleSample="${titleSample.trim()}" fullSampleLen=${fullSample.length} fullSample="${fullSample.slice(0, 100)}..."`);

  if (fullSample.length > 0) {
    const cjkMatches = fullSample.match(/[\u4e00-\u9fa5]/g) || [];
    const kanaMatches = fullSample.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || [];
    const hangulMatches = fullSample.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || [];
    const latinMatches = fullSample.match(/[a-zA-Z]/g) || [];
    const cyrillicMatches = fullSample.match(/[\u0400-\u04FF]/g) || [];
    const arabicMatches = fullSample.match(/[\u0600-\u06FF]/g) || [];

    const cjkCount = cjkMatches.length;
    const kanaCount = kanaMatches.length;
    const hangulCount = hangulMatches.length;
    const latinCount = latinMatches.length;
    const cyrillicCount = cyrillicMatches.length;
    const arabicCount = arabicMatches.length;

    console.log(`[TTS detectBookLanguage] charCounts: latin=${latinCount} cjk=${cjkCount} kana=${kanaCount} hangul=${hangulCount} cyrillic=${cyrillicCount} arabic=${arabicCount}`);

    // 韓文 (包含韓文音節)
    if (hangulCount >= 2 && hangulCount >= cjkCount) {
      return 'ko';
    }
    // 日文 (包含假名)
    if (kanaCount >= 2 || (kanaCount > 0 && kanaCount * 3 >= cjkCount)) {
      return 'ja';
    }
    // 俄文等西里爾字母
    if (cyrillicCount >= 10 && cyrillicCount > latinCount) {
      return 'ru-RU';
    }
    // 阿拉伯文
    if (arabicCount >= 10 && arabicCount > latinCount) {
      return 'ar-SA';
    }
    // 英文/拉丁文：拉丁字母佔主導
    if (latinCount >= 3 && latinCount > cjkCount) {
      return 'en';
    }
    // 中文：CJK 字符顯著多於拉丁字母
    if (cjkCount >= 3 && cjkCount >= latinCount) {
      const tradExclusive = fullSample.match(/[這裡們點後開關體說聲經書個長發實誰國學門頁見讓動經頭時兩還給會樣無從為與應聽東廣關機電]/g) || [];
      const simpExclusive = fullSample.match(/[这里们点后开关体说声经书个长发实谁国学门页见让动经头时两还给会样无从为与应听东广关机电]/g) || [];
      if (tradExclusive.length > simpExclusive.length && tradExclusive.length >= 2) {
        return 'zh-TW';
      }
      if (simpExclusive.length > tradExclusive.length && simpExclusive.length >= 2) {
        return 'zh-CN';
      }
      return (navigator.language && (navigator.language.includes('TW') || navigator.language.includes('HK'))) ? 'zh-TW' : 'zh-CN';
    }
  }

  // 2. 第二優先級：無正文文本時，檢查書籍內嵌的官方語言元數據 (<dc:language> 或 EXTH 524)
  let metaLang = '';
  if (epubBookData && epubBookData.metadata && epubBookData.metadata.language) {
    metaLang = epubBookData.metadata.language;
  } else if (currentBook && currentBook.language) {
    metaLang = currentBook.language;
  }

  if (metaLang && typeof metaLang === 'string') {
    const clean = metaLang.trim().toLowerCase().replace('_', '-');
    if (clean.startsWith('zh') || clean.startsWith('cmn') || clean.startsWith('yue')) {
      return (clean.includes('tw') || clean.includes('hk') || clean.includes('hant')) ? 'zh-TW' : 'zh-CN';
    }
    if (clean.startsWith('ja') || clean.startsWith('jp')) return 'ja';
    if (clean.startsWith('ko') || clean.startsWith('kr')) return 'ko';
    if (clean.startsWith('en')) return 'en';
    if (clean.startsWith('fr')) return 'fr-FR';
    if (clean.startsWith('de')) return 'de-DE';
    if (clean.startsWith('es')) return 'es-ES';
    if (clean.startsWith('ru')) return 'ru-RU';
    if (clean.startsWith('it')) return 'it-IT';
    if (/^[a-z]{2}(-[a-z]{2,4})?$/i.test(clean)) return clean;
  }

  // 3. 第三優先級：使用用戶全局設定的 TTS 語言（僅當正文與元數據均無法判斷時）
  if (currentTTSLanguage && currentTTSLanguage !== 'auto') {
    return currentTTSLanguage;
  }

  // 4. 最終兜底：默認使用瀏覽器/系統語言
  if (navigator.language && navigator.language.startsWith('zh')) {
    return (navigator.language.includes('TW') || navigator.language.includes('HK')) ? 'zh-TW' : 'zh-CN';
  } else if (navigator.language && navigator.language.startsWith('ja')) {
    return 'ja';
  } else if (navigator.language && navigator.language.startsWith('ko')) {
    return 'ko';
  }
  return 'en';
}

function shouldAppendChapterTitles(contentSample, chapterTitles) {
  return !contentSample.trim() && Boolean(chapterTitles.trim());
}

// 根據系統語言格式化 TTS 語音顯示名稱
// 例如 shortName="zh-CN-XiaoxiaoNeural" → 中文顯示 "晓晓 Xiaoxiao (中文(中国) · 女)"
const VOICE_LOCAL_NAMES = {
  // 中文 (简体)
  'Xiaoxiao': '晓晓', 'Xiaoyi': '晓伊', 'Yunjian': '云健', 'Yunxi': '云希',
  'Yunxia': '云夏', 'Yunyang': '云扬', 'Xiaobei': '晓北', 'Xiaoni': '晓妮',
  // 中文 (繁體)
  'HsiaoChen': '曉臻', 'HsiaoYu': '曉雨', 'YunJhe': '雲哲',
  // 中文 (粵語)
  'HiuGaai': '曉佳', 'HiuMaan': '曉曼', 'WanLung': '雲龍',
  // 日語
  'Nanami': '七海', 'Keita': '圭太',
  // 韓語
  'SunHi': '선히', 'InJoon': '인준', 'Hyunsu': '현수'
};

function formatVoiceDisplayName(voice) {
  // 非 Edge 語音或 OpenAI/Local 語音，直接用原名
  if (!voice.shortName && !voice.isEdge) {
    const displayLang = voice.lang === 'multilingual' ? (getMsg('tts_lang_multilingual') || 'Multilingual') : voice.lang;
    return `${voice.name} (${displayLang})`;
  }

  const shortName = voice.shortName || '';
  // 從 shortName 提取人名：zh-CN-XiaoxiaoNeural → Xiaoxiao
  const parts = shortName.split('-');
  let personName = '';
  if (parts.length >= 3) {
    personName = parts.slice(2).join('-').replace(/Neural$/i, '').replace(/Multilingual$/i, '');
  }
  if (!personName) {
    // 從 FriendlyName 中提取：Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)
    const match = (voice.friendlyName || voice.name || '').match(/,\s*([A-Za-z]+?)(?:Neural|Multilingual)?\s*\)/);
    personName = match ? match[1] : voice.name;
  }

  // 用 Intl.DisplayNames 把語言代碼翻譯成系統語言
  let langDisplay = voice.lang || '';
  if (voice.lang && voice.lang !== 'multilingual') {
    try {
      const uiLang = navigator.language || 'en';
      const dn = new Intl.DisplayNames([uiLang], { type: 'language' });
      langDisplay = dn.of(voice.lang) || voice.lang;
    } catch (e) {
      langDisplay = voice.lang;
    }
  } else if (voice.lang === 'multilingual') {
    langDisplay = getMsg('tts_lang_multilingual') || 'Multilingual';
  }

  // 性別本地化
  const genderMap = {
    'female': getMsg('voice_gender_female') || 'Female',
    'male': getMsg('voice_gender_male') || 'Male'
  };
  const genderStr = genderMap[voice.gender] || '';

  const meta = genderStr ? `${langDisplay} · ${genderStr}` : langDisplay;
  // 對於有本地化名稱的語音，CJK 系統語言下顯示 "本地名 拉丁名 (語言 · 性別)"，否則只顯示拉丁名
  const localName = VOICE_LOCAL_NAMES[personName] || '';
  const uiLangPrefix = (navigator.language || 'en').toLowerCase().split('-')[0];
  const isCJKUI = ['zh', 'ja', 'ko'].includes(uiLangPrefix);
  const displayName = (localName && isCJKUI) ? `${localName} ${personName}` : personName;
  return `${displayName} (${meta})`;
}

function getTTSVoiceGroups(voices, lang, edgeOnly = false) {
  const normalizePrefix = (value) => {
    const code = (value || '').toLowerCase().replace('_', '-');
    if (code.startsWith('zh') || code.startsWith('cmn') || code.startsWith('yue') || code.startsWith('wuu')) return 'zh';
    if (code.startsWith('en') || code.startsWith('eng')) return 'en';
    if (code.startsWith('ja') || code.startsWith('jpn')) return 'ja';
    if (code.startsWith('ko') || code.startsWith('kor')) return 'ko';
    if (code.startsWith('fr') || code.startsWith('fra')) return 'fr';
    if (code.startsWith('de') || code.startsWith('deu') || code.startsWith('ger')) return 'de';
    if (code.startsWith('es') || code.startsWith('spa')) return 'es';
    return code.split('-')[0];
  };

  const availableVoices = [];
  const seenNames = new Set();
  for (const voice of voices || []) {
    if (edgeOnly && !voice.isEdge) continue;
    if (seenNames.has(voice.name)) continue;
    seenNames.add(voice.name);
    availableVoices.push(voice);
  }

  const targetPrefix = normalizePrefix(lang || 'en');
  const targetLocale = (lang || 'en').toLowerCase().replace('_', '-');
  const matchedVoices = availableVoices.filter(voice =>
    voice.lang === 'multilingual' || normalizePrefix(voice.lang) === targetPrefix
  );
  matchedVoices.sort((a, b) => {
    const aLang = (a.lang || '').toLowerCase().replace('_', '-');
    const bLang = (b.lang || '').toLowerCase().replace('_', '-');
    const aExact = aLang.startsWith(targetLocale);
    const bExact = bLang.startsWith(targetLocale);
    if (aExact !== bExact) return aExact ? -1 : 1;
    if (aLang !== bLang) return aLang.localeCompare(bLang);
    const aNatural = a.isEdge || /natural|online|neural/i.test(a.name || '');
    const bNatural = b.isEdge || /natural|online|neural/i.test(b.name || '');
    if (aNatural !== bNatural) return aNatural ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  return { matchedVoices, availableVoices };
}

// 初始化播放面板語音下拉選單
function initTTSPanelVoices(filename, isBookOpening = false) {
  // 檢測書籍語言：打開新書時重新檢測並緩存；異步語音列表更新時複用緩存
  let lang;
  if (isBookOpening) {
    lang = detectBookLanguage(filename);
    currentBookDetectedLanguage = lang;
    console.log(`[TTS] Book opened: detected language = "${lang}" for "${filename}"`);
  } else if (currentBookDetectedLanguage) {
    lang = currentBookDetectedLanguage;
    console.log(`[TTS] Voice refresh: reusing cached language = "${lang}"`);
  } else {
    lang = detectBookLanguage(filename);
    console.log(`[TTS] No cache: detected language = "${lang}" for "${filename}"`);
  }

  const select = document.getElementById('tts-voice-select');
  if (!select) return;
  const currentSelected = select.value;
  select.innerHTML = '';

  const voiceGroups = getTTSVoiceGroups(tts.voices, lang, ttsOnlyEdge);
  const { matchedVoices } = voiceGroups;

  const createOption = (voice) => {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = formatVoiceDisplayName(voice);
    return opt;
  };

  let hasDefaultVoice = false;

  // 1. 添加推薦語音（僅顯示與書籍語言匹配的語音）
  if (matchedVoices.length > 0) {
    matchedVoices.forEach(voice => {
      select.appendChild(createOption(voice));
      if (voice.name === ttsDefaultVoice) hasDefaultVoice = true;
    });
  }

  // Inject default/custom voice for OpenAI/Local providers if not present
  if (ttsDefaultVoice && !hasDefaultVoice && !ttsOnlyEdge && (tts.ttsProvider === 'openai' || tts.ttsProvider === 'local')) {
    const opt = document.createElement('option');
    opt.value = ttsDefaultVoice;
    opt.textContent = `${ttsDefaultVoice} (${getMsg('tts_lang_multilingual') || 'Multilingual'})`;
    select.appendChild(opt);
    tts.setVoice(ttsDefaultVoice);
  }

  // 優先使用保存的語音，其次保留當前已選中的語音，最後是推薦列表第一項
  const savedVoice = currentBook?.progress?.ttsVoice;
  const allOptions = select.querySelectorAll('option');
  const availableVoiceValues = Array.from(allOptions).map(opt => opt.value);
  
  if (availableVoiceValues.length > 0) {
    if (savedVoice && availableVoiceValues.includes(savedVoice)) {
      select.value = savedVoice;
      tts.setVoice(savedVoice);
    } else if (ttsDefaultVoice && availableVoiceValues.includes(ttsDefaultVoice) && (tts.ttsProvider === 'openai' || tts.ttsProvider === 'local')) {
      select.value = ttsDefaultVoice;
      tts.setVoice(ttsDefaultVoice);
    } else if (!isBookOpening && currentSelected && availableVoiceValues.includes(currentSelected)) {
      select.value = currentSelected;
      tts.setVoice(currentSelected);
    } else if (matchedVoices.length > 0) {
      select.value = matchedVoices[0].name;
      tts.setVoice(matchedVoices[0].name);
    } else {
      select.value = availableVoiceValues[0];
      tts.setVoice(availableVoiceValues[0]);
    }
  }
  console.log(`[TTS] Final selected voice: "${select.value}"`);
}


// ==================== 7. 文字選取、高亮劃線與筆記功能 ==================== */

// 監聽文字選取
function handleTextSelection(e) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const menu = document.getElementById('selection-menu');
    if (menu) menu.style.display = 'none';
    selectedNoteIdState = null;
    return;
  }
  const selectedText = selection.toString().trim();
  const menu = document.getElementById('selection-menu');

  if (selectedText.length > 0) {
    selectedTextState = selectedText;
    selectedTextRange = selection.getRangeAt(0).cloneRange();

    // 檢測是否為行動端，以便將選單渲染至底部
    const isMobile = window.innerWidth <= 768 || ('ontouchstart' in window);

    if (isMobile) {
      menu.classList.add('mobile-bottom-menu');
      menu.style.top = '';
      menu.style.left = '';
    } else {
      menu.classList.remove('mobile-bottom-menu');
      // 獲取選取文字坐標以顯示選單
      const rect = selectedTextRange.getBoundingClientRect();
      menu.style.top = `${rect.top + window.scrollY - 55}px`;
      menu.style.left = `${rect.left + window.scrollX + (rect.width / 2) - (menu.offsetWidth / 2)}px`;
    }

    // 檢查選取內容是否為已有的高亮/筆記
    let noteId = null;
    try {
      const startNode = selectedTextRange.startContainer;
      const startElement = startNode.nodeType === Node.ELEMENT_NODE ? startNode : startNode.parentElement;
      const highlightSpan = startElement ? startElement.closest('span[class^="highlight-"]') : null;
      if (highlightSpan) {
        noteId = highlightSpan.getAttribute('data-note-id');
      }
    } catch (err) {
      console.warn('Error reading data-note-id:', err);
    }

    const deleteBtn = document.getElementById('selection-delete-btn');
    if (noteId) {
      selectedNoteIdState = noteId;
      if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    } else {
      selectedNoteIdState = null;
      if (deleteBtn) deleteBtn.style.display = 'none';
    }

    // 確保 AI 按鈕的顯示狀態為顯示
    document.querySelectorAll('.ai-btn').forEach(btn => {
      btn.style.display = 'inline-flex';
    });

    menu.style.display = 'flex';
  } else {
    // 點擊空白處或清除選取時隱藏選單
    if (!e || !e.target || e.target.closest('#selection-menu') === null) {
      menu.style.display = 'none';
      selectedNoteIdState = null;
    }
  }
}

// 輔助函式：獲取選取範圍在句子文字內容中的起止偏移量
// 輔助函式：獲取選取範圍在句子文字內容中的起止偏移量
function getSelectionOffsets(elements, range) {
  const getBoundaryOffset = (container, offset) => {
    let found = false;
    let charOffset = 0;
    let currentOffset = 0;

    const traverse = (node) => {
      if (found) return;

      if (node === container) {
        if (node.nodeType === Node.TEXT_NODE) {
          charOffset = currentOffset + offset;
          found = true;
          return;
        } else {
          if (offset === 0) {
            charOffset = currentOffset;
            found = true;
            return;
          }
        }
      }

      if (node.parentNode === container && container.nodeType === Node.ELEMENT_NODE) {
        const idx = Array.from(container.childNodes).indexOf(node);
        if (idx === offset) {
          charOffset = currentOffset;
          found = true;
          return;
        }
      }

      if (node.nodeType === Node.TEXT_NODE) {
        currentOffset += node.nodeValue.length;
      } else {
        const children = Array.from(node.childNodes);
        for (let child of children) {
          traverse(child);
          if (found) return;
        }
        if (node === container && offset >= node.childNodes.length) {
          charOffset = currentOffset;
          found = true;
          return;
        }
      }
    };

    for (let el of elements) {
      traverse(el);
      if (found) break;
    }
    return found ? charOffset : currentOffset;
  };

  const startOffset = getBoundaryOffset(range.startContainer, range.startOffset);
  const endOffset = getBoundaryOffset(range.endContainer, range.endOffset);
  return { startOffset, endOffset };
}

// 輔助函式：在 DOM 子樹中精確高亮指定起止偏移量（或子字串）的文字節點
function applyHighlightToDOMRange(elementsOrElement, startOffset, endOffset, color, noteId, textFallback = '') {
  const elements = Array.isArray(elementsOrElement) ? elementsOrElement : [elementsOrElement];
  let start = startOffset;
  let end = endOffset;

  // 如果起止位置無效、相同或為空，則使用 textFallback 在純文字中進行子字串搜尋
  if (start === undefined || end === undefined || start === null || end === null || start >= end) {
    if (!textFallback) return;
    const totalText = elements.map(el => el.textContent).join('');
    const idx = totalText.indexOf(textFallback);
    if (idx !== -1) {
      start = idx;
      end = idx + textFallback.length;
    } else {
      return; // 找不到對應文字則跳過
    }
  }

  let currentOffset = 0;
  const nodesToWrap = [];

  const traverse = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.nodeValue.length;
      const nodeStart = currentOffset;
      const nodeEnd = currentOffset + len;

      const intersectStart = Math.max(nodeStart, start);
      const intersectEnd = Math.min(nodeEnd, end);

      if (intersectStart < intersectEnd) {
        nodesToWrap.push({
          node,
          start: intersectStart - nodeStart,
          end: intersectEnd - nodeStart
        });
      }
      currentOffset += len;
    } else {
      const children = Array.from(node.childNodes);
      for (let child of children) {
        traverse(child);
      }
    }
  };

  for (let el of elements) {
    traverse(el);
  }

  // 從後往前處理節點，避免 splitText 影響前面的 node 索引
  for (let i = nodesToWrap.length - 1; i >= 0; i--) {
    const { node, start: sOffset, end: eOffset } = nodesToWrap[i];
    let targetNode = node;
    try {
      if (sOffset > 0) {
        targetNode = node.splitText(sOffset);
      }
      if (eOffset - sOffset < targetNode.nodeValue.length) {
        targetNode.splitText(eOffset - sOffset);
      }

      const span = document.createElement('span');
      span.className = `highlight-${color}`;
      if (noteId) {
        span.setAttribute('data-note-id', noteId);
      }
      targetNode.parentNode.replaceChild(span, targetNode);
      span.appendChild(targetNode);
    } catch (err) {
      console.error('Failed to split/wrap text node for highlight:', err);
    }
  }
}

// 添加高亮劃線
async function handleAddHighlight(color) {
  if (!currentBook || !selectedTextState) return;

  const startSentenceEl = selectedTextRange.startContainer.nodeType === Node.ELEMENT_NODE 
    ? selectedTextRange.startContainer.closest('.tts-sentence') 
    : selectedTextRange.startContainer.parentNode.closest('.tts-sentence');
  
  const endSentenceEl = selectedTextRange.endContainer.nodeType === Node.ELEMENT_NODE 
    ? selectedTextRange.endContainer.closest('.tts-sentence') 
    : selectedTextRange.endContainer.parentNode.closest('.tts-sentence');

  const sentenceIndex = startSentenceEl ? parseInt(startSentenceEl.getAttribute('data-sentence-index')) : 0;
  const rawEndIndex = endSentenceEl ? parseInt(endSentenceEl.getAttribute('data-sentence-index')) : sentenceIndex;
  const endSentenceIndex = Math.max(sentenceIndex, rawEndIndex);

  let startOffset = 0;
  let endOffset = 0;
  if (startSentenceEl && selectedTextRange) {
    const container = document.getElementById('book-content');
    const sentenceElements = [];
    for (let idx = sentenceIndex; idx <= endSentenceIndex; idx++) {
      const spans = Array.from(container.querySelectorAll(`[data-sentence-index="${idx}"]`));
      sentenceElements.push(...spans);
    }
    if (sentenceElements.length > 0) {
      const offsets = getSelectionOffsets(sentenceElements, selectedTextRange);
      startOffset = offsets.startOffset;
      endOffset = offsets.endOffset;
    }
  }

  const note = {
    type: 'highlight',
    color,
    text: selectedTextState,
    chapterIndex: currentChapterIndex,
    sentenceIndex,
    endSentenceIndex,
    startOffset,
    endOffset
  };

  const updatedNotes = await library.saveNote(currentBook.id, note);
  currentBook.notes = updatedNotes;

  let savedNoteId = null;
  if (startSentenceEl && updatedNotes) {
    const savedNote = updatedNotes.find(n => n.chapterIndex === currentChapterIndex && n.sentenceIndex === sentenceIndex && n.type === 'highlight' && n.color === color);
    if (savedNote) {
      savedNoteId = savedNote.noteId;
    }
  }
  
  // 在頁面上即時繪製高亮
  highlightSelectionInDOM(color, savedNoteId);
  
  // 隱藏選單
  document.getElementById('selection-menu').style.display = 'none';
  window.getSelection().removeAllRanges();
}

// 在 DOM 中包裹高亮標籤
function highlightSelectionInDOM(color, noteId) {
  if (!selectedTextRange) return;
  const startSentenceEl = selectedTextRange.startContainer.nodeType === Node.ELEMENT_NODE 
    ? selectedTextRange.startContainer.closest('.tts-sentence') 
    : selectedTextRange.startContainer.parentNode.closest('.tts-sentence');
  
  const endSentenceEl = selectedTextRange.endContainer.nodeType === Node.ELEMENT_NODE 
    ? selectedTextRange.endContainer.closest('.tts-sentence') 
    : selectedTextRange.endContainer.parentNode.closest('.tts-sentence');

  if (startSentenceEl) {
    const sentenceIndex = parseInt(startSentenceEl.getAttribute('data-sentence-index'));
    const rawEndIndex = endSentenceEl ? parseInt(endSentenceEl.getAttribute('data-sentence-index')) : sentenceIndex;
    const endSentenceIndex = Math.max(sentenceIndex, rawEndIndex);

    const container = document.getElementById('book-content');
    const sentenceElements = [];
    for (let idx = sentenceIndex; idx <= endSentenceIndex; idx++) {
      const spans = Array.from(container.querySelectorAll(`[data-sentence-index="${idx}"]`));
      sentenceElements.push(...spans);
    }

    if (sentenceElements.length > 0) {
      const { startOffset, endOffset } = getSelectionOffsets(sentenceElements, selectedTextRange);
      applyHighlightToDOMRange(sentenceElements, startOffset, endOffset, color, noteId, selectedTextState);
    }
  }
}

// 載入已存檔的高亮
function applySavedHighlightsToDOM(targetWrapper = null, targetChapterIndex = null) {
  if (!currentBook || !currentBook.notes) return;

  const chIndex = targetChapterIndex !== null ? targetChapterIndex : currentChapterIndex;
  const container = targetWrapper || document.getElementById('book-content');

  currentBook.notes.forEach(note => {
    if (note.chapterIndex === chIndex) {
      const startIdx = note.sentenceIndex;
      const endIdx = note.endSentenceIndex !== undefined ? note.endSentenceIndex : startIdx;

      // 尋找對應的句子元素
      const sentenceElements = [];
      for (let idx = startIdx; idx <= endIdx; idx++) {
        const spans = Array.from(container.querySelectorAll(`[data-sentence-index="${idx}"]`));
        sentenceElements.push(...spans);
      }

      if (sentenceElements.length > 0) {
        const color = note.color || 'yellow';
        // 套用精確高亮範圍
        applyHighlightToDOMRange(sentenceElements, note.startOffset, note.endOffset, color, note.noteId, note.text);
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

  const sentenceEl = selectedTextRange.startContainer.nodeType === Node.ELEMENT_NODE 
    ? selectedTextRange.startContainer.closest('.tts-sentence') 
    : selectedTextRange.startContainer.parentNode.closest('.tts-sentence');
  const sentenceIndex = sentenceEl ? parseInt(sentenceEl.getAttribute('data-sentence-index')) : 0;

  let startOffset = 0;
  let endOffset = 0;
  if (sentenceEl && selectedTextRange) {
    const offsets = getSelectionOffsets(sentenceEl, selectedTextRange);
    startOffset = offsets.startOffset;
    endOffset = offsets.endOffset;
  }

  const note = {
    type: 'note',
    text: selectedTextState,
    noteText: text, // 用戶輸入的註釋
    chapterIndex: currentChapterIndex,
    sentenceIndex,
    startOffset,
    endOffset
  };

  const updatedNotes = await library.saveNote(currentBook.id, note);
  currentBook.notes = updatedNotes;

  let savedNoteId = null;
  if (sentenceEl && updatedNotes) {
    const savedNote = updatedNotes.find(n => n.chapterIndex === currentChapterIndex && n.sentenceIndex === sentenceIndex && n.type === 'note');
    if (savedNote) {
      savedNoteId = savedNote.noteId;
    }
  }
  
  // 顯示高亮代表有筆記
  highlightSelectionInDOM('yellow', savedNoteId);

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
        updateHeaderActiveStates();
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
        updateHeaderActiveStates();
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
    // Delete from DB and update the in-memory array
    const updatedNotes = await library.deleteNote(currentBook.id, noteId);
    currentBook.notes = updatedNotes;
    
    // Update the sidebar list
    await renderHighlightsList();

    // Immediately remove highlight from DOM by unwrapping matching span elements
    const container = document.getElementById('book-content');
    if (container) {
      const highlightSpans = container.querySelectorAll(`span[data-note-id="${noteId}"]`);
      highlightSpans.forEach(span => {
        span.replaceWith(...span.childNodes);
      });
    }
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

// 輕量級 Markdown 格式化解析器，為 AI 回覆提供換行、加粗、代碼與列表的結構化渲染
// 獲取 Obsidian Callout 對應的 SVG 圖標
function getCalloutIcon(type) {
  const icons = {
    note: `<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14h-2v-6h2zm0-8h-2V6h2z"/></svg>`,
    info: `<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14h-2v-6h2zm0-8h-2V6h2z"/></svg>`,
    todo: `<svg viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-9 14-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z"/></svg>`,
    tip: `<svg viewBox="0 0 24 24"><path d="M9 21h6v-1H9zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>`,
    hint: `<svg viewBox="0 0 24 24"><path d="M9 21h6v-1H9zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>`,
    important: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`,
    warning: `<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
    caution: `<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
    attention: `<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
    error: `<svg viewBox="0 0 24 24"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`,
    danger: `<svg viewBox="0 0 24 24"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`,
    bug: `<svg viewBox="0 0 24 24"><path d="M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a6.002 6.002 0 0 0-2.83 0L8.41 3 7 4.41l1.62 1.63C7.79 6.64 7.07 7.27 6.63 8H4v2h2.07c-.05.33-.07.66-.07 1v1H4v2h2v1c0 .34.02.67.07 1H4v2h2.63a5.985 5.985 0 0 0 1.82 1.96L6.83 20.4l1.41 1.41 2.17-2.17a6.002 6.002 0 0 0 2.83 0l2.17 2.17 1.41-1.41-1.62-1.63c.83-.61 1.55-1.24 1.99-1.97H20v-2h-2.07c.05-.33.07-.66.07-1v-1h2v-2h-2v-1c0-.34-.02-.67-.07-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>`,
    success: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z"/></svg>`,
    done: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z"/></svg>`,
    quote: `<svg viewBox="0 0 24 24"><path d="M6 17h3l2-4V7H5v7h3zm8 0h3l2-4V7h-6v7h3z"/></svg>`,
    example: `<svg viewBox="0 0 24 24"><path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3zM5.89 12.55L12 15.89l6.11-3.34c.66-.36 1.07-1.05 1.07-1.81V9.58L12 13.5 4.82 9.58v1.16c0 .76.41 1.45 1.07 1.81z"/></svg>`
  };
  return icons[type] || icons.note;
}

// 輕量級 Markdown 格式化解析器，為 AI 回覆提供換行、加粗、代碼、列表、表格與 Callout 的結構化渲染
function formatMarkdown(text) {
  if (!text) return '';
  
  // 1. 轉義 HTML 字符防止 XSS 注入
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
    
  // 1.1 LaTeX Math Formula Extraction (placeholder replacement to protect from markdown formatting)
  const mathBlocks = [];
  const latexMap = {
    '\\rightarrow': '→',
    '\\to': '→',
    '\\leftarrow': '←',
    '\\leftrightarrow': '↔',
    '\\Rightarrow': '⇒',
    '\\Leftarrow': '⇐',
    '\\Leftrightarrow': '⇔',
    '\\implies': '⇒',
    '\\iff': '⇔',
    '\\pm': '±',
    '\\times': '×',
    '\\div': '÷',
    '\\leq': '≤',
    '\\le': '≤',
    '\\geq': '≥',
    '\\ge': '≥',
    '\\neq': '≠',
    '\\ne': '≠',
    '\\approx': '≈',
    '\\infty': '∞',
    '\\in': '∈',
    '\\alpha': 'α',
    '\\beta': 'β',
    '\\gamma': 'γ',
    '\\delta': 'δ',
    '\\theta': 'θ',
    '\\lambda': 'λ',
    '\\mu': 'μ',
    '\\pi': 'π',
    '\\sigma': 'σ',
    '\\phi': 'φ',
    '\\omega': 'ω',
    '\\Delta': 'Δ',
    '\\Sigma': 'Σ',
    '\\Omega': 'Ω'
  };

  // Replace $$ block formulas first
  html = html.replace(/\$\$(.*?)\$\$/gs, (match, formula) => {
    let clean = formula;
    for (const [key, val] of Object.entries(latexMap)) {
      clean = clean.split(key).join(val);
    }
    const placeholder = `__MATH_BLOCK_PLACEHOLDER_${mathBlocks.length}__`;
    mathBlocks.push({
      placeholder,
      html: `<span class="math-block" style="display: block; text-align: center; margin: 0.5em 0; font-family: 'Lora', Georgia, serif; font-style: italic;">${clean}</span>`
    });
    return placeholder;
  });

  // Replace $ inline formulas next
  html = html.replace(/\$(.*?)\$/g, (match, formula) => {
    if (!formula || formula.trim() === '') return match;
    let clean = formula;
    for (const [key, val] of Object.entries(latexMap)) {
      clean = clean.split(key).join(val);
    }
    const placeholder = `__MATH_INLINE_PLACEHOLDER_${mathBlocks.length}__`;
    mathBlocks.push({
      placeholder,
      html: `<span class="math-inline" style="font-family: 'Lora', Georgia, serif; font-style: italic;">${clean}</span>`
    });
    return placeholder;
  });
    
  // 1.5 圖片處理：![alt](url) -> <img src="url" alt="alt" class="obsidian-image" loading="lazy">
  html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1" class="obsidian-image" loading="lazy">');

  // 2. 鏈接處理：[文本](鏈接) -> <a href="鏈接" target="_blank">文本</a>
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');

  // 3. 加粗：**文本** -> <strong>文本</strong>
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // 3.5 高亮 (Highlight): ==文本== -> <mark class="obsidian-highlight">文本</mark>
  html = html.replace(/==(.*?)==/g, '<mark class="obsidian-highlight">$1</mark>');

  // 3.6 刪除線 (Strikethrough): ~~文本~~ -> <del class="obsidian-del">文本</del>
  html = html.replace(/~~(.*?)~~/g, '<del class="obsidian-del">$1</del>');

  // 3.7 WikiLinks: [[鏈接|文本]] -> <span class="obsidian-wikilink">文本</span>, [[鏈接]] -> <span class="obsidian-wikilink">鏈接</span>
  html = html.replace(/\[\[([^\]]+?)\|([^\]]+?)\]\]/g, '<span class="obsidian-wikilink">$2</span>');
  html = html.replace(/\[\[([^\]]+?)\]\]/g, '<span class="obsidian-wikilink">$1</span>');

  // 4. 行內代碼：`代碼` -> <code>代碼</code> (使用斷言避免破壞 ``` 代碼塊圍欄)
  html = html.replace(/(?<!`)`(?!`)([^`\n]+?)`(?!`)/g, '<code>$1</code>');
  
  // 5. 按行解析以支持標題、列表、多行代碼塊、表格及 Callout
  const lines = html.split('\n');
  let listStack = []; // stores { type: 'ul'|'ol', indent: number }
  let inCodeBlock = false;
  let codeBlockLanguage = '';
  let inBlockquote = false;
  let inCallout = false;
  let inTable = false;
  let codeBlockLines = [];
  let calloutLines = [];
  let calloutType = '';
  let calloutTitle = '';
  let tableAlignments = [];
  let resultLines = [];
  
  function closeAllLists(resArr) {
    while (listStack.length > 0) {
      const popped = listStack.pop();
      resArr.push(popped.type === 'ul' ? '</ul>' : '</ol>');
    }
  }

  // 表格輔助解析函數
  function splitTableCells(lineStr) {
    let cells = lineStr.trim().split('|');
    if (cells[0] === '') cells.shift();
    if (cells[cells.length - 1] === '') cells.pop();
    return cells.map(c => c.trim());
  }

  function getTableAlignments(sepLineStr) {
    return splitTableCells(sepLineStr).map(cell => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let trimmed = line.trim();
    
    // 檢查代碼塊
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        // 代碼塊結束
        if (codeBlockLanguage === 'mermaid') {
          resultLines.push(`<div class="mermaid">${codeBlockLines.join('\n')}</div>`);
        } else {
          resultLines.push(`<pre><code class="language-${codeBlockLanguage || 'code'}">${codeBlockLines.join('\n')}</code></pre>`);
        }
        codeBlockLines = [];
        inCodeBlock = false;
        codeBlockLanguage = '';
      } else {
        // 代碼塊開始
        closeAllLists(resultLines);
        if (inBlockquote) { resultLines.push('</blockquote>'); inBlockquote = false; }
        if (inCallout) { closeCallout(resultLines); inCallout = false; }
        if (inTable) { resultLines.push('</tbody></table>'); inTable = false; }
        inCodeBlock = true;
        codeBlockLanguage = trimmed.substring(3).trim().toLowerCase();
      }
      continue;
    }
    
    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // 檢查表格
    if (trimmed.startsWith('|') || (inTable && trimmed.includes('|'))) {
      closeAllLists(resultLines);
      if (inBlockquote) { resultLines.push('</blockquote>'); inBlockquote = false; }
      if (inCallout) { closeCallout(resultLines); inCallout = false; }

      if (!inTable) {
        // 檢查下一行是否為表格分隔線
        const nextLine = lines[i + 1];
        const nextTrimmed = nextLine ? nextLine.trim() : '';
        const isSeparator = nextTrimmed.includes('|') && /^[|:\-\s]+$/.test(nextTrimmed);
        
        if (isSeparator) {
          inTable = true;
          tableAlignments = getTableAlignments(nextTrimmed);
          const headers = splitTableCells(line);
          
          resultLines.push('<table><thead><tr>');
          headers.forEach((header, idx) => {
            const align = tableAlignments[idx] || 'left';
            resultLines.push(`<th style="text-align: ${align};">${header}</th>`);
          });
          resultLines.push('</tr></thead><tbody>');
          
          i++; // 跳過下一行的分隔線
          continue;
        }
      } else {
        // 表格內容行
        const cells = splitTableCells(line);
        resultLines.push('<tr>');
        const colCount = tableAlignments.length;
        for (let idx = 0; idx < colCount; idx++) {
          const cell = cells[idx] || '';
          const align = tableAlignments[idx] || 'left';
          resultLines.push(`<td style="text-align: ${align};">${cell}</td>`);
        }
        resultLines.push('</tr>');
        continue;
      }
    } else if (inTable) {
      resultLines.push('</tbody></table>');
      inTable = false;
    }

    // 檢查分隔線
    if (trimmed === '---' || trimmed === '***') {
      closeAllLists(resultLines);
      if (inBlockquote) { resultLines.push('</blockquote>'); inBlockquote = false; }
      if (inCallout) { closeCallout(resultLines); inCallout = false; }
      resultLines.push('<hr>');
      continue;
    }

    // 檢查引用區塊 & Callout
    let isBlockquote = false;
    let quoteContent = '';
    if (trimmed.startsWith('&gt;')) {
      isBlockquote = true;
      if (trimmed.startsWith('&gt; ')) {
        quoteContent = trimmed.substring(5);
      } else {
        quoteContent = trimmed.substring(4);
      }
    }

    if (isBlockquote) {
      closeAllLists(resultLines);
      
      const calloutMatch = quoteContent.match(/^\[!(.*?)\]\s*(.*)/);
      if (calloutMatch && !inCallout && !inBlockquote) {
        inCallout = true;
        calloutType = calloutMatch[1].toLowerCase();
        calloutTitle = calloutMatch[2].trim() || (calloutType.charAt(0).toUpperCase() + calloutType.slice(1));
        calloutLines = [];
      } else if (inCallout) {
        calloutLines.push(quoteContent);
      } else {
        if (!inBlockquote) {
          resultLines.push('<blockquote>');
          inBlockquote = true;
        }
        resultLines.push(`<p>${quoteContent}</p>`);
      }
      continue;
    } else {
      if (inCallout) {
        closeCallout(resultLines);
        inCallout = false;
      }
      if (inBlockquote) {
        resultLines.push('</blockquote>');
        inBlockquote = false;
      }
    }

    // 檢查標題 1-6 級
    let isHeading = false;
    for (let h = 6; h >= 1; h--) {
      const prefix = '#'.repeat(h) + ' ';
      if (trimmed.startsWith(prefix)) {
        closeAllLists(resultLines);
        const headingText = trimmed.substring(h + 1).trim();
        resultLines.push(`<h${h}>${headingText}</h${h}>`);
        isHeading = true;
        break;
      }
    }
    if (isHeading) {
      continue;
    }

    // 列表解析 (支持嵌套)
    const unorderedMatch = line.match(/^(\s*)([-*]|\+)\s+(.*)/);
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);

    if (unorderedMatch || orderedMatch) {
      const isUnordered = !!unorderedMatch;
      const match = isUnordered ? unorderedMatch : orderedMatch;
      const indentStr = match[1];
      let indent = 0;
      for (let char of indentStr) {
        if (char === '\t') indent += 4;
        else indent += 1;
      }
      
      const type = isUnordered ? 'ul' : 'ol';
      const content = match[3].trim();
      
      if (listStack.length === 0) {
        resultLines.push(type === 'ul' ? '<ul>' : '<ol>');
        listStack.push({ type, indent });
      } else {
        let top = listStack[listStack.length - 1];
        if (indent > top.indent) {
          resultLines.push(type === 'ul' ? '<ul>' : '<ol>');
          listStack.push({ type, indent });
        } else {
          while (listStack.length > 0 && listStack[listStack.length - 1].indent > indent) {
            const popped = listStack.pop();
            resultLines.push(popped.type === 'ul' ? '</ul>' : '</ol>');
          }
          if (listStack.length === 0) {
            resultLines.push(type === 'ul' ? '<ul>' : '<ol>');
            listStack.push({ type, indent });
          } else {
            top = listStack[listStack.length - 1];
            if (top.type !== type) {
              resultLines.push(top.type === 'ul' ? '</ul>' : '</ol>');
              listStack.pop();
              resultLines.push(type === 'ul' ? '<ul>' : '<ol>');
              listStack.push({ type, indent });
            }
          }
        }
      }
      
      if (isUnordered) {
        let isTask = false;
        let isChecked = false;
        let taskText = content;
        if (content.startsWith('[ ] ')) {
          isTask = true;
          isChecked = false;
          taskText = content.substring(4);
        } else if (content.startsWith('[x] ') || content.startsWith('[X] ')) {
          isTask = true;
          isChecked = true;
          taskText = content.substring(4);
        }
        
        if (isTask) {
          resultLines.push(`<li class="task-list-item"><input type="checkbox" disabled ${isChecked ? 'checked' : ''}> <span>${taskText}</span></li>`);
        } else {
          resultLines.push(`<li>${content}</li>`);
        }
      } else {
        resultLines.push(`<li>${content}</li>`);
      }
      continue;
    }

    // 空行
    if (trimmed === '') {
      closeAllLists(resultLines);
      resultLines.push('<div class="empty-line"></div>');
    }
    // 普通正文行
    else {
      closeAllLists(resultLines);
      resultLines.push(`<p>${line}</p>`);
    }
  }

  // 閉合所有未結束的狀態
  if (inCodeBlock) {
    if (codeBlockLanguage === 'mermaid') {
      resultLines.push(`<div class="mermaid">${codeBlockLines.join('\n')}</div>`);
    } else {
      resultLines.push(`<pre><code class="language-${codeBlockLanguage || 'code'}">${codeBlockLines.join('\n')}</code></pre>`);
    }
  }
  closeAllLists(resultLines);
  if (inTable) {
    resultLines.push('</tbody></table>');
  }
  if (inCallout) {
    closeCallout(resultLines);
  }
  if (inBlockquote) {
    resultLines.push('</blockquote>');
  }
  
  let finalHtml = resultLines.join('\n');
  for (const block of mathBlocks) {
    finalHtml = finalHtml.split(block.placeholder).join(block.html);
  }
  return finalHtml;

  // 關閉 Callout 的輔支方法
  function closeCallout(resArr) {
    const icon = getCalloutIcon(calloutType);
    resArr.push(`<div class="obsidian-callout callout-${calloutType}">`);
    resArr.push(`  <div class="callout-title">`);
    resArr.push(`    <span class="callout-icon">${icon}</span>`);
    resArr.push(`    <span class="callout-title-inner">${calloutTitle}</span>`);
    resArr.push(`  </div>`);
    if (calloutLines.length > 0) {
      resArr.push(`  <div class="callout-content">`);
      calloutLines.forEach(l => {
        if (l.trim() !== '') {
          resArr.push(`    <p>${l}</p>`);
        }
      });
      resArr.push(`  </div>`);
    }
    resArr.push(`</div>`);
  }
}

// Helper to wrap Mermaid text to prevent overlapping node boundaries
function wrapMermaidText(text, maxLen = 10) {
  if (!text || text.length <= maxLen) return text;

  const isCJK = (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0x4E00 && code <= 0x9FFF) || 
           (code >= 0x3400 && code <= 0x4DBF) || 
           (code >= 0xF900 && code <= 0xFAFF) || 
           (code >= 0x3040 && code <= 0x309F) || 
           (code >= 0x30A0 && code <= 0x30FF) || 
           (code >= 0xac00 && code <= 0xd7af);
  };

  let result = '';
  let lineLen = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n') {
      result += '\n';
      lineLen = 0;
      continue;
    }

    result += char;
    lineLen += isCJK(char) ? 2 : 1;

    if (lineLen >= maxLen * 2) {
      if (i + 1 < text.length) {
        const nextChar = text[i + 1];
        if (nextChar === ' ') {
          result += '\n';
          lineLen = 0;
          i++; 
        } else if (isCJK(char) || isCJK(nextChar)) {
          result += '\n';
          lineLen = 0;
        } else {
          let hasSpaceSoon = false;
          for (let j = 1; j <= 5; j++) {
            if (i + j < text.length && text[i + j] === ' ') {
              hasSpaceSoon = true;
              break;
            }
          }
          if (!hasSpaceSoon) {
            result += '\n';
            lineLen = 0;
          }
        }
      }
    }
  }

  return result.replace(/\n+/g, '\n').trim();
}

// Preprocessor for Mermaid mindmap code to resolve overlaps and mixed-syntax errors
function preprocessMermaidMindmap(code, shouldWrap = true) {
  const lines = code.split('\n');
  const processedLines = [];
  let isMindmap = false;
  let nodeCounter = 0;

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      processedLines.push(line);
      continue;
    }

    if (trimmed === 'mindmap' || trimmed.startsWith('mindmap ')) {
      isMindmap = true;
      processedLines.push(line);
      continue;
    }

    if (!isMindmap) {
      processedLines.push(line);
      continue;
    }

    if (trimmed.startsWith('%%') || trimmed.startsWith('---')) {
      processedLines.push(line);
      continue;
    }

    if (trimmed.toLowerCase() === 'end') {
      continue;
    }

    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    let text = trimmed;
    if (text.toLowerCase().startsWith('subgraph ')) {
      text = text.substring(9).trim();
    }

    let shapeOpen = '';
    let shapeClose = '';

    const hasSpaceBefore = (char) => {
      const idx = text.indexOf(char);
      if (idx === -1) return true;
      return text.substring(0, idx).trim().includes(' ');
    };

    if (text.includes('((') && text.endsWith('))') && !hasSpaceBefore('((')) {
      const idx = text.indexOf('((');
      text = text.substring(idx + 2, text.length - 2);
      shapeOpen = '(("`';
      shapeClose = '`"))';
    } else if (text.includes('(') && text.endsWith(')') && !hasSpaceBefore('(')) {
      const idx = text.indexOf('(');
      text = text.substring(idx + 1, text.length - 1);
      shapeOpen = '("`';
      shapeClose = '`")';
    } else if (text.includes('[') && text.endsWith(']') && !hasSpaceBefore('[')) {
      const idx = text.indexOf('[');
      text = text.substring(idx + 1, text.length - 1);
      shapeOpen = '["`';
      shapeClose = '`"]';
    } else if (text.includes('{{') && text.endsWith('}}') && !hasSpaceBefore('{{')) {
      const idx = text.indexOf('{{');
      text = text.substring(idx + 2, text.length - 2);
      shapeOpen = '{"`';
      shapeClose = '`"}';
    } else if (text.includes(')') && text.endsWith('(') && !hasSpaceBefore(')')) {
      const idx = text.indexOf(')');
      text = text.substring(idx + 1, text.length - 1);
      shapeOpen = ')"`';
      shapeClose = '`(';
    } else {
      if (indent.length <= 2) {
        shapeOpen = '(("`';
        shapeClose = '`"))';
      } else {
        shapeOpen = '("`';
        shapeClose = '`")';
      }
    }

    text = text.replace(/^"`|`$/g, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '').trim();
    text = text.replace(/`/g, "'");

    const wrappedText = shouldWrap ? wrapMermaidText(text, 10) : text;

    nodeCounter++;
    const nodeId = 'node_' + nodeCounter;

    processedLines.push(`${indent}${nodeId}${shapeOpen}${wrappedText}${shapeClose}`);
  }

  return processedLines.join('\n');
}

const activeMindElixirs = [];
let mindElixirLoaded = false;

async function loadMindElixirLibrary() {
  if (typeof MindElixir !== 'undefined') {
    mindElixirLoaded = true;
    return;
  }
  if (mindElixirLoaded) return;
  
  try {
    await new Promise((resolve, reject) => {
      // Load CSS
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'libs/mind-elixir.css';
      link.onerror = () => {
        link.href = 'reader/libs/mind-elixir.css';
        link.onerror = () => {
          link.href = 'https://cdn.jsdelivr.net/npm/mind-elixir/dist/style.css';
        };
      };
      document.head.appendChild(link);
      
      // Load JS
      const script = document.createElement('script');
      script.src = 'libs/mind-elixir.js';
      script.onload = () => { mindElixirLoaded = true; resolve(); };
      script.onerror = () => {
        const script2 = document.createElement('script');
        script2.src = 'reader/libs/mind-elixir.js';
        script2.onload = () => { mindElixirLoaded = true; resolve(); };
        script2.onerror = () => {
          const script3 = document.createElement('script');
          script3.src = 'https://cdn.jsdelivr.net/npm/mind-elixir/dist/MindElixir.js';
          script3.onload = () => { mindElixirLoaded = true; resolve(); };
          script3.onerror = reject;
          document.body.appendChild(script3);
        };
        document.body.appendChild(script2);
      };
      document.body.appendChild(script);
    });
  } catch (err) {
    console.error('Failed to load mind-elixir library:', err);
    throw err;
  }
}

function parseMermaidMindmapToMindElixir(code) {
  const lines = code.split('\n');
  const parentStack = []; // stores { node, indent }
  let rootNode = null;
  
  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'mindmap' || trimmed.startsWith('mindmap ') || trimmed.startsWith('%%') || trimmed.startsWith('---')) {
      continue;
    }
    
    // Robust new regex with non-capturing shape groups
    const match = line.match(/^(\s*)(node_\d+)(?:[^"`\']+)"`([\s\S]*?)`"(?:[^"`\']+)$/);
    if (!match) continue;
    
    const indent = match[1].length;
    const id = match[2];
    const text = match[3];
    
    const node = {
      id: id,
      topic: text,
      children: []
    };
    
    while (parentStack.length > 0 && parentStack[parentStack.length - 1].indent >= indent) {
      parentStack.pop();
    }
    
    if (parentStack.length === 0) {
      node.root = true;
      rootNode = node;
    } else {
      parentStack[parentStack.length - 1].node.children.push(node);
    }
    
    parentStack.push({ node, indent });
  }
  
  return { nodeData: rootNode };
}

function setupMindElixirToolbar(container, mind) {
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-toolbar';
  
  const zoomInTip = (typeof getMsg === 'function' && getMsg('zoom_in')) || '放大';
  const zoomOutTip = (typeof getMsg === 'function' && getMsg('zoom_out')) || '縮小';
  const resetTip = (typeof getMsg === 'function' && getMsg('zoom_reset')) || '重置';
  
  toolbar.innerHTML = `
    <button class="mermaid-btn zoom-in" title="${zoomInTip}">＋</button>
    <button class="mermaid-btn zoom-out" title="${zoomOutTip}">－</button>
    <button class="mermaid-btn zoom-reset" title="${resetTip}">↺</button>
  `;
  container.appendChild(toolbar);
  
  toolbar.querySelector('.zoom-in').addEventListener('click', (e) => {
    e.stopPropagation();
    mind.scale(mind.scaleVal + 0.1);
  });
  
  toolbar.querySelector('.zoom-out').addEventListener('click', (e) => {
    e.stopPropagation();
    mind.scale(mind.scaleVal - 0.1);
  });
  
  toolbar.querySelector('.zoom-reset').addEventListener('click', (e) => {
    e.stopPropagation();
    mind.toCenter();
  });
}

let mermaidLoaded = false;
async function renderMermaidBlocks() {
  const panel = document.getElementById('ai-panel');
  if (!panel || (panel.style.display !== 'flex' && panel.style.display !== 'block')) {
    return; // Skip rendering if the AI panel is hidden to avoid SVG measurement errors
  }

  const containers = document.querySelectorAll('#ai-content .mermaid:not([data-processed="true"])');
  if (containers.length === 0) return;

  if (!mermaidLoaded) {
    if (typeof mermaid === 'undefined') {
      // 動態載入 fallback（僅用於 Web/PWA 版本，擴充功能版已在 HTML 中靜態引入）
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'libs/mermaid.min.js';
          script.onload = () => {
            mermaidLoaded = true;
            resolve();
          };
          script.onerror = () => {
            // Web 版本嘗試 reader/libs/ 路徑
            const script2 = document.createElement('script');
            script2.src = 'reader/libs/mermaid.min.js';
            script2.onload = () => {
              mermaidLoaded = true;
              resolve();
            };
            script2.onerror = () => {
              // CDN 載入備用方式 1 (jsDelivr)
              const script3 = document.createElement('script');
              script3.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
              script3.onload = () => {
                mermaidLoaded = true;
                resolve();
              };
              script3.onerror = () => {
                // CDN 載入備用方式 2 (cdnjs)
                const script4 = document.createElement('script');
                script4.src = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js';
                script4.onload = () => {
                  mermaidLoaded = true;
                  resolve();
                };
                script4.onerror = () => {
                  console.error('Failed to load mermaid library from local and CDNs');
                  reject(new Error('Mermaid load error'));
                };
                document.body.appendChild(script4);
              };
              document.body.appendChild(script3);
            };
            document.body.appendChild(script2);
          };
          document.body.appendChild(script);
        });
      } catch (err) {
        console.error(err);
        // 載入失敗時，將所有 mermaid 容器降級為代碼塊顯示
        for (const container of containers) {
          container.setAttribute('data-processed', 'true');
          const code = container.textContent.trim();
          container.innerHTML = `<pre class="mermaid-fallback"><code>${code}</code></pre>`;
        }
        return;
      }
    } else {
      mermaidLoaded = true;
    }
    if (mermaidLoaded) {
      mermaid.initialize({
        startOnLoad: false,
        theme: document.body.classList.contains('theme-dark') ? 'dark' : 'default',
        securityLevel: 'loose',
        mindmap: {
          useMaxWidth: false,
          nodeSpacing: 120,
          rankSpacing: 90,
          padding: 15
        }
      });
    }
  }

  if (mermaidLoaded || typeof MindElixir !== 'undefined' || mindElixirLoaded) {
    // 逐個容器渲染，單個失敗不影響其他
    for (const container of containers) {
      let code = container.textContent.trim();
      
      // Check if it's a mindmap block, render with Mind-Elixir
      if (code.startsWith('mindmap') || code.includes('\nmindmap')) {
        container.setAttribute('data-processed', 'true');
        try {
          await loadMindElixirLibrary();
          
          // Preprocess (bypassing wrap to keep single-line nodes)
          const preprocessedCode = preprocessMermaidMindmap(code, false);
          const parsedData = parseMermaidMindmapToMindElixir(preprocessedCode);
          
          container.innerHTML = '';
          container.style.position = 'relative';
          container.style.overflow = 'hidden';
          container.style.userSelect = 'none';
          container.classList.add('mindelixir-container');
          
          const canvasContainer = document.createElement('div');
          canvasContainer.className = 'mindelixir-canvas';
          canvasContainer.style.width = '100%';
          canvasContainer.style.height = '100%';
          container.appendChild(canvasContainer);
          
          // Generate a deterministic storage key based on the raw Mermaid mindmap code text
          const getHashCode = (str) => {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
              hash = (hash << 5) - hash + str.charCodeAt(i);
              hash |= 0;
            }
            return 'mindelixir_data_' + hash;
          };
          const storageKey = getHashCode(code);
          
          // Check if we have saved data in localStorage
          let data = null;
          const savedStr = localStorage.getItem(storageKey);
          if (savedStr) {
            try {
              data = JSON.parse(savedStr);
            } catch (err) {
              console.warn('Failed to parse cached mind-elixir data:', err);
            }
          }
          
          if (!data) {
            data = parsedData;
          }
          
          const isDark = document.body.classList.contains('theme-dark') || document.body.classList.contains('theme-oled');
          
          const mind = new MindElixir({
            el: canvasContainer,
            direction: MindElixir.SIDE,
            editable: true,
            toolBar: false,
            contextMenu: false,
            theme: isDark ? MindElixir.DARK_THEME : MindElixir.THEME
          });
          
          mind.init(data);
          activeMindElixirs.push({ mind, container });
          
          setupMindElixirToolbar(container, mind);
          
          // Listen to operations and auto-save
          const saveState = () => {
            try {
              const currentData = mind.getData();
              localStorage.setItem(storageKey, JSON.stringify(currentData));
            } catch (err) {
              console.warn('Failed to save mind-elixir data:', err);
            }
          };
          
          mind.bus.addListener('operation', saveState);
          mind.bus.addListener('expandNode', saveState);
          
          continue; // Rendered successfully, skip Mermaid flowchart flow
        } catch (err) {
          console.warn('Mind-Elixir mindmap render failed, falling back to Mermaid:', err);
          // Fall back to Mermaid rendering flow below
        }
      }
      
      // Normal Mermaid rendering flow (e.g. flowcharts, sequence diagrams, or mindmap fallback)
      container.setAttribute('data-processed', 'true');
      if (mermaidLoaded) {
        if (code.startsWith('mindmap') || code.includes('\nmindmap')) {
          code = preprocessMermaidMindmap(code);
          const nodeCount = (code.match(/node_\d+/g) || []).length;
          let nodeSpacing = 120;
          let rankSpacing = 90;
          if (nodeCount > 30) {
            nodeSpacing = 160;
            rankSpacing = 120;
          } else if (nodeCount > 15) {
            nodeSpacing = 140;
            rankSpacing = 100;
          }
          if (!code.includes('%%{init') && !code.startsWith('---')) {
            code = `%%{init: { "mindmap": { "nodeSpacing": ${nodeSpacing}, "rankSpacing": ${rankSpacing}, "padding": 15 } } }%%\n` + code;
          }
        }
        
        try {
          const id = 'mermaid_' + Math.random().toString(36).substr(2, 9);
          const { svg } = await mermaid.render(id, code, container);
          container.innerHTML = svg;
          setupMermaidPanZoom(container);
        } catch (err) {
          console.warn('Mermaid render failed for block, falling back to code display:', err.message || err);
          container.innerHTML = `<pre class="mermaid-fallback"><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
        }
      } else {
        container.innerHTML = `<pre class="mermaid-fallback"><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
      }
    }
  }
}

// 設置 Mermaid 思維導圖拖曳、縮放與自適應
function setupMermaidPanZoom(container) {
  const svgEl = container.querySelector('svg');
  if (!svgEl) return;

  // 用 wrapper 包裹 SVG
  const wrapper = document.createElement('div');
  wrapper.className = 'mermaid-wrapper';
  
  // 將 SVG 移動到 wrapper 中
  svgEl.parentNode.insertBefore(wrapper, svgEl);
  wrapper.appendChild(svgEl);

  // 添加悬浮控制工具栏
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-toolbar';
  
  const zoomInTip = (typeof getMsg === 'function' && getMsg('zoom_in')) || '放大';
  const zoomOutTip = (typeof getMsg === 'function' && getMsg('zoom_out')) || '縮小';
  const resetTip = (typeof getMsg === 'function' && getMsg('zoom_reset')) || '重置';
  
  toolbar.innerHTML = `
    <button class="mermaid-btn zoom-in" title="${zoomInTip}">＋</button>
    <button class="mermaid-btn zoom-out" title="${zoomOutTip}">－</button>
    <button class="mermaid-btn zoom-reset" title="${resetTip}">↺</button>
  `;
  container.appendChild(toolbar);

  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  function updateTransform() {
    wrapper.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  // 鼠標拖拽事件
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 僅限左鍵
    if (e.target.closest('.mermaid-toolbar')) return;
    e.preventDefault();
    
    isDragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    wrapper.classList.add('dragging');
  });

  const onMouseMove = (e) => {
    if (!container.isConnected) {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      return;
    }
    if (!isDragging) return;
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    updateTransform();
  };

  const onMouseUp = () => {
    if (!container.isConnected) {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      return;
    }
    if (isDragging) {
      isDragging = false;
      wrapper.classList.remove('dragging');
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  // 觸摸拖拽事件
  container.addEventListener('touchstart', (e) => {
    if (e.target.closest('.mermaid-toolbar')) return;
    if (e.touches.length === 1) {
      isDragging = true;
      startX = e.touches[0].clientX - translateX;
      startY = e.touches[0].clientY - translateY;
      wrapper.classList.add('dragging');
    }
  }, { passive: true });

  const onTouchMove = (e) => {
    if (!container.isConnected) {
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      return;
    }
    if (!isDragging) return;
    if (e.touches.length === 1) {
      translateX = e.touches[0].clientX - startX;
      translateY = e.touches[0].clientY - startY;
      updateTransform();
    }
  };

  const onTouchEnd = () => {
    if (!container.isConnected) {
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      return;
    }
    if (isDragging) {
      isDragging = false;
      wrapper.classList.remove('dragging');
    }
  };

  window.addEventListener('touchmove', onTouchMove, { passive: true });
  window.addEventListener('touchend', onTouchEnd);

  // 滾輪縮放事件
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = 1.1;
    const oldScale = scale;

    if (e.deltaY < 0) {
      scale = Math.min(scale * zoomFactor, 5);
    } else {
      scale = Math.max(scale / zoomFactor, 0.3);
    }

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    translateX = mouseX - (mouseX - translateX) * (scale / oldScale);
    translateY = mouseY - (mouseY - translateY) * (scale / oldScale);

    updateTransform();
  }, { passive: false });

  // 工具欄按鈕事件
  toolbar.querySelector('.zoom-in').addEventListener('click', (e) => {
    e.stopPropagation();
    scale = Math.min(scale * 1.2, 5);
    updateTransform();
  });

  toolbar.querySelector('.zoom-out').addEventListener('click', (e) => {
    e.stopPropagation();
    scale = Math.max(scale / 1.2, 0.3);
    updateTransform();
  });

  toolbar.querySelector('.zoom-reset').addEventListener('click', (e) => {
    e.stopPropagation();
    scale = 1;
    translateX = 0;
    translateY = 0;
    updateTransform();
  });

  // 雙擊重置
  container.addEventListener('dblclick', (e) => {
    if (e.target.closest('.mermaid-toolbar')) return;
    scale = 1;
    translateX = 0;
    translateY = 0;
    updateTransform();
  });

  // 使用 ResizeObserver 監聽容器大小變化（例如 AI 伴侶面板拖曳拉寬/窄時，若處於預設比例則重置位置以保持置中）
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (!container.isConnected) {
        observer.disconnect();
        return;
      }
      if (scale === 1 && (translateX !== 0 || translateY !== 0)) {
        translateX = 0;
        translateY = 0;
        updateTransform();
      }
    });
    observer.observe(container);
  }
}

// 獲取預設的 AI 提問提示詞列表
function getAISuggestions() {
  return [
    {
      key: 'ai_suggest_sum_chapter',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
      label: getMsg('ai_suggest_sum_chapter_lbl') || '总结本章',
      prompt: getMsg('ai_suggest_sum_chapter_prt') || '帮我总结当前章节的核心观点与主要内容。'
    },
    {
      key: 'ai_suggest_chapter_map',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3zM6 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z"></path><path d="M18 8h-3v8h3M6 8h3v8H6"></path></svg>',
      label: getMsg('ai_suggest_chapter_map_lbl') || '本章思维导图',
      prompt: getMsg('ai_suggest_chapter_map_prt') || '请梳理当前章节的内容结构，输出一份 Mermaid mindmap 思维导图。严格要求：1) 必须以 ```mermaid 代码块包裹；2) 第一行写 mindmap；3) 纯缩进表示层级，禁止使用箭头 -->、::icon()、subgraph 等语法；4) 节点文本不要包含括号或特殊符号；5) 节点文本必须非常简短（建议不超过 10 个字，最好 2-4 个字），绝对不要输出长句或段落以防止节点重叠；6) 参考格式：mindmap\n  root(主题)\n    分支1\n      子节点A\n      子节点B\n    分支2\n      子节点C'
    },
    {
      key: 'ai_suggest_book_map',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>',
      label: getMsg('ai_suggest_book_map_lbl') || '全书思维导图',
      prompt: getMsg('ai_suggest_book_map_prt') || '请结合全书检索到的脉络，梳理本书的整体架构与核心章节逻辑，输出一份 Mermaid mindmap 思维导图。严格要求：1) 必须以 ```mermaid 代码块包裹；2) 第一行写 mindmap；3) 纯缩进表示层级，禁止使用箭头 -->、::icon()、subgraph 等语法；4) 节点文本不要包含括号或特殊符号；5) 节点文本必须非常简短（建议不超过 10 个字，最好 2-4 个字），绝对不要输出长句或段落以防止节点重叠；6) 参考格式：mindmap\n  root(书名)\n    第一部分\n      要点1\n      要点2\n    第二部分\n      要点3'
    },
    {
      key: 'ai_suggest_takeaways',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
      label: getMsg('ai_suggest_takeaways_lbl') || '核心要点',
      prompt: getMsg('ai_suggest_takeaways_prt') || '分析当前章节或全书中最重要的 3-5 个核心知识点与启示（Key Takeaways）。'
    },
    {
      key: 'ai_suggest_characters',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
      label: getMsg('ai_suggest_characters_lbl') || '人物关系',
      prompt: getMsg('ai_suggest_characters_prt') || '梳理本书中出现的主要人物、角色背景及其相互之间的关系脉络。'
    },
    {
      key: 'ai_suggest_explain_concept',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
      label: getMsg('ai_suggest_explain_concept_lbl') || '名词解释',
      prompt: getMsg('ai_suggest_explain_concept_prt') || '解释本书当前上下文中提到的核心专业术语或深奥概念。'
    },
    {
      key: 'ai_suggest_quiz',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
      label: getMsg('ai_suggest_quiz_lbl') || '阅读自测',
      prompt: getMsg('ai_suggest_quiz_prt') || '根据当前章节的内容，为我设计 3 道阅读理解或自测思考题，帮助我加深理解。'
    }
  ];
}

// 初始化快捷提示词标标签栏
// 初始化快捷提示词标签栏
function initAISuggestions() {
  const container = document.getElementById('ai-suggestions-container');
  if (!container) return;

  container.innerHTML = '';
  
  aiPromptsTemplatesList.forEach((item, index) => {
    const chip = document.createElement('div');
    chip.className = 'ai-suggestion-chip';
    
    // Set custom or default icon
    let iconHTML = item.icon || DEFAULT_CUSTOM_ICON;
    if (item.key && AI_SUGGESTION_ICONS[item.key]) {
      iconHTML = AI_SUGGESTION_ICONS[item.key];
    }
    
    chip.innerHTML = `${iconHTML}<span>${item.label}</span>`;
    
    // Add edit button (pencil icon)
    const editBtn = document.createElement('button');
    editBtn.className = 'chip-edit-btn';
    editBtn.type = 'button';
    editBtn.title = getMsg('btn_edit') || 'Edit';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
    
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent executing prompt query
      openPromptEditDialog(item, index);
    });
    
    chip.appendChild(editBtn);
    
    chip.addEventListener('click', () => {
      const inputEl = document.getElementById('ai-input');
      if (inputEl) {
        inputEl.value = item.prompt;
        // 触发自适应高度
        inputEl.style.height = 'auto';
        inputEl.style.height = inputEl.scrollHeight + 'px';
        sendCustomAIQuery();
      }
    });
    
    container.appendChild(chip);
  });
  
  // Add "+" dashed chip at the end
  const addChip = document.createElement('div');
  addChip.className = 'ai-suggestion-chip add-prompt-chip';
  addChip.innerHTML = `<svg class="svg-icon" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span>${getMsg('ai_add_prompt') || 'Add'}</span>`;
  addChip.addEventListener('click', () => {
    openPromptEditDialog(null, -1);
  });
  container.appendChild(addChip);
}

function openPromptEditDialog(item, index) {
  currentEditingPromptIndex = index;
  const dialog = document.getElementById('ai-prompt-edit-dialog');
  const form = document.getElementById('ai-prompt-edit-form');
  const title = document.getElementById('ai-prompt-dialog-title');
  const nameInput = document.getElementById('ai-prompt-name-input');
  const contentInput = document.getElementById('ai-prompt-content-input');
  const deleteBtn = document.getElementById('ai-prompt-dialog-delete');
  
  if (!dialog || !form || !nameInput || !contentInput || !deleteBtn) return;
  
  // Reset form validation styles or messages if any
  form.reset();
  
  if (item) {
    // Edit mode
    if (title) {
      title.textContent = getMsg('ai_prompt_edit_title') || 'Edit Prompt Template';
      title.setAttribute('data-i18n', 'ai_prompt_edit_title');
    }
    nameInput.value = item.label;
    contentInput.value = item.prompt;
    deleteBtn.style.display = 'block';
  } else {
    // Add mode
    if (title) {
      title.textContent = getMsg('ai_prompt_add_title') || 'Add Prompt Template';
      title.setAttribute('data-i18n', 'ai_prompt_add_title');
    }
    nameInput.value = '';
    contentInput.value = '';
    deleteBtn.style.display = 'none';
  }
  
  dialog.showModal();
}

// 渲染本書的 AI 溝通歷史記錄
function renderAIChatHistory() {
  const contentEl = document.getElementById('ai-content');
  if (!contentEl) return;

  contentEl.innerHTML = '';
  
  const chats = currentBook && currentBook.aiChats ? currentBook.aiChats : [];
  if (chats.length === 0) {
    // 渲染默認歡迎語
    contentEl.innerHTML = `
      <div class="ai-chat-bubble assistant-bubble">
        ${getMsg('ai_welcome_msg') || 'Hi! I am your AI Reading Assistant. How can I help you today?'}
      </div>
    `;
    return;
  }

  chats.forEach(chat => {
    const groupEl = document.createElement('div');
    groupEl.className = 'ai-chat-group';
    groupEl.setAttribute('data-chat-id', chat.chatId);

    // 使用者提問氣泡
    const userBubble = document.createElement('div');
    userBubble.className = 'ai-chat-bubble user-bubble';
    userBubble.textContent = chat.query;
    groupEl.appendChild(userBubble);

    // AI 回答氣泡
    const assistantBubble = document.createElement('div');
    assistantBubble.className = 'ai-chat-bubble assistant-bubble';
    assistantBubble.innerHTML = formatMarkdown(chat.reply);
    groupEl.appendChild(assistantBubble);

    // 添加刪除按鈕
    addDeleteButtonToGroup(groupEl, chat);

    contentEl.appendChild(groupEl);
  });

  contentEl.scrollTop = contentEl.scrollHeight;
  renderMermaidBlocks();
}

// 給對話組添加刪除按鈕
function addDeleteButtonToGroup(groupEl, chat) {
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-chat-btn';
  deleteBtn.setAttribute('data-i18n-title', 'ai_delete_chat_title');
  deleteBtn.setAttribute('title', getMsg('ai_delete_chat_title') || 'Delete conversation');
  deleteBtn.innerHTML = `
    <svg class="svg-icon svg-icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
  `;
  
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const confirmMsg = getMsg('confirm_delete_single_chat') || '確定要刪除這條溝通記錄嗎？';
    if (confirm(confirmMsg)) {
      try {
        const updatedChats = await library.deleteAIChat(currentBook.id, chat.chatId);
        currentBook.aiChats = updatedChats;
        
        // 刪除動畫
        groupEl.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
        groupEl.style.opacity = '0';
        groupEl.style.transform = 'scale(0.92)';
        setTimeout(() => {
          groupEl.remove();
          const contentEl = document.getElementById('ai-content');
          if (contentEl && contentEl.querySelectorAll('.ai-chat-group').length === 0) {
            renderAIChatHistory(); // 如果空了，重新渲染歡迎詞
          }
        }, 250);
      } catch (err) {
        console.error('Failed to delete chat:', err);
        alert(getMsg('error_prefix') + ': ' + err.message);
      }
    }
  });
  groupEl.appendChild(deleteBtn);
}

// 打開 AI 面板並顯示載入中
function showAILoading(typeLabel, textContext) {
  const panel = document.getElementById('ai-panel');
  const content = document.getElementById('ai-content');
  panel.style.display = 'flex';
  
  // 如果只有歡迎詞（無對話組），清除之
  if (content.querySelectorAll('.ai-chat-group').length === 0) {
    content.innerHTML = '';
  }

  // 1. 建立對話組容器
  const groupEl = document.createElement('div');
  groupEl.className = 'ai-chat-group';
  const tempChatId = 'chat_temp_' + Date.now();
  groupEl.setAttribute('data-chat-id', tempChatId);

  // 2. 插入使用者提問氣泡 (帶有操作類型)
  const queryText = `[${typeLabel}] ${textContext}`;
  const userBubble = document.createElement('div');
  userBubble.className = 'ai-chat-bubble user-bubble';
  userBubble.textContent = queryText;
  groupEl.appendChild(userBubble);

  // 3. 插入 AI 思考氣泡
  const assistantBubble = document.createElement('div');
  assistantBubble.className = 'ai-chat-bubble assistant-bubble';
  assistantBubble.id = 'ai-active-assistant-bubble'; // 方便流式更新
  assistantBubble.innerHTML = `
    <div class="ai-loading" style="padding: 0; justify-content: flex-start; gap: 6px;">
      <div class="ai-loading-spinner" style="width: 14px; height: 14px;"></div>
      <span>${getMsg('ai_thinking') || 'Thinking...'}</span>
    </div>
  `;
  groupEl.appendChild(assistantBubble);

  content.appendChild(groupEl);
  content.scrollTop = content.scrollHeight;

  return { groupEl, queryText, assistantBubble };
}
// ==================== AI 精準上下文提取輔助函數 ====================

/**
 * 獲取當前邏輯章節的純文本內容。
 * 利用 TTS 引擎已解析的 sentences 陣列精確過濾出 currentChapterIndex 對應的文本，
 * 解決多個 TOC 條目共享同一 XHTML 文件時，#book-content 包含跨章內容的問題。
 */
function getCurrentChapterText() {
  // 方法 1：利用 tts.sentences（最精確，每個句子都標記了所屬的 chapterIndex）
  if (tts && tts.sentences && tts.sentences.length > 0) {
    const chapterSentences = tts.sentences.filter(s => s.chapterIndex === currentChapterIndex);
    if (chapterSentences.length > 0) {
      return chapterSentences.map(s => s.text).join('\n');
    }
  }

  // 方法 2：利用 DOM 中的 hash 錨點邊界手動截取子章節文本
  const bookContentEl = document.getElementById('book-content');
  if (!bookContentEl) return '';

  if (epubBookData && epubBookData.chapters && currentChapterIndex >= 0) {
    const currentChapter = epubBookData.chapters[currentChapterIndex];
    if (currentChapter) {
      // 找出同一物理文件的所有子章節
      const siblings = [];
      epubBookData.chapters.forEach((ch, idx) => {
        if (ch.cleanHref === currentChapter.cleanHref) {
          siblings.push({ chapter: ch, index: idx });
        }
      });

      // 如果有多個子章節共用一個文件，需要精確截取
      if (siblings.length > 1 && currentChapter.hash) {
        const startAnchor = document.getElementById(currentChapter.hash) ||
                            bookContentEl.querySelector(`[name="${currentChapter.hash.replace(/"/g, '\\"')}"]`);
        if (startAnchor) {
          // 找下一個子章節的錨點作為結束邊界
          const currentSiblingIdx = siblings.findIndex(s => s.index === currentChapterIndex);
          let endAnchor = null;
          if (currentSiblingIdx >= 0 && currentSiblingIdx < siblings.length - 1) {
            const nextSibling = siblings[currentSiblingIdx + 1];
            if (nextSibling.chapter.hash) {
              endAnchor = document.getElementById(nextSibling.chapter.hash) ||
                          bookContentEl.querySelector(`[name="${nextSibling.chapter.hash.replace(/"/g, '\\"')}"]`);
            }
          }

          // 收集 startAnchor 到 endAnchor 之間的所有文字
          const texts = [];
          const walker = document.createTreeWalker(bookContentEl, NodeFilter.SHOW_TEXT, null);
          let inRange = false;
          let node;
          while ((node = walker.nextNode())) {
            if (!inRange) {
              if (startAnchor.contains(node) || startAnchor === node.parentNode ||
                  startAnchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
                inRange = true;
              }
            }
            if (inRange) {
              if (endAnchor && (endAnchor.contains(node) || endAnchor === node.parentNode ||
                  endAnchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ||
                  endAnchor === node)) {
                break;
              }
              const txt = node.textContent.trim();
              if (txt) texts.push(txt);
            }
          }
          if (texts.length > 0) {
            return texts.join('\n');
          }
        }
      }
    }
  }

  // 方法 3：回退到清理後的整個 #book-content 文本
  const clone = bookContentEl.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, iframe, link[rel="stylesheet"]').forEach(el => el.remove());
  return clone.textContent.trim();
}

/**
 * 獲取當前可見頁面的純文本內容。
 * 在翻頁模式下，根據 currentPageIndex 計算可見視口範圍並提取對應句子；
 * 在連續滾動模式下，提取視口範圍內可見的句子。
 */
function getCurrentPageText() {
  const isPaginated = document.body.classList.contains('layout-paginated');

  // 利用 TTS sentences 進行精準提取
  if (tts && tts.sentences && tts.sentences.length > 0) {
    const container = document.getElementById('reader-container');
    const bookContentEl = document.getElementById('book-content');
    if (!container || !bookContentEl) return getCurrentChapterText();

    if (isPaginated) {
      // 翻頁模式：根據 currentPageIndex 和容器寬度計算可見區域
      const { containerWidth, columnGap } = getPaginatedPagesInfo();
      if (containerWidth <= 0) return getCurrentChapterText();

      const containerRect = container.getBoundingClientRect();
      const paddingLeft = parseFloat(window.getComputedStyle(container).paddingLeft) || 0;
      
      // 可見區域的左右邊界（相對於 viewport）
      const viewportLeft = containerRect.left + paddingLeft;
      const viewportRight = viewportLeft + containerWidth;

      const visibleTexts = [];
      for (const sentence of tts.sentences) {
        if (!sentence.element) continue;
        const rect = sentence.element.getBoundingClientRect();
        // 元素至少部分在可見視口內
        if (rect.right > viewportLeft && rect.left < viewportRight && rect.height > 0) {
          visibleTexts.push(sentence.text);
        }
      }
      if (visibleTexts.length > 0) {
        return visibleTexts.join('\n');
      }
    } else {
      // 連續滾動模式：提取視口內可見的句子
      const viewportTop = 0;
      const viewportBottom = window.innerHeight;
      
      const visibleTexts = [];
      for (const sentence of tts.sentences) {
        if (!sentence.element) continue;
        const rect = sentence.element.getBoundingClientRect();
        if (rect.bottom > viewportTop && rect.top < viewportBottom && rect.height > 0) {
          visibleTexts.push(sentence.text);
        }
      }
      if (visibleTexts.length > 0) {
        return visibleTexts.join('\n');
      }
    }
  }

  // 回退：使用章節全文
  return getCurrentChapterText();
}

// 本地分析實體及共現矩陣 (0 Token)
function extractEntitiesAndCooccurrence(chunks) {
  if (!chunks || chunks.length === 0) return '';

  const nameMap = {};
  const conceptMap = {};
  
  // 對話標記人名提取及專有名词匹配 (Chinese Dialogue & English Capitalized names)
  const chDialogueRegex = /([\u4e00-\u9fa5]{2,3})(?:说|道|喊|叫|笑|叹|问道|回答|冷笑|怒道)/g;
  const quoteRegex = /“([\u4e00-\u9fa5]{2,6})”/g;
  const titleRegex = /《([\u4e00-\u9fa5]{2,12})》/g;
  const enNameRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;

  // 1. 掃描所有段落，提取實體候選
  for (const chunk of chunks) {
    const text = chunk.text;
    
    let match;
    chDialogueRegex.lastIndex = 0;
    while ((match = chDialogueRegex.exec(text)) !== null) {
      const name = match[1];
      if (!/我|你|他|她|它|谁|这|那|您|咱|哥|姐|爸|妈|阿/.test(name)) {
        nameMap[name] = (nameMap[name] || 0) + 1;
      }
    }
    
    quoteRegex.lastIndex = 0;
    while ((match = quoteRegex.exec(text)) !== null) {
      const term = match[1];
      if (term.length >= 2 && !/我|你|他|她|它|这|那|什么|怎么/.test(term)) {
        conceptMap[term] = (conceptMap[term] || 0) + 0.5;
      }
    }

    titleRegex.lastIndex = 0;
    while ((match = titleRegex.exec(text)) !== null) {
      const title = match[1];
      conceptMap[title] = (conceptMap[title] || 0) + 2.0;
    }

    enNameRegex.lastIndex = 0;
    while ((match = enNameRegex.exec(text)) !== null) {
      const enName = match[1];
      if (!/^(The|And|But|For|Or|So|Yet|To|At|By|In|On|Of|With|He|She|It|They|We|You|I|This|That)$/.test(enName)) {
        nameMap[enName] = (nameMap[enName] || 0) + 1;
      }
    }
  }

  // 2. 篩選高頻實體
  const topNames = Object.entries(nameMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(x => x[0]);

  const topConcepts = Object.entries(conceptMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(x => x[0]);

  const allEntities = [...topNames, ...topConcepts];
  if (allEntities.length === 0) return '';

  // 3. 計算共現頻次
  const matrix = {};
  for (const entity of allEntities) {
    matrix[entity] = {};
  }

  for (const chunk of chunks) {
    const text = chunk.text;
    const present = allEntities.filter(entity => text.includes(entity));
    
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const e1 = present[i];
        const e2 = present[j];
        matrix[e1][e2] = (matrix[e1][e2] || 0) + 1;
        matrix[e2][e1] = (matrix[e2][e1] || 0) + 1;
      }
    }
  }

  // 4. 格式化輸出報告
  let summary = '[Local Entity Co-occurrence Analysis]\n';
  if (topNames.length > 0) {
    summary += `Top Characters/Entities: ${topNames.join(', ')}\n`;
  }
  if (topConcepts.length > 0) {
    summary += `Top Concepts/Book Terms: ${topConcepts.join(', ')}\n`;
  }
  
  summary += '\nEntity Associations (Frequent Paragraph Co-occurrences):\n';
  let associationsCount = 0;
  for (const e1 of allEntities) {
    const rels = Object.entries(matrix[e1])
      .filter(x => x[1] >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    if (rels.length > 0) {
      summary += `- ${e1} ➔ ${rels.map(r => `${r[0]} (${r[1]} times)`).join(', ')}\n`;
      associationsCount++;
    }
  }

  if (associationsCount === 0) return '';
  return summary + '[End of Local Entity Analysis]\n';
}

// 顯示本地保存的深度分析摘要
function displayBookSummary(summary) {
  const contentEl = document.getElementById('ai-content');
  if (!contentEl) return;
  
  if (contentEl.querySelectorAll('.ai-chat-group').length === 0) {
    contentEl.innerHTML = '';
  }
  
  const groupEl = document.createElement('div');
  groupEl.className = 'ai-chat-group';
  contentEl.appendChild(groupEl);
  
  const userBubble = document.createElement('div');
  userBubble.className = 'ai-chat-bubble user-bubble';
  userBubble.textContent = getMsg('ai_deep_analysis_trigger') || '一鍵全書深度分析';
  groupEl.appendChild(userBubble);
  
  const assistantBubble = document.createElement('div');
  assistantBubble.className = 'ai-chat-bubble assistant-bubble';
  assistantBubble.innerHTML = formatMarkdown(summary);
  groupEl.appendChild(assistantBubble);
  
  contentEl.scrollTop = contentEl.scrollHeight;
  renderMermaidBlocks();
}

// 執行全書深度分析報告
async function runDeepBookAnalysis() {
  const panel = document.getElementById('ai-panel');
  const contentEl = document.getElementById('ai-content');
  if (!panel || !contentEl) return;
  
  panel.style.display = 'flex';
  updateHeaderActiveStates();
  
  if (contentEl.querySelectorAll('.ai-chat-group').length === 0) {
    contentEl.innerHTML = '';
  }
  
  const groupEl = document.createElement('div');
  groupEl.className = 'ai-chat-group';
  contentEl.appendChild(groupEl);
  
  const userBubble = document.createElement('div');
  userBubble.className = 'ai-chat-bubble user-bubble';
  userBubble.textContent = getMsg('ai_deep_analysis_trigger') || '一鍵全書深度分析';
  groupEl.appendChild(userBubble);
  
  const assistantBubble = document.createElement('div');
  assistantBubble.className = 'ai-chat-bubble assistant-bubble';
  groupEl.appendChild(assistantBubble);
  
  contentEl.scrollTop = contentEl.scrollHeight;
  
  try {
    assistantBubble.innerHTML = `
      <div class="ai-loading" style="padding: 0; justify-content: flex-start; gap: 6px;">
        <div class="ai-loading-spinner" style="width: 14px; height: 14px;"></div>
        <span>正在掃描全書實體與關聯網 (0 Token)...</span>
      </div>
    `;
    
    if (bookChunksCache.length === 0) {
      await buildBookSearchIndex();
    }
    
    const entitySummary = extractEntitiesAndCooccurrence(bookChunksCache);
    const chapters = (epubBookData && epubBookData.chapters) ? epubBookData.chapters : [];
    const chapterTitles = chapters.map((ch, idx) => `${idx + 1}. ${ch.title}`).join('\n');
    
    // ===== 階段一：Map 階段（逐章進行增量內容分析與摘要） =====
    const tempParser = new DOMParser();
    const chapterSummaries = currentBook.chapterSummaries || {};
    
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      
      // 如果該章節摘要已存儲在 IndexedDB 中，直接跳過 AI 調用
      if (chapterSummaries[i] && !chapterSummaries[i].startsWith('[章節摘要分析失敗')) {
        console.log(`Chapter ${i + 1} summary loaded from local IndexedDB cache.`);
        continue;
      }
      
      if (typeof ch.getContent !== 'function') continue;
      
      // 顯示閱讀進度
      assistantBubble.innerHTML = `
        <div class="ai-loading" style="padding: 0; justify-content: flex-start; gap: 6px;">
          <div class="ai-loading-spinner" style="width: 14px; height: 14px;"></div>
          <span>正在閱讀與增量分析：第 ${i + 1}/${chapters.length} 章 [${Math.round((i / chapters.length) * 100)}%]...</span>
        </div>
      `;
      contentEl.scrollTop = contentEl.scrollHeight;
      
      try {
        const html = await ch.getContent();
        const doc = tempParser.parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, noscript, iframe').forEach(el => el.remove());
        const plainText = (doc.body.textContent || '').trim().replace(/\s+/g, ' ');
        
        if (plainText.length < 50) {
          chapterSummaries[i] = `本章節無實質內容或字數過少。`;
          await library.saveChapterSummary(currentBook.id, i, chapterSummaries[i]);
          continue;
        }
        
        // 限制長度，防止極長章節引發 context 溢出 (限制在 15,000 字符内)
        const truncatedText = plainText.length > 15000 ? plainText.substring(0, 15000) + '... [已截斷]' : plainText;
        
        const chSystemPrompt = "You are an expert reading assistant. Summarize the provided chapter text. Extract the main events, characters/entities, core concepts, and key arguments. Keep it strictly factual, clear, and do not exceed 300 words. Respond in Traditional Chinese (or Simplified Chinese if the book is in simplified CJK).";
        const chQuery = `Chapter Title: "${ch.title}"\n\nChapter Content:\n${truncatedText}`;
        
        const chSummary = await ai._chat(chSystemPrompt, chQuery, null);
        chapterSummaries[i] = chSummary;
        
        // 增量寫入本地 IndexedDB
        await library.saveChapterSummary(currentBook.id, i, chSummary);
      } catch (err) {
        console.warn(`Failed to summarize chapter ${i} (${ch.title}):`, err);
        chapterSummaries[i] = `[章節摘要分析失敗: ${err.message}]`;
      }
    }
    
    // 更新內存中的章節摘要映射
    currentBook.chapterSummaries = chapterSummaries;
    
    // 彙總所有章節的摘要內容
    let compiledChapterSummaries = '';
    for (let i = 0; i < chapters.length; i++) {
      if (chapterSummaries[i]) {
        compiledChapterSummaries += `[Chapter ${i + 1}: ${chapters[i].title}]\n${chapterSummaries[i]}\n\n`;
      }
    }
    
    // ===== 階段二：Reduce 階段（結合章節摘要、目錄和關聯矩陣生成最終分析報告） =====
    assistantBubble.innerHTML = `
      <div class="ai-loading" style="padding: 0; justify-content: flex-start; gap: 6px;">
        <div class="ai-loading-spinner" style="width: 14px; height: 14px;"></div>
        <span>正在彙總章節脈絡，生成全書深度分析報告...</span>
      </div>
    `;
    contentEl.scrollTop = contentEl.scrollHeight;
    
    const bookTitle = currentBook?.title || document.getElementById('reader-book-title')?.textContent?.trim() || epubBookData?.title || 'Unknown';
    const bookAuthor = currentBook?.author || epubBookData?.author || 'Unknown';
    
    const systemPrompt = "You are an expert research assistant and professional book critic. You excel at analyzing both fiction (novels, literature) and non-fiction (history, social science, philosophy, science, business, technology). Your task is to write a highly professional, comprehensive book analysis report based on the book metadata, table of contents, and a client-side entity co-occurrence association network.";
    const query = `Book Title: "${bookTitle}"
Author: "${bookAuthor}"

[Table of Contents (Chapters)]
${chapterTitles}

[Client-Side Entity Co-occurrence Data]
${entitySummary}

[Chapter-by-Chapter Summaries]
${compiledChapterSummaries}

Please generate a comprehensive "Deep Book Analysis Report" in Chinese (or matching reader language). Adapt the structure, sections, and terminology based on whether the book is fiction (novel, story) or non-fiction (academic, history, social science, philosophy, etc.):

1. **书籍定位与类型** (Briefly determine the genre, style, and subject matter of this book).
2. **核心概念/主要人物与关联网络** (Using the co-occurrence data and chapter summaries above:
   - If fiction/biography: Analyze main characters/figures, their roles, and their relationship network.
   - If academic/social science/technical: Define core concepts, key terminology, primary figures/theories, and how they relate to one another).
3. **脉络节点与论证/情节框架** (Using the chapter summaries and table of contents:
   - If fiction/narrative: Identify major plot arcs, narrative milestones, and key timeline events.
   - If academic/non-fiction: Outline the logical progression, primary arguments, chapter-by-chapter thesis, and structural layout of the book's reasoning).
4. **核心思想、价值与文学特色/学术贡献** (Discuss the main takeaways, themes, methodology/writing style, and the overall academic, practical, or literary contribution).

Format your output nicely with markdown. Make sure it is highly professional, insightful, and detailed.`;
    
    let reportText = '';
    const finalReply = await ai._chat(systemPrompt, query, (chunk) => {
      reportText = chunk;
      assistantBubble.innerHTML = formatMarkdown(chunk);
      contentEl.scrollTop = contentEl.scrollHeight;
    });
    
    await library.saveBookSummary(currentBook.id, finalReply);
    currentBook.bookSummary = finalReply;
    
    const newChat = {
      chatId: 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      query: getMsg('ai_deep_analysis_trigger') || '一鍵全書深度分析',
      reply: finalReply
    };
    const updatedChats = await library.saveAIChat(currentBook.id, newChat);
    currentBook.aiChats = updatedChats;
    
    renderMermaidBlocks();
  } catch (err) {
    assistantBubble.innerHTML = `<span style="color:red;">分析失敗: ${err.message}</span>`;
  }
}

// 向 AI 發送自定義提問
async function sendCustomAIQuery() {
  const inputEl = document.getElementById('ai-input');
  const query = inputEl.value.trim();
  if (!query) return;

  inputEl.value = '';
  inputEl.style.height = '38px'; // 恢復默認高度

  const contentEl = document.getElementById('ai-content');

  // 如果只有歡迎詞，清除之
  if (contentEl.querySelectorAll('.ai-chat-group').length === 0) {
    contentEl.innerHTML = '';
  }

  // 1. 建立對話組容器
  const groupEl = document.createElement('div');
  groupEl.className = 'ai-chat-group';
  const tempChatId = 'chat_temp_' + Date.now();
  groupEl.setAttribute('data-chat-id', tempChatId);

  // 2. 插入使用者問題氣泡
  const userBubble = document.createElement('div');
  userBubble.className = 'ai-chat-bubble user-bubble';
  userBubble.textContent = query;
  groupEl.appendChild(userBubble);

  // 3. 插入 AI 思考中/回答氣泡
  const assistantBubble = document.createElement('div');
  assistantBubble.className = 'ai-chat-bubble assistant-bubble';
  assistantBubble.innerHTML = `
    <div class="ai-loading" style="padding: 0; justify-content: flex-start; gap: 6px;">
      <div class="ai-loading-spinner" style="width: 14px; height: 14px;"></div>
      <span>${getMsg('ai_thinking') || 'Thinking...'}</span>
    </div>
  `;
  groupEl.appendChild(assistantBubble);
  
  contentEl.appendChild(groupEl);
  contentEl.scrollTop = contentEl.scrollHeight;

  // --- 本地快取查找 (0 Token 阻斷重複網絡調用) ---
  const allChats = (currentBook && currentBook.aiChats) ? currentBook.aiChats : [];
  const cachedChat = allChats.find(c => c.query === query);
  if (cachedChat) {
    assistantBubble.innerHTML = formatMarkdown(cachedChat.reply);
    contentEl.scrollTop = contentEl.scrollHeight;
    renderMermaidBlocks();
    return;
  }

  try {
    const bookTitle = document.getElementById('reader-book-title')?.textContent?.trim() || '';
    const bookContentEl = document.getElementById('book-content');

    // 如果索引正在建立，等待其完成以獲取全書上下文
    if (bookChunksCache.length === 0 && isIndexingBook) {
      let waitCount = 0;
      while (isIndexingBook && waitCount < 30) { // 最多等待 3 秒
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
    }
    
    // 如果快取為空且未處於建立狀態，嘗試主動建立索引
    if (bookChunksCache.length === 0 && !isIndexingBook && epubBookData && epubBookData.chapters) {
      await buildBookSearchIndex();
    }

    let bookContext = '';
    let contextScope = 'none'; // 'page' | 'chapter' | 'fullbook' | 'none'
    
    // === 三層查詢分類 ===
    const isFullBookQuery = /全书|整本|整本书|全部章节|整个文件|全局/.test(query);
    const isPageQuery = /本页|当前页|这一页|这页|当前页面|该页|这页上/.test(query);
    const isChapterQuery = /本章|当前章|这一章|这章|该章|这个章节|当前章节|本章节|这一节|这节|本节|当前节|总结|大纲|思维导图|脑图|核心观点|核心要点|结构|提纲|脉络|梳理/.test(query);
    
    // 獲取當前章節標題
    const currentChapterTitle = (epubBookData && epubBookData.chapters && epubBookData.chapters[currentChapterIndex])
      ? epubBookData.chapters[currentChapterIndex].title
      : '';

    // --- 根據問題複雜度動態調整 Top-K 召回量 ---
    let topK = 4;
    if (isFullBookQuery || /关系|人物|角色|性格|大事件|脉络|结构|关联|联系|图谱/.test(query)) {
      topK = 10;
    }

    if (isFullBookQuery) {
      // ===== 全書檢索模式 =====
      if (bookChunksCache.length > 0) {
        const relevantChunks = retrieveRelevantChunks(query, bookChunksCache, topK);
        if (relevantChunks.length > 0) {
          bookContext = relevantChunks.map((chunk, idx) => 
            `[Source Context ${idx + 1}] (Chapter: "${chunk.chapterTitle}"):\n${chunk.text}\n`
          ).join('\n');
          contextScope = 'fullbook';
        }
      }
    } else if (isPageQuery) {
      // ===== 當前頁面模式 =====
      const pageText = getCurrentPageText();
      if (pageText) {
        bookContext = pageText.substring(0, 25000);
        contextScope = 'page';
      }
    } else if (isChapterQuery) {
      // ===== 當前章節模式 =====
      const chapterText = getCurrentChapterText();
      if (chapterText) {
        bookContext = chapterText.substring(0, 25000);
        contextScope = 'chapter';
      }
    } else {
      // ===== 一般提問：優先嘗試全書檢索，回退到章節上下文 =====
      if (bookChunksCache.length > 0) {
        const relevantChunks = retrieveRelevantChunks(query, bookChunksCache, topK);
        if (relevantChunks.length > 0) {
          bookContext = relevantChunks.map((chunk, idx) => 
            `[Source Context ${idx + 1}] (Chapter: "${chunk.chapterTitle}"):\n${chunk.text}\n`
          ).join('\n');
          contextScope = 'fullbook';
        }
      }
      if (!bookContext) {
        const chapterText = getCurrentChapterText();
        if (chapterText) {
          bookContext = chapterText.substring(0, 25000);
          contextScope = 'chapter';
        }
      }
    }

    // --- 本地實體共現矩陣生成 (0 Token 輔助人物關係分析) ---
    let cooccurrenceSummary = '';
    const isRelationshipQuery = /关系|人物|角色|性格|大事件|脉络|结构|关联|联系|图谱/.test(query);
    if (isRelationshipQuery && bookChunksCache.length > 0) {
      try {
        cooccurrenceSummary = extractEntitiesAndCooccurrence(bookChunksCache);
      } catch (err) {
        console.warn('Failed to extract co-occurrences:', err);
      }
    }

    // --- 檢查是否存在本地已生成的章節摘要，如果存在且提問是全局性/大綱/思維導圖/總結類的，則將章節摘要作為背景信息提供給 AI ---
    let summaryContext = '';
    const hasCachedSummaries = currentBook && currentBook.chapterSummaries && Object.keys(currentBook.chapterSummaries).length > 0;
    const isSummarizationOrMapQuery = /思维导图|脑图|总结|大纲|提纲|结构|脉络|情节|人物关系|角色关系/.test(query) || isFullBookQuery;
    
    if (hasCachedSummaries && isSummarizationOrMapQuery) {
      let compiledChapterSummaries = '';
      const chapters = (epubBookData && epubBookData.chapters) ? epubBookData.chapters : [];
      const isBuiltin = ai.provider === 'builtin';
      
      for (let i = 0; i < chapters.length; i++) {
        if (currentBook.chapterSummaries[i]) {
          let chSum = currentBook.chapterSummaries[i];
          // 對於瀏覽器內置模型，限制單章摘要字數以防 context window 溢出
          if (isBuiltin && chSum.length > 80) {
            chSum = chSum.substring(0, 80) + '...';
          }
          compiledChapterSummaries += `[Chapter ${i + 1}: ${chapters[i].title}]\n${chSum}\n\n`;
        }
      }
      if (compiledChapterSummaries) {
        summaryContext = compiledChapterSummaries;
      }
    }

    // === 構建系統提示詞 ===
    let systemPrompt = 'You are a helpful reading assistant. Answer the user\'s questions about the book content or general questions. Respond in the language of the prompt.\n';
    if (bookTitle) {
      systemPrompt += `Current Book: "${bookTitle}"\n`;
    }
    if (currentChapterTitle) {
      systemPrompt += `Current Chapter: "${currentChapterTitle}"\n`;
    }
    if (activeSelectedTextContext) {
      systemPrompt += `\n[User's Highlighted/Selected Text Focus]\n"${activeSelectedTextContext}"\n[End of Highlighted Text]\n\nThe user has selected the specific portion of text above. Please focus your answer specifically on this selected text if the user's question relates to it.\n`;
    }
    if (bookContext) {
      if (contextScope === 'fullbook') {
        systemPrompt += `\n[Relevant Paragraphs from the Entire Book]\n${bookContext}\n[End of Full Book Context]\n\nThe paragraphs above have been retrieved from the entire book using a TF-IDF semantic search for the user's query. Use them as the factual context to answer the user's question accurately and prevent hallucinations. Keep your answers grounded in these source texts.\n`;
      } else if (contextScope === 'page') {
        systemPrompt += `\n[Current Visible Page Content]\n${bookContext}\n[End of Current Page]\n\nThe above text is the exact content currently displayed on the user's screen (visible page). Use ONLY this text to answer the user's question about the current page. Do not invent or include content not shown above.\n`;
      } else if (contextScope === 'chapter') {
        systemPrompt += `\n[Current Chapter Content: "${currentChapterTitle || 'Untitled'}"]\n${bookContext}\n[End of Current Chapter]\n\nThe above text is the complete content of the current chapter the user is reading. Use ONLY this text to answer questions about this chapter. Do not invent or include content from other chapters.\n`;
      }
    }
    
    if (cooccurrenceSummary) {
      systemPrompt += `\n${cooccurrenceSummary}\nUse the local entity co-occurrence mapping above to accurately link characters, events, and concepts. It represents the physical text association structure of the book. Make sure your relationship and character descriptions align with these findings.\n`;
    }

    if (summaryContext) {
      systemPrompt += `\n[Chapter-by-Chapter Summaries (Factual Foundation)]\n${summaryContext}\n[End of Chapter Summaries]\n\nThe summaries above describe each chapter of the book in detail. Use them as the factual foundation to answer the user's request (e.g., generating a mindmap, summary, outline, or plot structure). Ensure your response matches these chapter descriptions exactly.\n`;
    }

    // 如果存在全書深度分析報告，將其作為宏觀全局知識注入
    if (currentBook && currentBook.bookSummary) {
      systemPrompt += `\n[Book Master Overview (Deep Analysis Report)]\n${currentBook.bookSummary}\n[End of Master Overview]\n\nThe above is the comprehensive deep analysis report of the entire book. Use it as the supreme factual foundation to answer macroscopic, thematic, or general questions about the book. Ensure your answer aligns with this structural and thematic overview.\n`;
    }

    // 發送後清除針對性選取上下文並隱藏提示欄
    activeSelectedTextContext = '';
    const badge = document.getElementById('ai-selection-context');
    if (badge) badge.style.display = 'none';

    const history = (currentBook && currentBook.aiChats) ? currentBook.aiChats.slice(-10) : [];
    const finalReply = await ai._chat(systemPrompt, query, (chunk) => {
      assistantBubble.innerHTML = formatMarkdown(chunk);
      contentEl.scrollTop = contentEl.scrollHeight;
    }, history);

    // 保存到資料庫
    const newChat = {
      chatId: 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      query: query,
      reply: finalReply
    };
    groupEl.setAttribute('data-chat-id', newChat.chatId);
    
    // 添加刪除按鈕
    addDeleteButtonToGroup(groupEl, newChat);

    const updatedChats = await library.saveAIChat(currentBook.id, newChat);
    currentBook.aiChats = updatedChats;
    renderMermaidBlocks();
  } catch (e) {
    assistantBubble.innerHTML = `<span style="color:red;">${getMsg('error_prefix') || 'Error'}: ${e.message}</span>`;
  }
}

// 觸發 AI 摘要
async function triggerAISummary() {
  if (!selectedTextState) return;
  document.getElementById('selection-menu').style.display = 'none';
  window.getSelection().removeAllRanges();
  
  const typeLabel = getMsg('ai_summary_label') || 'Summary';
  const { groupEl, queryText, assistantBubble } = showAILoading(typeLabel, selectedTextState);
  
  try {
    const finalReply = await ai.summarize(selectedTextState, (chunk) => {
      if (assistantBubble) {
        assistantBubble.innerHTML = formatMarkdown(chunk);
        document.getElementById('ai-content').scrollTop = document.getElementById('ai-content').scrollHeight;
      }
    });

    // 保存到資料庫
    const newChat = {
      chatId: 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      query: queryText,
      reply: finalReply
    };
    groupEl.setAttribute('data-chat-id', newChat.chatId);
    
    // 添加刪除按鈕
    addDeleteButtonToGroup(groupEl, newChat);

    const updatedChats = await library.saveAIChat(currentBook.id, newChat);
    currentBook.aiChats = updatedChats;
    renderMermaidBlocks();
  } catch (e) {
    if (assistantBubble) {
      assistantBubble.innerHTML = `<span style="color:red;">${getMsg('error_prefix')}: ${e.message}</span>`;
    }
  }
}

// 觸發 AI 釋義
async function triggerAIExplain() {
  if (!selectedTextState) return;
  document.getElementById('selection-menu').style.display = 'none';
  window.getSelection().removeAllRanges();
  
  const typeLabel = getMsg('ai_explain_label') || 'Explain';
  const { groupEl, queryText, assistantBubble } = showAILoading(typeLabel, selectedTextState);

  // 獲取選詞的上下文段落
  const parentPara = selectedTextRange.startContainer.parentElement.closest('p, div, li');
  const context = parentPara ? parentPara.textContent : selectedTextState;

  try {
    const finalReply = await ai.explainWord(selectedTextState, context, (chunk) => {
      if (assistantBubble) {
        assistantBubble.innerHTML = formatMarkdown(chunk);
        document.getElementById('ai-content').scrollTop = document.getElementById('ai-content').scrollHeight;
      }
    });

    // 保存到資料庫
    const newChat = {
      chatId: 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      query: queryText,
      reply: finalReply
    };
    groupEl.setAttribute('data-chat-id', newChat.chatId);
    
    // 添加刪除按鈕
    addDeleteButtonToGroup(groupEl, newChat);

    const updatedChats = await library.saveAIChat(currentBook.id, newChat);
    currentBook.aiChats = updatedChats;
    renderMermaidBlocks();
  } catch (e) {
    if (assistantBubble) {
      assistantBubble.innerHTML = `<span style="color:red;">${getMsg('error_prefix')}: ${e.message}</span>`;
    }
  }
}

// 觸發 AI 翻譯
async function triggerAITranslate() {
  if (!selectedTextState) return;
  document.getElementById('selection-menu').style.display = 'none';
  window.getSelection().removeAllRanges();
  
  const typeLabel = getMsg('ai_translate_label') || 'Translate';
  const { groupEl, queryText, assistantBubble } = showAILoading(typeLabel, selectedTextState);

  // 檢測目標語言：如果是英文則翻譯成中文，否則翻譯成英文
  const hasChinese = /[\u4e00-\u9fa5]/.test(selectedTextState);
  let targetLang = 'English';
  if (!hasChinese) {
    const localeTargetLang = getMsg('ai_target_lang');
    targetLang = (localeTargetLang && localeTargetLang !== 'ai_target_lang') ? localeTargetLang : 'Traditional Chinese';
    if (targetLang === 'English') {
      targetLang = 'Traditional Chinese';
    }
  }

  try {
    const finalReply = await ai.translate(selectedTextState, targetLang, (chunk) => {
      if (assistantBubble) {
        assistantBubble.innerHTML = formatMarkdown(chunk);
        document.getElementById('ai-content').scrollTop = document.getElementById('ai-content').scrollHeight;
      }
    });

    // 保存到資料庫
    const newChat = {
      chatId: 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      query: queryText,
      reply: finalReply
    };
    groupEl.setAttribute('data-chat-id', newChat.chatId);
    
    // 添加刪除按鈕
    addDeleteButtonToGroup(groupEl, newChat);

    const updatedChats = await library.saveAIChat(currentBook.id, newChat);
    currentBook.aiChats = updatedChats;
    renderMermaidBlocks();
  } catch (e) {
    if (assistantBubble) {
      assistantBubble.innerHTML = `<span style="color:red;">${getMsg('error_prefix')}: ${e.message}</span>`;
    }
  }
}

// 觸發 AI 針對性提問
function triggerAIAsk() {
  if (!selectedTextState) return;
  document.getElementById('selection-menu').style.display = 'none';
  window.getSelection().removeAllRanges();

  // 設置選取的文本為當前的針對性提問上下文
  activeSelectedTextContext = selectedTextState;
  
  // 顯示聚焦狀態欄，並更新文字
  const badge = document.getElementById('ai-selection-context');
  const badgeText = document.getElementById('ai-selection-context-text');
  if (badge && badgeText) {
    const preview = selectedTextState.length > 40 ? selectedTextState.substring(0, 40) + '...' : selectedTextState;
    badgeText.textContent = `"${preview}"`;
    badge.style.display = 'flex';
  }

  // 打開 AI 面板並聚焦輸入框
  const aiPanel = document.getElementById('ai-panel');
  if (aiPanel) {
    aiPanel.style.display = 'flex';
    const contentEl = document.getElementById('ai-content');
    if (contentEl && contentEl.querySelectorAll('.ai-chat-group').length === 0) {
      contentEl.innerHTML = '';
    }
    // 關閉其他側邊欄和下拉面板
    document.getElementById('reader-sidebar').classList.remove('active');
    document.getElementById('settings-panel').classList.remove('dropdown-active');
    document.getElementById('tts-panel').classList.remove('dropdown-active');
    updateHeaderActiveStates();
  }
  const inputEl = document.getElementById('ai-input');
  if (inputEl) {
    inputEl.focus();
  }
}

// 將純文本進行滑動窗口切片
function chunkText(text, size = 800, overlap = 150) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + size;
    if (end > text.length) end = text.length;
    chunks.push(text.substring(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

// 建立整本書籍內容的輕量級全文檢索倒排/詞頻索引
async function buildBookSearchIndex() {
  if (!epubBookData || !epubBookData.chapters) {
    bookChunksCache = [];
    chapterTextsCache = [];
    return;
  }
  
  isIndexingBook = true;
  bookChunksCache = [];
  chapterTextsCache = [];
  console.log('Building client-side RAG search index for the entire book...');
  
  try {
    const chapters = epubBookData.chapters;
    const tempParser = new DOMParser();
    
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      if (typeof ch.getContent !== 'function') continue;
      
      try {
        const html = await ch.getContent();
        const doc = tempParser.parseFromString(html, 'text/html');
        // 清理無效標籤
        doc.querySelectorAll('script, style, noscript, iframe').forEach(el => el.remove());

        // 為了精確搜尋提取包含正確空格的文本
        function extractText(node) {
          if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
          if (node.nodeType === Node.ELEMENT_NODE) {
            const isBlock = /^(P|DIV|BR|H[1-6]|LI|BLOCKQUOTE|TR|TD|TH|SECTION|ARTICLE|ASIDE|NAV)$/i.test(node.tagName);
            let text = isBlock ? ' ' : '';
            for (const child of node.childNodes) {
              text += extractText(child);
            }
            return text + (isBlock ? ' ' : '');
          }
          return '';
        }
        
        const rawText = extractText(doc.body);
        const chapterPlainText = rawText.replace(/\s+/g, ' ').trim();
        
        chapterTextsCache.push({
          chapterTitle: ch.title,
          chapterIndex: i,
          text: chapterPlainText
        });
        
        const plainText = (doc.body.textContent || '').trim().replace(/\s+/g, ' ');
        
        if (plainText.length > 50) {
          const chunkTexts = chunkText(plainText, 800, 150);
          for (let j = 0; j < chunkTexts.length; j++) {
            bookChunksCache.push({
              chapterTitle: ch.title,
              chapterIndex: i,
              chunkIndex: j,
              text: chunkTexts[j]
            });
          }
        }
      } catch (err) {
        console.warn(`Failed to index chapter ${i} (${ch.title}):`, err);
      }
    }
    console.log(`Index built successfully! Total chunks: ${bookChunksCache.length}`);
  } catch (err) {
    console.error('Failed to build book search index:', err);
  } finally {
    isIndexingBook = false;
  }
}

// 基於 TF-IDF 與中英文混合分詞的輕量級檢索器
function retrieveRelevantChunks(query, chunks, topK = 4) {
  if (!chunks || chunks.length === 0) return [];

  const terms = [];
  const rawTerms = query.toLowerCase().split(/[\s,.\/\\?!@#￥%……&*（）()_+\-=\[\]{}：；“”‘’'\"：；。，？！、]/).filter(t => t.trim().length >= 2);
  
  for (const t of rawTerms) {
    terms.push(t);
    // 針對中文，提取單字及雙字以提升召回率
    if (/[\u4e00-\u9fa5]/.test(t)) {
      for (let i = 0; i < t.length; i++) {
        terms.push(t[i]);
        if (i < t.length - 1) {
          terms.push(t.substring(i, i + 2));
        }
      }
    }
  }

  const uniqueTerms = [...new Set(terms)].filter(t => t.length > 0);
  if (uniqueTerms.length === 0) return chunks.slice(0, topK);

  const idfs = {};
  const totalChunks = chunks.length;
  for (const term of uniqueTerms) {
    let containingCount = 0;
    for (const chunk of chunks) {
      if (chunk.text.toLowerCase().includes(term)) {
        containingCount++;
      }
    }
    idfs[term] = Math.log(totalChunks / (containingCount + 1)) + 1;
  }

  const scoredChunks = chunks.map(chunk => {
    let score = 0;
    const chunkTextLower = chunk.text.toLowerCase();
    for (const term of uniqueTerms) {
      const index = chunkTextLower.indexOf(term);
      if (index !== -1) {
        let count = 0;
        let pos = index;
        while (pos !== -1) {
          count++;
          pos = chunkTextLower.indexOf(term, pos + term.length);
        }
        
        const tf = count / chunk.text.length;
        const idf = idfs[term];
        const termWeight = term.length >= 3 ? 1.5 : (term.length === 2 ? 1.0 : 0.5);
        score += tf * idf * termWeight;
      }
    }
    return { chunk, score };
  });

  scoredChunks.sort((a, b) => b.score - a.score);
  return scoredChunks
    .filter(x => x.score > 0)
    .slice(0, topK)
    .map(x => x.chunk);
}

// 初始化 AI 伴侶面板拖曳調整大小功能
function initAIResize() {
  const handle = document.getElementById('ai-resize-handle');
  const panel = document.getElementById('ai-panel');
  if (!handle || !panel) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 只允許左鍵拖曳
    e.preventDefault();

    isResizing = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;

    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    // 拖曳向左 (e.clientX 減小) 時，面板寬度增加
    const deltaX = startX - e.clientX;
    let newWidth = startWidth + deltaX;

    // 設定寬度邊界限制：280px 到 95% 螢幕寬度，解除原有的最大 800px 限制
    const minWidth = 280;
    const maxWidth = window.innerWidth * 0.95;
    if (newWidth < minWidth) newWidth = minWidth;
    if (newWidth > maxWidth) newWidth = maxWidth;

    document.documentElement.style.setProperty('--ai-panel-width', `${newWidth}px`);
    localStorage.setItem('aiPanelWidth', `${newWidth}px`);

    if (document.body.classList.contains('layout-paginated')) {
      applyLayoutDimensions();
    }
  });

  window.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    handle.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (document.body.classList.contains('layout-paginated')) {
      applyLayoutDimensions();
    }
  });

  window.addEventListener('resize', () => {
    const currentWidthStr = document.documentElement.style.getPropertyValue('--ai-panel-width');
    if (currentWidthStr) {
      const currentWidth = parseInt(currentWidthStr);
      if (!isNaN(currentWidth)) {
        const maxWidth = Math.round(window.innerWidth * 0.95);
        if (currentWidth > maxWidth) {
          const newWidth = Math.max(280, maxWidth);
          document.documentElement.style.setProperty('--ai-panel-width', `${newWidth}px`);
          localStorage.setItem('aiPanelWidth', `${newWidth}px`);
        }
      }
    }
  });
}

// 初始化左側側邊欄拖曳調整大小功能
function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  const panel = document.getElementById('reader-sidebar');
  if (!handle || !panel) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 只允許左鍵拖曳
    e.preventDefault();

    isResizing = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;

    handle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    // 拖曳向右 (e.clientX 增大) 時，左側側邊欄寬度增加
    const deltaX = e.clientX - startX;
    let newWidth = startWidth + deltaX;

    // 設定寬度邊界限制：280px 到 95% 螢幕寬度
    const minWidth = 280;
    const maxWidth = window.innerWidth * 0.95;
    if (newWidth < minWidth) newWidth = minWidth;
    if (newWidth > maxWidth) newWidth = maxWidth;

    document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
    localStorage.setItem('sidebarWidth', `${newWidth}px`);

    if (document.body.classList.contains('layout-paginated')) {
      applyLayoutDimensions();
    }
  });

  window.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    handle.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (document.body.classList.contains('layout-paginated')) {
      applyLayoutDimensions();
    }
  });

  window.addEventListener('resize', () => {
    const currentWidthStr = document.documentElement.style.getPropertyValue('--sidebar-width');
    if (currentWidthStr) {
      const currentWidth = parseInt(currentWidthStr);
      if (!isNaN(currentWidth)) {
        const maxWidth = Math.round(window.innerWidth * 0.95);
        if (currentWidth > maxWidth) {
          const newWidth = Math.max(280, maxWidth);
          document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
          localStorage.setItem('sidebarWidth', `${newWidth}px`);
        }
      }
    }
  });
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

async function shareBackupBlobDirectly(backupBlob, filename) {
  if (typeof File === 'undefined' || !navigator.share) return false;
  const backupFile = new File([backupBlob], filename, { type: 'application/zip' });
  if (navigator.canShare && !navigator.canShare({ files: [backupFile] })) return false;

  await navigator.share({
    title: getMsg('backup_share_title'),
    text: getMsg('backup_share_text'),
    files: [backupFile]
  });
  return true;
}

// 導出書庫備份
async function handleExportBackup() {
  const backupBtn = document.getElementById('backup-btn');
  if (!backupBtn) return;
  const originalHtml = backupBtn.innerHTML;
  
  // Helper to convert blob to base64 using memory-efficient ArrayBuffer chunking
  const blobToBase64 = async (blob) => {
    try {
      if (typeof blob.arrayBuffer === 'function') {
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const len = bytes.byteLength;
        const chunkSize = 16384; // 16KB chunks to avoid stack overflow
        for (let i = 0; i < len; i += chunkSize) {
          const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
          binary += String.fromCharCode.apply(null, chunk);
        }
        return window.btoa(binary);
      }
    } catch (e) {
      console.warn('ArrayBuffer base64 conversion failed, falling back to FileReader:', e);
    }
    
    // Fallback to FileReader with safe onload/onerror handling
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          const base64String = reader.result.split(',')[1];
          if (base64String) {
            resolve(base64String);
          } else {
            reject(new Error('Base64 data was empty'));
          }
        } else {
          reject(new Error('Reader result is not a string'));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(blob);
    });
  };

  // Helper: 將一個 Blob 分塊寫入 Capacitor Filesystem（解決超大文件的橋接限制）
  const writeBlobToCache = async (Filesystem, path, blob) => {
    const chunkSize = 16 * 1024 * 1024; // 16MB chunks
    const totalSize = blob.size;
    const totalChunks = Math.ceil(totalSize / chunkSize);
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      const chunkBlob = blob.slice(start, end);
      const base64Data = await blobToBase64(chunkBlob);
      
      if (i === 0) {
        await Filesystem.writeFile({ path, data: base64Data, directory: 'CACHE' });
      } else {
        await Filesystem.appendFile({ path, data: base64Data, directory: 'CACHE' });
      }
    }
  };
  
  try {
    // 1. 取得所有書籍
    const books = await library.getAllBooks();
    if (books.length === 0) {
      alert(getMsg('no_books'));
      return;
    }

    // 2. 獲取備份檔名
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const filename = `edgereader_backup_${YYYY}${MM}${DD}_${hh}${mm}${ss}.zip`;

    const isCapacitor = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins;
    const isAndroid = /android/i.test(navigator.userAgent);

    // =====================================================================
    // 路徑 A：Android Capacitor — 逐文件寫入 CACHE + 原生 Java 端 ZIP 打包
    // 優勢：避免整個 ZIP Blob 駐留 JS 記憶體，避免 Base64 橋接整個 ZIP
    // =====================================================================
    if (isCapacitor && isAndroid) {
      const { NativeTTS, Filesystem } = window.Capacitor.Plugins;
      if (NativeTTS && typeof NativeTTS.createZipFromDirectory === 'function' && Filesystem) {
        try {
          // 進入載入狀態
          backupBtn.disabled = true;
          backupBtn.innerHTML = `
            <span class="btn-icon">
              <svg class="svg-icon" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            </span>
            <span>${getMsg('backing_up')}</span>
          `;

          // 清理並建立暫存目錄
          try { await Filesystem.rmdir({ path: 'backup_temp', directory: 'CACHE', recursive: true }); } catch (e) { /* ignore */ }
          await Filesystem.mkdir({ path: 'backup_temp', directory: 'CACHE', recursive: true });
          await Filesystem.mkdir({ path: 'backup_temp/books', directory: 'CACHE', recursive: true });
          await Filesystem.mkdir({ path: 'backup_temp/covers', directory: 'CACHE', recursive: true });

          // 逐本寫入書籍文件和封面至 CACHE（一次只有一本書的 Blob 在記憶體中）
          const serializedBooks = [];
          for (const book of books) {
            const meta = {
              id: book.id, title: book.title, author: book.author,
              format: book.format, size: book.size, addedAt: book.addedAt,
              lastReadAt: book.lastReadAt, progress: book.progress,
              bookmarks: book.bookmarks || [], notes: book.notes || [],
              stats: book.stats || null, aiChats: book.aiChats || [],
              bookSummary: book.bookSummary || '', chapterSummaries: book.chapterSummaries || {},
              folder: book.folder || null, hasFile: false, coverType: 'none', coverValue: ''
            };

            if (book.file instanceof Blob) {
              meta.hasFile = true;
              await writeBlobToCache(Filesystem, `backup_temp/books/${book.id}.bin`, book.file);
            }

            if (book.cover instanceof Blob) {
              meta.coverType = 'blob';
              await writeBlobToCache(Filesystem, `backup_temp/covers/${book.id}.bin`, book.cover);
            } else if (typeof book.cover === 'string') {
              meta.coverType = 'string';
              meta.coverValue = book.cover;
            }

            serializedBooks.push(meta);
          }

          // 寫入 metadata.json
          const backupPayload = {
            version: '2.0', backupAt: Date.now(), books: serializedBooks,
            customFolders: getCustomFolders(), aiPromptsTemplates: aiPromptsTemplatesList
          };
          await Filesystem.writeFile({
            path: 'backup_temp/metadata.json',
            data: btoa(unescape(encodeURIComponent(JSON.stringify(backupPayload)))),
            directory: 'CACHE'
          });

          // 呼叫原生 Java 端 ZipOutputStream 高速打包
          const zipResult = await NativeTTS.createZipFromDirectory({
            sourcePath: 'backup_temp',
            outputFilename: filename
          });

          // 彈出系統另存為對話框
          try {
            if (typeof NativeTTS.saveFileToSystem === 'function') {
              await NativeTTS.saveFileToSystem({
                filename: filename,
                fileUri: zipResult.uri
              });
              alert(getMsg('backup_success'));
            } else {
              // 降級：使用分享
              const { Share } = window.Capacitor.Plugins;
              if (Share) {
                await Share.share({
                  title: getMsg('backup_share_title'),
                  text: getMsg('backup_share_text'),
                  url: zipResult.uri,
                  dialogTitle: getMsg('backup_share_dialog_title')
                });
              }
              alert(getMsg('backup_success'));
            }
          } catch (saveErr) {
            if (saveErr.message && /cancel/i.test(saveErr.message)) {
              console.log('User cancelled Android save dialog');
            } else {
              throw saveErr;
            }
          } finally {
            // 清理暫存目錄和 ZIP 文件
            try { await Filesystem.rmdir({ path: 'backup_temp', directory: 'CACHE', recursive: true }); } catch (e) { /* ignore */ }
            try { await Filesystem.deleteFile({ path: filename, directory: 'CACHE' }); } catch (e) { /* ignore */ }
          }
          return;
        } catch (err) {
          console.warn('Android native ZIP backup failed, falling back to JSZip:', err);
          // 降級到下面的通用 JSZip 路徑
        }
      }
    }

    // =====================================================================
    // 路徑 B：瀏覽器 / 非 Android Capacitor — 使用 JSZip
    // =====================================================================

    // 3. 在支援的瀏覽器中，優先使用 File System Access API 直接彈出保存至文件系統對話框
    let fileHandle = null;
    let useSaveFilePicker = !isCapacitor && typeof window.showSaveFilePicker === 'function';
    if (useSaveFilePicker) {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: 'ZIP Archive',
            accept: { 'application/zip': ['.zip'] }
          }]
        });
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log('User cancelled backup save picker');
          return;
        }
        console.warn('showSaveFilePicker initialization failed, falling back to tag download:', err);
        useSaveFilePicker = false;
      }
    }

    // 進入載入狀態
    backupBtn.disabled = true;
    backupBtn.innerHTML = `
      <span class="btn-icon">
        <svg class="svg-icon" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
      </span>
      <span>${getMsg('backing_up')}</span>
    `;

    // 4. 使用 JSZip 構造壓縮包
    if (typeof window.JSZip === 'undefined') {
      throw new Error('JSZip 庫未載入，無法進行備份！');
    }
    const zip = new window.JSZip();
    const serializedBooks = [];

    for (const book of books) {
      const meta = {
        id: book.id, title: book.title, author: book.author,
        format: book.format, size: book.size, addedAt: book.addedAt,
        lastReadAt: book.lastReadAt, progress: book.progress,
        bookmarks: book.bookmarks || [], notes: book.notes || [],
        stats: book.stats || null, aiChats: book.aiChats || [],
        bookSummary: book.bookSummary || '', chapterSummaries: book.chapterSummaries || {},
        folder: book.folder || null, hasFile: false, coverType: 'none', coverValue: ''
      };

      if (book.file instanceof Blob) {
        meta.hasFile = true;
        zip.file(`books/${book.id}.bin`, book.file);
      }

      if (book.cover instanceof Blob) {
        meta.coverType = 'blob';
        zip.file(`covers/${book.id}.bin`, book.cover);
      } else if (typeof book.cover === 'string') {
        meta.coverType = 'string';
        meta.coverValue = book.cover;
      }

      serializedBooks.push(meta);
    }

    const backupPayload = {
      version: '2.0', backupAt: Date.now(), books: serializedBooks,
      customFolders: getCustomFolders(), aiPromptsTemplates: aiPromptsTemplatesList
    };
    zip.file('metadata.json', JSON.stringify(backupPayload));
    
    // 5. 優先使用流式寫入 showSaveFilePicker（記憶體佔用降到 O(chunk) 級別）
    if (useSaveFilePicker && fileHandle) {
      try {
        const writable = await fileHandle.createWritable();
        await new Promise((resolve, reject) => {
          const stream = zip.generateInternalStream({ type: 'uint8array', compression: 'STORE', streamFiles: true });
          stream.on('data', (data) => {
            stream.pause();
            writable.write(data).then(() => stream.resume()).catch(reject);
          });
          stream.on('error', reject);
          stream.on('end', () => {
            writable.close().then(resolve).catch(reject);
          });
          stream.resume();
        });
        alert(getMsg('backup_success'));
        return;
      } catch (writeErr) {
        console.error('Streaming via showSaveFilePicker failed, falling back:', writeErr);
      }
    }
    
    // 6. 降級路徑：生成完整 Blob
    const backupBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true });
    
    // 7. Capacitor 非 Android 路徑（iOS 等）
    if (isCapacitor && window.Capacitor.Plugins.Filesystem && window.Capacitor.Plugins.Share) {
      const { Filesystem, Share, NativeTTS } = window.Capacitor.Plugins;
      
      let actionChoice = 'share';
      
      if (isAndroid) {
        actionChoice = 'share';
      } else {
        const confirmSave = confirm(getMsg('backup_save_prompt'));
        actionChoice = confirmSave ? 'save' : 'share';
      }
      
      const chunkSize = isAndroid ? 16 * 1024 * 1024 : 1024 * 1024;
      const totalSize = backupBlob.size;
      const totalChunks = Math.ceil(totalSize / chunkSize);
      let fileUri = '';
      const saveDirectory = (actionChoice === 'save' && !isAndroid) ? 'DOCUMENTS' : 'CACHE';

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, totalSize);
        const chunkBlob = backupBlob.slice(start, end);
        const base64Data = await blobToBase64(chunkBlob);
        
        if (i === 0) {
          const writeResult = await Filesystem.writeFile({
            path: filename, data: base64Data, directory: saveDirectory
          });
          fileUri = writeResult.uri;
        } else {
          await Filesystem.appendFile({
            path: filename, data: base64Data, directory: saveDirectory
          });
        }
      }
      
      if (actionChoice === 'save') {
        if (isAndroid) {
          if (NativeTTS && typeof NativeTTS.copyFileToDownloads === 'function') {
            try {
              const result = await NativeTTS.copyFileToDownloads({
                filename: filename, fileUri: fileUri
              });
              alert(getMsg('backup_saved_to_downloads', [result.path]));
            } catch (copyErr) {
              console.error('Copy to Downloads failed:', copyErr);
              alert(getMsg('backup_save_fallback_share'));
              await Share.share({
                title: getMsg('backup_share_title'), text: getMsg('backup_share_text'),
                url: fileUri, dialogTitle: getMsg('backup_share_dialog_title')
              });
            } finally {
              try { await Filesystem.deleteFile({ path: filename, directory: 'CACHE' }); } catch (e) { /* ignore */ }
            }
          } else {
            alert(getMsg('backup_native_save_unavailable'));
            await Share.share({
              title: getMsg('backup_share_title'), text: getMsg('backup_share_text'),
              url: fileUri, dialogTitle: getMsg('backup_share_dialog_title')
            });
          }
        } else {
          // iOS
          alert(getMsg('backup_saved_to_app_directory', [filename]));
        }
      } else {
        // Share action
        await Share.share({
          title: getMsg('backup_share_title'), text: getMsg('backup_share_text'),
          url: fileUri, dialogTitle: getMsg('backup_share_dialog_title')
        });
        try { await Filesystem.deleteFile({ path: filename, directory: 'CACHE' }); } catch (e) { /* ignore */ }
      }
    } else {
      // 瀏覽器版本使用 standard A 標籤下載
      const downloadUrl = URL.createObjectURL(backupBlob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      
      alert(getMsg('backup_success'));
    }
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

  restoreBtn.disabled = true;
  restoreBtn.innerHTML = `
    <span class="btn-icon">
      <svg class="svg-icon" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
    </span>
    <span>${getMsg('restoring')}</span>
  `;

  const performRestore = async () => {
    try {
      let isZip = false;
      let zip;
      
      if (typeof window.JSZip !== 'undefined') {
        try {
          zip = await window.JSZip.loadAsync(file);
          isZip = true;
        } catch (zipErr) {
          isZip = false;
        }
      }

      if (isZip) {
        // 使用 JSZip 載入備份 (v2.0)
        const metaFile = zip.file('metadata.json');
        if (!metaFile) {
          throw new Error('無效的備份檔案，ZIP 內找不到 metadata.json！');
        }

        const metaText = await metaFile.async('string');
        const data = JSON.parse(metaText);

        if (!data || (data.version !== '2.0' && data.version !== '1.0') || !Array.isArray(data.books)) {
          alert(getMsg('invalid_backup_file'));
          return;
        }

        // 還原每一本書
        for (const b of data.books) {
          let fileBlob = null;
          if (b.hasFile) {
            const fileEntry = zip.file(`books/${b.id}.bin`);
            if (fileEntry) {
              fileBlob = await fileEntry.async('blob');
            }
          }

          let coverBlobOrString = '';
          if (b.coverType === 'blob') {
            const coverEntry = zip.file(`covers/${b.id}.bin`);
            if (coverEntry) {
              coverBlobOrString = await coverEntry.async('blob');
            }
          } else if (b.coverType === 'string') {
            coverBlobOrString = b.coverValue;
          }

          let fileObj = fileBlob;
          if (fileBlob && !(fileBlob instanceof File)) {
            const fileName = b.title ? `${b.title}.${b.format}` : `${b.id}.${b.format}`;
            fileObj = new File([fileBlob], fileName, { type: fileBlob.type });
          }

          const book = {
            id: b.id,
            title: b.title,
            author: b.author,
            format: b.format,
            file: fileObj,
            cover: coverBlobOrString,
            folder: b.folder || null,
            size: b.size,
            addedAt: b.addedAt,
            lastReadAt: b.lastReadAt,
            progress: b.progress,
            bookmarks: b.bookmarks || [],
            notes: b.notes || [],
            stats: b.stats || null,
            aiChats: b.aiChats || [],
            bookSummary: b.bookSummary || '',
            chapterSummaries: b.chapterSummaries || {}
          };

          await library.importBook(book);
        }

        // 合併並還原自定義資料夾列表
        if (data.customFolders && Array.isArray(data.customFolders)) {
          const existingFolders = getCustomFolders();
          const mergedFolders = Array.from(new Set([...existingFolders, ...data.customFolders]));
          saveCustomFolders(mergedFolders);
        }

        // 合併並還原自定義 AI 提示詞模板
        if (data.aiPromptsTemplates && Array.isArray(data.aiPromptsTemplates)) {
          const currentTemplates = aiPromptsTemplatesList;
          data.aiPromptsTemplates.forEach(importedItem => {
            const isDuplicate = currentTemplates.some(curr => 
              curr.label === importedItem.label && curr.prompt === importedItem.prompt
            );
            if (!isDuplicate) {
              const existingIndex = currentTemplates.findIndex(curr => curr.key && curr.key === importedItem.key);
              if (existingIndex >= 0) {
                currentTemplates[existingIndex].label = importedItem.label;
                currentTemplates[existingIndex].prompt = importedItem.prompt;
              } else {
                const key = importedItem.key || ('ai_suggest_custom_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5));
                currentTemplates.push({
                  key: key,
                  icon: importedItem.icon || DEFAULT_CUSTOM_ICON,
                  label: importedItem.label,
                  prompt: importedItem.prompt,
                  isDefault: importedItem.isDefault || false
                });
              }
            }
          });
          chrome.storage.local.set({ aiPromptsTemplates: currentTemplates }, () => {
            aiPromptsTemplatesList = currentTemplates;
            initAISuggestions();
          });
        }
      } else {
        // 否則為舊版 JSON 備份 (v1.0)
        const jsonText = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => resolve(event.target.result);
          reader.onerror = () => reject(new Error('讀取 JSON 檔案失敗'));
          reader.readAsText(file);
        });

        const data = JSON.parse(jsonText);
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

          let fileObj = fileBlob;
          if (fileBlob && !(fileBlob instanceof File)) {
            const fileName = b.title ? `${b.title}.${b.format}` : `${b.id}.${b.format}`;
            fileObj = new File([fileBlob], fileName, { type: fileBlob.type });
          }

          const book = {
            id: b.id,
            title: b.title,
            author: b.author,
            format: b.format,
            file: fileObj,
            cover: coverBlobOrString,
            size: b.size,
            addedAt: b.addedAt,
            lastReadAt: b.lastReadAt,
            progress: b.progress,
            bookmarks: b.bookmarks || [],
            notes: b.notes || [],
            stats: b.stats || null,
            aiChats: b.aiChats || [],
            bookSummary: b.bookSummary || '',
            chapterSummaries: b.chapterSummaries || {}
          };

          await library.importBook(book);
        }
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

  performRestore();
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
  const clearAllBtn = document.getElementById('clear-all-stats-btn');
  const clearBookBtn = document.getElementById('clear-book-stats-btn');

  if (tabOverview && tabBooks && contentOverview && contentBooks) {
    if (tabName === 'overview') {
      tabOverview.classList.add('active');
      tabBooks.classList.remove('active');
      contentOverview.classList.add('active');
      contentBooks.classList.remove('active');
      if (clearAllBtn) clearAllBtn.style.display = 'block';
      if (clearBookBtn) clearBookBtn.style.display = 'none';
    } else {
      tabOverview.classList.remove('active');
      tabBooks.classList.add('active');
      contentOverview.classList.remove('active');
      contentBooks.classList.add('active');
      if (clearAllBtn) clearAllBtn.style.display = 'none';
      if (clearBookBtn) clearBookBtn.style.display = 'block';
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
    const stats = b.stats || { readingDays: {}, hourlyDist: {} };
    const bookTotal = Object.values(stats.readingDays || {}).reduce((s, v) => s + v, 0);
    totalSeconds += bookTotal;
    if (bookTotal > 0) {
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

  const stats = book.stats || { readingDays: {}, hourlyDist: {} };
  const readingDays = stats.readingDays || {};
  const hourlyDist = stats.hourlyDist || {};
  const totalTime = Object.values(readingDays).reduce((s, v) => s + v, 0);

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


// ==================== 15. 書庫資料夾與批量管理邏輯 ====================

// 獲取自定義資料夾列表
function getCustomFolders() {
  const foldersJson = localStorage.getItem('edgereader_custom_folders');
  return foldersJson ? JSON.parse(foldersJson) : [];
}

// 保存自定義資料夾列表
function saveCustomFolders(folders) {
  localStorage.setItem('edgereader_custom_folders', JSON.stringify(folders));
}

// 創建新資料夾
async function createFolder(folderName) {
  if (!folderName) return;
  const folders = getCustomFolders();
  if (folders.includes(folderName)) {
    alert('資料夾已存在！');
    return;
  }
  folders.push(folderName);
  saveCustomFolders(folders);
  document.getElementById('folder-dialog').close();
  await renderBookshelf();
}

// 重命名資料夾
async function renameFolder(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const folders = getCustomFolders();
  
  // 更新 localStorage 列表
  const idx = folders.indexOf(oldName);
  if (idx > -1) {
    folders[idx] = newName;
  } else {
    folders.push(newName);
  }
  saveCustomFolders(folders);

  // 更新所有屬於該資料夾的書籍
  const books = await library.getAllBooks();
  for (const book of books) {
    if (book.folder === oldName) {
      await library.updateBookFolder(book.id, newName);
    }
  }

  if (currentFolder === oldName) {
    currentFolder = newName;
  }
  
  document.getElementById('folder-dialog').close();
  await renderBookshelf();
}

// 刪除資料夾
async function deleteFolder(folderName) {
  if (!folderName) return;
  if (confirm(getMsg('confirm_delete_folder') || '確定要刪除此資料夾嗎？資料夾內的書籍將被移至根目錄。')) {
    const folders = getCustomFolders();
    const idx = folders.indexOf(folderName);
    if (idx > -1) {
      folders.splice(idx, 1);
      saveCustomFolders(folders);
    }

    // 將資料夾內的所有書籍移至根目錄 (null)
    const books = await library.getAllBooks();
    for (const book of books) {
      if (book.folder === folderName) {
        await library.updateBookFolder(book.id, null);
      }
    }

    if (currentFolder === folderName) {
      currentFolder = null;
    }

    await renderBookshelf();
  }
}

// 切換批量選擇模式
function toggleSelectMode(active) {
  isSelectMode = active;
  const shelf = document.getElementById('bookshelf-grid');
  const batchBar = document.getElementById('batch-action-bar');
  const manageBtn = document.getElementById('batch-manage-btn');

  if (isSelectMode) {
    if (shelf) shelf.classList.add('select-mode-active');
    if (batchBar) batchBar.classList.add('active');
    selectedBookIds.clear();
    updateBatchActionBar();
    if (manageBtn) manageBtn.classList.add('active');
  } else {
    if (shelf) shelf.classList.remove('select-mode-active');
    if (batchBar) batchBar.classList.remove('active');
    selectedBookIds.clear();
    document.querySelectorAll('.book-card.selected').forEach(card => card.classList.remove('selected'));
    if (manageBtn) manageBtn.classList.remove('active');
  }
}

// 切換單本書籍選中狀態
function toggleBookSelection(bookId, card) {
  if (selectedBookIds.has(bookId)) {
    selectedBookIds.delete(bookId);
    card.classList.remove('selected');
  } else {
    selectedBookIds.add(bookId);
    card.classList.add('selected');
  }
  updateBatchActionBar();
}

// 更新批量操作欄狀態
function updateBatchActionBar() {
  const count = selectedBookIds.size;
  const countSpan = document.getElementById('batch-selected-count');
  if (countSpan) {
    countSpan.textContent = getMsg('batch_selected_count', [count]) || `Selected: ${count} books`;
  }

  const moveBtn = document.getElementById('batch-move-btn');
  const deleteBtn = document.getElementById('batch-delete-btn');

  if (moveBtn && deleteBtn) {
    if (count > 0) {
      moveBtn.disabled = false;
      deleteBtn.disabled = false;
    } else {
      moveBtn.disabled = true;
      deleteBtn.disabled = true;
    }
  }
}

// 打開新建/重命名資料夾對話框
let folderDialogCallback = null;
function openFolderDialog(editingFolder = null) {
  const dialog = document.getElementById('folder-dialog');
  const title = document.getElementById('folder-dialog-title');
  const input = document.getElementById('folder-name-input');
  
  if (editingFolder) {
    if (title) title.textContent = getMsg('rename_folder') || '重命名資料夾';
    if (input) input.value = editingFolder;
    folderDialogCallback = (newName) => renameFolder(editingFolder, newName);
  } else {
    if (title) title.textContent = getMsg('create_folder') || '新建資料夾';
    if (input) input.value = '';
    folderDialogCallback = (newName) => createFolder(newName);
  }

  if (dialog) dialog.showModal();
}

// 打開資料夾選擇對話框 (用於批量移動)
function openFolderSelectDialog(onSelected) {
  const dialog = document.getElementById('folder-select-dialog');
  const list = document.getElementById('folder-select-list');
  if (!list) return;
  list.innerHTML = '';

  const folders = getCustomFolders();
  const allFolders = Array.from(new Set([...folders]));

  // 移出到根目錄選項
  const rootLi = document.createElement('li');
  rootLi.className = 'folder-select-item';
  rootLi.innerHTML = `
    <svg class="folder-select-item-icon" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
    <span>${getMsg('move_to_root') || '移出資料夾 (根目錄)'}</span>
  `;
  rootLi.addEventListener('click', () => {
    onSelected(null);
    if (dialog) dialog.close();
  });
  list.appendChild(rootLi);

  // 現有資料夾選項
  allFolders.forEach(folderName => {
    const li = document.createElement('li');
    li.className = 'folder-select-item';
    li.innerHTML = `
      <svg class="folder-select-item-icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
      <span>${folderName}</span>
    `;
    li.addEventListener('click', () => {
      onSelected(folderName);
      if (dialog) dialog.close();
    });
    list.appendChild(li);
  });

  // 新建資料夾並移動選項
  const newLi = document.createElement('li');
  newLi.className = 'folder-select-item';
  newLi.style.borderStyle = 'dashed';
  newLi.style.color = 'var(--primary-color)';
  newLi.innerHTML = `
    <svg class="folder-select-item-icon" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    <span style="font-weight: 600;">+ ${getMsg('create_folder') || '新建資料夾'}</span>
  `;
  newLi.addEventListener('click', () => {
    if (dialog) dialog.close();
    setTimeout(() => {
      const newName = prompt('請輸入新建資料夾名稱:');
      if (newName && newName.trim()) {
        const trimmed = newName.trim();
        const custom = getCustomFolders();
        if (!custom.includes(trimmed)) {
          custom.push(trimmed);
          saveCustomFolders(custom);
        }
        onSelected(trimmed);
      }
    }, 200);
  });
  list.appendChild(newLi);

  if (dialog) dialog.showModal();
}

// Register PWA Service Worker & Manifest for Web Version
if (window.location.protocol.startsWith('http')) {
  // Inject Web App Manifest dynamically to prevent local file CORS errors on file://
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = 'manifest.webmanifest';
  document.head.appendChild(link);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('[PWA] Service Worker registered successfully', reg.scope))
        .catch(err => console.warn('[PWA] Service Worker registration failed:', err));
    });
  }
}

// ==================== 7. 全文搜尋與關鍵字高亮 (Full-Text Search & Highlighting) ====================

function performBookSearch(query) {
  if (!query) return;
  const cleanQuery = query.trim();
  if (cleanQuery.length === 0) return;

  currentSearchQuery = cleanQuery;
  const listEl = document.getElementById('search-results-list');
  const infoEl = document.getElementById('sidebar-search-results-info');
  const loadingEl = document.getElementById('sidebar-search-loading');
  const indexingEl = document.getElementById('sidebar-search-indexing');

  if (!listEl) return;

  listEl.innerHTML = '';
  if (infoEl) infoEl.style.display = 'none';
  if (loadingEl) loadingEl.style.display = 'none';
  if (indexingEl) indexingEl.style.display = 'none';

  if (isIndexingBook) {
    if (indexingEl) indexingEl.style.display = 'block';
    const pollInterval = setInterval(() => {
      if (!isIndexingBook) {
        clearInterval(pollInterval);
        performBookSearch(query);
      }
    }, 300);
    return;
  }

  if (!chapterTextsCache || chapterTextsCache.length === 0) {
    if (indexingEl) indexingEl.style.display = 'block';
    buildBookSearchIndex().then(() => {
      if (indexingEl) indexingEl.style.display = 'none';
      if (!chapterTextsCache || chapterTextsCache.length === 0) {
        listEl.innerHTML = `<li style="text-align: center; padding: 20px; color: var(--text-muted); font-family: var(--font-sans);">${getMsg('search_no_results') || 'No matches found.'}</li>`;
        return;
      }
      performBookSearch(query);
    });
    return;
  }

  if (loadingEl) loadingEl.style.display = 'block';

  setTimeout(() => {
    const results = [];
    const lowerQuery = cleanQuery.toLowerCase();
    const queryRegex = new RegExp(escapeRegExp(cleanQuery), 'gi');

    for (const chapter of chapterTextsCache) {
      let match;
      let matchIndexInChapter = 0;
      queryRegex.lastIndex = 0;
      while ((match = queryRegex.exec(chapter.text)) !== null) {
        results.push({
          chapterTitle: chapter.chapterTitle || 'Chapter',
          chapterIndex: chapter.chapterIndex,
          text: chapter.text,
          index: match.index,
          matchIndex: matchIndexInChapter
        });
        matchIndexInChapter++;
      }
    }

    if (loadingEl) loadingEl.style.display = 'none';
    if (infoEl) {
      infoEl.textContent = getMsg('search_results_count', [String(results.length)]) || `Found ${results.length} matches`;
      infoEl.style.display = 'block';
    }

    if (results.length === 0) {
      listEl.innerHTML = `<li style="text-align: center; padding: 20px; color: var(--text-muted); font-family: var(--font-sans);">${getMsg('search_no_results') || 'No matches found.'}</li>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    results.forEach(res => {
      const li = document.createElement('li');
      li.className = 'search-result-item';
      li.style.cssText = 'padding: 12px; margin-bottom: 8px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: all 0.2s;';
      
      const start = Math.max(0, res.index - 40);
      const end = Math.min(res.text.length, res.index + lowerQuery.length + 60);
      let snippet = res.text.substring(start, end);
      if (start > 0) snippet = '...' + snippet;
      if (end < res.text.length) snippet = snippet + '...';

      const queryRegex = new RegExp(escapeRegExp(cleanQuery), 'gi');
      const highlightedSnippet = snippet.replace(queryRegex, match => `<span class="search-snippet-match" style="background-color: rgba(255, 235, 59, 0.4); color: var(--text-color); font-weight: bold; border-radius: 2px; padding: 0 2px;">${match}</span>`);

      li.innerHTML = `
        <div style="font-size: 13px; color: var(--primary-color); font-weight: 600; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; font-family: var(--font-sans);">${res.chapterTitle}</div>
        <div style="font-size: 15px; line-height: 1.5; color: var(--text-color);">${highlightedSnippet}</div>
      `;

      li.addEventListener('click', async () => {
        const isSameChapter = currentChapterIndex === res.chapterIndex;
        if (!isSameChapter) {
          await loadChapter(res.chapterIndex, false, false, false, true, null, null, null, null, null, true);
        }
        highlightAndScrollToSearchQuery(cleanQuery, res.matchIndex, true);
      });

      fragment.appendChild(li);
    });

    listEl.appendChild(fragment);
  }, 50);
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightAndScrollToSearchQuery(query, targetMatchIndex = 0, smoothScroll = true) {
  clearSearchHighlights();

  if (!query) return;
  const cleanQuery = query.trim();
  if (cleanQuery.length === 0) return;

  const contentEl = document.getElementById('book-content');
  if (!contentEl) return;

  const regex = new RegExp(escapeRegExp(cleanQuery), 'gi');
  let matchCount = 0;

  const highlightTextNodes = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue;
      if (regex.test(text)) {
        const span = document.createElement('span');
        span.className = 'search-highlight-wrapper';
        span.innerHTML = text.replace(regex, match => {
          const isTarget = matchCount === targetMatchIndex;
          const markClass = isTarget ? 'search-highlight target-match' : 'search-highlight';
          const idAttr = isTarget ? 'id="search-target-match"' : '';
          matchCount++;
          return `<mark class="${markClass}" ${idAttr}>${match}</mark>`;
        });
        node.parentNode.replaceChild(span, node);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();
      if (tagName !== 'script' && tagName !== 'style' && !node.classList.contains('textLayer')) {
        const children = Array.from(node.childNodes);
        children.forEach(child => highlightTextNodes(child));
      }
    }
  };

  highlightTextNodes(contentEl);

  setTimeout(() => {
    const target = contentEl.querySelector('#search-target-match') || contentEl.querySelector('.search-highlight');
    if (target) {
      target.scrollIntoView({ behavior: smoothScroll ? 'smooth' : 'auto', block: 'center' });
    }
  }, 150);
}

function clearSearchHighlights() {
  const contentEl = document.getElementById('book-content');
  if (!contentEl) return;

  const wrappers = contentEl.querySelectorAll('.search-highlight-wrapper');
  wrappers.forEach(wrapper => {
    const parent = wrapper.parentNode;
    if (parent) {
      const textNode = document.createTextNode(wrapper.textContent);
      parent.replaceChild(textNode, wrapper);
      parent.normalize();
    }
  });
}
