pub mod fav;
pub mod preview;
pub mod scan;
pub mod settings;
pub mod types;

use std::path::Path;
use types::{PreviewResponse, ScanResult, TrashErrorItem, TrashResponse};

#[tauri::command]
fn is_directory(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
fn open_folder_dialog() -> Option<String> {
    let folder = rfd::FileDialog::new()
        .set_title("选择照片文件夹")
        .pick_folder();
    folder.map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_folder(root: String) -> ScanResult {
    let s = settings::read_settings();
    let recursive = s.get("recursive").and_then(|v| v.as_bool()).unwrap_or(true);
    let group = s.get("groupRawJpeg").and_then(|v| v.as_bool()).unwrap_or(true);
    let fav_name = s.get("favoritesFileName").and_then(|v| v.as_str()).unwrap_or("favorites.txt");

    let _ = settings::add_recent(&root);
    scan::scan_folder(&root, recursive, group, fav_name)
}

#[tauri::command]
fn get_preview(file: String, kind: String) -> PreviewResponse {
    preview::get_preview(&file, &kind)
}

#[tauri::command]
fn save_favorites(root: String, fav_list: Vec<String>) -> Result<usize, String> {
    let s = settings::read_settings();
    let fav_name = s.get("favoritesFileName").and_then(|v| v.as_str()).unwrap_or("favorites.txt");
    fav::save_favorites(&root, fav_name, &fav_list)
}

#[tauri::command]
fn get_favorites(root: String) -> Vec<String> {
    let s = settings::read_settings();
    let fav_name = s.get("favoritesFileName").and_then(|v| v.as_str()).unwrap_or("favorites.txt");
    fav::read_favorites(&root, fav_name)
}

#[tauri::command]
fn trash_files(files: Vec<String>) -> TrashResponse {
    let mut done = Vec::new();
    let mut errors = Vec::new();

    for f in files {
        let p = Path::new(&f);
        if p.exists() {
            match trash::delete(p) {
                Ok(_) => done.push(f),
                Err(e) => errors.push(TrashErrorItem {
                    file: f,
                    error: e.to_string(),
                }),
            }
        }
    }

    TrashResponse {
        ok: errors.is_empty(),
        done,
        errors,
    }
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> bool {
    let p = Path::new(&path);
    if p.exists() {
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", path.replace('/', "\\")))
                .spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn();
        }
        true
    } else {
        false
    }
}

#[tauri::command]
fn open_path(path: String) -> bool {
    open::that(path).is_ok()
}

#[tauri::command]
fn get_settings() -> serde_json::Value {
    settings::read_settings()
}

#[tauri::command]
fn set_settings(patch: serde_json::Value) -> serde_json::Value {
    settings::write_settings(patch)
}

#[tauri::command]
fn get_recent() -> Vec<String> {
    settings::read_recent()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            is_directory,
            open_folder_dialog,
            scan_folder,
            get_preview,
            save_favorites,
            get_favorites,
            trash_files,
            reveal_in_explorer,
            open_path,
            get_settings,
            set_settings,
            get_recent
        ])
        .run(tauri::generate_context!())
        .expect("运行 PhotoView 时发生错误");
}
