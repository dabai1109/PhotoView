//! 收藏搬文件的端到端回归：真的复制一份相册出来，走 fav + scan 的完整链路。
//!
//! 单元测试各自只盯自己那一块，但真正会咬人的是接缝：文件搬进收藏文件夹之后，
//! 重新扫描还认不认得它是收藏？RAW+JPG 有没有在搬家路上散掉？
//! 这里拿 test-photos 里真实的 RAW/JPG 配对来跑一遍。

use photoview_lib::{fav, scan, types::MoveItem};
use std::fs;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("test-photos")
}

/// 把 test-photos 里的一对 DSC_0003.JPG / .NEF 拷进一个干净的临时相册
fn make_album(tag: &str) -> PathBuf {
    let album = std::env::temp_dir().join(format!("photoview_fav_e2e_{}", tag));
    let _ = fs::remove_dir_all(&album);
    let day = album.join("2026-08-23");
    fs::create_dir_all(&day).unwrap();

    let src = fixtures();
    for name in ["DSC_0003.JPG", "DSC_0003.NEF"] {
        let from = src.join(name);
        assert!(from.is_file(), "找不到测试素材 {}", from.display());
        fs::copy(&from, day.join(name)).unwrap();
    }
    album
}

#[test]
fn favorite_then_rescan_still_sees_one_favored_pair() {
    let album = make_album("rescan");
    let root = album.to_string_lossy().to_string();
    let day = album.join("2026-08-23");

    // 收藏前：一组、两个文件、没被收藏
    let before = scan::scan_folder(&root, true, true, "收藏", "favorites.txt");
    assert!(before.ok);
    assert_eq!(before.groups.len(), 1, "RAW+JPG 应该是一组");
    assert!(!before.groups[0].favored);
    assert_eq!(before.groups[0].files.len(), 2);

    // 收藏：整组搬进收藏文件夹
    let files: Vec<String> = before.groups[0].files.clone();
    let moved = fav::favorite_files(&root, "收藏", &files).expect("收藏失败");
    assert_eq!(moved.len(), 2);
    for m in &moved {
        assert!(Path::new(&m.to).is_file(), "{} 应该已经在收藏夹里", m.to);
        assert!(!Path::new(&m.from).exists(), "{} 不该还在原处", m.from);
    }

    // 重新扫描：还是一组，且被认定为已收藏
    let after = scan::scan_folder(&root, true, true, "收藏", "favorites.txt");
    assert_eq!(after.groups.len(), 1, "搬完还是一组，配对不能散");
    assert!(after.groups[0].favored, "收藏夹里的照片重新扫描要认得出是收藏");
    assert_eq!(after.groups[0].files.len(), 2);
    assert_eq!(after.groups[0].id, "收藏/DSC_0003.NEF");
    assert!(!after.has_legacy_favorites);

    // 取消收藏：搬回原来的子目录，状态跟着回去
    let restored = fav::unfavorite_files(&moved).expect("还原失败");
    assert_eq!(restored.len(), 2);
    for m in &restored {
        assert!(Path::new(&m.to).is_file(), "{} 应该已经回到原目录", m.to);
        assert_eq!(Path::new(&m.to).parent().unwrap(), day.as_path());
    }
    let back = scan::scan_folder(&root, true, true, "收藏", "favorites.txt");
    assert_eq!(back.groups.len(), 1);
    assert!(!back.groups[0].favored, "移回原目录之后就不是收藏了");

    let _ = fs::remove_dir_all(&album);
}

#[test]
fn favoriting_twice_is_idempotent_and_never_duplicates() {
    let album = make_album("twice");
    let root = album.to_string_lossy().to_string();

    let first = scan::scan_folder(&root, true, true, "收藏", "favorites.txt");
    let files: Vec<String> = first.groups[0].files.clone();
    let moved = fav::favorite_files(&root, "收藏", &files).unwrap();

    // 已经在收藏夹里的再收藏一次：原地不动，from == to
    let again: Vec<String> = moved.iter().map(|m| m.to.clone()).collect();
    let second = fav::favorite_files(&root, "收藏", &again).unwrap();
    for m in &second {
        assert_eq!(m.from, m.to, "已经在收藏夹里的不该再被搬一次");
    }

    let after = scan::scan_folder(&root, true, true, "收藏", "favorites.txt");
    assert_eq!(after.groups.len(), 1, "不能凭空多出一组照片");
    assert_eq!(after.groups[0].files.len(), 2);

    let _ = fs::remove_dir_all(&album);
}

#[test]
fn restoring_into_an_occupied_name_keeps_both_photos() {
    let album = make_album("occupied");
    let root = album.to_string_lossy().to_string();
    let day = album.join("2026-08-23");

    let first = scan::scan_folder(&root, true, true, "收藏", "favorites.txt");
    let files: Vec<String> = first.groups[0].files.clone();
    let moved = fav::favorite_files(&root, "收藏", &files).unwrap();

    // 原位置又出现了同名文件（重新拷了一次卡）
    for name in ["DSC_0003.JPG", "DSC_0003.NEF"] {
        fs::write(day.join(name), b"another shoot").unwrap();
    }

    let restored = fav::unfavorite_files(&moved).unwrap();
    for m in &restored {
        assert!(Path::new(&m.to).is_file());
        assert_ne!(
            fs::read(&m.to).unwrap(),
            b"another shoot".to_vec(),
            "还原时把原位置那张覆盖掉了 —— 这是不可逆的数据丢失"
        );
    }
    // 后来那两个也还在
    for name in ["DSC_0003.JPG", "DSC_0003.NEF"] {
        assert_eq!(fs::read(day.join(name)).unwrap(), b"another shoot".to_vec());
    }
    // 让开名字之后主名依旧成对，不会被拆成两组
    let stems: Vec<String> = restored
        .iter()
        .map(|m| {
            Path::new(&m.to)
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .to_lowercase()
        })
        .collect();
    assert_eq!(stems[0], stems[1], "让名之后配对也要留在一组里");

    let _ = fs::remove_dir_all(&album);
}

#[test]
fn undo_of_unfavorite_puts_the_pair_back_into_the_fav_folder() {
    let album = make_album("undo");
    let root = album.to_string_lossy().to_string();

    let first = scan::scan_folder(&root, true, true, "收藏", "favorites.txt");
    let files: Vec<String> = first.groups[0].files.clone();
    let moved = fav::favorite_files(&root, "收藏", &files).unwrap();
    let restored = fav::unfavorite_files(&moved).unwrap();

    // 前端撤销「取消收藏」走的就是这条：拿当前路径再收藏一次
    let now: Vec<String> = restored.iter().map(|m| m.to.clone()).collect();
    let redo: Vec<MoveItem> = fav::favorite_files(&root, "收藏", &now).unwrap();
    for m in &redo {
        assert!(Path::new(&m.to).is_file());
        assert_eq!(
            Path::new(&m.to).parent().unwrap(),
            album.join("收藏").as_path(),
            "撤销「取消收藏」必须真的回到收藏文件夹"
        );
    }

    let after = scan::scan_folder(&root, true, true, "收藏", "favorites.txt");
    assert_eq!(after.groups.len(), 1);
    assert!(after.groups[0].favored);

    let _ = fs::remove_dir_all(&album);
}
