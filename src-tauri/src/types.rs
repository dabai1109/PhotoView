use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PhotoGroup {
    pub id: String,
    pub dir: String,
    pub base: String,
    pub name: String,
    pub files: Vec<String>,
    pub sizes: Vec<u64>,
    pub primary: String,
    pub ext: String,
    #[serde(rename = "isRaw")]
    pub is_raw: bool,
    #[serde(rename = "hasPair")]
    pub has_pair: bool,
    pub size: u64,
    pub mtime: f64,
    pub favored: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    pub ok: bool,
    pub root: String,
    pub groups: Vec<PhotoGroup>,
    #[serde(rename = "favoritesFileName")]
    pub favorites_file_name: String,
}

/// 字段名必须与 app.js 的读取方式一致：ex.aperture / ex.shutter / ex.iso / ex.focal …
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ExifData {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    /// 已格式化，如 "1/250s"
    pub shutter: Option<String>,
    /// 已格式化，如 "f/1.8"
    pub aperture: Option<String>,
    /// 已格式化，如 "ISO 400"
    pub iso: Option<String>,
    /// 已格式化，如 "35mm"
    pub focal: Option<String>,
    pub focal35: Option<String>,
    /// 已格式化，如 "+0.3 EV"
    pub ev: Option<String>,
    pub date: Option<String>,
    pub orientation: u32,
    #[serde(rename = "pixelX")]
    pub pixel_x: Option<u32>,
    #[serde(rename = "pixelY")]
    pub pixel_y: Option<u32>,
}

/// 预览响应「元数据」部分。
///
/// 图片字节**不走这里** —— 它们被暂存在 Rust 侧，前端拿 `token` 通过
/// `take_preview_bytes` 以二进制方式取走（见 tauri-bridge.js）。
/// 这样避免了 base64 带来的 +33% 体积和一次大字符串的 JSON 编解码。
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct PreviewResponse {
    pub ok: bool,
    /// true = 命中磁盘缩略图缓存，字节已是烤好的缩略图，前端直接用
    pub cached: bool,
    /// 取字节用的一次性凭据；ok=false 时为 None
    pub token: Option<u64>,
    pub mime: Option<String>,
    /// 渲染层还需要补的旋转（解码器已处理的部分不重复转）
    pub orientation: u32,
    #[serde(rename = "exifOrientation")]
    pub exif_orientation: u32,
    /// 文件里实际存的尺寸，worker 缩放要用
    #[serde(rename = "storeW")]
    pub store_w: u32,
    #[serde(rename = "storeH")]
    pub store_h: u32,
    /// 解码后（= 屏幕上）的尺寸
    pub width: u32,
    pub height: u32,
    pub exif: Option<ExifData>,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    pub error: Option<String>,
}

impl PreviewResponse {
    pub fn err(msg: impl Into<String>, exif: Option<ExifData>, file_size: u64) -> Self {
        PreviewResponse {
            ok: false,
            orientation: 1,
            exif_orientation: 1,
            exif,
            file_size,
            error: Some(msg.into()),
            ..Default::default()
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrashResponse {
    pub ok: bool,
    pub done: Vec<String>,
    pub errors: Vec<TrashErrorItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrashErrorItem {
    pub file: String,
    pub error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RestoreItemResult {
    pub path: String,
    pub ok: bool,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RestoreResponse {
    pub ok: bool,
    pub results: Vec<RestoreItemResult>,
    pub error: Option<String>,
}
