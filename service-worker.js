const VOICES_ENDPOINT = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const KNOWN_PROVIDERS = new Set(['openai', 'ollama']);
const MAX_MESSAGES = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 8192;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
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

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((part) => part <= 255) ? octets : null;
}

function parseIpv6(host) {
  if (!host.includes(':') || host.includes('%')) return null;
  let value = host;
  const ipv4Match = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[2]);
    if (!ipv4) return null;
    value = `${ipv4Match[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  if ((value.match(/::/g) || []).length > 1) return null;
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill('0'), ...right].map((part) => parseInt(part, 16));
}

function classifyIpv4(octets) {
  const loopback = octets[0] === 127;
  return {
    loopback,
    private: loopback || octets[0] === 0 || octets[0] === 10 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
  };
}

function classifyHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === 'localhost') return { private: true, loopback: true };
  if (host.endsWith('.localhost')) return { private: true, loopback: false };
  const ipv4 = parseIpv4(host);
  if (ipv4) return classifyIpv4(ipv4);
  const ipv6 = parseIpv6(host);
  if (!ipv6) return { private: false, loopback: false };
  const unspecified = ipv6.every((part) => part === 0);
  const loopback = ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1;
  const mapped = ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff;
  if (mapped) return classifyIpv4([ipv6[6] >> 8, ipv6[6] & 255, ipv6[7] >> 8, ipv6[7] & 255]);
  const linkLocal = (ipv6[0] & 0xffc0) === 0xfe80;
  const uniqueLocal = (ipv6[0] & 0xfe00) === 0xfc00;
  return { private: unspecified || loopback || linkLocal || uniqueLocal, loopback };
}

function isAllowedLocalPath(provider, pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const allowed = provider === 'ollama'
    ? ['/', '/api/tags', '/v1/models', '/api/chat']
    : ['/', '/v1', '/models', '/v1/models', '/chat/completions', '/v1/chat/completions'];
  return allowed.includes(normalized);
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
  const host = classifyHost(url.hostname);
  if (host.private) {
    const ollamaLocal = provider === 'ollama' && host.loopback && url.protocol === 'http:' && url.port === '11434' && isAllowedLocalPath(provider, url.pathname);
    const lmStudioLocal = provider === 'openai' && host.loopback && url.protocol === 'http:' && url.port === '1234' && isAllowedLocalPath(provider, url.pathname);
    if (!ollamaLocal && !lmStudioLocal) throw new Error('Private endpoint is not approved');
  }
  return url;
}

function endpointWithPath(provider, rawUrl, operation) {
  const url = validateEndpoint(provider, rawUrl);
  const suffix = operation === 'fallbackModels' ? '/v1/models' : operation === 'models'
    ? (provider === 'ollama' ? '/api/tags' : '/models')
    : (provider === 'ollama' ? '/api/chat' : '/chat/completions');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(suffix)) {
    let base = pathname.replace(/\/(?:api\/tags|api\/chat|chat\/completions)$/, '').replace(/\/+$/, '');
    if (/\/v1\/models$/.test(base)) base = provider === 'ollama' ? base.replace(/\/v1\/models$/, '') : base.replace(/\/models$/, '');
    url.pathname = base + suffix;
  } else {
    url.pathname = pathname;
  }
  return url.toString();
}

function safeError(error) {
  if (error?.name === 'AbortError') return 'Request timed out or was cancelled';
  if (/^(?:Unsupported provider|Invalid endpoint|Private endpoint is not approved|Too many messages|Invalid messages|Request body too large|Request field too large)$/.test(error?.message || '')) return error.message;
  return 'Upstream request failed';
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new Error('Response body too large');
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data: JSON.parse(new TextDecoder('utf-8').decode(body)), response };
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
    fetchJson(VOICES_ENDPOINT, {}, request.timeoutMs)
      .then(({ data, response }) => {
        sendResponse({ success: true, data, serverDate: response.headers.get('Date') });
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
      let data;
      try {
        ({ data } = await fetchJson(url, { headers }, request.timeoutMs));
        if (request.provider === 'ollama' && !Array.isArray(data?.models)) throw new Error('Invalid Ollama response');
      } catch (error) {
        if (request.provider !== 'ollama') throw error;
        ({ data } = await fetchJson(endpointWithPath('ollama', request.url, 'fallbackModels'), { headers }, request.timeoutMs));
      }
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
