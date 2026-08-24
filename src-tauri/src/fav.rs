//! 收藏管理模块：将照片文件移入相册根目录的“收藏”文件夹，或移回原目录。

use crate::settings::sanitize_file_name;
use crate::types::MoveItem;
use std::fs;
use std::path::{Path, PathBuf};

/// 获取安全的收藏目录路径
pub fn fav_dir(root: &str, folder_name: &str) -> PathBuf {
    let safe_folder = sanitize_file_name(folder_name, "收藏");
    Path::new(root).join(safe_folder)
}

/// `a.jpg` + 1 -> `a (1).jpg`；n 为 0 时原样返回
fn decorate(file_name: &str, n: u32) -> String {
    if n == 0 {
        return file_name.to_string();
    }
    let p = Path::new(file_name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    match p.extension().and_then(|s| s.to_str()) {
        Some(ext) => format!("{} ({}).{}", stem, n, ext),
        None => format!("{} ({})", stem, n),
    }
}

/// 给一批文件在目标目录里挑一组不冲突的落点。
///
/// 整批必须共用同一个 ` (n)` 后缀：RAW 和 JPG 是靠「同目录 + 同主名」认亲的
/// （见 scan.rs 的分组），只给撞名的那一个加后缀，配对就会在目标目录里分家，
/// 变成两组照片。
fn unique_batch_dests(target_dir: &Path, file_names: &[&str]) -> Vec<PathBuf> {
    for n in 0..10_000u32 {
        let cands: Vec<PathBuf> = file_names
            .iter()
            .map(|name| target_dir.join(decorate(name, n)))
            .collect();
        if cands.iter().all(|p| !p.exists()) {
            return cands;
        }
    }
    // 同一个主名撞上一万次已经不是正常情况，交给下面的 IO 去报错，别在这儿死循环
    file_names.iter().map(|n| target_dir.join(n)).collect()
}

/// 移动单个文件，优先使用 rename，失败时回退到 copy + remove
///
/// 注意 `fs::rename` 在 Windows 上会直接覆盖同名目标文件，所以调用方必须
/// 先用 `unique_batch_dests` 拿到空位 —— 这里不做任何存在性检查。
fn safe_move_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src == dst {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    // 跨卷或被锁定等情况回退
    fs::copy(src, dst)?;
    fs::remove_file(src)?;
    Ok(())
}

/// 一组照片要么整组搬走要么原地不动：中途失败就把已经搬过的挪回去。
///
/// 半途而废最难受的不是这一次失败，而是 RAW 和 JPG 被留在两个目录里 ——
/// 下次扫描它们就是两组照片了，用户还得自己去对。
fn rollback(done: &[MoveItem]) {
    for m in done.iter().rev() {
        if m.from == m.to {
            continue;
        }
        // 回滚再失败也没有别的招了，至少不要盖掉真正的错误原因
        let _ = safe_move_file(Path::new(&m.to), Path::new(&m.from));
    }
}

/// 将一组文件移动到“收藏”文件夹
///
/// 返回的 `MoveItem` 记的是「从哪搬到哪」，前端拿它更新自己记的路径，
/// 撤销时再原路倒回去。已经在收藏夹里的文件返回 `from == to`。
pub fn favorite_files(
    root: &str,
    folder_name: &str,
    files: &[String],
) -> Result<Vec<MoveItem>, String> {
    if !Path::new(root).is_dir() {
        return Err("相册目录不存在".to_string());
    }
    if files.is_empty() {
        return Ok(Vec::new());
    }

    // 先把整组检查一遍再动手：搬到一半才发现少文件，配对就被拆到两个目录里了
    for f in files {
        if !Path::new(f).exists() {
            return Err(format!("文件不存在：{}", f));
        }
    }

    let target_folder = fav_dir(root, folder_name);
    if let Err(e) = fs::create_dir_all(&target_folder) {
        return Err(format!("创建收藏文件夹失败：{}", e));
    }

    let canonical_target = match fs::canonicalize(&target_folder) {
        Ok(p) => p,
        Err(_) => target_folder.clone(),
    };

    let mut results: Vec<Option<MoveItem>> = vec![None; files.len()];
    let mut pending: Vec<(usize, &String, &str)> = Vec::new();

    for (i, f) in files.iter().enumerate() {
        let src_path = Path::new(f);

        // 已经在收藏文件夹里的原样返回，不重复搬
        let is_already_in_fav = src_path
            .parent()
            .and_then(|p| fs::canonicalize(p).ok())
            .map(|p| p == canonical_target)
            .unwrap_or(false);

        if is_already_in_fav {
            results[i] = Some(MoveItem {
                from: f.clone(),
                to: f.clone(),
            });
            continue;
        }

        let file_name = match src_path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => return Err(format!("无效的文件名：{}", f)),
        };
        pending.push((i, f, file_name));
    }

    let names: Vec<&str> = pending.iter().map(|(_, _, n)| *n).collect();
    let dests = unique_batch_dests(&target_folder, &names);

    let mut done: Vec<MoveItem> = Vec::new();
    for ((i, f, _), dest) in pending.iter().zip(dests.iter()) {
        if let Err(e) = safe_move_file(Path::new(f), dest) {
            rollback(&done);
            return Err(format!("移动文件失败（{}）：{}", f, e));
        }
        let item = MoveItem {
            from: (*f).clone(),
            to: dest.to_string_lossy().to_string(),
        };
        done.push(item.clone());
        results[*i] = Some(item);
    }

    Ok(results.into_iter().flatten().collect())
}

/// 把 `favorite_files` 记下的那一步移动倒回去：文件从 `to` 挪回 `from`。
///
/// 原位置要是被别的文件占了（比如卡又拷了一遍），会另挑一个不冲突的名字，
/// 绝不覆盖 —— 覆盖掉的是用户的另一张照片，不可逆。所以真正的落点看返回值的 `to`。
pub fn unfavorite_files(moves: &[MoveItem]) -> Result<Vec<MoveItem>, String> {
    let mut results: Vec<Option<MoveItem>> = vec![None; moves.len()];
    let mut pending: Vec<(usize, &MoveItem)> = Vec::new();

    for (i, item) in moves.iter().enumerate() {
        if item.from == item.to {
            results[i] = Some(item.clone());
            continue;
        }

        let current_path = Path::new(&item.to);
        if !current_path.exists() {
            // 收藏夹里已经没有了：原路径上在的话就是已经还原过，当成完成
            if Path::new(&item.from).exists() {
                results[i] = Some(item.clone());
                continue;
            }
            return Err(format!("找不到待还原的收藏文件：{}", item.to));
        }
        pending.push((i, item));
    }

    // 按目标目录分组，同一个目录里的一批共用防冲突后缀，配对才不会分家
    let mut by_dir: Vec<(PathBuf, Vec<(usize, &MoveItem)>)> = Vec::new();
    for (i, item) in pending {
        let dir = Path::new(&item.from)
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        match by_dir.iter_mut().find(|(d, _)| *d == dir) {
            Some((_, v)) => v.push((i, item)),
            None => by_dir.push((dir, vec![(i, item)])),
        }
    }

    let mut done: Vec<MoveItem> = Vec::new();
    for (dir, items) in &by_dir {
        let names: Vec<String> = items
            .iter()
            .map(|(_, m)| {
                Path::new(&m.from)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            })
            .collect();
        let name_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        let dests = unique_batch_dests(dir, &name_refs);

        for ((i, m), dest) in items.iter().zip(dests.iter()) {
            if let Err(e) = safe_move_file(Path::new(&m.to), dest) {
                rollback(&done);
                return Err(format!("还原文件失败（{}）：{}", m.to, e));
            }
            let item = MoveItem {
                from: m.to.clone(),
                to: dest.to_string_lossy().to_string(),
            };
            done.push(item.clone());
            results[*i] = Some(item);
        }
    }

    Ok(results.into_iter().flatten().collect())
}

/* ---------- 遗留清单（1.5.0 及以前）----------
   收藏已经改成「照片真的搬进收藏文件夹」，这份清单不再是收藏的载体。
   但老用户的相册里还躺着它，扫描仍然读它来保住已有的收藏星星，
   前端在这类相册里取消收藏时也会回写 —— 不然摘掉的星星下次扫描又长回来。
   所以格式必须和 1.5.0 完全一致（txt 一行一条 / json 数组或 {favorites:[]}），
   读得懂什么就得写得回什么，不能把用户的 .json 清单写成纯文本。 */

fn legacy_path(root: &str, file_name: &str) -> PathBuf {
    // 必须先消毒：`Path::join` 遇到绝对路径会把 root 整个替换掉，
    // `file_name` 一旦带上盘符或 `..` 就能写到相册目录之外去
    Path::new(root).join(sanitize_file_name(file_name, "favorites.txt"))
}

fn is_json(file_name: &str) -> bool {
    file_name.to_lowercase().ends_with(".json")
}

pub fn read_favorites(root: &str, file_name: &str) -> Vec<String> {
    let target = legacy_path(root, file_name);
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

    let target = legacy_path(root, file_name);
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

    crate::settings::write_atomic(&target, bytes.as_bytes()).map_err(|e| e.to_string())?;
    Ok(unique.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fav_dir_is_clamped_into_root() {
        let p = fav_dir("D:/Photos", "../../evil");
        assert_eq!(p, Path::new("D:/Photos").join("收藏"));
        let p = fav_dir("D:/Photos", "精选");
        assert_eq!(p, Path::new("D:/Photos").join("精选"));
    }

    #[test]
    fn legacy_path_traversal_is_clamped_into_root() {
        let p = legacy_path("D:/Photos", "../../evil.txt");
        assert_eq!(p, Path::new("D:/Photos").join("favorites.txt"));
        let p = legacy_path("D:/Photos", "C:/Windows/System32/evil.txt");
        assert_eq!(p, Path::new("D:/Photos").join("favorites.txt"));
        // 正常名字要原样保留
        let p = legacy_path("D:/Photos", "选片.json");
        assert_eq!(p, Path::new("D:/Photos").join("选片.json"));
    }

    #[test]
    fn legacy_list_survives_a_read_write_roundtrip() {
        let dir = std::env::temp_dir().join("photoview_fav_legacy_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();

        // txt：去重（大小写不敏感）且保持顺序
        let n = save_favorites(
            &root,
            "favorites.txt",
            &["B.NEF".into(), "a.nef".into(), "b.nef".into(), "  ".into()],
        )
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            read_favorites(&root, "favorites.txt"),
            vec!["B.NEF".to_string(), "a.nef".to_string()]
        );

        // json：老用户可能把清单命名成 .json，读得懂就必须写得回去
        assert!(is_json("选片.JSON"));
        assert!(!is_json("favorites.txt"));
        save_favorites(&root, "选片.json", &["x.nef".into(), "y.jpg".into()]).unwrap();
        assert_eq!(
            read_favorites(&root, "选片.json"),
            vec!["x.nef".to_string(), "y.jpg".to_string()],
            "写成 JSON 就得能按 JSON 读回来，别把人家的清单写成纯文本"
        );

        // 1.5.0 还支持 {"favorites": [...]} 这种写法
        fs::write(dir.join("obj.json"), br#"{"favorites":["k.nef"]}"#).unwrap();
        assert_eq!(read_favorites(&root, "obj.json"), vec!["k.nef".to_string()]);

        assert!(read_favorites("Z:/nope", "favorites.txt").is_empty());
        assert!(save_favorites("Z:/nope/nope", "favorites.txt", &["a".into()]).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn favorite_and_unfavorite_roundtrip() {
        let temp_dir = std::env::temp_dir().join("photoview_fav_roundtrip_test");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let root = temp_dir.to_string_lossy().to_string();
        let sub = temp_dir.join("sub");
        fs::create_dir_all(&sub).unwrap();

        let file_a = sub.join("photo_a.jpg");
        let file_b = sub.join("photo_a.nef");
        fs::write(&file_a, b"jpeg content").unwrap();
        fs::write(&file_b, b"raw content").unwrap();

        let files = vec![
            file_a.to_string_lossy().to_string(),
            file_b.to_string_lossy().to_string(),
        ];

        // 收藏
        let moved = favorite_files(&root, "收藏", &files).unwrap();
        assert_eq!(moved.len(), 2);
        assert!(!file_a.exists());
        assert!(!file_b.exists());

        let target_a = PathBuf::from(&moved[0].to);
        let target_b = PathBuf::from(&moved[1].to);
        assert!(target_a.exists());
        assert!(target_b.exists());
        assert_eq!(target_a.parent().unwrap(), temp_dir.join("收藏"));

        // 移回
        let restored = unfavorite_files(&moved).unwrap();
        assert_eq!(restored.len(), 2);
        assert!(file_a.exists());
        assert!(file_b.exists());
        assert!(!target_a.exists());
        assert!(!target_b.exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn deduplicate_destination_filename() {
        let temp_dir = std::env::temp_dir().join("photoview_fav_dedup_test");
        let _ = fs::remove_dir_all(&temp_dir);
        let fav_folder = temp_dir.join("收藏");
        fs::create_dir_all(&fav_folder).unwrap();

        // 已经在收藏夹里放一个同名文件
        let existing = fav_folder.join("test.jpg");
        fs::write(&existing, b"already here").unwrap();

        let src = temp_dir.join("test.jpg");
        fs::write(&src, b"new content").unwrap();

        let root = temp_dir.to_string_lossy().to_string();
        let moved = favorite_files(&root, "收藏", &[src.to_string_lossy().to_string()]).unwrap();
        assert_eq!(moved.len(), 1);

        let new_dest = PathBuf::from(&moved[0].to);
        assert_eq!(
            new_dest.file_name().unwrap().to_str().unwrap(),
            "test (1).jpg"
        );
        assert!(existing.exists());
        assert!(new_dest.exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn restore_never_clobbers_an_existing_file() {
        let temp_dir = std::env::temp_dir().join("photoview_fav_no_clobber_test");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let root = temp_dir.to_string_lossy().to_string();

        let src = temp_dir.join("a.jpg");
        fs::write(&src, b"the favorited one").unwrap();
        let moved = favorite_files(&root, "收藏", &[src.to_string_lossy().to_string()]).unwrap();

        // 原位置后来又出现了一张同名但不同内容的照片（重新拷了一次卡之类）
        fs::write(&src, b"a different photo").unwrap();

        let restored = unfavorite_files(&moved).unwrap();
        // 已经在原位的那张是别人的数据，绝不能被覆盖
        assert_eq!(fs::read(&src).unwrap(), b"a different photo");
        let landed = PathBuf::from(&restored[0].to);
        assert!(landed.exists());
        assert_eq!(fs::read(&landed).unwrap(), b"the favorited one");
        assert_ne!(landed, src);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn pair_keeps_one_stem_when_the_name_is_taken() {
        let temp_dir = std::env::temp_dir().join("photoview_fav_pair_stem_test");
        let _ = fs::remove_dir_all(&temp_dir);
        let fav_folder = temp_dir.join("收藏");
        fs::create_dir_all(&fav_folder).unwrap();
        let sub = temp_dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let root = temp_dir.to_string_lossy().to_string();

        // 收藏夹里已经有一张别的 a.jpg，但没有 a.nef
        fs::write(fav_folder.join("a.jpg"), b"someone else").unwrap();

        let jpg = sub.join("a.jpg");
        let nef = sub.join("a.nef");
        fs::write(&jpg, b"pair jpg").unwrap();
        fs::write(&nef, b"pair raw").unwrap();

        let moved = favorite_files(
            &root,
            "收藏",
            &[jpg.to_string_lossy().to_string(), nef.to_string_lossy().to_string()],
        )
        .unwrap();

        // RAW+JPG 是一组的：只给冲突的那个加后缀会让主名分家，扫描时被拆成两组
        let stem_of = |p: &str| {
            Path::new(p)
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .to_lowercase()
        };
        assert_eq!(
            stem_of(&moved[0].to),
            stem_of(&moved[1].to),
            "配对文件在收藏夹里必须共用同一个主名"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn a_failed_batch_leaves_nothing_half_moved() {
        let temp_dir = std::env::temp_dir().join("photoview_fav_rollback_test");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let root = temp_dir.to_string_lossy().to_string();

        let good = temp_dir.join("good.jpg");
        fs::write(&good, b"good").unwrap();
        let missing = temp_dir.join("missing.nef");

        let r = favorite_files(
            &root,
            "收藏",
            &[
                good.to_string_lossy().to_string(),
                missing.to_string_lossy().to_string(),
            ],
        );
        assert!(r.is_err());
        // 整组要么全进收藏夹要么原地不动，不能把一半留在收藏夹里
        assert!(good.exists(), "失败后第一个文件必须回到原位");
        assert!(!temp_dir.join("收藏").join("good.jpg").exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
