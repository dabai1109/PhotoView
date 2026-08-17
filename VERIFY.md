# PhotoView Tauri 2 迁移：改动清单与验证指南

> **交接文档 · 已部分验证**（更新于 2026-08-17）
>
> Rust 侧已全部跑通：`cargo test --lib` 28 项全绿、`cargo clippy --all-targets` 0 警告、
> `cargo build --release` 链接通过（3m35s，`photoview.exe` 6.84 MB）、
> 集成测试 `tests/fixtures.rs` 2 项全绿。
> **仍未验证的是运行时/前端部分** —— 见第 4 节标 ⏳ 的条目，需要在跑起来的窗口里确认。

- 目标平台：Windows 11（主），macOS（CI 也构建）
- 技术栈：Tauri 2 + 原生 ESM 前端（无框架）+ Rust 后端
- 前置：Rust stable 工具链、Node 20+

---

## 1. 背景：这是什么项目

摄影师选片工具。原来是 Electron 应用（`src/main/` + `src/renderer/`），
最近迁移到 Tauri 2（新增 `src-tauri/`）。迁移后做了一次 code review，
发现 21 个问题并全部修改，就是这份文档要验证的内容。

**核心设计：RAW 不解码。** 尼康 NEF 等 RAW 内部有相机生成的内嵌 JPEG 预览，
解析 TIFF/IFD 结构定位到它的字节范围，直接把这段 JPEG 交给浏览器解码。
比解 RAW 快一到两个数量级（Photo Mechanic 的做法）。

### 目录

```
src-tauri/src/
  tiff.rs        【新增】TIFF/EXIF 解析器，从 src/main/tiff.js 移植
  thumbs.rs      【新增】缩略图磁盘缓存，从 src/main/thumbs.js 移植
  preview.rs     【重写】预览提取策略 + 方向归属判定 + 分析结果缓存
  scan.rs        【重写】文件夹扫描 + RAW/JPG 配对
  fav.rs         【重写】收藏清单读写
  settings.rs    【重写】设置 / 最近打开 / 选片进度
  types.rs       【重写】IPC 数据结构
  lib.rs         【重写】IPC 命令层
  main.rs        未改
src-tauri/capabilities/default.json   【新增】
src/renderer/
  tauri-bridge.js   【重写】Tauri IPC → window.pv 适配层
  index.html        【改 1 行】CSP
  app.js            ❌ 未改，也不允许改（见第 2 节）
  decode-worker.js  ❌ 未改，也不允许改
src/main/          Electron 版主进程，已停用，保留作参照实现
test/              Electron 时期的 e2e 脚本，需要 electron，已不在 CI
test-photos/       测试素材
```

看完整 diff：

```bash
git status
git diff
# 新增未跟踪文件：src-tauri/src/tiff.rs, src-tauri/src/thumbs.rs, src-tauri/capabilities/
```

---

## 2. 不可破坏的契约

`app.js`（1200+ 行 UI 逻辑）和 `decode-worker.js` 是**冻结**的。
迁移的全部适配都在 `tauri-bridge.js` 这一层完成。
如果发现 Rust 返回的形状和 app.js 期望的不一致，**改 Rust 或 bridge，不要改 app.js**。

### 2.1 `pv.preview(file, kind, box)` 的返回形状

app.js 里这两处决定了契约（**改动前正是这里挂掉的**）：

```js
// app.js:104  —— r.data 必须是 TypedArray，不是字符串
const buf = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength);

// app.js:170  —— 直接塞进 Blob
const blob = new Blob([r.data], { type: r.mime || 'image/jpeg' });
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | bool | 失败时 app.js 读 `error` |
| `data` | **`Uint8Array`** | 原始 JPEG/PNG 字节。**不是 base64，不是 data URI** |
| `mime` | string | `image/jpeg` 等 |
| `cached` | bool | true = `data` 已是烤好的缩略图（转过向、缩过放），渲染层直接用 |
| `orientation` | 1–8 | **渲染层还需要补的旋转**。解码器已经转过的部分不重复算 |
| `exifOrientation` | 1–8 | 真实 EXIF 方向，信息面板显示用 |
| `storeW` / `storeH` | u32 | 文件里**存储**的尺寸，worker 缩放要用 |
| `width` / `height` | u32 | **解码后**（屏幕上）的尺寸，方向 5–8 时与 store 相反 |
| `exif` | object | 见 2.2 |
| `fileSize` | u64 | |

`orientation` 的判定逻辑是这个项目最容易错的地方，见 `src-tauri/src/preview.rs`
里 `raw_preview()` 的注释，和 `src/main/preview.js:214-229`（参照实现）：

- **相机直出 JPEG**：自带 EXIF 方向 → 浏览器解码器会自己转 → `orientation = 1`
- **RAW 抠出来的内嵌预览**：通常不带 EXIF → 解码器不会转 → `orientation = RAW 主 IFD 的方向`
- 少数机型的内嵌预览自带方向标签 → 解码器会转 → `orientation = 1`

**转两次就会把竖图转成横图。**

### 2.2 `exif` 的字段名

app.js:721-729 读的是这些名字，且值是**已经格式化好的字符串**：

```
make, model, lens,
shutter    "1/250s"      aperture  "f/1.8"
iso        "ISO 400"     focal     "35mm"      focal35  "52mm"
ev         "+0.3 EV"     date      "2024-05-12 10:31:22"
orientation (数字 1-8)   pixelX / pixelY (数字)
```

⚠️ 改动前 `types.rs` 用的是 `fNumber` / `exposure`，前端根本不读，
所以信息面板的光圈和快门一直是空的。这是本次修复项 #21。

### 2.3 图片字节的传输协议（本次新引入）

图片字节**不走 JSON**。走 base64 的话 `r.data.buffer` 会直接 undefined，
而且 20MB 的预览要多传 33% 并额外做一次大字符串 JSON 编解码。

```
前端 bridge                          Rust
  invoke('get_preview')      →   返回元数据 + 一次性 token（不含字节）
  invoke('take_preview_bytes')→   tauri::ipc::Response(Vec<u8>) 原始二进制
  拼成 meta.data = Uint8Array
```

- token 是**一次性**的，`take_bytes()` 取走即释放
- 前端不取会挂在 Rust 侧，靠 64 条上限兜底淘汰（`preview.rs` 的 `PENDING_MAX`）
- 这是本次改动**风险最高**的一处，见第 4 节 A

---

## 3. 验证步骤

### 3.1 编译与单测（先做这个，其它都依赖它）

```bash
cd src-tauri
cargo test --lib          # 28 个单测
cargo clippy --all-targets
```

28 个单测的分布：

| 模块 | 数量 | 覆盖 |
|---|---|---|
| `tiff.rs` | 7 | SOF0 解析、跳过 APP1 内嵌缩略图、垃圾数据不死循环不 panic、畸形 TIFF、方向交换、数字格式化 |
| `preview.rs` | 7 | full 取最大 / thumb 取「≥900 里最小」/ 无尺寸时按字节数排序 / token 一次性 / 缺文件报错 / mime |
| `thumbs.rs` | 3 | 缓存键随每个输入变化、路径大小写不敏感、box=0 不缓存 |
| `settings.rs` | 4 | 默认值完整、**路径穿越被拦**、session 键稳定、哈希格式 |
| `fav.rs` | 5 | **路径穿越被夹回 root**、JSON 识别、缺文件、去重且保序 |
| `scan.rs` | 2 | 扩展名判定、缺目录不 ok |

**预期**：全绿。如果编译不过，最可能的位置见第 4 节 H。

### 3.2 跑起来

```bash
npm install
npm run tauri:dev
```

打开仓库自带的 `test-photos/`（29 个文件，含合成 NEF、RAW+JPG 配对、
子目录 `第二机位/`、以及三张带方向标签的竖拍 JPEG）。

### 3.3 逐项验收

按严重程度排，前 5 项是「改动前应用完全不可用」的问题。

| # | 验收点 | 怎么看 | 改动前的症状 |
|---|---|---|---|
| 1 | **缩略图能出图** | 网格里 24 组照片都有图，不是灰块 | 全空。`r.data` 是字符串 → `.buffer` undefined → TypeError 被 `catch {}` 吞掉 |
| 1 | **大图能出图** | 双击进大图，图片正常 | 裂图。Blob 里装的是 `data:image/jpeg;base64,...` 这串 ASCII 文本 |
| 2 | **无 CSP 报错** | DevTools Console 全程无 `Refused to connect` | 所有 invoke 被拦，白屏 |
| 3 | **扫描不冻界面** | 扫描时窗口能拖动、能响应 | 主线程被占满，整个窗口冻住 |
| 4 | **竖拍方向正确** | `ZS_1_竖拍o6` `ZS_2_竖拍o8` `ZS_3_竖拍o3` 三张在网格和大图里都是竖的 | 所有竖拍横着显示 |
| 5 | **拖拽能打开** | 从资源管理器拖一个文件夹进窗口 | 完全无反应 |
| 6 | RAW 无预览时报错 | 需要一个不含内嵌预览的 RAW | 返回整个 RAW 当 JPEG，40MB 白传 + 解码失败 |
| 7 | 大 RAW 不卡 | 打开一张 20MB+ 的真实 NEF，秒开 | 暴力扫 30MB，最坏 O(n²) |
| 8 | 尺寸正确 | 信息面板「尺寸」和「预览图」两行合理 | 可能读到 EXIF 缩略图的 160×120 |
| 9 | **二次打开秒开** | 关掉重开同一目录，网格瞬间出图 | 磁盘缩略图缓存整个丢了 |
| 10 | 「在资源管理器中显示」 | 对**路径带空格**的照片用一次 | 打开「文档」目录而不是选中文件 |
| 11 | 路径穿越被拦 | 单测覆盖；也可手动把设置里 `favoritesFileName` 改成 `../../x.txt` | 可写到相册目录外 |
| 12 | 配置健壮 | 手动删掉 settings.json 里几个 key，重启仍正常 | 缺 key 时默认值不生效 |
| 13 | 删除语义 | 手动在应用外删掉一张的 JPG，再在应用内删这一组 | 「一个都没删」也报成功 |
| 14 | 点开头的目录能扫 | 把 test-photos 复制成 `.photos` 再打开 | 整个扫描返回空 |
| 15 | 体积 | `cargo build --release` 后看安装包 | 4 个没用的插件 + kamadak-exif 白编译 |
| 16 | capabilities | 启动无权限报错 | `gen/schemas/capabilities.json` 是 `{}` |
| 17 | 产物 | Windows 只出 NSIS，不再多一个 MSI | `targets: "all"` |
| 18 | **CI 不乱发布** | push 到 main 时只构建不发 release | 每次 push main 都创建一个 tag 叫 `main` 的正式 release |
| 19 | npm 干净 | `npm ci` 不再下载 Electron | 还带着 electron + electron-builder |
| 20 | 版本单源 | 构建产物版本是 1.0.0 | 三处手动同步 |
| 21 | **光圈快门有值** | 大图按 `I` 开信息面板，光圈/快门两行不为空 | 一直是空的（字段名对不上） |

### 3.4 和参照实现交叉验证（强烈建议）

`src/main/tiff.js` 是经过验证的 JS 参照实现，`test/parser.test.js` 有 19 项针对它的单测。
Rust 版是移植的，**两边在同一批文件上的输出应该一致**。

```bash
node test/parser.test.js      # 参照实现的输出，记下来
```

然后放一个 Rust 集成测试对比。把下面这段存成 `src-tauri/tests/fixtures.rs`：

```rust
//! 跑一遍 test-photos/，把关键结论打出来，和 node test/parser.test.js 对比
use photoview_lib::preview;
use std::path::{Path, PathBuf};

fn photos() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("test-photos")
}

#[test]
fn dump_every_fixture() {
    let dir = photos();
    assert!(dir.is_dir(), "找不到 test-photos: {}", dir.display());

    let mut files: Vec<PathBuf> = walk(&dir);
    files.sort();

    let mut failed = Vec::new();
    for f in &files {
        let s = f.to_string_lossy().to_string();
        for kind in ["thumb", "full"] {
            let r = preview::get_preview(&s, kind, 0);
            let bytes = r.token.and_then(preview::take_bytes).unwrap_or_default();
            println!(
                "{:<28} {:<5} ok={} bytes={:>8} store={}x{} disp={}x{} orient={} exifOrient={} err={:?}",
                f.file_name().unwrap().to_string_lossy(),
                kind, r.ok, bytes.len(),
                r.store_w, r.store_h, r.width, r.height,
                r.orientation, r.exif_orientation, r.error,
            );
            if r.ok {
                // 拿到的必须是真的 JPEG/PNG，不能是原始 RAW 字节
                assert!(bytes.len() > 128, "{} {} 字节太少", s, kind);
                let is_jpeg = bytes[0] == 0xFF && bytes[1] == 0xD8;
                let is_png = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
                assert!(is_jpeg || is_png, "{} {} 不是有效图片头", s, kind);
            } else {
                failed.push(format!("{} ({}) -> {:?}", s, kind, r.error));
            }
        }
    }
    // test-photos 里每个文件都应该能出预览
    assert!(failed.is_empty(), "这些没能出预览：\n{}", failed.join("\n"));
}

/// 三张 ZS_* 是专门为方向测试造的，文件名末尾就是期望的 EXIF 方向
#[test]
fn portrait_jpegs_report_their_exif_orientation() {
    for (name, want) in [
        ("ZS_1_竖拍o6.JPG", 6u32),
        ("ZS_2_竖拍o8.JPG", 8),
        ("ZS_3_竖拍o3.JPG", 3),
    ] {
        let p = photos().join(name);
        if !p.exists() {
            continue;
        }
        let r = preview::get_preview(&p.to_string_lossy(), "full", 0);
        let _ = r.token.and_then(preview::take_bytes);
        assert!(r.ok, "{} 读取失败: {:?}", name, r.error);
        assert_eq!(r.exif_orientation, want, "{} 的 exifOrientation 不对", name);
        // 相机直出 JPEG 自带方向标签，解码器会自己转 → 渲染层不能再转
        assert_eq!(r.orientation, 1, "{} 的 orientation 应该是 1", name);
        // 方向 5-8 时，解码后的尺寸要和存储尺寸相反
        if (5..=8).contains(&want) {
            assert_eq!((r.width, r.height), (r.store_h, r.store_w), "{} 宽高该交换", name);
        } else {
            assert_eq!((r.width, r.height), (r.store_w, r.store_h), "{} 宽高不该交换", name);
        }
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| photoview_lib::scan::is_supported_ext(x))
            .unwrap_or(false)
        {
            out.push(p);
        }
    }
    out
}
```

跑：

```bash
cargo test --test fixtures -- --nocapture
```

⚠️ **test-photos 的覆盖缺口（已实测确认）**：

1. **RAW 竖拍那条路径是覆盖到的** —— 实测 `DSC_0005.NEF`(orient=8)、`DSC_0008.NEF`(orient=3)、
   `DSC_0011.NEF`(orient=6)、`收藏/B_2.NEF`(orient=6) 都返回了 `orientation == exifOrientation != 1`，
   即「内嵌预览不带 EXIF → 渲染层要自己转」。这正是修复项 #4 最关键的分支，改动前它恒为 1。
2. **thumb / full 的候选选择没被端到端覆盖** —— 看 `test/make-fixtures.js` 的 `buildNef()`：
   合成 NEF 里只有 `ifdPrev`（compression=6 + tag 0x0201/0x0202）会产出预览候选，
   `ifd0` 没有 JPEG offset/length，`ifdRaw` 的 compression 是 34713（尼康 RAW）。
   **每个 fixture 只有一张内嵌预览**，所以 thumb 和 full 必然返回同一份字节
   （实测输出里两行的 bytes 和尺寸完全一致，这是符合预期的，不是 bug）。
   真机 NEF 通常有 2–3 张预览（160×120 / 1620×1080 / 全尺寸），
   `candidate_order()` 的选择逻辑目前只由 `preview.rs` 的 3 个单测覆盖。
   **想端到端验证修复项 #9，需要一张真实相机出的 NEF。**

---

## 4. 待验证的高风险假设

这些是在没法编译的情况下做的判断。当前状态：

| | 项 | 状态 |
|---|---|---|
| A | `tauri::ipc::Response` 到 JS 的类型 | ⏳ 需在 Console 里确认 |
| B | CSP 值是否正确且够用 | ⏳ 需看 DevTools 有无 CSP 报错 |
| C | camelCase → snake_case 参数映射 | ⏳ 需实际 invoke 一次 |
| D | `"version": "../package.json"` | ✅ tauri-build 在编译期解析成功 |
| E | capabilities 的窗口标签 | ✅ `gen/schemas/capabilities.json` 已从 `{}` 变成含本 capability |
| F | `bundle.targets` | ⏳ 需跑 `npm run tauri:build` |
| G | release profile（LTO） | ✅ 链接通过，3m35s，exe 6.84 MB |
| H | 借用检查的两处 | ✅ 编译通过 |
| I | rfd 在 spawn_blocking 里弹对话框 | ⏳ Windows 上已能选目录（见下）；macOS 未验 |
| J | 拖放事件 payload 形状 | ⏳ 需实际拖一次 |
| K | explorer.exe `/select` 引号 | ⏳ 需用路径带空格的照片测 |

运行时已经**间接确认**的（从 `test-photos/` 被改动的痕迹反推）：

- **删除到回收站可用** —— `DSC_0001.JPG` / `DSC_0003.JPG` / `DSC_0003.NEF` 确实进了系统回收站
- **收藏写入可用** —— `test-photos/favorites.txt` 被创建，内容是 `DSC_0004.JPG` + `DSC_0005.NEF`
- **选目录可用** —— 能打开 test-photos 才谈得上前两条

各条的验证方法见下。

### A. `tauri::ipc::Response` 到 JS 侧的类型

`lib.rs` 的 `take_preview_bytes` 返回 `tauri::ipc::Response::new(Vec<u8>)`。
我假设 JS 侧收到 `ArrayBuffer`。bridge 里 `toBytes()` 对
`Uint8Array` / `ArrayBuffer` / 其它 TypedArray / `number[]` 都做了兜底。

**怎么验**：DevTools Console 里

```js
const m = await window.__TAURI__.core.invoke('get_preview',
  { file: 'D:/MyProject/claw/PhotoView/test-photos/DSC_0001.JPG', kind: 'full', boxSize: 0 });
console.log(m.ok, m.token, m.mime, m.storeW, m.storeH, m.orientation, m.exifOrientation);
const b = await window.__TAURI__.core.invoke('take_preview_bytes', { token: m.token });
console.log(b.constructor.name, b.byteLength ?? b.length);
const u8 = b instanceof ArrayBuffer ? new Uint8Array(b) : b;
console.log('SOI:', u8[0].toString(16), u8[1].toString(16));  // 期望 ff d8
```

如果 `b` 不是 ArrayBuffer/TypedArray 而是别的东西，改 `tauri-bridge.js` 的 `toBytes()`。

### B. CSP 值是否正确且够用

`src/renderer/index.html:5` 和 `src-tauri/tauri.conf.json` 的 `app.security.csp`
都加了 `connect-src 'self' ipc: http://ipc.localhost`。

依据是 `node_modules/@tauri-apps/api/core.js:207` 的注释里给的示例值。
**没有实际见过它报错**，所以「改动前 CSP 挡死 IPC」这个判断本身也需要确认
（可以 `git stash` 回去看是不是真的白屏 + Console 报 CSP）。

注意：meta 标签的 CSP 和 header 的 CSP 会取**交集**，两边都必须放行 ipc。

### C. camelCase → snake_case 参数映射

bridge 发 `boxSize`、`favList`，Rust 侧是 `box_size`、`fav_list`。
我假设 Tauri 2 自动转换。如果不转，invoke 会抛 `missing required key box_size`。

（`box` 是 Rust 关键字，不能直接用作参数名，所以这里必须是 `box_size`。）

### D. `"version": "../package.json"`

`tauri.conf.json` 改成从 package.json 读版本号，消除三处手动同步。
确认构建不报 schema 错、产物版本是 1.0.0。

### E. capabilities 的窗口标签

`capabilities/default.json` 写的是 `"windows": ["main"]`。
`tauri.conf.json` 的 `app.windows[0]` 没有显式 `label`，我假设默认就是 `main`。
如果启动报权限错，检查这里。

### F. `bundle.targets: ["nsis", "app", "dmg"]`

从 `"all"` 改过来（原来 Windows 上会多产一个 MSI）。
确认 Windows 构建不会因为列表里有 `dmg`/`app` 而报错。

### G. release profile

新加了 `opt-level = "s"`、`lto = true`、`codegen-units = 1`、`strip = true`，
配合 `crate-type = ["staticlib", "cdylib", "rlib"]`。确认能链接通过。
没有加 `panic = "abort"`（怕影响依赖里的 `catch_unwind`）。

### H. 借用检查最可能出问题的两处

1. `preview.rs` 的 `analyze_raw()`：`src` 借用了 `full`（`full.as_deref()`），
   之后 `full` 被 move 进 `RawAnalysis { buffer: full }`。
   靠 NLL 判定 `src` 的借用在补全尺寸的循环之后就结束了。
2. `tiff.rs` 的 `Walker::collect()`：`self.previews.push(...)` 时参数里不能再借 `&self`
   —— 已经把 width/height 提前算成局部变量了。同一文件 `to_exif()` 里
   date 那个闭包也调整过（避免借用后 move）。

### I. rfd 在 `spawn_blocking` 里弹对话框

`open_folder_dialog` 现在在 `spawn_blocking` 里调 `rfd::FileDialog::pick_folder()`。
Windows 上 rfd 自己处理 COM 初始化，应该没问题。
**macOS 要单独确认**：blocking 对话框从非主线程调用会不会 panic 或卡死。

已知小瑕疵：rfd 没有 `set_parent`，对话框可能不是模态、可能出现在主窗口后面。
（这和改动前行为一致，不是回归。想修就用 `tauri-plugin-dialog`，
但那要把这个依赖加回来。）

### J. 拖放事件的 payload 形状

`tauri-bridge.js` 监听 `tauri://drag-enter` / `drag-leave` / `drag-drop`，
假设 drop 的 payload 是 `{ paths: string[], position: {...} }`，
然后**合成** app.js 已经在监听的 DOM 事件：

- `dragenter`，带 `dataTransfer = { types: ['Files'] }`（app.js:1123 要读 `types.includes('Files')`）
- `drop`，带 `dataTransfer = { files: [{ path }, ...] }`（app.js:1142 要走 `pv.pathForFile(f)`）

**怎么验**：Console 里 `window.__TAURI__.event.listen('tauri://drag-drop', e => console.log(e.payload))`
然后拖一个文件夹进来，看 payload 结构对不对。

### K. explorer.exe 的 `/select` 引号

`reveal_in_explorer` 在 Windows 上用了 `CommandExt::raw_arg`
传 `/select,"C:\有 空格的\路径\a.jpg"`。必须用**路径里真的带空格**的照片测一次。
走 `.arg()` 的话 Rust 会再包一层引号，explorer 解析不了，会打开「文档」目录。

---

## 5. 未解决的线上问题：删除失败

用户在真实素材上遇到的报错（**改动前**的版本）：

```
删除失败: Error during a trash operation: CanonicalizePath (original: "H:\照片\nikon\2026-07-04尼康现场\...")
```

### 分析

`trash::delete()` 在 Windows 上第一步是 `std::fs::canonicalize(path)`，
失败就抛 `CanonicalizePath`，**把真正的原因整个吞掉**。

而 `fs::canonicalize` 在 Windows 上必须**真正打开文件**
（`CreateFileW` + `GetFinalPathNameByHandleW`）。关键在于 `Path::exists()`
**不需要**打开文件 —— Rust 的 Windows `metadata` 在 `CreateFileW` 失败时
会退回用 `FindFirstFileW` 读属性。所以「`exists()` 说在、`canonicalize()` 打不开」
是完全可能的，代码里原有的 `p.exists()` 检查拦不住它。

「看得见但打不开」的可能原因，按可能性排：

1. **云盘占位文件** —— OneDrive / 坚果云 / 百度网盘的「仅在线」文件，
   打开触发回源下载，失败或超时就是这个错。`H:\照片\` 这种独立盘符很符合
2. **路径超长** —— `2026-07-04尼康现场` 这类中文目录名加上原文件名容易顶到 260 字符
3. **被别的程序独占** —— Lightroom / Bridge / 杀毒软件 / 备份软件
4. 权限问题，或外置盘 / NAS 掉线

有个线索能缩小范围：app.js:903 只在**整组文件全部失败**时才弹这个 toast
（`!r.ok && !r.done.length`）。如果这张是 NEF+JPG 配对且两个都挂了，
更像是目录层面的问题（1/2/4），而不是单个文件被某个看图软件锁住。

### 已做的改动

`lib.rs` 的 `trash_files` 现在删除前自己先 canonicalize 一次，
把真正的系统错误捞出来（原因写在前面，因为 toast 会截断）：

- `系统打不开这个文件：另一个程序正在使用此文件… — H:\...` → 被占用
- `系统打不开这个文件：拒绝访问。 — H:\...` → 权限 / 云盘占位
- `系统打不开这个文件（路径长 287 字符，已接近 Windows 260 上限）：…` → 路径超长

**这不是把删除修好了**，是把哑错误变成能定位的错误。
真正的修法取决于是哪一种，需要拿到新的报错文本才能定。

### 请协助确认

在出问题的目录上跑（`Attributes` 里出现 `Offline` / `RecallOnOpen` /
`RecallOnDataAccess` 就是云盘占位）：

```powershell
Get-ChildItem 'H:\照片\nikon\2026-07-04尼康现场' -File |
  Select-Object -First 5 Name, Length, Attributes | Format-Table -Auto
```

顺便看路径长度：

```powershell
Get-ChildItem 'H:\照片\nikon\2026-07-04尼康现场' -File |
  ForEach-Object { $_.FullName.Length } | Measure-Object -Maximum
```

---

## 6. 另外知道的、这次没动的

- **`Ctrl+Z` 从回收站还原没接**。`tauri-bridge.js` 的 `restore` 直接返回
  `{ok:false, error:'请在系统回收站中手动还原'}`，app.js 会如实提示。
  `trash` crate 有 `os_limited::{list, restore_all}`（Windows/Linux，macOS 没有），
  要接需要 cfg 分平台。README 已经改成如实描述。
- **`setNativeTheme` 是空操作**。标题栏跟随主题需要原生窗口 API，
  配色本身由 CSS 的 `data-theme` 负责，视觉上没影响。
- **`src/main/` 是死代码**。Tauri 只打包 `src/renderer/`（`frontendDist`），
  所以不影响体积。保留作参照实现，`test/parser.test.js` 也还依赖它。
- **`scripts/clean-locales.js`** 是 electron-builder 的 afterPack 钩子，
  随 package.json 的 `build` 段一起失效了，现在没人引用。
- **缩略图缓存按写入时间淘汰**，不是访问时间 —— Windows 默认不更新 atime，
  拿访问时间排序等于随机排序。
- 分组键用了 `dir.to_lowercase()`，在大小写敏感的文件系统（Linux / 部分 macOS）
  上理论上会让两个不同目录撞到一起。Windows 上不是问题。
