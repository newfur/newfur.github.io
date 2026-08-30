const VOICES_ENDPOINT = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const KNOWN_PROVIDERS = new Set(['openai', 'ollama']);
const MAX_MESSAGES = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 8192;
const DEFAULT_TIMEOUT_MS = 30000;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('reader/reader.html') });
});

function setupRules() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' },
          { header: 'User-Agent', operation: 'set', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0' }
        ]
      },
      condition: { urlFilter: 'speech.platform.bing.com', resourceTypes: ['websocket', 'xmlhttprequest'] }
    }]
  }, () => {
    if (chrome.runtime.lastError) console.error('Failed to update dynamic rules.');
  });
}

chrome.runtime.onInstalled.addListener(setupRules);
chrome.runtime.onStartup.addListener(setupRules);
setupRules();

function isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && url.pathname.startsWith('/reader/');
  } catch {
    return false;
  }
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
  }
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function validateEndpoint(provider, rawUrl) {
  if (!KNOWN_PROVIDERS.has(provider)) throw new Error('Unsupported provider');
  if (typeof rawUrl === 'string' && rawUrl.length > MAX_URL_LENGTH) throw new Error('Request field too large');
  const fallback = provider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:11434';
  let url;
  try {
    url = new URL((typeof rawUrl === 'string' && rawUrl.trim()) || fallback);
  } catch {
    throw new Error('Invalid endpoint');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid endpoint');
  if (isPrivateHostname(url.hostname)) {
    const ollamaLocal = provider === 'ollama' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && (!url.port || url.port === '11434');
    const lmStudioLocal = provider === 'openai' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === '1234';
    if (!ollamaLocal && !lmStudioLocal) throw new Error('Private endpoint is not approved');
  }
  return url;
}

function endpointWithPath(provider, rawUrl, operation) {
  const url = validateEndpoint(provider, rawUrl);
  const suffix = operation === 'models'
    ? (provider === 'ollama' ? '/api/tags' : '/models')
    : (provider === 'ollama' ? '/api/chat' : '/chat/completions');
  if (!url.pathname.endsWith(suffix)) url.pathname = url.pathname.replace(/\/+$/, '') + suffix;
  return url.toString();
}

function safeError(error) {
  if (error?.name === 'AbortError') return 'Request timed out or was cancelled';
  if (/^(?:Unsupported provider|Invalid endpoint|Private endpoint is not approved|Too many messages|Invalid messages|Request body too large|Request field too large)$/.test(error?.message || '')) return error.message;
  return 'Upstream request failed';
}

async function timedFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = options.controller || new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), DEFAULT_TIMEOUT_MS));
  try {
    return await fetch(url, { ...options, controller: undefined, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isTrustedSender(sender) || !request || typeof request !== 'object') {
    sendResponse({ success: false, error: 'Unauthorized caller' });
    return false;
  }
  if (request.action === 'fetchVoices') {
    timedFetch(VOICES_ENDPOINT)
      .then(async (result) => {
        if (!result.ok) throw new Error('Voice service unavailable');
        sendResponse({ success: true, data: await result.json(), serverDate: result.headers.get('Date') });
      })
      .catch((error) => sendResponse({ success: false, error: safeError(error) }));
    return true;
  }
  if (request.action === 'fetchModels') {
    (async () => {
      const url = endpointWithPath(request.provider, request.url, 'models');
      const headers = {};
      if (request.apiKey && String(request.apiKey).length > MAX_API_KEY_LENGTH) throw new Error('Request field too large');
      if (request.apiKey && request.provider === 'openai') headers.Authorization = `Bearer ${String(request.apiKey)}`;
      let result = await timedFetch(url, { headers });
      let data = result.ok ? await result.json() : null;
      if (request.provider === 'ollama' && !Array.isArray(data?.models)) {
        const fallback = validateEndpoint('ollama', request.url);
        fallback.pathname = fallback.pathname.replace(/\/+$/, '') + '/v1/models';
        result = await timedFetch(fallback.toString(), { headers });
        if (!result.ok) throw new Error('Model service unavailable');
        data = await result.json();
      }
      if (!result.ok || !data) throw new Error('Model service unavailable');
      const records = request.provider === 'ollama' ? (data.models || data.data || []) : (data.data || []);
      const models = records.slice(0, 1000).map((model) => String(model.name || model.id || '').slice(0, 256)).filter(Boolean);
      sendResponse({ success: true, models });
    })().catch((error) => sendResponse({ success: false, error: safeError(error) }));
    return true;
  }
  sendResponse({ success: false, error: 'Unsupported action' });
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-stream' || !isTrustedSender(port.sender)) return;
  let controller = null;
  let disconnected = false;
  let settled = false;
  let inFlight = false;
  let timer = null;
  const postOnce = (message) => {
    if (disconnected || settled) return;
    settled = true;
    port.postMessage(message);
  };
  port.onDisconnect.addListener(() => {
    disconnected = true;
    clearTimeout(timer);
    controller?.abort();
  });
  port.onMessage.addListener(async (message) => {
    if (settled || disconnected || inFlight || message?.action !== 'chat') return;
    inFlight = true;
    try {
      if (!KNOWN_PROVIDERS.has(message.provider)) throw new Error('Unsupported provider');
      if (!Array.isArray(message.messages) || message.messages.length > MAX_MESSAGES) throw new Error('Too many messages');
      const messages = message.messages.map((item) => ({
        role: String(item?.role || '').slice(0, 32),
        content: String(item?.content || '')
      }));
      if (messages.some(({ role }) => !['system', 'user', 'assistant'].includes(role))) throw new Error('Invalid messages');
      const body = JSON.stringify({
        model: String(message.model || (message.provider === 'openai' ? 'gpt-4o-mini' : 'llama3')).slice(0, 256),
        messages,
        stream: true
      });
      if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new Error('Request body too large');
      const headers = { 'Content-Type': 'application/json' };
      if (message.apiKey && String(message.apiKey).length > MAX_API_KEY_LENGTH) throw new Error('Request field too large');
      if (message.apiKey && message.provider === 'openai') headers.Authorization = `Bearer ${String(message.apiKey)}`;
      controller = new AbortController();
      const timeoutMs = Math.min(Math.max(Number(message.timeoutMs) || DEFAULT_TIMEOUT_MS, 1), DEFAULT_TIMEOUT_MS);
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const result = await fetch(endpointWithPath(message.provider, message.url, 'chat'), {
        method: 'POST', headers, body, signal: controller.signal
      });
      if (!result.ok) throw new Error('AI service unavailable');
      const reader = result.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (!disconnected) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const text = parseChunk(message.provider, line);
          if (text && !disconnected) port.postMessage({ type: 'chunk', text });
        }
      }
      if (!disconnected) {
        const text = parseChunk(message.provider, buffer);
        if (text) port.postMessage({ type: 'chunk', text });
        postOnce({ type: 'done' });
      }
    } catch (error) {
      postOnce({ type: 'error', message: safeError(error) });
    } finally {
      clearTimeout(timer);
    }
  });
});

function parseChunk(provider, line) {
  const cleaned = line.trim();
  if (!cleaned || cleaned === 'data: [DONE]') return '';
  try {
    const data = JSON.parse(provider === 'openai' && cleaned.startsWith('data: ') ? cleaned.slice(6) : cleaned);
    return provider === 'openai' ? (data.choices?.[0]?.delta?.content || '') : (data.message?.content || '');
  } catch {
    return '';
  }
}
