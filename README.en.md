# Edge E-Book Reader

Language: [简体中文](README.md) | [繁體中文](README.zh-TW.md) | **English**

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web%20%7C%20Android%20%7C%20iOS-blue)](javascript:;)
[![Version](https://img.shields.io/badge/version-3.4.14-orange)](javascript:;)
[![License](https://img.shields.io/badge/license-ISC-green)](LICENSE)

An immersive, high-performance, and deeply customizable cross-platform e-book reader crafted for modern web browsers and mobile devices. Engineered with a client-driven core and native bridge architecture, it integrates multi-format parsing, natural neural TTS powered by Microsoft Edge, on-device/cloud AI reading companions, dynamic mindmaps, and granular reading statistics.

The project offers 5 tailored distribution formats: **Browser Extension**, **Single-File Offline Reader**, **Online Web / PWA**, **Android Native App**, and **iOS Native App**, providing a seamless reading experience across desktop and mobile devices.

---

## 📱 Five Editions: Capabilities & Comparison

Choose the best form factor tailored to your workflow and device environment:

| Feature | 🧩 Browser Extension | 💾 Single-File Offline | 🌐 Online Web / PWA | 🤖 Android Native App | 🍎 iOS Native App |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Environment** | Chrome/Edge/Brave Desktop | Any modern browser | Web browser or PWA install | Android 8.0+ Phone/Tablet | iOS 13.0+ (iPhone/iPad) |
| **Installation** | Unpacked extension in Dev mode | Double-click single HTML file | Visit URL / Add to Home Screen | Install APK package | Install via Sideloadly |
| **Offline Reading** | Full offline support (TTS requires net) | Full offline support (TTS requires net)| Cached via Service Worker | Full offline support (TTS requires net) | Full offline support (TTS requires net) |
| **Multi-Format Parsing** | ✅ EPUB, AZW3, MOBI, TXT, CBZ | ✅ Full support | ✅ Full support | ✅ Full support | ✅ Full support |
| **Edge Neural TTS** | ✅ Direct via MV3 header modification | ✅ Direct via native WebSocket | ⚠️ Supported only in local Node mode; Public static hosts fall back to Web Speech | ✅ Native network stack | ✅ Native network stack |
| **Background / Lockscreen TTS** | ❌ Active tab only | ❌ Frozen by mobile OS | ⚠️ Relies on silent keep-alive | ✅ Dedicated foreground service | ✅ AVAudioSession playback |
| **Lockscreen Artwork & Controls**| ❌ Not supported | ❌ Not supported | ⚠️ Limited MediaSession support | ✅ Full MediaSession notification | ✅ Native MPNowPlaying integration |
| **AI Companion & Mindmap** | ✅ On-device Gemini Nano + Cloud | ✅ Supports custom Cloud/Ollama API | ✅ Full support | ✅ Recommended Cloud / Ollama | ✅ Recommended Cloud / Ollama |
| **Storage & Privacy** | Isolated extension IndexedDB | Origin/file-scoped IndexedDB | Domain IndexedDB (Exportable) | Native sandbox IndexedDB | Native sandbox IndexedDB |

---

### 1. 🧩 Browser Extension (Chrome / Edge MV3)
* **What it can do**:
  - Complete reading typography, book parsing, bookshelf management, and reading analytics.
  - Utilizes Manifest V3 `declarativeNetRequest` to rewrite headers on the fly, **bypassing Microsoft Edge cloud TTS CORS restrictions and Origin checks**, delivering natural human-like voice synthesis directly in the browser.
  - Supports Chrome/Edge on-device **Gemini Nano** AI model for offline translation, definitions, and chapter summarization.
* **What is missing / Limitations**:
  - Limited to Chromium desktop browsers (Chrome, Edge, Brave, etc.). Mobile browsers generally do not support MV3 extensions.
  - TTS playback terminates when the browser is closed.
* **How to install**:
  1. Download `Raconteur-Chrome-*.zip` from [Releases](https://github.com/newfur/newfur.github.io/releases) and extract it (or clone the source code).
  2. Open `chrome://extensions/` or `edge://extensions/` in your browser.
  3. Toggle **"Developer mode"** in the top-right corner.
  4. Click **"Load unpacked"** and select the extracted directory.

---

### 2. 💾 Single-File Offline Reader (HTML)
* **What it can do**:
  - **Zero dependencies, zero installation**: The entire reader is bundled into a single standalone `.html` file (~2.3MB). All JS engines, CSS themes, parsers (JSZip, etc.), mindmap renderers, and multilingual assets are inlined.
  - **Direct Edge Neural TTS Support**: When opened locally under the `file:///` protocol, the reader connects directly to Microsoft's official voice service via WebSocket (`wss://speech.platform.bing.com/...`) combined with dynamic `Sec-MS-GEC` authentication tokens. **It is completely free from standard HTTP CORS restrictions and plays high-quality Microsoft Edge neural voices smoothly**! Automatically falls back to system voices (Web Speech API) if completely offline.
  - Double-click to open in any modern browser on Windows, macOS, Linux, Android, or iOS.
  - All books, reading progress, and highlights are stored securely in the browser's local IndexedDB.
* **What is missing / Limitations**:
  - On mobile browsers, JavaScript execution is often suspended when entering the background or locking the screen; lacks native lock screen media controls.
* **How to install / use**:
  1. Download the latest `Raconteur-Offline-*.html` from [Releases](https://github.com/newfur/newfur.github.io/releases).
  2. Double-click to open in Chrome, Edge, Safari, or Firefox. Press `Ctrl+D` (or `Cmd+D`) to bookmark for instant future access.

---

### 3. 🌐 Online Web / PWA (Web Server & Progressive Web App)
* **What it can do**:
  - Instant access via any web URL across desktop and mobile devices.
  - **Full PWA Experience**: Installable as a standalone app with no browser address bar, seamless full-screen layout, and Service Worker offline caching.
  - Complete bookshelf, reader typography, notes/highlights, and AI features.
  - **Self-Hosted Local Node.js Mode** (`npm start`): Includes an integrated WebSocket `/api/tts` proxy that relays Edge TTS traffic without CORS limitations.
* **What is missing / Limitations**:
  - **Edge TTS is unavailable on public static hosting**: Static website hosting platforms (e.g. GitHub Pages, Vercel) have no backend server to run the `/api/tts` proxy. Furthermore, public HTTP/HTTPS web origins are restricted by browser cross-origin policies and cannot forge headers to connect directly to Microsoft servers. Consequently, **Edge TTS cannot play directly on public static web/PWA deployments** (it automatically falls back to browser default Web Speech synthesis).
  - To experience Edge voices on the web, we recommend: ① Using the **Single-File Offline Reader** locally; ② Installing the **Browser Extension**; or ③ Running the Node.js server locally (`npm start`).
* **How to install / use**:
  - **Online**: Visit the deployed URL.
  - **PWA Installation**: In desktop Chrome/Edge, click the "Install" icon in the address bar; on iOS Safari, tap "Share" -> **"Add to Home Screen"**.
  - **Self-Hosted Node Server (with full Edge TTS)**:
    ```bash
    git clone https://github.com/newfur/newfur.github.io.git
    cd newfur.github.io
    npm install
    npm start
    # Access http://localhost:3000
    ```

---

### 4. 🤖 Android Native App (APK)
* **What it can do**:
  - Lightweight Android application built with Ionic Capacitor (~15MB APK).
  - Native network stack connects directly to Microsoft Edge cloud service without browser CORS barriers.
  - **True Foreground Audio Service (`AudioPlayerService`)**: Runs a persistent foreground service with WakeLock/WifiLock, ensuring uninterrupted TTS playback when navigating apps, in background, or with screen locked.
  - **System Lockscreen & Notification Media Controls**: Full Android `MediaSession` integration. Lockscreen and notification center display **the current sentence, book title, author, and dynamically generated 512px compressed book cover**, with native Previous, Next, and Play/Pause controls.
  - **Native Back Button Interception**: Pressing the Android back button closes modals and dialogs first, and returns to the bookshelf from the reading view, preventing accidental app exit.
* **What is missing / Limitations**:
  - Sourced outside Google Play Store; requires enabling "Install unknown apps" permission on your device.
* **How to install**:
  1. Download `Raconteur-*.apk` from [Releases](https://github.com/newfur/newfur.github.io/releases).
  2. Open the APK on your Android device and confirm installation.

---

### 5. 🍎 iOS Native App (IPA)
* **What it can do**:
  - Built with Capacitor and Swift, weighing only **2.25MB** — extremely fast and lightweight.
  - Native network stack connects directly to Microsoft Edge TTS for pristine voice synthesis.
  - **Lockscreen Audio Controls & Background Playback**: Integrated with iOS `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` under `AVAudioSession (.playback)`. Lockscreen showcases **the active sentence text, book title, author, and dynamic 512px compressed book cover**, supporting lockscreen skipping and Dynamic Island status.
  - Fully adaptive to iPhone notch, Dynamic Island, and iPad layouts with safe-area handling.
* **What is missing / Limitations**:
  - Not available on the official App Store; requires sideloading tools.
* **How to install**:
  - **Recommended: Sideloadly**:
    1. Download and launch [Sideloadly](https://sideloadly.io/) on your PC or Mac;
    2. Download the latest `EdgeReader-*.ipa` from [Releases](https://github.com/newfur/newfur.github.io/releases);
    3. Drag and drop the `.ipa` into the Sideloadly window;
    4. Enter your Apple ID;
    5. Connect your iPhone / iPad via USB and click **Start** to sign and install;
    6. On your iOS device, go to **Settings** -> **General** -> **VPN & Device Management** and trust the Apple ID certificate before launching.
  - **Alternative Sideloading Tools**:
    - Compatible with AltStore, SideStore, and TrollStore;
    - Or build and install directly onto a connected device via Xcode on macOS.

---

## 🛠️ Architecture & Technical Design

The project employs a **pure client-side core engine + lightweight native bridge** architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Edge Reader System Architecture                       │
└─────────────────────────────────────────────────────────────────────────────┘

                  ┌─────────────────────────────────────────┐
                  │        UI Typography & Presentation     │
                  │   reader.html / reader.css / i18n.js    │
                  │(Paginated/Scrolling/Themes/Fonts/Select)│
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │          Core Reader Controller         │
                  │               reader.js                 │
                  └─────────┬──────────┬──────────┬─────────┘
                            │          │          │
   ┌────────────────────────┘          │          └─────────────────────────┐
   ▼                                   ▼                                    ▼
┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐
│   Multi-Format Parsers  │ │    TTS Speech Engine    │ │   AI Companion & RAG    │
│    parsers/ (Pure JS)   │ │          tts.js         │ │         ai.js           │
├─────────────────────────┤ ├─────────────────────────┤ ├─────────────────────────┤
│ • EPUB (EPUB 2/3 spec)  │ │ • Edge WebSocket Neural │ │ • Built-in Gemini Nano  │
│ • AZW3 / MOBI (Kindle)  │ │ • Dual-Player Buffering │ │ • Cloud API (OpenAI/Deep│
│ • TXT / Markdown (Splits│ │ • Smart sentence parser │ │ • Local Ollama/LM Studio│
│ • CBZ (Comic waterfall)│ │ • Global 512px cover opt│ │ • Async TF-IDF Indexing │
│ • FB2 (FictionBook)     │ │ • Seamless empty chapter│ │ • Mermaid Mindmap stream│
└─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │           Data Persistence Layer        │
                  │             library.js                  │
                  │   IndexedDB (Books, Progress, Notes)    │
                  │   Backup Engine (ZIP import/export)     │
                  └────────────────────┬────────────────────┘
                                       │
     ┌─────────────────────────────────┴─────────────────────────────────┐
     ▼                                                                   ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────────────┐
│        Web & Extension Runtime        │ │       Native Mobile Bridge (Capacitor)│
├───────────────────────────────────────┤ ├───────────────────────────────────────┤
│ • Chrome MV3 declarativeNetRequest    │ │ • NativeTTS Plugin                    │
│ • Service Worker (Offline PWA Cache)  │ │ • Android: AudioPlayerService         │
│ • Single-File Inline Compiler         │ │ • iOS: AVAudioSession + MPNowPlaying  │
│ • Node.js Dev & WS Proxy Server       │ │ • SafeArea & Back Button Handlers     │
└───────────────────────────────────────┘ └───────────────────────────────────────┘
```

### Key Subsystems & Workflows

1. **Global Compressed Cover Mechanism (`compressCoverImage`)**:
   - Original book covers frequently range from 3MB to 10MB in raw size. Passing high-resolution images repeatedly across JS bridges introduces IPC latency, memory pressure, and dropped lockscreen updates.
   - **Solution**: Upon opening a book, a Canvas pipeline proportionally scales down and compresses the cover into a compact 512×512 JPEG DataURL (~20KB–40KB). This compressed thumbnail is cached globally and shared instantly across Web MediaSession, Android MediaSession, and iOS MPNowPlayingInfoCenter without memory spikes.

2. **Seamless Cross-Chapter Audio Pipeline**:
   - Features double-buffered audio playback: while the current sentence finishes its trailing silence, the next sentence is pre-fetched and pre-warmed in the background player.
   - **Empty Chapter Skip**: When advancing to a chapter containing only illustrations or blank title pages, the TTS engine automatically recurses and pre-fetches the subsequent text chapter, preventing audio stalls.

3. **Dual Progress Tracking**:
   - Visual reading position and audio narration position are tracked independently yet synced. Opening a book restores the exact sentence position of the last TTS session, while tapping any sentence during visual reading starts playback from that exact point.

---

## 💻 Development & Build Scripts

```bash
# 1. Install dependencies
npm install

# 2. Launch local dev server with Edge TTS proxy (default: port 3000)
npm start

# 3. Compile standalone offline reader (outputs reader_offline.html & index.html)
npm run build:offline

# 4. Sync web assets to Android project
npm run build:mobile

# 5. Sync web assets to iOS project
npm run build:ios

# 6. Build iOS unsigned IPA (macOS + Xcode required)
npm run build:ipa

# 7. Bump patch version and recompile all target assets
npm run bump

# 8. Run unit & regression tests
npm test
```

---

## ⚠️ Notes & Limitations

1. **DRM Protected Books**: The parser is purely client-side and does not decrypt commercial DRM (Amazon Kindle DRM, Adobe DRM). Remove protection prior to importing.
2. **On-Device Gemini Nano**: Requires Chrome/Edge 128+ Dev/Canary with experimental Prompt API flags enabled and adequate system VRAM/RAM.
3. **Data Backup**: All data is stored locally in your browser/device's IndexedDB. Browsers may evict storage under extreme disk pressure. **Export regular `.zip` backups from the Bookshelf menu.**

---

## 📄 License

Open-sourced under the [ISC License](LICENSE). Contributions, issues, and pull requests are welcome!
