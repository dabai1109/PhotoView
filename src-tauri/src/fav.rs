//! 收藏清单读写。清单是一个纯文本（或 JSON）文件，直接落在相册根目录下，
//! 方便用户拿去给 Lightroom / Bridge 之类的工具用。

use crate::settings::{sanitize_file_name, write_atomic};
use std::fs;
use std::path::{Path, PathBuf};

/// 解析出清单文件的真实路径。
///
/// 这里必须先消毒一次：`Path::join` 遇到绝对路径会把 root 整个替换掉，
/// 所以 `file_name` 一旦带上盘符或 `..` 就能写到相册目录之外去。
fn target_path(root: &str, file_name: &str) -> PathBuf {
    let safe = sanitize_file_name(file_name, "favorites.txt");
    Path::new(root).join(safe)
}

fn is_json(file_name: &str) -> bool {
    file_name.to_lowercase().ends_with(".json")
}

pub fn read_favorites(root: &str, file_name: &str) -> Vec<String> {
    let target = target_path(root, file_name);
    let content = match fs::read_to_string(&target) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    if is_json(file_name) {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&content) {
            return list;
        }
        #[derive(serde::Deserialize)]
        struct Obj {
            favorites: Vec<String>,
        }
        if let Ok(obj) = serde_json::from_str::<Obj>(&content) {
            return obj.favorites;
        }
        return Vec::new();
    }

    // txt：一行一条，忽略空行和 # 注释
    content
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

pub fn save_favorites(root: &str, file_name: &str, fav_list: &[String]) -> Result<usize, String> {
    if !Path::new(root).is_dir() {
        return Err("相册目录不存在".to_string());
    }

    // 去重（大小写不敏感），保持原有顺序
    let mut unique: Vec<String> = Vec::with_capacity(fav_list.len());
    let mut seen = std::collections::HashSet::new();
    for item in fav_list {
        let trimmed = item.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_lowercase()) {
            unique.push(trimmed.to_string());
        }
    }

    let target = target_path(root, file_name);
    let bytes = if is_json(file_name) {
        serde_json::to_string_pretty(&unique).map_err(|e| e.to_string())?
    } else {
        let mut text = String::new();
        for item in &unique {
            text.push_str(item);
            text.push_str("\r\n");
        }
        text
    };

    write_atomic(&target, bytes.as_bytes()).map_err(|e| e.to_string())?;
    Ok(unique.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_is_clamped_into_root() {
        let p = target_path("D:/Photos", "../../evil.txt");
        assert_eq!(p, Path::new("D:/Photos").join("favorites.txt"));

        let p = target_path("D:/Photos", "C:/Windows/System32/evil.txt");
        assert_eq!(p, Path::new("D:/Photos").join("favorites.txt"));

        // 正常名字要原样保留
        let p = target_path("D:/Photos", "选片.json");
        assert_eq!(p, Path::new("D:/Photos").join("选片.json"));
    }

    #[test]
    fn json_detection() {
        assert!(is_json("a.JSON"));
        assert!(is_json("a.json"));
        assert!(!is_json("a.txt"));
    }

    #[test]
    fn missing_file_reads_empty() {
        assert!(read_favorites("Z:/nope", "favorites.txt").is_empty());
    }

    #[test]
    fn saving_into_missing_root_errors() {
        assert!(save_favorites("Z:/nope/nope", "favorites.txt", &["a".into()]).is_err());
    }

    #[test]
    fn dedupe_is_case_insensitive_and_order_preserving() {
        let dir = std::env::temp_dir().join("photoview_fav_test");
        let _ = fs::create_dir_all(&dir);
        let root = dir.to_string_lossy().to_string();

        let n = save_favorites(
            &root,
            "favorites.txt",
            &["B.NEF".into(), "a.nef".into(), "b.nef".into(), "  ".into()],
        )
        .unwrap();
        assert_eq!(n, 2);

        let back = read_favorites(&root, "favorites.txt");
        assert_eq!(back, vec!["B.NEF".to_string(), "a.nef".to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }
}
