use crate::fav::read_favorites;
use crate::types::{PhotoGroup, ScanResult};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

const RAW_EXTS: &[&str] = &[
    "nef", "nrw", "cr2", "cr3", "crw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "pef",
    "ptx", "srw", "raw", "rwl", "iiq", "3fr", "fff", "erf", "mrw", "x3f",
];

const PLAIN_EXTS: &[&str] = &["jpg", "jpeg", "jpe", "png", "webp", "gif", "bmp", "avif"];

pub fn is_raw_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    RAW_EXTS.contains(&lower.as_str())
}

pub fn is_supported_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    RAW_EXTS.contains(&lower.as_str()) || PLAIN_EXTS.contains(&lower.as_str())
}

pub fn scan_folder(
    root: &str,
    recursive: bool,
    group_raw_jpeg: bool,
    fav_file_name: &str,
) -> ScanResult {
    let root_path = Path::new(root);
    if !root_path.exists() {
        return ScanResult {
            ok: false,
            root: root.to_string(),
            groups: Vec::new(),
            favorites_file_name: fav_file_name.to_string(),
        };
    }

    let max_depth = if recursive { 8 } else { 1 };
    let mut files = Vec::new();

    for entry in WalkDir::new(root_path)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if name.starts_with('.') || name == "$RECYCLE.BIN" || name == "System Volume Information"
                || name == "node_modules" || name == ".git"
            {
                return false;
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let p = entry.path();
            if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                if is_supported_ext(ext) {
                    files.push(p.to_path_buf());
                }
            }
        }
    }

    // 分组
    let mut map: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for f in files {
        let dir = f.parent().unwrap_or(root_path).to_string_lossy().to_string();
        let stem = f.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let key = if group_raw_jpeg {
            format!("{}|{}", dir.to_lowercase(), stem.to_lowercase())
        } else {
            f.to_string_lossy().to_lowercase()
        };
        map.entry(key).or_default().push(f);
    }

    // 读取收藏列表
    let fav_items = read_favorites(root, fav_file_name);
    let fav_set: HashSet<String> = fav_items.iter().map(|x| x.trim().to_lowercase()).collect();

    let mut groups = Vec::new();
    for mut file_list in map.into_values() {
        file_list.sort(); // 确定顺序

        // 主文件优先选 RAW
        let raws: Vec<&PathBuf> = file_list
            .iter()
            .filter(|p| is_raw_ext(p.extension().and_then(|x| x.to_str()).unwrap_or("")))
            .collect();
        let primary = if !raws.is_empty() {
            raws[0].clone()
        } else {
            file_list[0].clone()
        };

        let stat = match fs::metadata(&primary) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let mut sizes = Vec::new();
        let mut total_size = 0u64;
        let mut file_strs = Vec::new();

        for f in &file_list {
            let s = fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            sizes.push(s);
            total_size += s;
            file_strs.push(f.to_string_lossy().to_string());
        }

        let mtime = stat
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);

        let primary_str = primary.to_string_lossy().to_string();
        let primary_name = primary
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let primary_base = primary
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let primary_dir = primary
            .parent()
            .unwrap_or(root_path)
            .to_string_lossy()
            .to_string();
        let ext = primary
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_uppercase();

        let rel_id = pathdiff::diff_paths(&primary, root_path)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| primary_name.clone());

        // 判断是否已收藏
        let id_lower = rel_id.to_lowercase();
        let name_lower = primary_name.to_lowercase();
        let base_lower = primary_base.to_lowercase();
        let is_fav = fav_set.contains(&id_lower)
            || fav_set.contains(&name_lower)
            || fav_set.contains(&base_lower)
            || file_list.iter().any(|f| {
                let f_name = f.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                let f_rel = pathdiff::diff_paths(f, root_path)
                    .map(|p| p.to_string_lossy().replace('\\', "/").to_lowercase())
                    .unwrap_or_default();
                fav_set.contains(&f_name) || fav_set.contains(&f_rel)
            });

        groups.push(PhotoGroup {
            id: rel_id,
            dir: primary_dir,
            base: primary_base,
            name: primary_name,
            files: file_strs,
            sizes,
            primary: primary_str,
            ext,
            is_raw: !raws.is_empty(),
            has_pair: file_list.len() > 1,
            size: total_size,
            mtime,
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
