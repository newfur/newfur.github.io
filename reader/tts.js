// 動態句子合併閾值：
// 僅限制單句最短長度（同段落內合併至至少 100 字），絕不限制最長長度，且結尾必須是完整的句子結束標點符號，
// 嚴禁在句子中間（如逗號、分號處）打斷，確保每一句都是語義與語調 100% 完整的自然句子。
const TTS_MIN_SENTENCE_LEN = 100;

// 輔助函式：將文字切分為句子，同時避免在英文縮寫、縮寫首字母（如 J. F.）或小數點（如 3.14）處發生錯誤截斷
function splitTextIntoSentences(text) {
  const parts = text.split(/([。！？.!?\r\n]+[」』”’"'）】〉》]*)/);
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

// 輔助函式：判斷一個句子是否為常見語氣詞/嘆詞/擬聲詞超短句（如「嗯。」「啊！」「哦……」「哎呀！」「啧。」）
// 若在同一段落內出現此類短句，斷句時會自動與後續句子合併，避免孤立發音突兀與過度碎片化
function isInterjectionShortSentence(text) {
  if (!text) return false;
  // 去除所有標點符號、引號、括號、符號與空白字符
  const core = text.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!core || core.length === 0 || core.length > 3) return false;
  // 中文常見語氣詞/嘆詞/擬聲詞
  const zhInterjection = /^[嗯啊哦呃哎咦呀哼哈哇切喂呸嘘咳嗷喔嘻呵哟唷嘿呜唔呐啧嘁]+$/;
  if (zhInterjection.test(core)) return true;
  // 英文常見語氣嘆詞 (oh, ah, um, uh, hmm, etc.)
  const enInterjection = /^(oh|ah|um|uh|hmm|hm|alas|wow|oops|hey|eh)$/i;
  if (enInterjection.test(core)) return true;
  return false;
}

function appLog(tag, msg) {
  try {
    if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS && typeof window.Capacitor.Plugins.NativeTTS.writeLog === 'function') {
      window.Capacitor.Plugins.NativeTTS.writeLog({ tag, message: msg }).catch(() => {});
    }
  } catch (e) {}
}

export class TTSEngine {
  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    if (typeof window !== 'undefined') {
      window.tts = this;
    }
    
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
    this.prefetchQueue = []; // 預載排隊隊列
    this.activeFetchCount = 0; // 當前並發抓取數
    this.maxConcurrentFetches = 3; // 最大並發下載數，兼顧首句極速啟動與後續分組吞吐量
    
    // 建立持久的雙通道 Audio 播放器以進行無縫交替預熱播放，消除播放間隙。
    // 在 Native 原生端（iOS/Android），播放路徑由 _isNativeEngineAvailable() 攔截由原生底層處理，不使用此處的 DOM Audio。
    // 在 Chrome 插件版與網頁版，雙播放器配合 _prewarmNextPlayer 實現 0ms 物理無縫切換。
    this.players = typeof Audio !== 'undefined' ? [new Audio(), new Audio()] : [];
    this.activePlayerIdx = 0;
    this.currentAudio = null; // 當前正在播放的 Audio 對象
    this.pollingTimer = null; // 用於高頻同步高亮的時間監聽器
    this.isAutoScrolling = false; // 標記是否為 TTS 自動滾動
    
    this.players.forEach(audio => {
      audio.preload = 'auto';
      audio.disableRemotePlayback = true; // 停用遠端播放，提高穩定性
    });

    this.nativeQueue = new Set(); // 儲存預載排隊中的 native 句子索引
    this.silenceAudio = null; // 用於移動端後台持續播放的靜音播放器
    this._playbackWatchdog = null; // 播放看門狗計時器：偵測並恢復播放停滯
    this._lastPlaybackProgressTime = 0; // 上次播放進展的時間戳

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
    this.voiceSessionId = 0;
    this._lastSentCoverBookId = null;
    this._lastSkipTime = 0; // 防抖時間戳：防止原生端雙重派發導致 next/previous 被執行兩次
    this._lastPauseResumeTime = 0; // 防抖時間戳：防止原生端雙重派發導致 pause/resume 互相覆蓋

    // 全局書籍與封面資訊 (壓縮版 DataURL)，供鎖屏與通知欄即時調用
    this.currentBookTitle = 'TTS Reading';
    this.currentBookAuthor = 'E-Book Reader';
    this.currentBookCover = '';

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
          const action = (data.action || '').toLowerCase();
          switch (action) {
            case 'play':
            case 'action_play':
              this._resumeFromNative = true;
              this.resume();
              this._resumeFromNative = false;
              break;
            case 'pause':
            case 'action_pause':
              if (this.isPlaying && !this.isPaused) {
                this._pauseFromNative = true;
                this.pause();
                this._pauseFromNative = false;
              }
              break;
            case 'toggle':
            case 'action_toggle_play':
            case 'action_play_pause':
              if (this.isPaused || !this.isPlaying) {
                this._resumeFromNative = true;
                this.resume();
                this._resumeFromNative = false;
              } else {
                this._pauseFromNative = true;
                this.pause();
                this._pauseFromNative = false;
              }
              break;
            case 'next':
            case 'action_next':
              this.next();
              break;
            case 'previous':
            case 'prev':
            case 'action_prev':
            case 'action_previous':
              this.previous();
              break;
            case 'stop':
            case 'action_stop':
              this.stop();
              break;
          }
        });

        // Listen for Route B Native Audio Engine sentence events
        window.Capacitor.Plugins.NativeTTS.addListener('sentenceStarted', (data) => {
          appLog("TTS_JS", `Received sentenceStarted: index=${data.index}, duration=${data.duration}`);
          const index = data.index;
          this._lastPlaybackProgressTime = Date.now();
          this.playbackStarted = true;
          this.isPaused = false;
          this.currentIndex = index;
          this.currentlyPlayingIndex = index;
          const currentSentence = this.sentences[index];
          if (currentSentence) {
            const doHighlight = () => {
              const sent = this.sentences[index] || currentSentence;
              this._highlightSentence(sent);
              if (this.onSentenceStart) {
                this.onSentenceStart(index);
              }
              this._updateMediaSession(sent);
              this._fillPreFetchBuffer();
              this._prewarmNextPlayer();
            };

            if (currentSentence.chapterIndex !== this.currentChapterIndex) {
              this.currentChapterIndex = currentSentence.chapterIndex;
              this.prefetchedChapterIndex = null;
              if (this.onChapterTransition) {
                const p = this.onChapterTransition(currentSentence.chapterIndex);
                if (p && typeof p.then === 'function') {
                  p.then(doHighlight);
                } else {
                  doHighlight();
                }
              } else {
                doHighlight();
              }
              this._prefetchNextChapter();
            } else {
              doHighlight();
            }
          } else {
            this._fillPreFetchBuffer();
            this._prewarmNextPlayer();
          }
        });

        window.Capacitor.Plugins.NativeTTS.addListener('sentenceEnded', (data) => {
          appLog("TTS_JS", `Received sentenceEnded: index=${data.index}, gaplessHandled=${data && data.gaplessHandled}`);
          if (data && data.gaplessHandled) {
            // Gapless switch already started next sentence natively, do not trigger duplicate playback
            return;
          }
          const endedIndex = data.index;
          // If native engine did not have next sentence pre-warmed, trigger playback now
          if (this.isPlaying && !this.isPaused && this.currentIndex <= endedIndex) {
            this.currentIndex = endedIndex + 1;
            this._playActiveSentence();
          }
        });
      } catch (e) {
        console.warn("Failed to register NativeTTS listeners:", e);
      }
    }

    this._initVoices();
  }

  _isNativeEngineAvailable() {
    return typeof window !== 'undefined' &&
      window.Capacitor &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.NativeTTS &&
      typeof window.Capacitor.Plugins.NativeTTS.playNativeSentence === 'function';
  }

  _setMediaSessionPlaybackState(state) {
    if (this._isNativeEngineAvailable()) return;
    if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state;
    }
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
      this.voiceSessionId++;
      this._initVoices();
    }
  }

  _startPolling() {
    this._stopPolling();
    if (!this.isPlaying || this.isPaused || !this.currentAudio) return;
    
    const check = () => {
      if (!this.isPlaying || this.isPaused || !this.currentAudio) {
        this._stopPolling();
        return;
      }
      const audio = this.currentAudio;
      if (audio.ontimeupdate) {
        audio.ontimeupdate();
      }
    };
    
    // 使用 setInterval 替代 requestAnimationFrame 以支援 iOS 背景執行與定時校準
    this.pollingTimer = setInterval(check, 100);
  }

  _stopPolling() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
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
        // 退化降級：若無 extension context，嘗試透過本地 proxy API 或直接請求微軟官方 Bing 端點
        const isNativeApp = typeof window !== 'undefined' && (
          window.Capacitor ||
          window.location.protocol === 'capacitor:' ||
          window.location.protocol === 'app:' ||
          window.location.protocol === 'file:'
        );

        if (isNativeApp && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS && typeof window.Capacitor.Plugins.NativeTTS.syncClock === 'function') {
          try {
            const clockRes = await window.Capacitor.Plugins.NativeTTS.syncClock();
            if (clockRes && typeof clockRes.clockSkew === 'number') {
              this.clockSkew = clockRes.clockSkew;
              console.log(`TTS Clock synced via NativeTTS. Skew: ${this.clockSkew} ms`);
            }
          } catch (e) {}
        }

        const isWeb = !isNativeApp && (window.location.protocol === 'http:' || window.location.protocol === 'https:');
        
        // 1. 若在 Web 模式（例如 node server.js），先嘗試本地 proxy 避免任何 CORS 警告
        if (isWeb) {
          try {
            const response = await fetch("/api/voices").catch(() => null);
            if (response && response.ok) {
              list = await response.json();
              const serverDate = response.headers.get("x-server-date") || response.headers.get("Date");
              if (serverDate) {
                this.clockSkew = new Date(serverDate).getTime() - Date.now();
                console.log(`TTS Clock synced via local web proxy. Skew: ${this.clockSkew} ms`);
              }
            }
          } catch (e) {}
        }

        // 2. 若本地 API 不可用（例如在靜態離線託管、PWA 或 Native/file:// 下），直接 fetch 官方 Bing 端點
        if (!list) {
          try {
            const bingUrl = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
            const response = await fetch(bingUrl).catch(() => null);
            if (response && response.ok) {
              list = await response.json();
              const serverDate = response.headers.get("x-server-date") || response.headers.get("Date");
              if (serverDate) {
                this.clockSkew = new Date(serverDate).getTime() - Date.now();
                console.log(`TTS Clock synced via Bing direct endpoint. Skew: ${this.clockSkew} ms`);
              }
            }
          } catch (e) {}
        }
      }

      if (!list) {
        // 靜態備用列表：若完全離線斷網或受限，提供各主流語言最熱門的高品質 Microsoft Edge Online 語音
        list = [
          // 中文 (簡體 / 繁體 / 粵語)
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)", Locale: "zh-CN", ShortName: "zh-CN-XiaoxiaoNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-CN, YunxiNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, YunxiNeural)", Locale: "zh-CN", ShortName: "zh-CN-YunxiNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-CN, YunjianNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, YunjianNeural)", Locale: "zh-CN", ShortName: "zh-CN-YunjianNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoyiNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoyiNeural)", Locale: "zh-CN", ShortName: "zh-CN-XiaoyiNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoChenNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoChenNeural)", Locale: "zh-TW", ShortName: "zh-TW-HsiaoChenNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoYuNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-TW, HsiaoYuNeural)", Locale: "zh-TW", ShortName: "zh-TW-HsiaoYuNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-TW, YunJheNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-TW, YunJheNeural)", Locale: "zh-TW", ShortName: "zh-TW-YunJheNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-HK, HiuMaanNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-HK, HiuMaanNeural)", Locale: "zh-HK", ShortName: "zh-HK-HiuMaanNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (zh-HK, WanLungNeural)", Name: "Microsoft Server Speech Text to Speech Voice (zh-HK, WanLungNeural)", Locale: "zh-HK", ShortName: "zh-HK-WanLungNeural", Gender: "Male" },
          // 英文 (美式 / 英式 / 澳式)
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)", Locale: "en-US", ShortName: "en-US-JennyNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-US, GuyNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-US, GuyNeural)", Locale: "en-US", ShortName: "en-US-GuyNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)", Locale: "en-US", ShortName: "en-US-AriaNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-US, AnaNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-US, AnaNeural)", Locale: "en-US", ShortName: "en-US-AnaNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-US, ChristopherNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-US, ChristopherNeural)", Locale: "en-US", ShortName: "en-US-ChristopherNeural", Gender: "Male" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-AU, NatashaNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-AU, NatashaNeural)", Locale: "en-AU", ShortName: "en-AU-NatashaNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-GB, SoniaNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-GB, SoniaNeural)", Locale: "en-GB", ShortName: "en-GB-SoniaNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (en-GB, RyanNeural)", Name: "Microsoft Server Speech Text to Speech Voice (en-GB, RyanNeural)", Locale: "en-GB", ShortName: "en-GB-RyanNeural", Gender: "Male" },
          // 日文
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (ja-JP, NanamiNeural)", Name: "Microsoft Server Speech Text to Speech Voice (ja-JP, NanamiNeural)", Locale: "ja-JP", ShortName: "ja-JP-NanamiNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (ja-JP, KeitaNeural)", Name: "Microsoft Server Speech Text to Speech Voice (ja-JP, KeitaNeural)", Locale: "ja-JP", ShortName: "ja-JP-KeitaNeural", Gender: "Male" },
          // 韓文
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (ko-KR, SunHiNeural)", Name: "Microsoft Server Speech Text to Speech Voice (ko-KR, SunHiNeural)", Locale: "ko-KR", ShortName: "ko-KR-SunHiNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (ko-KR, InJoonNeural)", Name: "Microsoft Server Speech Text to Speech Voice (ko-KR, InJoonNeural)", Locale: "ko-KR", ShortName: "ko-KR-InJoonNeural", Gender: "Male" },
          // 法文 / 德文 / 西班牙文
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (fr-FR, DeniseNeural)", Name: "Microsoft Server Speech Text to Speech Voice (fr-FR, DeniseNeural)", Locale: "fr-FR", ShortName: "fr-FR-DeniseNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (de-DE, KatjaNeural)", Name: "Microsoft Server Speech Text to Speech Voice (de-DE, KatjaNeural)", Locale: "de-DE", ShortName: "de-DE-KatjaNeural", Gender: "Female" },
          { FriendlyName: "Microsoft Server Speech Text to Speech Voice (es-ES, ElviraNeural)", Name: "Microsoft Server Speech Text to Speech Voice (es-ES, ElviraNeural)", Locale: "es-ES", ShortName: "es-ES-ElviraNeural", Gender: "Female" }
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
    if (!langCode) langCode = 'en';
    const cleanLang = langCode.toLowerCase().replace('_', '-');
    
    // 語言代碼規範化函數，支援 WebSpeech API / BCP47 各種變體
    const normalizePrefix = (l) => {
      const s = (l || '').toLowerCase().replace('_', '-');
      if (s.startsWith('zh') || s.startsWith('cmn') || s.startsWith('yue') || s.startsWith('wuu')) return 'zh';
      if (s.startsWith('en') || s.startsWith('eng')) return 'en';
      if (s.startsWith('ja') || s.startsWith('jpn')) return 'ja';
      if (s.startsWith('ko') || s.startsWith('kor')) return 'ko';
      if (s.startsWith('fr') || s.startsWith('fra')) return 'fr';
      if (s.startsWith('de') || s.startsWith('deu') || s.startsWith('ger')) return 'de';
      if (s.startsWith('es') || s.startsWith('spa')) return 'es';
      if (s.startsWith('ru') || s.startsWith('rus')) return 'ru';
      if (s.startsWith('it') || s.startsWith('ita')) return 'it';
      return s.split('-')[0];
    };

    const targetPrefix = normalizePrefix(cleanLang);

    // 過濾出與目標語言前綴匹配的語音包，防止下拉選單顯示過多無關語言的語音
    let matched = this.voices.filter(v => {
      const vPrefix = normalizePrefix(v.lang);
      return vPrefix === targetPrefix || v.lang === 'multilingual';
    });
    
    // 若無任何語音匹配該前綴，退化為顯示所有語音
    if (matched.length === 0) {
      matched = [...this.voices];
    }
    
    const sorted = [...matched];
    
    sorted.sort((a, b) => {
      const aLang = (a.lang || '').toLowerCase().replace('_', '-');
      const bLang = (b.lang || '').toLowerCase().replace('_', '-');
      
      const aMatchExact = aLang.startsWith(cleanLang);
      const bMatchExact = bLang.startsWith(cleanLang);
      
      // 1. 完全匹配地區語言（如 en-US 匹配 en-US）排在最前
      if (aMatchExact && !bMatchExact) return -1;
      if (!aMatchExact && bMatchExact) return 1;
      
      // 2. 語言前綴相同但地區不同時，按語言代碼排序
      if (aLang !== bLang) {
        return aLang.localeCompare(bLang);
      }
      
      // 3. 在同一語言中，優先 Online/Natural/Neural 語音
      const aName = (a.name || '').toLowerCase();
      const bName = (b.name || '').toLowerCase();
      const aNatural = aName.includes('natural') || aName.includes('online') || aName.includes('neural') || a.isEdge;
      const bNatural = bName.includes('natural') || bName.includes('online') || bName.includes('neural') || b.isEdge;
      
      if (aNatural && !bNatural) return -1;
      if (!aNatural && bNatural) return 1;
      
      // 4. 按名稱排序
      return (a.name || '').localeCompare(b.name || '');
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
    
    // 清理舊的音訊快取 blob URLs，防止章節切換時內存累積
    if (this.audioCache.size > 0) {
      this.audioCache.forEach(cached => {
        if (cached.blobUrl && cached.blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(cached.blobUrl);
        }
        this._cleanupNativeTTSFile(cached);
      });
      this.audioCache.clear();
      this.fetchingIndices.clear();
      this.prefetchQueue = [];
      this.activeFetchCount = 0;
    }
    
    let sentenceId = 0;
    let relativeSentenceId = 0;

    // 找出所有與當前章節共享相同 cleanHref 的子章節及其 hash 對照，以便為每句話分配精確的 chapterIndex
    const subChapters = [];
    let maxSubChapterIdx = this.currentChapterIndex;
    if (epubBookData && epubBookData.chapters && this.currentChapterIndex !== undefined) {
      const currentChapter = epubBookData.chapters[this.currentChapterIndex];
      if (currentChapter && currentChapter.cleanHref) {
        epubBookData.chapters.forEach((ch, idx) => {
          if (ch.cleanHref === currentChapter.cleanHref) {
            subChapters.push({ hash: ch.hash || '', index: idx });
            if (idx > maxSubChapterIdx) maxSubChapterIdx = idx;
          }
        });
      }
    }
    // 當前容器已包含此 cleanHref 下所有子章節的內容，預加載進度應直接前進到最大子章節索引，防止後續重複預加載同一文件
    this.lastPrefetchedChapterIndex = maxSubChapterIdx;

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
              relativeIndex: relativeSentenceId,
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
            relativeSentenceId++;
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
        const matchedSub = subChapters.find(sub => {
          if (!sub.hash) return false;
          try {
            return sub.hash === nodeId || decodeURIComponent(sub.hash) === nodeId || sub.hash === nodeName || decodeURIComponent(sub.hash) === nodeName;
          } catch (e) {
            return sub.hash === nodeId || sub.hash === nodeName;
          }
        });
        if (matchedSub) {
          flushCurrentSentence();
          activeSubChapterIndex = matchedSub.index;
          currentActiveSubChapterIndex = matchedSub.index;
          relativeSentenceId = 0; // 重置子章節內的相對句子索引，保證 tts.play(0) 能精確定位到該子章節第 0 句
        }

        const tagName = node.tagName.toLowerCase();
        
        // 跳過上標 (sup)、下標 (sub)、腳本、樣式以及文件元數據標籤 (title, head, meta, link)
        const isSkipTag = tagName === 'sup' || tagName === 'sub' || tagName === 'script' || tagName === 'style' || tagName === 'title' || tagName === 'head' || tagName === 'meta' || tagName === 'link';

        if (isSkipTag || node.classList.contains('textLayer')) {
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
                if (currentText.trim().length >= TTS_MIN_SENTENCE_LEN && !isInterjectionShortSentence(currentText)) {
                  flushCurrentSentence();
                }
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

    // 使用離線 Clone Node 進行解析與修改，大幅減少 DOM 回流與重繪 (Reflow/Repaint)，提速高達數十倍！
    const clone = containerElement.cloneNode(true);
    traverse(clone);
    flushCurrentSentence();
    
    // 一次性將修改後的節點覆蓋回原容器
    containerElement.replaceChildren(...clone.childNodes);
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
    // 使用順序遊標匹配，避免重複文本（如"是的。"、"好的。"多次出現）被 find() 從頭搜索導致匹配到錯誤句子
    let matchCursor = startSentenceIndex;

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

            const currentSubChapterIndices = new Set(subChapters.map(s => s.index));
            if (currentSubChapterIndices.size === 0 && this.currentChapterIndex !== undefined) {
              currentSubChapterIndices.add(this.currentChapterIndex);
            }

            // 從 matchCursor 開始順序向前搜索，保證重複文本按出現順序逐一配對，且絕不越界匹配到後續章節的句子
            let existingSentence = null;
            const searchLimit = Math.min(this.sentences.length, targetSentIdx + 100);
            for (let si = matchCursor; si < searchLimit; si++) {
              const sent = this.sentences[si];
              if (currentSubChapterIndices.has(sent.chapterIndex) && sent.text === cleanSentence && hasNoElements(sent)) {
                existingSentence = sent;
                matchCursor = si + 1; // 遊標前進到下一個位置，避免同一句子被重複匹配
                break;
              }
            }

            if (existingSentence) {
              existingSentence.element = currentElements[0];
              existingSentence.elements = [...currentElements];
              if (existingSentence.chapterIndex === undefined || existingSentence.chapterIndex === null) {
                existingSentence.chapterIndex = currentActiveSubChapterIndex;
              }
              existingSentence.isHeading = isHeading;
              finalSentIdx = existingSentence.index;
            } else {
              // 退化降級：僅在 targetSentIdx 確實屬於當前文件的子章節時對照，嚴防越界篡改後續章節的句子引用與章節索引
              const sentByIndex = this.sentences[targetSentIdx];
              if (sentByIndex && currentSubChapterIndices.has(sentByIndex.chapterIndex)) {
                sentByIndex.element = currentElements[0];
                sentByIndex.elements = [...currentElements];
                if (sentByIndex.chapterIndex === undefined || sentByIndex.chapterIndex === null) {
                  sentByIndex.chapterIndex = currentActiveSubChapterIndex;
                }
                sentByIndex.isHeading = isHeading;
                finalSentIdx = sentByIndex.index;
              } else {
                console.warn(`[TTS syncDOM] No matching sentence for text: "${cleanSentence.substring(0, 40)}..." at expected index ${targetSentIdx}, total: ${this.sentences.length}`);
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
        const matchedSub = subChapters.find(sub => {
          if (!sub.hash) return false;
          try {
            return sub.hash === nodeId || decodeURIComponent(sub.hash) === nodeId || sub.hash === nodeName || decodeURIComponent(sub.hash) === nodeName;
          } catch (e) {
            return sub.hash === nodeId || sub.hash === nodeName;
          }
        });
        if (matchedSub) {
          flushCurrentSentence();
          activeSubChapterIndex = matchedSub.index;
          currentActiveSubChapterIndex = matchedSub.index;
        }

        const tagName = node.tagName.toLowerCase();
        
        // 跳過上標 (sup)、下標 (sub)、腳本、樣式以及文件元數據標籤 (title, head, meta, link)
        const isSkipTag = tagName === 'sup' || tagName === 'sub' || tagName === 'script' || tagName === 'style' || tagName === 'title' || tagName === 'head' || tagName === 'meta' || tagName === 'link';

        if (isSkipTag || node.classList.contains('textLayer')) {
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
                if (currentText.trim().length >= TTS_MIN_SENTENCE_LEN && !isInterjectionShortSentence(currentText)) {
                  flushCurrentSentence();
                }
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

    // 使用離線 Clone Node 進行解析，避免頻繁觸發瀏覽器重繪
    const clone = containerElement.cloneNode(true);
    traverse(clone);
    flushCurrentSentence();
    containerElement.replaceChildren(...clone.childNodes);

    // 清除屬於「上一章」且仍殘留在句子隊列中的舊 DOM 引用。
    // 這些引用指向的元素已隨 innerHTML 更新而被銷毀，若不清除將導致高亮時操作已脫離文件的「孤兒」元素。
    for (let i = 0; i < this.sentences.length; i++) {
      const sent = this.sentences[i];
      if (sent.element && !containerElement.contains(sent.element)) {
        sent.element = null;
        sent.elements = [];
      }
    }

    // DOM 映射完成後，等瀏覽器完成佈局渲染後高亮並平移至當前正在播放的句子
    if (this.isPlaying) {
      setTimeout(() => {
        if (!this.isPlaying) return;
        const currentSent = this.sentences[this.currentIndex];
        if (currentSent) {
          // 即使 element 為 null 也嘗試高亮，_highlightSentence 內部的兜底邏輯會通過 data-sentence-index 查找
          this._highlightSentence(currentSent);
        }
      }, 100);
    }
  }

  // 直接設置純文本句子
  setRawText(text) {
    this.sentences = [];
    this.currentIndex = 0;
    
    // 按行切分段落，保證跨行時不誤合併不同段落/角色的語氣短句
    const paragraphs = text.split(/\r?\n/);
    paragraphs.forEach(para => {
      const cleanPara = para.trim();
      if (!cleanPara) return;
      const matches = splitTextIntoSentences(cleanPara);
      if (matches) {
        let currentText = "";
        matches.forEach((s) => {
          const clean = s.trim();
          if (clean.length > 0) {
            if (!isSeparatorSentence(clean)) {
              currentText += (currentText ? " " : "") + clean;
              const endsSentence = /[。！？.!?\r\n]/.test(s);
              if (endsSentence) {
                if (currentText.trim().length >= TTS_MIN_SENTENCE_LEN && !isInterjectionShortSentence(currentText)) {
                  this.sentences.push({
                    index: this.sentences.length,
                    chapterIndex: this.currentChapterIndex,
                    text: currentText.trim(),
                    isHeading: false,
                    element: null
                  });
                  currentText = "";
                }
              }
            }
          }
        });
        if (currentText.trim().length > 0) {
          this.sentences.push({
            index: this.sentences.length,
            chapterIndex: this.currentChapterIndex,
            text: currentText.trim(),
            isHeading: false,
            element: null
          });
        }
      }
    });
  }

  // 直接設置預先映射好的句子隊列
  setSentences(sentences) {
    this.sentences = sentences;
    this.currentIndex = 0;
  }

  // 設置當前書籍信息與壓縮版封面
  setBookInfo(title, author, cover = '') {
    if (title) this.currentBookTitle = title;
    if (author) this.currentBookAuthor = author;
    if (cover) this.currentBookCover = cover;
  }

  // 設置全局壓縮版封面
  setCover(cover) {
    if (cover) {
      this.currentBookCover = cover;
      const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
      if (isCapacitorApp) {
        window.Capacitor.Plugins.NativeTTS.updateMetadata({
          title: this.currentBookTitle || 'TTS Reading',
          artist: this.currentBookAuthor || 'E-Book Reader',
          cover: cover,
          isPlaying: this.isPlaying && !this.isPaused
        }).catch(() => {});
      }
      if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
        try {
          let mimeType = 'image/jpeg';
          if (cover.startsWith('data:image/png')) mimeType = 'image/png';
          else if (cover.startsWith('data:image/webp')) mimeType = 'image/webp';
          navigator.mediaSession.metadata = new MediaMetadata({
            title: this.currentBookTitle || 'TTS Reading',
            artist: this.currentBookAuthor || 'E-Book Reader',
            album: this.currentBookTitle || '',
            artwork: [{ src: cover, sizes: '512x512', type: mimeType }]
          });
        } catch (e) {}
      }
    }
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
    return new Promise(async (rawResolve, rawReject) => {
      let isSettled = false;
      let activeWs = null;
      const timeoutTimer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try {
            if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS && typeof window.Capacitor.Plugins.NativeTTS.cancelTTS === 'function') {
              window.Capacitor.Plugins.NativeTTS.cancelTTS({ connectionId }).catch(() => {});
            }
            if (activeWs && activeWs.readyState !== WebSocket.CLOSED) {
              activeWs.close();
            }
          } catch (e) {}
          rawReject(new Error("TTS request timed out (12s)"));
        }
      }, 12000);

      const resolve = (val) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          rawResolve(val);
        }
      };

      const reject = (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          rawReject(err);
        }
      };

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

        let speakText = sentence.text || '';
        // 清除註釋角標編號（例如 [1]、①、¹、〔注1〕等）
        speakText = speakText.replace(/[\[\(\{〔【](?:[0-9]+|注[0-9]*|[a-zA-Z]+)[\]\)}〕】]/g, '');
        speakText = speakText.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g, '');
        speakText = speakText.replace(/[\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089]/g, '');

        // 若純為標點符號或空白，直接返回微型靜音音訊，避免向雲端請求無效音訊或導致超時報錯
        const hasPronounceable = /[\p{L}\p{N}]/u.test(speakText);
        if (!hasPronounceable) {
          resolve(this._createSilentAudioBlob());
          return;
        }

        if (!/[。！？.!?；;，,：:]\s*$/.test(speakText)) {
          if (sentence.isHeading) {
            speakText += "。";
          } else {
            speakText += "，";
          }
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
              text: speakText,
              voice: voiceShortName,
              connectionId: connectionId,
              secMsGec: secMsGec,
              dateStr: this._dateToString()
            });
            // Prefer in-memory Base64 Blob (100% native WebKit in-memory playback, avoids custom scheme range issues)
            if (result.audioBase64) {
              const base64ToBlob = (base64, mimeType) => {
                const byteCharacters = atob(base64);
                const len = byteCharacters.length;
                const byteArray = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                  byteArray[i] = byteCharacters.charCodeAt(i);
                }
                return new Blob([byteArray], { type: mimeType });
              };
              const blob = base64ToBlob(result.audioBase64, 'audio/mpeg');
              blob.filePath = result.filePath || null;
              blob.audioBase64 = result.audioBase64 || null;
              resolve(blob);
              return;
            }
            if (result.filePath) {
              // Fallback: Convert native file path to a Capacitor-compatible URL
              const fileUrl = window.Capacitor.convertFileSrc
                ? window.Capacitor.convertFileSrc(result.filePath)
                : 'file://' + result.filePath;
              resolve({ _isFileUrl: true, fileUrl: fileUrl, filePath: result.filePath });
              return;
            }
          } catch (nativeErr) {
            console.error("Native Edge TTS failed, falling back to WebSocket in webview:", nativeErr);
            if (!this.isPlaying || this.isPaused) {
              return;
            }
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
        activeWs = ws;
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
            
            const headerBytes = new Uint8Array(arrayBuffer, 2, headerLength);
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
            resolve(this._createSilentAudioBlob());
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

  _getGroupInfoForIndex(index) {
    // 每一句都進行物理校準：取消多句合併分組，所有句子均作為獨立單句獲取與播放。
    // 每句起播瞬間由 audio.play() 嚴格觸發高亮同步，徹底消除組內時間比例估算偏差，實現 100% 物理精準對齊。
    return null;

    /*
    // 歷史分組邏輯（每組最多 4 句，或累計約 120 字）：
    // 梯級優化：前 3 句單句獲取以保證極速啟動與順序緩存，從第 4 句（session + 3）起進入分組階段。
    const baseIndex = (typeof this.playbackStartSessionIndex === 'number') ? (this.playbackStartSessionIndex + 3) : 3;
    if (index < baseIndex) {
      return null;
    }

    let currentGroupStart = baseIndex;
    while (currentGroupStart <= index && currentGroupStart < this.sentences.length) {
      const startSentence = this.sentences[currentGroupStart];
      const chapterIdx = startSentence.chapterIndex;

      let groupLength = 1;
      let groupCharCount = startSentence.text ? startSentence.text.length : 0;
      while (groupLength < 4 && (currentGroupStart + groupLength) < this.sentences.length) {
        const nextSentence = this.sentences[currentGroupStart + groupLength];
        if (nextSentence.chapterIndex !== chapterIdx) {
          break; // 不跨章節
        }
        // 若累積字符數已超過 120 字（約 20~25 秒語音），適時分組，保證單組內高亮預估極高精度
        if (groupCharCount > 120) {
          break;
        }
        groupCharCount += (nextSentence.text ? nextSentence.text.length : 0);
        groupLength++;
      }

      if (index >= currentGroupStart && index < currentGroupStart + groupLength) {
        const groupSentences = [];
        for (let i = 0; i < groupLength; i++) {
          groupSentences.push(this.sentences[currentGroupStart + i]);
        }
        return {
          groupStartIndex: currentGroupStart,
          groupLength: groupLength,
          sentences: groupSentences
        };
      }

      currentGroupStart += groupLength;
    }

    return null;
    */
  }

  // 4. 預加載控制與播放隊列
  _fetchSentence(index, retryCount = 0) {
    const voice = this.selectedVoice;
    const useNativeSynth = (voice && voice.type === 'speechSynthesis');
    if (useNativeSynth) return;

    if (index >= this.sentences.length) return;
    if (this.audioCache.has(index)) return;
    if (retryCount === 0 && this.fetchingIndices.has(index)) return;

    // 判斷是否進入分組發送階段：直接依據 _getGroupInfoForIndex 判定該句子是否屬於合併分組
    const currentVoiceSessionId = this.voiceSessionId;
    const groupInfo = this._getGroupInfoForIndex(index);

    if (!groupInfo) {
      // 1. 單句獲取階段（前序單句或未分組的獨立句子）
      this.fetchingIndices.add(index);
      const sentence = this.sentences[index];
      return this._downloadSentenceAudio(sentence).then(blob => {
        if (this.voiceSessionId !== currentVoiceSessionId) {
          return;
        }
        this.consecutiveWsFailures = 0;
        this._saveToCache(index, blob);
      }).catch(err => {
        if (this.voiceSessionId !== currentVoiceSessionId) {
          return;
        }
        console.error(`Failed to prefetch sentence ${index} (attempt ${retryCount + 1}):`, err);
        this.fetchingIndices.delete(index);
        
        if (retryCount < 2) {
          setTimeout(() => {
            this._fetchSentence(index, retryCount + 1);
          }, 1500);
          return;
        }
        
        this.consecutiveWsFailures = (this.consecutiveWsFailures || 0) + 1;
        const hasSpeechSynth = typeof window !== 'undefined' && window.speechSynthesis && typeof window.speechSynthesis.speak === 'function' && window.speechSynthesis.getVoices().length > 0;
        if (this.consecutiveWsFailures >= 10 && hasSpeechSynth) {
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

        if (this.isPlaying && !this.isPaused && this.currentIndex === index) {
          this.currentIndex = index + 1;
          this._playActiveSentence();
        }
      });
    } else {
      // 2. 合併發送階段（動態分組，不跨越章節邊界）
      const groupStartIndex = groupInfo.groupStartIndex;
      const groupSentences = groupInfo.sentences;
      
      if (this.audioCache.has(groupStartIndex)) return;
      if (retryCount === 0 && this.fetchingIndices.has(groupStartIndex)) return;
      
      this.fetchingIndices.add(groupStartIndex);
      
      if (groupSentences.length === 0) {
        this.fetchingIndices.delete(groupStartIndex);
        return;
      }
      
      // 合併句子的文字，對無結尾標點的句子（特別是標題）自動追加適當標點以達到斷句停頓效果
      const texts = groupSentences.map(s => {
        let text = s.text;
        // 清除註釋角標編號（例如 [1]、①、¹、〔注1〕等）以精確判斷結尾標點
        let cleanText = text.replace(/[\[\(\{〔【](?:[0-9]+|注[0-9]*|[a-zA-Z]+)[\]\)}〕】]/g, '');
        cleanText = cleanText.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g, '');
        cleanText = cleanText.replace(/[\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089]/g, '');
        
        if (!/[。！？.!?；;，,：:]\s*$/.test(cleanText.trim())) {
          if (s.isHeading) {
            text += "。";
          } else {
            text += "，";
          }
        }
        return text;
      });
      
      const combinedText = texts.join(' ');
      const virtualSentence = {
        text: combinedText,
        chapterIndex: groupSentences[0].chapterIndex,
        isHeading: groupSentences[groupSentences.length - 1].isHeading
      };
      
      return this._downloadSentenceAudio(virtualSentence).then(blob => {
        if (this.voiceSessionId !== currentVoiceSessionId) {
          return;
        }
        this.consecutiveWsFailures = 0;
        this._saveGroupToCache(groupStartIndex, groupSentences, blob);
      }).catch(err => {
        if (this.voiceSessionId !== currentVoiceSessionId) {
          return;
        }
        console.error(`Failed to prefetch group starting at ${groupStartIndex}:`, err);
        this.fetchingIndices.delete(groupStartIndex);
        
        if (retryCount < 2) {
          setTimeout(() => {
            this._fetchSentence(groupStartIndex, retryCount + 1);
          }, 1500);
          return;
        }

        // 若分組多次獲取失敗且當前正卡在該分組，跳過該分組繼續播放
        if (this.isPlaying && !this.isPaused && this.currentIndex >= groupStartIndex && this.currentIndex < groupStartIndex + groupSentences.length) {
          this.currentIndex = groupStartIndex + groupSentences.length;
          this._playActiveSentence();
        }
      });
    }
  }

  _saveToCache(index, blobOrFileResult) {
    // If native TTS returned a file URL, use it directly (zero-copy, no Blob/DataURL conversion)
    if (blobOrFileResult && blobOrFileResult._isFileUrl) {
      this.audioCache.set(index, {
        blobUrl: blobOrFileResult.fileUrl,
        filePath: blobOrFileResult.filePath, // Store native path for cleanup
        isReady: true,
        isGroup: false
      });
      this.fetchingIndices.delete(index);
      this._onAudioCacheReady(index);
      return;
    }

    const blob = blobOrFileResult;
    const filePath = (blob && blob.filePath) ? blob.filePath : null;
    const audioBase64 = (blob && blob.audioBase64) ? blob.audioBase64 : null;
    if (window.location.protocol === 'file:') {
      const reader = new FileReader();
      reader.onloadend = () => {
        this.audioCache.set(index, {
          blobUrl: reader.result,
          filePath: filePath,
          audioBase64: audioBase64,
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
        filePath: filePath,
        audioBase64: audioBase64,
        isReady: true,
        isGroup: false
      });
      this.fetchingIndices.delete(index);
      this._onAudioCacheReady(index);
    }
  }

  _saveGroupToCache(groupStartIndex, groupSentences, blobOrFileResult) {
    const onUrlReady = (blobUrl, filePath) => {
      // 快取分組的音訊源，記錄所包含的句子清單
      this.audioCache.set(groupStartIndex, {
        blobUrl,
        filePath: filePath || null, // Store native path for cleanup
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

    // If native TTS returned a file URL, use it directly
    if (blobOrFileResult && blobOrFileResult._isFileUrl) {
      onUrlReady(blobOrFileResult.fileUrl, blobOrFileResult.filePath);
      return;
    }

    const blob = blobOrFileResult;
    if (window.location.protocol === 'file:') {
      const reader = new FileReader();
      reader.onloadend = () => onUrlReady(reader.result, null);
      reader.readAsDataURL(blob);
    } else {
      onUrlReady(URL.createObjectURL(blob), null);
    }
  }

  _onAudioCacheReady(index) {
    if (this.isPlaying && !this.isPaused && this.currentIndex === index && this.currentlyPlayingIndex !== index) {
      this._playActiveSentence();
    }
    // 只要有任何新快取就緒，主動嘗試為空閒播放器預熱下一個音訊源
    if (this.isPlaying && !this.isPaused) {
      this._prewarmNextPlayer();
    }
    // 即便尚未開始播放，只要首句快取就緒就立即啟動後續預取管線，不等 audio.play() 回調
    if (this.isPlaying && !this.isPaused && !this.playbackStarted && index === this.currentIndex) {
      this._earlyFillPreFetchBuffer();
    }
    // 每次快取就緒時，持續驅動預取隊列推進後續流水線
    if (this.isPlaying && !this.isPaused) {
      this._fillPreFetchBuffer();
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

  // 在首句快取就緒但尚未開始播放時提前啟動預取管線，縮短第二句及後續句子的等待時間
  _earlyFillPreFetchBuffer() {
    if (!this.isPlaying) return;
    const voice = this.selectedVoice;
    const useNativeSynth = (voice && voice.type === 'speechSynthesis');
    if (useNativeSynth) return;

    // 提前預取 10 句，與常規緩衝區保持一致
    let scanIndex = this.currentIndex + 1;
    const maxScanIndex = Math.min(this.sentences.length, this.currentIndex + 10);

    while (scanIndex < maxScanIndex) {
      const groupInfo = this._getGroupInfoForIndex(scanIndex);
      if (groupInfo) {
        const gStart = groupInfo.groupStartIndex;
        if (!this.audioCache.has(gStart) && !this.fetchingIndices.has(gStart) && !this.prefetchQueue.includes(gStart)) {
          this.prefetchQueue.push(gStart);
        }
        scanIndex = gStart + groupInfo.groupLength;
      } else {
        if (!this.audioCache.has(scanIndex) && !this.fetchingIndices.has(scanIndex) && !this.prefetchQueue.includes(scanIndex)) {
          this.prefetchQueue.push(scanIndex);
        }
        scanIndex++;
      }
    }
    this._processPrefetchQueue();
  }

  _fillPreFetchBuffer() {
    if (!this.isPlaying || !this.playbackStarted) return;
    const voice = this.selectedVoice;
    const useNativeSynth = (voice && voice.type === 'speechSynthesis');
    if (useNativeSynth) return;

    // 梯級動態預載隊列填充：
    // 單句階段逐句加入隊列；分組階段以 groupStartIndex 步進加入隊列，防止重複發送與隊列阻塞
    let scanIndex = this.currentIndex + 1;
    const maxScanIndex = Math.min(this.sentences.length, this.currentIndex + 10);

    while (scanIndex < maxScanIndex) {
      const groupInfo = this._getGroupInfoForIndex(scanIndex);
      if (groupInfo) {
        const gStart = groupInfo.groupStartIndex;
        if (!this.audioCache.has(gStart) && !this.fetchingIndices.has(gStart) && !this.prefetchQueue.includes(gStart)) {
          this.prefetchQueue.push(gStart);
        }
        // 步進跳過該組所包含的所有句子
        scanIndex = gStart + groupInfo.groupLength;
      } else {
        if (!this.audioCache.has(scanIndex) && !this.fetchingIndices.has(scanIndex) && !this.prefetchQueue.includes(scanIndex)) {
          this.prefetchQueue.push(scanIndex);
        }
        scanIndex++;
      }
    }
    this._processPrefetchQueue();
  }

  _getMaxConcurrentFetches() {
    const isNativeApp = typeof window !== 'undefined' && (
      window.Capacitor ||
      window.location.protocol === 'capacitor:' ||
      window.location.protocol === 'app:' ||
      window.location.protocol === 'file:'
    );

    // 1. 檢查目前進度往後的 3 句話是否已在快取中就緒
    let cachedCount = 0;
    for (let i = 1; i <= 3; i++) {
      const checkIdx = this.currentIndex + i;
      if (checkIdx >= this.sentences.length) {
        cachedCount++; // 若已達結尾，視為就緒，避免死鎖
        continue;
      }
      const group = this._getGroupInfoForIndex(checkIdx);
      const targetIdx = group ? group.groupStartIndex : checkIdx;
      if (this.audioCache.has(targetIdx) || this.audioCache.has(checkIdx)) {
        cachedCount++;
      } else {
        break; // 只要遇到斷層就停止計數
      }
    }

    // 2. 嚴格遵循順序：如果緩存不足 3 句，強制並發為 1，確保最前序的句子獨佔網絡帶寬，以最快速度返回
    if (cachedCount < 3) {
      return 1;
    }

    // 3. 已有 3 句以上緩存，有足夠時間，此時再放開並發加速填充 10 句緩衝區
    // 統一所有平台（插件版、Android版、網頁版、iOS版）最大並發為 2，避免過多並發影響整體穩定性
    return Math.min(2, this.maxConcurrentFetches);
  }

  _processPrefetchQueue() {
    if (!this.isPlaying || this.isPaused) return;
    const maxConcurrent = this._getMaxConcurrentFetches();
    while (this.activeFetchCount < maxConcurrent && this.prefetchQueue.length > 0) {
      const nextIdx = this.prefetchQueue.shift();
      if (this.audioCache.has(nextIdx) || this.fetchingIndices.has(nextIdx)) {
        continue;
      }
      this.activeFetchCount++;
      const finishFetch = () => {
        this.activeFetchCount = Math.max(0, this.activeFetchCount - 1);
        this._processPrefetchQueue();
      };
      try {
        const p = this._fetchSentence(nextIdx);
        if (p && typeof p.finally === 'function') {
          p.finally(finishFetch);
        } else {
          finishFetch();
        }
      } catch (e) {
        finishFetch();
      }
    }
  }

  _playActiveSentence() {
    if (!this.isPlaying || this.isPaused) return;
    
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

    // Route B: Native Audio Engine on iOS (Swift AVAudioPlayer with twin-player gapless pre-warming)
    if (this._isNativeEngineAvailable()) {
      const cached = this.audioCache.get(index);
      if (!cached || !cached.isReady) {
        this._fetchSentence(index);
        return;
      }

      this.currentlyPlayingIndex = index;
      this.playbackStarted = true;
      this._markPlaybackProgress();

      const totalSentences = (Array.isArray(this.sentences) && this.sentences.length > 0) ? this.sentences.length : 1;
      const currentSentIdx = Math.max(0, Math.min(this.currentIndex, totalSentences - 1));
      const remainingSentences = Math.max(1, totalSentences - currentSentIdx);
      const currentElapsed = currentSentIdx * 5.0;
      const chapterDuration = Math.max(60.0, currentElapsed + remainingSentences * 5.0);
      const bookTitle = this.currentBookTitle || (typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.title || currentBook.title || 'TTS Reading') : 'TTS Reading');
      const bookArtist = this.currentBookAuthor || (typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.author || currentBook.author || 'E-Book Reader') : 'E-Book Reader');
      const coverBase64 = this.currentBookCover || '';

      const payload = {
        filePath: cached.filePath || '',
        audioBase64: cached.audioBase64 || '',
        index: index,
        text: sentence ? sentence.text : '',
        title: bookTitle,
        artist: bookArtist,
        cover: coverBase64,
        duration: chapterDuration,
        currentTime: currentElapsed,
        rate: this.rate || 1.0,
        volume: (typeof this.volume === 'number' && this.volume >= 0) ? this.volume : 1.0
      };

      const doNativePlay = () => {
        window.Capacitor.Plugins.NativeTTS.playNativeSentence(payload).then(() => {
          if (!this.isPlaying || this.isPaused) return;
          const sent = this.sentences[index] || sentence;
          this._highlightSentence(sent);
          if (this.onSentenceStart) {
            this.onSentenceStart(index);
          }
          this._updateMediaSession(sent);
          this._fillPreFetchBuffer();
          this._prefetchNextChapter();
          this._prewarmNextPlayer();
        }).catch(err => {
          console.error("playNativeSentence error:", err);
          if (this.isPlaying && !this.isPaused) {
            setTimeout(() => {
              this.currentIndex = index + 1;
              this._playActiveSentence();
            }, 300);
          }
        });
      };

      if (sentence.chapterIndex !== this.currentChapterIndex) {
        this.currentChapterIndex = sentence.chapterIndex;
        this.prefetchedChapterIndex = null;
        if (this.onChapterTransition) {
          const p = this.onChapterTransition(sentence.chapterIndex);
          if (p && typeof p.then === 'function') {
            p.then(() => {
              if (!this.isPlaying || this.isPaused) return;
              doNativePlay();
            });
          } else {
            doNativePlay();
          }
        } else {
          doNativePlay();
        }
        this._prefetchNextChapter();
      } else {
        doNativePlay();
      }
      return;
    }
    
    const cached = this.audioCache.get(index);
    if (!cached || !cached.isReady) {
      this._fetchSentence(index);
      
      const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
      if (this.isPlaying && !this.isPaused) {
        this._setMediaSessionPlaybackState('playing');
        if (isCapacitorApp) {
          window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
            isPlaying: true
          }).catch(() => {});
        }
      }

      // 如果當前沒有任何音訊在播放（或者當前音訊已暫停/播放結束），為防止 iOS 挂起 JavaScript，應立刻啟動靜音播放器保活
      if ((!this.currentAudio || this.currentAudio.paused || this.currentAudio.ended) && this.silenceAudio) {
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
    
    // 獲取播放器（單一播放器架構始終使用 index 0，保證 iOS NowPlaying 會話穩定）
    const nextPlayerIdx = this.players.length > 1 ? (1 - this.activePlayerIdx) : 0;
    const prevAudio = this.currentAudio;
    const audio = this.players[this.activePlayerIdx];
    this.currentAudio = audio;
    
    const isSameSource = (audio.dataset.srcUrl === audioUrl);
    
    if (!isSameSource) {
      audio._boundaries = null; // 重置已快取的邊界數據
    }

    const cleanupAudioResources = () => {
      if (isGroupPlay) {
        if (audioUrl && audioUrl.startsWith('blob:')) {
          URL.revokeObjectURL(audioUrl);
        }
        const groupCached = this.audioCache.get(groupStartIndex);
        if (groupCached) this._cleanupNativeTTSFile(groupCached);
        if (groupSentences) {
          for (let i = 0; i < groupSentences.length; i++) {
            this.audioCache.delete(groupStartIndex + i);
          }
        }
      } else {
        if (cached && cached.blobUrl && cached.blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(cached.blobUrl);
        }
        this._cleanupNativeTTSFile(cached);
        this.audioCache.delete(index);
      }
    };
    audio._cleanupResources = cleanupAudioResources;

    const getBoundaries = () => {
      if (audio._boundaries) return audio._boundaries;
      if (isGroupPlay && groupSentences && audio.duration) {
        audio._boundaries = this._getGroupBoundaries(groupSentences, audio.duration);
        return audio._boundaries;
      }
      return null;
    };

    const setupGroupSeeking = () => {
      if (isGroupPlay && groupSentences && audio.duration) {
        const boundaries = getBoundaries();
        if (boundaries && boundaries[idxInGroup]) {
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
      // 確保 iOS Safari 在加載音訊元數據後不會重設播放速度，並同步最新真實時長
      audio.onloadedmetadata = () => {
        audio.playbackRate = this.rate;
        setupGroupSeeking();
        if (this.isPlaying && !this.isPaused) {
          const sent = this.sentences[index] || sentence;
          this._updateMediaSession(sent);
        }
      };
    } else {
      audio.playbackRate = this.rate;
      setupGroupSeeking();
    }
    audio.volume = (typeof this.volume === 'number' && this.volume > 0) ? this.volume : 1.0;
    audio.muted = false; // 關鍵修復：防止 WebKit 底層因自動播放或後台切源隱式設置 muted=true 導致有進度無聲音
    audio.playbackRate = this.rate;

    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;

    audio.onplay = () => {
      this._setMediaSessionPlaybackState('playing');
      if (this.isPlaying && !this.isPaused && isCapacitorApp) {
        window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
          isPlaying: true
        }).catch(() => {});
      }
    };
    audio.onpause = () => {
      if (this.isPaused) {
        this._setMediaSessionPlaybackState('paused');
      } else if (this.isPlaying) {
        // 換句過渡期間當前句子音訊暫停，明確告知 WebKit 媒體會話依然處於 playing 狀態！
        this._setMediaSessionPlaybackState('playing');
      }
      // 換句過渡期間當前句子音訊暫停，WebKit底層會誤將鎖屏翻轉為三角形(▶)。立即通知原生層維持播放中(⏸)！
      if (this.isPlaying && !this.isPaused) {
        if (isCapacitorApp) {
          window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
            isPlaying: true
          }).catch(() => {});
        }
      }
    };
    
    // 監聽時間更新事件：在當前句子即將結束前，提前預加載並播放下一句，實現完美無縫交替
    let hasTriggeredNext = false;
    
    if (isGroupPlay) {
      audio.ontimeupdate = () => {
        if (!this.isPlaying || this.isPaused) return;
        
        const boundaries = getBoundaries();
        if (!boundaries) return;
        const rawTime = audio.currentTime;
        if (typeof audio._lastWatchedTime !== 'number' || Math.abs(rawTime - audio._lastWatchedTime) > 0.1) {
          audio._lastWatchedTime = rawTime;
          this._markPlaybackProgress();
        }
        const currentTime = rawTime;
        
        // 尋找當前播放時間對應分組內的哪一句（若音訊播放至末尾或交替間隙，平滑保持在分組最後一句，防止倒跳回開頭 0）
        let currentIdxInGroup = boundaries.length - 1;
        for (let i = 0; i < boundaries.length; i++) {
          if (currentTime < boundaries[i].end) {
            currentIdxInGroup = i;
            break;
          }
        }
        
        const activeIdx = groupStartIndex + currentIdxInGroup;
        if (activeIdx !== this.currentIndex) {
          this.currentIndex = activeIdx;
          this.currentlyPlayingIndex = activeIdx; // 同步更新實際播放索引，確保暫停時能保存正確位置
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
              this._prewarmNextPlayer();
              this._fillPreFetchBuffer();
            };

            if (currentSentence.chapterIndex !== this.currentChapterIndex) {
              this.currentChapterIndex = currentSentence.chapterIndex;
              this.prefetchedChapterIndex = null;
              if (this.onChapterTransition) {
                const p = this.onChapterTransition(currentSentence.chapterIndex);
                if (p && typeof p.then === 'function') {
                  p.then(() => {
                    if (!this.isPlaying || this.isPaused) return;
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
        if (rawTime >= audio.duration - threshold) {
          if (!hasTriggeredNext) {
            hasTriggeredNext = true;
            this._stopPolling(); // 停止高頻輪詢
            audio.ontimeupdate = null; // 避免重疊期間重複觸發
            
            // 切換至下一個播放器，播放下一分組的起點
            this.activePlayerIdx = nextPlayerIdx;
            this.currentIndex = groupStartIndex + groupSentences.length;
            this._playActiveSentence();
          }
        }
      };
      
      audio.onended = () => {
        this._stopPolling(); // 停止高頻輪詢
        audio.ontimeupdate = null;
        audio.onended = null;
        audio.onloadedmetadata = null;
        
        if (typeof audio._cleanupResources === 'function') {
          audio._cleanupResources();
          audio._cleanupResources = null;
        }
        
        if (this.isPlaying && !this.isPaused) {
          this._setMediaSessionPlaybackState('playing');
          if (isCapacitorApp) {
            window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
              isPlaying: true
            }).catch(() => {});
          }
        }

        if (!this.isPlaying || this.isPaused) return;
        
        if (!hasTriggeredNext) {
          hasTriggeredNext = true;
          this.activePlayerIdx = nextPlayerIdx;
          this.currentIndex = groupStartIndex + groupSentences.length;
          this._playActiveSentence();
        }
      };
    } else {
      audio.ontimeupdate = () => {
        if (!this.isPlaying || this.isPaused) return;
        
        if (typeof audio._lastWatchedTime !== 'number' || Math.abs(audio.currentTime - audio._lastWatchedTime) > 0.1) {
          audio._lastWatchedTime = audio.currentTime;
          this._markPlaybackProgress();
        }
        
        // 計算合理的提前量。減小提前量至 80ms (或句子長度的 8%)，使其落在結尾標點符號的靜音期，避免語音重疊與音量波動
        const threshold = audio.duration ? Math.min(0.08, audio.duration * 0.08) : 0.08;
        if (audio.duration && audio.currentTime >= audio.duration - threshold) {
          if (!hasTriggeredNext) {
            hasTriggeredNext = true;
            this._stopPolling(); // 停止高頻輪詢
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
        this._stopPolling(); // 停止高頻輪詢
        audio.ontimeupdate = null;
        audio.onended = null;
        audio.onloadedmetadata = null;
        
        if (typeof audio._cleanupResources === 'function') {
          audio._cleanupResources();
          audio._cleanupResources = null;
        }
        
        if (this.isPlaying && !this.isPaused) {
          this._setMediaSessionPlaybackState('playing');
          if (isCapacitorApp) {
            window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
              isPlaying: true
            }).catch(() => {});
          }
        }

        if (!this.isPlaying || this.isPaused) return;
        
        // 若下一句還沒有被觸發播放，則在此手動觸發
        if (!hasTriggeredNext) {
          hasTriggeredNext = true;
          this.activePlayerIdx = nextPlayerIdx;
          this.currentIndex = index + 1;
          this._playActiveSentence();
        }
      };
    }

    const startPlay = () => {
      if (!this.isPlaying || this.isPaused) return;

      this._setMediaSessionPlaybackState('playing');
      if (isCapacitorApp) {
        window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
          isPlaying: true
        }).catch(() => {});
      }
      
      // 停止其它播放器的回調，避免事件競爭，但延後到新音訊成功播放後再執行 pause()
      // 消除新舊音訊切換時的「零音訊空窗期」，防止 iOS 鎖屏/通知欄判定為暫停而閃爍切換圖標
      if (Array.isArray(this.players)) {
        this.players.forEach(p => {
          if (p && p !== audio) {
            try {
              p.ontimeupdate = null;
              p.onended = null;
              p.onloadedmetadata = null;
            } catch (e) {}
          }
        });
      }

      audio.muted = false;
      audio.volume = (typeof this.volume === 'number' && this.volume > 0) ? this.volume : 1.0;
      audio.play().then(() => {
        if (!this.isPlaying || this.isPaused) {
          try { audio.pause(); } catch (e) {}
          return;
        }
        this._setMediaSessionPlaybackState('playing');
        if (isCapacitorApp) {
          window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
            isPlaying: true
          }).catch(() => {});
        }
        // 成功播放真實語音後暫停靜音保活播放器，避免雙重音訊競爭或音量衰減
        this._stopSilenceKeepAlive();

        // 成功播放後，立即暫停所有非當前播放器並重置進度與清理資源
        if (Array.isArray(this.players)) {
          this.players.forEach(p => {
            if (p && p !== audio) {
              try {
                if (typeof p._cleanupResources === 'function') {
                  p._cleanupResources();
                  p._cleanupResources = null;
                }
                p.pause();
                p.currentTime = 0;
                p.ontimeupdate = null;
                p.onended = null;
                p.onloadedmetadata = null;
              } catch (e) {}
            }
          });
        }
        
        // 再次強制設置播放速度，以防止部分 iOS 瀏覽器在啟動播放時強制將速度重設為 1.0
        audio.playbackRate = this.rate;
        
        this.playbackStarted = true;
        this._markPlaybackProgress(); // 通知看門狗：播放正常推進中
        this._fillPreFetchBuffer();
        this._prefetchNextChapter();
        this._prewarmNextPlayer();
        this._startPolling(); // 啟動高頻輪詢以即時更新高亮
        
        // 在音訊實際開始播放時，才執行高亮和回調，消除播放延遲導致的高亮超前
        doHighlightAndCallbacks();
      }).catch(err => {
        console.error("Audio play error:", err);
        this._stopPolling(); // 確保停止輪詢
        audio.ontimeupdate = null;
        audio.onended = null;
        audio.onloadedmetadata = null;
        
        // 若已停止或暫停，不修改索引避免狀態污染
        if (!this.isPlaying || this.isPaused) return;
        
        // 若播放失敗，等待 300ms 緩衝後再跳轉下一句，防止播放器異常拋錯時陷入無聲極速跳句
        if (!hasTriggeredNext) {
          hasTriggeredNext = true;
          setTimeout(() => {
            if (!this.isPlaying || this.isPaused) return;
            this.activePlayerIdx = nextPlayerIdx;
            this.currentIndex = isGroupPlay ? (groupStartIndex + groupSentences.length) : (index + 1);
            this._playActiveSentence();
          }, 300);
        }
      });
    };

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
            if (!this.isPlaying || this.isPaused) return;
            startPlay();
          });
        } else {
          startPlay();
        }
      } else {
        startPlay();
      }
      
      this._prefetchNextChapter();
    } else {
      startPlay();
    }
  }

  _speakNativeSentence(index) {
    if (!this.isPlaying || this.isPaused) return;
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
      this.currentlyPlayingIndex = index; // 同步更新實際播放索引
      
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
              if (!this.isPlaying || this.isPaused) return;
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
      if (!this.isPlaying || this.isPaused) return;
      
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
      if (!this.isPlaying || this.isPaused) return;
      
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

  unlock() {
    if (typeof Audio === 'undefined') return;
    if (this._isAudioUnlocked) return;
    this._isAudioUnlocked = true;

    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;

    // 1. 初始化並在用戶手勢中解鎖靜音保活播放器 (維持 iOS WebKit WebContent 音訊管道活躍)
    if (!this.silenceAudio) {
      this.silenceAudio = new Audio();
      this.silenceAudio.src = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV';
      this.silenceAudio.loop = true;
      this.silenceAudio.volume = 0.001;
      this.silenceAudio.preload = 'auto';
    }
    try {
      const pSilence = this.silenceAudio.play();
      if (pSilence && typeof pSilence.then === 'function') {
        pSilence.then(() => {
          // 若當前未在播放 TTS，解鎖成功後暫停靜音播放器，避免背景耗電
          if (!this.isPlaying || this.isPaused) {
            this.silenceAudio.pause();
          }
        }).catch(() => {});
      }
    } catch (e) {}

    // 2. 在用戶手勢中同步預熱音訊播放器，使其獲得 WebKit Autoplay 授權
    const SILENCE_DATA_URI = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    if (Array.isArray(this.players)) {
      this.players.forEach(p => {
        if (p && !p._unlocked) {
          p._unlocked = true;
          try {
            if (!p.src) {
              p.src = SILENCE_DATA_URI;
            }
            const pr = p.play();
            if (pr && typeof pr.then === 'function') {
              pr.then(() => {
                p.pause();
                p.currentTime = 0;
              }).catch(() => {});
            }
          } catch (e) {}
        }
      });
    }
  }

  _startSilenceKeepAlive() {
    if (this._isNativeEngineAvailable()) return;
    if (typeof Audio === 'undefined') return;
    if (!this.isPlaying || this.isPaused) return; // 暫停或未播放時嚴禁啟動靜音音訊
    
    if (!this.silenceAudio) {
      this.silenceAudio = new Audio();
      this.silenceAudio.src = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV';
      this.silenceAudio.loop = true;
      this.silenceAudio.volume = 0.001; // 微量音量維持 WebKit CoreAudio 活躍，完全無感靜音
      this.silenceAudio.preload = 'auto';
    }
    
    if (this.silenceAudio.paused) {
      this.silenceAudio.play().catch(err => {
        console.warn("Failed to play silence audio keep-alive:", err);
      });
    }
  }

  _createSilentAudioBlob() {
    const base64 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV';
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    blob.audioBase64 = base64;
    return blob;
  }

  _stopSilenceKeepAlive() {
    if (this.silenceAudio) {
      try {
        this.silenceAudio.pause();
        this.silenceAudio.currentTime = 0;
      } catch (e) {}
    }
  }

  // 播放看門狗：定期偵測播放是否異常中斷停滯，若停滯則自動恢復
  _startPlaybackWatchdog() {
    this._stopPlaybackWatchdog();
    if (!this.isPlaying || this.isPaused) return; // 處於暫停或停止狀態時絕不啟動看門狗

    // 原生雙播放器引擎 (Route B: iOS AVAudioPlayer / Android MediaPlayer) 自身擁有底層生命週期、
    // 事件回調、預加載與無縫切換。且在 TTS_MIN_SENTENCE_LEN=100 合併模式下，單句長度常達 25-35 秒，
    // 後台 WebKit 計時器節流下強行運行 JS 看門狗會誤判停滯並重播句子，故原生引擎完全交由 Native 管理。
    if (this._isNativeEngineAvailable()) return;

    appLog("TTS", "_startPlaybackWatchdog started");
    this._lastPlaybackProgressTime = Date.now();
    this._lastWatchedCurrentTime = null;
    this._playbackWatchdog = setInterval(() => {
      if (!this.isPlaying || this.isPaused) {
        this._stopPlaybackWatchdog();
        return;
      }
      
      const now = Date.now();

      // 1. 如果當前音訊或任何播放器正在正常發聲播放（非暫停、非結尾、且非靜音保活軌道），且時間指針正在前進，視為健康播放中
      const activeAudio = (this.currentAudio && !this.currentAudio.paused && !this.currentAudio.ended && this.currentAudio !== this.silenceAudio)
        ? this.currentAudio
        : (Array.isArray(this.players) ? this.players.find(p => p && !p.paused && !p.ended && p !== this.silenceAudio) : null);

      if (activeAudio) {
        const curTime = activeAudio.currentTime;
        if (typeof this._lastWatchedCurrentTime !== 'number' || Math.abs(curTime - this._lastWatchedCurrentTime) > 0.05) {
          this._lastWatchedCurrentTime = curTime;
          this._lastPlaybackProgressTime = now;
          return; // 音訊正在正常發聲，絕對不干涉，防止重複觸發
        }
      } else {
        this._lastWatchedCurrentTime = null;
      }

      const timeSinceProgress = now - this._lastPlaybackProgressTime;
      
      // 若超過 8 秒完全無發聲且無進展（排除了正常的網絡緩衝時間），判定為停滯
      if (timeSinceProgress > 8000) {
        if (!this.isPlaying || this.isPaused) {
          this._stopPlaybackWatchdog();
          return;
        }

        // 如果此時有任何播放器仍在發聲，絕不可干涉
        const anyPlayerPlaying = Array.isArray(this.players) && this.players.some(p => p && !p.paused && !p.ended && p !== this.silenceAudio);
        if (anyPlayerPlaying) {
          this._lastPlaybackProgressTime = now;
          return;
        }

        appLog("TTS Watchdog", `Playback stalled for ${Math.round(timeSinceProgress/1000)}s at index ${this.currentIndex}, isPaused=${this.isPaused}`);
        console.warn(`[TTS Watchdog] Playback stalled for ${Math.round(timeSinceProgress/1000)}s at index ${this.currentIndex}, attempting recovery...`);
        this._lastPlaybackProgressTime = now; // 重置以防止連續觸發
        
        // 核心保護：如果所有音訊實質已處於 paused 狀態，這說明音訊已被外部或系統（如鎖屏/藍牙）暫停，絕不能擅自喚醒重播！
        const allPaused = Array.isArray(this.players) && this.players.every(p => !p || p.paused || p.ended);
        if (allPaused) {
          appLog("TTS Watchdog", "All players paused during stall check, syncing pause state and stopping watchdog");
          console.log("[TTS Watchdog] All players paused during stall check, syncing pause state and stopping watchdog");
          this.pause();
          return;
        }

        const idx = this.currentIndex;
        if (idx >= this.sentences.length) {
          // 已播完所有句子
          this.stop();
          if (this.onPlaybackEnd) this.onPlaybackEnd();
          return;
        }
        
        const cached = this.audioCache.get(idx);
        if (cached && cached.isReady) {
          if (!this.currentAudio || this.currentAudio.ended) {
            console.warn('[TTS Watchdog] Audio stalled, attempting to resume playback...');
            this._playActiveSentence();
          }
        } else {
          // 快取未就緒 → 強制重新請求該句（可能之前的請求超時或失敗後未清理乾淨）
          console.warn('[TTS Watchdog] Cache not ready, force re-fetching...');
          this.fetchingIndices.delete(idx);
          // 清理可能的分組鎖定
          const groupInfo = this._getGroupInfoForIndex(idx);
          if (groupInfo) {
            this.fetchingIndices.delete(groupInfo.groupStartIndex);
          }
          this._fetchSentence(idx);
          // 只有在未暫停且播放中時才保活
          if (this.isPlaying && !this.isPaused && this.silenceAudio && this.silenceAudio.paused) {
            this.silenceAudio.play().catch(() => {});
          }
        }
        
        // 確保預取管線仍在推進
        this._fillPreFetchBuffer();
      }
    }, 2000); // 每 2 秒檢查一次
  }

  _stopPlaybackWatchdog() {
    if (this._playbackWatchdog) {
      appLog("TTS", "_stopPlaybackWatchdog called");
      clearInterval(this._playbackWatchdog);
      this._playbackWatchdog = null;
    }
  }

  // 記錄播放進展（在每次成功開始播放新句子時調用）
  _markPlaybackProgress() {
    this._lastPlaybackProgressTime = Date.now();
  }

  // 清理已播放完畢的原生臨時音訊文件
  _cleanupNativeTTSFile(cached) {
    if (!cached) return;
    if (cached.filePath && typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS) {
      window.Capacitor.Plugins.NativeTTS.deleteTTSFile({ filePath: cached.filePath }).catch(() => {});
    }
    if (cached.blobUrl && cached.blobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(cached.blobUrl);
    }
  }

  async _updateMediaSession(sentence) {
    this._setMediaSessionPlaybackState((this.isPlaying && !this.isPaused) ? 'playing' : 'paused');

    const text = sentence ? sentence.text : (this.currentBookTitle || 'TTS Reading');
    const title = this.currentBookTitle || (typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.title || currentBook.title || 'TTS Reading') : 'TTS Reading');
    const artist = this.currentBookAuthor || (typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.author || currentBook.author || 'E-Book Reader') : 'E-Book Reader');
    const coverBase64 = this.currentBookCover || await getBookCoverBase64();
    if (coverBase64 && !this.currentBookCover) {
      this.currentBookCover = coverBase64;
    }

    // 計算章節維度的整體進度與時長，防止單句時長（2~3秒）走完時被 iOS 系統誤判為音訊播放完畢而自動翻轉為播放（▶）圖標
    const totalSentences = (Array.isArray(this.sentences) && this.sentences.length > 0) ? this.sentences.length : 1;
    const currentSentIdx = Math.max(0, Math.min(this.currentIndex, totalSentences - 1));
    const remainingSentences = Math.max(1, totalSentences - currentSentIdx);
    const sentenceAudioTime = (this.currentAudio && !isNaN(this.currentAudio.currentTime)) ? this.currentAudio.currentTime : 0;
    const currentElapsed = currentSentIdx * 5.0 + sentenceAudioTime;
    const chapterDuration = Math.max(60.0, currentElapsed + remainingSentences * 5.0);

    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
    if (isCapacitorApp) {
      const nativePayload = {
        title: title,
        artist: artist,
        text: text,
        duration: chapterDuration,
        currentTime: currentElapsed,
        isPlaying: this.isPlaying && !this.isPaused
      };

      if (this.isPaused || !this.isPlaying) {
        nativePayload.isPlaying = false;
      }
      
      // 發送壓縮後的輕量封面 (約 20KB~40KB)，保證原生端能始終保持或更新封面
      if (coverBase64) {
        nativePayload.cover = coverBase64;
      }
      
      window.Capacitor.Plugins.NativeTTS.updateMetadata(nativePayload).catch(e => console.error("Error updating native metadata:", e));
    }

    if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
      try {
        const metadataOpts = {
          title: text,
          artist: artist,
          album: title
        };
        if (coverBase64) {
          let mimeType = 'image/jpeg';
          if (coverBase64.startsWith('data:image/png')) mimeType = 'image/png';
          else if (coverBase64.startsWith('data:image/webp')) mimeType = 'image/webp';
          else if (coverBase64.startsWith('data:image/gif')) mimeType = 'image/gif';
          
          metadataOpts.artwork = [
            { src: coverBase64, sizes: '512x512', type: mimeType }
          ];
        }
        navigator.mediaSession.metadata = new MediaMetadata(metadataOpts);

        this._setMediaSessionPlaybackState((this.isPlaying && !this.isPaused) ? 'playing' : 'paused');

        if ('setPositionState' in navigator.mediaSession && chapterDuration > 0) {
          try {
            navigator.mediaSession.setPositionState({
              duration: chapterDuration,
              playbackRate: this.rate || 1.0,
              position: Math.min(currentElapsed, chapterDuration)
            });
          } catch (posErr) {}
        }

        navigator.mediaSession.setActionHandler('play', () => {
          this.resume();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          this.pause();
        });
        navigator.mediaSession.setActionHandler('stop', () => {
          this.stop();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
          this.previous();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
          this.next();
        });
        try {
          navigator.mediaSession.setActionHandler('seekbackward', () => {
            this.previous();
          });
          navigator.mediaSession.setActionHandler('seekforward', () => {
            this.next();
          });
        } catch (seekErr) {}
      } catch (e) {
        console.warn("MediaSession update failed:", e);
      }
    }
  }

  play(index = 0, isAbsolute = false) {
    if (this.sentences.length === 0) {
      console.warn("tts.play: sentences array is empty, skipping playback start");
      return;
    }
    
    // 停止當前播放器並清理播放狀態，但保留音訊快取以加速點擊後的啟動播放
    this.isPlaying = false;
    this.isPaused = false;
    this._stopPolling();
    
    if (this.synth) {
      this.synth.cancel();
    }
    this.currentUtterance = null;
    this.nativeQueue.clear();
    
    this.players.forEach(p => {
      try {
        p.pause();
        p.currentTime = 0;
        if (p.dataset) p.dataset.srcUrl = '';
        p.ontimeupdate = null;
        p.onended = null;
        p.onloadedmetadata = null;
      } catch (e) {}
    });
    this.currentAudio = null;
    
    this.isPlaying = true;
    this._startSilenceKeepAlive(); // 在用戶手勢中同步啟動靜音保活，維持 iOS 音訊會話
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
        this._cleanupNativeTTSFile(cached);
        this.audioCache.delete(idx);
      }
    });
    
    this.isInitialPlay = true; // 標記為點擊開始的初始播放
    this.playbackStarted = false; // 標記尚未開始播放
    this.playbackStartSessionIndex = this.currentIndex;
    
    this.prefetchQueue = []; // 清空先前的後台預加載排隊
    this.fetchingIndices.delete(this.currentIndex); // 強制解除當前目標句的獲取鎖定，防止因先前失敗或超時而直接 return
    
    // 點击正文後，优先仅向 TTS 引擎发送当前首句，确保首句以最快速度返回
    this._fetchSentence(this.currentIndex);

    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
    if (isCapacitorApp) {
      // 1. 立即同步通知原生端開始播放，確保 isCurrentlyPlaying 立即置為 true，守護計時器啟動，鎖屏按鈕即時變更為暫停（⏸）
      window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
        isPlaying: true
      }).catch(() => {});

      // 2. 異步傳遞封面與書籍元數據給前台服務
      (async () => {
        const bookTitle = this.currentBookTitle || (typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.title || currentBook.title || 'TTS Reading') : 'TTS Reading');
        const bookArtist = this.currentBookAuthor || (typeof currentBook !== 'undefined' && currentBook ? (currentBook.metadata?.author || currentBook.author || 'E-Book Reader') : 'E-Book Reader');
        const sentence = this.sentences[this.currentIndex];
        const coverBase64 = this.currentBookCover || await getBookCoverBase64();
        if (coverBase64 && !this.currentBookCover) {
          this.currentBookCover = coverBase64;
        }
        const totalSentences = (Array.isArray(this.sentences) && this.sentences.length > 0) ? this.sentences.length : 1;
        const currentSentIdx = Math.max(0, Math.min(this.currentIndex, totalSentences - 1));
        const chapterDuration = Math.max(60, totalSentences * 5);
        const currentElapsed = Math.min(chapterDuration - 1, currentSentIdx * 5);
        window.Capacitor.Plugins.NativeTTS.startForegroundService({
          title: bookTitle,
          artist: bookArtist,
          text: sentence ? sentence.text : '',
          cover: coverBase64,
          duration: chapterDuration,
          currentTime: currentElapsed,
          isPlaying: this.isPlaying && !this.isPaused
        }).catch(e => console.error("Error starting native foreground service:", e));
      })();
    }

    this._setMediaSessionPlaybackState('playing');
    this._startSilenceKeepAlive();
    this._startPlaybackWatchdog();
    this._playActiveSentence();
    this._prefetchNextChapter();
    if (this.onStateChange) this.onStateChange();
  }

  // 預加載下一章，並將句子直接追加到當前的 sentences 列表中以實現在線預合成
  async _prefetchNextChapter() {
    if (!this.getNextChapterData || this.lastPrefetchedChapterIndex === undefined) return;
    
    const targetNextIndex = this.lastPrefetchedChapterIndex + 1;
    if (this.prefetchedChapterIndex === targetNextIndex) return;
    
    // 提前鎖定標記，防範多個異步調用同時並發預加載同一章節，導致句子隊列重複追加
    this.prefetchedChapterIndex = targetNextIndex;
    
    try {
      const nextChapter = await this.getNextChapterData(this.lastPrefetchedChapterIndex);
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
      
      // 如果當前文件包含多個子章節（共享相同 cleanHref），計算最大子章節索引
      // 防止後續重複預加載同一個 HTML 文件導致句子被成倍重複加入隊列
      let maxSubChapterIdx = targetNextIndex;
      if (this.epubBookData && this.epubBookData.chapters) {
        const currentChapter = this.epubBookData.chapters[targetNextIndex];
        if (currentChapter && currentChapter.cleanHref) {
          this.epubBookData.chapters.forEach((ch, idx) => {
            if (ch.cleanHref === currentChapter.cleanHref && idx > maxSubChapterIdx) {
              maxSubChapterIdx = idx;
            }
          });
        }
      }
      this.lastPrefetchedChapterIndex = maxSubChapterIdx;
      const nextSentences = this._extractSentencesFromHtml(nextChapter.html, nextChapter.index);
      
      if (nextSentences.length > 0) {
        const startIdx = this.sentences.length;
        nextSentences.forEach((s, i) => {
          s.index = startIdx + i;
          if (s.relativeIndex === undefined) s.relativeIndex = i;
          // 保留 _extractSentencesFromHtml 精確識別的子章節索引，不盲目覆蓋為 nextChapter.index
          if (s.chapterIndex === undefined || s.chapterIndex === null) s.chapterIndex = nextChapter.index;
          this.sentences.push(s);
        });
        
        this._fillPreFetchBuffer();
      } else {
        // 如果該章節為空（例如全是圖片無文字），直接解鎖並繼續預加載下一章
        this.prefetchedChapterIndex = null;
        this._prefetchNextChapter();
      }
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
    let relativeSentenceId = 0;

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
            relativeIndex: relativeSentenceId,
            text: cleanSentence,
            isHeading: isHeading,
            chapterIndex: currentActiveSubChapterIndex,
            element: null,
            elements: []
          });
          sentenceId++;
          relativeSentenceId++;
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
        const matchedSub = subChapters.find(sub => {
          if (!sub.hash) return false;
          try {
            return sub.hash === nodeId || decodeURIComponent(sub.hash) === nodeId || sub.hash === nodeName || decodeURIComponent(sub.hash) === nodeName;
          } catch (e) {
            return sub.hash === nodeId || sub.hash === nodeName;
          }
        });
        if (matchedSub) {
          flushCurrentSentence();
          activeSubChapterIndex = matchedSub.index;
          currentActiveSubChapterIndex = matchedSub.index;
          relativeSentenceId = 0; // 重置子章節內的相對句子索引
        }

        const tagName = node.tagName.toLowerCase();
        const isSkipTag = tagName === 'sup' || tagName === 'sub' || tagName === 'script' || tagName === 'style' || tagName === 'title' || tagName === 'head' || tagName === 'meta' || tagName === 'link';

        if (isSkipTag || node.classList.contains('textLayer')) {
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
                if (currentText.trim().length >= TTS_MIN_SENTENCE_LEN && !isInterjectionShortSentence(currentText)) {
                  flushCurrentSentence();
                }
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
    appLog("TTS", "pause() called: isPlaying=" + this.isPlaying + ", isPaused=" + this.isPaused + ", _pauseFromNative=" + this._pauseFromNative);
    this._stopPlaybackWatchdog();
    if (!this.isPlaying) return;

    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;

    // 1. 無條件立即標記為暫停，嚴格停止看門狗，停止靜音保活
    this.isPaused = true;
    this._stopPlaybackWatchdog();
    this._stopSilenceKeepAlive();
    if (this._silencePauseTimeout) {
      clearTimeout(this._silencePauseTimeout);
      this._silencePauseTimeout = null;
    }
    // 暫停超過 30 分鐘後自動停止保活以節省電量
    this._silencePauseTimeout = setTimeout(() => {
      if (this.isPaused) {
        this._stopSilenceKeepAlive();
      }
    }, 30 * 60 * 1000);

    // 2. 清空待處理的預加載隊列，並在 Capacitor 原生環境中立即取消在途的 Edge TTS WebSocket 任務與原生超時定時器
    // 注意：在 Route B 原生引擎模式下，暫停時保留預加載隊列與在途音訊，避免電話打斷或暫停恢復時管道被掏空
    if (!this._isNativeEngineAvailable()) {
      this.prefetchQueue = [];
      if (isCapacitorApp && typeof window.Capacitor.Plugins.NativeTTS.cancelAllTTS === 'function') {
        window.Capacitor.Plugins.NativeTTS.cancelAllTTS().catch(() => {});
      }
    }

    // Route B: Native Audio Engine pause
    if (this._isNativeEngineAvailable()) {
      if (!this._pauseFromNative) {
        window.Capacitor.Plugins.NativeTTS.pauseNative().catch(() => {});
      }
    }

    // 3. 立即實體暫停所有音訊播放器，消除聲音輸出
    const voice = this.selectedVoice;
    const useNativeSynth = (voice && voice.type === 'speechSynthesis');
    if (useNativeSynth && this.synth) {
      try { this.synth.pause(); } catch (e) {}
    } else {
      if (this.currentAudio) {
        try { this.currentAudio.pause(); } catch (e) {}
      }
      if (this.players && this.players.length > 0) {
        this.players.forEach(p => {
          try { p.pause(); } catch (e) {}
        });
      }
    }
    this._stopPolling();

    // 4. 防抖時間戳更新
    const now = Date.now();
    this._lastPauseResumeTime = now;

    if (isCapacitorApp && !this._pauseFromNative && !this._isNativeEngineAvailable()) {
      // 只有非原生端觸發的暫停才需要通知原生端（原生端 Remote Command 已自行處理完畢）
      window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
        isPlaying: false
      }).catch(e => console.error("Error updating native playback state:", e));
    }

    this._setMediaSessionPlaybackState('paused');

    if (this.onStateChange) this.onStateChange();
  }

  resume() {
    appLog("TTS", "resume() called: isPlaying=" + this.isPlaying + ", isPaused=" + this.isPaused + ", _resumeFromNative=" + this._resumeFromNative);
    console.log("[TTS Resume] resume() called");
    this._isInterrupted = false;
    if (!this.isPlaying) {
      this.play(this.currentIndex);
      return;
    }
    if (this.isPaused) {
      const now = Date.now();
      this._lastPauseResumeTime = now;
      this.isPaused = false;
      this._startPlaybackWatchdog();
      if (this._silencePauseTimeout) {
        clearTimeout(this._silencePauseTimeout);
        this._silencePauseTimeout = null;
      }

      // Route B: Native Audio Engine resume
      if (this._isNativeEngineAvailable()) {
        if (!this._resumeFromNative) {
          window.Capacitor.Plugins.NativeTTS.resumeNative().then(res => {
            if (res && res.resumed === false) {
              console.warn("[TTS Resume] Native resume reported resumed=false, falling back to _playActiveSentence()");
              this._playActiveSentence();
            }
          }).catch(err => {
            console.warn("[TTS Resume] resumeNative error, falling back to _playActiveSentence()", err);
            this._playActiveSentence();
          });
        }
        this._setMediaSessionPlaybackState('playing');
        this._fillPreFetchBuffer();
        if (this.onStateChange) this.onStateChange();
        return;
      }
      
      const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
      if (isCapacitorApp && !this._resumeFromNative) {
        // 只有非原生端觸發的恢復才需要通知原生端（原生端 Remote Command 已自行處理完畢）
        window.Capacitor.Plugins.NativeTTS.updatePlaybackState({
          isPlaying: true
        }).catch(e => console.error("Error updating native playback state:", e));
      }

      this._setMediaSessionPlaybackState('playing');

      const voice = this.selectedVoice;
      const useNativeSynth = (voice && voice.type === 'speechSynthesis');
      if (useNativeSynth && this.synth) {
        this._stopSilenceKeepAlive();
        this.synth.resume();
      } else {
        // 確保其它所有未處於播放狀態的播放器完全暫停並重置進度
        if (Array.isArray(this.players)) {
          this.players.forEach(p => {
            if (p && p !== this.currentAudio) {
              try {
                p.pause();
                p.currentTime = 0;
              } catch (e) {}
            }
          });
        }
        if (this.currentAudio && this.currentAudio.src && !this.currentAudio.ended && this.currentAudio.currentTime < (this.currentAudio.duration || 1) - 0.05) {
          const initialTime = this.currentAudio.currentTime;
          let hasSettled = false;
          // 驗證看門狗：若 play() 雖已 resolve 但音訊指針在 500ms 內未實質前進（或仍處於 paused），強制呼叫 _playActiveSentence()
          const resumeTimeout = setTimeout(() => {
            if (!hasSettled && !this.isPaused && this.isPlaying) {
              const cur = this.currentAudio ? this.currentAudio.currentTime : initialTime;
              const isStalled = !this.currentAudio || this.currentAudio.paused || Math.abs(cur - initialTime) < 0.01;
              if (isStalled) {
                hasSettled = true;
                console.warn("[TTS Resume] currentAudio stalled on resume (paused or time not advancing), falling back to _playActiveSentence()");
                this._playActiveSentence();
              }
            }
          }, 500);

          const playPromise = this.currentAudio.play();
          if (playPromise !== undefined) {
            playPromise.then(() => {
              if (!this.isPlaying || this.isPaused) {
                try { this.currentAudio.pause(); } catch (e) {}
                hasSettled = true;
                clearTimeout(resumeTimeout);
                return;
              }
              // 注意：此處絕不可直接 clearTimeout(resumeTimeout)，因為 WebKit 在後台環境下 Promise 可能立即 resolve，
              // 但硬體音訊管線仍可能卡頓未啟動！讓 resumeTimeout 在 500ms 時檢查 currentTime 是否真正前進
              this._stopSilenceKeepAlive();
              this._startPolling();
            }).catch(err => {
              if (hasSettled) return;
              hasSettled = true;
              clearTimeout(resumeTimeout);
              console.error("[TTS Resume] play() failed, replaying sentence:", err);
              this._playActiveSentence();
            });
          } else {
            clearTimeout(resumeTimeout);
            this._playActiveSentence();
          }
        } else {
          this._playActiveSentence();
        }
      }
      // 恢復播放後重啟預取管線，防止暫停期間預取停止導致後續快取枯竭
      this._fillPreFetchBuffer();
      if (this.onStateChange) this.onStateChange();
    }
  }

  stop() {
    // 先保留 currentlyPlayingIndex 的值，以便 onStateChange 回調可以正確保存最後播放位置
    const lastPlayingIndex = this.currentlyPlayingIndex;
    this.isPlaying = false;
    this.isPaused = false;
    this.playbackStarted = false;
    this.prefetchQueue = [];
    this.activeFetchCount = 0;
    this._lastSentCoverBookId = null;
    if (this._silencePauseTimeout) {
      clearTimeout(this._silencePauseTimeout);
      this._silencePauseTimeout = null;
    }
    this._stopSilenceKeepAlive();
    this._stopPolling();
    
    const isCapacitorApp = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS;
    if (isCapacitorApp) {
      if (typeof window.Capacitor.Plugins.NativeTTS.cancelAllTTS === 'function') {
        window.Capacitor.Plugins.NativeTTS.cancelAllTTS().catch(() => {});
      }
      if (typeof window.Capacitor.Plugins.NativeTTS.cleanupTTSFiles === 'function') {
        window.Capacitor.Plugins.NativeTTS.cleanupTTSFiles().catch(() => {});
      }
      if (typeof window.Capacitor.Plugins.NativeTTS.stopNative === 'function') {
        window.Capacitor.Plugins.NativeTTS.stopNative().catch(() => {});
      }
      window.Capacitor.Plugins.NativeTTS.stopForegroundService().catch(e => console.error("Error stopping native foreground service:", e));
    }

    this._isInterrupted = false;
    this._setMediaSessionPlaybackState('none');

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
      this._cleanupNativeTTSFile(cached);
    });
    this.audioCache.clear();
    this.fetchingIndices.clear();
    this._stopPlaybackWatchdog();
    
    // 批量清理所有殘留的原生臨時音訊文件
    if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeTTS && typeof window.Capacitor.Plugins.NativeTTS.cleanupTTSFiles === 'function') {
      window.Capacitor.Plugins.NativeTTS.cleanupTTSFiles().catch(() => {});
    }
    
    this.prefetchedChapterIndex = null;
    this._clearHighlight();
    // 在 onStateChange 回調前暫時恢復 currentlyPlayingIndex，讓保存邏輯能讀到正確位置
    this.currentlyPlayingIndex = lastPlayingIndex;
    if (this.onStateChange) this.onStateChange();
    // 回調完成後重置
    this.currentlyPlayingIndex = -1;
  }

  next() {
    if (this.isPlaying) {
      const now = Date.now();
      if (now - this._lastSkipTime < 200) return; // 防抖：200ms 內重複調用直接忽略
      this._lastSkipTime = now;
      const nextIndex = Math.min(this.currentIndex + 1, this.sentences.length - 1);
      this.play(nextIndex, true);
    }
  }

  previous() {
    if (this.isPlaying) {
      const now = Date.now();
      if (now - this._lastSkipTime < 200) return; // 防抖：200ms 內重複調用直接忽略
      this._lastSkipTime = now;
      const prevIndex = Math.max(this.currentIndex - 1, 0);
      this.play(prevIndex, true);
    }
  }

  setRate(rate) {
    this.rate = rate;
    if (this._isNativeEngineAvailable()) {
      window.Capacitor.Plugins.NativeTTS.setRateNative({ rate: this.rate }).catch(() => {});
    }
    this.players.forEach(p => {
      try {
        p.playbackRate = this.rate;
      } catch (e) {}
    });
  }



  _prewarmNextPlayer() {
    if (!this.isPlaying || this.isPaused) return;
    
    // 找出下一個「需要使用不同音訊源」的目標句子索引
    let nextAudioIndex = this.currentIndex + 1;
    const currentGroup = this._getGroupInfoForIndex(this.currentIndex);
    if (currentGroup) {
      // 若當前句子屬於分組合併塊，下一個音訊源必然是整個分組後的第一句
      nextAudioIndex = currentGroup.groupStartIndex + currentGroup.groupLength;
    }

    if (nextAudioIndex >= this.sentences.length) return;

    // Route B: If Native Audio Engine is active, pre-warm next sentence on preparedPlayer!
    if (this._isNativeEngineAvailable()) {
      const nextCached = this.audioCache.get(nextAudioIndex);
      if (nextCached && nextCached.isReady && (nextCached.filePath || nextCached.audioBase64)) {
        window.Capacitor.Plugins.NativeTTS.prepareNextSentence({
          filePath: nextCached.filePath || '',
          audioBase64: nextCached.audioBase64 || '',
          index: nextAudioIndex,
          rate: this.rate || 1.0,
          volume: (typeof this.volume === 'number' && this.volume >= 0) ? this.volume : 1.0
        }).catch(err => {
          console.warn("prepareNextSentence failed:", err);
        });
      }
      return;
    }

    if (!this.players || this.players.length <= 1) return;

    const cached = this.audioCache.get(nextAudioIndex);
    if (cached && cached.isReady) {
      const targetBlobUrl = cached.blobUrl;
      if (!targetBlobUrl) return;
      
      const nextPlayer = this.players[1 - this.activePlayerIdx];
      if (nextPlayer.dataset.srcUrl !== targetBlobUrl) {
        nextPlayer.src = targetBlobUrl;
        nextPlayer.dataset.srcUrl = targetBlobUrl;
        nextPlayer.load();
        nextPlayer.playbackRate = this.rate;
        nextPlayer.muted = false;
        nextPlayer.volume = (typeof this.volume === 'number' && this.volume >= 0) ? this.volume : 1.0;
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
        this._cleanupNativeTTSFile(cached);
      });
      this.audioCache.clear();
      this.fetchingIndices.clear();
      this.prefetchQueue = [];
      this.activeFetchCount = 0;
      this.voiceSessionId++;
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

    // 兜底查找：如果句子的元素引用為空（可能由於 syncDOM 匹配失敗或章節切換後引用丟失），
    // 通過 data-sentence-index 屬性在當前容器中搜索，確保跨章節後高亮不丟失
    if (!targetEl && this.container && sentence.index !== undefined) {
      const foundEls = this.container.querySelectorAll(`[data-sentence-index="${sentence.index}"]`);
      if (foundEls.length > 0) {
        foundEls.forEach(el => {
          el.classList.add('reading-sentence');
          el.classList.add(styleClass);
        });
        targetEl = foundEls[0];
        // 修復引用以便後續高亮不再需要兜底查找
        sentence.element = foundEls[0];
        sentence.elements = Array.from(foundEls);
      }
    }

    // 統一滾動邏輯：所有分支共用同一套精確居中滾動
    if (!targetEl) return;
    const isPaginated = document.body.classList.contains('layout-paginated');
    if (isPaginated) return;

    this.isAutoScrolling = true; // 標記為自動滾動，避免觸發手動進度保存
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
    } else {
      // 若不滾動，在微小延遲後安全重設 flag，以防 instant 滾動沒有觸發 scroll 事件
      setTimeout(() => {
        this.isAutoScrolling = false;
      }, 50);
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

// 壓縮書籍封面圖片為適合鎖屏與控制中心通知欄的小體積 JPEG (最大寬高 512px，約 20KB~40KB)
export async function compressCoverImage(coverBlobOrUrl, maxDimension = 512, quality = 0.8) {
  if (!coverBlobOrUrl) return '';
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  
  return new Promise((resolve) => {
    let url = '';
    let needsRevoke = false;
    
    if (typeof coverBlobOrUrl === 'string') {
      url = coverBlobOrUrl;
    } else if (coverBlobOrUrl && (coverBlobOrUrl instanceof Blob || (typeof coverBlobOrUrl === 'object' && typeof coverBlobOrUrl.slice === 'function'))) {
      try {
        url = URL.createObjectURL(coverBlobOrUrl);
        needsRevoke = true;
      } catch (e) {
        return resolve('');
      }
    } else {
      return resolve('');
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    const cleanup = () => {
      if (needsRevoke && url) {
        try { URL.revokeObjectURL(url); } catch (e) {}
      }
    };

    img.onload = () => {
      try {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        if (!width || !height) {
          cleanup();
          return resolve('');
        }

        // 等比縮放，確保寬高均不超過 maxDimension
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          return resolve('');
        }
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        cleanup();
        resolve(dataUrl);
      } catch (err) {
        cleanup();
        resolve('');
      }
    };

    img.onerror = () => {
      cleanup();
      resolve('');
    };

    img.src = url;
  });
}

let _cachedCoverBookId = null;
let _cachedCoverBase64 = '';

async function getBookCoverBase64() {
  const book = (typeof currentBook !== 'undefined' && currentBook) ? currentBook : (typeof window !== 'undefined' ? window.currentBook : null);
  if (!book || !book.cover) {
    return '';
  }
  if (book.compressedCover) {
    return book.compressedCover;
  }
  if (_cachedCoverBookId === book.id && _cachedCoverBase64) {
    return _cachedCoverBase64;
  }
  try {
    const compressed = await compressCoverImage(book.cover);
    if (compressed) {
      _cachedCoverBookId = book.id;
      _cachedCoverBase64 = compressed;
      book.compressedCover = compressed;
      return compressed;
    }
  } catch (e) {
    console.warn("Failed to compress book cover:", e);
  }
  return '';
}
