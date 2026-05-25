"// reader/tts.js
// 文字轉語音 (TTS) 控制引擎，負責句子分割、DOM 節點包裝、Edge 自然語音加載與同步高亮自動滾動

export class TTSEngine {
  constructor() {
    this.synth = window.speechSynthesis;
    this.utterance = null;
    this.isPlaying = false;
    this.isPaused = false;
    
    this.sentences = [];      // 當前章節的所有純文本句子
    this.currentIndex = 0;    // 當前播放的句子索引
    this.container = null;    // 閱讀器內容容器 DOM
    
    this.voices = [];
    this.selectedVoice = null;
    this.rate = 1.0;          // 朗讀速度
    this.volume = 1.0;
    
    // 事件回調
    this.onSentenceStart = null;
    this.onPlaybackEnd = null;
    this.onStateChange = null;

    this._initVoices();
  }

  // 1. 初始化並加載語音包
  _initVoices() {
    const load = () => {
      this.voices = this.synth.getVoices();
      if (this.onStateChange) this.onStateChange();
    };
    
    load();
    if (this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = load;
    }
  }

  // 獲取適用於指定語言的語音包，優先加載 Edge Natural 語音
  getVoicesForLanguage(langCode) {
    const cleanLang = langCode.toLowerCase().replace('_', '-');
    
    // 過濾出語言匹配的語音
    let langVoices = this.voices.filter(v => v.lang.toLowerCase().startsWith(cleanLang) || 
      (cleanLang.startsWith('zh') && v.lang.toLowerCase().startsWith('zh'))
    );

    if (langVoices.length === 0) {
      langVoices = this.voices; // 退而求其次使用全部語音
    }

    // 排序：將 Microsoft Online (Natural) 放在最前面，其次是其他 Edge/Online 語音，最後是本地語音
    langVoices.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aNatural = aName.includes('natural') || aName.includes('online');
      const bNatural = bName.includes('natural') || bName.includes('onli
<truncated 6588 bytes>