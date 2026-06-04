# Edge 网页版电子书阅读器 (Edge E-Book Reader)

Language: **简体中文** | [繁體中文](README.zh-TW.md) | [English](README.en.md)

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web-blue)](javascript:;)
[![License](https://img.shields.io/badge/license-ISC-green)](javascript:;)

一款专为网页和浏览器设计的现代、美观、功能强大且高度定制化的电子书阅读器。项目集成了多格式解析器、高质量 Microsoft Edge 云端神经网络语音朗读（TTS）、本地 AI 阅读助手以及精美的阅读统计分析，支持**浏览器插件**、**本地 Web 服务 (PWA)** 以及**单文件离线版**三种形态。

---

## 📖 项目简介

本项目旨在打破电子书阅读的平台限制，提供最顶级、最流畅的跨端阅读与朗读体验。特别针对**微软 Edge 神经网络语音**进行了深度适配与技术突破，使您无需安装复杂的客户端，即可在任何主流 Chromium 浏览器中享受媲美真人的有声书朗读。

---

## ✨ 核心特性

### 1. 🗂️ 广泛的电子书格式支持
内置轻量级纯 JS 解析引擎，支持多种主流电子书及文档格式的本地解析与渲染：
*   **EPUB**: 完整支持章节目录、样式渲染、图文混排及多级跳转。
*   **AZW3 / MOBI**: 兼容 Kindle 格式，支持解析内嵌的样式与图片。
*   **TXT / MD (Markdown)**: 智能提取章节标题与段落，自动构建目录树。
*   **FB2**: 完备支持小说段落和排版。
*   **CBZ (漫画)**: 支持图片打包漫画的瀑布流或单页阅读。

### 2. 🎨 极致的个性化排版系统
*   **版面布局**: 支持 **“左右模拟翻页”** 与 **“上下连续滚动”** 模式。
*   **字体支持**: 内置霞鹜文楷 (LXGW WenKai)、思源宋体 (Noto Serif)、OpenDyslexic (易读字体)、Fira Code (等宽代码)、Inter (无衬线) 等，支持调整大小、行高、字距。
*   **视觉主题**: 预设明亮白、深雅灰、复古纸、极简绿、纯黑 (OLED)、樱花粉、海洋蓝、石板灰等 8 种主题。
*   **纸张质感**: 支持叠加经典纸纹、羊皮纸、亚麻布纹、仿旧纸、水纹纸等物理纹理底纹。

### 3. 🎙️ 高保真神经网络 TTS 朗读
*   **Edge 官方音质**: 直连微软 Edge 神经网络云端 TTS，支持晓晓、云希、云健等数十种极具表现力的自然人声。
*   **双播放器缓冲机制**: 内部维护双 `Audio` 播放对象交替预加载与解码，彻底消除句子切换间的卡顿与空白延迟。
*   **安全防后台挂起**: 针对 iOS / Android 移动端后台运行进行了专门的静音保活与保活音频轨道设计，支持锁屏/后台连续朗读。
*   **智能断句**: 内置断句解析器，可智能识别小数点（如 3.14）及英文缩写（如 Mr., J. F.），防止句子被粗暴截断，并自动过滤正文中的角标、脚注符号。

### 4. 🤖 浏览器本地 AI 阅读伴侣
*   **无需 Key 的本地 AI**: 对接 Chrome/Edge 浏览器内置的实验性 **Prompt API (Gemini Nano)**，数据完全本地处理。
*   **三大 AI 能力**: 支持**一键划词释义**、**选中段落/章节摘要**、以及**流式文本离线翻译**。

### 5. 📊 深度阅读数据统计
*   **全局概览**: 统计总阅读时长、阅读天数、累计阅读书籍。
*   **单本分析**: 展示单本书的阅读明细、日均阅读时长。
*   **时间段分布**: 可视化展示 24 小时阅读时间分布，洞察您的阅读习惯。
*   **每日明细**: 日历热力图式记录每日阅读时间，见证阅读足迹。

### 6. 📁 书库管理与备份还原
*   **分类管理**: 支持新建文件夹、重命名，可批量移动书籍、批量删除。
*   **全量备份**: 一键导出包含**所有书籍文件、阅读进度、划线、高亮、笔记以及阅读统计**在内的加密/压缩备份包 (`.zip`)。

---

## 🔄 最近更新与优化 (v2.0.0)

*   **自定义 AI 与本地 LLM 整合**:
    - 支持接入 OpenAI、DeepSeek 等云端大语言模型接口，以及本地部署的 Ollama 实例。
    - 在扩展环境下通过 Background Service Worker 代理流式通信，彻底绕过跨域 (CORS) 限制。
    - 提供了单独的“保存 AI 配置”按钮并给出成功保存反馈，解决配置保存不直观的问题。
    - 顶部导航栏新增“AI 助手”全局聊天入口，且 AI 面板底部新增对话输入框，支持直接键入问题进行自由交互，并将历史与流式回复渲染为精美的聊天气泡对话流。
*   **侧边栏样式与字体层级优化**:
    - 强制侧边栏功能按钮及分区标题（添加书签、书签、笔记与高亮）使用稳定的系统 UI 字体，解决特定电子书内嵌 CSS 污染侧边栏组件字体的问题。
    - 调整侧边栏文字大小（顶部标签 18px，按钮及标题 16px），建立清晰的界面视觉层级。

---

## 🔄 历史更新 (v1.2.2)

*   **排版渲染优化**:
    - 统一并规范了不同格式书籍（如 EPUB/AZW3）的正文左右边距渲染，解决部分书籍段落容器因内部样式冲突导致的边距过大或不对称问题。
    - 修复了分栏（双页）排版模式下，长章节标题文字超出页面边界溢出的问题。
    - 彻底解决阅读器顶部标题栏在加载某些书籍时，因书籍内置 CSS 污染 `h2` 标签而导致的文字垂直偏位、被裁剪显示不完整的问题。
*   **工程构建与代码库优化**:
    - 规范 Git 忽略规则，将本地临时开发脚本、測試文件以及自动打包产生的 `.zip` 文件排除在 Git 追踪之外。

---

## 🔄 历史更新 (v1.2.1)

*   **数据管理**: 新增“清理阅读记录”功能（支持单本书籍与全库一键清空）；删除书籍时同步自动清空其统计数据。
*   **交互体验**: 统一弹窗关闭规范，支持点击遮罩空白处快速关闭，并在“关于”弹窗右上角增加“X”关闭按钮。
*   **排版美化**:
    - “纸张底纹”兼容“连续滚动”模式，提升底纹对比度，并新增**牛皮纸**、**竹木纤维**、**复古格子**三款精美纸张样式。
    - 优化侧边栏字号比例，并设置默认主题为清新护眼的“极简绿”。
*   **自适应布局**: 优化书架头部标题栏宽度为自适应，解决桌面端浏览器缩放时的布局溢出问题。

---

## 🛠️ 架构设计

项目采用纯前端驱动架构，数据统一存储于浏览器本地的 **IndexedDB** 中。根据运行环境不同，设计了三种分发部署模式：

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
         动态修改请求头绕过           通过 node.js 服务      Data URL 绕过 Chrome
         Bing TTS 的 CORS 校验        代理转发 TTS 流量      file:// 安全策略限制
```

### 1. 浏览器插件模式 (Extension Mode)
*   **实现原理**: 遵循 Chrome Extension Manifest V3 规范。
*   **核心优势**: 能够利用 `chrome.declarativeNetRequest` 动态修改请求头，将 WebSocket 连往 `speech.platform.bing.com` 的请求 Origin 强行改写为 `chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold` (Edge 官方 TTS 插件 ID)，直接获取官方神经网络接口权限。
*   **背景通信**: `service-worker.js` 在后台拦截并代理 TTS 语音列表获取，解决浏览器跨域（CORS）屏障。

### 2. 本地网页服务模式 (Web Server Mode)
*   **实现原理**: 由 `server.js` 提供基于 Node.js 的微服务。
*   **接口代理**: 针对不支持插件环境的普通浏览器，在服务端建立 `/api/voices` 接口和 `/api/tts` (WebSocket) 代理，将请求包装后转发给 Bing 服务器，突破浏览器的 CORS 原源策略限制。
*   **PWA 支持**: 集成了 `sw.js` 与 `manifest.webmanifest`，开启离线静态资源缓存，在断网时依然可以秒级加载阅读器主界面。

### 3. 单文件离线模式 (Standalone Offline Mode)
*   **实现原理**: 提供一个无额外依赖的离线大 HTML 文件 `reader_offline.html`。
*   **打包技术**: 通过构建脚本 `scratch/compile_offline.js`，将 `JSZip` 库、所有格式解析模块、CSS 样式、TTS 控制脚本及多语言 JSON 包直接内联嵌入到 HTML 的 `<script>` 和 `<style>` 中。
*   **本地安全规避**: 在 `file://` 协议下运行时，由于 Chrome 安全机制限制，无法直接通过 `URL.createObjectURL(blob)` 连续播放音频，会触发 `ERR_REQUEST_RANGE_NOT_SATISFIABLE` 报错。离线版在 TTS 引擎中自动将 Blob 转换为 Base64 格式的 Data URL 传入播放器，彻底解决了本地单文件无法连续朗读的问题。

---

## 🚀 使用与构建方法

### 📦 方法 A：作为浏览器插件安装 (推荐)
1. 下载本项目源码。
2. 打开 Chrome 或 Microsoft Edge 浏览器，进入 **“扩展程序”** 页面 (`chrome://extensions/` 或 `edge://extensions/`)。
3. 开启右上角的 **“开发者模式”**。
4. 点击 **“加载已解压的扩展程序”**，选择项目根目录。
5. 点击浏览器工具栏的插件图标，即可打开全屏阅读器。

### 🌐 方法 B：本地 Node.js 网页版运行
1. 确保已安装 Node.js 环境。
2. 在项目根目录执行安装依赖：
   ```bash
   npm install
   ```
3. 启动本地开发与代理服务器：
   ```bash
   npm start
   ```
4. 打开浏览器访问：`http://localhost:3000`。

### 💾 方法 C：构建单文件离线版/静态部署
1. 执行打包脚本：
   ```bash
   npm run build:offline
   ```
2. 打包完成后，会在根目录生成 `reader_offline.html` 和 `index.html`。
3. **直接运行**: 双击 `reader_offline.html` 即可在本地离线使用，支持直接拖拽书籍导入。
4. **托管部署**: 静态文件可以直接上传到 Vercel、GitHub Pages、Cloudflare Pages 等平台。项目内已附带 `vercel.json` 配置文件。

---

## ⚠️ 项目局限性

虽然项目在排版和朗读上做了极大的技术优化，但在特定场景下仍存在以下局限：

1.  **DRM 版权限制**: 
    无法解析和阅读受 DRM（数字版权管理）加密保护的电子书（例如直接从 Kindle 商店下载的受保护 `.azw3`/`.mobi` 格式，或 Adobe 加密的 `.epub` ），导入前需先使用第三方工具进行解密去保护。
2.  **本地 AI 硬件及版本门槛**:
    AI 伴侣功能完全基于 Chromium 浏览器的 **Gemini Nano Prompt API**。要使用该功能：
    *   浏览器需为 Chrome/Edge 128+ 开发者/金丝雀版本或开启了相应实验性 Flag 的稳定版。
    *   需在 `chrome://flags` 中开启 `#optimization-guide-on-device-model` (设为 Enabled BypassPerfRequirement) 和 `#prompt-api-for-gemini-nano` (设为 Enabled)。
    *   设备需有足够的显存/内存来下载和运行本地 Gemini Nano 模型（约 1.5GB ~ 3GB 模型包）。
3.  **纯静态/离线状态下的 TTS 限制**:
    *   如果使用静态部署（如 Vercel 静态页面）或直接双击打开 `reader_offline.html` 且**未启动本地 proxy 代理服务器**时，Edge TTS 需要直连微软服务器。若微软对 `speech.platform.bing.com` 的 Sec-MS-GEC 计算校验规则进行重大升级，直连 WebSocket 可能会暂时失效。
    *   在完全没有网络连接的物理离线状态下，云端神经网络 TTS 将不可用，系统会自动降级并尝试调用浏览器本地的 Web Speech API (`speechSynthesis`)，朗读音质会大打折扣。
4.  **IndexedDB 存储上限与数据安全**:
    *   所有书籍和进度均存储在当前浏览器域名的本地数据库中。如果用户手动清除了浏览器缓存、使用了“无痕/隐私模式”或者系统磁盘空间极度不足，浏览器可能会自动回收 IndexedDB 空间，导致书库数据丢失。
    *   **建议**: 强烈建议定期使用书库主页顶部的 **“备份书库”** 功能导出 `.zip` 文件到本地妥善保存。
5.  **移动端后台播放受限**:
    *   尽管 TTS 引擎实现了双播放器无缝衔接与静音保活，但在部分移动端系统（如 iOS Safari 或部分强力清理后台的安卓系统）上，若离开浏览器时间过长，系统墓碑机制仍可能强制挂起浏览器进程，导致 TTS 停止播放。可通过使用独立 App 壳或保持屏幕微亮来缓解。

---

## 📂 项目结构

```
mysterious-oppenheimer/
├── _locales/              # 国际化语言包 (支持中繁、中简、英文)
├── icons/                 # 插件及 PWA 图标
├── reader/                # 阅读器核心源码
│   ├── css/
│   ├── libs/              # 第三方依赖库 (JSZip)
│   ├── parsers/           # 电子书格式解析器 (EPUB, AZW3, TXT, CBZ)
│   ├── ai.js              # 浏览器内置 Gemini Nano 接口对接
│   ├── i18n.js            # 多语言翻译模块
│   ├── library.js         # 书库管理逻辑 (书库渲染、分类、导入导出)
│   ├── reader.css         # 阅读器排版与主题样式
│   ├── reader.html        # 主阅读界面 DOM
│   ├── reader.js          # 阅读核心控制器 (翻页、滚动、事件监听)
│   └── tts.js             # 微软 TTS 神经网络朗读引擎 (无缝双缓冲、断句)
├── scratch/               # 构建工具与脚本开发目录
│   └── compile_offline.js # 离线大文件打包脚本
├── manifest.json          # Chrome Extension Manifest V3 配置文件
├── manifest.webmanifest   # PWA 配置文件
├── sw.js                  # PWA Service Worker 缓存脚本
├── service-worker.js      # 浏览器插件后台脚本 (Origin 修改规则)
├── server.js              # 本地 Node.js 网页开发及 TTS 代理服务器
├── index.html             # 编译生成的网页版主页 (同 reader_offline.html)
├── vercel.json            # Vercel 静态托管配置
└── README.md              # 项目说明文档
```

---

## 📄 开源协议

本项目采用 [ISC License](LICENSE) 许可协议开源。
