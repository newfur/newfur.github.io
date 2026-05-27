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
          },
          {
            header: "User-Agent",
            operation: "set",
            value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
          }
        ]
      },
      condition: {
        urlFilter: "speech.platform.bing.com",
        resourceTypes: ["websocket", "xmlhttprequest"]
      }
    }
  ];

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: rules
  }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to update dynamic rules:", chrome.runtime.lastError);
    } else {
      console.log("Successfully registered Edge TTS dynamic rules.");
    }
  });
}

// 註冊初始化與啟動事件
chrome.runtime.onInstalled.addListener(setupRules);
chrome.runtime.onStartup.addListener(setupRules);
// 每次 Service Worker 被喚醒時都調用，確保 session 規則存在
setupRules();

// 監聽來自前台的訊息，代理 CORS 限制的請求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchVoices") {
    fetch("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4")
      .then(r => {
        if (!r.ok) throw new Error("Status " + r.status);
        const serverDate = r.headers.get("Date");
        return r.json().then(data => ({ data, serverDate }));
      })
      .then(({ data, serverDate }) => sendResponse({ success: true, data, serverDate }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 保持異步通道開啟
  }
});
