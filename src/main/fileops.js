'use strict';
/**
 * 文件操作：收藏（复制/移动到收藏夹）、删除（进系统回收站）、从回收站还原。
 * 所有删除都走 shell.trashItem，文件进 Windows 回收站，随时可恢复。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const { execFile } = require('child_process');

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 目标已存在时自动加 _1 _2 后缀 */
async function uniquePath(target) {
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, `${base}_${i}${ext}`);
    if (!(await exists(p))) return p;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

/** 跨盘安全的移动 */
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await fsp.copyFile(from, to);
      await fsp.unlink(from);
    } else throw e;
  }
}

/**
 * 读取相册目录下的收藏记录文件（支持 .txt 或 .json）
 * @param {string} root 相册根目录
 * @param {string} fileName 记录文件名，如 favorites.txt
 * @returns {Promise<string[]>} 已收藏的文件标识列表（文件名或相对路径）
 */
async function readFavorites(root, fileName = 'favorites.txt') {
  const target = path.join(root, fileName);
  if (!(await exists(target))) return [];
  try {
    const raw = await fsp.readFile(target, 'utf8');
    if (fileName.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.favorites)) return parsed.favorites;
      return [];
    }
    // txt 格式：按行读取，忽略空行与 # 注释
    return raw
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (e) {
    console.warn('读取收藏记录文件失败:', e);
    return [];
  }
}

/**
 * 写入相册目录下的收藏记录文件
 * @param {string} root 相册根目录
 * @param {string} fileName 记录文件名，如 favorites.txt
 * @param {string[]} favList 已收藏的文件标识列表
 * @returns {Promise<{ok:boolean, file:string, count:number, error?:string}>}
 */
async function writeFavorites(root, fileName = 'favorites.txt', favList = []) {
  const target = path.join(root, fileName);
  try {
    const uniqueList = Array.from(new Set(favList.filter(Boolean)));
    if (fileName.toLowerCase().endsWith('.json')) {
      await fsp.writeFile(target, JSON.stringify(uniqueList, null, 2), 'utf8');
    } else {
      const content = uniqueList.length > 0 ? uniqueList.join('\r\n') + '\r\n' : '';
      await fsp.writeFile(target, content, 'utf8');
    }
    return { ok: true, file: target, count: uniqueList.length };
  } catch (e) {
    return { ok: false, file: target, count: 0, error: String(e.message || e) };
  }
}

/** 删除到系统回收站 */
async function trash(files) {
  const done = [];
  const errors = [];
  for (const f of files) {
    try {
      if (!(await exists(f))) continue;
      await shell.trashItem(f);
      done.push(f);
    } catch (e) {
      errors.push({ file: f, error: String(e.message || e) });
    }
  }
  return { ok: errors.length === 0, done, errors };
}

function psEncode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 从 Windows 回收站还原文件到原位置。
 * 通过 Shell.Application COM 对象查找"原始位置"匹配的项并执行还原动词。
 */
async function restoreFromRecycleBin(files) {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
  const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$targets = @(${list})
$shell = New-Object -ComObject Shell.Application
$rb = $shell.Namespace(10)
$items = @($rb.Items())
$result = @()
foreach ($t in $targets) {
  $dir  = Split-Path -Parent $t
  $leaf = Split-Path -Leaf $t
  $noext = [System.IO.Path]::GetFileNameWithoutExtension($t)
  if (Test-Path -LiteralPath $t) { $result += @{ path=$t; ok=$true; note='exists' }; continue }
  $found = $null
  foreach ($it in $items) {
    $loc = $rb.GetDetailsOf($it, 1)
    if ($loc -ne $dir) { continue }
    if ($it.Name -eq $leaf -or $it.Name -eq $noext) { $found = $it; break }
  }
  if ($null -eq $found) { $result += @{ path=$t; ok=$false; note='not-found' }; continue }
  $done = $false
  foreach ($v in @($found.Verbs())) {
    $n = ($v.Name -replace '&','')
    if ($n -match '还原|復原|恢复|Restore|Wiederherstellen|Restaurer|Restaurar|Ripristina|元に戻す|복원') {
      $v.DoIt(); $done = $true; break
    }
  }
  if (-not $done) { $found.InvokeVerb('undelete') }
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $t) { $ok = $true; break }
  }
  $result += @{ path=$t; ok=$ok; note='restored' }
}
ConvertTo-Json -Compress -InputObject @($result)
`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', psEncode(script)],
      { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: String(err.message || err) });
        let parsed = [];
        try {
          const t = String(stdout || '').trim();
          if (t) parsed = JSON.parse(t);
          if (!Array.isArray(parsed)) parsed = [parsed];
        } catch {}
        const okAll = parsed.length > 0 && parsed.every((r) => r.ok);
        resolve({ ok: okAll, results: parsed });
      }
    );
  });
}

module.exports = { readFavorites, writeFavorites, trash, restoreFromRecycleBin, uniquePath, exists };
