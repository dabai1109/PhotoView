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

pub fn scan_folder(
    root: &str,
    recursive: bool,
    group_raw_jpeg: bool,
    fav_file_name: &str,
) -> ScanResult {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return ScanResult {
            ok: false,
            root: root.to_string(),
            groups: Vec::new(),
            favorites_file_name: fav_file_name.to_string(),
        };
    }

    let max_depth = if recursive { 8 } else { 1 };
    let mut files: Vec<FileInfo> = Vec::new();

    for entry in WalkDir::new(root_path)
        .max_depth(max_depth)
        .into_iter()
        // filter_entry 也会作用于根节点：根目录自己叫 ".photos" 之类时不能把整棵树否掉
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
        // Windows 上 walkdir 直接复用 readdir 拿到的元数据，这里不会真的再打一次盘
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

    // 收藏列表
    let fav_items = read_favorites(root, fav_file_name);
    let fav_set: HashSet<String> = fav_items.iter().map(|x| x.trim().to_lowercase()).collect();

    let rel_of = |p: &Path| -> Option<String> {
        pathdiff::diff_paths(p, root_path).map(|r| r.to_string_lossy().replace('\\', "/"))
    };

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

        // 收藏可以按相对路径 / 文件名 / 主名任一种写法命中
        let id_lower = rel_id.to_lowercase();
        let name_lower = primary_name.to_lowercase();
        let base_lower = primary
            .path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let is_fav = fav_set.contains(&id_lower)
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
        favorites_file_name: fav_file_name.to_string(),
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
        let r = scan_folder("Z:/nope/nope", true, true, "favorites.txt");
        assert!(!r.ok);
        assert!(r.groups.is_empty());
    }
}
