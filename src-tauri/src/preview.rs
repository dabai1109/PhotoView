use crate::scan::is_raw_ext;
use crate::types::{ExifData, PreviewResponse};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// 从 JPEG 字节流中提取尺寸
fn get_jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    let mut i = 0;
    while i + 8 < data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        // SOF0, SOF1, SOF2 (Baseline, Extended, Progressive)
        if marker == 0xC0 || marker == 0xC1 || marker == 0xC2 {
            if i + 8 < data.len() {
                let h = ((data[i + 5] as u32) << 8) | (data[i + 6] as u32);
                let w = ((data[i + 7] as u32) << 8) | (data[i + 8] as u32);
                return Some((w, h));
            }
        }
        i += 2;
    }
    None
}

/// 快速扫描 RAW / TIFF 二进制中的内嵌 JPEG 预览图
fn extract_embedded_jpeg(data: &[u8]) -> Option<Vec<u8>> {
    let mut best_start = 0;
    let mut best_len = 0;
    let mut i = 0;

    while i + 3 < data.len() {
        // 查找 JPEG SOI: 0xFF, 0xD8, 0xFF
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            let start = i;
            let mut j = i + 2;
            let mut end = None;
            // 往后寻找 EOI: 0xFF, 0xD9
            while j + 1 < data.len() {
                if data[j] == 0xFF && data[j + 1] == 0xD9 {
                    end = Some(j + 2);
                    // 检查是否紧跟着另一段更大的 JPEG
                    if j + 2 < data.len() && data[j + 2] == 0xFF && data.get(j + 3) == Some(&0xD8) {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            if let Some(e) = end {
                let len = e - start;
                // 挑选最大的预览图（通常 > 100KB）
                if len > best_len && len > 32 * 1024 {
                    best_len = len;
                    best_start = start;
                }
                i = e;
                continue;
            }
        }
        i += 1;
    }

    if best_len > 0 {
        Some(data[best_start..best_start + best_len].to_vec())
    } else {
        None
    }
}

/// 提取 EXIF 信息
fn extract_exif(file_path: &Path) -> (Option<ExifData>, u32) {
    let file = match File::open(file_path) {
        Ok(f) => f,
        Err(_) => return (None, 1),
    };
    let mut reader = BufReader::new(file);
    let exif_reader = exif::Reader::new();
    let exif_data = match exif_reader.read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return (None, 1),
    };

    let mut info = ExifData::default();
    let mut orientation = 1u32;

    for f in exif_data.fields() {
        let tag = f.tag;
        let val_str = f.display_value().to_string();

        match tag {
            exif::Tag::Make => info.make = Some(val_str),
            exif::Tag::Model => info.model = Some(val_str),
            exif::Tag::LensModel | exif::Tag::LensMake => info.lens = Some(val_str),
            exif::Tag::FocalLength => info.focal = Some(val_str),
            exif::Tag::FocalLengthIn35mmFilm => info.focal35 = Some(val_str),
            exif::Tag::FNumber => info.f_number = Some(val_str),
            exif::Tag::ExposureTime => info.exposure = Some(val_str),
            exif::Tag::PhotographicSensitivity => info.iso = Some(val_str),
            exif::Tag::ExposureBiasValue => info.ev = Some(val_str),
            exif::Tag::DateTimeOriginal | exif::Tag::DateTime => info.date = Some(val_str),
            exif::Tag::Orientation => {
                if let exif::Value::Short(ref v) = f.value {
                    if let Some(&o) = v.first() {
                        orientation = o as u32;
                        info.orientation = orientation;
                    }
                }
            }
            exif::Tag::PixelXDimension => {
                if let exif::Value::Long(ref v) = f.value {
                    info.pixel_x = v.first().copied();
                } else if let exif::Value::Short(ref v) = f.value {
                    info.pixel_x = v.first().map(|&x| x as u32);
                }
            }
            exif::Tag::PixelYDimension => {
                if let exif::Value::Long(ref v) = f.value {
                    info.pixel_y = v.first().copied();
                } else if let exif::Value::Short(ref v) = f.value {
                    info.pixel_y = v.first().map(|&x| x as u32);
                }
            }
            _ => {}
        }
    }

    (Some(info), orientation)
}

pub fn get_preview(file_path_str: &str, _kind: &str) -> PreviewResponse {
    let p = Path::new(file_path_str);
    if !p.exists() {
        return PreviewResponse {
            ok: false,
            cached: false,
            data: None,
            mime: None,
            orientation: 1,
            exif_orientation: 1,
            store_w: 0,
            store_h: 0,
            width: 0,
            height: 0,
            exif: None,
            file_size: 0,
            error: Some("文件不存在".to_string()),
        };
    }

    let file_size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
    let is_raw = is_raw_ext(&ext);

    let (exif_opt, exif_orient) = extract_exif(p);

    let (bytes, mime) = if is_raw {
        // 读取前 30MB 数据用于提取内嵌大图
        let mut file = match File::open(p) {
            Ok(f) => f,
            Err(e) => {
                return PreviewResponse {
                    ok: false,
                    cached: false,
                    data: None,
                    mime: None,
                    orientation: 1,
                    exif_orientation: 1,
                    store_w: 0,
                    store_h: 0,
                    width: 0,
                    height: 0,
                    exif: exif_opt,
                    file_size,
                    error: Some(e.to_string()),
                }
            }
        };

        let read_len = std::cmp::min(file_size as usize, 30 * 1024 * 1024);
        let mut buf = vec![0u8; read_len];
        if file.read_exact(&mut buf).is_err() {
            let _ = file.seek(SeekFrom::Start(0));
            buf.clear();
            let _ = file.read_to_end(&mut buf);
        }

        if let Some(jpeg_bytes) = extract_embedded_jpeg(&buf) {
            (jpeg_bytes, "image/jpeg".to_string())
        } else {
            (buf, "image/jpeg".to_string())
        }
    } else {
        // 普通图片直接读取全部
        match std::fs::read(p) {
            Ok(b) => {
                let m = match ext.as_str() {
                    "png" => "image/png",
                    "webp" => "image/webp",
                    "gif" => "image/gif",
                    "avif" => "image/avif",
                    "bmp" => "image/bmp",
                    _ => "image/jpeg",
                };
                (b, m.to_string())
            }
            Err(e) => {
                return PreviewResponse {
                    ok: false,
                    cached: false,
                    data: None,
                    mime: None,
                    orientation: 1,
                    exif_orientation: 1,
                    store_w: 0,
                    store_h: 0,
                    width: 0,
                    height: 0,
                    exif: exif_opt,
                    file_size,
                    error: Some(e.to_string()),
                }
            }
        }
    };

    let (mut width, mut height) = get_jpeg_dimensions(&bytes).unwrap_or((0, 0));
    if width == 0 || height == 0 {
        if let Some(ref ex) = exif_opt {
            width = ex.pixel_x.unwrap_or(0);
            height = ex.pixel_y.unwrap_or(0);
        }
    }

    let b64 = BASE64.encode(&bytes);
    let data_uri = format!("data:{};base64,{}", mime, b64);

    PreviewResponse {
        ok: true,
        cached: false,
        data: Some(data_uri),
        mime: Some(mime),
        orientation: 1, // Base64已是图片本身，由前端根据exifOrientation旋转
        exif_orientation: exif_orient,
        store_w: width,
        store_h: height,
        width,
        height,
        exif: exif_opt,
        file_size,
        error: None,
    }
}
