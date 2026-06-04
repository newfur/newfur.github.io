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

// 監聽來自前台的長連接，用於流式傳輸 AI 回答 (繞過 CORS 限制)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ai-stream") {
    port.onMessage.addListener(async (msg) => {
      if (msg.action === "chat") {
        const { provider, url, apiKey, model, messages } = msg;
        try {
          let fetchUrl = (url ? url.trim() : "");
          if (!fetchUrl) {
            fetchUrl = provider === "openai" ? "https://api.openai.com/v1" : "http://localhost:11434";
          }
          const activeModel = (model ? model.trim() : "") || (provider === "openai" ? "gpt-4o-mini" : "llama3");

          const headers = {
            "Content-Type": "application/json"
          };
          let body = {};

          if (provider === "openai") {
            if (apiKey) {
              headers["Authorization"] = `Bearer ${apiKey}`;
            }
            if (!fetchUrl.endsWith("/chat/completions")) {
              fetchUrl = fetchUrl.replace(/\/+$/, "") + "/chat/completions";
            }
            body = {
              model: activeModel,
              messages: messages,
              stream: true
            };
          } else if (provider === "ollama") {
            if (!fetchUrl.endsWith("/api/chat")) {
              fetchUrl = fetchUrl.replace(/\/+$/, "") + "/api/chat";
            }
            body = {
              model: activeModel,
              messages: messages,
              stream: true
            };
          }

          const response = await fetch(fetchUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(body)
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText || response.statusText}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); // 保留不完整的一行

            for (const line of lines) {
              const cleanedLine = line.trim();
              if (!cleanedLine) continue;

              if (provider === "openai") {
                if (cleanedLine === "data: [DONE]") {
                  continue;
                }
                if (cleanedLine.startsWith("data: ")) {
                  try {
                    const json = JSON.parse(cleanedLine.substring(6));
                    const text = json.choices?.[0]?.delta?.content || "";
                    if (text) {
                      port.postMessage({ type: "chunk", text });
                    }
                  } catch (e) {
                    console.warn("Parse error for line:", cleanedLine, e);
                  }
                }
              } else if (provider === "ollama") {
                try {
                  const json = JSON.parse(cleanedLine);
                  const text = json.message?.content || "";
                  if (text) {
                    port.postMessage({ type: "chunk", text });
                  }
                } catch (e) {
                  console.warn("Parse error for line:", cleanedLine, e);
                }
              }
            }
          }

          // 處理剩餘的緩衝區
          if (buffer.trim()) {
            const cleanedLine = buffer.trim();
            if (provider === "openai" && cleanedLine.startsWith("data: ") && cleanedLine !== "data: [DONE]") {
              try {
                const json = JSON.parse(cleanedLine.substring(6));
                const text = json.choices?.[0]?.delta?.content || "";
                if (text) port.postMessage({ type: "chunk", text });
              } catch (e) {}
            } else if (provider === "ollama") {
              try {
                const json = JSON.parse(cleanedLine);
                const text = json.message?.content || "";
                if (text) port.postMessage({ type: "chunk", text });
              } catch (e) {}
            }
          }

          port.postMessage({ type: "done" });
        } catch (error) {
          port.postMessage({ type: "error", message: error.message });
        }
      }
    });
  }
});

