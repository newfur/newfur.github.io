// service-worker.js
// 監聽用戶點擊擴充功能圖籤事件，並打開全螢幕網頁版閱讀器
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("reader/reader.html")
  });
});

// 設定 declarativeNetRequest 以便在向 Edge TTS 發送 WebSocket 請求時重寫 Origin 標頭
function setupRules() {
  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "Origin",
            operation: "set",
            value: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
          }
        ]
      },
      condition: {
        urlFilter: "speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1",
        resourceTypes: ["websocket", "xmlhttprequest"]
      }
    }
  ];

  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: rules
  }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to update session rules:", chrome.runtime.lastError);
    } else {
      console.log("Successfully registered Edge TTS session rules.");
    }
  });
}

// 註冊初始化與啟動事件
chrome.runtime.onInstalled.addListener(setupRules);
chrome.runtime.onStartup.addListener(setupRules);
// 每次 Service Worker 被喚醒時都調用，確保 session 規則存在
setupRules();
