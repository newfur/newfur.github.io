# Edge 網頁版電子書閱讀器 (Edge E-Book Reader)

Language: [简体中文](README.md) | **繁體中文** | [English](README.en.md)

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web%20%7C%20Android%20%7C%20iOS-blue)](javascript:;)
[![Version](https://img.shields.io/badge/version-3.4.66-orange)](https://github.com/newfur/newfur.github.io/releases/tag/v3.4.66)
[![Build & Deploy](https://github.com/newfur/newfur.github.io/actions/workflows/build-deploy.yml/badge.svg)](https://github.com/newfur/newfur.github.io/actions)
[![License](https://img.shields.io/badge/license-ISC-green)](LICENSE)

一款專為現代桌面瀏覽器與行動裝置（iOS / Android）打造的沉浸式、高效能且高度可自訂的跨平台電子書閱讀器。專案採用**純前端核心 + 輕量原生橋接**的現代化解耦架構，整合了全格式書籍解析引擎、微軟 Edge 神經網路自然人聲語音朗讀（TTS）、雙引擎自適應播放架構、端側/雲端 AI 伴侶、全書客戶端 RAG 檢索以及多端鎖定畫面媒體中心深度連動。

專案提供 **瀏覽器擴充功能版**、**單檔案離線網頁版**、**線上網頁/PWA版**、**Android 原生 App** 以及 **iOS 原生 App** 五種發行形態，覆蓋從桌面大螢幕到手機平板的全情境無縫閱讀。

---

## 🌟 最新多端重構核心亮點 (v3.4.6x)

針對跨平台行動閱讀、長時間聽書、背景保活與裝置儲存的痛點，最新版本完成了深度的底層重構：

### 1. 🎧 雙引擎自適應 TTS 架構 (Adaptive Dual-Engine Architecture)
- **Route A（標準 Web DOM 音訊流）**：專為桌面瀏覽器擴充功能、單檔案離線版及 Web 網頁端設計。基於標準 HTML5 Audio API 與記憶體 Blob URL，事件驅動，極致輕盈。
- **Route B（行動端原生硬體雙緩衝無縫引擎 - Native Twin-Player Engine）**：
  - **0ms 極速無縫換句 (Gapless Playback)**：針對行動端 WebView 在鎖定畫面/背景下容易被系統降頻、導致句間卡頓或停頓的痛點，iOS (`AVAudioPlayer`) 與 Android (`MediaPlayer`) 原生層均實現了**雙底層硬體通道乒乓交叉緩衝（Ping-Pong Buffering）**。當當前句子在通道 A 發聲時，下一句音訊已在背景完成合成並在通道 B 完成物理硬體預熱（`prepareToPlay`）；當前句播放結束瞬間，硬體通道毫秒級無感切換，徹底消滅句間延遲與空隙！
  - **全鏈路主執行緒 RunLoop 排程**：iOS 端原生層所有播放器建立、事件監聽與狀態管理嚴格綁定於主執行緒 `RunLoop.main`，根治了蘋果 CoreAudio 在背景 GCD 工作執行緒中丟棄代理回呼（`audioPlayerDidFinishPlaying`）的頑疾。
  - **硬體級看門狗雙保險 (Hardware Watchdog Fallback Timer)**：原生底層配備智慧看門狗守護計時器，動態計算預期播放時長。在來電掛斷、藍牙耳機頻繁切換、音訊工作階段搶占等極端系統異常導致硬體事件未回報時，看門狗自動檢測硬體真實狀態並自動推進下一句，**保障多小時連續朗讀永不假死卡頓**。

### 2. 🗄️ 徹底解耦的極速儲存引擎 (Decoupled Storage Engine)
- **告別應用儲存惡性膨脹**：舊版閱讀器在長期閱讀、記錄進度或匯出時容易產生多重巢狀序列化，導致應用占用空間異常暴漲。重構後徹底剝離書籍內容實體與全域設定、閱讀進度，書籍正文、索引與閱讀記錄在 IndexedDB 中實行獨立分表儲存。
- **儲存健康可控**：即便匯入數百本大容量圖文書籍，應用自身體積與執行快取也始終保持在幾十兆的極佳水準，徹底根除了「應用占用幾十甚至上百 GB」的儲存隱患。

### 3. 🖼️ 全域 512px 動態封面壓縮與廣播機制 (`compressCoverImage`)
- 原版電子書封面解析度往往極高（體積達 3MB~10MB），頻繁透過 JS 橋接發送給原生媒體中心極易引發跨程序通訊阻塞甚至 OOM 閃退。
- 新增智慧 Canvas 降採樣壓縮管線：在解析圖書瞬間將封面自動等比壓縮至 512×512 視網膜高畫質規格（僅 20KB~40KB），不僅鎖定畫面與通知列秒顯封面，更大幅降低記憶體消耗。

### 4. 🧠 客戶端全書非同步 RAG 與全文秒級檢索
- 純前端自研輕量倒排索引與 TF-IDF 檢索演算法，開啟書籍背景非同步毫秒級完成全書切片索引（總索引建構通常在 1 秒以內），為端側模型（Gemini Nano）與雲端大模型（OpenAI、DeepSeek、Claude、Ollama 等）提供精準的上下文知識庫，支援角色脈絡梳理與 Mermaid 動態心智圖生成。

---

## 📱 五大版本能力與選型對比

| 功能維度 | 🧩 瀏覽器擴充功能版 | 💾 單檔案離線版 | 🌐 線上網頁/PWA版 | 🤖 Android 原生版 | 🍎 iOS 原生版 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **執行平台** | Chrome/Edge/Brave 桌面擴充 | 任意現代瀏覽器按兩下直接開啟 | 瀏覽器造訪或新增為 PWA | Android 8.0+ 手機/平板 | iOS 13.0+ (iPhone/iPad) |
| **安裝套件體積** | 約 2.4 MB (ZIP) | 約 2.3 MB (單個 HTML) | 0 位元組 (即開即用) | 約 16 MB (APK) | 僅 **2.25 MB** (IPA) |
| **安裝方式** | 開發者模式載入解壓目錄 | 本地儲存，按兩下即用 | 造訪 URL / 新增到主畫面 | 安裝 APK 安裝套件 | 使用 Sideloadly / 巨魔安裝 |
| **網路要求** | 完全離線閱讀（TTS需連網） | 完全離线閱讀（TTS需連網） | 離線快取支援（PWA） | 完全離線閱讀（TTS需連網） | 完全離線閱讀（TTS需連網） |
| **多格式解析** | ✅ EPUB, AZW3, MOBI, TXT, CBZ | ✅ 完整支援 | ✅ 完整支援 | ✅ 完整支援 | ✅ 完整支援 |
| **Edge 神經網路TTS** | ✅ 完美支援（MV3請求標頭改寫） | ✅ 完美支援（直連官方 WebSocket）| ⚠️ 本地Node支援；公網靜態降級 | ✅ 完美支援（原生穿透） | ✅ 完美支援（原生穿透） |
| **TTS 底層架構** | Route A (DOM Audio) | Route A (DOM Audio) | Route A (DOM Audio) | **Route B (雙硬體無縫緩衝)** | **Route B (雙硬體無縫緩衝)** |
| **0ms 換句與看門狗** | 依賴瀏覽器核心排程 | 依賴瀏覽器核心排程 | 依賴瀏覽器核心排程 | ✅ 硬體雙緩衝 + 零延遲切句 | ✅ 硬體雙緩衝 + 看門狗守護 |
| **背景與鎖定畫面朗讀** | ❌ 僅限前台分頁 | ❌ 行動端息屏易被掛起 | ⚠️ 依賴靜音保活，易受回收 | ✅ 極佳（前台服務喚醒鎖） | ✅ 極佳（AVAudioSession保活） |
| **鎖定畫面封面與媒體控制** | ❌ 不支援 | ❌ 不支援 | ⚠️ 部分瀏覽器支援 MediaSession | ✅ 完整 MediaSession 鎖定畫面控制 | ✅ 深度整合 MPNowPlaying 控制 |
| **AI 伴侶 & 心智圖**| ✅ 端側 Gemini Nano + 雲端 | ✅ 支援雲端/本地 Ollama API | ✅ 完整支援 | ✅ 推薦設定雲端 API / Ollama | ✅ 推薦設定雲端 API / Ollama |
| **資料安全與備份** | 擴充功能專屬 IndexedDB | 本地檔案隔離 IndexedDB | 網域隔離 IndexedDB | 沙盒解耦儲存，支援整包備份 | 沙盒解耦儲存，支援整包備份 |

---

### 1. 🧩 瀏覽器擴充功能版 (Chrome / Edge Extension - MV3)
* **核心優勢**：
  - 透過 Manifest V3 的 `declarativeNetRequest` 動態改寫請求標頭，**徹底突破微軟 Edge 雲端 TTS 的 CORS 跨網域限制與 Origin 防盜鏈檢測**，在桌面瀏覽器內直享幾十種超自然真人員工神經網路語音。
  - 原生適配 Chrome 128+ 內建的 **Gemini Nano** 端側大模型，無需消耗外網流量或設定 API Key，即可實現段落精讀、古文翻譯、生詞解釋與章節速讀。
* **局限性**：
  - 僅限於 Chromium 核心桌面瀏覽器；關閉瀏覽器後朗讀停止。
* **安裝步驟**：
  1. 在 [Releases](https://github.com/newfur/newfur.github.io/releases) 下載 `Raconteur-Chrome-*.zip` 並解壓縮。
  2. 瀏覽器網址列輸入 `chrome://extensions/` 或 `edge://extensions/`。
  3. 開啟右上角 **「開發者模式」** 開關。
  4. 點選 **「載入未打包的擴充功能」**，選取解壓縮目錄即可。

---

### 2. 💾 單檔案離線網頁版 (Single-File Offline Reader)
* **核心優勢**：
  - **零依賴單檔案**：整個閱讀器所有 JS 邏輯、CSS 樣式、解析器核心（JSZip 等）、字型及多語言資源全部內聯壓制在一個 `.html` 檔案中（約 2.3MB）。
  - **本地直連 Edge 語音**：直接在本地以 `file:///` 通訊協定開啟執行時，閱讀器會透過 WebSocket (`wss://speech.platform.bing.com/...`) 直連微軟官方服務，結合動態計算的 `Sec-MS-GEC` 鑑權權杖，**完全不受跨網域限制，可直接流暢播放微軟高品質神經網路人聲**！若離線則自動降級為系統發音。
  - 無需安裝 Node.js、無需部署伺服器，Windows/macOS/Linux/手機瀏覽器按兩下即開。
* **局限性**：
  - 手機行動端瀏覽器退入背景或熄屏時，網頁指令碼易被系統休眠，無鎖定畫面主控台。
* **安裝使用**：
  1. 在 [Releases](https://github.com/newfur/newfur.github.io/releases) 下載最新的 `Raconteur-Offline-*.html`。
  2. 任意現代瀏覽器按兩下直接執行，建議按 `Ctrl+D`（或 `Cmd+D`）加入書籤以便日後使用。

---

### 3. 🌐 線上網頁 / PWA 版 (Web Server & PWA)
* **核心優勢**：
  - 支援多裝置連網造訪，支援新增至桌面或手機主畫面（PWA 獨立視窗執行，無瀏覽器頂欄遮擋）。
  - 本地 Node.js 執行模式（`npm start`）內建專有 `/api/tts` 反向代理，支援滿血 Edge 自然語音。
* **局限性**：
  - 公網純靜態託管環境（如 GitHub Pages、Vercel）因缺少後端中繼且受制於瀏覽器跨網域策略，Edge 語音會自動降級為瀏覽器本地 Web Speech 發音。建議需純淨網路體驗者使用外掛程式版、單檔案離線版或行動用戶端。
* **使用方式**：
  - **線上直達**：造訪部署網址；手機點選 Safari 「分享」 -> **「加入主畫面」** 獲得 App 級體驗。
  - **本地私有化部署**：
    ```bash
    git clone https://github.com/newfur/newfur.github.io.git
    cd newfur.github.io
    npm install
    npm start
    # 造訪 http://localhost:3000
    ```

---

### 4. 🤖 Android 原生版 (Android APK)
* **核心優勢**：
  - **前台服務硬核保活 (`AudioPlayerService`)**：在系統級啟用帶有喚醒鎖（`PARTIAL_WAKE_LOCK`）的前台常駐播放服務，鎖定畫面、滅屏或切至其他 App 聽書數小時依然穩定播放。
  - **Route B 原生雙緩衝播放**：雙 `MediaPlayer` 硬體緩衝區自動交替無縫換句，無延遲停頓。
  - **原生鎖定畫面與系統通知列主控台**：深度接入 Android `MediaSession`，顯示即時朗讀句子、書籍名、作者與全域 512px 壓縮封面，支援實體按鍵/藍牙耳機上一句、下一句與播放控制。
  - **原生實體返回鍵攔截**：層級返回，優先退出浮層與目錄，避免誤觸退出應用程式。
* **安裝步驟**：
  1. 在 [Releases](https://github.com/newfur/newfur.github.io/releases) 下載最新的 `Raconteur-*.apk`。
  2. 傳輸到安卓裝置點選安裝（若系統提示外部來源風險，選擇允許繼續安裝）。

---

### 5. 🍎 iOS 原生版 (iOS IPA)
* **核心優勢**：
  - **極致超輕量**：基於 Capacitor 與原生 Swift 精準建構，安裝套件體積僅 **2.25MB**！
  - **Route B 原生雙緩衝無縫播放引擎**：採用雙 `AVAudioPlayer` 交叉乒乓輪替技術，主執行緒 RunLoop 精準排程，毫秒級無感換句，徹底告別 WebKit 程序在鎖定畫面下的凍結卡頓。
  - **硬體級看門狗雙保險**：遇到來電、藍牙搶占等異常打斷時，看門狗自動檢測並自動恢復，永不假死。
  - **系統鎖定畫面、控制中心與動態島整合**：深度接入 `MPNowPlayingInfoCenter` 與 `MPRemoteCommandCenter`，設定 `AVAudioSession (.playback)` 模式，鎖定畫面即時呈現高畫質書籍封面、朗讀文字、章節進度及耳機遙控切句。
  - **全螢幕自適應**：原生動態測量並適配瀏海螢幕與動態島（Dynamic Island）頂部安全區。
* **安裝步驟**：
  - **推薦使用 Sideloadly 側載安裝**：
    1. 電腦端下載並安裝 [Sideloadly](https://sideloadly.io/)；
    2. 在 [Releases](https://github.com/newfur/newfur.github.io/releases) 下載最新的 `EdgeReader-*.ipa`；
    3. 將 `.ipa` 檔案拖入 Sideloadly，填寫您的 Apple ID 帳號；
    4. 用傳輸線將 iPhone / iPad 連接至電腦，點選 **Start** 簽名並安裝；
    5. 開啟手機「設定」->「一般」->「VPN 與裝置管理」，信任該憑證即可暢享閱讀！
  - 也支援使用 AltStore、SideStore、巨魔商店（TrollStore）或 Mac 本地 Xcode 編譯安裝。

---

## 🛠️ 專案架構設計

本專案採用分層解耦的純前端驅動 + 原生輕量外掛程式化架構設計：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Edge Reader 跨平台架構設計                            │
└─────────────────────────────────────────────────────────────────────────────┘

                  ┌─────────────────────────────────────────┐
                  │          UI 排版與使用者互動呈現層      │
                  │   reader.html / reader.css / i18n.js    │
                  │ (左右翻頁/縱向滾動/主題紙質/字型/高亮浮層)  │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │            核心閱讀器控制器             │
                  │               reader.js                 │
                  └─────────┬──────────┬──────────┬─────────┘
                            │          │          │
    ┌───────────────────────┘          │          └─────────────────────────┐
    ▼                                  ▼                                    ▼
┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐
│     全格式電子書解析    │ │   自適應雙路由 TTS 引擎 │ │   AI 伴侶 & 客戶端 RAG  │
│    parsers/ (純前端JS)  │ │          tts.js         │ │         ai.js           │
├─────────────────────────┤ ├─────────────────────────┤ ├─────────────────────────┤
│ • EPUB (EPUB 2/3 標準)  │ │ 【Route A - Web DOM】   │ │ • 瀏覽器端側Gemini Nano │
│ • AZW3 / MOBI (Kindle)  │ │   HTML5 Audio (PC/擴充) │ │ • 雲端 API (OpenAI/Deep)│
│ • TXT (智慧目錄推導)    │ │ 【Route B - 原生雙緩衝】│ │ • 本地模型 (Ollama/LM)  │
│ • CBZ (漫畫圖片瀑布流)  │ │   0ms 硬體雙緩衝無縫切換│ │ • 全書非同步倒排 RAG 索引 │
│ • FB2 (FictionBook)     │ │   硬體級看門狗狀態守護  │ │ • Mermaid 心智圖生成    │
└─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │          資料持久化與解耦儲存層         │
                  │               library.js                │
                  │   IndexedDB (實體獨立儲存，嚴禁內聯膨脹)│
                  │   512px 全域封面智慧壓縮與跨端廣播機制  │
                  └────────────────────┬────────────────────┘
                                       │
     ┌─────────────────────────────────┴─────────────────────────────────┐
     ▼                                                                   ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────────────┐
│           Web 與桌面擴充功能執行環境  │ │         行動端原生引擎橋接層 (Capacitor)│
├───────────────────────────────────────┤ ├───────────────────────────────────────┤
│ • Chrome MV3 declarativeNetRequest    │ │ • NativeTTS 原生擴充套件              │
│ • Service Worker (離線資源智慧快取)   │ │ • Android: AudioPlayerService 前台服務│
│ • 單檔案靜態內聯打包 (Offline HTML)   │ │ • iOS: AVAudioPlayer + MPNowPlaying   │
│ • Node.js 本地微服務與 WebSocket 代理 │ │ • 硬體看門狗計時器 & 執行緒 RunLoop 保障│
└───────────────────────────────────────┘ └───────────────────────────────────────┘
```

---

## 💻 開發者指南與建構指令

本專案根目錄下提供了完善的自動化打包、編譯與同步指令碼：

```bash
# 1. 安裝開發依賴
npm install

# 2. 啟動本地開發服務 (預設連接埠 3000，內建 Edge TTS 代理)
npm start

# 3. 編譯單檔案離線版 (產生 reader_offline.html 與 index.html)
npm run build:offline

# 4. 一鍵建構 Web 產物並同步至 Android / iOS 專案
npm run build:dist
npx cap copy ios
npx cap copy android

# 5. 一鍵編譯 iOS 原生 IPA 安裝套件 (需 macOS + Xcode 環境)
npm run build:ipa

# 6. 執行全套測試套件
npm test
```

---

## ⚠️ 常見問題與說明

1. **DRM 加密書籍**：閱讀器解析器為純客戶端前端演算法，不支援受商業版權保護（如亞馬遜 Kindle DRM、Adobe DRM）的加密檔案，匯入前請先使用解密工具轉換為普通 EPUB/AZW3/TXT。
2. **端側本地大模型 (Gemini Nano)**：僅支援 Chrome/Edge 128+ 開發版/金絲雀版，需在 `chrome://flags` 中開啟相關實驗性 Prompt API 特性，且電腦需配備相應的硬體顯存與執行記憶體。
3. **資料隱私與備份**：所有書籍與閱讀記錄完全儲存在您本地裝置的 IndexedDB 沙盒中，絕無任何第三方中心伺服器收集您的隱私資料。換機或重裝前，**請隨時在書架右上角點選「匯出備份」產生 `.zip` 完整封存檔案**。

---

## 📄 開源許可

本專案採用 [ISC License](LICENSE) 授權合約開源發布。歡迎提交 Issue 與 Pull Request 共同共建！
