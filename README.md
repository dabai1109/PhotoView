# PhotoView · 摄影师选片工具

拖入文件夹 → 快速过片 → 喜欢的按 `F` 进收藏夹，不要的按 `X` 进回收站。专为尼康 RAW 工作流做的 Windows 桌面应用。

## 怎么跑起来

```bash
npm install          # 若 electron 二进制下载卡住：ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
npm start
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
- **删除**：走 Windows 回收站，随时能还原。应用内 `Ctrl+Z` 会调用系统 Shell 接口把文件还原回原位置。
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
- **解码不卡界面**：主进程只做 I/O，解码和缩放放在 4 个 Web Worker 里，缩略图按 `路径+修改时间+大小+烘焙版本` 缓存到磁盘（上限 800MB，按访问时间淘汰）。
- **横竖构图自适应**：竖拍照片一律按竖幅显示。这里有个坑——浏览器的两个解码器行为不一致（`<img>` 认 CSS `image-orientation`，`createImageBitmap` 的 `imageOrientation:'none'` 却不生效，照样按 EXIF 转）。所以由主进程判断「这段 JPEG 字节自己带不带 EXIF 方向」：带的话解码器会自己转，渲染层就不再转；不带的话（RAW 抠出来的预览通常如此）才按 RAW 主 IFD 的方向补上。转两次就会把竖图转成横图。
- **网格虚拟滚动**：只渲染可视区域的卡片，几千张照片也不卡。

## 目录结构

```
src/main/      主进程
  tiff.js        TIFF/EXIF 解析器（无依赖）
  preview.js     预览图提取策略 + 方向归属判定
  scan.js        文件夹扫描 + RAW/JPG 配对
  fileops.js     收藏 / 回收站 / 从回收站还原
  thumbs.js      缩略图磁盘缓存
  store.js       设置与选片进度
src/renderer/  界面（原生 ESM，无框架）
test/
  parser.test.js       解析器单测
  make-fixtures.js     生成测试素材
  smoke.js             端到端跑一遍并截图
  perf.js              大图加载耗时 + 大图方向
  thumb-orientation.js 缩略图方向
```

## 测试

```bash
node test/parser.test.js               # 19 项：解析器 + EXIF + 兜底 + 损坏文件
npx electron test/smoke.js             # 扫描→大图→100%→收藏→删除→撤销还原→筛选，截图到 shots/
npx electron test/perf.js              # 每张大图的加载耗时，以及 25 张的方向逐张核对
npx electron test/thumb-orientation.js # 网格缩略图逐张核对方向
node test/make-fixtures.js             # 重新生成 test-photos/
```

冒烟测试会真的把文件丢进回收站再还原回来，用的是 `test-photos/` 里的素材。测试素材里专门放了带 EXIF 方向标签的竖拍 JPEG（`ZS_*`）和内嵌预览不带 EXIF 的 NEF，两条方向路径都能覆盖到。
