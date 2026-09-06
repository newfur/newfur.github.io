# Edge 网页版电子书阅读器 (Edge E-Book Reader)

Language: **简体中文** | [繁體中文](README.zh-TW.md) | [English](README.en.md)

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web%20%7C%20Android%20%7C%20iOS-blue)](javascript:;)
[![Version](https://img.shields.io/badge/version-3.4.65-orange)](https://github.com/newfur/newfur.github.io/releases/tag/v3.4.65)
[![Build & Deploy](https://github.com/newfur/newfur.github.io/actions/workflows/build-deploy.yml/badge.svg)](https://github.com/newfur/newfur.github.io/actions)
[![License](https://img.shields.io/badge/license-ISC-green)](LICENSE)

一款专为现代桌面浏览器与移动设备（iOS / Android）打造的沉浸式、高性能且高度可定制的跨平台电子书阅读器。项目采用**纯前端核心 + 轻量原生桥接**的现代化解耦架构，集成了全格式书籍解析引擎、微软 Edge 神经网络自然人声语音朗读（TTS）、双引擎自适应播放架构、端侧/云端 AI 伴侣、全书客户端 RAG 检索以及多端锁屏媒体中心深度联动。

项目提供 **浏览器插件版**、**单文件离线网页版**、**在线网页/PWA版**、**Android 原生 App** 以及 **iOS 原生 App** 五种发行形态，覆盖从桌面大屏到手机平板的全场景无缝阅读。

---

## 🌟 最新多端重构核心亮点 (v3.4.6x)

针对跨平台移动阅读、长时间听书、后台保活与设备存储的痛点，最新版本完成了深度的底层重构：

### 1. 🎧 双引擎自适应 TTS 架构 (Adaptive Dual-Engine Architecture)
- **Route A（标准 Web DOM 音频流）**：专为桌面浏览器插件、单文件离线版及 Web 网页端设计。基于标准 HTML5 Audio API 与内存 Blob URL，事件驱动，极致轻盈。
- **Route B（移动端原生硬件双缓冲无缝引擎 - Native Twin-Player Engine）**：
  - **0ms 极速无缝换句 (Gapless Playback)**：针对移动端 WebView 在锁屏/后台下容易被系统降频、导致句间卡顿或停顿的痛点，iOS (`AVAudioPlayer`) 与 Android (`MediaPlayer`) 原生层均实现了**双底层硬件通道乒乓交叉缓冲（Ping-Pong Buffering）**。当当前句子在通道 A 发声时，下一句音频已在后台完成合成并在通道 B 完成物理硬件预热（`prepareToPlay`）；当前句播放结束瞬间，硬件通道毫秒级无感切换，彻底消灭句间延迟与空隙！
  - **全链路主线程 RunLoop 调度**：iOS 端原生层所有播放器创建、事件监听与状态管理严格绑定于主线程 `RunLoop.main`，根治了苹果 CoreAudio 在后台 GCD 工作线程中丢弃代理回调（`audioPlayerDidFinishPlaying`）的顽疾。
  - **硬件级看门狗双保险 (Hardware Watchdog Fallback Timer)**：原生底层配备智能看门狗守护定时器，动态计算预期播放时长。在来电挂断、蓝牙耳机频繁切换、音频会话抢占等极端系统异常导致硬件事件未上报时，看门狗自动检测硬件真实状态并自动推进下一句，**保障多小时连续朗读永不假死卡顿**。

### 2. 🗄️ 彻底解耦的极速存储引擎 (Decoupled Storage Engine)
- **告别应用存储恶性膨胀**：旧版阅读器在长期阅读、记录进度或导出时容易产生多重嵌套序列化，导致应用占用空间异常暴涨。重构后彻底剥离书籍内容实体与全局配置、阅读进度，书籍正文、索引与阅读记录在 IndexedDB 中实行独立分表存储。
- **存储健康可控**：即便导入数百本大容量图文图书，应用自身体积与运行缓存也始终保持在几十兆的极佳水平，彻底根除了“应用占用几十甚至上百 GB”的存储隐患。

### 3. 🖼️ 全局 512px 动态封面压缩与广播机制 (`compressCoverImage`)
- 原版电子书封面分辨率往往极高（体积达 3MB~10MB），频繁通过 JS 桥接发送给原生媒体中心极易引发跨进程通信阻塞甚至 OOM 闪退。
- 新增智能 Canvas 降采样压缩管道：在解析图书瞬间将封面自动等比压缩至 512×512 视网膜高清规格（仅 20KB~40KB），不仅锁屏与通知栏秒显封面，更大幅降低内存消耗。

### 4. 🧠 客户端全书异步 RAG 与全文秒级检索
- 纯前端自研轻量倒排索引与 TF-IDF 检索算法，打开书籍后台异步毫秒级完成全书切片索引（总索引构建通常在 1 秒以内），为端侧模型（Gemini Nano）与云端大模型（OpenAI、DeepSeek、Claude、Ollama 等）提供精准的上下文知识库，支持角色脉络梳理与 Mermaid 动态思维导图生成。

---

## 📱 五大版本能力与选型对比

| 功能维度 | 🧩 浏览器插件版 | 💾 单文件离线版 | 🌐 在线网页/PWA版 | 🤖 Android 原生版 | 🍎 iOS 原生版 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **运行平台** | Chrome/Edge/Brave 桌面扩展 | 任意现代浏览器双击直接打开 | 浏览器访问或添加为 PWA | Android 8.0+ 手机/平板 | iOS 13.0+ (iPhone/iPad) |
| **安装包体积** | 约 2.4 MB (ZIP) | 约 2.3 MB (单个 HTML) | 0 字节 (即开即用) | 约 16 MB (APK) | 仅 **2.25 MB** (IPA) |
| **安装方式** | 开发者模式加载解压目录 | 本地保存，双击即用 | 访问 URL / 添加到主屏幕 | 安装 APK 安装包 | 使用 Sideloadly / 巨魔安装 |
| **网络要求** | 完全离线阅读（TTS需联网） | 完全离线阅读（TTS需联网） | 离线缓存支持（PWA） | 完全离线阅读（TTS需联网） | 完全离线阅读（TTS需联网） |
| **多格式解析** | ✅ EPUB, AZW3, MOBI, TXT, CBZ | ✅ 完整支持 | ✅ 完整支持 | ✅ 完整支持 | ✅ 完整支持 |
| **Edge 神经网络TTS** | ✅ 完美支持（MV3请求头改写） | ✅ 完美支持（直连官方 WebSocket）| ⚠️ 本地Node支持；公网静态降级 | ✅ 完美支持（原生穿透） | ✅ 完美支持（原生穿透） |
| **TTS 底层架构** | Route A (DOM Audio) | Route A (DOM Audio) | Route A (DOM Audio) | **Route B (双硬件无缝缓冲)** | **Route B (双硬件无缝缓冲)** |
| **0ms 换句与看门狗** | 依赖浏览器内核调度 | 依赖浏览器内核调度 | 依赖浏览器内核调度 | ✅ 硬件双缓冲 + 零延迟切句 | ✅ 硬件双缓冲 + 看门狗守护 |
| **后台与锁屏朗读** | ❌ 仅限前台标签页 | ❌ 移动端息屏易被挂起 | ⚠️ 依赖静音保活，易受回收 | ✅ 极佳（前台服务唤醒锁） | ✅ 极佳（AVAudioSession保活） |
| **锁屏封面与媒体控制** | ❌ 不支持 | ❌ 不支持 | ⚠️ 部分浏览器支持 MediaSession | ✅ 完整 MediaSession 锁屏控制 | ✅ 深度集成 MPNowPlaying 控制 |
| **AI 伴侣 & 思维导图**| ✅ 端侧 Gemini Nano + 云端 | ✅ 支持云端/本地 Ollama API | ✅ 完整支持 | ✅ 推荐配置云端 API / Ollama | ✅ 推荐配置云端 API / Ollama |
| **数据安全与备份** | 插件专属 IndexedDB | 本地文件隔离 IndexedDB | 域名隔离 IndexedDB | 沙盒解耦存储，支持整包备份 | 沙盒解耦存储，支持整包备份 |

---

### 1. 🧩 浏览器插件版 (Chrome / Edge Extension - MV3)
* **核心优势**：
  - 通过 Manifest V3 的 `declarativeNetRequest` 动态改写请求头，**彻底突破微软 Edge 云端 TTS 的 CORS 跨域限制与 Origin 防盗链检测**，在桌面浏览器内直享几十种超自然真人员工神经网络语音。
  - 原生适配 Chrome 128+ 内置的 **Gemini Nano** 端侧大模型，无需消耗外网流量或配置 API Key，即可实现段落精读、古文翻译、生词解释与章节速读。
* **局限性**：
  - 仅限于 Chromium 内核桌面浏览器；关闭浏览器后朗读停止。
* **安装步骤**：
  1. 在 [Releases](https://github.com/newfur/newfur.github.io/releases) 下载 `Raconteur-Chrome-*.zip` 并解压。
  2. 浏览器地址栏输入 `chrome://extensions/` 或 `edge://extensions/`。
  3. 开启右上角 **“开发者模式”** 开关。
  4. 点击 **“加载已解压的扩展程序”**，选取解压目录即可。

---

### 2. 💾 单文件离线网页版 (Single-File Offline Reader)
* **核心优势**：
  - **零依赖单文件**：整个阅读器所有 JS 逻辑、CSS 样式、解析器内核（JSZip 等）、字体及多语言资源全部内联压制在一个 `.html` 文件中（约 2.3MB）。
  - **本地直连 Edge 语音**：直接在本地以 `file:///` 协议打开运行时，阅读器会通过 WebSocket (`wss://speech.platform.bing.com/...`) 直连微软官方服务，结合动态计算的 `Sec-MS-GEC` 鉴权令牌，**完全不受跨域限制，可直接流畅播放微软高质量神经网络人声**！若离线则自动降级为系统发音。
  - 无需安装 Node.js、无需部署服务器，Windows/macOS/Linux/手机浏览器双击即开。
* **局限性**：
  - 手机移动端浏览器退入后台或熄屏时，网页脚本易被系统休眠，无锁屏控制台。
* **安装使用**：
  1. 在 [Releases](https://github.com/newfur/newfur.github.io/releases) 下载最新的 `Raconteur-Offline-*.html`。
  2. 任意现代浏览器双击直接运行，建议按 `Ctrl+D`（或 `Cmd+D`）收藏为本地书签。

---

### 3. 🌐 在线网页 / PWA 版 (Web Server & PWA)
* **核心优势**：
  - 支持多设备联网访问，支持添加至桌面或手机主屏（PWA 独立窗口运行，无浏览器顶栏遮挡）。
  - 本地 Node.js 运行模式（`npm start`）内置专有 `/api/tts` 反向代理，支持满血 Edge 自然语音。
* **局限性**：
  - 公网纯静态托管环境（如 GitHub Pages、Vercel）因缺少后端中继且受制于浏览器跨域策略，Edge 语音会自动降级为浏览器本地 Web Speech 发音。建议需纯净网络体验者使用插件版、单文件离线版或移动客户端。
* **使用方式**：
  - **在线直达**：访问部署网址；手机点击 Safari “分享” -> **“添加到主屏幕”** 获得 App 级体验。
  - **本地私有化部署**：
    ```bash
    git clone https://github.com/newfur/newfur.github.io.git
    cd newfur.github.io
    npm install
    npm start
    # 访问 http://localhost:3000
    ```

---

### 4. 🤖 Android 原生版 (Android APK)
* **核心优势**：
  - **前台服务硬核保活 (`AudioPlayerService`)**：在系统级启用带有唤醒锁（`PARTIAL_WAKE_LOCK`）的前台常驻播放服务，锁屏、灭屏或切至其他 App 听书数小时依然稳定播放。
  - **Route B 原生双缓冲播放**：双 `MediaPlayer` 硬件缓冲区自动交替无缝换句，无延迟停顿。
  - **原生锁屏与系统通知栏控制台**：深度接入 Android `MediaSession`，显示实时朗读句子、书籍名、作者与全局 512px 压缩封面，支持物理按键/蓝牙耳机上一句、下一句与播放控制。
  - **原生物理返回键拦截**：层级返回，优先退出浮层与目录，避免误触退出应用。
* **安装步骤**：
  1. 在 [Releases](https://github.com/newfur/newfur.github.io/releases) 下载最新的 `Raconteur-*.apk`。
  2. 传输到安卓设备点击安装（若系统提示外部来源风险，选择允许继续安装）。

---

### 5. 🍎 iOS 原生版 (iOS IPA)
* **核心优势**：
  - **极致超轻量**：基于 Capacitor 与原生 Swift 精准构建，安装包体积仅 **2.25MB**！
  - **Route B 原生双缓冲无缝播放引擎**：采用双 `AVAudioPlayer` 交叉乒乓轮替技术，主线程 RunLoop 精准调度，毫秒级无感换句，彻底告别 WebKit 进程在锁屏下的冻结卡顿。
  - **硬件级看门狗双保险**：遇到来电、蓝牙抢占等异常打断时，看门狗自动检测并自动恢复，永不假死。
  - **系统锁屏、控制中心与灵动岛集成**：深度接入 `MPNowPlayingInfoCenter` 与 `MPRemoteCommandCenter`，配置 `AVAudioSession (.playback)` 模式，锁屏实时呈现高清书籍封面、朗读文本、章节进度及耳机遥控切句。
  - **全面屏自适应**：原生动态测量并适配刘海屏与灵动岛（Dynamic Island）顶部安全区。
* **安装步骤**：
  - **推荐使用 Sideloadly 侧载安装**：
    1. 电脑端下载并安装 [Sideloadly](https://sideloadly.io/)；
    2. 在 [Releases](https://github.com/newfur/newfur.github.io/releases) 下载最新的 `EdgeReader-*.ipa`；
    3. 将 `.ipa` 文件拖入 Sideloadly，填写您的 Apple ID 账号；
    4. 用数据线将 iPhone / iPad 连接至电脑，点击 **Start** 签名并安装；
    5. 打开手机「设置」->「通用」->「VPN 与设备管理」，信任该证书即可畅享阅读！
  - 也支持使用 AltStore、SideStore、巨魔商店（TrollStore）或 Mac 本地 Xcode 编译安装。

---

## 🛠️ 项目架构设计

本项目采用分层解耦的纯前端驱动 + 原生轻量插件化架构设计：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Edge Reader 跨平台架构设计                            │
└─────────────────────────────────────────────────────────────────────────────┘

                  ┌─────────────────────────────────────────┐
                  │          UI 排版与用户交互呈现层        │
                  │   reader.html / reader.css / i18n.js    │
                  │ (左右翻页/纵向滚动/主题纸质/字体/高亮浮层)  │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │            核心阅读器控制器             │
                  │               reader.js                 │
                  └─────────┬──────────┬──────────┬─────────┘
                            │          │          │
    ┌───────────────────────┘          │          └─────────────────────────┐
    ▼                                  ▼                                    ▼
┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐
│     全格式电子书解析    │ │   自适应双路由 TTS 引擎 │ │   AI 伴侣 & 客户端 RAG  │
│    parsers/ (纯前端JS)  │ │          tts.js         │ │         ai.js           │
├─────────────────────────┤ ├─────────────────────────┤ ├─────────────────────────┤
│ • EPUB (EPUB 2/3 标准)  │ │ 【Route A - Web DOM】   │ │ • 浏览器端侧Gemini Nano │
│ • AZW3 / MOBI (Kindle)  │ │   HTML5 Audio (PC/扩展) │ │ • 云端 API (OpenAI/Deep)│
│ • TXT (智能目录推导)    │ │ 【Route B - 原生双缓冲】│ │ • 本地模型 (Ollama/LM)  │
│ • CBZ (漫画图片瀑布流)  │ │   0ms 硬件双缓冲无缝切换│ │ • 全书异步倒排 RAG 索引 │
│ • FB2 (FictionBook)     │ │   硬件级看门狗状态守护  │ │ • Mermaid 思维导图生成  │
└─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │          数据持久化与解耦存储层         │
                  │               library.js                │
                  │   IndexedDB (实体独立存储，严禁内联膨胀)│
                  │   512px 全局封面智能压缩与跨端广播机制  │
                  └────────────────────┬────────────────────┘
                                       │
     ┌─────────────────────────────────┴─────────────────────────────────┐
     ▼                                                                   ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────────────┐
│           Web 与桌面扩展运行环境      │ │         移动端原生引擎桥接层 (Capacitor)│
├───────────────────────────────────────┤ ├───────────────────────────────────────┤
│ • Chrome MV3 declarativeNetRequest    │ │ • NativeTTS 原生扩展插件              │
│ • Service Worker (离线资源智能缓存)   │ │ • Android: AudioPlayerService 前台服务│
│ • 单文件静态内联打包 (Offline HTML)   │ │ • iOS: AVAudioPlayer + MPNowPlaying   │
│ • Node.js 本地微服务与 WebSocket 代理 │ │ • 硬件看门狗定时器 & 线程 RunLoop 保障│
└───────────────────────────────────────┘ └───────────────────────────────────────┘
```

---

## 💻 开发者指南与构建命令

本项目根目录下提供了完善的自动化打包、编译与同步脚本：

```bash
# 1. 安装开发依赖
npm install

# 2. 启动本地开发服务 (默认端口 3000，内置 Edge TTS 代理)
npm start

# 3. 编译单文件离线版 (生成 reader_offline.html 与 index.html)
npm run build:offline

# 4. 一键构建 Web 产物并同步至 Android / iOS 工程
npm run build:dist
npx cap copy ios
npx cap copy android

# 5. 一键编译 iOS 原生 IPA 安装包 (需 macOS + Xcode 环境)
npm run build:ipa

# 6. 执行全套测试套件
npm test
```

---

## ⚠️ 常见问题与说明

1. **DRM 加密书籍**：阅读器解析器为纯客户端前端算法，不支持受商业版权保护（如亚马逊 Kindle DRM、Adobe DRM）的加密文件，导入前请先使用解密工具转换为普通 EPUB/AZW3/TXT。
2. **端侧本地大模型 (Gemini Nano)**：仅支持 Chrome/Edge 128+ 开发版/金丝雀版，需在 `chrome://flags` 中开启相关实验性 Prompt API 特性，且电脑需配备相应的硬件显存与运行内存。
3. **数据隐私与备份**：所有书籍与阅读记录完全保存在您本地设备的 IndexedDB 沙盒中，绝无任何第三方中心服务器收集您的隐私数据。换机或重装前，**请随时在书架右上角点击“导出备份”生成 `.zip` 完整存档文件**。

---

## 📄 开源许可

本项目采用 [ISC License](LICENSE) 许可协议开源发布。欢迎提交 Issue 与 Pull Request 共同共建！
