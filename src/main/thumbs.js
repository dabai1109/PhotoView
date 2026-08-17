'use strict';
/** 缩略图磁盘缓存：第二次打开同一文件夹时秒开 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const MAX_BYTES = 800 * 1024 * 1024;
// 烤缩略图的逻辑变了就升版本，让旧缓存自动失效（v2：修正了 EXIF 自带方向被转两次的问题）
const BAKE_VERSION = 'v2';
let dir = null;

function cacheDir() {
  if (!dir) {
    dir = path.join(app.getPath('userData'), 'thumbs');
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function keyFor(filePath, mtimeMs, size, box) {
  return crypto
    .createHash('sha1')
    .update(`${path.resolve(filePath).toLowerCase()}|${Math.round(mtimeMs)}|${size}|${box}|${BAKE_VERSION}`)
    .digest('hex');
}

async function get(filePath, box) {
  try {
    const st = await fsp.stat(filePath);
    const k = keyFor(filePath, st.mtimeMs, st.size, box);
    const p = path.join(cacheDir(), k.slice(0, 2), k + '.jpg');
    const data = await fsp.readFile(p);
    fsp.utimes(p, new Date(), new Date()).catch(() => {});
    return { data, key: k };
  } catch {
    return null;
  }
}

async function put(filePath, box, bytes) {
  try {
    const st = await fsp.stat(filePath);
    const k = keyFor(filePath, st.mtimeMs, st.size, box);
    const sub = path.join(cacheDir(), k.slice(0, 2));
    await fsp.mkdir(sub, { recursive: true });
    await fsp.writeFile(path.join(sub, k + '.jpg'), Buffer.from(bytes));
    return true;
  } catch {
    return false;
  }
}

/** 后台清理：超出上限时按访问时间淘汰 */
async function prune() {
  try {
    const root = cacheDir();
    const files = [];
    let total = 0;
    for (const sub of await fsp.readdir(root)) {
      const sp = path.join(root, sub);
      let list;
      try {
        list = await fsp.readdir(sp);
      } catch {
        continue;
      }
      for (const f of list) {
        const fp = path.join(sp, f);
        try {
          const st = await fsp.stat(fp);
          files.push({ fp, atime: st.atimeMs, size: st.size });
          total += st.size;
        } catch {}
      }
    }
    if (total <= MAX_BYTES) return;
    files.sort((a, b) => a.atime - b.atime);
    for (const f of files) {
      if (total <= MAX_BYTES * 0.8) break;
      try {
        await fsp.unlink(f.fp);
        total -= f.size;
      } catch {}
    }
  } catch {}
}

async function clear() {
  try {
    await fsp.rm(cacheDir(), { recursive: true, force: true });
    dir = null;
    cacheDir();
    return true;
  } catch {
    return false;
  }
}

module.exports = { get, put, prune, clear };
