// 輔助函式：將文字切分為句子，同時避免在英文縮寫、縮寫首字母（如 J. F.）或小數點（如 3.14）處發生錯誤截斷
function splitTextIntoSentences(text) {
  const parts = text.split(/([。！？.!?\r\n]+)/);
  const sentences = [];
  let currentSentence = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || part === null) continue;

    if (i % 2 === 0) {
      // 文本段落
      currentSentence += part;
    } else {
      // 定界符段落
      if (part.includes('.')) {
        const prevText = currentSentence.trim();
        const nextPart = parts[i + 1] || "";
        
        // 1. 是否為小數點 (前後均為數字)
        const isDecimal = /\d$/.test(prevText) && /^\d/.test(nextPart.trim());
        
        // 2. 是否為英文名字/縮寫首字母 (前一個單字僅包含單個英文字母)
        const lastWordMatch = prevText.match(/\b([a-zA-Z])$/);
        const isInitial = lastWordMatch !== null;
        
        // 3. 是否為常見英文縮寫
        const commonAbbrs = /\b(Mr|Mrs|Ms|Dr|Prof|vs|etc|eg|ie|vol|p|pp|Gen|Col|Maj|Capt|Lt|Sgt)\b/i;
        const isAbbr = commonAbbrs.test(prevText);

        if (isDecimal || isInitial || isAbbr) {
          // 不視為句子結束：直接拼接到當前句子中並繼續
          currentSentence += part;
        } else {
          // 視為句子結束
          currentSentence += part;
          if (currentSentence.trim().length > 0) {
            sentences.push(currentSentence);
          }
          currentSentence = "";
        }
      } else {
        // 其他定界符 (如 。 ！ ？ ! ? \n 等) 必然是句子結束
        currentSentence += part;
        if (currentSentence.trim().length > 0) {
          sentences.push(currentSentence);
        }
        currentSentence = "";
      }
    }
  }

  if (currentSentence.trim().length > 0) {
    sentences.push(currentSentence);
  }

  return sentences;
}

// 輔助函式：判斷一個句子是否僅為用於分割段落的裝飾/分隔符號（如 ***, ---, ◆◆◆）
function isSeparatorSentence(text) {
  const clean = text.replace(/\s+/g, '');
  if (clean.length === 0) return false;
  // 1. 包含連續2個以上的 *, -, _, =, #, ~, +, ., /, \, — 等特殊符號的純符號串
  if (/^[*\-_=#~+./\\—]{2,}$/.test(clean)) return true;
  // 2. 包含常見的裝飾分割符號如 ◆◇●○■□▲△★☆※
  if (/^[◆◇●○■□▲△★☆※]{1,}$/.test(clean)) return true;
  return false;
}

export class TTSEngine {
  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    
    // 播放狀態定義
    this.isPlaying = false;
    this.isPaused = false;
    this.isInitialPlay = false; // 標記是否為點擊開始的初始播放狀態
    this.playbackStarted = false; // 標記是否已經成功開始播放
    this.currentlyPlayingIndex = -1; // 標記當前實際播放的句子絕對索引
    
    this.sentences = [];      // 當前章節的所有句子 (會隨預加載動態追加)
    this.currentIndex = 0;    // 當前播放的句子索引
    this.container = null;    // 閱讀器內容容器 DOM
    
    this.voices = [];         // 合併後的語音列表
    this.selectedVoice = null;
    this.rate = 1.0;          // 朗讀速度
    this.volume = 1.0;        // 朗讀音量
    this.highlightStyle = null; // 高亮樣式類別
    
    // HTML5 Audio 播放隊列與快取
    this.audioCache = new Map(); // index -> { blobUrl, isReady }
    this.fetchingIndices = new Set();
    
    // 建立雙播放器以進行無縫交替播放，消除播放間隙，防止 iOS 後台掛起
    this.players = typeof Audio !== 'undefined' ? [new Audio(), new Audio()] : [];
    this.activePlayerIdx = 0;
    this.currentAudio = null; // 當前正在播放的 Audio 對象
    
    this.players.forEach(audio => {
      audio.preload = 'auto';
      audio.disableRemotePlayback = true; // 停用遠端播放，提高 iOS 穩定性
      
      audio.addEventListener('pause', () => {
        if (this.isPlaying && !this.isPaused && audio === this.currentAudio) {
          this.pause();
        }
      });
      audio.addEventListener('play', () => {
        if (this.isPlaying && this.isPaused && audio === this.currentAudio) {
          this.resume();
        }
      });
    });

    this.nativeQueue = new Set(); // 儲存預載排隊中的 native 句子索引
    this.silenceAudio = null; // 用於移動端後台持續播放的靜音播放器

    // 跨章節無縫播放與數據預加載變量
    this.currentChapterIndex = 0;
    this.getNextChapterData = null; // 獲取下一章數據的回調 (由外部傳入，返回 Promise<{index, html}>)
    this.onChapterTransition = null; // 跨章節過渡時的回調 (由外部傳入)
    
    this.prefetchedChapterIndex = null; // 當前已預加載的章節索引，避免重複預加載

    // 事件回調
    this.onSentenceStart = null;
    this.onPlaybackEnd = null;
    this.onStateChange = null;

    this.clockSkew = 0; // 用於與服務器同步時間，以產生正確的 Sec-MS-GEC Token
    this.consecutiveWsFailures = 0; // 連續 WebSocket 語音加載失敗計數器，用於自動降級 fallback
    this.playbackStartSessionIndex = null;

    // Custom LLM / Local TTS Config
    this.ttsProvider = 'edge'; // 'edge' | 'system' | 'openai' | 'local'
    this.ttsApiKey = '';
    this.ttsEndpoint = '';
    this.ttsModel = 'tts-1';

    // Listen for media action events from NativeTTS
    if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS) {
      try {
        window.Capacitor.Plugins.NativeTTS.addListener('mediaAction', (data) => {
          console.log("Received native media action:", data.action);
          if (!this.isPlaying) return;
          switch (data.action) {
            case 'play':
              if (this.isPaused) this.resume();
              break;
            case 'pause':
              if (!this.isPaused) this.pause();
              break;
            case 'toggle':
              if (this.isPaused) {
                this.resume();
              } else {
                this.pause();
              }
              break;
            case 'next':
              this.next();
              break;
            case 'previous':
              this.previous();
              break;
            case 'stop':
              this.stop();
              break;
          }
        });
      } catch (e) {
        console.warn("Failed to register NativeTTS mediaAction listener:", e);
      }
    }

    this._initVoices();
  }

  // 設置配置項
  configure({ provider, apiKey, endpoint, model }) {
    let voiceChanged = false;
    if (provider !== undefined && this.ttsProvider !== provider) {
      this.ttsProvider = provider;
      voiceChanged = true;
    }
    if (apiKey !== undefined && this.ttsApiKey !== apiKey) {
      this.ttsApiKey = apiKey;
    }
    if (endpoint !== undefined && this.ttsEndpoint !== endpoint) {
      this.ttsEndpoint = endpoint;
    }
    if (model !== undefined && this.ttsModel !== model) {
      this.ttsModel = model;
    }
    if (voiceChanged) {
      this._initVoices();
    }
  }

  // 1. 初始化並加載語音包 (使用 SpeechSynthesis 獲取系統與 Edge 雲端語音)
  async _initVoices() {
    if (this.ttsProvider === 'openai') {
      this.voices = [
        { name: 'Alloy (OpenAI)', lang: 'multilingual', friendlyName: 'Alloy', shortName: 'alloy', gender: 'neutral', isEdge: false, isNative: false, type: 'openai' },
        { name: 'Echo (OpenAI)', lang: 'multilingual', friendlyName: 'Echo', shortName: 'echo', gender: 'neutral', isEdge: false, isNative: false, type: 'openai' },
        { name: 'Fable (OpenAI)', lang: 'multilingual', friendlyName: 'Fable', shortName: 'fable', gender: 'neutral', isEdge: false, isNative: false, type: 'openai' },
        { name: 'Onyx (OpenAI)', lang: 'multilingual', friendlyName: 'Onyx', shortName: 'onyx', gender: 'male', isEdge: false, isNative: false, type: 'openai' },
        { name: 'Nova (OpenAI)', lang: 'multilingual', friendlyName: 'Nova', shortName: 'nova', gender: 'female', isEdge: false, isNative: false, type: 'openai' },
        { name: 'Shimmer (OpenAI)', lang: 'multilingual', friendlyName: 'Shimmer', shortName: 'shimmer', gender: 'female', isEdge: false, isNative: false, type: 'openai' },
      ];
      if (this.onStateChange) this.onStateChange();
      return;
    } else if (this.ttsProvider === 'local') {
      this.voices = [
        { name: 'Alloy (Local)', lang: 'multilingual', friendlyName: 'Alloy', shortName: 'alloy', gender: 'neutral', isEdge: false, isNative: false, type: 'local' },
        { name: 'Echo (Local)', lang: 'multilingual', friendlyName: 'Echo', shortName: 'echo', gender: 'neutral', isEdge: false, isNative: false, type: 'local' },
        { name: 'Fable (Local)', lang: 'multilingual', friendlyName: 'Fable', shortName: 'fable', gender: 'neutral', isEdge: false, isNative: false, type: 'local' },
        { name: 'Onyx (Local)', lang: 'multilingual', friendlyName: 'Onyx', shortName: 'onyx', gender: 'male', isEdge: false, isNative: false, type: 'local' },
        { name: 'Nova (Local)', lang: 'multilingual', friendlyName: 'Nova', shortName: 'nova', gender: 'female', isEdge: false, isNative: false, type: 'local' },
        { name: 'Shimmer (Local)', lang: 'multilingual', friendlyName: 'Shimmer', shortName: 'shimmer', gender: 'female', isEdge: false, isNative: false, type: 'local' },
      ];
      if (this.onStateChange) this.onStateChange();
      return;
    }

    const getWebSpeechVoices = () => {
      if (this.synth) {
        return this.synth.getVoices().map(v => ({
          name: v.name,
          lang: v.lang || '',
          friendlyName: v.name,
          gender: 'unknown',
          isEdge: v.name.includes('Online (Natural)') || v.name.includes('Natural') || v.name.includes('Neural'),
          isNative: true,
          rawVoice: v,
          type: 'speechSynthesis'
        }));
      }
      return [];
    };

    if (this.ttsProvider === 'system') {
      this.voices = getWebSpeechVoices();
      if (this.onStateChange) this.onStateChange();
      return;
    }

    const loadVoices = () => {
      const voices = getWebSpeechVoices();
      if (voices.length > 0) {
        const existingNames = new Set(this.voices.map(v => v.name));
        const newVoices = voices.filter(v => !existingNames.has(v.name));
        if (newVoices.length > 0) {
          this.voices = [...this.voices, ...newVoices];
          if (this.onStateChange) this.onStateChange();
        }
      }
    };

    loadVoices();
    if (this.synth && this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = loadVoices;
    }

    // 獲取微軟 Edge 官方線上神經網路語音列表 (使其支援 Chrome 瀏覽器，使用 background-worker 代替 fetch 避免 CORS 限制)
    try {
      let list = null;
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: "fetchVoices" }, (res) => {
            if (chrome.runtime.lastError) {
              console.warn("Failed to fetch voices via service worker:", chrome.runtime.lastError);
              resolve({ success: false });
            } else {
              resolve(res || { success: false });
            }
          });
        });
        if (response && response.success) {
          list = response.data;
          if (response.serverDate) {
            this.clockSkew = new Date(response.serverDate).getTime() - Date.now();
            console.log(`TTS Clock synced via Service Worker. Skew: ${this.clockSkew} ms`);
          }
        }
      }

      if (!list) {
        // 退化降級：若無 extension context，嘗試透過本地 API 或直接 fetch
        const isNativeApp = typeof window !== 'undefined' && (
          window.Capacitor ||
          window.location.protocol === 'capacitor:' ||
          window.location.protocol === 'app:' ||
          window.location.protocol === 'file:'
        );
        const isWeb = !isNativeApp && (window.location.protocol === 'http:' || window.location.protocol === 'https:');
        const url = isWeb 
          ? "/api/voices" 
          : "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
        const response = await fetch(url).catch(() => null);
        if (response && response.ok) {
          list = await response.json();
          const serverDate = response.headers.get("x-server-date") || response.headers.get("Date");
          if (serverDate) {
            this.clockSkew = new Date(serverDate).getTime() - Date.now();
            console.log(`TTS Clock synced via local web proxy. Skew: ${this.clockSkew} ms`);
          }
        }
      }

      if (!list) {
        // 靜態備用列表：若無法透過網路或 background worker 取得列表（例如在 file:// 下受 CORS 限制），
        // 我們直接硬編碼預置最熱門的高品質 Microsoft Edge Online 語音，使其可在離線版中使用 WebSocket 正常播放。
        list = [
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)", Locale: "zh-CN", ShortName: "zh-CN-XiaoxiaoNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-CN, YunxiNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, YunxiNeural)", Locale: "zh-CN", ShortName: "zh-CN-YunxiNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-CN, YunjianNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, YunjianNeural)", Locale: "zh-CN", ShortName: "zh-CN-YunjianNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoChenNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoChenNeural)", Locale: "zh-TW", ShortName: "zh-TW-HsiaoChenNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoYuNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoYuNeural)", Locale: "zh-TW", ShortName: "zh-TW-HsiaoYuNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-TW, YunJheNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-TW, YunJheNeural)", Locale: "zh-TW", ShortName: "zh-TW-YunJheNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-HK, HiuMaanNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-HK, HiuMaanNeural)", Locale: "zh-HK", ShortName: "zh-HK-HiuMaanNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)", Locale: "en-US", ShortName: "en-US-AriaNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-US, GuyNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-US, GuyNeural)", Locale: "en-US", ShortName: "en-US-GuyNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)", Locale: "en-US", ShortName: "en-US-JennyNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (ja-JP, NanamiNeural)", Name: "Microsoft Server Speech Text to Speech Voice (ja-JP, NanamiNeural)", Locale: "ja-JP", ShortName: "ja-JP-NanamiNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (ja-JP, KeitaNeural)", Name: "Microsoft Server Speech Text to Speech Voice (ja-JP, KeitaNeural)", Locale: "ja-JP", ShortName: "ja-JP-KeitaNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (ko-KR, SunHiNeural)", Name: "Microsoft Server Speech Text to Speech Voice (ko-KR, SunHiNeural)", Locale: "ko-KR", ShortName: "ko-KR-SunHiNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (ko-KR, InJoonNeural)", Name: "Microsoft Server Speech Text to Speech Voice (ko-KR, InJoonNeural)", Locale: "ko-KR", ShortName: "ko-KR-InJoonNeural", Gender: "Male" }
        ];
      }

      if (list) {
        const edgeVoices = list.map(v => ({
          name: v.FriendlyName || v.Name,
          lang: v.Locale,
          friendlyName: v.FriendlyName || v.Name,
          shortName: v.ShortName,
          gender: v.Gender ? v.Gender.toLowerCase() : 'unknown',
          isEdge: true,
          isNative: false,
          type: 'edgeOnline'
        }));
        if (edgeVoices.length > 0) {
          // 合併本地語音，保留微軟語音並剔除重複項目
          const merged = [...edgeVoices];
          const local = getWebSpeechVoices();
          local.forEach(lv => {
            if (!merged.some(mv => mv.name === lv.name || (mv.shortName && lv.name.includes(mv.shortName)))) {
              merged.push(lv);
            }
          });
          this.voices = merged;
          if (this.onStateChange) this.onStateChange();
        }
      }
    } catch (e) {
      console.warn("Failed to fetch Edge online voice list, fallback to WebSpeech API:", e);
    }
  }

  // 獲取適用於指定語言的語音包，優先加載 Edge Natural / Neural 語音，且只顯示該語言分類下的語音
  getVoicesForLanguage(langCode) {
    const cleanLang = langCode.toLowerCase().replace('_', '-');
    const langPrefix = cleanLang.split('-')[0]; // e.g. 'zh' or 'en'
    
    // 過濾出與目標語言前綴匹配的語音包，防止下拉選單顯示過多無關語言的語音
    let matched = this.voices.filter(v => {
      const vLang = v.lang.toLowerCase().replace('_', '-');
      return vLang.startsWith(langPrefix) || vLang === 'multilingual';
    });
    
    // 若無任何語音匹配該前綴，退化為顯示所有語音
    if (matched.length === 0) {
      matched = [...this.voices];
    }
    
    const sorted = [...matched];
    
    sorted.sort((a, b) => {
      const aLang = a.lang.toLowerCase().replace('_', '-');
      const bLang = b.lang.toLowerCase().replace('_', '-');
      
      const aMatch = aLang.startsWith(cleanLang) || (cleanLang.startsWith('zh') && aLang.startsWith('zh'));
      const bMatch = bLang.startsWith(cleanLang) || (cleanLang.startsWith('zh') && bLang.startsWith('zh'));
      
      // 1. 首選語言排在最前面
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      
      // 2. 如果語言不同，按語言代碼字母排序
      if (aLang !== bLang) {
        return aLang.localeCompare(bLang);
      }
      
      // 3. 在同一語言中，優先 Online/Natural/Neural 語音
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aNatural = aName.includes('natural') || aName.includes('online') || aName.includes('neural') || a.isEdge;
      const bNatural = bName.includes('natural') || bName.includes('online') || bName.includes('neural') || b.isEdge;
      
      if (aNatural && !bNatural) return -1;
      if (!aNatural && bNatural) return 1;
      
      // 4. 按名稱排序
      return a.name.localeCompare(b.name);
    });
    
    return sorted;
  }

  // 輔助函式：向上遍歷父鏈以判斷是否為標題節點
  _isHeadingNode(node) {
    let curr = node;
    while (curr && curr.parentNode) {
      if (curr.nodeType === Node.ELEMENT_NODE) {
        const tag = curr.tagName.toLowerCase();
        if (tag.match(/^h[1-6]$/) || tag === 'title') {
          return true;
        }
      }
      curr = curr.parentNode;
    }
    return false;
  }

  // 2. 將 DOM 容器中的文字節點安全拆分為句子，並包裹成 SPAN
  prepareContainer(containerElement, epubBookData = null) {
    this.epubBookData = epubBookData;
    this.container = containerElement;
    this.sentences = [];
    this.currentIndex = 0;
    
    let sentenceId = 0;

    // 找出所有與當前章節共享相同 cleanHref 的子章節及其 hash 對照，以便為每句話分配精確的 chapterIndex
    const subChapters = [];
    if (epubBookData && epubBookData.chapters && this.currentChapterIndex !== undefined) {
      const currentChapter = epubBookData.chapters[this.currentChapterIndex];
      if (currentChapter) {
        epubBookData.chapters.forEach((ch, idx) => {
          if (ch.cleanHref === currentChapter.cleanHref) {
            subChapters.push({ hash: ch.hash || '', index: idx });
          }
        });
      }
    }
    let activeSubChapterIndex = subChapters.length > 0 ? subChapters[0].index : this.currentChapterIndex;

    let currentText = "";
    let currentElements = [];
    let currentActiveSubChapterIndex = activeSubChapterIndex;
    let isHeading = false;

    const isBlockElement = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const tagName = node.tagName.toLowerCase();
      const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'td', 'blockquote', 'section', 'article', 'aside', 'header', 'footer', 'dt', 'dd'];
      return blockTags.includes(tagName);
    };

    const flushCurrentSentence = () => {
      const cleanSentence = currentText.trim();
      if (cleanSentence.length > 0) {
        if (currentElements.length > 0) {
          if (!isSeparatorSentence(cleanSentence)) {
            this.sentences.push({
              index: sentenceId,
              relativeIndex: sentenceId,
              chapterIndex: currentActiveSubChapterIndex,
              text: cleanSentence,
              isHeading: isHeading,
              elements: [...currentElements],
              element: currentElements[0]
            });
            currentElements.forEach(el => {
              el.setAttribute('data-sentence-index', sentenceId);
            });
            sentenceId++;
          }
        }
      }
      currentText = "";
      currentElements = [];
    };

    // 遞歸遍歷文字節點
    const traverse = (node) => {
      const isBlock = isBlockElement(node);
      if (isBlock) {
        flushCurrentSentence();
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const nodeId = node.getAttribute('id') || '';
        const nodeName = node.tagName.toLowerCase() === 'a' ? (node.getAttribute('name') || '') : '';
        const matchedSub = subChapters.find(sub => 
          sub.hash && (sub.hash === nodeId || sub.hash === nodeName)
        );
        if (matchedSub) {
          flushCurrentSentence();
          activeSubChapterIndex = matchedSub.index;
          currentActiveSubChapterIndex = matchedSub.index;
        }

        const tagName = node.tagName.toLowerCase();
        
        // 僅跳過上標 (sup)、下標 (sub) 標籤，以及 script, style, textLayer 和 a 標籤，以防誤傷正文中的其他 note 樣式段落或英文單詞
        const isNoteTag = tagName === 'sup' || tagName === 'sub';

        if (isNoteTag || tagName === 'script' || tagName === 'style' || node.classList.contains('textLayer') || tagName === 'a') {
          return;
        }
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (text.trim().length === 0) return;

        // 利用正則與縮寫過濾切分句子，避免名字中的縮寫點或小數點被截斷
        const matches = splitTextIntoSentences(text);

        if (matches && matches.length > 0) {
          const fragment = document.createDocumentFragment();
          
          matches.forEach(s => {
            const cleanSentence = s.trim();
            if (cleanSentence.length > 0) {
              const span = document.createElement('span');
              span.className = 'tts-sentence';
              span.textContent = s; // 保留原始空白與標點
              fragment.appendChild(span);
              
              currentElements.push(span);
              currentText += s;
              isHeading = this._isHeadingNode(node);
              currentActiveSubChapterIndex = activeSubChapterIndex;

              const endsSentence = /[。！？.!?\r\n]/.test(s);
              if (endsSentence) {
                flushCurrentSentence();
              }
            } else {
              fragment.appendChild(document.createTextNode(s));
            }
          });

          node.parentNode.replaceChild(fragment, node);
        }
      } else {
        const children = Array.from(node.childNodes);
        children.forEach(child => traverse(child));
      }

      if (isBlock) {
        flushCurrentSentence();
      }
    };

    traverse(this.container);
    flushCurrentSentence();
  }

  // 無縫切換章節時，將新加載的 DOM element 對應到已預加載的句子對象上
  syncDOM(containerElement, epubBookData = null) {
    this.epubBookData = epubBookData;
    this.container = containerElement;
    let sentenceId = 0;

    const subChapters = [];
    if (epubBookData && epubBookData.chapters && this.currentChapterIndex !== undefined) {
      const currentChapter = epubBookData.chapters[this.currentChapterIndex];
      if (currentChapter) {
        epubBookData.chapters.forEach((ch, idx) => {
          if (ch.cleanHref === currentChapter.cleanHref) {
            subChapters.push({ hash: ch.hash || '', index: idx });
          }
        });
      }
    }
    let activeSubChapterIndex = subChapters.length > 0 ? subChapters[0].index : this.currentChapterIndex;

    let startSentenceIndex = this.sentences.findIndex(sent => sent.chapterIndex === activeSubChapterIndex);
    if (startSentenceIndex === -1) {
      startSentenceIndex = this.sentences.findIndex(sent => !sent.element);
    }
    if (startSentenceIndex === -1) {
      startSentenceIndex = 0;
    }

    let currentText = "";
    let currentElements = [];
    let currentActiveSubChapterIndex = activeSubChapterIndex;
    let isHeading = false;

    const isBlockElement = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const tagName = node.tagName.toLowerCase();
      const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'td', 'blockquote', 'section', 'article', 'aside', 'header', 'footer', 'dt', 'dd'];
      return blockTags.includes(tagName);
    };

    const flushCurrentSentence = () => {
      const cleanSentence = currentText.trim();
      if (cleanSentence.length > 0) {
        if (currentElements.length > 0) {
          const targetSentIdx = startSentenceIndex + sentenceId;
          let finalSentIdx = targetSentIdx;

          if (!isSeparatorSentence(cleanSentence)) {
            const hasNoElements = (sent) => !sent.element && (!sent.elements || sent.elements.length === 0);

            let existingSentence = this.sentences.find(sent => 
              sent.chapterIndex === currentActiveSubChapterIndex && 
              sent.text === cleanSentence && 
              hasNoElements(sent)
            );
            if (!existingSentence) {
              existingSentence = this.sentences.find(sent => 
                sent.text === cleanSentence && 
                hasNoElements(sent)
              );
            }

            if (existingSentence) {
              existingSentence.element = currentElements[0];
              existingSentence.elements = [...currentElements];
              existingSentence.chapterIndex = currentActiveSubChapterIndex;
              existingSentence.isHeading = isHeading;
              finalSentIdx = existingSentence.index;
            } else {
              // 退化降級：直接按 index 對照
              const sentByIndex = this.sentences[targetSentIdx];
              if (sentByIndex) {
                sentByIndex.element = currentElements[0];
                sentByIndex.elements = [...currentElements];
                sentByIndex.chapterIndex = currentActiveSubChapterIndex;
                sentByIndex.isHeading = isHeading;
                finalSentIdx = sentByIndex.index;
              }
            }

            currentElements.forEach(el => {
              el.setAttribute('data-sentence-index', finalSentIdx);
            });
            sentenceId++;
          }
        }
      }
      currentText = "";
      currentElements = [];
    };

    const traverse = (node) => {
      const isBlock = isBlockElement(node);
      if (isBlock) {
        flushCurrentSentence();
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const nodeId = node.getAttribute('id') || '';
        const nodeName = node.tagName.toLowerCase() === 'a' ? (node.getAttribute('name') || '') : '';
        const matchedSub = subChapters.find(sub => 
          sub.hash && (sub.hash === nodeId || sub.hash === nodeName)
        );
        if (matchedSub) {
          flushCurrentSentence();
          activeSubChapterIndex = matchedSub.index;
          currentActiveSubChapterIndex = matchedSub.index;
        }

        const tagName = node.tagName.toLowerCase();
        
        // 僅跳過上標 (sup)、下標 (sub) 標籤，以及 script, style, textLayer 和 a 標籤，以防誤傷正文中的其他 note 樣式段落或英文單詞
        const isNoteTag = tagName === 'sup' || tagName === 'sub';

        if (isNoteTag || tagName === 'script' || tagName === 'style' || node.classList.contains('textLayer') || tagName === 'a') {
          return;
        }
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (text.trim().length === 0) return;

        const matches = splitTextIntoSentences(text);

        if (matches && matches.length > 0) {
          const fragment = document.createDocumentFragment();
          
          matches.forEach(s => {
            const cleanSentence = s.trim();
            if (cleanSentence.length > 0) {
              const span = document.createElement('span');
              span.className = 'tts-sentence';
              span.textContent = s;
              fragment.appendChild(span);
              
              currentElements.push(span);
              currentText += s;
              isHeading = this._isHeadingNode(node);
              currentActiveSubChapterIndex = activeSubChapterIndex;

              const endsSentence = /[。！？.!?\r\n]/.test(s);
              if (endsSentence) {
                flushCurrentSentence();
              }
            } else {
              fragment.appendChild(document.createTextNode(s));
            }
          });

          node.parentNode.replaceChild(fragment, node);
        }
      } else {
        const children = Array.from(node.childNodes);
        children.forEach(child => traverse(child));
      }

      if (isBlock) {
        flushCurrentSentence();
      }
    };

    traverse(this.container);
    flushCurrentSentence();

    // DOM 映射完成後，等瀏覽器完成佈局渲染後高亮並平移至當前正在播放的句子
    if (this.isPlaying) {
      setTimeout(() => {
        if (!this.isPlaying) return;
        const currentSent = this.sentences[this.currentIndex];
        if (currentSent && currentSent.element) {
          this._highlightSentence(currentSent);
        }
      }, 100);
    }
  }

  // 直接設置純文本句子
  setRawText(text) {
    this.sentences = [];
    this.currentIndex = 0;
    
    const matches = splitTextIntoSentences(text);
    
    if (matches) {
      matches.forEach((s, index) => {
        const clean = s.trim();
        if (clean.length > 0) {
          if (!isSeparatorSentence(clean)) {
            this.sentences.push({
              index: this.sentences.length,
              chapterIndex: this.currentChapterIndex,
              text: clean,
              isHeading: false,
              element: null
            });
          }
        }
      });
    }
  }

  // 直接設置預先映射好的句子隊列
  setSentences(sentences) {
    this.sentences = sentences;
    this.currentIndex = 0;
  }

  // 3. Edge 語音下載輔助方法
  _generateConnectionId() {
    return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[x]/g, () => {
      return (Math.random() * 16 | 0).toString(16);
    });
  }

  _dateToString() {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const d = new Date();
    const dayName = days[d.getUTCDay()];
    const monthName = months[d.getUTCMonth()];
    const date = d.getUTCDate().toString().padStart(2, '0');
    const year = d.getUTCFullYear();
    const hours = d.getUTCHours().toString().padStart(2, '0');
    const minutes = d.getUTCMinutes().toString().padStart(2, '0');
    const seconds = d.getUTCSeconds().toString().padStart(2, '0');
    return `${dayName} ${monthName} ${date} ${year} ${hours}:${minutes}:${seconds} GMT+0000 (Coordinated Universal Time)`;
  }

  _escapeXml(unsafe) {
    return unsafe.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  }

  _sha256PureJs(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    
    var mathPow = Math.pow;
    var maxWord = mathPow(2, 32);
    var lengthProperty = 'length';
    var i, j;
    var result = '';
    var words = [];
    var asciiBitLength = ascii[lengthProperty] * 8;
    var hash = [];
    var k = [];
    var primeCounter = 0;
    
    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) {
          isComposite[i] = candidate;
        }
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1/3) * maxWord) | 0;
      }
    }
    
    ascii += '\x80';
    while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii[lengthProperty]; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return ""; // ASCII check
      words[i >> 2] |= j << (24 - (i % 4) * 8);
    }
    words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
    words[words[lengthProperty]] = (asciiBitLength | 0);
    
    for (j = 0; j < words[lengthProperty]; ) {
      var w = words.slice(j, j += 16);
      var oldHash = hash.slice(0);
      
      for (i = 0; i < 64; i++) {
        var w16 = w[i - 16], w15 = w[i - 15], w2 = w[i - 2], w7 = w[i - 7];
        var s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        var s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        var newWord = w[i] = (i < 16) ? (w[i] || 0) : (w16 + s0 + w7 + s1) | 0;
        
        var s3 = rightRotate(oldHash[0], 2) ^ rightRotate(oldHash[0], 13) ^ rightRotate(oldHash[0], 22);
        var maj = (oldHash[0] & oldHash[1]) ^ (oldHash[0] & oldHash[2]) ^ (oldHash[1] & oldHash[2]);
        var t2 = (s3 + maj) | 0;
        
        var s2 = rightRotate(oldHash[4], 6) ^ rightRotate(oldHash[4], 11) ^ rightRotate(oldHash[4], 25);
        var ch = (oldHash[4] & oldHash[5]) ^ (~oldHash[4] & oldHash[6]);
        var t1 = (oldHash[7] + s2 + ch + k[i] + newWord) | 0;
        
        oldHash = [(t1 + t2) | 0].concat(oldHash);
        oldHash[4] = (oldHash[4] + t1) | 0;
      }
      
      for (i = 0; i < 8; i++) {
        hash[i] = (hash[i] + oldHash[i]) | 0;
      }
    }
    
    for (i = 0; i < 8; i++) {
      var word = hash[i];
      for (j = 3; j >= 0; j--) {
        var byte = (word >> (j * 8)) & 0xff;
        result += byte.toString(16).padStart(2, '0');
      }
    }
    return result;
  }

  async _generateSecMsGecToken() {
    const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
    const WIN_EPOCH = 11644473600;
    
    let unixSeconds = Math.floor((Date.now() + (this.clockSkew || 0)) / 1000);
    unixSeconds += WIN_EPOCH;
    unixSeconds -= (unixSeconds % 300);
    
    const ticks = BigInt(unixSeconds) * 10000000n;
    const strToHash = ticks.toString() + TRUSTED_CLIENT_TOKEN;
    
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      try {
        const encoder = new TextEncoder();
        const data = encoder.encode(strToHash);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        return hashHex;
      } catch (e) {
        console.warn("crypto.subtle failed, falling back to pure JS SHA-256:", e);
      }
    }
    
    return this._sha256PureJs(strToHash).toUpperCase();
  }

  _getVoiceShortName(voice) {
    if (!voice) return 'zh-CN-XiaoxiaoNeural';
    
    // 如果語音物件帶有從 API 載入的 shortName，直接返回
    if (voice.shortName) {
      return voice.shortName;
    }
    
    const name = voice.name;
    const lang = voice.lang || 'zh-CN';
    const cleanLang = lang.replace('_', '-');
    
    if (name.includes('Neural') && name.includes('-')) {
      return name;
    }
    
    const match = name.match(/Microsoft\s+([A-Za-z0-9]+)\s+/i);
    if (match) {
      const charName = match[1];
      return `${cleanLang}-${charName}Neural`;
    }
    
    if (cleanLang.startsWith('zh-cn') || cleanLang.startsWith('zh-CN')) {
      if (name.includes('Yunxi')) return 'zh-CN-YunxiNeural';
      if (name.includes('Xiaoxiao')) return 'zh-CN-XiaoxiaoNeural';
      if (name.includes('Yunjian')) return 'zh-CN-YunjianNeural';
      if (name.includes('Xiaoyi')) return 'zh-CN-XiaoyiNeural';
      return 'zh-CN-XiaoxiaoNeural';
    } else if (cleanLang.startsWith('zh-hk')) {
      return 'zh-HK-HiuMaanNeural';
    } else if (cleanLang.startsWith('zh-tw')) {
      return 'zh-TW-HsiaoChenNeural';
    } else if (cleanLang.startsWith('en')) {
      if (name.includes('Aria')) return 'en-US-AriaNeural';
      if (name.includes('Guy')) return 'en-US-GuyNeural';
      return 'en-US-AriaNeural';
    }
    
    return name;
  }

  _downloadSentenceAudio(sentence) {
    return new Promise(async (resolve, reject) => {
      try {
        if (this.ttsProvider === 'openai' || this.ttsProvider === 'local') {
          try {
            const defaultEndpoint = this.ttsProvider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:5000/v1';
            const endpoint = (this.ttsEndpoint || defaultEndpoint).replace(/\/+$/, '') + '/audio/speech';
            const apiKey = this.ttsApiKey || '';
            const model = this.ttsModel || 'tts-1';
            const voiceName = (this.selectedVoice && this.selectedVoice.shortName) || 'alloy';

            const headers = {
              'Content-Type': 'application/json'
            };
            if (apiKey) {
              headers['Authorization'] = `Bearer ${apiKey}`;
            }

            let speakText = sentence.text;
            // 清除註釋角標編號（例如 [1]、①、¹、〔注1〕等）
            speakText = speakText.replace(/[\[\(\{〔【](?:[0-9]+|注[0-9]*|[a-zA-Z]+)[\]\)}〕】]/g, '');
            speakText = speakText.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g, '');
            speakText = speakText.replace(/[\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089]/g, '');

            if (!/[。！？.!?；;，,：:]\s*$/.test(speakText)) {
              if (sentence.isHeading) {
                speakText += "。";
              } else {
                speakText += "，";
              }
            }

            const response = await fetch(endpoint, {
              method: 'POST',
              headers: headers,
              body: JSON.stringify({
                model: model,
                input: speakText,
                voice: voiceName,
                response_format: 'mp3'
              })
            });

            if (!response.ok) {
              const errText = await response.text();
              throw new Error(`HTTP ${response.status}: ${errText || response.statusText}`);
            }

            const blob = await response.blob();
            resolve(blob);
          } catch (e) {
            reject(e);
          }
          return;
        }

        const secMsGec = await this._generateSecMsGecToken();
        const connectionId = this._generateConnectionId();
        const voiceShortName = this._getVoiceShortName(this.selectedVoice);
        
        const isNativeApp = typeof window !== 'undefined' && (
          window.Capacitor ||
          window.location.protocol === 'capacitor:' ||
          window.location.protocol === 'app:' ||
          window.location.protocol === 'file:'
        );

        // Native Plugin delegation
        if (isNativeApp && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS) {
          try {
            const result = await window.Capacitor.Plugins.NativeTTS.downloadTTS({
              text: sentence.text,
              voice: voiceShortName,
              connectionId: connectionId,
              secMsGec: secMsGec,
              dateStr: this._dateToString()
            });
            const base64ToBlob = (base64, mimeType) => {
              const byteCharacters = atob(base64);
              const byteNumbers = new Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
              }
              const byteArray = new Uint8Array(byteNumbers);
              return new Blob([byteArray], { type: mimeType });
            };
            const blob = base64ToBlob(result.audioBase64, 'audio/mpeg');
            resolve(blob);
            return;
          } catch (nativeErr) {
            console.error("Native Edge TTS failed, falling back to WebSocket in webview:", nativeErr);
          }
        }

        const isWeb = !isNativeApp && (window.location.protocol === 'http:' || window.location.protocol === 'https:');
        let url;
        if (isWeb) {
          const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          url = `${wsProtocol}//${window.location.host}/api/tts` +
                `?ConnectionId=${connectionId}` +
                `&Sec-MS-GEC=${secMsGec}`;
        } else {
          url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
                `?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4` +
                `&ConnectionId=${connectionId}` +
                `&Sec-MS-GEC=${secMsGec}` +
                `&Sec-MS-GEC-Version=1-143.0.3650.75`;
        }
                    
        const ws = new WebSocket(url);
        const audioChunks = [];
        
        ws.binaryType = 'arraybuffer';
        
        ws.onopen = () => {
          const configMsg = 
            `X-Timestamp:${this._dateToString()}\r\n` +
            `Content-Type:application/json; charset=utf-8\r\n` +
            `Path:speech.config\r\n\r\n` +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: {
                      sentenceBoundaryEnabled: "false",
                      wordBoundaryEnabled: "false"
                    },
                    outputFormat: "audio-24khz-48kbitrate-mono-mp3"
                  }
                }
              }
            });
          ws.send(configMsg);
          
          let speakText = sentence.text;
          // 清除註釋角標編號（例如 [1]、①、¹、〔注1〕等）
          speakText = speakText.replace(/[\[\(\{〔【](?:[0-9]+|注[0-9]*|[a-zA-Z]+)[\]\)}〕】]/g, '');
          speakText = speakText.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g, '');
          speakText = speakText.replace(/[\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089]/g, '');
          
          if (!/[。！？.!?；;，,：:]\s*$/.test(speakText)) {
            if (sentence.isHeading) {
              speakText += "。";
            } else {
              speakText += "，";
            }
          }
          
          const escapedText = this._escapeXml(speakText);
          const ssml = 
            `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
            `<voice name='${voiceShortName}'>` +
            `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
            `${escapedText}` +
            `</prosody>` +
            `</voice>` +
            `</speak>`;
            
          const ssmlMsg = 
            `X-RequestId:${connectionId}\r\n` +
            `Content-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${this._dateToString()}Z\r\n` +
            `Path:ssml\r\n\r\n` +
            ssml;
          ws.send(ssmlMsg);
        };
        
        ws.onmessage = (event) => {
          if (typeof event.data === "string") {
            const separator = "\r\n\r\n";
            const index = event.data.indexOf(separator);
            if (index !== -1) {
              const headersStr = event.data.substring(0, index);
              const headers = {};
              headersStr.split("\r\n").forEach(line => {
                const parts = line.split(":");
                if (parts.length >= 2) {
                  headers[parts[0].trim()] = parts.slice(1).join(":").trim();
                }
              });
              
              if (headers["Path"] === "turn.end") {
                ws.close();
              }
            }
          } else {
            const arrayBuffer = event.data;
            const view = new DataView(arrayBuffer);
            if (arrayBuffer.byteLength < 2) return;
            const headerLength = view.getUint16(0, false);
            if (headerLength + 2 > arrayBuffer.byteLength) return;
            
            const headerBytes = new Uint8Array(arrayBuffer, 2, headerLength - 2);
            const textDecoder = new TextDecoder("utf-8");
            const headersStr = textDecoder.decode(headerBytes);
            const headers = {};
            headersStr.split("\r\n").forEach(line => {
              const parts = line.split(":");
              if (parts.length >= 2) {
                headers[parts[0].trim()] = parts.slice(1).join(":").trim();
              }
            });
            
            if (headers["Path"] === "audio") {
              const audioBytes = new Uint8Array(arrayBuffer, headerLength + 2);
              audioChunks.push(audioBytes);
            }
          }
        };
        
        ws.onclose = () => {
          if (audioChunks.length > 0) {
            const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
            resolve(blob);
          } else {
            reject(new Error("No audio data received"));
          }
        };
        
        ws.onerror = (err) => {
          reject(err);
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  // 4. 預加載控制與播放隊列
  _fetchSentence(index, retryCount = 0) {
    const voice = this.selectedVoice;
    const useNativeSynth = (voice && voice.type === 'speechSynthesis');
    if (useNativeSynth) return;

    if (index >= this.sentences.length) return;
    if (this.audioCache.has(index)) return;
    if (retryCount === 0 && this.fetchingIndices.has(index)) return;

    // 判斷是否進入“分組（10句）發送”階段：
    // 每當開始播放（即 playbackStartSessionIndex 已設定），前10句（index < session + 10）單句獲取以保證極速啟動，
    // 從第11句起，轉為每10句一組進行合併請求
    const isGroupPhase = (typeof this.playbackStartSessionIndex === 'number') && 
                         (index >= this.playbackStartSessionIndex + 10);

    if (!isGroupPhase) {
      // 1. 單句獲取階段
      this.fetchingIndices.add(index);
      const sentence = this.sentences[index];
      
      this._downloadSentenceAudio(sentence).then(blob => {
        this.consecutiveWsFailures = 0;
        this._saveToCache(index, blob);
      }).catch(err => {
        console.error(`Failed to prefetch sentence ${index} (attempt ${retryCount + 1}):`, err);
        this.fetchingIndices.delete(index);
        
        if (retryCount < 2) {
          setTimeout(() => {
            this._fetchSentence(index, retryCount + 1);
          }, 1500);
          return;
        }
        
        this.consecutiveWsFailures = (this.consecutiveWsFailures || 0) + 1;
        if (this.consecutiveWsFailures >= 10) {
          console.warn("WebSocket TTS failed 10 times consecutively. Switching to native Web Speech API.");
          this.consecutiveWsFailures = 0;
          
          const currentLang = (voice && voice.lang) || 'zh-CN';
          const cleanLang = currentLang.split('-')[0].toLowerCase();
          let nativeVoice = this.voices.find(v => v.type === 'speechSynthesis' && v.lang.toLowerCase().startsWith(cleanLang));
          
          if (!nativeVoice) {
            nativeVoice = {
              name: 'System Default',
              lang: cleanLang === 'zh' ? 'zh-CN' : 'en-US',
              friendlyName: 'System Default',
              isEdge: false,
              isNative: true,
              type: 'speechSynthesis'
            };
            this.voices.push(nativeVoice);
          }
          
          let msg = "Microsoft cloud voice connection failed, automatically switched to local system voice.";
          let userLang = (typeof navigator !== 'undefined' && navigator.language) || 'en';
          if (userLang.startsWith('zh-CN') || userLang.startsWith('zh_CN') || userLang.startsWith('zh-sg') || userLang.startsWith('zh-hans') || userLang.toLowerCase() === 'zh') {
            msg = "微软云端语音连接失败（可能由于移动端跨域限制或无网络），已自动为您切换为本地系统语音朗读。";
          } else if (userLang.startsWith('zh')) {
            msg = "微軟雲端語音連接失敗（可能由於移動端跨域限制或無網路），已自動為您切換為本地系統語音朗讀。";
          }
          alert(msg);
          this.setVoice(nativeVoice.name);
          
          const selectEl = document.getElementById('tts-voice-select');
          if (selectEl) {
            selectEl.value = nativeVoice.name;
          }
          
          if (this.isPlaying) {
            this.play(this.currentIndex, true);
          }
          return;
        }

        if (this.isPlaying && this.currentIndex === index) {
          this.currentIndex = index + 1;
          this._playActiveSentence();
        }
      });
    } else {
      // 2. 合併發送階段（每次發送10句）
      // 計算包含 index 的分組起點 index
      const offset = index - (this.playbackStartSessionIndex + 10);
      const groupIdx = Math.floor(offset / 10);
      const groupStartIndex = this.playbackStartSessionIndex + 10 + groupIdx * 10;
      
      if (this.audioCache.has(groupStartIndex)) return;
      if (retryCount === 0 && this.fetchingIndices.has(groupStartIndex)) return;
      
      this.fetchingIndices.add(groupStartIndex);
      
      // 收集該分組的10句文字
      const groupSentences = [];
      for (let i = 0; i < 10; i++) {
        const targetIdx = groupStartIndex + i;
        if (targetIdx < this.sentences.length) {
          groupSentences.push(this.sentences[targetIdx]);
        }
      }
      
      if (groupSentences.length === 0) {
        this.fetchingIndices.delete(groupStartIndex);
        return;
      }
      
      // 合併句子的文字
      const mergedText = groupSentences.map(s => s.text).join(' ');
      const virtualSentence = {
        text: mergedText,
        chapterIndex: groupSentences[0].chapterIndex
      };
      
      this._downloadSentenceAudio(virtualSentence).then(blob => {
        this.consecutiveWsFailures = 0;
        this._saveGroupToCache(groupStartIndex, groupSentences, blob);
      }).catch(err => {
        console.error(`Failed to prefetch group starting at ${groupStartIndex}:`, err);
        this.fetchingIndices.delete(groupStartIndex);
        
        if (retryCount < 2) {
          setTimeout(() => {
            this._fetchSentence(groupStartIndex, retryCount + 1);
          }, 1500);
        }
      });
    }
  }

  _saveToCache(index, blob) {
    if (window.location.protocol === 'file:') {
      const reader = new FileReader();
      reader.onloadend = () => {
        this.audioCache.set(index, {
          blobUrl: reader.result,
          isReady: true,
          isGroup: false
        });
        this.fetchingIndices.delete(index);
        this._onAudioCacheReady(index);
      };
      reader.readAsDataURL(blob);
    } else {
      const blobUrl = URL.createObjectURL(blob);
      this.audioCache.set(index, {
        blobUrl,
        isReady: true,
        isGroup: false
      });
      this.fetchingIndices.delete(index);
      this._onAudioCacheReady(index);
    }
  }

  _saveGroupToCache(groupStartIndex, groupSentences, blob) {
    const onUrlReady = (blobUrl) => {
      // 快取分組的音訊源，記錄所包含的句子清單
      this.audioCache.set(groupStartIndex, {
        blobUrl,
        isReady: true,
        isGroup: true,
        groupStartIndex,
        sentences: groupSentences
      });
      
      // 將分組內的其他 index 關聯指向起點，作為 references
      for (let i = 1; i < groupSentences.length; i++) {
        const idx = groupStartIndex + i;
        this.audioCache.set(idx, {
          isReady: true,
          isGroupRef: true,
          groupStartIndex
        });
      }
      
      this.fetchingIndices.delete(groupStartIndex);
      this._onAudioCacheReady(groupStartIndex);
    };

    if (window.location.protocol === 'file:') {
      const reader = new FileReader();
      reader.onloadend = () => onUrlReady(reader.result);
      reader.readAsDataURL(blob);
    } else {
      onUrlReady(URL.createObjectURL(blob));
    }
  }

  _onAudioCacheReady(index) {
    if (this.isPlaying && this.currentIndex === index && this.currentlyPlayingIndex !== index) {
      this._playActiveSentence();
    }
    if (this.isPlaying && index === this.currentIndex + 1) {
      this._prewarmNextPlayer();
    }
  }

  _getWeightedLength(text) {
    if (!text) return 0;
    const cleanText = text.trim();
    if (!cleanText) return 0;
    
    let length = cleanText.length;
    
    // Count punctuation marks that cause pauses
    const longPauses = (cleanText.match(/[。！？\.!\?\n\r]/g) || []).length;
    const shortPauses = (cleanText.match(/[，；、,;:：]/g) || []).length;
    
    // Add virtual characters for pauses
    // A long pause is about 0.5s - 0.8s, equivalent to ~3.5 Chinese characters spoken speed
    // A short pause is about 0.2s - 0.4s, equivalent to ~1.8 Chinese characters spoken speed
    return length + (longPauses * 3.5) + (shortPauses * 1.8);
  }

  _getGroupBoundaries(sentences, duration) {
    const lengths = sentences.map(s => this._getWeightedLength(s.text));
    const totalLength = lengths.reduce((a, b) => a + b, 0);
    if (totalLength === 0) {
      return sentences.map((_, i) => ({
        start: (duration / sentences.length) * i,
        end: (duration / sentences.length) * (i + 1)
      }));
    }
    
    let currentStart = 0;
    const boundaries = [];
    for (let i = 0; i < sentences.length; i++) {
      const frac = lengths[i] / totalLength;
      const end = currentStart + duration * frac;
      boundaries.push({ start: currentStart, end: end });
      currentStart = end;
    }
    return boundaries;
  }

  _fillPreFetchBuffer() {
    if (!this.isPlaying || !this.playbackStarted) return;
    const voice = this.selectedVoice;
    const useNativeSynth = (voice && voice.type === 'speechSynthesis');
    if (useNativeSynth) return;

    // 保持當前播放位置後方的 70 句處於預載快取狀態。
    // _fetchSentence 會自動處理前 10 句單句獲取與後續每 10 句分組獲取的邏輯。
    for (let i = 1; i <= 70; i++) {
      const targetIndex = this.currentIndex + i;
      if (targetIndex < this.sentences.length) {
        this._fetchSentence(targetIndex);
      }
    }
  }

  _playActiveSentence() {
    if (!this.isPlaying) return;
    
    const index = this.currentIndex;
    if (index >= this.sentences.length) {
      this.stop();
      if (this.onPlaybackEnd) this.onPlaybackEnd();
      return;
    }
    
    const sentence = this.sentences[index];
    const voice = this.selectedVoice;
    const useNativeSynth = (voice && voice.type === 'speechSynthesis');
    
    if (useNativeSynth) {
      this._speakNativeSentence(index);
      return;
    }
    
    const cached = this.audioCache.get(index);
    if (!cached || !cached.isReady) {
      this._fetchSentence(index);
      
      // 如果當前沒有任何音訊在播放，為防止 iOS 挂起 JavaScript，應立刻啟動靜音播放器保活
      if (!this.currentAudio && this.silenceAudio) {
        this.silenceAudio.play().catch(e => console.warn("Failed to resume silence on cache miss:", e));
      }
      return;
    }
    
    this.currentlyPlayingIndex = index;
    
    // 判斷是否為分組播放
    let audioUrl = cached.blobUrl;
    let isGroupPlay = false;
    let groupStartIndex = index;
    let groupSentences = null;
    let idxInGroup = 0;

    if (cached.isGroup) {
      audioUrl = cached.blobUrl;
      isGroupPlay = true;
      groupStartIndex = index;
      groupSentences = cached.sentences;
      idxInGroup = 0;
    } else if (cached.isGroupRef) {
      const parentCache = this.audioCache.get(cached.groupStartIndex);
      if (parentCache && parentCache.isReady) {
        audioUrl = parentCache.blobUrl;
        isGroupPlay = true;
        groupStartIndex = cached.groupStartIndex;
        groupSentences = parentCache.sentences;
        idxInGroup = index - groupStartIndex;
      }
    }
    
    // 獲取下一個閒置的播放器
    const nextPlayerIdx = 1 - this.activePlayerIdx;
    const prevAudio = this.currentAudio;
    const audio = this.players[this.activePlayerIdx];
    this.currentAudio = audio;
    
    const isSameSource = (audio.dataset.srcUrl === audioUrl);
    
    const setupGroupSeeking = () => {
      if (isGroupPlay && groupSentences && audio.duration) {
        const boundaries = this._getGroupBoundaries(groupSentences, audio.duration);
        if (boundaries[idxInGroup]) {
          const targetTime = boundaries[idxInGroup].start;
          if (Math.abs(audio.currentTime - targetTime) > 0.5) {
            audio.currentTime = targetTime;
          }
        }
      }
    };

    if (!isSameSource) {
      audio.src = audioUrl;
      audio.dataset.srcUrl = audioUrl;
      audio.load(); // 強制加載新音訊源，防止 file:// 協議下解碼狀態混亂
      // 確保 iOS Safari 在加載音訊元數據後不會重設播放速度
      audio.onloadedmetadata = () => {
        audio.playbackRate = this.rate;
        setupGroupSeeking();
      };
    } else {
      audio.playbackRate = this.rate;
      setupGroupSeeking();
    }
    audio.volume = this.volume;
    audio.playbackRate = this.rate;
    
    // 跨章節無縫過渡檢測
    // 用於執行高亮與回調的輔助函數（章節切換後需重新讀取句子引用以取得新 DOM 元素）
    const doHighlightAndCallbacks = () => {
      const sent = this.sentences[index] || sentence;
      this._highlightSentence(sent);
      this._updateMediaSession(sent);
      if (this.onSentenceStart) {
        this.onSentenceStart(index);
      }
    };

    if (sentence.chapterIndex !== this.currentChapterIndex) {
      this.currentChapterIndex = sentence.chapterIndex;
      this.prefetchedChapterIndex = null;
      
      if (this.onChapterTransition) {
        // onChapterTransition 是 async 函數（內部 await loadChapter 重建 DOM）
        // 必須等待完成後再高亮，否則句子的 element 引用尚未由 syncDOM 建立
        const transitionPromise = this.onChapterTransition(sentence.chapterIndex);
        if (transitionPromise && typeof transitionPromise.then === 'function') {
          transitionPromise.then(() => {
            if (!this.isPlaying) return;
            doHighlightAndCallbacks();
          });
        } else {
          doHighlightAndCallbacks();
        }
      } else {
        doHighlightAndCallbacks();
      }
      
      this._prefetchNextChapter();
    } else {
      doHighlightAndCallbacks();
    }
    
    // 監聽時間更新事件：在當前句子即將結束前，提前預加載並播放下一句，實現完美無縫交替
    let hasTriggeredNext = false;
    
    if (isGroupPlay) {
      audio.ontimeupdate = () => {
        if (!this.isPlaying) return;
        if (!audio.duration) return;
        
        const boundaries = this._getGroupBoundaries(groupSentences, audio.duration);
        const currentTime = audio.currentTime;
        
        // 尋找當前播放時間對應分組內的哪一句
        let currentIdxInGroup = idxInGroup;
        for (let i = 0; i < boundaries.length; i++) {
          if (currentTime >= boundaries[i].start && currentTime < boundaries[i].end) {
            currentIdxInGroup = i;
            break;
          }
        }
        
        const activeIdx = groupStartIndex + currentIdxInGroup;
        if (activeIdx !== this.currentIndex) {
          this.currentIndex = activeIdx;
          const currentSentence = this.sentences[activeIdx];
          
          if (currentSentence) {
            // 高亮與回調輔助（章節切換後重新讀取句子以取得新 DOM 元素）
            const doGroupHighlight = () => {
              const sent = this.sentences[activeIdx] || currentSentence;
              this._highlightSentence(sent);
              this._updateMediaSession(sent);
              if (this.onSentenceStart) {
                this.onSentenceStart(activeIdx);
              }
              this._fillPreFetchBuffer();
              this._prewarmNextPlayer();
            };

            if (currentSentence.chapterIndex !== this.currentChapterIndex) {
              this.currentChapterIndex = currentSentence.chapterIndex;
              this.prefetchedChapterIndex = null;
              if (this.onChapterTransition) {
                const p = this.onChapterTransition(currentSentence.chapterIndex);
                if (p && typeof p.then === 'function') {
                  p.then(() => {
                    if (!this.isPlaying) return;
                    doGroupHighlight();
                  });
                } else {
                  doGroupHighlight();
                }
              } else {
                doGroupHighlight();
              }
              this._prefetchNextChapter();
            } else {
              doGroupHighlight();
            }
          }
        }
        
        // 計算合理的提前量
        const threshold = Math.min(0.08, audio.duration * 0.08);
        if (currentTime >= audio.duration - threshold) {
          if (!hasTriggeredNext) {
            hasTriggeredNext = true;
            audio.ontimeupdate = null; // 避免重疊期間重複觸發
            
            // 切換至下一個播放器，播放下一分組的起點
            this.activePlayerIdx = nextPlayerIdx;
            this.currentIndex = groupStartIndex + groupSentences.length;
            this._playActiveSentence();
          }
        }
      };
      
      audio.onended = () => {
        audio.ontimeupdate = null;
        audio.onended = null;
        audio.onloadedmetadata = null;
        
        if (audioUrl && audioUrl.startsWith('blob:')) {
          URL.revokeObjectURL(audioUrl);
        }
        for (let i = 0; i < groupSentences.length; i++) {
          this.audioCache.delete(groupStartIndex + i);
        }
        
        if (!this.isPlaying) return;
        
        if (!hasTriggeredNext) {
          hasTriggeredNext = true;
          this.activePlayerIdx = nextPlayerIdx;
          this.currentIndex = groupStartIndex + groupSentences.length;
          this._playActiveSentence();
        }
      };
    } else {
      audio.ontimeupdate = () => {
        if (!this.isPlaying) return;
        
        // 計算合理的提前量。減小提前量至 80ms (或句子長度的 8%)，使其落在結尾標點符號的靜音期，避免語音重疊與音量波動
        const threshold = audio.duration ? Math.min(0.08, audio.duration * 0.08) : 0.08;
        if (audio.duration && audio.currentTime >= audio.duration - threshold) {
          if (!hasTriggeredNext) {
            hasTriggeredNext = true;
            audio.ontimeupdate = null; // 避免重疊期間重複觸發
            
            // 切換至下一個播放器，並播放下一句
            this.activePlayerIdx = nextPlayerIdx;
            this.currentIndex = index + 1;
            this._playActiveSentence();
          }
        }
      };
      
      // 容錯機制：以防 ontimeupdate 由於特殊原因未觸發（例如有些設備或格式的 duration 為空）
      audio.onended = () => {
        audio.ontimeupdate = null;
        audio.onended = null;
        audio.onloadedmetadata = null;
        
        if (cached.blobUrl && cached.blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(cached.blobUrl);
        }
        this.audioCache.delete(index);
        
        if (!this.isPlaying) return;
        
        // 若下一句還沒有被觸發播放，則在此手動觸發
        if (!hasTriggeredNext) {
          hasTriggeredNext = true;
          this.activePlayerIdx = nextPlayerIdx;
          this.currentIndex = index + 1;
          this._playActiveSentence();
        }
      };
    }
    
    audio.play().then(() => {
      // 成功播放後，如果有上一個正在播放的播放器，立即暫停並清理，避免在 iOS 後台因 JavaScript 延時器延遲而造成長時間雙路播放/音量起伏
      if (prevAudio && prevAudio !== audio) {
        try {
          prevAudio.pause();
          prevAudio.ontimeupdate = null;
          prevAudio.onended = null;
          prevAudio.onloadedmetadata = null;
        } catch (e) {}
      }
      
      // 再次強制設置播放速度，以防止部分 iOS 瀏覽器在啟動播放時強制將速度重設為 1.0
      audio.playbackRate = this.rate;
      
      this.playbackStarted = true;
      this._fillPreFetchBuffer();
      this._prefetchNextChapter();
      this._prewarmNextPlayer();
    }).catch(err => {
      console.error("Audio play error:", err);
      audio.ontimeupdate = null;
      audio.onended = null;
      audio.onloadedmetadata = null;
      
      // 若播放失敗，跳過該句子
      if (!hasTriggeredNext) {
        hasTriggeredNext = true;
        this.activePlayerIdx = nextPlayerIdx;
        this.currentIndex = isGroupPlay ? (groupStartIndex + groupSentences.length) : (index + 1);
        this._playActiveSentence();
      }
    });
  }

  _speakNativeSentence(index) {
    if (!this.isPlaying) return;
    if (index >= this.sentences.length) {
      this.stop();
      if (this.onPlaybackEnd) this.onPlaybackEnd();
      return;
    }

    const sentence = this.sentences[index];
    const voice = this.selectedVoice;
    this.nativeQueue.add(index);

    let speakText = sentence.text;
    // 清除註釋角標編號（例如 [1]、①、¹、〔注1〕等）
    speakText = speakText.replace(/[\[\(\{〔【](?:[0-9]+|注[0-9]*|[a-zA-Z]+)[\]\)}〕】]/g, '');
    speakText = speakText.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g, '');
    speakText = speakText.replace(/[\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089]/g, '');

    const utterance = new SpeechSynthesisUtterance(speakText);
    if (voice && this.synth) {
      const liveVoices = this.synth.getVoices();
      const liveVoice = liveVoices.find(v => v.name === voice.name);
      if (liveVoice) {
        utterance.voice = liveVoice;
        utterance.lang = liveVoice.lang || '';
      } else if (voice.rawVoice) {
        utterance.voice = voice.rawVoice;
        utterance.lang = voice.lang || '';
      } else {
        utterance.lang = voice.lang || '';
      }
    } else if (voice) {
      utterance.lang = voice.lang || '';
    } else {
      const hasChinese = /[\u4e00-\u9fa5]/.test(sentence.text);
      utterance.lang = hasChinese ? 'zh-CN' : 'en-US';
    }
    
    utterance.rate = this.rate;
    utterance.volume = this.volume;

    utterance.onstart = () => {
      if (!this.isPlaying) return;
      this.currentIndex = index;
      
      // 跨章節無縫過渡檢測
      const doNativeHighlight = () => {
        const sent = this.sentences[index] || sentence;
        this._highlightSentence(sent);
        this._updateMediaSession(sent);
        if (this.onSentenceStart) {
          this.onSentenceStart(index);
        }
      };

      if (sentence.chapterIndex !== this.currentChapterIndex) {
        this.currentChapterIndex = sentence.chapterIndex;
        this.prefetchedChapterIndex = null;
        if (this.onChapterTransition) {
          const p = this.onChapterTransition(sentence.chapterIndex);
          if (p && typeof p.then === 'function') {
            p.then(() => {
              if (!this.isPlaying) return;
              doNativeHighlight();
            });
          } else {
            doNativeHighlight();
          }
        } else {
          doNativeHighlight();
        }
        this._prefetchNextChapter();
      } else {
        doNativeHighlight();
      }

      // 預先將「下一句」放入瀏覽器的朗讀隊列中，以實現無縫連續過渡
      const nextIndex = index + 1;
      if (nextIndex < this.sentences.length && !this.nativeQueue.has(nextIndex)) {
        this.nativeQueue.add(nextIndex);
        this._speakNativeSentence(nextIndex);
      }
    };

    utterance.onend = () => {
      this.nativeQueue.delete(index);
      if (!this.isPlaying) return;
      
      // 若下一句已在隊列中準備播放，則交由瀏覽器原生隊列切換，防止重複觸發
      if (this.nativeQueue.has(index + 1)) {
        return;
      }
      
      // 若下一句因為特殊原因（如暫停後重開）未能自動觸發，手動跳轉播放
      if (this.currentIndex === index) {
        this.currentIndex = index + 1;
        this._playActiveSentence();
      }
    };

    utterance.onerror = (err) => {
      console.error("SpeechSynthesis utterance error:", err);
      this.nativeQueue.delete(index);
      if (!this.isPlaying) return;
      
      if (this.nativeQueue.has(index + 1)) {
        return;
      }
      
      if (this.currentIndex === index) {
        this.currentIndex = index + 1;
        this._playActiveSentence();
      }
    };

    this.synth.speak(utterance);
  }

  _startSilenceKeepAlive() {
    if (typeof Audio === 'undefined') return;
    
    if (!this.silenceAudio) {
      this.silenceAudio = new Audio();
      this.silenceAudio.src = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV';
      this.silenceAudio.loop = true;
      this.silenceAudio.volume = 0.01;
    }
    
    this.silenceAudio.play().catch(err => {
      console.warn("Failed to play silence audio keep-alive:", err);
    });
  }

  _stopSilenceKeepAlive() {
    if (this.silenceAudio) {
      try {
        this.silenceAudio.pause();
      } catch (e) {}
    }
  }

  _updateMediaSession(sentence) {
    const text = sentence ? sentence.text : 'TTS Reading';
    const title = typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.title || currentBook.title || 'TTS Reading') : 'TTS Reading';
    const artist = typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.author || currentBook.author || 'E-Book Reader') : 'E-Book Reader';

    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
    if (isCapacitorApp) {
      window.Capacitor.Plugins.NativeTTS.updateMetadata({
        title: title,
        artist: artist,
        text: text
      }).catch(e => console.error("Error updating native metadata:", e));
    }

    if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: text,
          artist: artist,
          album: title
        });

        navigator.mediaSession.playbackState = 'playing';

        navigator.mediaSession.setActionHandler('play', () => {
          this.resume();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          this.pause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
          this.previous();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
          this.next();
        });
      } catch (e) {
        console.warn("MediaSession update failed:", e);
      }
    }
  }

  play(index = 0, isAbsolute = false) {
    if (this.sentences.length === 0) return;
    
    // 停止當前播放器並清理播放狀態，但保留音訊快取以加速點擊後的啟動播放
    this.isPlaying = false;
    this.isPaused = false;
    this._stopSilenceKeepAlive();
    
    if (this.synth) {
      this.synth.cancel();
    }
    this.currentUtterance = null;
    this.nativeQueue.clear();
    
    this.players.forEach(p => {
      try {
        p.pause();
        p.removeAttribute('src'); // 移除 src 屬性以防止在 file:// 協議下瀏覽器將空字串解析為當前 HTML 路徑而拋出 CORS 錯誤
        p.load(); // 徹底重置播放器狀態
        if (p.dataset) p.dataset.srcUrl = '';
        p.ontimeupdate = null;
        p.onended = null;
        p.onloadedmetadata = null;
      } catch (e) {}
    });
    this.currentAudio = null;
    
    this.isPlaying = true;
    this.currentlyPlayingIndex = -1;
    
    let absoluteIndex = index;
    if (!isAbsolute) {
      const match = this.sentences.find(sent => sent.chapterIndex === this.currentChapterIndex && sent.relativeIndex === index);
      if (match) {
        absoluteIndex = match.index;
      } else {
        const fallbackMatch = this.sentences.find(sent => sent.relativeIndex === index);
        if (fallbackMatch) {
          absoluteIndex = fallbackMatch.index;
        }
      }
    }
    this.currentIndex = Math.max(0, Math.min(absoluteIndex, this.sentences.length - 1));
    
    // 智能快取淘汰：僅釋放並刪除與新進度相差較遠（例如小於 currentIndex 或大於 currentIndex + 15）的快取項目
    const keysToDelete = [];
    this.audioCache.forEach((cached, idx) => {
      if (idx < this.currentIndex || idx > this.currentIndex + 15) {
        keysToDelete.push(idx);
      }
    });
    keysToDelete.forEach(idx => {
      const cached = this.audioCache.get(idx);
      if (cached) {
        if (cached.blobUrl && cached.blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(cached.blobUrl);
        }
        this.audioCache.delete(idx);
      }
    });
    
    this.isInitialPlay = true; // 標記為點擊開始的初始播放
    this.playbackStarted = false; // 標記尚未開始播放
    this.playbackStartSessionIndex = this.currentIndex;
    
    // 點擊正文後，只向 tts 引擎發送 1 句 (當前句)
    this._fetchSentence(this.currentIndex);

    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
    if (isCapacitorApp) {
      (async () => {
        const bookTitle = typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.title || currentBook.title || 'TTS Reading') : 'TTS Reading';
        const bookArtist = typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.author || currentBook.author || 'E-Book Reader') : 'E-Book Reader';
        const sentence = this.sentences[this.currentIndex];
        const coverBase64 = await getBookCoverBase64();
        window.Capacitor.Plugins.NativeTTS.startForegroundService({
          title: bookTitle,
          artist: bookArtist,
          text: sentence ? sentence.text : '',
          cover: coverBase64,
          isPlaying: true
        }).catch(e => console.error("Error starting native foreground service:", e));
      })();
    }

    this._startSilenceKeepAlive();
    this._playActiveSentence();
    this._prefetchNextChapter();
    if (this.onStateChange) this.onStateChange();
  }

  // 預加載下一章，並將句子直接追加到當前的 sentences 列表中以實現在線預合成
  async _prefetchNextChapter() {
    if (!this.getNextChapterData || this.currentChapterIndex === undefined) return;
    
    const targetNextIndex = this.currentChapterIndex + 1;
    if (this.prefetchedChapterIndex === targetNextIndex) return;
    
    // 提前鎖定標記，防範多個異步調用同時並發預加載同一章節，導致句子隊列重複追加
    this.prefetchedChapterIndex = targetNextIndex;
    
    try {
      const nextChapter = await this.getNextChapterData(this.currentChapterIndex);
      if (!nextChapter || !this.isPlaying) {
        if (this.prefetchedChapterIndex === targetNextIndex) {
          this.prefetchedChapterIndex = null;
        }
        return;
      }
      
      if (nextChapter.index !== targetNextIndex) {
        if (this.prefetchedChapterIndex === targetNextIndex) {
          this.prefetchedChapterIndex = null;
        }
        return;
      }
      
      const nextSentences = this._extractSentencesFromHtml(nextChapter.html, nextChapter.index);
      
      const startIdx = this.sentences.length;
      nextSentences.forEach((s, i) => {
        s.index = startIdx + i;
        s.relativeIndex = i;
        s.chapterIndex = nextChapter.index;
        this.sentences.push(s);
      });
      
      this._fillPreFetchBuffer();
    } catch (e) {
      console.error("Failed to prefetch next chapter:", e);
      if (this.prefetchedChapterIndex === targetNextIndex) {
        this.prefetchedChapterIndex = null;
      }
    }
  }

  _extractSentencesFromHtml(htmlStr, chapterIndex = null) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlStr, 'text/html');
    const sentences = [];
    let sentenceId = 0;

    const subChapters = [];
    const epubBookData = this.epubBookData;
    const targetChapterIdx = chapterIndex !== null ? chapterIndex : this.currentChapterIndex;
    if (epubBookData && epubBookData.chapters && targetChapterIdx !== undefined) {
      const currentChapter = epubBookData.chapters[targetChapterIdx];
      if (currentChapter) {
        epubBookData.chapters.forEach((ch, idx) => {
          if (ch.cleanHref === currentChapter.cleanHref) {
            subChapters.push({ hash: ch.hash || '', index: idx });
          }
        });
      }
    }
    let activeSubChapterIndex = subChapters.length > 0 ? subChapters[0].index : targetChapterIdx;

    let currentText = "";
    let currentActiveSubChapterIndex = activeSubChapterIndex;
    let isHeading = false;

    const isBlockElement = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const tagName = node.tagName.toLowerCase();
      const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'td', 'blockquote', 'section', 'article', 'aside', 'header', 'footer', 'dt', 'dd'];
      return blockTags.includes(tagName);
    };

    const flushCurrentSentence = () => {
      const cleanSentence = currentText.trim();
      if (cleanSentence.length > 0) {
        if (!isSeparatorSentence(cleanSentence)) {
          sentences.push({
            index: sentenceId,
            text: cleanSentence,
            isHeading: isHeading,
            chapterIndex: currentActiveSubChapterIndex,
            element: null,
            elements: []
          });
          sentenceId++;
        }
      }
      currentText = "";
    };

    const traverse = (node) => {
      const isBlock = isBlockElement(node);
      if (isBlock) {
        flushCurrentSentence();
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const nodeId = node.getAttribute('id') || '';
        const nodeName = node.tagName.toLowerCase() === 'a' ? (node.getAttribute('name') || '') : '';
        const matchedSub = subChapters.find(sub => 
          sub.hash && (sub.hash === nodeId || sub.hash === nodeName)
        );
        if (matchedSub) {
          flushCurrentSentence();
          activeSubChapterIndex = matchedSub.index;
          currentActiveSubChapterIndex = matchedSub.index;
        }

        const tagName = node.tagName.toLowerCase();
        const isNoteTag = tagName === 'sup' || tagName === 'sub';

        if (isNoteTag || tagName === 'script' || tagName === 'style' || node.classList.contains('textLayer') || tagName === 'a') {
          return;
        }
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (text.trim().length === 0) return;

        const matches = splitTextIntoSentences(text);

        if (matches && matches.length > 0) {
          matches.forEach(s => {
            const cleanSentence = s.trim();
            if (cleanSentence.length > 0) {
              currentText += s;
              isHeading = this._isHeadingNode(node);
              currentActiveSubChapterIndex = activeSubChapterIndex;

              const endsSentence = /[。！？.!?\r\n]/.test(s);
              if (endsSentence) {
                flushCurrentSentence();
              }
            }
          });
        }
      } else {
        const children = Array.from(node.childNodes);
        children.forEach(child => traverse(child));
      }

      if (isBlock) {
        flushCurrentSentence();
      }
    };

    traverse(doc.body);
    flushCurrentSentence();
    return sentences;
  }

  pause() {
    if (this.isPlaying && !this.isPaused) {
      this.isPaused = true;
      this._stopSilenceKeepAlive();
      
      const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
      if (isCapacitorApp) {
        window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
          isPlaying: false
        }).catch(e => console.error("Error updating native playback state:", e));
      }

      if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }

      const voice = this.selectedVoice;
      const useNativeSynth = (voice && voice.type === 'speechSynthesis');
      if (useNativeSynth && this.synth) {
        this.synth.pause();
      } else if (this.currentAudio) {
        this.currentAudio.pause();
      }
      if (this.onStateChange) this.onStateChange();
    }
  }

  resume() {
    if (this.isPlaying && this.isPaused) {
      this.isPaused = false;
      this._startSilenceKeepAlive();
      
      const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
      if (isCapacitorApp) {
        window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
          isPlaying: true
        }).catch(e => console.error("Error updating native playback state:", e));
      }

      if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }

      const voice = this.selectedVoice;
      const useNativeSynth = (voice && voice.type === 'speechSynthesis');
      if (useNativeSynth && this.synth) {
        this.synth.resume();
      } else if (this.currentAudio) {
        this.currentAudio.play().catch(err => console.error("Resume error:", err));
      }
      if (this.onStateChange) this.onStateChange();
    }
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    this.playbackStarted = false;
    this.currentlyPlayingIndex = -1;
    this._stopSilenceKeepAlive();
    
    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
    if (isCapacitorApp) {
      window.Capacitor.Plugins.NativeTTS.stopForegroundService().catch(e => console.error("Error stopping native foreground service:", e));
    }

    if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }

    if (this.synth) {
      this.synth.cancel();
    }
    this.currentUtterance = null;
    this.nativeQueue.clear();
    
    // 停止所有播放器並清理，防範 iOS 背景殘留播放
    this.players.forEach(p => {
      try {
        p.pause();
        p.removeAttribute('src'); // 移除 src 屬性以防止在 file:// 協議下瀏覽器將空字串解析為當前 HTML 路徑而拋出 CORS 錯誤
        p.load(); // 徹底重置播放器狀態
        if (p.dataset) p.dataset.srcUrl = '';
        p.ontimeupdate = null;
        p.onended = null;
      } catch (e) {}
    });
    this.currentAudio = null;
    
    this.audioCache.forEach(cached => {
      if (cached.blobUrl && cached.blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(cached.blobUrl);
      }
    });
    this.audioCache.clear();
    this.fetchingIndices.clear();
    
    this.prefetchedChapterIndex = null;
    this._clearHighlight();
    if (this.onStateChange) this.onStateChange();
  }

  next() {
    if (this.isPlaying) {
      const nextIndex = Math.min(this.currentIndex + 1, this.sentences.length - 1);
      this.play(nextIndex, true);
    }
  }

  previous() {
    if (this.isPlaying) {
      const prevIndex = Math.max(this.currentIndex - 1, 0);
      this.play(prevIndex, true);
    }
  }

  setRate(rate) {
    this.rate = rate;
    this.players.forEach(p => {
      try {
        p.playbackRate = this.rate;
      } catch (e) {}
    });
  }

  _prewarmNextPlayer() {
    if (!this.isPlaying) return;
    const nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.sentences.length) return;

    const cached = this.audioCache.get(nextIndex);
    if (cached && cached.isReady) {
      // 如果下一句屬於同一個合併分組，則無需預熱，因為使用的是同一個音訊源
      if (cached.isGroupRef) return;
      
      const nextPlayer = this.players[1 - this.activePlayerIdx];
      if (nextPlayer.dataset.srcUrl !== cached.blobUrl) {
        nextPlayer.src = cached.blobUrl;
        nextPlayer.dataset.srcUrl = cached.blobUrl;
        nextPlayer.load();
        nextPlayer.playbackRate = this.rate;
        nextPlayer.volume = this.volume;
        nextPlayer.onloadedmetadata = () => {
          nextPlayer.playbackRate = this.rate;
        };
      }
    }
  }

  startPrefetch(startIndex = 0) {
    const voice = this.selectedVoice;
    const useNativeSynth = (voice && voice.type === 'speechSynthesis');
    if (useNativeSynth) return;

    if (this.sentences.length === 0) return;
    const start = Math.max(0, Math.min(startIndex, this.sentences.length - 1));
    const bufferSize = 10;
    for (let i = 0; i < bufferSize; i++) {
      const targetIndex = start + i;
      if (targetIndex < this.sentences.length) {
        this._fetchSentence(targetIndex);
      }
    }
  }

  setVoice(voiceName) {
    let newVoice = this.voices.find(v => v.name === voiceName) || null;
    if (!newVoice && voiceName && (this.ttsProvider === 'openai' || this.ttsProvider === 'local')) {
      newVoice = {
        name: voiceName,
        lang: 'multilingual',
        friendlyName: voiceName,
        shortName: voiceName,
        gender: 'neutral',
        isEdge: false,
        isNative: false,
        type: this.ttsProvider
      };
      this.voices.push(newVoice);
    }
    const isChanged = !this.selectedVoice || !newVoice || this.selectedVoice.name !== newVoice.name;
    
    this.selectedVoice = newVoice;
    
    if (isChanged) {
      this.audioCache.forEach(cached => {
        if (cached.blobUrl && cached.blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(cached.blobUrl);
        }
      });
      this.audioCache.clear();
      this.fetchingIndices.clear();
    }

    if (this.isPlaying) {
      if (isChanged) {
        this.play(this.currentIndex, true);
      }
    }
  }

  _highlightSentence(sentence) {
    this._clearHighlight();
    const styleClass = this.highlightStyle || 'highlight-style-yellow';

    // 提取需要高亮的目標元素
    let targetEl = null;
    if (sentence.elements && sentence.elements.length > 0) {
      sentence.elements.forEach(el => {
        el.classList.add('reading-sentence');
        el.classList.add(styleClass);
      });
      targetEl = sentence.elements[0];
    } else if (sentence.element) {
      sentence.element.classList.add(styleClass);
      sentence.element.classList.add('reading-sentence');
      targetEl = sentence.element;
    }

    // 統一滾動邏輯：所有分支共用同一套精確居中滾動
    if (!targetEl) return;
    const isPaginated = document.body.classList.contains('layout-paginated');
    if (isPaginated) return;

    // 【關鍵修復】先中斷任何正在進行的 smooth scroll 動畫。
    // 如果前一句的 smooth scroll 仍在動畫中，getBoundingClientRect() 會返回動畫中間幀的坐標，
    // 導致 isVisible 判斷錯誤（元素在動畫途中看似可見，但動畫完成後被推離視窗中央）。
    // 透過 instant scroll 到當前位置來立即停止動畫，確保後續測量的坐標準確。
    window.scrollTo({ top: window.scrollY, behavior: 'instant' });

    // 強制同步佈局計算，確保 _clearHighlight 移除的 border 與新增的 border 都已反映到佈局中
    const forceReflow = targetEl.offsetHeight;
    const rect = targetEl.getBoundingClientRect();
    const headerHeight = 80;
    const footerHeight = 80;
    // 頂部和底部安全邊距
    const isVisible = rect.top >= (headerHeight + 20) && rect.bottom <= (window.innerHeight - footerHeight - 100);

    if (!isVisible) {
      // 計算絕對 Y 坐標，手動精確滾動到視窗中央
      const absoluteY = rect.top + window.scrollY;
      const targetScrollY = absoluteY - (window.innerHeight / 2) + (rect.height / 2);
      window.scrollTo({
        top: targetScrollY,
        behavior: 'smooth'
      });
    }
  }

  async fetchModels(provider, url, apiKey) {
    const useExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;
    if (useExtension) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'fetchModels', provider: 'openai', url, apiKey }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response.models);
          } else {
            reject(new Error(response?.error || 'Failed to fetch models'));
          }
        });
      });
    } else {
      let fetchUrl = (url ? url.trim() : "");
      if (!fetchUrl) {
        fetchUrl = provider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:5000/v1';
      }
      const headers = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      fetchUrl = fetchUrl.replace(/\/+$/, '') + '/models';
      try {
        const response = await fetch(fetchUrl, { headers });
        if (!response.ok) throw new Error("Status " + response.status);
        const data = await response.json();
        let models = [];
        if (data.data) {
          models = data.data.map(m => m.id);
        }
        return models;
      } catch (err) {
        throw err;
      }
    }
  }

  _clearHighlight() {
    if (this.container) {
      this.container.querySelectorAll('.reading-sentence').forEach(el => {
        el.classList.remove('reading-sentence');
        const classesToRemove = Array.from(el.classList).filter(c => c.startsWith('highlight-style-'));
        classesToRemove.forEach(c => el.classList.remove(c));
      });
    }
  }
}

async function getBookCoverBase64() {
  if (typeof currentBook === 'undefined' || !currentBook || !currentBook.cover) {
    return '';
  }
  try {
    if (typeof currentBook.cover === 'string') {
      if (currentBook.cover.startsWith('data:')) {
        return currentBook.cover;
      }
      return '';
    }
    if (currentBook.cover instanceof Blob) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve('');
        reader.readAsDataURL(currentBook.cover);
      });
    }
  } catch (e) {
    console.warn("Failed to get book cover base64:", e);
  }
  return '';
}
