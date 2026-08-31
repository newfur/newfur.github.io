// reader/ai.js
// AI 閱讀伴侶模組，支持瀏覽器內置的 Prompt API (Gemini Nano) 以及自定義 AI 服務商 (OpenAI / Ollama)

import { getMsg } from './i18n.js';

export class AIEngine {
  constructor() {
    this.session = null;
    this.isSupported = false; // 僅針對瀏覽器內置 AI 狀態
    
    // 自定義服務商配置
    this.provider = 'builtin'; // 'builtin' | 'openai' | 'ollama'
    this.apiKey = '';
    this.endpoint = '';
    this.model = '';
  }

  _assertCurrent(context) {
    if (context?.controller?.signal.aborted || (context?.isCurrent && !context.isCurrent())) {
      throw context?.controller?.signal.reason || new DOMException('stale AI operation', 'AbortError');
    }
  }

  _ownedChunk(context, onChunk) {
    return chunk => {
      this._assertCurrent(context);
      onChunk?.(chunk);
    };
  }

  // 設置配置項
  configure({ provider, apiKey, endpoint, model }) {
    if (provider) this.provider = provider;
    if (apiKey !== undefined) this.apiKey = apiKey;
    if (endpoint !== undefined) this.endpoint = endpoint;
    if (model !== undefined) this.model = model;
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

  // 建立內置 AI 會話
  async _createSession(systemPrompt = '', context = null) {
    if (!this.isSupported) {
      const errMsg = getMsg('ai_builtin_not_supported') || 'Built-in AI (Gemini Nano) is not supported in this browser. Please configure a custom AI provider (e.g. DeepSeek, OpenAI, Ollama) in the Global Settings dialog.';
      throw new Error(errMsg);
    }
    
    // 如果已有會話，先關閉釋放內存
    if (this.session) {
      try { this.session.destroy(); } catch(e) {}
      this.session = null;
    }

    try {
      const options = systemPrompt ? { systemPrompt } : {};
      let session;
      if (window.ai.languageModel) {
        session = await window.ai.languageModel.create(options);
      } else if (window.ai.assistant) {
        session = await window.ai.assistant.create(options);
      } else {
        session = await window.ai.create(options);
      }
      try {
        this._assertCurrent(context);
      } catch (error) {
        try { session.destroy(); } catch (e) {}
        throw error;
      }
      this.session = session;
      return session;
    } catch (e) {
      console.error('Failed to create AI session:', e);
      throw e;
    }
  }

  // 核心對話入口 (流式輸出)
  async _chat(systemPrompt, prompt, onChunk, history = [], context = null) {
    this._assertCurrent(context);
    if (this.provider === 'builtin') {
      const session = await this._createSession(systemPrompt, context);
      let fullPrompt = "";
      if (history && history.length > 0) {
        for (const turn of history) {
          fullPrompt += `User: ${turn.query}\nAssistant: ${turn.reply}\n`;
        }
      }
      fullPrompt += `User: ${prompt}\nAssistant:`;
      return this._streamPrompt(fullPrompt, onChunk, context, session);
    }

    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    if (history && history.length > 0) {
      for (const turn of history) {
        messages.push({ role: 'user', content: turn.query });
        messages.push({ role: 'assistant', content: turn.reply });
      }
    }

    messages.push({ role: 'user', content: prompt });

    const useExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect;
    if (useExtension) {
      return this._streamExtension(this.provider, this.endpoint, this.apiKey, this.model, messages, onChunk, context);
    } else {
      return this._streamDirect(this.provider, this.endpoint, this.apiKey, this.model, messages, onChunk, context);
    }
  }

  // 1. 章節/選段摘要 (流式輸出)
  async summarize(text, onChunk, context = null) {
    const systemPrompt = getMsg('ai_system_prompt_summarize') || 'You are a helpful reading assistant. Summarize the following text concisely. Respond in the language of the text input.';
    const prompt = `Please summarize this text: \n\n${text.substring(0, 4000)}`;
    return this._chat(systemPrompt, prompt, onChunk, [], context);
  }

  // 2. 生詞釋義 (流式輸出)
  async explainWord(word, textContext, onChunk, operationContext = null) {
    const systemPrompt = getMsg('ai_system_prompt_explain') || 'You are a helpful dictionary assistant. Explain the meaning of the selected word based on its context. Keep it concise.';
    const prompt = `Selected Word: "${word}"\nContext: "...${textContext.substring(0, 500)}..."\n\nPlease explain the word's meaning in this context.`;
    return this._chat(systemPrompt, prompt, onChunk, [], operationContext);
  }

  // 3. 離線翻譯 (流式輸出)
  async translate(text, targetLangName, onChunk, context = null) {
    const systemPrompt = (getMsg('ai_system_prompt_translate') || 'You are a professional translator. Translate the text into {target}. Output only the translation, no explanation.').replace('$target$', targetLangName).replace('{target}', targetLangName);
    const prompt = `Translate this text:\n\n${text.substring(0, 1500)}`;
    return this._chat(systemPrompt, prompt, onChunk, [], context);
  }

  // 流式 Prompt 處理封裝 (內置 AI)
  async _streamPrompt(prompt, onChunk, context = null, requestSession = this.session) {
    if (!requestSession) throw new Error('AI session is not initialized');

    try {
      this._assertCurrent(context);
      if (typeof requestSession.promptStreaming === 'function') {
        const stream = requestSession.promptStreaming(prompt);
        let fullResponse = '';
        
        for await (const chunk of stream) {
          this._assertCurrent(context);
          fullResponse = chunk;
          if (onChunk) onChunk(chunk);
        }
        return fullResponse;
      } else {
        const response = await requestSession.prompt(prompt);
        this._assertCurrent(context);
        if (onChunk) onChunk(response);
        return response;
      }
    } catch (e) {
      if (e?.name !== 'AbortError') console.error('AI prompt error:', e);
      throw e;
    } finally {
      try { requestSession.destroy(); } catch(e) {}
      if (this.session === requestSession) this.session = null;
    }
  }

  // 透過 Extension 背景 Service Worker 流式訪問 (無跨域 CORS 問題)
  async _streamExtension(provider, url, apiKey, model, messages, onChunk, context = null) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'ai-stream' });
      let fullResponse = '';
      let settled = false;
      let disconnected = false;
      const disconnect = () => {
        if (disconnected) return;
        disconnected = true;
        try { port.disconnect(); } catch (e) {}
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        context?.controller?.signal.removeEventListener('abort', abort);
        disconnect();
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(context.controller.signal.reason || new DOMException('AI operation aborted', 'AbortError'));
      context?.controller?.signal.addEventListener('abort', abort, { once: true });

      port.onMessage.addListener((msg) => {
        if (settled) return;
        if (msg.type === 'chunk') {
          try {
            this._assertCurrent(context);
            fullResponse += msg.text;
            if (onChunk) onChunk(fullResponse);
          } catch (error) { finish(error); }
        } else if (msg.type === 'done') {
          finish(null, fullResponse);
        } else if (msg.type === 'error') {
          finish(new Error(msg.message));
        }
      });

      port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) {
          finish(new Error(chrome.runtime.lastError.message));
        } else if (!settled) {
          finish(new Error('AI extension port disconnected'));
        }
      });

      port.postMessage({
        action: 'chat',
        provider,
        url,
        apiKey,
        model,
        messages
      });
      try { this._assertCurrent(context); } catch (error) { finish(error); }
    });
  }

  // 獨立離線 HTML 環境下直接 Fetch 流式訪問
  async _streamDirect(provider, url, apiKey, model, messages, onChunk, context = null) {
    this._assertCurrent(context);
    let fetchUrl = (url ? url.trim() : "");
    if (!fetchUrl) {
      fetchUrl = provider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:11434';
    }
    const activeModel = (model ? model.trim() : "") || (provider === 'openai' ? 'gpt-4o-mini' : 'llama3');

    const headers = {
      'Content-Type': 'application/json'
    };
    let body = {};

    if (provider === 'openai') {
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      if (!fetchUrl.endsWith('/chat/completions')) {
        fetchUrl = fetchUrl.replace(/\/+$/, '') + '/chat/completions';
      }
      body = {
        model: activeModel,
        messages: messages,
        stream: true
      };
    } else if (provider === 'ollama') {
      if (!fetchUrl.endsWith('/api/chat')) {
        fetchUrl = fetchUrl.replace(/\/+$/, '') + '/api/chat';
      }
      body = {
        model: activeModel,
        messages: messages,
        stream: true
      };
    }

    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: context?.controller?.signal
    });
    this._assertCurrent(context);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      this._assertCurrent(context);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const cleanedLine = line.trim();
        if (!cleanedLine) continue;

        if (provider === 'openai') {
          if (cleanedLine === 'data: [DONE]') {
            continue;
          }
          if (cleanedLine.startsWith('data: ')) {
            try {
              const json = JSON.parse(cleanedLine.substring(6));
              const text = json.choices?.[0]?.delta?.content || '';
              if (text) {
                fullResponse += text;
                this._ownedChunk(context, onChunk)(fullResponse);
              }
            } catch (e) {
              if (e?.name === 'AbortError') throw e;
              console.warn('Parse error:', cleanedLine, e);
            }
          }
        } else if (provider === 'ollama') {
          try {
            const json = JSON.parse(cleanedLine);
            const text = json.message?.content || '';
            if (text) {
              fullResponse += text;
              this._ownedChunk(context, onChunk)(fullResponse);
            }
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            console.warn('Parse error:', cleanedLine, e);
          }
        }
      }
    }

    if (buffer.trim()) {
      const cleanedLine = buffer.trim();
      if (provider === 'openai' && cleanedLine.startsWith('data: ') && cleanedLine !== 'data: [DONE]') {
        try {
          const json = JSON.parse(cleanedLine.substring(6));
          const text = json.choices?.[0]?.delta?.content || '';
          if (text) {
            fullResponse += text;
            this._ownedChunk(context, onChunk)(fullResponse);
          }
        } catch (e) { if (e?.name === 'AbortError') throw e; }
      } else if (provider === 'ollama') {
        try {
          const json = JSON.parse(cleanedLine);
          const text = json.message?.content || '';
          if (text) {
            fullResponse += text;
            this._ownedChunk(context, onChunk)(fullResponse);
          }
        } catch (e) { if (e?.name === 'AbortError') throw e; }
      }
    }

    return fullResponse;
  }

  // 測試 AI 連線配置是否可用
  async testConnection(provider, endpoint, apiKey, model) {
    const prevProvider = this.provider;
    const prevEndpoint = this.endpoint;
    const prevApiKey = this.apiKey;
    const prevModel = this.model;

    try {
      this.configure({ provider, apiKey, endpoint, model });

      if (provider === 'builtin') {
        await this.checkAvailability();
        if (!this.isSupported) throw new Error('Built-in AI is not supported in this browser.');
        return 'Built-in AI (Gemini Nano) is available!';
      }

      let resultText = '';
      const testSystemPrompt = 'You are a helpful assistant. Respond with a very short connection success message.';
      const testUserPrompt = 'Respond with "OK" if you receive this.';
      
      await this._chat(testSystemPrompt, testUserPrompt, (chunk) => {
        resultText = chunk;
      });
      
      return resultText || 'Connection OK';
    } finally {
      this.configure({ provider: prevProvider, apiKey: prevApiKey, endpoint: prevEndpoint, model: prevModel });
    }
  }

  // 獲取模型列表
  async fetchModels(provider, url, apiKey) {
    const useExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;
    if (useExtension) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'fetchModels', provider, url, apiKey }, (response) => {
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
      // 獨立離線 HTML 環境下直接 Fetch
      let fetchUrl = (url ? url.trim() : "");
      if (!fetchUrl) {
        fetchUrl = provider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:11434';
      }
      const headers = {};
      if (apiKey && provider === 'openai') {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      if (provider === 'openai') {
        fetchUrl = fetchUrl.replace(/\/+$/, '') + '/models';
      } else if (provider === 'ollama') {
        fetchUrl = fetchUrl.replace(/\/+$/, '') + '/api/tags';
      }

      try {
        const response = await fetch(fetchUrl, { headers });
        if (!response.ok) throw new Error("Status " + response.status);
        const data = await response.json();
        let models = [];
        if (provider === 'openai' && data.data) {
          models = data.data.map(m => m.id);
        } else if (provider === 'ollama' && data.models) {
          models = data.models.map(m => m.name);
        }
        return models;
      } catch (err) {
        if (provider === 'ollama') {
          try {
            let fallbackUrl = (url ? url.trim() : 'http://localhost:11434').replace(/\/+$/, '') + '/v1/models';
            const response = await fetch(fallbackUrl, { headers });
            if (response.ok) {
              const data = await response.json();
              if (data.data) {
                return data.data.map(m => m.id);
              }
            }
          } catch(e) {}
        }
        throw err;
      }
    }
  }
}
