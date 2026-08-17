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
            .map(photoview_lib::scan::is_supported_ext)
            .unwrap_or(false)
        {
            out.push(p);
        }
    }
    out
}
