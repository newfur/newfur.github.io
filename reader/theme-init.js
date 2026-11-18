/**
 * theme-init.js
 * 立即同步恢復使用者主題設定，杜絕首屏白屏與閃爍 (Anti-FOUC)。
 * 符合 Manifest V3 擴充功能 Content Security Policy (CSP: script-src 'self') 規範。
 */
(function() {
  try {
    var theme = null;
    var raw = localStorage.getItem('theme');
    if (raw) {
      try { theme = JSON.parse(raw); } catch (e) { theme = raw; }
    }
    if (!theme && window.matchMedia) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'mint';
    }
    theme = theme || 'mint';
    var themeClass = 'theme-' + theme;

    // 1. 立即同步套用於 <html> 根元素，使 CSS 變數立即生效
    if (document.documentElement) {
      document.documentElement.classList.add(themeClass);
    }

    // 2. 監聽 <body> 元素的掛載，於首幀繪製前同步添加主題 class
    if (document.body) {
      document.body.classList.add(themeClass);
    } else {
      var observer = new MutationObserver(function() {
        if (document.body) {
          document.body.classList.add(themeClass);
          observer.disconnect();
        }
      });
      observer.observe(document.documentElement, { childList: true });

      document.addEventListener('DOMContentLoaded', function() {
        observer.disconnect();
        if (document.body && !document.body.classList.contains(themeClass)) {
          document.body.classList.add(themeClass);
        }
      });
    }
  } catch (e) {}
})();
