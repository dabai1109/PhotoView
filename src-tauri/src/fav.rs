use std::fs;
use std::path::Path;

pub fn read_favorites(root: &str, file_name: &str) -> Vec<String> {
    let target = Path::new(root).join(file_name);
    if !target.exists() {
        return Vec::new();
    }

    if let Ok(content) = fs::read_to_string(&target) {
        if file_name.to_lowercase().ends_with(".json") {
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

        // txt 格式
        return content
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect();
    }
    Vec::new()
}

pub fn save_favorites(root: &str, file_name: &str, fav_list: &[String]) -> Result<usize, String> {
    let target = Path::new(root).join(file_name);
    let mut unique = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for item in fav_list {
        let trimmed = item.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_lowercase()) {
            unique.push(trimmed.to_string());
        }
    }

    let count = unique.len();
    if file_name.to_lowercase().ends_with(".json") {
        let json_str = serde_json::to_string_pretty(&unique).map_err(|e| e.to_string())?;
        fs::write(target, json_str).map_err(|e| e.to_string())?;
    } else {
        let mut text = String::new();
        for item in &unique {
            text.push_str(item);
            text.push_str("\r\n");
        }
        fs::write(target, text).map_err(|e| e.to_string())?;
    }

    Ok(count)
}
