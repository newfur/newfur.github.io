# Edge E-Book Reader

Language: [简体中文](README.md) | [繁體中文](README.zh-TW.md) | **English**

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web-blue)](javascript:;)
[![License](https://img.shields.io/badge/license-ISC-green)](javascript:;)

A modern, beautiful, powerful, and highly customizable e-book reader designed specifically for web pages and browsers. The project integrates multi-format parsers, high-quality Microsoft Edge cloud neural TTS (Text-to-Speech) reading, a local AI reading assistant, and exquisite reading statistics. It supports three deployment forms: **Browser Extension**, **Local Web Service (PWA)**, and **Single-File Offline Version**.

---

## 📖 Introduction

This project aims to break the platform limitations of e-book reading, providing a premium, smooth cross-device reading and listening experience. Special deep adaptation and technical breakthroughs have been made for the **Microsoft Edge Neural Voice**, allowing you to enjoy audiobook reading comparable to human narration in any mainstream Chromium browser without installing complex clients.

---

## ✨ Core Features

### 1. 🗂️ Wide Range of E-Book Formats
Built-in lightweight pure JS parsing engines support local parsing and rendering of various mainstream e-book and document formats:
*   **EPUB**: Full support for chapter directories, style rendering, mixed text/image layout, and multi-level jumps.
*   **AZW3 / MOBI**: Compatible with Kindle formats, supporting parsed embedded styles and images.
*   **TXT / MD (Markdown)**: Intelligently extracts chapter titles and paragraphs to automatically build directory trees.
*   **FB2**: Fully supports novel paragraphing and typesetting.
*   **CBZ (Comic)**: Supports image-packaged comics in waterfall flow or single-page reading modes.

### 2. 🎨 Ultimate Personalized Typography System
*   **Layout Modes**: Supports **"simulate page turning"** (double-page paginated layout) and **"continuous scrolling"** modes.
*   **Font Support**: Built-in LXGW WenKai, Noto Serif, OpenDyslexic (accessibility font), Fira Code (monospace for code), Inter (sans-serif), etc., supporting adjustments for size, line height, and letter spacing.
*   **Visual Themes**: 8 preset themes including Light White, Deep Elegant Gray, Retro Paper, Minimalist Green, Pure Black (OLED), Cherry Blossom Pink, Ocean Blue, and Slate Gray.
*   **Paper Textures**: Supports overlaying physical background textures like Classic Paper, Parchment, Linen, Aged Paper, and Washi.

### 3. 🎙️ High-Fidelity Neural TTS Reading
*   **Edge Official Voice Quality**: Connects directly to Microsoft Edge Neural Cloud TTS, supporting dozens of highly expressive natural voices such as Xiaoxiao, Yunxi, and Yunjian.
*   **Dual-Player Buffer Mechanism**: Maintains two `Audio` playback objects internally, alternating preloading and decoding to completely eliminate pauses and blank delays between sentence transitions.
*   **Anti-Background Suspension**: Specially designed silent keep-alive and audio keep-alive track configurations for iOS / Android mobile background running, supporting screen-locked/background continuous reading.
*   **Smart Sentence Splitting**: Built-in sentence splitter intelligently recognizes decimal points (e.g., 3.14) and English abbreviations (e.g., Mr., J. F.) to prevent sentences from being crudely truncated, while automatically filtering superscripts and footnote symbols.

### 4. 🤖 Local AI Reading Companion
*   **No-Key Local AI**: Connects to the browser's experimental **Prompt API (Gemini Nano)** for completely local data processing.
*   **Three Core AI Capabilities**: Supports **one-click word definition**, **selected paragraph/chapter summarization**, and **streamed offline translation**.
*   **Custom AI & Local LLM**: Supports cloud APIs (OpenAI, DeepSeek) and locally deployed services (Ollama, LM Studio).

### 5. 📊 In-Depth Reading Statistics
*   **Global Overview**: Statistics on total reading time, days read, and cumulative books read.
*   **Single Book Analysis**: Shows reading details and daily average reading duration for a single book.
*   **Time Period Distribution**: Visualizes 24-hour reading distribution to gain insights into your reading habits.
*   **Daily Details**: Calendar heatmap tracks daily reading time, recording your reading footprint.

### 6. 📁 Library Management & Backup
*   **Category Management**: Supports creating folders, renaming, batch moving, and batch deleting books.
*   **Full Backup & Restore**: One-click export of a compressed/encrypted backup package (`.zip`) containing **all book files, reading progress, highlights, notes, and reading statistics**.

---

## 🔄 Recent Updates & Optimizations (v2.0.2)

*   **Mobile Selection Menu AI Buttons Stacking & Labels**:
    - Restructured the text selection popup HTML, grouping highlight styles, delete, note, and speak actions in a top row (icon-only to prevent squeeze).
    - Wrapped the 4 AI actions (Summary, Explain, Translate, Ask) in a dedicated bottom row, enabling visible text labels on mobile screens with compact icons and paddings.
*   **Fixed Desktop AI Buttons Visibility**:
    - Ensured that both the main AI assistant header button and selection popover AI query buttons (Summary, Explain, Translate, Ask) remain permanently visible on desktop/standard browsers that do not natively support built-in AI (Gemini Nano), allowing users to use third-party custom providers.
    - Added localized setup guidance/error prompts when using the default built-in AI in unsupported environments to guide users on selecting a custom provider (e.g. DeepSeek, OpenAI, Ollama).
*   **Multi-Profile AI Configuration Support**:
    - Support for saving multiple AI provider profiles, pre-populated with popular presets: OpenAI (Official), DeepSeek, Google Gemini API, SiliconFlow (DeepSeek), Ollama (Local), and LM Studio.
    - Custom profiles can be created, deleted, and renamed.
    - Legacy configurations automatically migrate to a custom profile named "Migrated Profile" to prevent credentials loss.
    - Fixed empty profile name saves and placeholder updates.
*   **Sidebar Styles & Font Hierarchy Optimization**:
    - Forces sidebar buttons and section headers (Add Bookmark, Bookmarks, Notes & Highlights) to use stable system UI fonts to prevent book-internal CSS from polluting UI elements.
    - Scaled sidebar typography (tabs 18px, buttons/headers 16px) to establish a clean visual hierarchy.
*   **Desktop Layout Shift & Resizable Panel**:
    - Adds smooth sidebar and AI panel desktop layout offsets to center book content in the remaining viewport.
    - Supports draggable resizing of the AI panel with boundary constraints and width persistence.
*   **Client-Side Book-Wide RAG Search Index**:
    - Asynchronously builds a TF-IDF text search index of the entire book, providing relevant factual paragraphs to the AI prompt to prevent hallucinations.
*   **Keyboard Navigation Focus Correction**:
    - Bypasses page-turning shortcut handlers when pressing arrow keys or spacebar inside text input fields (`INPUT`, `TEXTAREA`, or `contenteditable` regions), fixing the bug where typing or moving the text cursor triggered page transitions.

---

## 🔄 Historical Updates (v1.2.2)

*   **Typesetting and Rendering Optimizations**:
    - Standardized and regulated left/right margins across different formats (e.g., EPUB/AZW3) to resolve styling conflicts in certain books.
    - Fixed page overflow for long chapter headings in multi-column paginated layouts.
    - Resolved header vertical offset and clipping issues caused by book-specific CSS polluting `h2` elements.
*   **Build & Repository Cleanups**:
    - Configured Git rules to exclude temporary scripts, test files, and built zip bundles.

---

## 🛠️ Architecture Design

The project uses a pure client-driven architecture, saving all user data inside the browser's local **IndexedDB**. Depending on the environment, three distribution modes are implemented:

```
                              ┌────────────────────────┐
                              │    Core Application    │
                              │ (i18n, Parsers, Engine)│
                              └───────────┬────────────┘
                                          │
                  ┌───────────────────────┼───────────────────────┐
                  ▼                       ▼                       ▼
       ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
       │   Extension Mode    │ │   Web Server Mode   │ │  Standalone Offline  │
       │ (Chrome/Edge MV3)   │ │ (Node.js + PWA App) │ │    (Single HTML)    │
       └──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘
                  │                       │                       │
         declarativeNetRequest        WebSockets API         IndexedDB + base64
         Dynamically modifies         Proxies TTS traffic     Data URL bypasses Chrome
         request headers to bypass    via Node.js server      local file:// security
         Bing TTS CORS policies       to resolve CORS         restrictions
```

### 1. Extension Mode (Chrome/Edge MV3)
*   **Mechanism**: Adheres to the Chrome Extension Manifest V3 standard.
*   **Key Advantage**: Leverages `chrome.declarativeNetRequest` to dynamically modify HTTP request headers, rewriting the connection Origin to the official Edge extension ID (`chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`) to bypass CORS and authenticate with Edge Neural TTS.
*   **Service Worker**: `service-worker.js` handles remote API proxying and chunk stream forwarding.

### 2. Web Server Mode (Node.js + PWA)
*   **Mechanism**: Runs a lightweight Node.js server using `server.js`.
*   **Proxy Endpoint**: For standard browsers that do not support extensions, the server exposes `/api/voices` and a WebSocket proxy at `/api/tts` to relay speech traffic, bypassing CORS restrictions.
*   **PWA Cache**: Incorporates `sw.js` and `manifest.webmanifest` to enable offline assets caching, allowing instant load times even without an active internet connection.

### 3. Standalone Offline Mode (Single HTML)
*   **Mechanism**: Compiles the entire application into a single, zero-dependency HTML file `reader_offline.html`.
*   **Bundler**: The script `scratch/compile_offline.js` reads CSS, JS, libs (JSZip), and locale JSON files and injects them inline into `<script>` and `<style>` tags.
*   **Chrome local file:// workaround**: Running in `file://` protocol normally triggers `ERR_REQUEST_RANGE_NOT_SATISFIABLE` in Chrome when playing audio blobs consecutively. The engine automatically converts audio blobs into Base64 Data URLs, solving offline reading issues.

---

## 🚀 How to Run & Build

### 📦 Method A: Install as a Browser Extension (Recommended)
1. Download this repository.
2. Open Chrome or Edge and navigate to **Extensions** (`chrome://extensions/` or `edge://extensions/`).
3. Toggle on **Developer Mode** (top-right).
4. Click **Load unpacked** and select the root directory of the project.
5. Click the extension icon in the toolbar to open the reader.

### 🌐 Method B: Local Node.js Server
1. Ensure Node.js is installed.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   npm start
   ```
4. Access `http://localhost:3000` in your browser.

### 💾 Method C: Build Offline Single-File HTML
1. Run the compilation script:
   ```bash
   npm run build:offline
   ```
2. Two files will be output to the root directory: `reader_offline.html` and `index.html`.
3. Double-click `reader_offline.html` to run locally and offline. You can drag and drop e-books directly onto the bookshelf.
4. Upload `index.html` directly to static hosting sites (GitHub Pages, Vercel, Cloudflare Pages).

---

## ⚠️ Limitations & Disclaimers

1.  **DRM Encryption**: Cannot parse DRM-encrypted files (such as Adobe DRM or protected Kindle files). Books must be decrypted before import.
2.  **Local Gemini Nano Hardware Requirements**:
    *   Requires Chrome/Edge 128+ Dev/Canary or enabled flags.
    *   Enable `#optimization-guide-on-device-model` and `#prompt-api-for-gemini-nano` in `chrome://flags`.
    *   Your device must have sufficient memory/GPU resources to download and run the model (~1.5GB - 3GB).
3.  **TTS Server Availability**: Direct connection to Bing TTS endpoints requires active internet connection. If Microsoft changes its authentication protocol, direct connections might temporarily fail until updated. If fully offline, the engine falls back to standard Web Speech API.
4.  **IndexedDB Storage Caps**: All books are saved locally. Clearing browser data or running out of disk space might cause the browser to reclaim space, wiping the database. **Regularly back up your library using the export feature**.
5.  **Mobile Background Suspension**: Despite keep-alive strategies, iOS and some aggressive Android battery savers might suspend the background browser tab. Keeping the screen slightly dimmed or using a wrapper app helps mitigate this.

---

## 📂 Project Structure

```
mysterious-oppenheimer/
├── _locales/              # Localized string dictionaries (EN, ZH-TW, ZH-CN)
├── icons/                 # Extension & PWA icons
├── reader/                # Core reader assets
│   ├── css/
│   ├── libs/              # Third-party dependency (JSZip)
│   ├── parsers/           # Book parsers (EPUB, AZW3, TXT, CBZ)
│   ├── ai.js              # Built-in Prompt API & Custom LLM wrapper
│   ├── i18n.js            # Translator modules
│   ├── library.js         # Library layout & IndexedDB interactions
│   ├── reader.css         # Visual styles and themes
│   ├── reader.html        # Main reader viewport DOM
│   ├── reader.js          # Navigation, settings, and event loops
│   └── tts.js             # High-quality Edge TTS wrapper
├── scratch/               # Local developer scripts
│   └── compile_offline.js # Single-file bundler script
├── manifest.json          # Chrome Extension V3 manifest config
├── manifest.webmanifest   # PWA manifest
├── sw.js                  # PWA service worker caching
├── service-worker.js      # Extension background script (Origin headers modifier)
├── server.js              # Local Node.js server and API proxy
├── index.html             # Built web reader page (identcal to reader_offline.html)
├── vercel.json            # Vercel static routing config
└── README.md              # Project documentation (Simplified Chinese)
```

---

## 📄 License

This project is open-source and licensed under the [ISC License](LICENSE).
