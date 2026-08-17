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

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ExifData {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub focal: Option<String>,
    pub focal35: Option<String>,
    #[serde(rename = "fNumber")]
    pub f_number: Option<String>,
    pub exposure: Option<String>,
    pub iso: Option<String>,
    pub ev: Option<String>,
    pub date: Option<String>,
    pub orientation: u32,
    #[serde(rename = "pixelX")]
    pub pixel_x: Option<u32>,
    #[serde(rename = "pixelY")]
    pub pixel_y: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreviewResponse {
    pub ok: bool,
    pub cached: bool,
    pub data: Option<String>, // data:image/jpeg;base64,...
    pub mime: Option<String>,
    pub orientation: u32,
    #[serde(rename = "exifOrientation")]
    pub exif_orientation: u32,
    #[serde(rename = "storeW")]
    pub store_w: u32,
    #[serde(rename = "storeH")]
    pub store_h: u32,
    pub width: u32,
    pub height: u32,
    pub exif: Option<ExifData>,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    pub error: Option<String>,
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
