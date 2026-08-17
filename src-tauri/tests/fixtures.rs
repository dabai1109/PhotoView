//! 跑一遍 test-photos/，把关键结论打出来，和 node test/parser.test.js 对比
use photoview_lib::preview;
use std::path::{Path, PathBuf};

fn photos() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("test-photos")
}

#[test]
fn dump_every_fixture() {
    let dir = photos();
    assert!(dir.is_dir(), "找不到 test-photos: {}", dir.display());

    let mut files: Vec<PathBuf> = walk(&dir);
    files.sort();

    let mut failed = Vec::new();
    for f in &files {
        let s = f.to_string_lossy().to_string();
        for kind in ["thumb", "full"] {
            let r = preview::get_preview(&s, kind, 0);
            let bytes = r.token.and_then(preview::take_bytes).unwrap_or_default();
            println!(
                "{:<28} {:<5} ok={} bytes={:>8} store={}x{} disp={}x{} orient={} exifOrient={} err={:?}",
                f.file_name().unwrap().to_string_lossy(),
                kind, r.ok, bytes.len(),
                r.store_w, r.store_h, r.width, r.height,
                r.orientation, r.exif_orientation, r.error,
            );
            if r.ok {
                // 拿到的必须是真的 JPEG/PNG，不能是原始 RAW 字节
                assert!(bytes.len() > 128, "{} {} 字节太少", s, kind);
                let is_jpeg = bytes[0] == 0xFF && bytes[1] == 0xD8;
                let is_png = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
                assert!(is_jpeg || is_png, "{} {} 不是有效图片头", s, kind);
            } else {
                failed.push(format!("{} ({}) -> {:?}", s, kind, r.error));
            }
        }
    }
    // test-photos 里每个文件都应该能出预览
    assert!(failed.is_empty(), "这些没能出预览：\n{}", failed.join("\n"));
}

/// 三张 ZS_* 是专门为方向测试造的，文件名末尾就是期望的 EXIF 方向
#[test]
fn portrait_jpegs_report_their_exif_orientation() {
    for (name, want) in [
        ("ZS_1_竖拍o6.JPG", 6u32),
        ("ZS_2_竖拍o8.JPG", 8),
        ("ZS_3_竖拍o3.JPG", 3),
    ] {
        let p = photos().join(name);
        if !p.exists() {
            continue;
        }
        let r = preview::get_preview(&p.to_string_lossy(), "full", 0);
        let _ = r.token.and_then(preview::take_bytes);
        assert!(r.ok, "{} 读取失败: {:?}", name, r.error);
        assert_eq!(r.exif_orientation, want, "{} 的 exifOrientation 不对", name);
        // 相机直出 JPEG 自带方向标签，解码器会自己转 → 渲染层不能再转
        assert_eq!(r.orientation, 1, "{} 的 orientation 应该是 1", name);
        // 方向 5-8 时，解码后的尺寸要和存储尺寸相反
        if (5..=8).contains(&want) {
            assert_eq!((r.width, r.height), (r.store_h, r.store_w), "{} 宽高该交换", name);
        } else {
            assert_eq!((r.width, r.height), (r.store_w, r.store_h), "{} 宽高不该交换", name);
        }
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .map(photoview_lib::scan::is_supported_ext)
            .unwrap_or(false)
        {
            out.push(p);
        }
    }
    out
}

#[test]
fn test_trash_and_restore_cycle() {
    let temp_dir = std::env::temp_dir();
    let test_file = temp_dir.join("photoview_test_restore_cycle.tmp");
    
    // 1. 创建临时测试文件
    std::fs::write(&test_file, "photoview restore test").expect("创建测试临时文件失败");
    assert!(test_file.exists(), "临时文件应该存在");

    let file_str = test_file.to_string_lossy().to_string();

    // 2. 移到系统回收站
    trash::delete(&test_file).expect("移到回收站失败");
    assert!(!test_file.exists(), "移到回收站后文件应该不再存在于原路径");

    // 3. 执行 PowerShell 还原脚本逻辑
    #[cfg(target_os = "windows")]
    {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let target_arg = format!("'{}'", file_str.replace('\'', "''"));
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
            target_arg
        );

        let utf16_bytes: Vec<u8> = script
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let encoded = BASE64.encode(&utf16_bytes);

        let out = std::process::Command::new("powershell.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", &encoded])
            .output()
            .expect("PowerShell 还原执行失败");

        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        println!("Restore test output: {}", stdout);

        // 4. 验证文件已成功回到原路径
        assert!(test_file.exists(), "从回收站还原后文件应该重新存在");

        // 5. 清理测试文件
        let _ = std::fs::remove_file(&test_file);
    }
}

