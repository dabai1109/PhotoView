pub mod fav;
pub mod preview;
pub mod scan;
pub mod settings;
pub mod thumbs;
pub mod tiff;
pub mod types;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::path::Path;
use types::{
    PreviewResponse, RestoreItemResult, RestoreResponse, ScanResult, TrashErrorItem, TrashResponse,
};

/// 所有会读写磁盘的命令都必须离开主线程。
///
/// Tauri 里非 async 的命令跑在主线程上 —— 扫描上千张 RAW 时窗口会整个冻住。
/// 这里统一走 `spawn_blocking`：既不占主线程，也不会把阻塞 IO 塞进 async 执行器。
async fn blocking<T, F>(f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.ok()
}

#[tauri::command]
async fn is_directory(path: String) -> bool {
    blocking(move || Path::new(&path).is_dir()).await.unwrap_or(false)
}

#[tauri::command]
async fn open_folder_dialog() -> Option<String> {
    // 原生对话框是阻塞的，绝不能在主线程上开
    blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择照片文件夹")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .flatten()
}

#[tauri::command]
async fn scan_folder(root: String) -> ScanResult {
    let fallback = ScanResult {
        ok: false,
        root: root.clone(),
        groups: Vec::new(),
        favorites_file_name: "favorites.txt".to_string(),
    };
    blocking(move || {
        let s = settings::read_settings();
        let recursive = s.get("recursive").and_then(|v| v.as_bool()).unwrap_or(true);
        let group = s.get("groupRawJpeg").and_then(|v| v.as_bool()).unwrap_or(true);
        let fav_name = settings::favorites_file_name();

        let _ = settings::add_recent(&root);
        scan::scan_folder(&root, recursive, group, &fav_name)
    })
    .await
    .unwrap_or(fallback)
}

/// 只返回元数据，图片字节由 `take_preview_bytes` 以二进制取走
#[tauri::command]
async fn get_preview(file: String, kind: String, box_size: Option<u32>) -> PreviewResponse {
    let box_size = box_size.unwrap_or(0);
    blocking(move || preview::get_preview(&file, &kind, box_size))
        .await
        .unwrap_or_else(|| PreviewResponse::err("预览任务被中断", None, 0))
}

/// 凭 token 取走图片字节。返回原始二进制，不经过 JSON / base64。
#[tauri::command]
async fn take_preview_bytes(token: u64) -> tauri::ipc::Response {
    let bytes = blocking(move || preview::take_bytes(token).unwrap_or_default())
        .await
        .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

/// 前端 worker 烤好的缩略图存盘（data 是 base64，比 JSON 数字数组小得多）
#[tauri::command]
async fn put_thumb(file: String, box_size: u32, data: String) -> bool {
    blocking(move || match BASE64.decode(data.as_bytes()) {
        Ok(bytes) => thumbs::put(&file, box_size, &bytes),
        Err(_) => false,
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
async fn clear_cache() -> bool {
    blocking(thumbs::clear).await.unwrap_or(false)
}

#[tauri::command]
async fn save_favorites(root: String, fav_list: Vec<String>) -> Result<usize, String> {
    blocking(move || {
        let fav_name = settings::favorites_file_name();
        fav::save_favorites(&root, &fav_name, &fav_list)
    })
    .await
    .unwrap_or_else(|| Err("保存任务被中断".to_string()))
}

#[tauri::command]
async fn get_favorites(root: String) -> Vec<String> {
    blocking(move || {
        let fav_name = settings::favorites_file_name();
        fav::read_favorites(&root, &fav_name)
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn trash_files(files: Vec<String>) -> TrashResponse {
    blocking(move || {
        let mut done = Vec::new();
        let mut errors = Vec::new();

        for f in files {
            let p = Path::new(&f);
            // 不存在也要报出来，否则前端会把"什么都没删"当成删除成功
            if !p.exists() {
                errors.push(TrashErrorItem {
                    file: f,
                    error: "文件不存在或已被移走".to_string(),
                });
                continue;
            }

            // trash crate 内部会先 fs::canonicalize，失败时只抛一个
            // `CanonicalizePath(original: ...)` —— 完全看不出是被别的程序占用、
            // 没权限、还是路径太长。这里自己先做一次，把真正的系统错误捞出来给用户。
            if let Err(e) = std::fs::canonicalize(p) {
                let n = f.chars().count();
                let hint = if n >= 250 {
                    format!("（路径长 {} 字符，已接近 Windows 260 上限）", n)
                } else {
                    String::new()
                };
                errors.push(TrashErrorItem {
                    // 原因写在前面：toast 会截断，别让有用的信息被切掉
                    error: format!("系统打不开这个文件{}：{} — {}", hint, e, f),
                    file: f,
                });
                continue;
            }

            match trash::delete(p) {
                Ok(_) => done.push(f),
                Err(e) => errors.push(TrashErrorItem {
                    file: f,
                    error: e.to_string(),
                }),
            }
        }

        TrashResponse {
            ok: errors.is_empty(),
            done,
            errors,
        }
    })
    .await
    .unwrap_or(TrashResponse {
        ok: false,
        done: Vec::new(),
        errors: vec![TrashErrorItem {
            file: String::new(),
            error: "删除任务被中断".to_string(),
        }],
    })
}

#[tauri::command]
async fn restore_files(files: Vec<String>) -> RestoreResponse {
    blocking(move || {
        if files.is_empty() {
            return RestoreResponse {
                ok: true,
                results: Vec::new(),
                error: None,
            };
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            let targets_joined = files
                .iter()
                .map(|f| format!("'{}'", f.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(",");

            let script = format!(
                r#"$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$targets = @({})
$shell = New-Object -ComObject Shell.Application
$rb = $shell.Namespace(10)
$items = @($rb.Items())
$result = @()
foreach ($t in $targets) {{
  $dir  = Split-Path -Parent $t
  $leaf = Split-Path -Leaf $t
  $noext = [System.IO.Path]::GetFileNameWithoutExtension($t)
  if (Test-Path -LiteralPath $t) {{ $result += @{{ path=$t; ok=$true; note='exists' }}; continue }}
  $found = $null
  foreach ($it in $items) {{
    $loc = $rb.GetDetailsOf($it, 1)
    if ($loc -ne $dir) {{ continue }}
    if ($it.Name -eq $leaf -or $it.Name -eq $noext) {{ $found = $it; break }}
  }}
  if ($null -eq $found) {{ $result += @{{ path=$t; ok=$false; note='not-found' }}; continue }}
  $done = $false
  foreach ($v in @($found.Verbs())) {{
    $n = ($v.Name -replace '&','')
    if ($n -match '还原|復原|恢复|Restore|Wiederherstellen|Restaurer|Restaurar|Ripristina|元に戻す|복원') {{
      $v.DoIt(); $done = $true; break
    }}
  }}
  if (-not $done) {{ $found.InvokeVerb('undelete') }}
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {{
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $t) {{ $ok = $true; break }}
  }}
  $result += @{{ path=$t; ok=$ok; note='restored' }}
}}
ConvertTo-Json -Compress -InputObject @($result)
"#,
                targets_joined
            );

            let utf16_bytes: Vec<u8> = script
                .encode_utf16()
                .flat_map(|u| u.to_le_bytes())
                .collect();
            let encoded = BASE64.encode(&utf16_bytes);

            match std::process::Command::new("powershell.exe")
                .creation_flags(CREATE_NO_WINDOW)
                .args(["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", &encoded])
                .output()
            {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if stdout.is_empty() {
                        return RestoreResponse {
                            ok: false,
                            results: Vec::new(),
                            error: Some("PowerShell 未返回还原结果".to_string()),
                        };
                    }
                    if let Ok(list) = serde_json::from_str::<Vec<RestoreItemResult>>(&stdout) {
                        let all_ok = !list.is_empty() && list.iter().all(|x| x.ok);
                        RestoreResponse {
                            ok: all_ok,
                            results: list,
                            error: None,
                        }
                    } else if let Ok(single) = serde_json::from_str::<RestoreItemResult>(&stdout) {
                        let all_ok = single.ok;
                        RestoreResponse {
                            ok: all_ok,
                            results: vec![single],
                            error: None,
                        }
                    } else {
                        RestoreResponse {
                            ok: false,
                            results: Vec::new(),
                            error: Some(format!("解析还原结果失败，输出：{}", stdout)),
                        }
                    }
                }
                Err(e) => RestoreResponse {
                    ok: false,
                    results: Vec::new(),
                    error: Some(format!("启动 PowerShell 失败：{}", e)),
                },
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = files;
            RestoreResponse {
                ok: false,
                results: Vec::new(),
                error: Some("自动从回收站还原目前仅支持 Windows".to_string()),
            }
        }
    })
    .await
    .unwrap_or_else(|| RestoreResponse {
        ok: false,
        results: Vec::new(),
        error: Some("还原任务被中断".to_string()),
    })
}

#[tauri::command]
async fn reveal_in_explorer(path: String) -> bool {
    blocking(move || {
        let p = Path::new(&path);
        if !p.exists() {
            return false;
        }

        #[cfg(target_os = "windows")]
        {
            // explorer.exe 的 /select 参数必须整串手工引号传进去。
            // 走 .arg() 的话 Rust 会因为路径里有空格再包一层引号，explorer 解析不了，
            // 结果是打开"文档"目录而不是选中文件。
            use std::os::windows::process::CommandExt;
            let win_path = path.replace('/', "\\");
            std::process::Command::new("explorer.exe")
                .raw_arg(format!("/select,\"{}\"", win_path))
                .spawn()
                .is_ok()
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .is_ok()
        }

        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            // Linux 没有统一的"选中文件"接口，退而求其次打开所在目录
            match p.parent() {
                Some(dir) => open::that(dir).is_ok(),
                None => false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
async fn open_path(path: String) -> bool {
    blocking(move || Path::new(&path).exists() && open::that(path).is_ok())
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn get_settings() -> serde_json::Value {
    blocking(settings::read_settings)
        .await
        .unwrap_or_else(settings::defaults)
}

#[tauri::command]
async fn set_settings(patch: serde_json::Value) -> serde_json::Value {
    blocking(move || settings::write_settings(patch))
        .await
        .unwrap_or_else(settings::defaults)
}

#[tauri::command]
async fn get_recent() -> Vec<String> {
    blocking(settings::read_recent).await.unwrap_or_default()
}

#[tauri::command]
async fn get_session(root: String) -> serde_json::Value {
    blocking(move || settings::get_session(&root))
        .await
        .unwrap_or_else(|| serde_json::json!({ "cursor": 0 }))
}

#[tauri::command]
async fn set_session(root: String, data: serde_json::Value) -> bool {
    blocking(move || settings::set_session(&root, data))
        .await
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            // 启动后台清理，别让缩略图缓存无限长大
            tauri::async_runtime::spawn(async {
                let _ = tauri::async_runtime::spawn_blocking(thumbs::prune).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_directory,
            open_folder_dialog,
            scan_folder,
            get_preview,
            take_preview_bytes,
            put_thumb,
            clear_cache,
            save_favorites,
            get_favorites,
            trash_files,
            restore_files,
            reveal_in_explorer,
            open_path,
            get_settings,
            set_settings,
            get_recent,
            get_session,
            set_session
        ])
        .run(tauri::generate_context!())
        .expect("运行 PhotoView 时发生错误");
}
