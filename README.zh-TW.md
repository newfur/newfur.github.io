# Edge 網頁版電子書閱讀器 (Edge E-Book Reader)

Language: [简体中文](README.md) | **繁體中文** | [English](README.en.md)

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web%20%7C%20Android-blue)](javascript:;)
[![License](https://img.shields.io/badge/license-ISC-green)](javascript:;)

一款專為網頁和行動端設計的現代、美觀、功能強大且高度客製化的電子書閱讀器。專案整合了多格式解析器、高品質 Microsoft Edge 雲端神經網路語音朗讀（TTS）、本地/雲端 AI 閱讀助手以及精美的閱讀統計分析。支援**瀏覽器擴充功能**、**本地 Web 服務 (PWA)**、**單檔案離線版**以及**Android 原生 App** 四種形態。

---

## 📖 專案簡介

本專案旨在打破電子書閱讀的平台限制，提供最頂級、最流暢的跨裝置閱讀與聆聽體驗。特別針對**微軟 Edge 神經網路語音**進行了技術突破，使您無需安裝複雜的用戶端，即可在任何主流 Chromium 瀏覽器及行動裝置上享受媲美真人的有聲書朗讀。

---

## ✨ 核心特性

1. **🗂️ 廣泛的電子書格式支援**：內置輕量級純 JS 解析引擎，支援 **EPUB**（章節目錄、圖文混排）、**AZW3 / MOBI**（Kindle 格式相容）、**TXT / MD**（智慧提取章節與段落）、**FB2**、**CBZ**（漫畫瀑布流/單頁）。
2. **🎨 極致的個性化排版系統**：支援「左右模擬翻頁」與「上下連續滾動」；內置霞鶩文楷、思源宋體、OpenDyslexic 等字型；預設明亮白、純黑 (OLED)、深雅灰等 8 種主題並支援紙張質感底紋疊加。
3. **🎙️ 高保真神經網路 TTS 朗讀**：直連微軟 Edge 神經網路雲端 TTS，支援數十種極具表現力的自然人聲；內置無縫雙播放器預載機制，消除切換卡頓；支援 iOS/Android 行動端背景/鎖定螢幕靜音保活播放；智慧斷句過濾角標。
4. **🤖 瀏覽器本地/雲端 AI 伴侶**：對接瀏覽器內置 **Gemini Nano** 介面（完全本地處理），同時支援配置 OpenAI、DeepSeek、Gemini API、SiliconFlow 及本地 Ollama、LM Studio。支援一鍵劃詞釋義、章節/段落摘要、離線翻譯。
5. **📊 深度閱讀數據統計**：總時長、閱讀天數統計；單本書日均閱讀明細；24小時閱讀時間段分佈；日曆熱力圖式足跡記錄。
6. **📁 書庫管理與安全備份**：支援書籍分類資料夾管理、批次移動/刪除；支援一鍵匯出包含書籍檔案、閱讀進度、高亮劃線、筆記和閱讀統計的加密壓縮備份包 (`.zip`)。
7. **📱 原生行動端支援**：基於 Ionic Capacitor 建構，支援打包為 Android 原生 App，適配高精圓形/自適應系統圖標。

---

## 🔄 版本歷史與更新

### 🚀 v3.1.x (當前最新)
* **高精圖標重構 (v3.1.8)**: 重新以 AI 高清繪製並裁剪替換了全套平台的極簡扁平化 App 圖標（無數字、超清晰向量風），並為 Android 原生殼工程適配了自適應背景色及圓形、前景層圖標。
* **TTS 朗讀進度保存優化 (v3.1.5)**: 解決了背景/鎖定螢幕狀態下因瀏覽器定時器暫停導致進度丟失的問題。新增了在暫停、隱藏（visibilitychange）及頁面關閉時的立即同步寫入機制；優化章節過渡邏輯，防止載入臨界點越界卡死。
* **高亮位置微調 (v3.1.4)**: 實現了朗讀高亮同步偏移微調與啟動效能優化。

### 📱 v3.0.0 (原生跨平台支援)
* **Android/iOS 雙端打包**: 引入 Capacitor 架構，支援將閱讀器無縫打包為原生移動端 App。
* **閱讀統計 Bug 修復**: 修復了備份還原時，同一天同一小時的閱讀時間重複累計的 Bug。

### 🤖 v2.x.x (AI 伴侶與 RAG 搜尋)
* **多服務商 AI 配置**: 支援自訂 OpenAI、DeepSeek、Gemini API、SiliconFlow 及本地 Ollama、LM Studio 實例。
* **精準 AI 上下文提取**: 支援全局、章節及可見視窗級頁面文字精準提取。
* **本地 RAG 搜尋索引**: 背景非同步建立全書 TF-IDF 索引，向 AI 提問時自動檢索最相關段落，防止幻覺。
* **Mermaid 互動思維導圖**: 支援 AI 自動生成思維導圖，並支援拖曳縮放、平移與持久化儲存。

---

## 🛠️ 架構設計

專案採用純前端驅動架構，資料統一儲存於瀏覽器本地的 **IndexedDB** 中。根據執行環境不同，設計了四種分發部署模式：

```
                               ┌────────────────────────┐
                               │    Core Application    │
                               │ (i18n, Parsers, Engine)│
                               └───────────┬────────────┘
                                           │
         ┌─────────────────────────┬───────┴─────────┬─────────────────────────┐
         ▼                         ▼                 ▼                         ▼
   ┌───────────┐             ┌───────────┐     ┌───────────┐             ┌───────────┐
   │ Extension │             │Web Server │     │Standalone │             │Android App│
   │ (MV3)     │             │(Node+PWA) │     │(SingleHTML│             │(Capacitor)│
   └─────┬─────┘             └─────┬─────┘     └─────┬─────┘             └─────┬─────┘
         │                         │                 │                         │
 declarativeNetRequest         WebSockets      IndexedDB+base64         Capacitor Plugins
 動態修改請求標頭繞過         Node服務代理     Data URL 繞過             原生介面與檔案系統
 Bing TTS CORS 限制            TTS 流量限制    本地 file:// 限制         本地化沙盒儲存
```

---

## 🚀 使用與建構方法

### 📦 方法 A：作為瀏覽器擴充功能安裝 (推薦)
1. 下載本專案原始碼。
2. 打開 Chrome 或 Edge 瀏覽器，進入 **「擴充功能」** 頁面 (`chrome://extensions/`)。
3. 開啟右上角的 **「開發者模式」**。
4. 點擊 **「載入未打包的擴充功能」**，選擇專案根目錄。

### 🌐 方法 B：本地 Node.js 網頁版執行
1. 安裝依賴並啟動本地伺服器：
   ```bash
   npm install
   npm start
   ```
2. 打開瀏覽器訪問：`http://localhost:3000`。

### 💾 方法 C：建構單檔案離線版/靜態部署
1. 執行打包指令碼：
   ```bash
   npm run build:offline
   ```
2. 打包完成後，會在根目錄生成 `reader_offline.html` 和 `index.html`（雙擊 `reader_offline.html` 即可離線使用）。
3. 靜態檔案 `index.html` 可以直接上傳到 Vercel、GitHub Pages 等託管。

### 📱 方法 D：建構 Android 原生 App
1. 確保安裝了 Android SDK 和 Gradle 環境。
2. 執行建構指令碼同步資產：
   ```bash
   npm run build:mobile
   ```
3. 使用 Android Studio 打開 `android/` 目錄進行編譯部署，或直接透過 Gradle 建構。

---

## ⚠️ 專案局限性

1. **DRM 版權限制**: 無法解析 DRM 加密保護的電子書（如 Amazon Kindle 保護格式、Adobe DRM），匯入前需先解密。
2. **本地 AI 硬體門檻**: 瀏覽器內置 Gemini Nano 需 Chrome/Edge 128+ 開發版並開啟對應 Flags，且裝置需有足夠記憶體/顯存執行模型。
3. **TTS 限制**: 純靜態無代理伺服器時直連微軟 WebSocket。若微軟修改校驗規則可能導致失效。完全離線時會自動降級為本地 Web Speech 朗讀。
4. **資料安全**: 資料儲存於瀏覽器 IndexedDB。清理快取或系統磁碟不足時可能會被瀏覽器回收，建議定期備份匯出 `.zip` 檔案。

---

## 📂 專案結構

```
Edge-Reader/
├── _locales/              # 國際化語言包 (支援中繁、中簡、英文)
├── android/               # Android 原生殼工程 (Capacitor)
├── icons/                 # 擴充功能及 PWA 圖標
├── reader/                # 閱讀器核心原始碼
│   ├── css/
│   ├── libs/              # 第三方依賴庫 (JSZip)
│   ├── parsers/           # 電子書格式解析器 (EPUB, AZW3, TXT, CBZ)
│   ├── ai.js              # 瀏覽器內置 Gemini Nano 與雲端/本地大模型介面對接
│   ├── i18n.js            # 多語言翻譯模組
│   ├── library.js         # 書庫管理邏輯 (書庫渲染、分類、匯入匯出)
│   ├── reader.css         # 閱讀器排版與主題樣式
│   ├── reader.html        # 主閱讀介面 DOM
│   ├── reader.js          # 閱讀核心控制器 (翻頁、滾動、事件監聽)
│   └── tts.js             # 微軟 TTS 神經網路朗讀引擎 (無縫雙緩衝、斷句)
├── scratch/               # 建構與補助腳本目錄
│   ├── build_dist.js      # 行動端/PWA 靜態資源編譯打包腳本
│   └── compile_offline.js # 離線單檔案打包腳本
├── www/                   # 編譯產生的 PWA/行動端靜態資源目錄
├── capacitor.config.json  # Capacitor 跨平台配置文件
├── manifest.json          # Chrome Extension Manifest V3 配置文件
├── manifest.webmanifest   # PWA 配置文件
├── sw.js                  # PWA Service Worker 快取腳本
├── service-worker.js      # 瀏覽器擴充功能背景腳本 (Origin 修改規則)
├── server.js              # 本地 Node.js 網頁開發及 TTS 代理伺服器
├── index.html             # 編譯產生的網頁版主頁 (同 reader_offline.html)
├── reader_offline.html    # 離線單檔案版 (雙擊即用)
├── vercel.json            # Vercel 靜態託管配置
└── README.md              # 專案說明文件 (繁體中文)
```

---

## 📄 開源協定

本專案採用 [ISC License](LICENSE) 許可協定開源。
