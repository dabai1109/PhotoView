//! 基于 GitHub Releases 和 tauri-plugin-updater 的自动更新管理模块。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub chunk_length: usize,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percentage: Option<f64>,
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let current_ver = app.package_info().version.to_string();
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => return Err(format!("初始化更新器失败: {e}")),
    };

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateCheckResult {
            available: true,
            current_version: current_ver,
            version: Some(update.version.clone()),
            date: update.date.map(|d| d.to_string()),
            body: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateCheckResult {
            available: false,
            current_version: current_ver,
            version: None,
            date: None,
            body: None,
        }),
        Err(e) => Err(format!("检查更新失败: {e}")),
    }
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| format!("初始化更新器失败: {e}"))?;
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Ok(false),
        Err(e) => return Err(format!("检查更新失败: {e}")),
    };

    let mut downloaded: u64 = 0;
    let app_handle = app.clone();

    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                let percentage = content_length.map(|total| {
                    if total > 0 {
                        ((downloaded as f64 / total as f64) * 100.0).round()
                    } else {
                        0.0
                    }
                });

                let _ = app_handle.emit(
                    "update-download-progress",
                    DownloadProgress {
                        chunk_length,
                        downloaded,
                        total: content_length,
                        percentage,
                    },
                );
            },
            || {
                // 下载与校验完成
            },
        )
        .await
        .map_err(|e| format!("下载安装更新失败: {e}"))?;

    Ok(true)
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}
