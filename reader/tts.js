// reader/tts.js
// 文字轉語音 (TTS) 控制引擎，負責語音列表加載、Edge 雲端語音 WebSocket 流式預載、無縫 HTML5 Audio 隊列播放與高亮同步

export class TTSEngine {
  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    
    // 播放狀態定義
    this.isPlaying = false;
    this.isPaused = false;
    
    this.sentences = [];      // 當前章節的所有句子 (會隨預加載動態追加)
    this.currentIndex = 0;    // 當前播放的句子索引
    this.container = null;    // 閱讀器內容容器 DOM
    
    this.voices = [];         // 合併後的語音列表
    this.selectedVoice = null;
    this.rate = 1.0;          // 朗讀速度
    this.volume = 1.0;        // 朗讀音量
    this.highlightStyle = null; // 高亮樣式類別
    
    // HTML5 Audio 播放隊列與快取
    this.audioCache = new Map(); // index -> { blobUrl, audio, isReady }
    this.fetchingIndices = new Set();
    this.currentAudio = null; // 當前正在播放的 Audio 對象

    // 跨章節無縫播放與數據預加載變量
    this.currentChapterIndex = 0;
    this.getNextChapterData = null; // 獲取下一章數據的回調 (由外部傳入，返回 Promise<{index, html}>)
    this.onChapterTransition = null; // 跨章節過渡時的回調 (由外部傳入)
    
    this.prefetchedChapterIndex = null; // 當前已預加載的章節索引，避免重複預加載

    // 事件回調
    this.onSentenceStart = null;
    this.onPlaybackEnd = null;
    this.onStateChange = null;

    this._initVoices();
  }

  // 1. 初始化並加載語音包 (使用 SpeechSynthesis 獲取系統與 Edge 雲端語音)
  async _initVoices() {
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

    const loadVoices = () => {
      const voices = getWebSpeechVoices();
      if (voices.length > 0) {
        this.voices = voices;
        if (this.onStateChange) this.onStateChange();
      }
    };

    loadVoices();
    if (this.synth && this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = loadVoices;
    }
  }

  // 獲取適用於指定語言的語音包，優先加載 Edge Natural / Neural 語音
  getVoicesForLanguage(langCode) {
    const cleanLang = langCode.toLowerCase().replace('_', '-');
    const sorted = [...this.voices];
    
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
  prepareContainer(containerElement) {
    this.container = containerElement;
    this.sentences = [];
    this.currentIndex = 0;
    
    let sentenceId = 0;

    // 遞歸遍歷文字節點
    const traverse = (node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (tagName === 'script' || tagName === 'style' || node.classList.contains('textLayer')) {
          return;
        }
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (text.trim().length === 0) return;

        // 利用正則切分句子：以句號、問號、感嘆號等中英文標點切分
        const sentenceRegex = /[^。！？.!?\r\n]+[。！？.!?\r\n]*/g;
        const matches = text.match(sentenceRegex);

        if (matches && matches.length > 0) {
          const fragment = document.createDocumentFragment();
          
          matches.forEach(s => {
            const cleanSentence = s.trim();
            if (cleanSentence.length > 0) {
              const span = document.createElement('span');
              span.className = 'tts-sentence';
              span.setAttribute('data-sentence-index', sentenceId);
              span.textContent = s; // 保留原始空白與標點
              fragment.appendChild(span);
              
              this.sentences.push({
                index: sentenceId,
                chapterIndex: this.currentChapterIndex,
                text: cleanSentence,
                isHeading: this._isHeadingNode(node),
                element: span
              });
              sentenceId++;
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
    };

    traverse(this.container);
  }

  // 無縫切換章節時，將新加載的 DOM element 對應到已預加載的句子對象上
  syncDOM(containerElement) {
    this.container = containerElement;
    let sentenceId = 0;

    const traverse = (node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (tagName === 'script' || tagName === 'style' || node.classList.contains('textLayer')) {
          return;
        }
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (text.trim().length === 0) return;

        const sentenceRegex = /[^。！？.!?\r\n]+[。！？.!?\r\n]*/g;
        const matches = text.match(sentenceRegex);

        if (matches && matches.length > 0) {
          const fragment = document.createDocumentFragment();
          
          matches.forEach(s => {
            const cleanSentence = s.trim();
            if (cleanSentence.length > 0) {
              const span = document.createElement('span');
              span.className = 'tts-sentence';
              span.setAttribute('data-sentence-index', sentenceId);
              span.textContent = s;
              fragment.appendChild(span);
              
              const existingSentence = this.sentences.find(sent => sent.chapterIndex === this.currentChapterIndex && sent.text === cleanSentence && !sent.element);
              if (existingSentence) {
                existingSentence.element = span;
                existingSentence.isHeading = this._isHeadingNode(node);
              } else {
                // 退化降級：直接按 index 對照
                const sentByIndex = this.sentences[sentenceId];
                if (sentByIndex) {
                  sentByIndex.element = span;
                  sentByIndex.isHeading = this._isHeadingNode(node);
                }
              }
              sentenceId++;
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
    };

    traverse(this.container);

    // DOM 映射完成後，立即高亮並平移至當前正在播放的句子
    const currentSent = this.sentences[this.currentIndex];
    if (currentSent && currentSent.element) {
      this._highlightSentence(currentSent);
    }
  }

  // 直接設置純文本句子
  setRawText(text) {
    this.sentences = [];
    this.currentIndex = 0;
    
    const sentenceRegex = /[^。！？.!?\r\n]+[。！？.!?\r\n]*/g;
    const matches = text.match(sentenceRegex);
    
    if (matches) {
      matches.forEach((s, index) => {
        const clean = s.trim();
        if (clean.length > 0) {
          this.sentences.push({
            index,
            chapterIndex: this.currentChapterIndex,
            text: clean,
            isHeading: false,
            element: null
          });
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

  async _generateSecMsGecToken() {
    const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
    const WIN_EPOCH = 11644473600;
    
    let unixSeconds = Math.floor(Date.now() / 1000);
    unixSeconds += WIN_EPOCH;
    unixSeconds -= (unixSeconds % 300);
    
    const ticks = BigInt(unixSeconds) * 10000000n;
    const strToHash = ticks.toString() + TRUSTED_CLIENT_TOKEN;
    
    const encoder = new TextEncoder();
    const data = encoder.encode(strToHash);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    
    return hashHex;
  }

  _getVoiceShortName(voice) {
    if (!voice) return 'zh-CN-XiaoxiaoNeural';
    
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
        const secMsGec = await this._generateSecMsGecToken();
        const connectionId = this._generateConnectionId();
        const voiceShortName = this._getVoiceShortName(this.selectedVoice);
        
        const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
                    `?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4` +
                    `&ConnectionId=${connectionId}` +
                    `&Sec-MS-GEC=${secMsGec}` +
                    `&Sec-MS-GEC-Version=1-143.0.3650.75`;
                    
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
          if (!/[。！？.!?；;，,：:]\s*$/.test(sentence.text)) {
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
            const blob = new Blob(audioChunks, { type: 'audio/mp3' });
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
  _fetchSentence(index) {
    if (index >= this.sentences.length) return;
    if (this.audioCache.has(index) || this.fetchingIndices.has(index)) return;
    
    this.fetchingIndices.add(index);
    const sentence = this.sentences[index];
    
    this._downloadSentenceAudio(sentence).then(blob => {
      const blobUrl = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.src = blobUrl;
      audio.preload = 'auto';
      audio.load();
      
      this.audioCache.set(index, {
        blobUrl,
        audio,
        isReady: true
      });
      this.fetchingIndices.delete(index);
      
      // 若當前正在播放且等待加載此句子，立即觸發播放
      if (this.isPlaying && this.currentIndex === index && !this.currentAudio) {
        this._playActiveSentence();
      }
    }).catch(err => {
      console.error(`Failed to prefetch sentence ${index}:`, err);
      this.fetchingIndices.delete(index);
      if (this.isPlaying && this.currentIndex === index) {
        // 容錯機制：跳過該句子
        this.currentIndex = index + 1;
        this._playActiveSentence();
      }
    });
  }

  _fillPreFetchBuffer() {
    if (!this.isPlaying) return;
    const bufferSize = 3;
    for (let i = 0; i < bufferSize; i++) {
      const targetIndex = this.currentIndex + i;
      this._fetchSentence(targetIndex);
    }
  }

  _playActiveSentence() {
    if (!this.isPlaying) return;
    
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.onended = null;
      this.currentAudio = null;
    }
    
    const index = this.currentIndex;
    if (index >= this.sentences.length) {
      this.stop();
      if (this.onPlaybackEnd) this.onPlaybackEnd();
      return;
    }
    
    const cached = this.audioCache.get(index);
    if (!cached || !cached.isReady) {
      this._fetchSentence(index);
      return;
    }
    
    const audio = cached.audio;
    this.currentAudio = audio;
    
    audio.volume = this.volume;
    audio.playbackRate = this.rate;
    
    const sentence = this.sentences[index];
    
    // 跨章節無縫過渡檢測
    if (sentence.chapterIndex !== this.currentChapterIndex) {
      this.currentChapterIndex = sentence.chapterIndex;
      this.prefetchedChapterIndex = null;
      
      if (this.onChapterTransition) {
        this.onChapterTransition(sentence.chapterIndex);
      }
      
      this._prefetchNextChapter();
    }
    
    this._highlightSentence(sentence);
    if (this.onSentenceStart) {
      this.onSentenceStart(index);
    }
    
    audio.play().then(() => {
      this._fillPreFetchBuffer();
      this._prefetchNextChapter();
    }).catch(err => {
      console.error("Audio play error:", err);
      // 跳過失敗的句子
      this.currentIndex = index + 1;
      this._playActiveSentence();
    });
    
    audio.onended = () => {
      if (!this.isPlaying) return;
      
      URL.revokeObjectURL(cached.blobUrl);
      this.audioCache.delete(index);
      
      this.currentIndex = index + 1;
      this._playActiveSentence();
    };
  }

  play(index = 0) {
    if (this.sentences.length === 0) return;
    
    this.stop();
    
    this.isPlaying = true;
    this.isPaused = false;
    this.currentIndex = Math.max(0, Math.min(index, this.sentences.length - 1));
    
    this._playActiveSentence();
    this._fillPreFetchBuffer();
    this._prefetchNextChapter();
    if (this.onStateChange) this.onStateChange();
  }

  // 預加載下一章，並將句子直接追加到當前的 sentences 列表中以實現在線預合成
  async _prefetchNextChapter() {
    if (!this.getNextChapterData || this.currentChapterIndex === undefined) return;
    
    const targetNextIndex = this.currentChapterIndex + 1;
    if (this.prefetchedChapterIndex === targetNextIndex) return;
    
    try {
      const nextChapter = await this.getNextChapterData(this.currentChapterIndex);
      if (!nextChapter || !this.isPlaying) return;
      
      this.prefetchedChapterIndex = nextChapter.index;
      
      const nextSentences = this._extractSentencesFromHtml(nextChapter.html);
      
      const startIdx = this.sentences.length;
      nextSentences.forEach((s, i) => {
        s.index = startIdx + i;
        s.chapterIndex = nextChapter.index;
        this.sentences.push(s);
      });
      
      this._fillPreFetchBuffer();
    } catch (e) {
      console.error("Failed to prefetch next chapter:", e);
    }
  }

  _extractSentencesFromHtml(htmlStr) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlStr, 'text/html');
    const sentences = [];
    let sentenceId = 0;

    const traverse = (node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (tagName === 'script' || tagName === 'style' || node.classList.contains('textLayer')) {
          return;
        }
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (text.trim().length === 0) return;

        const sentenceRegex = /[^。！？.!?\r\n]+[。！？.!?\r\n]*/g;
        const matches = text.match(sentenceRegex);
        
        if (matches) {
          matches.forEach(s => {
            const clean = s.trim();
            if (clean.length > 0) {
              sentences.push({
                index: sentenceId,
                text: clean,
                isHeading: this._isHeadingNode(node),
                element: null
              });
              sentenceId++;
            }
          });
        }
      } else {
        const children = Array.from(node.childNodes);
        children.forEach(child => traverse(child));
      }
    };

    traverse(doc.body);
    return sentences;
  }

  pause() {
    if (this.isPlaying && !this.isPaused) {
      if (this.currentAudio) {
        this.currentAudio.pause();
      }
      this.isPaused = true;
      if (this.onStateChange) this.onStateChange();
    }
  }

  resume() {
    if (this.isPlaying && this.isPaused) {
      if (this.currentAudio) {
        this.currentAudio.play().catch(err => console.error("Resume error:", err));
      }
      this.isPaused = false;
      if (this.onStateChange) this.onStateChange();
    }
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.onended = null;
      this.currentAudio = null;
    }
    
    this.audioCache.forEach(cached => {
      URL.revokeObjectURL(cached.blobUrl);
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
      this.play(nextIndex);
    }
  }

  previous() {
    if (this.isPlaying) {
      const prevIndex = Math.max(this.currentIndex - 1, 0);
      this.play(prevIndex);
    }
  }

  setRate(rate) {
    this.rate = rate;
    if (this.currentAudio) {
      this.currentAudio.playbackRate = this.rate;
    }
  }

  setVoice(voiceName) {
    this.selectedVoice = this.voices.find(v => v.name === voiceName) || null;
    if (this.isPlaying) {
      this.play(this.currentIndex);
    }
  }

  _highlightSentence(sentence) {
    this._clearHighlight();
    const styleClass = this.highlightStyle || 'highlight-style-yellow';

    if (sentence.elements && sentence.elements.length > 0) {
      sentence.elements.forEach(el => {
        el.classList.add('reading-sentence');
        el.classList.add(styleClass);
      });
      const isPaginated = document.body.classList.contains('layout-paginated');
      if (!isPaginated && sentence.elements[0]) {
        const firstEl = sentence.elements[0];
        const rect = firstEl.getBoundingClientRect();
        const headerHeight = 80; 
        const footerHeight = 80;
        const isVisible = rect.top >= headerHeight && rect.bottom <= (window.innerHeight - footerHeight);
        
        if (!isVisible) {
          firstEl.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
          });
        }
      }
    } else if (sentence.element) {
      sentence.element.classList.add('reading-sentence');
      sentence.element.classList.add(styleClass);
      
      const isPaginated = document.body.classList.contains('layout-paginated');
      if (!isPaginated) {
        const rect = sentence.element.getBoundingClientRect();
        const headerHeight = 80;
        const footerHeight = 80;
        const isVisible = rect.top >= headerHeight && rect.bottom <= (window.innerHeight - footerHeight);
        
        if (!isVisible) {
          sentence.element.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
          });
        }
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
