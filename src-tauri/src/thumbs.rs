//! 缩略图磁盘缓存：第二次打开同一文件夹时秒开。
//!
//! 存的是前端 worker 已经烤好的缩略图（正过向、缩过放的 JPEG），
//! 命中时可以完全跳过 RAW 解析和解码。

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

const MAX_BYTES: u64 = 800 * 1024 * 1024;
/// 烤缩略图的逻辑变了就升版本，让旧缓存自动失效
const BAKE_VERSION: &str = "v2";

fn cache_dir() -> PathBuf {
    let dir = crate::settings::app_dir().join("thumbs");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 缓存键里同时带了 mtime 和 size，用不着密码学哈希
fn key_for(path: &str, mtime_ms: u64, size: u64, box_size: u32) -> String {
    let s = format!(
        "{}|{}|{}|{}|{}",
        path.to_lowercase(),
        mtime_ms,
        size,
        box_size,
        BAKE_VERSION
    );
    crate::settings::hash_hex(&s)
}

/// (mtime 毫秒, 字节数)
fn stat_of(path: &str) -> Option<(u64, u64)> {
    let m = fs::metadata(path).ok()?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some((mtime, m.len()))
}

fn path_for(key: &str) -> PathBuf {
    cache_dir().join(&key[..2]).join(format!("{}.jpg", key))
}

pub fn get(path: &str, box_size: u32) -> Option<Vec<u8>> {
    if box_size == 0 {
        return None;
    }
    let (mtime, size) = stat_of(path)?;
    let key = key_for(path, mtime, size, box_size);
    fs::read(path_for(&key)).ok()
}

pub fn put(path: &str, box_size: u32, bytes: &[u8]) -> bool {
    if box_size == 0 || bytes.is_empty() {
        return false;
    }
    let (mtime, size) = match stat_of(path) {
        Some(v) => v,
        None => return false,
    };
    let key = key_for(path, mtime, size, box_size);
    let target = path_for(&key);
    if let Some(parent) = target.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    fs::write(target, bytes).is_ok()
}

pub fn clear() -> bool {
    let dir = cache_dir();
    let ok = fs::remove_dir_all(&dir).is_ok();
    let _ = fs::create_dir_all(&dir);
    ok
}

/// 后台清理：超出上限时按写入时间淘汰最旧的。
///
/// 用 mtime 而不是 atime —— Windows 默认不更新 atime，拿它排序等于随机排序。
pub fn prune() {
    let root = cache_dir();
    let mut files: Vec<(PathBuf, u64, u64)> = Vec::new(); // (路径, mtime, 大小)
    let mut total: u64 = 0;

    let subs = match fs::read_dir(&root) {
        Ok(s) => s,
        Err(_) => return,
    };
    for sub in subs.flatten() {
        let list = match fs::read_dir(sub.path()) {
            Ok(l) => l,
            Err(_) => continue,
        };
        for f in list.flatten() {
            if let Ok(md) = f.metadata() {
                if !md.is_file() {
                    continue;
                }
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                total += md.len();
                files.push((f.path(), mtime, md.len()));
            }
        }
    }

    if total <= MAX_BYTES {
        return;
    }
    files.sort_by_key(|x| x.1);
    let target = (MAX_BYTES as f64 * 0.8) as u64;
    for (p, _, size) in files {
        if total <= target {
            break;
        }
        if fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_changes_with_every_input() {
        let a = key_for("c:/a.nef", 1, 2, 220);
        assert_eq!(a.len(), 32);
        assert_ne!(a, key_for("c:/b.nef", 1, 2, 220));
        assert_ne!(a, key_for("c:/a.nef", 9, 2, 220));
        assert_ne!(a, key_for("c:/a.nef", 1, 9, 220));
        assert_ne!(a, key_for("c:/a.nef", 1, 2, 320));
    }

    /// Windows 路径大小写不敏感，键必须一致
    #[test]
    fn key_is_case_insensitive() {
        assert_eq!(
            key_for("C:/Photos/A.NEF", 1, 2, 220),
            key_for("c:/photos/a.nef", 1, 2, 220)
        );
    }

    #[test]
    fn box_zero_is_never_cached() {
        assert!(get("whatever", 0).is_none());
        assert!(!put("whatever", 0, b"x"));
    }
}
