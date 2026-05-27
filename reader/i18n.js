// reader/i18n.js
// 強化版國際化輔助模組 —— 動態載入 locale JSON 作為後備翻譯源
// 解決 chrome.i18n.getMessage() 在擴充功能未完全重載時無法取得新 key 的問題

// 動態載入的後備翻譯字典
let _fallbackMessages = null;
let _fallbackReady = false;

/**
 * 偵測使用者的 UI 語言並載入對應的 messages.json
 * 優先使用 chrome.i18n.getUILanguage()，如不可用則使用 navigator.language
 */
async function loadFallbackMessages() {
  try {
    // 偵測語言
    let lang = 'en';
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
      lang = chrome.i18n.getUILanguage();
    } else if (navigator.language) {
      lang = navigator.language;
    }

    // 將語言代碼映射為我們支持的 locale 資料夾名稱
    // 例如 "zh-TW" → "zh_TW", "zh-CN" → "zh_CN", "zh" → "zh_CN", "en-US" → "en"
    const normalizedLang = lang.replace('-', '_');
    let localePath = 'en'; // 預設

    if (normalizedLang.startsWith('zh_TW') || normalizedLang.startsWith('zh_HK') || normalizedLang.startsWith('zh_MO')) {
      localePath = 'zh_TW';
    } else if (normalizedLang.startsWith('zh')) {
      localePath = 'zh_CN';
    } else {
      localePath = 'en';
    }

    // 動態載入 JSON
    const url = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL(`_locales/${localePath}/messages.json`)
      : `../_locales/${localePath}/messages.json`;
    const res = await fetch(url);
    if (res.ok) {
      _fallbackMessages = await res.json();
    }
  } catch (e) {
    console.warn('[i18n] Failed to load fallback messages:', e);
    _fallbackMessages = null;
  }
  _fallbackReady = true;
}

/**
 * 從後備字典中取得翻譯文字，支持 $placeholder$ 替換
 */
function getFallbackMsg(key, substitutions = []) {
  if (!_fallbackMessages || !_fallbackMessages[key]) return '';
  let msg = _fallbackMessages[key].message || '';

  // 處理 placeholder 替換 (如 $progress$, $page$, $num$)
  if (substitutions.length > 0 && _fallbackMessages[key].placeholders) {
    const placeholders = _fallbackMessages[key].placeholders;
    for (const [name, info] of Object.entries(placeholders)) {
      // content 格式為 "$1", "$2" 等
      const idx = parseInt(info.content?.replace('$', '')) - 1;
      if (idx >= 0 && idx < substitutions.length) {
        // 替換 $name$ 格式的佔位符 (不分大小寫)
        const pattern = '\\$' + name + '\\$';
        const regex = new RegExp(pattern, 'gi');
        msg = msg.replace(regex, substitutions[idx]);
      }
    }
  }
  return msg;
}

/**
 * 取得國際化翻譯字串
 * 優先嘗試 chrome.i18n.getMessage()，若返回空值則使用後備字典
 */
export function getMsg(key, substitutions = []) {
  // 1. 嘗試 chrome.i18n API（擴充功能原生方式）
  if (typeof chrome !== 'undefined' && chrome.i18n) {
    const result = chrome.i18n.getMessage(key, substitutions);
    if (result) return result;
  }

  // 2. 使用後備字典
  const fallback = getFallbackMsg(key, substitutions);
  if (fallback) return fallback;

  // 3. 最終降級：返回 key 名稱
  return key;
}

/**
 * 掃描 DOM 並套用所有 data-i18n 翻譯
 * 支持 data-i18n（文字內容）、data-i18n-placeholder（輸入框佔位符）、data-i18n-title（提示文字）
 */
export function applyI18n() {
  // 1. 翻譯普通文本或輸入框 Placeholder
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    let message = getMsg(key);

    if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search')) {
      el.placeholder = message;
    } else {
      el.textContent = message;
    }
  });

  // 2. 翻譯 Placeholder 屬性
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = getMsg(key);
  });

  // 3. 翻譯 Title 提示屬性
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.title = getMsg(key);
  });
}

/**
 * 初始化國際化：先載入後備翻譯字典，再套用翻譯
 * 必須在 DOMContentLoaded 後呼叫
 */
export async function initI18n() {
  await loadFallbackMessages();
  applyI18n();
}
