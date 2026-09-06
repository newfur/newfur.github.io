# Edge E-Book Reader

Language: [简体中文](README.md) | [繁體中文](README.zh-TW.md) | **English**

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web%20%7C%20Android%20%7C%20iOS-blue)](javascript:;)
[![Version](https://img.shields.io/badge/version-3.4.65-orange)](https://github.com/newfur/newfur.github.io/releases/tag/v3.4.65)
[![Build & Deploy](https://github.com/newfur/newfur.github.io/actions/workflows/build-deploy.yml/badge.svg)](https://github.com/newfur/newfur.github.io/actions)
[![License](https://img.shields.io/badge/license-ISC-green)](LICENSE)

An immersive, high-performance, and deeply customizable cross-platform e-book reader engineered for modern desktop browsers and mobile devices (iOS / Android). Built upon a **client-driven decoupled architecture with a lightweight native bridge**, it seamlessly integrates multi-format parsing, Microsoft Edge neural natural voice text-to-speech (TTS), an adaptive dual-route audio playback engine, on-device/cloud AI companions, client-side asynchronous RAG search, and lockscreen media center controls.

The project is distributed in **5 form factors**: **Browser Extension**, **Single-File Offline Reader**, **Online Web / PWA**, **Android Native App**, and **iOS Native App**, delivering a fluid, uninterrupted reading and listening experience across desktops, smartphones, and tablets.

---

## 🌟 Highlights of the Multi-Platform Refactor (v3.4.6x)

To conquer the challenges of mobile background audio freezing, sentence-to-sentence latency, and device storage inflation, the core architecture underwent major optimizations:

### 1. 🎧 Adaptive Dual-Engine TTS Architecture
- **Route A (Standard Web DOM Audio Engine)**: Tailored for desktop browser extensions, single-file offline builds, and Web browsers. Driven by standard HTML5 Audio APIs and in-memory Blob URLs for maximum agility and zero dependencies.
- **Route B (Native Twin-Player Hardware Buffering Engine)**:
  - **0ms Gapless Sentence Switching**: Mobile WebViews are often throttled or suspended in background/lockscreen states, causing pauses between sentences. On iOS (`AVAudioPlayer`) and Android (`MediaPlayer`), native twin-player hardware channels operate in a **ping-pong buffering cycle**. While sentence A is playing, sentence B is already synthesized and pre-warmed in the physical hardware buffer (`prepareToPlay`). At the exact millisecond sentence A finishes, playback switches seamlessly with zero delay.
  - **Main-Thread RunLoop Dispatching**: On iOS, player instantiation, delegate registration, and event callbacks are strictly bound to `RunLoop.main`, eliminating delegate callback drops previously caused by background GCD worker threads.
  - **Hardware Watchdog Fallback Timer**: The native layer features an authoritative watchdog timer calculated from sentence duration. In edge cases (incoming phone calls, rapid Bluetooth disconnections, audio focus preemptions), the watchdog autonomously detects audio hardware state and recovers playback progression, **guaranteeing that continuous reading never freezes**.

### 2. 🗄️ Decoupled High-Performance Storage Engine
- **Elimination of Storage Bloat**: Previous versions suffered from nested serialization where entire book texts were redundantly embedded into user settings or progress checkpoints, causing local storage to balloon into tens of gigabytes over time. The refactored storage strictly decouples book bodies, indices, and reading bookmarks into separate IndexedDB stores.
- **Predictable Storage Health**: Even when importing hundreds of large illustrated e-books, the app storage footprint remains lean and steady in the tens of megabytes range.

### 3. 🖼️ Dynamic 512px Cover Image Downsampling (`compressCoverImage`)
- High-resolution e-book covers often span 3MB~10MB. Transmitting raw bitmaps across the JavaScript-to-Native bridge can congest IPC channels or trigger OOM crashes.
- Covers are dynamically downsampled via Canvas to crisp 512×512 JPEG images (only 20KB~40KB). Artwork renders instantly on mobile lockscreens and notifications while slashing RAM overhead.

### 4. 🧠 Client-Side Asynchronous RAG & Instant Full-Text Search
- Engineered with a zero-dependency in-memory inverted index and TF-IDF search algorithm. The entire book is indexed asynchronously within milliseconds after opening, feeding relevant context to on-device models (Gemini Nano) and cloud APIs (OpenAI, DeepSeek, Claude, Ollama) for character relationship mapping and dynamic Mermaid mindmap generation.

---

## 📱 Five Editions: Capabilities & Comparison

| Feature Dimension | 🧩 Browser Extension | 💾 Single-File Offline | 🌐 Online Web / PWA | 🤖 Android Native App | 🍎 iOS Native App |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Target Platform** | Chrome/Edge/Brave Desktop | Any modern browser | Web browser or PWA install | Android 8.0+ Phone/Tablet | iOS 13.0+ (iPhone/iPad) |
| **Package Size** | ~2.4 MB (ZIP) | ~2.3 MB (Single HTML) | 0 Bytes (Instant web load) | ~16 MB (APK) | Only **2.25 MB** (IPA) |
| **Installation** | Load unpacked in Dev mode | Double-click local file | Visit URL / Add to Home Screen | Install APK file | Install via Sideloadly / TrollStore |
| **Network Requirements**| Full offline (TTS needs net) | Full offline (TTS needs net) | Service Worker offline cache | Full offline (TTS needs net) | Full offline (TTS needs net) |
| **Format Parsing** | ✅ EPUB, AZW3, MOBI, TXT, CBZ | ✅ Full support | ✅ Full support | ✅ Full support | ✅ Full support |
| **Edge Neural TTS** | ✅ Full support (MV3 header rewrite) | ✅ Direct official WebSocket | ⚠️ Supported via local Node; static falls back | ✅ Native bypass | ✅ Native bypass |
| **TTS Architecture** | Route A (DOM Audio) | Route A (DOM Audio) | Route A (DOM Audio) | **Route B (Hardware Twin-Player)** | **Route B (Hardware Twin-Player)** |
| **0ms Gapless & Watchdog**| Browser event driven | Browser event driven | Browser event driven | ✅ Hardware twin-player buffering | ✅ Hardware twin-player + Watchdog |
| **Background / Lockscreen**| ❌ Active tab only | ❌ Frozen by mobile OS | ⚠️ Relies on silent keep-alive | ✅ Foreground Service with WakeLock | ✅ AVAudioSession playback |
| **Lockscreen Media Controls**| ❌ Not supported | ❌ Not supported | ⚠️ Limited MediaSession support | ✅ Full MediaSession controls | ✅ Native MPNowPlaying integration |
| **AI Companion & Mindmap**| ✅ On-device Gemini Nano + Cloud | ✅ Supports custom Cloud/Ollama API| ✅ Full support | ✅ Recommended Cloud / Ollama | ✅ Recommended Cloud / Ollama |
| **Storage & Privacy** | Isolated extension IndexedDB | File-origin IndexedDB | Domain IndexedDB | Sandboxed, supports ZIP backup | Sandboxed, supports ZIP backup |

---

### 1. 🧩 Browser Extension (Chrome / Edge MV3)
* **Key Advantages**:
  - Leverages Manifest V3 `declarativeNetRequest` to dynamically alter request headers on the fly, **bypassing Microsoft Edge cloud TTS CORS restrictions and Origin checks** to stream dozens of lifelike neural human voices.
  - Native integration with Chrome 128+ built-in **Gemini Nano** on-device AI model for offline translation, vocabulary lookups, and chapter summarization with zero network latency.
* **Limitations**:
  - Restricted to Chromium desktop browsers; playback ceases when the browser is closed.
* **Installation**:
  1. Download `Raconteur-Chrome-*.zip` from [Releases](https://github.com/newfur/newfur.github.io/releases) and extract it.
  2. Navigate to `chrome://extensions/` or `edge://extensions/`.
  3. Enable **"Developer mode"** in the upper-right corner.
  4. Click **"Load unpacked"** and select the extracted folder.

---

### 2. 💾 Single-File Offline Reader (Single HTML)
* **Key Advantages**:
  - **Zero-Dependency Single File**: All JavaScript logic, CSS themes, book parsers (JSZip, etc.), fonts, and multi-language localizations are bundled into a single `.html` file (~2.3MB).
  - **Direct Edge TTS Connection**: When opened locally via the `file:///` protocol, the reader connects directly to Microsoft's official WebSocket (`wss://speech.platform.bing.com/...`) using dynamic `Sec-MS-GEC` authentication tokens. **It is unaffected by standard HTTP CORS barriers and delivers authentic neural speech out of the box**!
  - No server or runtime needed. Runs effortlessly on Windows, macOS, Linux, and mobile browsers.
* **Limitations**:
  - Background audio on mobile browsers is subject to operating system tab suspension; lacks native lockscreen media controls.
* **Installation & Usage**:
  1. Download the latest `Raconteur-Offline-*.html` from [Releases](https://github.com/newfur/newfur.github.io/releases).
  2. Double-click to launch in any modern browser. Press `Ctrl+D` (or `Cmd+D`) to bookmark for future reading.

---

### 3. 🌐 Online Web / PWA Edition (Web Server & PWA)
* **Key Advantages**:
  - Access anywhere with multi-device synchronization support.
  - Installable as a Progressive Web App (PWA) on desktop or mobile home screens for an address-bar-free, fullscreen app experience.
  - Local Node.js server mode (`npm start`) includes a dedicated `/api/tts` proxy for full Edge neural voice support.
* **Limitations**:
  - In public static hosting environments (such as GitHub Pages or Vercel), browser CORS prevents direct connections to Microsoft's Edge servers without a backend proxy. TTS automatically falls back to system Web Speech synthesis. For neural voices, use the extension, offline HTML, or native apps.
* **Installation & Usage**:
  - **Web Access**: Visit the deployed URL. On iOS Safari, tap "Share" -> **"Add to Home Screen"**.
  - **Self-Hosted Node Server**:
    ```bash
    git clone https://github.com/newfur/newfur.github.io.git
    cd newfur.github.io
    npm install
    npm start
    # Visit http://localhost:3000
    ```

---

### 4. 🤖 Android Native App (Android APK)
* **Key Advantages**:
  - **Foreground Service with WakeLock (`AudioPlayerService`)**: Background audio playback runs as a prioritized Android Foreground Service backed by a CPU `PARTIAL_WAKE_LOCK`. Listen for hours with the screen turned off without process termination.
  - **Route B Native Twin-Player**: Dual `MediaPlayer` instances alternate hardware buffers for gapless 0ms sentence switching.
  - **Full Lockscreen & Notification Controls**: Deep integration with Android `MediaSession`. Displays the current reading sentence, book title, author, and dynamic 512px cover artwork with responsive media action buttons.
  - **Physical Back Button Handling**: Intercepts device navigation to dismiss overlays and dialogs before returning to the bookshelf.
* **Installation**:
  1. Download the latest `Raconteur-*.apk` from [Releases](https://github.com/newfur/newfur.github.io/releases).
  2. Transfer to your Android device and tap to install (allow unknown sources if prompted).

---

### 5. 🍎 iOS Native App (iOS IPA)
* **Key Advantages**:
  - **Featherweight**: Built with Capacitor and native Swift, with an IPA package footprint of just **2.25MB**!
  - **Route B Native Twin-Player Engine**: Twin `AVAudioPlayer` hardware channels cycle in a ping-pong buffer on `RunLoop.main`, delivering 0ms gapless switching and avoiding WebKit process lockscreen freezes.
  - **Hardware Watchdog Fallback Timer**: Prevents playback stalls during interruptions like phone calls or audio session route changes with automatic state verification and resumption.
  - **Lockscreen, Control Center & Dynamic Island Integration**: Connected to `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` with `AVAudioSession (.playback)` mode. Lockscreen shows artwork, sentence text, chapter progress, and supports remote headset commands.
  - **Edge-to-Edge Display**: Natively adapts to notch and Dynamic Island safe area insets.
* **Installation**:
  - **Recommended via Sideloadly**:
    1. Download and install [Sideloadly](https://sideloadly.io/) on your PC or Mac;
    2. Download the latest `EdgeReader-*.ipa` from [Releases](https://github.com/newfur/newfur.github.io/releases);
    3. Drag the `.ipa` file into Sideloadly and enter your Apple ID;
    4. Connect your iPhone / iPad via USB and click **Start** to sign and install;
    5. On your device, go to "Settings" -> "General" -> "VPN & Device Management" and trust the developer certificate.
  - Also compatible with AltStore, SideStore, TrollStore, or local Xcode builds.

---

## 🛠️ System Architecture

The application adopts a clean, layered architecture separating core reading logic from native platform capabilities:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Edge Reader Cross-Platform Architecture                │
└─────────────────────────────────────────────────────────────────────────────┘

                  ┌─────────────────────────────────────────┐
                  │          UI & Typography Layer          │
                  │   reader.html / reader.css / i18n.js    │
                  │  (Pagination / Scrolling / Themes / FX) │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │          Core Reader Controller         │
                  │                 reader.js               │
                  └─────────┬──────────┬──────────┬─────────┘
                            │          │          │
    ┌───────────────────────┘          │          └─────────────────────────┐
    ▼                                  ▼                                    ▼
┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐
│   Multi-Format Parsers  │ │  Adaptive Dual-Route TTS│ │  AI Companion & RAG     │
│   parsers/ (Vanilla JS) │ │          tts.js         │ │         ai.js           │
├─────────────────────────┤ ├─────────────────────────┤ ├─────────────────────────┤
│ • EPUB (EPUB 2/3 spec)  │ │ 【Route A - Web DOM】   │ │ • On-Device Gemini Nano │
│ • AZW3 / MOBI (Kindle)  │ │   HTML5 Audio (Web/Ext) │ │ • Cloud APIs (OpenAI)   │
│ • TXT (Chapter regex)   │ │ 【Route B - Native Twin】│ │ • Local LLMs (Ollama)  │
│ • CBZ (Comic waterfall) │ │   0ms Gapless Buffer    │ │ • Client-Side RAG Index │
│ • FB2 (FictionBook)     │ │   Hardware Watchdog     │ │ • Mermaid Mindmaps      │
└─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │   Decoupled Storage & Persistence Layer │
                  │                 library.js              │
                  │  IndexedDB (Decoupled entity tables)    │
                  │  512px Dynamic Canvas Cover Broadcast   │
                  └────────────────────┬────────────────────┘
                                       │
     ┌─────────────────────────────────┴─────────────────────────────────┐
     ▼                                                                   ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────────────┐
│        Web & Extension Runtime        │ │       Mobile Native Bridge (Capacitor)│
├───────────────────────────────────────┤ ├───────────────────────────────────────┤
│ • Chrome MV3 declarativeNetRequest    │ │ • NativeTTS Plugin                    │
│ • Service Worker (Offline asset cache)│ │ • Android: AudioPlayerService         │
│ • Inlined Single-File (Offline HTML)  │ │ • iOS: AVAudioPlayer + MPNowPlaying   │
│ • Node.js WebSocket Proxy Environment │ │ • Hardware Watchdog & RunLoop Binding │
└───────────────────────────────────────┘ └───────────────────────────────────────┘
```

---

## 💻 Developer Guide & Build Commands

Automated scripts for compilation, packaging, and synchronization are provided in the repository:

```bash
# 1. Install dependencies
npm install

# 2. Start local development server (port 3000, with built-in Edge TTS proxy)
npm start

# 3. Build single-file offline reader (outputs reader_offline.html and index.html)
npm run build:offline

# 4. Compile Web distribution and sync to Android / iOS projects
npm run build:dist
npx cap copy ios
npx cap copy android

# 5. Compile native iOS IPA package (requires macOS + Xcode)
npm run build:ipa

# 6. Run automated test suite
npm test
```

---

## ⚠️ Notes & Limitations

1. **DRM Protected Books**: Parsers run entirely client-side and do not support commercial DRM schemes (such as Amazon Kindle DRM or Adobe DRM). Remove DRM prior to importing.
2. **On-Device AI (Gemini Nano)**: Requires Chrome/Edge 128+ Dev/Canary builds with Prompt API enabled in `chrome://flags`, alongside supported hardware resources.
3. **Data Privacy & Backup**: All book files, notes, and reading progress reside exclusively in your local device's sandboxed IndexedDB storage. Before switching devices or clearing browser data, **export a `.zip` archive via the bookshelf's "Export Backup" button**.

---

## 📄 License

Released under the open-source [ISC License](LICENSE). Contributions, bug reports, and pull requests are welcome!
