# Edge E-Book Reader

Language: [简体中文](README.md) | [繁體中文](README.zh-TW.md) | **English**

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web%20%7C%20Android-blue)](javascript:;)
[![License](https://img.shields.io/badge/license-ISC-green)](javascript:;)

A modern, beautiful, powerful, and highly customizable e-book reader designed specifically for web pages and mobile devices. The project integrates multi-format parsers, high-quality Microsoft Edge cloud neural TTS (Text-to-Speech), a local/cloud AI reading assistant, and exquisite reading statistics. It supports four deployment forms: **Browser Extension**, **Local Web Service (PWA)**, **Single-File Offline Version**, and **Android Native App**.

---

## 📖 Introduction

This project aims to break the platform limitations of e-book reading, providing a premium, smooth cross-device reading and listening experience. Special technical breakthroughs have been made for the **Microsoft Edge Neural Voice**, allowing you to enjoy audiobook reading comparable to human narration in any mainstream Chromium browser and mobile device without installing complex clients.

---

## ✨ Core Features

1. **🗂️ Wide E-Book Formats Support**: Built-in lightweight pure JS parsing engines supporting **EPUB** (chapters, custom style, image alignment), **AZW3 / MOBI** (Kindle compatibility), **TXT / MD** (smart chaptering & markdown structure), **FB2**, and **CBZ** (comics waterfall/single page).
2. **🎨 Personalization Typography**: Supports "simulate page turning" and "continuous scrolling"; built-in custom fonts (LXGW WenKai, Noto Serif, OpenDyslexic, etc.); 8 preset visual themes with paper texture overlays.
3. **🎙️ High-Fidelity Neural TTS**: Direct connection to Edge cloud TTS with natural voices; dual-player preloading buffering to eliminate gap latency; iOS/Android mobile background/screen-locked keep-alive playback; smart splitting and footnote filtering.
4. **🤖 Local/Cloud AI Assistant**: Seamlessly connects to browser built-in **Gemini Nano** API (100% local processing), as well as OpenAI, DeepSeek, Google Gemini API, SiliconFlow, and local Ollama/LM Studio. Supports one-click word translation/definition, chapter summary, and streaming offline translator.
5. **📊 Deep Reading Statistics**: Tracking of total reading time, days read, daily logs, hourly distribution charts, and a calendar heatmap.
6. **📁 Library Management & Backups**: Book category folder structure, batch moving/deletion; one-click export of a compressed backup zip (`.zip`) containing all books, progress, highlights, notes, and history logs.
7. **📱 Mobile Platform Support**: Built using Ionic Capacitor, supporting compiled native Android APK package with adaptive app system icons.

---

## 🔄 Version History & Logs

### 🚀 v3.2.x (Latest)
* **Android Native UX & Unified Versioning (v3.2.0)**:
  - Intercepted Android native back button (`onBackPressed` in MainActivity), allowing open panels/dialogs to close first, and returning to the bookshelf on back presses (instead of exiting the app immediately).
  - Unified version reading by loading version numbers dynamically from `manifest.json`, eliminating hardcoded strings.
  - Automatically navigates to the exact last read sentence on TTS playback when opening a book, rather than just scrolling visually.
  - Improved mobile drag-to-import overlay, preventing flickering under multi-touch inputs.

### 🎨 v3.1.x (High-Res Icons & TTS Saving)
* **High-Res App Icons (v3.1.8)**: Redesigned with AI and cropped high-resolution system icons for all platforms (no numbers, clean vector aesthetics). Added native round and adaptive foreground/background icon layers for Android.
* **TTS Progress Saving (v3.1.5)**: Fixed progress saving issue in background/lock screen due to browser timer throttle. Implemented immediate database sync on pause, visibility change (background), and window closing. Corrected chapter overflow edge cases.
* **Tuning Highlights (v3.1.4)**: Sync offset fine-tuning and startup performance optimizations.

### 📱 v3.0.0 (Native Mobile Support)
* **Android Native Wrapper**: Introduced Capacitor wrapper, enabling seamless compilation into a native Android App.
* **Statistics Bug Fix**: Solved the issue where restoring a backup duplicate-counted reading time on overlapping hours/days.

### 🤖 v2.x.x (AI Assistant & RAG Search)
* **Custom AI Providers**: Configurable profiles for OpenAI, DeepSeek, Gemini, SiliconFlow, Ollama, and LM Studio.
* **Precision Context Extraction**: Precise context isolation at Global, Chapter, and visible Page level.
* **Client-Side RAG Search Index**: Asynchronous TF-IDF indexing of imported books to inject relevant context snippets to AI prompts, reducing hallucinations.
* **Mermaid Mindmaps**: Streamed generation of SVG mindmaps with pan, zoom, fit actions and database persistence.

---

## 🛠️ Architecture Design

The project uses a pure client-driven architecture, saving all user data inside the browser's local **IndexedDB**. Depending on the environment, four distribution modes are implemented:

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
 Modify request headers        Node server proxy Data URL bypasses       Native API / Filesystem
 to bypass Bing CORS           TTS traffic       local file:// limits    Sandbox Local Storage
```

---

## 🚀 How to Run & Build

### 📦 Method A: Install as a Browser Extension (Recommended)
1. Download this repository.
2. Open Chrome or Edge and navigate to **Extensions** (`chrome://extensions/`).
3. Toggle on **Developer Mode** (top-right).
4. Click **Load unpacked** and select the root directory of the project.

### 🌐 Method B: Local Node.js Web Server
1. Install dependencies and start the developer server:
    ```bash
    npm ci
    npm start
    ```
2. Open your browser to `http://localhost:3000`.

### 💾 Method C: Build Standalone Offline HTML
1. Run the compilation script:
   ```bash
   npm run build:offline
   ```
2. Two files will be output to the root directory: `reader_offline.html` and `index.html` (double-click `reader_offline.html` to run offline immediately).
3. `index.html` can be uploaded directly to static hosting sites (Vercel, GitHub Pages, etc.).

### 📱 Method D: Build Android Native App
1. Ensure Android SDK and Gradle are installed.
2. Build mobile assets and sync:
   ```bash
   npm run build:mobile
   ```
3. Open the `android/` directory in Android Studio to build the APK, or run gradle assembly tasks.

---

## ⚠️ Limitations & Disclaimers

1. **DRM Encryption**: Cannot parse DRM-encrypted files (such as Adobe DRM or protected Kindle files). Books must be decrypted before import.
2. **Local AI Hardware Requirements**: Built-in Gemini Nano requires Chrome/Edge 128+ Dev/Canary with correct flags enabled. Sufficient memory and GPU are required to run the local model.
3. **TTS Server Availability**: Direct connection to Bing TTS endpoints requires active internet connection. If Microsoft changes its authentication protocol, direct connections might temporarily fail until updated. If fully offline, the engine falls back to standard Web Speech API.
4. **IndexedDB Storage Security**: Data is saved locally in IndexedDB. Clearing browser data or running out of disk space might cause the browser to reclaim space. Regular backups are strongly recommended.

---

## 📂 Project Structure

```
Edge-Reader/
├── _locales/              # i18n language bundles (EN, ZH-TW, ZH-CN)
├── android/               # Android native project (Capacitor)
├── icons/                 # Extension & PWA icons
├── reader/                # Core reader source code
│   ├── css/
│   ├── libs/              # Third-party dependency (JSZip)
│   ├── parsers/           # Book parsers (EPUB, AZW3, TXT, CBZ)
│   ├── ai.js              # Prompt API & Custom LLM wrapper
│   ├── i18n.js            # Translator modules
│   ├── library.js         # Library layout & IndexedDB interactions
│   ├── reader.css         # Visual styles and themes
│   ├── reader.html        # Main reader viewport DOM
│   ├── reader.js          # Navigation, settings, and event loops
│   └── tts.js             # High-quality Edge TTS wrapper
├── scratch/               # Developer script utility directory
│   ├── build_dist.js      # Web asset bundler script for mobile/PWA
│   └── compile_offline.js # Single-file offline bundler script
├── www/                   # Compiled PWA/mobile web assets output directory
├── capacitor.config.json  # Capacitor configuration
├── manifest.json          # Chrome Extension V3 manifest config
├── manifest.webmanifest   # PWA manifest
├── sw.js                  # PWA service worker caching
├── service-worker.js      # Extension background script (Origin headers modifier)
├── server.js              # Local Node.js server and API proxy
├── index.html             # Built web reader page (identical to reader_offline.html)
├── reader_offline.html    # Standalone offline page (double-click to use)
├── vercel.json            # Vercel static routing config
└── README.md              # Project documentation
```

---

## 📄 License

This project is open-source and licensed under the [ISC License](LICENSE).
