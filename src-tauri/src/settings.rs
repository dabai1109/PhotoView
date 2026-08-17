use std::fs;
use std::path::PathBuf;

fn get_app_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("PhotoView")
}

pub fn get_settings_path() -> PathBuf {
    let dir = get_app_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

pub fn get_recent_path() -> PathBuf {
    let dir = get_app_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join("recent.json")
}

pub fn read_settings() -> serde_json::Value {
    let p = get_settings_path();
    if let Ok(content) = fs::read_to_string(p) {
        if let Ok(val) = serde_json::from_str(&content) {
            return val;
        }
    }
    serde_json::json!({
        "favoritesFileName": "favorites.txt",
        "groupRawJpeg": true,
        "recursive": true,
        "autoAdvanceOnFavorite": true,
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

pub fn write_settings(patch: serde_json::Value) -> serde_json::Value {
    let mut current = read_settings();
    if let (Some(cur_obj), Some(patch_obj)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            cur_obj.insert(k.clone(), v.clone());
        }
    }
    let p = get_settings_path();
    if let Ok(s) = serde_json::to_string_pretty(&current) {
        let _ = fs::write(p, s);
    }
    current
}

pub fn read_recent() -> Vec<String> {
    let p = get_recent_path();
    if let Ok(c) = fs::read_to_string(p) {
        if let Ok(v) = serde_json::from_str::<Vec<String>>(&c) {
            return v;
        }
    }
    Vec::new()
}

pub fn add_recent(path_str: &str) -> Vec<String> {
    let mut list = read_recent();
    list.retain(|x| x.to_lowercase() != path_str.to_lowercase());
    list.insert(0, path_str.to_string());
    if list.len() > 12 {
        list.truncate(12);
    }
    let p = get_recent_path();
    if let Ok(s) = serde_json::to_string(&list) {
        let _ = fs::write(p, s);
    }
    list
}
