//! 图片预览提取：
//!  - 普通图片（jpg/png/webp/gif/avif/bmp）→ 直接返回文件字节
//!  - RAW（NEF/NRW/CR2/ARW/DNG/PEF/SRW/ORF/RW2…）→ 解析 IFD 定位内嵌 JPEG 预览，按范围读盘
//!  - CR3/RAF 等非 TIFF 容器 → 扫描内嵌 JPEG 兜底
//!
//! 尼康 NEF 通常内嵌一张与原图同尺寸（或 1620×1080）的 JPEG 预览，
//! 直接取它来看片，速度比解码 RAW 快一到两个数量级，也是专业选片软件的做法。
//!
//! 图片字节不放进 JSON 响应，而是暂存在 `PENDING` 里由前端凭 token 以二进制取走。

use crate::scan::is_raw_ext;
use crate::thumbs;
use crate::tiff::{self, Preview};
use crate::types::{ExifData, PreviewResponse};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/// 先读 1MB 头部解析 IFD，绝大多数 RAW 足够
const HEAD_BYTES: u64 = 1024 * 1024;
const MAX_FULL_READ: u64 = 300 * 1024 * 1024;
const ANALYZE_CACHE_MAX: usize = 400;
/// 待取走的图片字节最多挂几份（前端并发上限 ~7，留足余量）
const PENDING_MAX: usize = 64;

// ---------------- 分析结果缓存 ----------------
// 只存偏移表和 EXIF（很小），避免 thumb / full 反复读盘解析。

#[derive(Clone)]
struct Analysis {
    mtime: u64,
    previews: Vec<Preview>,
    exif: ExifData,
}

struct AnalyzeCache {
    map: HashMap<String, Analysis>,
    order: VecDeque<String>,
}

fn analyze_cache() -> &'static Mutex<AnalyzeCache> {
    static C: OnceLock<Mutex<AnalyzeCache>> = OnceLock::new();
    C.get_or_init(|| {
        Mutex::new(AnalyzeCache {
            map: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}

fn cache_get(key: &str, mtime: u64) -> Option<Analysis> {
    let c = analyze_cache().lock().ok()?;
    c.map.get(key).filter(|a| a.mtime == mtime).cloned()
}

fn cache_put(key: String, val: Analysis) {
    if let Ok(mut c) = analyze_cache().lock() {
        if c.map.insert(key.clone(), val).is_none() {
            c.order.push_back(key);
        }
        while c.map.len() > ANALYZE_CACHE_MAX {
            match c.order.pop_front() {
                Some(k) => {
                    c.map.remove(&k);
                }
                None => break,
            }
        }
    }
}

// ---------------- 待取字节 ----------------

struct Pending {
    map: HashMap<u64, Vec<u8>>,
    order: VecDeque<u64>,
    next: u64,
}

fn pending() -> &'static Mutex<Pending> {
    static P: OnceLock<Mutex<Pending>> = OnceLock::new();
    P.get_or_init(|| {
        Mutex::new(Pending {
            map: HashMap::new(),
            order: VecDeque::new(),
            next: 1,
        })
    })
}

fn stash(bytes: Vec<u8>) -> Option<u64> {
    let mut p = pending().lock().ok()?;
    let token = p.next;
    p.next = p.next.wrapping_add(1).max(1);
    p.map.insert(token, bytes);
    p.order.push_back(token);
    // 前端拿完就 take 走；这里只是防止异常路径下无限堆积
    while p.map.len() > PENDING_MAX {
        match p.order.pop_front() {
            Some(k) => {
                p.map.remove(&k);
            }
            None => break,
        }
    }
    Some(token)
}

/// 取走并释放（一次性）
pub fn take_bytes(token: u64) -> Option<Vec<u8>> {
    let mut p = pending().lock().ok()?;
    p.order.retain(|&t| t != token);
    p.map.remove(&token)
}

// ---------------- 读盘工具 ----------------

fn read_upto(f: &mut File, len: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    let mut got = 0usize;
    while got < len {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    buf.truncate(got);
    Ok(buf)
}

fn read_range(path: &Path, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    read_upto(&mut f, len)
}

fn mtime_ms(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------- RAW 分析 ----------------

struct RawAnalysis {
    previews: Vec<Preview>,
    exif: ExifData,
    /// 本次整读进来的 buffer（不进缓存，避免占内存）
    buffer: Option<Vec<u8>>,
}

fn analyze_raw(path: &Path, size: u64) -> std::io::Result<RawAnalysis> {
    let mut f = File::open(path)?;
    let head = read_upto(&mut f, size.min(HEAD_BYTES) as usize)?;

    let mut parsed = tiff::walk_tiff(&head, 0);
    let mut full: Option<Vec<u8>> = None;

    // 只有在解析失败 / 结构被截断 / 一张预览都没找到时才整读文件；
    // 偏移超出头部但结构完整的（真实 NEF 的常态）后面按字节范围定点读取即可
    let needs_full = match &parsed {
        None => true,
        Some(p) => p.truncated || p.previews.is_empty(),
    };

    if needs_full && size <= MAX_FULL_READ {
        f.seek(SeekFrom::Start(0))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        if let Some(p2) = tiff::walk_tiff(&buf, 0) {
            if !p2.previews.is_empty() || parsed.is_none() {
                parsed = Some(p2);
            }
        }
        full = Some(buf);
    }

    let has_full = full.is_some();
    let src: &[u8] = match full.as_deref() {
        Some(b) => b,
        None => &head,
    };

    let mut previews: Vec<Preview> = parsed
        .as_ref()
        .map(|p| p.previews.clone())
        .unwrap_or_default();

    // 校验候选：必须以 SOI 开头。只有头部时越界的先留着，稍后按需读盘校验
    previews.retain(|p| {
        if p.length == 0 {
            return false;
        }
        match p.offset.checked_add(2) {
            Some(end) if end <= src.len() => src[p.offset] == 0xFF && src[p.offset + 1] == 0xD8,
            _ => !has_full,
        }
    });

    // 兜底：CR3 / RAF 等非 TIFF 容器
    if previews.is_empty() {
        if let Some(ref b) = full {
            previews = tiff::scan_jpegs(b);
        }
    }

    // 补全尺寸
    for p in previews.iter_mut() {
        if (p.width == 0 || p.height == 0) && p.offset + 4 < src.len() {
            let end = p.offset.saturating_add(p.length).min(src.len());
            if let Some((w, h)) = tiff::jpeg_size(src, p.offset, end) {
                p.width = w;
                p.height = h;
            }
        }
    }

    let exif = tiff::to_exif(parsed.as_ref());
    Ok(RawAnalysis {
        previews,
        exif,
        buffer: full,
    })
}

// ---------------- 候选排序 ----------------

/// 排序用的“大小”：优先长边，没尺寸信息时用字节数近似
fn rank(p: &Preview) -> f64 {
    let long = p.width.max(p.height);
    if long > 0 {
        long as f64
    } else {
        p.length as f64 / 1000.0
    }
}

/// full 从大到小；thumb 优先长边 ≥900 的最小一张（解码快），失败再退而求其次
fn candidate_order(previews: &[Preview], kind: &str) -> Vec<Preview> {
    let mut sorted = previews.to_vec();
    sorted.sort_by(|a, b| rank(a).partial_cmp(&rank(b)).unwrap_or(std::cmp::Ordering::Equal));

    if kind == "full" {
        return sorted.into_iter().rev().collect();
    }
    match sorted.iter().position(|p| p.width.max(p.height) >= 900) {
        Some(idx) => {
            let mut v: Vec<Preview> = sorted[idx..].to_vec();
            v.extend(sorted[..idx].iter().rev().cloned());
            v
        }
        None => sorted.into_iter().rev().collect(),
    }
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

// ---------------- 入口 ----------------

/// `kind`: "thumb" 取够用的最小预览（快），"full" 取最大预览（清晰）
/// `box_size`: 缩略图边长，用于命中磁盘缓存；full 传 0
pub fn get_preview(file_path_str: &str, kind: &str, box_size: u32) -> PreviewResponse {
    let p = Path::new(file_path_str);
    let md = match fs::metadata(p) {
        Ok(m) if m.is_file() => m,
        _ => return PreviewResponse::err("文件不存在", None, 0),
    };
    let file_size = md.len();
    let kind = if kind == "full" { "full" } else { "thumb" };

    // 1) 磁盘缩略图缓存：字节已经是烤好的缩略图，直接给前端
    if kind == "thumb" {
        if let Some(bytes) = thumbs::get(file_path_str, box_size) {
            if let Some(token) = stash(bytes) {
                return PreviewResponse {
                    ok: true,
                    cached: true,
                    token: Some(token),
                    mime: Some("image/jpeg".to_string()),
                    orientation: 1,
                    exif_orientation: 1,
                    file_size,
                    ..Default::default()
                };
            }
        }
    }

    let ext = p
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !is_raw_ext(&ext) {
        return plain_preview(p, &ext, file_size);
    }
    raw_preview(p, file_path_str, &md, file_size, kind)
}

/// 普通图片：整读文件交给浏览器解码
fn plain_preview(p: &Path, ext: &str, file_size: u64) -> PreviewResponse {
    let data = match fs::read(p) {
        Ok(d) => d,
        Err(e) => return PreviewResponse::err(e.to_string(), None, file_size),
    };

    let mut exif = ExifData {
        orientation: 1,
        ..Default::default()
    };
    if matches!(ext, "jpg" | "jpeg" | "jpe") {
        if let Some(r) = tiff::exif_from_jpeg(&data) {
            exif = tiff::to_exif(Some(&r));
        }
        if exif.pixel_x.is_none() {
            if let Some((w, h)) = tiff::jpeg_size(&data, 0, data.len()) {
                exif.pixel_x = Some(w);
                exif.pixel_y = Some(h);
            }
        }
    }

    // 相机直出 JPEG 自带方向标签，解码器会自己转 → 渲染层不要再转
    let self_o = exif.orientation;
    let store_w = exif.pixel_x.unwrap_or(0);
    let store_h = exif.pixel_y.unwrap_or(0);
    let token = match stash(data) {
        Some(t) => t,
        None => return PreviewResponse::err("预览缓存不可用", Some(exif), file_size),
    };

    PreviewResponse {
        ok: true,
        cached: false,
        token: Some(token),
        mime: Some(mime_for(ext).to_string()),
        orientation: 1, // 解码器已经处理，渲染层无需额外旋转
        exif_orientation: self_o,
        store_w,
        store_h,
        width: if tiff::swaps(self_o) { store_h } else { store_w },
        height: if tiff::swaps(self_o) { store_w } else { store_h },
        exif: Some(exif),
        file_size,
        error: None,
    }
}

fn raw_preview(
    p: &Path,
    file_path_str: &str,
    md: &fs::Metadata,
    file_size: u64,
    kind: &str,
) -> PreviewResponse {
    let mtime = mtime_ms(md);
    let key = file_path_str.to_lowercase();

    // 本次分析时整读进来的 buffer（命中缓存时为 None → 走定点读盘）
    let mut fresh: Option<Vec<u8>> = None;
    let analysis = match cache_get(&key, mtime) {
        Some(a) => a,
        None => {
            let r = match analyze_raw(p, file_size) {
                Ok(r) => r,
                Err(e) => return PreviewResponse::err(e.to_string(), None, file_size),
            };
            fresh = r.buffer;
            let a = Analysis {
                mtime,
                previews: r.previews,
                exif: r.exif,
            };
            cache_put(key, a.clone());
            a
        }
    };

    if analysis.previews.is_empty() {
        return PreviewResponse::err(
            "该文件中没有找到可用的内嵌预览图",
            Some(analysis.exif),
            file_size,
        );
    }

    for chosen in candidate_order(&analysis.previews, kind) {
        // 优先从已经在内存里的 buffer 切，否则按范围读盘
        let data = match fresh.as_ref().and_then(|fr| {
            let end = chosen.offset.checked_add(chosen.length)?;
            fr.get(chosen.offset..end).map(|s| s.to_vec())
        }) {
            Some(d) => d,
            None => {
                let avail = file_size.saturating_sub(chosen.offset as u64) as usize;
                let len = chosen.length.min(avail);
                if len < 128 {
                    continue;
                }
                match read_range(p, chosen.offset as u64, len) {
                    Ok(d) => d,
                    Err(_) => continue,
                }
            }
        };

        // 必须是完整 JPEG，否则换下一个候选
        if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
            continue;
        }

        let (mut width, mut height) = (chosen.width, chosen.height);
        if width == 0 || height == 0 {
            if let Some((w, h)) = tiff::jpeg_size(&data, 0, data.len()) {
                width = w;
                height = h;
            }
        }

        // 内嵌预览一般不带 EXIF（解码器不会转）→ 渲染层按 RAW 主 IFD 的方向自己转；
        // 少数机型的预览自带方向标签（解码器会转）→ 渲染层就不要再转了
        let self_o = tiff::self_orientation(&data);
        let true_o = analysis.exif.orientation;
        let decoder_rotates = self_o != 1;
        let flipped = decoder_rotates && tiff::swaps(self_o);

        let token = match stash(data) {
            Some(t) => t,
            None => continue,
        };

        return PreviewResponse {
            ok: true,
            cached: false,
            token: Some(token),
            mime: Some("image/jpeg".to_string()),
            orientation: if decoder_rotates { 1 } else { true_o },
            exif_orientation: true_o,
            store_w: width,
            store_h: height,
            width: if flipped { height } else { width },
            height: if flipped { width } else { height },
            exif: Some(analysis.exif.clone()),
            file_size,
            error: None,
        };
    }

    PreviewResponse::err(
        "内嵌预览图读取失败（数据校验不通过）",
        Some(analysis.exif),
        file_size,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pv(w: u32, h: u32, len: usize) -> Preview {
        Preview {
            offset: 0,
            length: len,
            width: w,
            height: h,
        }
    }

    #[test]
    fn full_picks_largest_first() {
        let list = vec![pv(800, 600, 10), pv(6000, 4000, 90), pv(1620, 1080, 40)];
        let order = candidate_order(&list, "full");
        assert_eq!(order[0].width, 6000);
        assert_eq!(order[2].width, 800);
    }

    /// thumb 要的是"够用的最小一张"：≥900 里最小的那张排第一
    #[test]
    fn thumb_picks_smallest_over_900() {
        let list = vec![pv(160, 120, 5), pv(6000, 4000, 90), pv(1620, 1080, 40)];
        let order = candidate_order(&list, "thumb");
        assert_eq!(order[0].width, 1620);
        assert_eq!(order[1].width, 6000);
        // 都试完了才轮到不够大的
        assert_eq!(order[2].width, 160);
    }

    /// 一张都不够 900 时，退而求其次从大到小
    #[test]
    fn thumb_falls_back_to_largest() {
        let list = vec![pv(160, 120, 5), pv(320, 240, 8)];
        let order = candidate_order(&list, "thumb");
        assert_eq!(order[0].width, 320);
        assert_eq!(order[1].width, 160);
    }

    /// 没有尺寸信息时用字节数排序，不能 panic
    #[test]
    fn rank_falls_back_to_byte_length() {
        let list = vec![pv(0, 0, 500_000), pv(0, 0, 20_000)];
        let order = candidate_order(&list, "full");
        assert_eq!(order[0].length, 500_000);
        assert!(candidate_order(&[], "full").is_empty());
    }

    #[test]
    fn token_is_one_shot() {
        let t = stash(vec![1, 2, 3]).unwrap();
        assert_eq!(take_bytes(t), Some(vec![1, 2, 3]));
        assert_eq!(take_bytes(t), None);
    }

    #[test]
    fn missing_file_reports_error() {
        let r = get_preview("Z:/definitely/not/here.nef", "thumb", 220);
        assert!(!r.ok);
        assert!(r.token.is_none());
        assert!(r.error.is_some());
    }

    #[test]
    fn mime_matches_extension() {
        assert_eq!(mime_for("png"), "image/png");
        assert_eq!(mime_for("webp"), "image/webp");
        assert_eq!(mime_for("jpg"), "image/jpeg");
        assert_eq!(mime_for("nef"), "image/jpeg");
    }
}
