"// reader/tts.js
// 文字轉語音 (TTS) 控制引擎，負責語音列表加載、內置 chrome.tts / speechSynthesis 語音合成、無縫隊列播放與高亮同步

export class TTSEngine {
  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    
    // 播放狀態定義
    this.isPlaying = false;
    this.isPaused = false;
    
    this.sentences = [];      // 當前章節的所有純文本句子
    this.currentIndex = 0;    // 當前播放的句子索引
    this.container = null;    // 閱讀器內容容器 DOM
    
    this.voices = [];         // 合併後的語音列表
    this.selectedVoice = null;
    this.rate = 1.0;          // 朗讀速度
    this.volume = 1.0;        // 朗讀音量
    this.highlightStyle = null; // 高亮樣式類別
    
    this.activeChunks = [];    // 當前正在播放的所有 chunks
    this.currentChunkIndex = -1; // 當前正被朗讀的 chunk 索引
    this.useChromeTts = false;  // 是否使用 chrome.tts (否則 fallback 爲 speechSynthesis)
    this.currentPlaybackId = null; // 適用於 speechSynthesis 的唯一播放 ID

    // 事件回調
    this.onSentenceStart = null;
    this.onPlaybackEnd = null;
    this.onStateChange = null;

    this._initVoices();
  }

  // 1. 初始化並加載語音包 (優先抓取 chrome.tts 語音，並合併 speechSynthesis 語音)
  async _initVoices() {
    const getChromeVoices = () => {
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.tts) {
          chrome.tts.getVoices((voices) => {
            resolve(voices.map(v => ({
              name: v.voiceName,
              lang: v.lang || '',
              friendlyName: v.voiceName,
              gender: v.gender || 'unknown',
              isEdge: v.voiceName.includes('Online (Natural)') || v.voiceName.includes('Natural') || v.voiceName.includes('Neural'),
              isNative: true,
              type: 'chrome.tts'
            })));\
<truncated 15804 bytes>