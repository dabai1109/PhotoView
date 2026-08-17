//! 轻量 TIFF / EXIF 解析器（从 src/main/tiff.js 等价移植）。
//!
//! 用途：从 TIFF 结构的 RAW（尼康 NEF/NRW、佳能 CR2、索尼 ARW、DNG、宾得 PEF…）
//! 中定位内嵌 JPEG 预览图的字节范围，并读取 EXIF 拍摄参数。
//!
//! 关键点：只解析 IFD 结构拿到偏移表，不整读文件。定位到偏移后按范围读盘，
//! 比暴力扫描整个 RAW 快一到两个数量级。

use crate::types::ExifData;
use std::collections::{HashMap, HashSet};

// ---------- tag 常量 ----------
pub const T_IMAGE_WIDTH: u16 = 0x0100;
pub const T_IMAGE_LENGTH: u16 = 0x0101;
pub const T_COMPRESSION: u16 = 0x0103;
pub const T_MAKE: u16 = 0x010f;
pub const T_MODEL: u16 = 0x0110;
pub const T_STRIP_OFFSETS: u16 = 0x0111;
pub const T_ORIENTATION: u16 = 0x0112;
pub const T_STRIP_BYTE_COUNTS: u16 = 0x0117;
pub const T_SUB_IFDS: u16 = 0x014a;
pub const T_JPEG_OFFSET: u16 = 0x0201;
pub const T_JPEG_LENGTH: u16 = 0x0202;
pub const T_EXIF_IFD: u16 = 0x8769;
pub const T_MAKERNOTE: u16 = 0x927c;
pub const T_EXPOSURE_TIME: u16 = 0x829a;
pub const T_F_NUMBER: u16 = 0x829d;
pub const T_ISO: u16 = 0x8827;
pub const T_ISO_SPEED: u16 = 0x8833;
pub const T_DATE_ORIGINAL: u16 = 0x9003;
pub const T_EXPOSURE_BIAS: u16 = 0x9204;
pub const T_FOCAL_LENGTH: u16 = 0x920a;
pub const T_EXIF_PIXEL_X: u16 = 0xa002;
pub const T_EXIF_PIXEL_Y: u16 = 0xa003;
pub const T_LENS_MODEL: u16 = 0xa434;
pub const T_FOCAL_35: u16 = 0xa405;

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        13 => 4,
        _ => 0,
    }
}

// ---------- 读取原语（全部带边界检查，越界返回 None 而不是 panic） ----------
fn rd_u16(buf: &[u8], o: usize, le: bool) -> Option<u16> {
    let b = buf.get(o..o.checked_add(2)?)?;
    Some(if le {
        u16::from_le_bytes([b[0], b[1]])
    } else {
        u16::from_be_bytes([b[0], b[1]])
    })
}

fn rd_u32(buf: &[u8], o: usize, le: bool) -> Option<u32> {
    let b = buf.get(o..o.checked_add(4)?)?;
    Some(if le {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    } else {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    })
}

fn rd_i32(buf: &[u8], o: usize, le: bool) -> Option<i32> {
    rd_u32(buf, o, le).map(|v| v as i32)
}

/// JPEG 段长度恒为大端
fn be16(buf: &[u8], o: usize) -> Option<u16> {
    let b = buf.get(o..o.checked_add(2)?)?;
    Some(u16::from_be_bytes([b[0], b[1]]))
}

// ---------- 数据结构 ----------
#[derive(Clone, Debug)]
pub enum TagValue {
    Num(f64),
    Nums(Vec<f64>),
    Text(String),
}

impl TagValue {
    pub fn num(&self) -> Option<f64> {
        match self {
            TagValue::Num(v) => Some(*v),
            TagValue::Nums(v) => v.first().copied(),
            TagValue::Text(_) => None,
        }
    }
    pub fn text(&self) -> Option<&str> {
        match self {
            TagValue::Text(s) => Some(s.as_str()),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Entry {
    typ: u16,
    count: usize,
    val_off: usize,
    byte_len: usize,
}

struct Ifd {
    entries: HashMap<u16, Entry>,
    next: usize,
}

/// 一张内嵌预览图候选
#[derive(Clone, Debug)]
pub struct Preview {
    pub offset: usize,
    pub length: usize,
    pub width: u32,
    pub height: u32,
}

pub struct TiffResult {
    pub previews: Vec<Preview>,
    pub tags: HashMap<u16, TagValue>,
    /// 尼康 MakerNote 里算出来的镜头名（tag 0x0084）
    pub nikon_lens: Option<String>,
    /// buffer 不完整导致没走完（需要整读文件重来）
    pub truncated: bool,
}

// ---------- TIFF 头 / IFD ----------
struct Header {
    le: bool,
    first_ifd: usize,
}

fn parse_header(buf: &[u8], base: usize) -> Option<Header> {
    if base.checked_add(8)? > buf.len() {
        return None;
    }
    let le = match (buf[base], buf[base + 1]) {
        (0x49, 0x49) => true,
        (0x4d, 0x4d) => false,
        _ => return None,
    };
    if rd_u16(buf, base + 2, le)? != 42 {
        return None;
    }
    let first = rd_u32(buf, base + 4, le)?;
    if first == 0 {
        return None;
    }
    Some(Header {
        le,
        first_ifd: base.checked_add(first as usize)?,
    })
}

fn read_ifd(buf: &[u8], offset: usize, le: bool, base: usize) -> Option<Ifd> {
    let count = rd_u16(buf, offset, le)? as usize;
    if count == 0 || count > 2048 {
        return None;
    }
    let end = offset
        .checked_add(2)?
        .checked_add(count.checked_mul(12)?)?
        .checked_add(4)?;
    if end > buf.len() {
        return None;
    }

    let mut entries = HashMap::with_capacity(count);
    let mut p = offset + 2;
    for _ in 0..count {
        let tag = rd_u16(buf, p, le)?;
        let typ = rd_u16(buf, p + 2, le)?;
        let n = rd_u32(buf, p + 4, le)? as usize;
        let ts = type_size(typ);
        if ts == 0 {
            p += 12;
            continue;
        }
        let byte_len = ts.saturating_mul(n);
        // 值 >4 字节时原地存的是指针，否则值就内联在这 4 字节里
        let val_off = if byte_len > 4 {
            base.saturating_add(rd_u32(buf, p + 8, le)? as usize)
        } else {
            p + 8
        };
        entries.insert(
            tag,
            Entry {
                typ,
                count: n,
                val_off,
                byte_len,
            },
        );
        p += 12;
    }

    let next_raw = rd_u32(buf, p, le)? as usize;
    Some(Ifd {
        entries,
        next: if next_raw != 0 {
            base.saturating_add(next_raw)
        } else {
            0
        },
    })
}

fn value(buf: &[u8], e: &Entry, le: bool) -> Option<TagValue> {
    let end = e.val_off.checked_add(e.byte_len)?;
    if end > buf.len() {
        return None;
    }

    // ASCII：latin1 解码，截到第一个 \0
    if e.typ == 2 {
        let raw = &buf[e.val_off..end];
        let cut = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
        let s: String = raw[..cut].iter().map(|&c| c as char).collect();
        return Some(TagValue::Text(s.trim().to_string()));
    }

    let one = |i: usize| -> Option<f64> {
        let off = e.val_off;
        match e.typ {
            1 | 6 | 7 => buf.get(off + i).map(|&v| v as f64),
            3 => rd_u16(buf, off + i * 2, le).map(|v| v as f64),
            8 => rd_u16(buf, off + i * 2, le).map(|v| v as i16 as f64),
            4 => rd_u32(buf, off + i * 4, le).map(|v| v as f64),
            9 => rd_i32(buf, off + i * 4, le).map(|v| v as f64),
            5 => {
                let a = rd_u32(buf, off + i * 8, le)? as f64;
                let b = rd_u32(buf, off + i * 8 + 4, le)? as f64;
                Some(if b != 0.0 { a / b } else { 0.0 })
            }
            10 => {
                let a = rd_i32(buf, off + i * 8, le)? as f64;
                let b = rd_i32(buf, off + i * 8 + 4, le)? as f64;
                Some(if b != 0.0 { a / b } else { 0.0 })
            }
            11 => rd_u32(buf, off + i * 4, le).map(|v| f32::from_bits(v) as f64),
            12 => {
                let b = buf.get(off + i * 8..off + i * 8 + 8)?;
                let arr: [u8; 8] = b.try_into().ok()?;
                Some(if le {
                    f64::from_le_bytes(arr)
                } else {
                    f64::from_be_bytes(arr)
                })
            }
            _ => None,
        }
    };

    if e.count == 1 {
        return one(0).map(TagValue::Num);
    }
    let mut out = Vec::new();
    for i in 0..e.count.min(512) {
        match one(i) {
            Some(v) => out.push(v),
            None => break,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(TagValue::Nums(out))
    }
}

// ---------- 遍历 ----------
struct Walker<'a> {
    buf: &'a [u8],
    base: usize,
    le: bool,
    previews: Vec<Preview>,
    tags: HashMap<u16, TagValue>,
    nikon_lens: Option<String>,
    seen: HashSet<usize>,
    truncated: bool,
}

impl<'a> Walker<'a> {
    fn get_val(&self, ifd: &Ifd, tag: u16) -> Option<TagValue> {
        value(self.buf, ifd.entries.get(&tag)?, self.le)
    }

    fn get_num(&self, ifd: &Ifd, tag: u16) -> Option<f64> {
        self.get_val(ifd, tag)?.num()
    }

    fn collect(&mut self, ifd: &Ifd, is_root: bool) {
        // 预览图候选：JPEGInterchangeFormat，或单条带的 JPEG 压缩
        let mut off: Option<usize> = None;
        let mut len: Option<usize> = None;

        if ifd.entries.contains_key(&T_JPEG_OFFSET) && ifd.entries.contains_key(&T_JPEG_LENGTH) {
            off = self.get_num(ifd, T_JPEG_OFFSET).map(|v| v as usize);
            len = self.get_num(ifd, T_JPEG_LENGTH).map(|v| v as usize);
        } else {
            let comp = self.get_num(ifd, T_COMPRESSION);
            let single_strip = ifd
                .entries
                .get(&T_STRIP_OFFSETS)
                .map(|e| e.count == 1)
                .unwrap_or(false);
            let has_counts = ifd.entries.contains_key(&T_STRIP_BYTE_COUNTS);
            let jpeg_compressed = matches!(comp, Some(c) if c == 6.0 || c == 7.0 || c == 99.0);
            if jpeg_compressed && single_strip && has_counts {
                off = self.get_num(ifd, T_STRIP_OFFSETS).map(|v| v as usize);
                len = self.get_num(ifd, T_STRIP_BYTE_COUNTS).map(|v| v as usize);
            }
        }

        if let (Some(o), Some(l)) = (off, len) {
            if l > 2048 {
                // 先算好再 push：避免在 &mut self.previews 的参数里再借一次 &self
                let width = self.get_num(ifd, T_IMAGE_WIDTH).unwrap_or(0.0) as u32;
                let height = self.get_num(ifd, T_IMAGE_LENGTH).unwrap_or(0.0) as u32;
                self.previews.push(Preview {
                    offset: self.base.saturating_add(o),
                    length: l,
                    width,
                    height,
                });
            }
        }

        // 合并 tag：根 IFD 覆盖，其余只在还没有该 tag 时写入
        let tags_to_read: Vec<u16> = ifd
            .entries
            .keys()
            .copied()
            .filter(|&t| t != T_MAKERNOTE && t != T_STRIP_OFFSETS)
            .filter(|t| is_root || !self.tags.contains_key(t))
            .collect();
        for t in tags_to_read {
            if let Some(v) = self.get_val(ifd, t) {
                self.tags.insert(t, v);
            }
        }
    }

    fn walk_chain(&mut self, start: usize, is_root: bool, depth: u32) {
        let mut off = start;
        let mut is_root = is_root;
        let mut guard = 0u32;

        while off != 0 && guard < 32 {
            guard += 1;
            if !self.seen.insert(off) {
                break;
            }
            if off.saturating_add(2) > self.buf.len() {
                self.truncated = true;
                break;
            }
            let ifd = match read_ifd(self.buf, off, self.le, self.base) {
                Some(i) => i,
                None => {
                    self.truncated = true;
                    break;
                }
            };

            self.collect(&ifd, is_root && guard == 1);

            if depth < 4 {
                if let Some(v) = self.get_val(&ifd, T_SUB_IFDS) {
                    let list: Vec<f64> = match v {
                        TagValue::Num(n) => vec![n],
                        TagValue::Nums(n) => n,
                        TagValue::Text(_) => vec![],
                    };
                    for s in list {
                        let target = self.base.saturating_add(s as usize);
                        self.walk_chain(target, false, depth + 1);
                    }
                }
                if let Some(v) = self.get_num(&ifd, T_EXIF_IFD) {
                    if v > 0.0 {
                        let target = self.base.saturating_add(v as usize);
                        self.walk_chain(target, false, depth + 1);
                    }
                }
                if let Some(mn) = ifd.entries.get(&T_MAKERNOTE).copied() {
                    self.parse_nikon_makernote(&mn);
                }
            }

            off = ifd.next;
            is_root = false;
        }
    }

    /// 尼康 MakerNote：`"Nikon\0"` + 版本(2) + 保留(2) + 一个完整的 TIFF 头。
    /// tag 0x0011 指向 PreviewIFD，部分机型的大预览图只存在这里。
    fn parse_nikon_makernote(&mut self, entry: &Entry) {
        let start = entry.val_off;
        if start.saturating_add(18) > self.buf.len() {
            return;
        }
        if &self.buf[start..start + 6] != b"Nikon\0".as_slice() {
            return;
        }
        let m_base = start + 10;
        let hdr = match parse_header(self.buf, m_base) {
            Some(h) => h,
            None => return,
        };
        let le = hdr.le;
        let root = match read_ifd(self.buf, hdr.first_ifd, le, m_base) {
            Some(r) => r,
            None => return,
        };

        if let Some(ptr) = root.entries.get(&0x0011) {
            if let Some(rel) = value(self.buf, ptr, le).and_then(|v| v.num()) {
                if rel > 0.0 {
                    let p_off = m_base.saturating_add(rel as usize);
                    if let Some(p_ifd) = read_ifd(self.buf, p_off, le, m_base) {
                        let o = p_ifd
                            .entries
                            .get(&T_JPEG_OFFSET)
                            .and_then(|e| value(self.buf, e, le))
                            .and_then(|v| v.num());
                        let l = p_ifd
                            .entries
                            .get(&T_JPEG_LENGTH)
                            .and_then(|e| value(self.buf, e, le))
                            .and_then(|v| v.num());
                        if let (Some(o), Some(l)) = (o, l) {
                            if l > 2048.0 {
                                let w = p_ifd
                                    .entries
                                    .get(&T_IMAGE_WIDTH)
                                    .and_then(|e| value(self.buf, e, le))
                                    .and_then(|v| v.num())
                                    .unwrap_or(0.0);
                                let h = p_ifd
                                    .entries
                                    .get(&T_IMAGE_LENGTH)
                                    .and_then(|e| value(self.buf, e, le))
                                    .and_then(|v| v.num())
                                    .unwrap_or(0.0);
                                self.previews.push(Preview {
                                    offset: m_base.saturating_add(o as usize),
                                    length: l as usize,
                                    width: w as u32,
                                    height: h as u32,
                                });
                            }
                        }
                    }
                }
            }
        }

        // 镜头规格 tag 0x0084 = [最短焦, 最长焦, 最大光圈, 最小光圈]
        if self.nikon_lens.is_none() {
            if let Some(e) = root.entries.get(&0x0084) {
                if let Some(TagValue::Nums(v)) = value(self.buf, e, le) {
                    if v.len() >= 4 {
                        let (f1, f2, a1, a2) = (v[0], v[1], v[2], v[3]);
                        let fs = if f1 == f2 {
                            format!("{}mm", fmt1(f1))
                        } else {
                            format!("{}-{}mm", fmt1(f1), fmt1(f2))
                        };
                        let aps = if a1 == a2 {
                            format!("f/{}", fmt1(a1))
                        } else {
                            format!("f/{}-{}", fmt1(a1), fmt1(a2))
                        };
                        self.nikon_lens = Some(format!("{} {}", fs, aps));
                    }
                }
            }
        }
    }
}

/// 遍历整个 TIFF，收集预览图候选 + 合并后的 tag 表。
/// `base` 是该 TIFF 结构在 buffer 中的起始偏移（JPEG 里的 EXIF 段不为 0）。
pub fn walk_tiff(buf: &[u8], base: usize) -> Option<TiffResult> {
    let hdr = parse_header(buf, base)?;
    let mut w = Walker {
        buf,
        base,
        le: hdr.le,
        previews: Vec::new(),
        tags: HashMap::new(),
        nikon_lens: None,
        seen: HashSet::new(),
        truncated: false,
    };
    w.walk_chain(hdr.first_ifd, true, 0);
    Some(TiffResult {
        previews: w.previews,
        tags: w.tags,
        nikon_lens: w.nikon_lens,
        truncated: w.truncated,
    })
}

// ---------- JPEG ----------

/// 从 JPEG 字节流读取存储尺寸（按段长跳转扫 SOFn，不会撞上熵编码数据里的假标记）
pub fn jpeg_size(buf: &[u8], start: usize, end: usize) -> Option<(u32, u32)> {
    let end = end.min(buf.len());
    if *buf.get(start)? != 0xFF || *buf.get(start + 1)? != 0xD8 {
        return None;
    }
    let mut p = start + 2;
    while p + 4 < end {
        if buf[p] != 0xFF {
            p += 1;
            continue;
        }
        let marker = buf[p + 1];
        // 填充字节 / 无参数标记
        if marker == 0xD8 || marker == 0x01 || marker == 0xFF || (0xD0..=0xD7).contains(&marker) {
            p += 2;
            continue;
        }
        if marker == 0xD9 {
            break;
        }
        let len = be16(buf, p + 2)? as usize;
        // SOFn（0xC4 DHT / 0xC8 JPG / 0xCC DAC 不是 SOF）
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            if p + 9 > end {
                break;
            }
            let h = be16(buf, p + 5)? as u32;
            let w = be16(buf, p + 7)? as u32;
            return Some((w, h));
        }
        if len < 2 {
            break;
        }
        p += 2 + len;
    }
    None
}

fn find_soi(buf: &[u8], from: usize) -> Option<usize> {
    if from + 3 > buf.len() {
        return None;
    }
    buf[from..]
        .windows(3)
        .position(|w| w[0] == 0xFF && w[1] == 0xD8 && w[2] == 0xFF)
        .map(|i| from + i)
}

/// 暴力扫描独立 JPEG（CR3 / RAF 等非 TIFF 容器的兜底）。
/// 按段长跳转推进，只有进入 SOS 之后才逐字节找 EOI —— 避免 O(n²)。
pub fn scan_jpegs(buf: &[u8]) -> Vec<Preview> {
    let mut out = Vec::new();
    let n = buf.len();
    let mut p = 0usize;

    while p + 3 < n {
        let soi = match find_soi(buf, p) {
            Some(s) => s,
            None => break,
        };

        let mut q = soi + 2;
        let mut eoi: Option<usize> = None;

        while q + 1 < n {
            if buf[q] != 0xFF {
                q += 1;
                continue;
            }
            let m = buf[q + 1];
            if m == 0xD9 {
                eoi = Some(q + 2);
                break;
            }
            if m == 0x01 || m == 0xFF || m == 0x00 || m == 0xD8 || (0xD0..=0xD7).contains(&m) {
                q += 2;
                continue;
            }
            if q + 4 > n {
                break;
            }
            let len = match be16(buf, q + 2) {
                Some(l) => l as usize,
                None => break,
            };
            if len < 2 {
                break;
            }
            if m == 0xDA {
                // 进入扫描数据，这段没有长度字段，只能逐字节找 EOI
                q += 2 + len;
                while q + 1 < n {
                    if buf[q] == 0xFF && buf[q + 1] == 0xD9 {
                        eoi = Some(q + 2);
                        break;
                    }
                    q += 1;
                }
                break;
            }
            q += 2 + len;
        }

        match eoi {
            Some(e) if e > soi => {
                let len = e - soi;
                if len > 4096 {
                    let (w, h) = jpeg_size(buf, soi, e).unwrap_or((0, 0));
                    out.push(Preview {
                        offset: soi,
                        length: len,
                        width: w,
                        height: h,
                    });
                }
                p = e;
            }
            _ => p = soi + 2,
        }

        if out.len() > 24 {
            break;
        }
    }
    out
}

/// 从 JPEG 头里找 APP1(Exif) 段并解析
pub fn exif_from_jpeg(buf: &[u8]) -> Option<TiffResult> {
    if *buf.first()? != 0xFF || *buf.get(1)? != 0xD8 {
        return None;
    }
    let n = buf.len().min(1024 * 1024);
    let mut p = 2usize;
    while p + 4 < n {
        if buf[p] != 0xFF {
            p += 1;
            continue;
        }
        let m = buf[p + 1];
        if m == 0xD8 || m == 0x01 || m == 0xFF || (0xD0..=0xD7).contains(&m) {
            p += 2;
            continue;
        }
        if m == 0xDA || m == 0xD9 {
            break;
        }
        let len = be16(buf, p + 2)? as usize;
        if m == 0xE1 && buf.get(p + 4..p + 10) == Some(b"Exif\0\0".as_slice()) {
            return walk_tiff(buf, p + 10);
        }
        if len < 2 {
            break;
        }
        p += 2 + len;
    }
    None
}

/// 这段 JPEG 字节自身带的 EXIF 方向。
///
/// 关键：浏览器解码器（`<img>` / `createImageBitmap`）会自动按它转向，
/// 渲染层只需要补解码器没转的那部分，否则会转两次（竖图变横图）。
/// RAW 里抠出来的预览通常不带 EXIF（返回 1），相机直出的 JPEG 则一定带。
pub fn self_orientation(data: &[u8]) -> u32 {
    match exif_from_jpeg(data) {
        Some(r) => {
            let o = r
                .tags
                .get(&T_ORIENTATION)
                .and_then(|v| v.num())
                .unwrap_or(1.0) as u32;
            if (1..=8).contains(&o) {
                o
            } else {
                1
            }
        }
        None => 1,
    }
}

pub fn swaps(o: u32) -> bool {
    (5..=8).contains(&o)
}

// ---------- 格式化 ----------

/// 保留 1 位小数并去掉多余的 0（对齐 JS 的 `Math.round(x*10)/10`）
fn fmt1(x: f64) -> String {
    let v = (x * 10.0).round() / 10.0;
    format!("{}", v)
}

/// 把原始 tag 表转成前端要用的 EXIF 对象。
/// 字段名和格式必须与 app.js 的读取方式一致（ex.aperture / ex.shutter / ex.iso …）。
pub fn to_exif(r: Option<&TiffResult>) -> ExifData {
    let mut out = ExifData {
        orientation: 1,
        ..Default::default()
    };
    let r = match r {
        Some(r) => r,
        None => return out,
    };
    let tags = &r.tags;
    let num = |t: u16| tags.get(&t).and_then(|v| v.num());
    let text = |t: u16| tags.get(&t).and_then(|v| v.text()).map(|s| s.to_string());

    out.make = text(T_MAKE);
    out.model = text(T_MODEL);
    out.lens = text(T_LENS_MODEL).or_else(|| r.nikon_lens.clone());

    // 快门：≥1s 直接写秒，否则写 1/x
    if let Some(s) = num(T_EXPOSURE_TIME) {
        if s > 0.0 {
            out.shutter = Some(if s >= 1.0 {
                format!("{}s", fmt1(s))
            } else {
                format!("1/{}s", (1.0 / s).round())
            });
        }
    }
    if let Some(f) = num(T_F_NUMBER) {
        if f > 0.0 {
            out.aperture = Some(format!("f/{}", fmt1(f)));
        }
    }
    if let Some(i) = num(T_ISO).or_else(|| num(T_ISO_SPEED)) {
        out.iso = Some(format!("ISO {}", i.round()));
    }
    if let Some(f) = num(T_FOCAL_LENGTH) {
        out.focal = Some(format!("{}mm", f.round()));
    }
    if let Some(f) = num(T_FOCAL_35) {
        out.focal35 = Some(format!("{}mm", f.round()));
    }
    if let Some(b) = num(T_EXPOSURE_BIAS) {
        if b != 0.0 {
            let sign = if b > 0.0 { "+" } else { "" };
            out.ev = Some(format!("{}{} EV", sign, fmt1(b)));
        }
    }
    // "2024:05:12 10:31:22" → "2024-05-12 10:31:22"
    out.date = text(T_DATE_ORIGINAL).map(|d| {
        let dated = d.len() >= 10 && d.as_bytes()[4] == b':' && d.as_bytes()[7] == b':';
        if dated {
            let mut s = d;
            s.replace_range(4..5, "-");
            s.replace_range(7..8, "-");
            s
        } else {
            d
        }
    });

    let o = num(T_ORIENTATION).unwrap_or(0.0) as u32;
    out.orientation = if (1..=8).contains(&o) { o } else { 1 };
    out.pixel_x = num(T_EXIF_PIXEL_X)
        .or_else(|| num(T_IMAGE_WIDTH))
        .map(|v| v as u32)
        .filter(|&v| v > 0);
    out.pixel_y = num(T_EXIF_PIXEL_Y)
        .or_else(|| num(T_IMAGE_LENGTH))
        .map(|v| v as u32)
        .filter(|&v| v > 0);

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一张最小的合法 JPEG：SOI + SOF0(w×h) + EOI
    fn tiny_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    #[test]
    fn jpeg_size_reads_sof0() {
        let j = tiny_jpeg(4032, 3024);
        assert_eq!(jpeg_size(&j, 0, j.len()), Some((4032, 3024)));
    }

    /// APP1 里塞一张缩略图的 SOF0，必须被段长跳过，读到的是主图尺寸
    #[test]
    fn jpeg_size_skips_app1_thumbnail() {
        let thumb = tiny_jpeg(160, 120);
        let mut j = vec![0xFF, 0xD8];
        let seg_len = (thumb.len() + 2) as u16;
        j.extend_from_slice(&[0xFF, 0xE1]);
        j.extend_from_slice(&seg_len.to_be_bytes());
        j.extend_from_slice(&thumb);
        j.extend_from_slice(&tiny_jpeg(6000, 4000)[2..]);
        assert_eq!(jpeg_size(&j, 0, j.len()), Some((6000, 4000)));
    }

    #[test]
    fn jpeg_size_rejects_non_jpeg() {
        assert_eq!(jpeg_size(&[0u8; 64], 0, 64), None);
    }

    /// 全是 0xFF 的垃圾数据不能把扫描器拖死，也不能 panic
    #[test]
    fn scan_jpegs_survives_garbage() {
        assert!(scan_jpegs(&vec![0xFFu8; 200_000]).is_empty());
        assert!(scan_jpegs(&[]).is_empty());
        assert!(scan_jpegs(&[0xFF, 0xD8, 0xFF]).is_empty());
    }

    /// 截断的 / 畸形的 TIFF 只能返回 None，不能越界 panic
    #[test]
    fn walk_tiff_handles_malformed() {
        assert!(walk_tiff(&[], 0).is_none());
        assert!(walk_tiff(&[0x49, 0x49, 0x2a, 0x00], 0).is_none());
        // 合法头但 IFD 偏移指向文件外
        let mut b = vec![0x49, 0x49, 0x2a, 0x00];
        b.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        let r = walk_tiff(&b, 0);
        assert!(r.map(|x| x.previews.is_empty()).unwrap_or(true));
    }

    #[test]
    fn swaps_only_for_5_to_8() {
        for o in 1..=4 {
            assert!(!swaps(o));
        }
        for o in 5..=8 {
            assert!(swaps(o));
        }
    }

    #[test]
    fn fmt1_trims_trailing_zero() {
        assert_eq!(fmt1(8.0), "8");
        assert_eq!(fmt1(1.8), "1.8");
        assert_eq!(fmt1(1.7999), "1.8");
    }
}
