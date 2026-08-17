'use strict';
/**
 * 图片预览提取：
 *  - 普通图片（jpg/png/webp/gif/avif）→ 直接返回文件字节
 *  - RAW（NEF/NRW/CR2/ARW/DNG/PEF/SRW/ORF/RW2…）→ 提取内嵌 JPEG 预览
 *  - CR3/RAF 等非 TIFF 容器 → 暴力扫描内嵌 JPEG 兜底
 *
 * 尼康 NEF 通常内嵌一张与原图同尺寸（或 1620×1080）的 JPEG 预览，
 * 直接取它来看片，速度比解码 RAW 快一到两个数量级，也是专业选片软件的做法。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { walkTiff, scanJpegs, jpegSize, toExif, exifFromJpeg } = require('./tiff');

const RAW_EXT = new Set([
  '.nef', '.nrw', // 尼康
  '.cr2', '.cr3', '.crw', // 佳能
  '.arw', '.srf', '.sr2', // 索尼
  '.dng', // 通用
  '.raf', // 富士
  '.orf', // 奥林巴斯
  '.rw2', // 松下
  '.pef', '.ptx', // 宾得
  '.srw', // 三星
  '.raw', '.rwl', '.iiq', '.3fr', '.fff', '.erf', '.mrw', '.x3f',
]);
const PLAIN_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.png', '.webp', '.gif', '.bmp', '.avif']);

const HEAD_BYTES = 1024 * 1024; // 先读 1MB 头部解析 IFD，绝大多数 RAW 足够
const MAX_FULL_READ = 300 * 1024 * 1024;

const isRaw = (p) => RAW_EXT.has(path.extname(p).toLowerCase());
const isPlain = (p) => PLAIN_EXT.has(path.extname(p).toLowerCase());
const isSupported = (p) => isRaw(p) || isPlain(p);

/**
 * 这段 JPEG 字节自身带的 EXIF 方向。
 * 关键：浏览器的解码器（<img> 和 createImageBitmap）会自动按它转向，
 * 渲染层只需要补上解码器没转的那部分，否则就会转两次（竖图变横图）。
 * RAW 里抠出来的预览通常不带 EXIF（返回 1），相机直出的 JPEG 则一定带。
 */
function selfOrientation(data) {
  try {
    const r = exifFromJpeg(data);
    if (!r) return 1;
    const o = toExif(r.tags).orientation;
    return o >= 1 && o <= 8 ? o : 1;
  } catch {
    return 1;
  }
}

const swaps = (o) => o >= 5 && o <= 8;

/** 分析 RAW 文件，返回预览候选列表 + EXIF */
async function analyzeRaw(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const headLen = Math.min(stat.size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);

    let parsed = walkTiff(head, 0);
    let full = null;

    // 只有在解析失败 / 结构被截断 / 一张预览都没找到时才整读文件；
    // 偏移超出头部但结构完整的（真实 NEF 的常态）后面按字节范围定点读取即可
    const needsFull = !parsed || parsed.truncated || parsed.previews.length === 0;

    if (needsFull && stat.size <= MAX_FULL_READ) {
      full = Buffer.alloc(stat.size);
      await fh.read(full, 0, stat.size, 0);
      const p2 = walkTiff(full, 0);
      if (p2 && p2.previews.length) parsed = p2;
      else if (p2 && !parsed) parsed = p2;
    }

    let previews = parsed ? parsed.previews.slice() : [];
    const src = full || head;
    // 校验候选：必须以 SOI 开头（越界的先留着，稍后按需读盘校验）
    previews = previews.filter((p) => {
      if (p.offset < 0 || p.length <= 0) return false;
      if (p.offset + 2 > src.length) return !!full ? false : true;
      return src[p.offset] === 0xff && src[p.offset + 1] === 0xd8;
    });
    if (!previews.length && full) previews = scanJpegs(full); // 兜底：CR3 / RAF 等非 TIFF 容器
    // 补全尺寸
    for (const p of previews) {
      if ((!p.width || !p.height) && p.offset + 4 < src.length) {
        const sz = jpegSize(src, p.offset, Math.min(p.offset + p.length, src.length));
        if (sz) {
          p.width = sz.width;
          p.height = sz.height;
        }
      }
    }

    const exif = toExif(parsed ? parsed.tags : null);
    return { previews, exif, size: stat.size, buffer: full, headLen };
  } finally {
    await fh.close();
  }
}

/** 缓存分析结果（只存偏移表和 EXIF，很小），避免 thumb / full 反复读盘解析 */
const analyzeCache = new Map(); // path -> {mtime, previews, exif}
const ANALYZE_CACHE_MAX = 400;

function putAnalyze(key, val) {
  analyzeCache.set(key, val);
  while (analyzeCache.size > ANALYZE_CACHE_MAX) {
    const first = analyzeCache.keys().next().value;
    analyzeCache.delete(first);
  }
}

/**
 * 取出可直接交给浏览器解码的 JPEG 字节。
 * kind: 'thumb' 取够用的最小预览（快），'full' 取最大预览（清晰）
 */
async function getPreview(filePath, kind = 'thumb') {
  const st = await fsp.stat(filePath);

  if (isPlain(filePath)) {
    const data = await fsp.readFile(filePath);
    let exif = {};
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.jpe') {
      const r = exifFromJpeg(data);
      if (r) exif = toExif(r.tags);
      if (!exif.pixelX) {
        const sz = jpegSize(data);
        if (sz) {
          exif.pixelX = sz.width;
          exif.pixelY = sz.height;
        }
      }
    }
    // 相机直出 JPEG 自带方向标签，解码器会自己转 → 渲染层不要再转
    const self = exif.orientation || 1;
    const storeW = exif.pixelX || 0;
    const storeH = exif.pixelY || 0;
    return {
      ok: true,
      data,
      mime: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
      orientation: 1, // 解码器已经处理，渲染层无需额外旋转
      exifOrientation: self,
      storeW,
      storeH,
      width: swaps(self) ? storeH : storeW, // 解码后（= 屏幕上）的尺寸
      height: swaps(self) ? storeW : storeH,
      exif,
      fileSize: st.size,
    };
  }

  const key = filePath;
  let a = analyzeCache.get(key);
  let fresh = null; // 本次分析时整读进来的 buffer（不放进缓存，避免占内存）
  if (!a || a.mtime !== st.mtimeMs) {
    const r = await analyzeRaw(filePath);
    a = { mtime: st.mtimeMs, previews: r.previews, exif: r.exif };
    fresh = r.buffer;
    putAnalyze(key, a);
  }

  if (!a.previews.length) {
    return { ok: false, error: '该文件中没有找到可用的内嵌预览图', exif: a.exif, fileSize: st.size };
  }

  const sorted = a.previews.slice().sort((x, y) => {
    const lx = Math.max(x.width, x.height) || x.length / 1000;
    const ly = Math.max(y.width, y.height) || y.length / 1000;
    return lx - ly;
  });

  // 候选优先级：full 从大到小；thumb 优先长边 ≥900 的最小一张（解码快），失败再退而求其次
  let order;
  if (kind === 'full') {
    order = sorted.slice().reverse();
  } else {
    const idx = sorted.findIndex((p) => Math.max(p.width, p.height) >= 900);
    order = idx >= 0 ? [...sorted.slice(idx), ...sorted.slice(0, idx).reverse()] : sorted.slice().reverse();
  }

  let fh = null;
  try {
    for (const chosen of order) {
      let data = null;
      if (fresh && chosen.offset >= 0 && chosen.offset + chosen.length <= fresh.length) {
        data = Buffer.from(fresh.subarray(chosen.offset, chosen.offset + chosen.length));
      } else {
        const len = Math.min(chosen.length, Math.max(0, st.size - chosen.offset));
        if (len < 128) continue;
        if (!fh) fh = await fsp.open(filePath, 'r');
        data = Buffer.alloc(len);
        await fh.read(data, 0, len, chosen.offset);
      }
      // 必须是完整 JPEG，否则换下一个候选
      if (!data || data[0] !== 0xff || data[1] !== 0xd8) continue;

      let { width, height } = chosen;
      if (!width || !height) {
        const sz = jpegSize(data);
        if (sz) {
          width = sz.width;
          height = sz.height;
        }
      }

      // 内嵌预览一般不带 EXIF（解码器不会转）→ 渲染层按 RAW 主 IFD 的方向自己转；
      // 少数机型的预览自带方向标签（解码器会转）→ 渲染层就不要再转了
      const self = selfOrientation(data);
      const trueO = a.exif.orientation || 1;
      const decoderRotates = self !== 1;

      return {
        ok: true,
        data,
        mime: 'image/jpeg',
        orientation: decoderRotates ? 1 : trueO, // 渲染层还需要补的旋转
        exifOrientation: trueO,
        storeW: width || 0, // 文件里实际存的尺寸（worker 缩放要用）
        storeH: height || 0,
        width: decoderRotates && swaps(self) ? height || 0 : width || 0, // 解码后的尺寸
        height: decoderRotates && swaps(self) ? width || 0 : height || 0,
        exif: a.exif,
        fileSize: st.size,
        previewCount: a.previews.length,
      };
    }
  } finally {
    if (fh) await fh.close();
  }

  return { ok: false, error: '内嵌预览图读取失败（数据校验不通过）', exif: a.exif, fileSize: st.size };
}

async function readExif(filePath) {
  try {
    const st = await fsp.stat(filePath);
    if (isPlain(filePath)) {
      const fh = await fsp.open(filePath, 'r');
      try {
        const len = Math.min(st.size, 512 * 1024);
        const head = Buffer.alloc(len);
        await fh.read(head, 0, len, 0);
        const r = exifFromJpeg(head);
        const exif = r ? toExif(r.tags) : {};
        if (!exif.pixelX) {
          const sz = jpegSize(head);
          if (sz) {
            exif.pixelX = sz.width;
            exif.pixelY = sz.height;
          }
        }
        return { ok: true, exif, fileSize: st.size };
      } finally {
        await fh.close();
      }
    }
    const cached = analyzeCache.get(filePath);
    if (cached && cached.mtime === st.mtimeMs) return { ok: true, exif: cached.exif, fileSize: st.size };
    const r = await analyzeRaw(filePath);
    putAnalyze(filePath, { mtime: st.mtimeMs, previews: r.previews, exif: r.exif });
    return { ok: true, exif: r.exif, fileSize: st.size };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { getPreview, readExif, isRaw, isPlain, isSupported, RAW_EXT, PLAIN_EXT };
