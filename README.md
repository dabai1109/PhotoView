# PhotoView · 摄影师超高速选片工作台

<div align="center">

![PhotoView Logo](src/renderer/icon.png)

**专为摄影师打造的极致轻量、超高速 RAW/JPEG 选片工具**  
*基于 Tauri 2.0 + Rust + 原生 ESM 构建 · 安装包仅 2~7MB · RAW 秒级全尺寸预览*

[![CI Build](https://github.com/dabai1109/PhotoView/actions/workflows/build.yml/badge.svg)](https://github.com/dabai1109/PhotoView/actions/workflows/build.yml)
[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-blue.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange.svg)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## 📸 项目简介

**PhotoView** 是一款专为摄影师外拍选片、快速过片量身定制的桌面端工作台。针对传统修图软件（Lightroom、Capture One 等）在面对数千张几十兆 RAW 照片时“载入慢、卡顿严重、生成预览费时”的痛点，PhotoView 采用类似 **Photo Mechanic** 的设计哲学：

**“RAW 文件不解码，直接提取机内高质量内嵌 JPEG 预览”**

通过极简的键盘流操作（`←`/`→` 快速翻页、`F` 标记收藏、`X` 删除进回收站、`Z` 100% 焦点放大），让成百上千张照片的初选、筛选在几分钟内轻松完成。

---

## ✨ 核心特性

- ⚡ **RAW 秒级秒开**：通过自研 TIFF/IFD 解析器，精准定位并提取 RAW 文件内部相机生成的内嵌 JPEG 预览（与原图色彩一致），无需漫长等候 demosaic 计算。
- 🎯 **1:1 焦点核对**：按 `Z` 键或单击画面一键 100% 原尺寸放大，配合鼠标丝滑平移，对焦清晰度一目了然。
- 📊 **EXIF HUD & RGB 直方图**：实时显示相机型号、镜头规格、光圈快门、ISO、等效焦距、曝光补偿、尺寸等信息，并动态计算 RGB 三通道直方图。
- 🗂 **非破坏性选片工作流**：
  - **清单式收藏 (`F`)**：在相册根目录维护 `favorites.txt`，零额外磁盘开销，即时生效且与文件系统完全同步。
  - **安全删除 (`X` / `Del`)**：照片直移系统回收站，支持在应用内随时 `Ctrl+Z` 自动还原。
  - **RAW + JPG 智能合并**：自动识别同名 RAW 与 JPG 并合并展示，协同操作。
- 🖼 **高性能虚拟滚动网格**：支持从 120px 到 420px 的缩略图尺寸无级调节，数千张照片顺畅滚动。
- 🎞 **双向智能预取胶片条**：大图模式下附带底部交互式胶片条，LRU 内存缓存结合前后智能预取，翻页延迟低至 1~20ms，告别黑屏与加载过渡。
- 🌓 **双色主题支持**：暗色暗房模式（Obsidian Dark）与影棚明亮模式（Studio Light），按 `T` 键即刻切换或跟随系统。
- 🔄 **内置静默/一键自动更新**：集成基于 GitHub Releases 与 `tauri-plugin-updater` 的版本检测、下载进度显示与自动重启。
- 🪶 **极致轻量**：告别 Electron 的庞大体积，基于 Tauri 2.0 与原生 Web 渲染，内存占用极低，绿色便携。

---

## ⌨️ 快捷键速查表

PhotoView 完全支持全键盘盲操，帮助摄影师实现高速流水线过片：

| 分类 | 快捷键 | 功能说明 |
|:---|:---|:---|
| **浏览与导航** | `←` / `→` | 上一张 / 下一张 |
| | `↑` / `↓` | 网格行上下移动 |
| | `PageUp` / `PageDown` | 快速翻页（网格跨行 / 大图 10 张） |
| | `Home` / `End` | 跳转至首张 / 末尾一张 |
| | `Enter` / `Space` | **网格视图 ⇄ 大图视图** 瞬切 |
| | `Esc` | 从大图模式返回网格视图 / 关闭弹窗 |
| **选片与动作** | `F` | **标记收藏 / 取消收藏**（高亮金星） |
| | `X` / `Del` / `Backspace` | **删除至回收站**（标记红叉） |
| | `Ctrl + Z` / `Cmd + Z` | **撤销上一步操作**（支持从回收站自动还原） |
| | `1` / `2` / `3` / `4` | 快速切换筛选：全部 / 待选 / 收藏 / 已删 |
| **画面与视图** | `Z` / `单击画面` | **100% 焦点对齐放大** / 适应屏幕缩放 |
| | `鼠标滚轮` | 大图无级缩放（最高 24x） / 网格滚动 |
| | `鼠标按住拖拽` | 放大模式下自由平移视野 |
| | `I` | 显示 / 隐藏 EXIF 参数与直方图侧边栏 |
| | `G` | 切换到网格视图 |
| | `T` | 切换暗色 / 亮色主题 |
| | `F5` / `R` / `Ctrl+R` | 刷新当前相册文件夹 |
| | `?` | 打开快捷键帮助面板 |

---

## 📁 支持的文件格式

| 分类 | 扩展名 | 预览提取策略 |
|:---|:---|:---|
| **尼康 RAW** | `.nef`, `.nrw` | 解析 SubIFD / MakerNote PreviewIFD 提取全尺寸机内 JPEG 预览 |
| **主流 RAW** | `.cr2`, `.cr3`, `.arw`, `.dng`, `.raf`, `.orf`, `.rw2`, `.pef`, `.srw` | TIFF/IFD 树遍历或扫描 JPEG 标记段（SOI/EOI）兜底 |
| **标准图像** | `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, `.gif`, `.bmp` | 原生直读，结合 EXIF 元数据提取 |

> 💡 **提示**：极少数不带内嵌 JPEG 预览的特殊 RAW 文件会提示读取失败，而不会渲染黑图或破坏流程。

---

## 🚀 快速上手与安装

### 1. 下载预编译版本
前往 [Releases 页面](../../releases/latest) 下载对应平台的安装包：
- **Windows**：`PhotoView_x.x.x_x64-setup.exe`（NSIS 单用户安装包）
- **macOS**：`PhotoView_x.x.x_universal.dmg`（兼容 Intel 与 Apple Silicon）

### 2. 运行与使用
1. 打开应用，将存储卡或包含照片的文件夹**直接拖入窗口**（或点击“选择照片文件夹”）。
2. 在网格视图中快速扫视，双击或按 `Space` 进大图仔细检视。
3. 喜欢的按 `F` 收藏，废片按 `X` 删除。
4. 选片结束后，所有收藏照片的记录已保存在相册根目录的 `favorites.txt` 中。

---

## 🛠 架构设计与技术实现

```
┌─────────────────────────────────────────────────────────────┐
│                    PhotoView 前端层 (Webview)                │
│  原生 ESM (无臃肿框架)  ·  CSS 变量主题系统  ·  虚拟滚动引擎    │
│  Web Worker 并发解码池  ·  LRU 双层内存缓存  ·  OffscreenCanvas │
└──────────────────────────────┬──────────────────────────────┘
                               │  IPC 二进制直传通道 (Uint8Array Token)
┌──────────────────────────────┴──────────────────────────────┐
│                    PhotoView 核心层 (Rust)                   │
│  lib.rs       : 全异步 IPC 命令调度 (spawn_blocking)          │
│  tiff.rs      : 纯 Rust 自研 TIFF / IFD / MakerNote 解析器   │
│  preview.rs   : RAW 内嵌预览提取 + 方向归属计算 (1MB 快速读取) │
│  scan.rs      : 异步文件遍历 + RAW+JPG 智能合并配对          │
│  fav.rs       : 路径穿越防护 + 收藏清单同步                  │
│  thumbs.rs    : 磁盘缩略图 LRU 缓存系统                      │
│  settings.rs  : 用户偏好与会话游标断点记忆                  │
│  update.rs    : GitHub Releases 自动更新管理                 │
└─────────────────────────────────────────────────────────────┘
```

### 技术亮点

1. **零原生依赖的 TIFF/EXIF 解析器 (`tiff.rs`)**  
   不依赖笨重的外部 C/C++ 库或通用庞大组件，直接按字节解析 TIFF Header、IFD 链、SubIFD、尼康 MakerNote PreviewIFD，先读 1MB 头部提取偏移量与尺寸，毫秒级定位预览图。
2. **多级并发解耦与二进制 IPC 管道**  
   - Rust 侧所有文件 I/O 与耗时扫描均运行在 `spawn_blocking` 线程池，UI 线程永不卡顿；
   - 大图预览字节通过一次性 Token 直传二进制 `Uint8Array`，绕过 base64 与 JSON 序列化带来的 33% 额外传输损耗；
   - 图像缩放、色彩统计与直方图生成交由前端 Web Worker 多线程池处理。
3. **彻底解决浏览器 EXIF 方向二次旋转问题**  
   智能判定 JPEG 字节流中是否自带 EXIF Orientation 标记：
   - 相机直出 JPEG（自带 EXIF 方向）：交给浏览器解码器自动旋转，渲染层不重复叠加；
   - RAW 提取出的裸 JPEG 预览（无 EXIF 标签）：由渲染层根据 RAW 主 IFD 方向进行精确补正。
4. **磁盘缩略图缓存与抗老化设计 (`thumbs.rs`)**  
   缩略图按 `路径 + 修改时间 + 大小 + 尺寸 + 烘焙版本` 生成哈希键并缓存至本地磁盘（800MB 阈值）。淘汰算法针对 Windows 系统 `atime`（访问时间）默认不更新的特性，采用写入时间 + 计数综合驱逐策略。
5. **Windows 回收站原生 COM 还原**  
   删除操作走系统回收站，并在撤销时通过后台 PowerShell COM 接口检索并恢复指定文件，做到既安全又便捷。

---

## 💻 本地开发与贡献

### 环境准备
- [Node.js](https://nodejs.org/) (推荐 20 LTS 或 22+)
- [Rust & Cargo](https://rustup.rs/) (Stable 1.75+)
- Windows 构建需安装 Visual Studio C++ 生成工具，macOS 需 Xcode Command Line Tools。

### 常用命令

```bash
# 1. 克隆代码仓库
git clone https://github.com/dabai1109/PhotoView.git
cd PhotoView

# 2. 安装依赖
npm install

# 3. 启动开发模式 (热重载)
npm run tauri:dev

# 4. 执行完整测试套件 (包含前端回归测试与 Rust 单元测试)
npm test

# 仅运行前端方向与游标测试
npm run test:js

# 仅运行 Rust 单元与端到端测试
npm run test:rust

# 5. 构建生产安装包 (Release)
npm run tauri:build
```

---

## 📂 项目目录结构

```
PhotoView/
├── .github/workflows/       # GitHub Actions CI/CD 自动构建与发布
├── assets/                  # 静态资源与图标
├── src/
│   └── renderer/            # 前端渲染层 (原生 ESM，零第三方框架)
│       ├── index.html       # 主页面骨架与弹窗结构
│       ├── styles.css       # 现代暗色/亮色 CSS 设计系统
│       ├── app.js           # 选片、导航、大图缩放与键盘交互主逻辑
│       ├── tauri-bridge.js  # Tauri 2.0 IPC ⇄ window.pv 适配桥接层
│       ├── decode-worker.js # Web Worker 异步图片缩放与直方图分析
│       └── icon.png         # 应用图标
├── src-tauri/               # 后端核心层 (Rust)
│   ├── Cargo.toml           # Rust 依赖配置与体积优化参数
│   ├── tauri.conf.json      # Tauri 窗口、安全策略与插件配置
│   ├── src/
│   │   ├── main.rs          # 应用入口
│   │   ├── lib.rs           # Tauri IPC 命令注册与异步调度
│   │   ├── tiff.rs          # 纯 Rust TIFF/IFD/EXIF 解析器
│   │   ├── preview.rs       # 预览提取策略、方向计算与 Token 管道
│   │   ├── scan.rs          # 目录异步扫描与 RAW+JPG 配对
│   │   ├── fav.rs           # 收藏清单读写与安全检查
│   │   ├── thumbs.rs        # 磁盘缩略图 LRU 缓存管理
│   │   ├── settings.rs      # 用户偏好设置与会话断点记忆
│   │   ├── update.rs        # 基于 Releases 的自动更新
│   │   └── types.rs         # 核心数据结构定义
│   └── tests/
│       └── fixtures.rs      # 真实素材端到端集成测试
├── test/                    # 前端方向计算与状态回归测试
├── test-photos/             # 测试样本素材 (包含竖拍 EXIF、配对文件等)
└── package.json             # 项目元信息与 npm 脚本
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 许可协议开源发布。
