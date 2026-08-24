use crate::fav::read_favorites;
use crate::types::{PhotoGroup, ScanResult};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

const RAW_EXTS: &[&str] = &[
    "nef", "nrw", "cr2", "cr3", "crw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "pef",
    "ptx", "srw", "raw", "rwl", "iiq", "3fr", "fff", "erf", "mrw", "x3f",
];

const PLAIN_EXTS: &[&str] = &["jpg", "jpeg", "jpe", "png", "webp", "gif", "bmp", "avif"];

const SKIP_DIRS: &[&str] = &["$RECYCLE.BIN", "System Volume Information", "node_modules", ".git"];

pub fn is_raw_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    RAW_EXTS.contains(&lower.as_str())
}

pub fn is_supported_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    RAW_EXTS.contains(&lower.as_str()) || PLAIN_EXTS.contains(&lower.as_str())
}

/// 遍历时顺手记下来的文件信息，省掉后面每个文件再 stat 一次
struct FileInfo {
    path: PathBuf,
    size: u64,
    mtime: f64,
}

/// 扫描相册。
///
/// `fav_folder_name` 是收藏文件夹名（照片真的会被搬进去，是收藏状态的唯一真相）；
/// `legacy_list_name` 是 1.5.0 及以前那份纯文本清单的文件名，只读不写，
/// 纯粹为了让老用户升级上来时收藏星星不丢。
pub fn scan_folder(
    root: &str,
    recursive: bool,
    group_raw_jpeg: bool,
    fav_folder_name: &str,
    legacy_list_name: &str,
) -> ScanResult {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return ScanResult {
            ok: false,
            root: root.to_string(),
            groups: Vec::new(),
            favorites_file_name: legacy_list_name.to_string(),
            favorites_folder_name: "收藏".to_string(),
            has_legacy_favorites: false,
        };
    }

    let fav_folder_name = crate::settings::sanitize_file_name(fav_folder_name, "收藏");
    let fav_folder_path = root_path.join(&fav_folder_name);
    let canonical_fav_folder = std::fs::canonicalize(&fav_folder_path).ok();
    let fav_prefix = format!("{}/", fav_folder_name.to_lowercase());

    let max_depth = if recursive { 8 } else { 1 };
    let mut files: Vec<FileInfo> = Vec::new();
    let mut scanned_paths = HashSet::new();

    let mut collect_from_dir = |dir: &Path, depth: usize| {
        for entry in WalkDir::new(dir)
            .max_depth(depth)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                !(name.starts_with('.') || SKIP_DIRS.iter().any(|&d| name.eq_ignore_ascii_case(d)))
            })
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            let supported = p
                .extension()
                .and_then(|x| x.to_str())
                .map(is_supported_ext)
                .unwrap_or(false);
            if !supported {
                continue;
            }
            if !scanned_paths.insert(p.to_path_buf()) {
                continue;
            }
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            files.push(FileInfo {
                path: p.to_path_buf(),
                size: md.len(),
                mtime: md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or(0.0),
            });
        }
    };

    // 扫描根目录
    collect_from_dir(root_path, max_depth);

    // 如果未开启递归，但相册根目录下有收藏文件夹，额外将收藏文件夹内的一级文件也扫描进来
    if !recursive && fav_folder_path.is_dir() {
        collect_from_dir(&fav_folder_path, 1);
    }

    // 分组：同目录同主名的 RAW / JPG 归为一组
    let mut map: HashMap<String, Vec<FileInfo>> = HashMap::new();
    for f in files {
        let key = if group_raw_jpeg {
            let dir = f
                .path
                .parent()
                .unwrap_or(root_path)
                .to_string_lossy()
                .to_lowercase();
            let stem = f.path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
            format!("{}|{}", dir, stem)
        } else {
            f.path.to_string_lossy().to_lowercase()
        };
        map.entry(key).or_default().push(f);
    }

    // 遗留清单文件兼容：只读不写，1.5.0 之前的收藏记录还认
    let fav_items = read_favorites(root, legacy_list_name);
    let has_legacy_favorites = !fav_items.is_empty();
    let fav_set: HashSet<String> = fav_items.iter().map(|x| x.trim().to_lowercase()).collect();

    let rel_of = |p: &Path| -> Option<String> {
        pathdiff::diff_paths(p, root_path).map(|r| r.to_string_lossy().replace('\\', "/"))
    };

    // canonicalize 一次是一次系统调用，上千张照片挨个做会明显拖慢扫描 ——
    // 按目录缓存，同一个目录只问一次
    let mut canon_cache: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();

    let mut groups = Vec::new();
    for mut file_list in map.into_values() {
        file_list.sort_by(|a, b| a.path.cmp(&b.path)); // 确定顺序
        if file_list.is_empty() {
            continue;
        }

        // 主文件优先选 RAW
        let primary_idx = file_list
            .iter()
            .position(|f| {
                f.path
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(is_raw_ext)
                    .unwrap_or(false)
            })
            .unwrap_or(0);
        let has_raw = file_list.iter().any(|f| {
            f.path
                .extension()
                .and_then(|x| x.to_str())
                .map(is_raw_ext)
                .unwrap_or(false)
        });
        let primary = &file_list[primary_idx];

        let primary_name = primary.path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let rel_id = rel_of(&primary.path).unwrap_or_else(|| primary_name.clone());

        // 这一组是不是躺在收藏文件夹里。
        // 先做纯字符串的相对路径判断：WalkDir 不跟随符号链接，正常情况这条就够了；
        // 只有它说「不在」时才退回 canonicalize（走 junction / 符号链接进来的相册）。
        let mut in_fav_folder = false;
        for f in &file_list {
            if let Some(rel) = rel_of(&f.path) {
                if rel.to_lowercase().starts_with(&fav_prefix) {
                    in_fav_folder = true;
                    break;
                }
            }
            if canonical_fav_folder.is_none() {
                continue;
            }
            if let Some(parent) = f.path.parent() {
                let canon = canon_cache
                    .entry(parent.to_path_buf())
                    .or_insert_with(|| std::fs::canonicalize(parent).ok())
                    .clone();
                if canon.is_some() && canon == canonical_fav_folder {
                    in_fav_folder = true;
                    break;
                }
            }
        }

        // 收藏状态：如果在收藏文件夹内，或者在遗留的清单中
        let id_lower = rel_id.to_lowercase();
        let name_lower = primary_name.to_lowercase();
        let base_lower = primary
            .path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let is_fav = in_fav_folder
            || fav_set.contains(&id_lower)
            || fav_set.contains(&name_lower)
            || fav_set.contains(&base_lower)
            || file_list.iter().any(|f| {
                let n = f.path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                let r = rel_of(&f.path).map(|x| x.to_lowercase()).unwrap_or_default();
                fav_set.contains(&n) || (!r.is_empty() && fav_set.contains(&r))
            });

        groups.push(PhotoGroup {
            id: rel_id,
            dir: primary.path.parent().unwrap_or(root_path).to_string_lossy().to_string(),
            base: primary.path.file_stem().unwrap_or_default().to_string_lossy().to_string(),
            name: primary_name,
            files: file_list.iter().map(|f| f.path.to_string_lossy().to_string()).collect(),
            sizes: file_list.iter().map(|f| f.size).collect(),
            primary: primary.path.to_string_lossy().to_string(),
            ext: primary
                .path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_uppercase(),
            is_raw: has_raw,
            has_pair: file_list.len() > 1,
            size: file_list.iter().map(|f| f.size).sum(),
            mtime: primary.mtime,
            favored: is_fav,
        });
    }

    // 自然排序（按 id）
    groups.sort_by(|a, b| alphanumeric_sort::compare_str(&a.id, &b.id));

    ScanResult {
        ok: true,
        root: root.to_string(),
        groups,
        favorites_file_name: legacy_list_name.to_string(),
        favorites_folder_name: fav_folder_name,
        has_legacy_favorites,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_and_plain_extensions() {
        assert!(is_raw_ext("nef"));
        assert!(is_raw_ext("NEF"));
        assert!(is_raw_ext("CR3"));
        assert!(!is_raw_ext("jpg"));
        assert!(is_supported_ext("jpg"));
        assert!(is_supported_ext("AVIF"));
        assert!(!is_supported_ext("txt"));
        assert!(!is_supported_ext(""));
    }

    #[test]
    fn missing_root_is_not_ok() {
        let r = scan_folder("Z:/nope/nope", true, true, "收藏", "favorites.txt");
        assert!(!r.ok);
        assert!(r.groups.is_empty());
    }

    #[test]
    fn favorited_photos_are_the_ones_inside_the_fav_folder() {
        let dir = std::env::temp_dir().join("photoview_scan_fav_folder_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("收藏")).unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("plain.jpg"), b"x").unwrap();
        std::fs::write(dir.join("sub/nested.jpg"), b"x").unwrap();
        std::fs::write(dir.join("收藏/picked.jpg"), b"x").unwrap();

        let root = dir.to_string_lossy().to_string();
        let r = scan_folder(&root, true, true, "收藏", "favorites.txt");
        assert!(r.ok);
        assert!(!r.has_legacy_favorites, "没有 favorites.txt 就不该说有");

        let fav_of = |name: &str| r.groups.iter().find(|g| g.name == name).map(|g| g.favored);
        assert_eq!(fav_of("picked.jpg"), Some(true), "收藏夹里的就是已收藏");
        assert_eq!(fav_of("plain.jpg"), Some(false));
        assert_eq!(fav_of("nested.jpg"), Some(false));

        // 关掉递归时收藏夹里的照片也得扫进来，否则「收藏」筛选是空的、也没法取消收藏
        let r2 = scan_folder(&root, false, true, "收藏", "favorites.txt");
        let names: Vec<&str> = r2.groups.iter().map(|g| g.name.as_str()).collect();
        assert!(names.contains(&"picked.jpg"), "非递归也要带上收藏夹：{:?}", names);
        assert!(!names.contains(&"nested.jpg"), "非递归不该下到别的子目录");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_list_still_marks_favorites() {
        let dir = std::env::temp_dir().join("photoview_scan_legacy_list_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.jpg"), b"x").unwrap();
        std::fs::write(dir.join("favorites.txt"), b"old.jpg\r\n").unwrap();

        let root = dir.to_string_lossy().to_string();
        let r = scan_folder(&root, true, true, "收藏", "favorites.txt");
        assert!(r.has_legacy_favorites, "读到了老清单就要告诉前端");
        assert_eq!(
            r.groups.iter().find(|g| g.name == "old.jpg").map(|g| g.favored),
            Some(true),
            "1.5.0 的收藏记录升级后不能丢"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
