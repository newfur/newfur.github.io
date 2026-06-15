# Edge 网页版电子书阅读器 (Edge E-Book Reader)

Language: **简体中文** | [繁體中文](README.zh-TW.md) | [English](README.en.md)

[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Web%20%7C%20Android-blue)](javascript:;)
[![License](https://img.shields.io/badge/license-ISC-green)](javascript:;)

一款专为网页和移动端设计的现代、美观、功能强大且高度定制化的电子书阅读器。项目集成了多格式解析器、高质量 Microsoft Edge 云端神经网络语音朗读（TTS）、本地/云端 AI 阅读助手以及精美的阅读统计分析。支持**浏览器插件**、**本地 Web 服务 (PWA)**、**单文件离线版**以及**安卓原生 App** 四种形态。

---

## 📖 项目简介

本项目旨在打破电子书阅读的平台限制，提供最顶级、最流畅的跨端阅读与朗读体验。特别针对**微软 Edge 神经网络语音**进行了技术突破，使您无需安装复杂的客户端，即可在任何主流 Chromium 浏览器及移动设备上享受媲美真人的有声书朗读。

---

## ✨ 核心特性

1. **🗂️ 广泛的电子书格式支持**：内置轻量级纯 JS 解析引擎，支持 **EPUB**（章节目录、图文混排）、**AZW3 / MOBI**（Kindle 格式兼容）、**TXT / MD**（智能提取章节与段落）、**FB2**、**CBZ**（漫画瀑布流/单页）。
2. **🎨 极致的个性化排版系统**：支持“左右模拟翻页”与“上下连续滚动”；内置霞鹜文楷、思源宋体、OpenDyslexic 等字体；预设明亮白、纯黑 (OLED)、深雅灰等 8 种主题并支持纸张质感底纹叠加。
3. **🎙️ 高保真神经网络 TTS 朗读**：直连微软 Edge 神经网络云端 TTS，支持数十种极具表现力的自然人声；内置无缝双播放器预加载机制，消除切换卡顿；支持 iOS/Android 移动端后台/锁屏静音保活播放；智能断句过滤角标。
4. **🤖 浏览器本地/云端 AI 伴侣**：对接浏览器内置 **Gemini Nano** 接口（完全本地处理），同时支持配置 OpenAI、DeepSeek、Gemini API、SiliconFlow 及本地 Ollama、LM Studio。支持一键划词释义、章节/段落摘要、离线翻译。
5. **📊 深度阅读数据统计**：总时长、阅读天数统计；单本书日均阅读明细；24小时阅读时间段分布；日历热力图式足迹记录。
6. **📁 书库管理与安全备份**：支持书籍分类文件夹管理、批量移动/删除；支持一键导出包含书籍文件、阅读进度、高亮划线、笔记和阅读统计的加密压缩备份包 (`.zip`)。
7. **📱 原生移动端支持**：基于 Ionic Capacitor 构建，支持打包为 Android 原生 App，适配高精圆形/自适应系统图标。

---

## 🔄 版本历史与更新

### 🚀 v3.1.x (当前最新)
* **高精图标重构 (v3.1.8)**: 重新以 AI 高清绘制并裁剪替换了全套平台的极简扁平化 App 图标（无数字、超清晰矢量风），并为 Android 原生壳工程适配了自适应背景色及圆形、前景层图标。
* **TTS 朗读进度保存优化 (v3.1.5)**: 解决了背景/锁屏状态下因浏览器定时器暂停导致进度丢失的问题。新增了在暂停、隐藏（visibilitychange）及页面关闭时的立即同步写入机制；优化章节过渡逻辑，防止加载临界点越界卡死。
* **高亮位置微调 (v3.1.4)**: 实现了朗读高亮同步偏移微调与启动性能优化。

### 📱 v3.0.0 (原生跨平台支持)
* **Android/iOS 双端打包**: 引入 Capacitor 架构，支持将阅读器无缝打包为原生移动端 App。
* **阅读统计 Bug 修复**: 修复了备份还原时，同一天同一小时的阅读时间重复累计的 Bug。

### 🤖 v2.x.x (AI 伴侣与 RAG 搜索)
* **多服务商 AI 配置**: 支持自定义 OpenAI、DeepSeek、Gemini API、SiliconFlow 及本地 Ollama、LM Studio 实例。
* **精准 AI 上下文提取**: 支持全局、章节及可见视窗级页面文字精准提取。
* **本地 RAG 搜索索引**: 后台异步建立全书 TF-IDF 索引，向 AI 提问时自动检索最相关段落，防止幻觉。
* **Mermaid 互动思维导图**: 支持 AI 自动生成思维导图，并支持拖拽缩放、平移与持久化存储。

---

## 🛠️ 架构设计

项目采用纯前端驱动架构，数据统一存储于浏览器本地的 **IndexedDB** 中。根据运行环境不同，设计了四种分发部署模式：

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
 动态修改请求头绕过            Node服务代理    Data URL 绕过            原生接口与文件系统
 Bing TTS CORS 限制            TTS 流量限制    本地 file:// 限制         本地化沙盒存储
```

---

## 🚀 使用与构建方法

### 📦 方法 A：作为浏览器插件安装 (推荐)
1. 下载本项目源码。
2. 打开 Chrome 或 Edge 浏览器，进入 **“扩展程序”** 页面 (`chrome://extensions/`)。
3. 开启右上角的 **“开发者模式”**。
4. 点击 **“加载已解压的扩展程序”**，选择项目根目录。

### 🌐 方法 B：本地 Node.js 网页版运行
1. 安装依赖并启动本地服务器：
   ```bash
   npm install
   npm start
   ```
2. 打开浏览器访问：`http://localhost:3000`。

### 💾 方法 C：构建单文件离线版/静态部署
1. 执行打包脚本：
   ```bash
   npm run build:offline
   ```
2. 打包完成后，会在根目录生成 `reader_offline.html` 和 `index.html`（双击 `reader_offline.html` 即可离线使用）。
3. 静态文件 `index.html` 可以直接上传到 Vercel、GitHub Pages 等托管。

### 📱 方法 D：构建 Android 原生 App
1. 确保安装了 Android SDK 和 Gradle 环境。
2. 运行构建脚本同步资产：
   ```bash
   npm run build:mobile
   ```
3. 使用 Android Studio 打开 `android/` 目录进行编译部署，或直接通过 Gradle 构建。

---

## ⚠️ 项目局限性

1. **DRM 版权限制**: 无法解析 DRM 加密保护的电子书（如 Amazon Kindle 保护格式、Adobe DRM），导入前需先解密。
2. **本地 AI 硬件门槛**: 浏览器内置 Gemini Nano 需 Chrome/Edge 128+ 开发版并开启对应 Flags，且设备需有足够内存/显存运行模型。
3. **TTS 限制**: 纯静态无代理服务器时直连微软 WebSocket。若微软修改校验规则可能导致失效。完全离线时会自动降级为本地 Web Speech 朗读。
4. **数据安全**: 数据存于浏览器 IndexedDB。清理缓存或系统磁盘不足时可能会被浏览器回收，建议定期备份导出 `.zip` 文件。

---

## 📂 项目结构

```
Edge-Reader/
├── _locales/              # 国际化语言包 (支持中繁、中简、英文)
├── android/               # Android 原生壳工程 (Capacitor)
├── icons/                 # 插件及 PWA 图标
├── reader/                # 阅读器核心源码
│   ├── css/
│   ├── libs/              # 第三方依赖库 (JSZip)
│   ├── parsers/           # 电子书格式解析器 (EPUB, AZW3, TXT, CBZ)
│   ├── ai.js              # 浏览器内置 Gemini Nano 与云端/本地大模型接口对接
│   ├── i18n.js            # 多语言翻译模块
│   ├── library.js         # 书库管理逻辑 (书库渲染、分类、导入导出)
│   ├── reader.css         # 阅读器排版与主题样式
│   ├── reader.html        # 主阅读界面 DOM
│   ├── reader.js          # 阅读核心控制器 (翻页、滚动、事件监听)
│   └── tts.js             # 微软 TTS 神经网络朗读引擎 (无缝双缓冲、断句)
├── scratch/               # 构建与辅助脚本目录
│   ├── build_dist.js      # 移动端/PWA 静态资源编译打包脚本
│   └── compile_offline.js # 离线单文件打包脚本
├── www/                   # 编译生成的 PWA/移动端静态资源目录
├── capacitor.config.json  # Capacitor 跨平台配置文件
├── manifest.json          # Chrome Extension Manifest V3 配置文件
├── manifest.webmanifest   # PWA 配置文件
├── sw.js                  # PWA Service Worker 缓存脚本
├── service-worker.js      # 浏览器插件后台脚本 (Origin 修改规则)
├── server.js              # 本地 Node.js 网页开发及 TTS 代理服务器
├── index.html             # 编译生成的网页版主页 (同 reader_offline.html)
├── reader_offline.html    # 离线单文件版 (双击即用)
├── vercel.json            # Vercel 静态托管配置
└── README.md              # 项目说明文档
```

---

## 📄 开源协议

本项目采用 [ISC License](LICENSE) 许可协议开源。
