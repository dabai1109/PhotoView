# PhotoView · 摄影师选片工具

拖入文件夹 → 快速过片 → 喜欢的按 `F` 进收藏夹，不要的按 `X` 进回收站。专为尼康 RAW 工作流做的 Windows 桌面应用。

## 怎么跑起来

需要 [Rust 工具链](https://rustup.rs) 和 Node 20+。

```bash
npm install
npm run tauri:dev      # 开发模式
npm run tauri:build    # 出安装包（Windows: NSIS，macOS: dmg）
```

首次启动后把照片文件夹拖进窗口即可开始。仓库里自带 `test-photos/` 可以直接拖进去试（含合成 NEF、RAW+JPG 配对、子文件夹）。

## 核心用法

| 键 | 作用 |
|---|---|
| `←` `→` | 上一张 / 下一张 |
| `F` | 收藏 / 取消收藏 |
| `X` `Del` | 删除到回收站 |
| `Ctrl+Z` | 撤销上一步（含从回收站还原） |
| `Enter` `空格` | 网格 ⇄ 大图 |
| `Z` / 单击画面 | 100% 看焦点，按住拖动平移 |
| 滚轮 | 大图缩放 |
| `I` | 信息面板 |
| `1`–`4` | 全部 / 待选 / 收藏 / 已删 |
| `Home` `End` | 第一张 / 最后一张 |

- **收藏**：默认把整组文件（NEF + 同名 JPG 一起）**复制**到 `<照片文件夹>/收藏/`，原文件不动。可在设置里改成「移动」。
- **删除**：走系统回收站，随时能从回收站手动还原。（Tauri 版尚未接「应用内一键还原」，`Ctrl+Z` 会提示去系统回收站操作。）
- **收藏状态以文件系统为准**：你在应用外往收藏夹里增删文件，重新打开时会如实反映。

## 支持的格式

- **尼康**：NEF、NRW
- 其它 RAW：CR2 CR3 ARW DNG RAF ORF RW2 PEF SRW 等
- 常规：JPG PNG WEBP AVIF GIF BMP

RAW 的显示方式是**提取机内生成的内嵌 JPEG 预览**（和 Photo Mechanic 一样），不做 RAW 解码，所以看片速度接近看 JPEG，且颜色就是机身设定下的效果。信息面板会标注预览图分辨率是否为全尺寸。

> 这意味着一张 RAW 若不含内嵌预览（极少见），会提示读取失败而不是显示黑图。

## 实现要点

- **零原生依赖**：自己写的 TIFF/IFD 解析器定位内嵌 JPEG，走 SubIFD 和尼康 MakerNote 的 PreviewIFD；CR3/RAF 这类非 TIFF 容器用扫描 SOI/EOI 兜底。EXIF（机身、镜头、光圈快门 ISO、方向）同一套解析出来。
- **只读需要的字节**：先读 1MB 头部解析结构，再按精确字节范围取预览，不整读几十 MB 的 RAW。
- **大图秒开**：看过和预取过的大图连同解码结果留在内存（LRU 6 张），停下来时自动预取前后几张；网格里选中一张也会提前备好。实测翻页 1–20ms，不再有「黑屏→模糊→清晰」的过程。
- **解码不卡界面**：Rust 侧只做 I/O（且全部离开主线程），解码和缩放放在 Web Worker 里，缩略图按 `路径+修改时间+大小+边长+烘焙版本` 缓存到磁盘（上限 800MB，超限时按写入时间淘汰 —— Windows 默认不更新 atime，拿访问时间排序等于随机排序）。
- **横竖构图自适应**：竖拍照片一律按竖幅显示。这里有个坑——浏览器的两个解码器行为不一致（`<img>` 认 CSS `image-orientation`，`createImageBitmap` 的 `imageOrientation:'none'` 却不生效，照样按 EXIF 转）。所以由主进程判断「这段 JPEG 字节自己带不带 EXIF 方向」：带的话解码器会自己转，渲染层就不再转；不带的话（RAW 抠出来的预览通常如此）才按 RAW 主 IFD 的方向补上。转两次就会把竖图转成横图。
- **网格虚拟滚动**：只渲染可视区域的卡片，几千张照片也不卡。

## 目录结构

```
src-tauri/src/   Rust 后端
  tiff.rs          TIFF/EXIF 解析器（无依赖）
  preview.rs       预览图提取策略 + 方向归属判定 + 分析结果缓存
  scan.rs          文件夹扫描 + RAW/JPG 配对
  fav.rs           收藏清单读写
  thumbs.rs        缩略图磁盘缓存
  settings.rs      设置 / 最近打开 / 选片进度
  lib.rs           IPC 命令层（全部走 spawn_blocking，不占主线程）
src/renderer/    界面（原生 ESM，无框架）
  tauri-bridge.js  Tauri IPC → window.pv 适配层
src/main/        Electron 版主进程（已停用，保留作参照实现）
test/            Electron 时期的端到端脚本（需要 electron，已不在 CI 里跑）
```

## 测试

```bash
npm test                   # Rust 单测：解析器 / 候选选择 / 路径穿越 / 缓存键
cargo test --manifest-path src-tauri/Cargo.toml
```

测试素材 `test-photos/` 里专门放了带 EXIF 方向标签的竖拍 JPEG（`ZS_*`，方向 3/6/8）和内嵌预览不带 EXIF 的 NEF，两条方向路径都能覆盖到。
