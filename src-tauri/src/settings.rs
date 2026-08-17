//! 应用配置、最近打开、每个相册的会话状态。
//!
//! 全部落在 `<data_dir>/PhotoView/` 下，写入走「临时文件 + 原子改名」，
//! 避免写一半崩溃导致配置损坏后静默回落默认值。

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub fn app_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("PhotoView");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn settings_path() -> PathBuf {
    app_dir().join("settings.json")
}

fn recent_path() -> PathBuf {
    app_dir().join("recent.json")
}

fn session_dir() -> PathBuf {
    let d = app_dir().join("sessions");
    let _ = fs::create_dir_all(&d);
    d
}

/// 128 位 FNV-1a 的十六进制串，用来给路径生成稳定的文件名
pub(crate) fn hash_hex(s: &str) -> String {
    const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013B;
    let mut h: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    for &b in s.as_bytes() {
        h ^= b as u128;
        h = h.wrapping_mul(PRIME);
    }
    format!("{:032x}", h)
}

/// 临时文件 + 原子改名。Windows 上 `fs::rename` 会覆盖已存在的目标。
pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

pub fn defaults() -> Value {
    json!({
        "favoritesFileName": "favorites.txt",
        "groupRawJpeg": true,
        "recursive": true,
        "autoAdvanceOnFavorite": false,
        "autoAdvanceOnDelete": true,
        "confirmDelete": false,
        "thumbSize": 220,
        "sortBy": "name",
        "showInfo": true,
        "showHistogram": true,
        "openLoupeOnDrop": false,
        "theme": "dark"
    })
}

/// 始终以默认值为底再叠加磁盘上的内容，缺 key 也不会漏配置
pub fn read_settings() -> Value {
    let mut merged = defaults();
    let stored: Option<Value> = fs::read_to_string(settings_path())
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());

    if let (Some(base), Some(Value::Object(on_disk))) = (merged.as_object_mut(), stored) {
        for (k, v) in on_disk {
            base.insert(k, v);
        }
    }
    merged
}

pub fn write_settings(patch: Value) -> Value {
    let mut current = read_settings();
    if let (Some(cur), Some(p)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            cur.insert(k.clone(), v.clone());
        }
    }
    if let Ok(s) = serde_json::to_string_pretty(&current) {
        let _ = write_atomic(&settings_path(), s.as_bytes());
    }
    current
}

/// 收藏清单的文件名。必须是纯文件名 —— 否则 `root.join(name)` 会被绝对路径
/// 或 `..` 带出相册目录，等于给前端开了任意文件写入。
pub fn sanitize_file_name(name: &str, fallback: &str) -> String {
    let n = name.trim();
    let bad = n.is_empty()
        || n == "."
        || n == ".."
        || n.contains('/')
        || n.contains('\\')
        || n.contains(':')
        || n.chars().any(|c| c.is_control());
    if bad {
        fallback.to_string()
    } else {
        n.to_string()
    }
}

/// 从配置里读出（已消毒的）收藏文件名
pub fn favorites_file_name() -> String {
    let s = read_settings();
    let raw = s
        .get("favoritesFileName")
        .and_then(|v| v.as_str())
        .unwrap_or("favorites.txt");
    sanitize_file_name(raw, "favorites.txt")
}

pub fn read_recent() -> Vec<String> {
    fs::read_to_string(recent_path())
        .ok()
        .and_then(|c| serde_json::from_str::<Vec<String>>(&c).ok())
        .unwrap_or_default()
}

pub fn add_recent(path_str: &str) -> Vec<String> {
    let mut list = read_recent();
    list.retain(|x| !x.eq_ignore_ascii_case(path_str));
    list.insert(0, path_str.to_string());
    list.truncate(12);
    if let Ok(s) = serde_json::to_string(&list) {
        let _ = write_atomic(&recent_path(), s.as_bytes());
    }
    list
}

fn session_path(root: &str) -> PathBuf {
    let key = hash_hex(&root.to_lowercase());
    session_dir().join(format!("{}.json", &key[..16]))
}

pub fn get_session(root: &str) -> Value {
    fs::read_to_string(session_path(root))
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .unwrap_or_else(|| json!({ "root": root, "favorites": {}, "cursor": 0 }))
}

pub fn set_session(root: &str, data: Value) -> bool {
    let mut obj = match data {
        Value::Object(o) => o,
        _ => serde_json::Map::new(),
    };
    obj.insert("root".to_string(), Value::String(root.to_string()));
    match serde_json::to_string(&Value::Object(obj)) {
        Ok(s) => write_atomic(&session_path(root), s.as_bytes()).is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_complete() {
        let d = defaults();
        assert_eq!(d["favoritesFileName"], "favorites.txt");
        assert_eq!(d["thumbSize"], 220);
        assert_eq!(d["theme"], "dark");
    }

    #[test]
    fn sanitize_rejects_traversal() {
        assert_eq!(sanitize_file_name("favorites.txt", "fb.txt"), "favorites.txt");
        assert_eq!(sanitize_file_name("选片.json", "fb.txt"), "选片.json");
        // 这些都会把写入带出相册目录
        assert_eq!(sanitize_file_name("../../evil.txt", "fb.txt"), "fb.txt");
        assert_eq!(sanitize_file_name("C:\\Windows\\evil.txt", "fb.txt"), "fb.txt");
        assert_eq!(sanitize_file_name("/etc/passwd", "fb.txt"), "fb.txt");
        assert_eq!(sanitize_file_name("sub/dir.txt", "fb.txt"), "fb.txt");
        assert_eq!(sanitize_file_name("  ", "fb.txt"), "fb.txt");
        assert_eq!(sanitize_file_name("..", "fb.txt"), "fb.txt");
        assert_eq!(sanitize_file_name("a\0b.txt", "fb.txt"), "fb.txt");
    }

    #[test]
    fn session_key_is_stable_and_case_insensitive() {
        assert_eq!(session_path("D:/Photos"), session_path("d:/photos"));
        assert_ne!(session_path("D:/Photos"), session_path("D:/Other"));
    }

    #[test]
    fn hash_is_32_hex_chars() {
        let h = hash_hex("anything");
        assert_eq!(h.len(), 32);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
