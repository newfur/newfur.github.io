// reader/ai.js
// AI 閱讀伴侶模組，對接瀏覽器內置的 Prompt API (Gemini Nano)

export class AIEngine {
  constructor() {
    this.session = null;
    this.isSupported = false;
  }

  // 檢測瀏覽器內置 AI 是否可用
  async checkAvailability() {
    try {
      if (typeof window === 'undefined') return false;

      // 1. 最新規範 window.ai.languageModel
      if (window.ai && window.ai.languageModel) {
        const capabilities = await window.ai.languageModel.capabilities();
        this.isSupported = capabilities.available !== 'no';
        return this.isSupported;
      }
      
      // 2. 舊版規範 window.ai.assistant
      if (window.ai && window.ai.assistant) {
        const capabilities = await window.ai.assistant.capabilities();
        this.isSupported = capabilities.available !== 'no';
        return this.isSupported;
      }

      // 3. 更舊版 window.ai
      if (window.ai && typeof window.ai.create === 'function') {
        this.isSupported = true;
        return true;
      }
    } catch (e) {
      console.warn('Check built-in AI availability error:', e);
    }
    
    this.isSupported = false;
    return false;
  }

  // 建立 AI 會話
  async _createSession(systemPrompt = '') {
    if (!this.isSupported) throw new Error('Built-in AI is not supported in this browser.');
    
    // 如果已有會話，先關閉釋放內存
    if (this.session) {
      try { this.session.destroy(); } catch(e) {}
      this.session = null;
    }

    try {
      const options = systemPrompt ? { systemPrompt } : {};
      
      if (window.ai.languageModel) {
        this.session = await window.ai.languageModel.create(options);
      } else if (window.ai.assistant) {
        this.session = await window.ai.assistant.create(options);
      } else {
        this.session = await window.ai.create(options);
      }
      return this.session;
    } catch (e) {
      console.error('Failed to create AI session:', e);
      throw e;
    }
  }

  // 1. 章節/選段摘要 (流式輸出)
  async summarize(text, onChunk) {
    const systemPrompt = 'You are a helpful reading assistant. Summarize the following text concisely. Respond in the language of the text input (if the text is in Chinese, summarize in Chinese).';
    await this._createSession(systemPrompt);

    const prompt = `Please summarize this text: \n\n${text.substring(0, 4000)}`;
    return this._streamPrompt(prompt, onChunk);
  }

  // 2. 生詞釋義 (流式輸出)
  async explainWord(word, context, onChunk) {
    const systemPrompt = 'You are a helpful dictionary assistant. Explain the meaning of the selected word based on its context. Keep it concise. Respond in the language of the context (Chinese if Chinese, English if English).';
    await this._createSession(systemPrompt);

    const prompt = `Selected Word: "${word}"\nContext: "...${context.substring(0, 500)}..."\n\nPlease explain the word's meaning in this context.`;
    return this._streamPrompt(prompt, onChunk);
  }

  // 3. 離線翻譯 (流式輸出)
  async translate(text, targetLangName, onChunk) {
    const systemPrompt = `You are a professional translator. Translate the text into ${targetLangName}. Output only the translation, no explanation.`;
    await this._createSession(systemPrompt);

    const prompt = `Translate this text:\n\n${text.substring(0, 1500)}`;
    return this._streamPrompt(prompt, onChunk);
  }

  // 流式 Prompt 處理封裝
  async _streamPrompt(prompt, onChunk) {
    if (!this.session) throw new Error('AI session is not initialized');

    try {
      // 檢測是否支持流式輸出
      if (typeof this.session.promptStreaming === 'function') {
        const stream = this.session.promptStreaming(prompt);
        let fullResponse = '';
        
        for await (const chunk of stream) {
          fullResponse = chunk;
          if (onChunk) onChunk(chunk);
        }
        return fullResponse;
      } else {
        // 退而求其次非流式輸出
        const response = await this.session.prompt(prompt);
        if (onChunk) onChunk(response);
        return response;
      }
    } catch (e) {
      console.error('AI prompt error:', e);
      throw e;
    } finally {
      // 完畢後關閉會話以釋放 AI 模型內存
      if (this.session) {
        try { this.session.destroy(); } catch(e) {}
        this.session = null;
      }
    }
  }
}
