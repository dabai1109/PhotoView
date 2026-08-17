'use strict';
/** 扫描文件夹，把 RAW+JPG 同名文件合并成一组 */
const fsp = require('fs').promises;
const path = require('path');
const { isSupported, isRaw } = require('./preview');

const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git', 'Lightroom', '.thumbnails']);

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

async function walk(dir, out, opts, depth) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!opts.recursive) continue;
      if (depth >= 8) continue;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      if (opts.excludeDirs.some((d) => path.resolve(d).toLowerCase() === path.resolve(full).toLowerCase())) continue;
      await walk(full, out, opts, depth + 1);
    } else if (e.isFile()) {
      if (e.name.startsWith('.')) continue;
      if (!isSupported(full)) continue;
      out.push(full);
    }
  }
}

/**
 * @param {string} root
 * @param {{recursive:boolean, group:boolean, excludeDirs:string[]}} opts
 */
async function scanFolder(root, opts) {
  const files = [];
  await walk(root, files, opts, 0);

  const map = new Map();
  for (const f of files) {
    const dir = path.dirname(f);
    const base = path.basename(f, path.extname(f));
    const key = opts.group ? `${dir.toLowerCase()}|${base.toLowerCase()}` : f.toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { dir, base, files: [] };
      map.set(key, g);
    }
    g.files.push(f);
  }

  const groups = [];
  for (const g of map.values()) {
    g.files.sort(); // 先定序，下面的 sizes 要和 files 一一对应
    // 主文件：优先 RAW（内嵌预览质量最高且带完整 EXIF）
    const raws = g.files.filter(isRaw);
    const primary = raws.length ? raws[0] : g.files[0];
    let stat;
    try {
      stat = await fsp.stat(primary);
    } catch {
      continue;
    }
    let total = 0;
    const sizes = [];
    for (const f of g.files) {
      let s = 0;
      try {
        s = (await fsp.stat(f)).size;
      } catch {}
      sizes.push(s);
      total += s;
    }
    groups.push({
      id: path.relative(root, primary) || path.basename(primary),
      dir: g.dir,
      base: g.base,
      name: path.basename(primary),
      files: g.files,
      sizes,
      primary,
      ext: path.extname(primary).slice(1).toUpperCase(),
      isRaw: raws.length > 0,
      hasPair: g.files.length > 1,
      size: total,
      mtime: stat.mtimeMs,
    });
  }

  groups.sort((a, b) => collator.compare(a.id, b.id));
  return groups;
}

module.exports = { scanFolder };
