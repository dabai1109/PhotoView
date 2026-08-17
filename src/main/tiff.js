'use strict';
/**
 * 轻量 TIFF / EXIF 解析器。
 * 用途：从 TIFF 结构的 RAW（尼康 NEF/NRW、佳能 CR2、索尼 ARW、DNG、宾得 PEF…）
 * 中定位内嵌的 JPEG 预览图，并读取 EXIF 拍摄参数。
 * 只做只读解析，不依赖任何原生模块。
 */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

// 常用 tag
const T = {
  IMAGE_WIDTH: 0x0100,
  IMAGE_LENGTH: 0x0101,
  BITS_PER_SAMPLE: 0x0102,
  COMPRESSION: 0x0103,
  MAKE: 0x010f,
  MODEL: 0x0110,
  STRIP_OFFSETS: 0x0111,
  ORIENTATION: 0x0112,
  STRIP_BYTE_COUNTS: 0x0117,
  SUB_IFDS: 0x014a,
  JPEG_OFFSET: 0x0201,
  JPEG_LENGTH: 0x0202,
  EXIF_IFD: 0x8769,
  MAKERNOTE: 0x927c,
  NEW_SUBFILE_TYPE: 0x00fe,
  EXPOSURE_TIME: 0x829a,
  F_NUMBER: 0x829d,
  ISO: 0x8827,
  ISO_SPEED: 0x8833,
  DATE_ORIGINAL: 0x9003,
  SHUTTER_SPEED: 0x9201,
  APERTURE: 0x9202,
  EXPOSURE_BIAS: 0x9204,
  METERING: 0x9207,
  FOCAL_LENGTH: 0x920a,
  EXIF_PIXEL_X: 0xa002,
  EXIF_PIXEL_Y: 0xa003,
  LENS_MODEL: 0xa434,
  LENS_MAKE: 0xa433,
  BODY_SERIAL: 0xa431,
  FOCAL_35: 0xa405,
  EXPOSURE_PROGRAM: 0x8822,
  WHITE_BALANCE: 0xa403,
};

function rdU16(buf, o, le) {
  return le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
}
function rdU32(buf, o, le) {
  return le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
}
function rdI32(buf, o, le) {
  return le ? buf.readInt32LE(o) : buf.readInt32BE(o);
}

/** 解析 TIFF 头，base 为该 TIFF 结构在 buffer 中的起始偏移 */
function parseHeader(buf, base) {
  if (base + 8 > buf.length) return null;
  const b0 = buf[base];
  const b1 = buf[base + 1];
  let le;
  if (b0 === 0x49 && b1 === 0x49) le = true;
  else if (b0 === 0x4d && b1 === 0x4d) le = false;
  else return null;
  const magic = rdU16(buf, base + 2, le);
  if (magic !== 42) return null;
  const first = rdU32(buf, base + 4, le);
  if (!first) return null;
  return { le, base, firstIFD: base + first };
}

/** 读取一个 IFD，返回 { entries: Map<tag, entry>, next } */
function readIFD(buf, offset, le, base) {
  if (offset < 0 || offset + 2 > buf.length) return null;
  const count = rdU16(buf, offset, le);
  if (count === 0 || count > 2048) return null;
  const end = offset + 2 + count * 12 + 4;
  if (end > buf.length) return null;
  const entries = new Map();
  let p = offset + 2;
  for (let i = 0; i < count; i++, p += 12) {
    const tag = rdU16(buf, p, le);
    const type = rdU16(buf, p + 2, le);
    const n = rdU32(buf, p + 4, le);
    const ts = TYPE_SIZE[type] || 0;
    if (!ts) continue;
    const byteLen = ts * n;
    let valOff = p + 8;
    if (byteLen > 4) valOff = base + rdU32(buf, p + 8, le);
    entries.set(tag, { tag, type, count: n, valOff, byteLen });
  }
  const nextRaw = rdU32(buf, p, le);
  return { entries, next: nextRaw ? base + nextRaw : 0 };
}

/** 取出条目的值 */
function value(buf, e, le) {
  if (!e) return undefined;
  const { type, count, valOff, byteLen } = e;
  if (valOff < 0 || valOff + byteLen > buf.length) return undefined;
  const one = (i) => {
    switch (type) {
      case 1:
      case 6:
      case 7:
        return buf[valOff + i];
      case 3:
        return rdU16(buf, valOff + i * 2, le);
      case 8:
        return le ? buf.readInt16LE(valOff + i * 2) : buf.readInt16BE(valOff + i * 2);
      case 4:
        return rdU32(buf, valOff + i * 4, le);
      case 9:
        return rdI32(buf, valOff + i * 4, le);
      case 5: {
        const a = rdU32(buf, valOff + i * 8, le);
        const b = rdU32(buf, valOff + i * 8 + 4, le);
        return b ? a / b : 0;
      }
      case 10: {
        const a = rdI32(buf, valOff + i * 8, le);
        const b = rdI32(buf, valOff + i * 8 + 4, le);
        return b ? a / b : 0;
      }
      case 11:
        return le ? buf.readFloatLE(valOff + i * 4) : buf.readFloatBE(valOff + i * 4);
      case 12:
        return le ? buf.readDoubleLE(valOff + i * 8) : buf.readDoubleBE(valOff + i * 8);
      default:
        return undefined;
    }
  };
  if (type === 2) {
    let s = buf.toString('latin1', valOff, valOff + byteLen);
    const z = s.indexOf('\0');
    if (z >= 0) s = s.slice(0, z);
    return s.trim();
  }
  if (count === 1) return one(0);
  const out = [];
  for (let i = 0; i < count && i < 512; i++) out.push(one(i));
  return out;
}

const num = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * 遍历整个 TIFF，收集：
 *  - previews: 内嵌 JPEG 预览候选 [{offset,length,width,height,src}]
 *  - tags: 合并后的 tag → 值（IFD0 + ExifIFD 优先）
 *  - truncated: 是否因为 buffer 不完整而没走完
 */
function walkTiff(buf, base = 0) {
  const hdr = parseHeader(buf, base);
  if (!hdr) return null;
  const { le } = hdr;
  const previews = [];
  const tags = new Map();
  const seen = new Set();
  let truncated = false;

  const collect = (ifd, isRoot) => {
    // 预览图候选：JPEGInterchangeFormat 或 单条带 JPEG 压缩
    let off, len;
    const jo = ifd.entries.get(T.JPEG_OFFSET);
    const jl = ifd.entries.get(T.JPEG_LENGTH);
    if (jo && jl) {
      off = num(value(buf, jo, le));
      len = num(value(buf, jl, le));
    } else {
      const comp = num(value(buf, ifd.entries.get(T.COMPRESSION), le));
      const so = ifd.entries.get(T.STRIP_OFFSETS);
      const sc = ifd.entries.get(T.STRIP_BYTE_COUNTS);
      if ((comp === 6 || comp === 7 || comp === 99) && so && sc && so.count === 1) {
        off = num(value(buf, so, le));
        len = num(value(buf, sc, le));
      }
    }
    if (off != null && len != null && len > 2048) {
      previews.push({
        offset: base + off,
        length: len,
        width: num(value(buf, ifd.entries.get(T.IMAGE_WIDTH), le)) || 0,
        height: num(value(buf, ifd.entries.get(T.IMAGE_LENGTH), le)) || 0,
        src: 'ifd',
      });
    }
    // 合并 tag（根 IFD / Exif IFD 的值优先保留第一个出现的）
    for (const [tag, e] of ifd.entries) {
      if (tag === T.MAKERNOTE || tag === T.STRIP_OFFSETS) continue;
      if (isRoot || !tags.has(tag)) {
        const v = value(buf, e, le);
        if (v !== undefined) tags.set(tag, v);
      }
    }
  };

  const walkChain = (start, isRoot, depth) => {
    let off = start;
    let guard = 0;
    while (off && guard++ < 32) {
      if (seen.has(off)) break;
      seen.add(off);
      if (off + 2 > buf.length) {
        truncated = true;
        break;
      }
      const ifd = readIFD(buf, off, le, base);
      if (!ifd) {
        truncated = true;
        break;
      }
      collect(ifd, isRoot && guard === 1);

      if (depth < 4) {
        const sub = ifd.entries.get(T.SUB_IFDS);
        if (sub) {
          const v = value(buf, sub, le);
          const list = Array.isArray(v) ? v : v != null ? [v] : [];
          for (const s of list) walkChain(base + s, false, depth + 1);
        }
        const ex = ifd.entries.get(T.EXIF_IFD);
        if (ex) {
          const v = num(value(buf, ex, le));
          if (v) walkChain(base + v, false, depth + 1);
        }
        const mn = ifd.entries.get(T.MAKERNOTE);
        if (mn) parseNikonMakerNote(buf, mn, previews, tags);
      }
      off = ifd.next;
      isRoot = false;
    }
  };

  walkChain(hdr.firstIFD, true, 0);
  return { previews, tags, le, truncated };
}

/**
 * 尼康 MakerNote：形如 "Nikon\0" + 版本(2) + 保留(2) + 完整 TIFF 头。
 * 其中 tag 0x0011 指向 PreviewIFD（偏移相对 MakerNote 内部的 TIFF 基址）。
 * 部分机型的大预览图只存在这里。
 */
function parseNikonMakerNote(buf, entry, previews, tags) {
  const start = entry.valOff;
  if (start + 18 > buf.length) return;
  if (buf.toString('latin1', start, start + 6) !== 'Nikon\0') return;
  const mBase = start + 10;
  const hdr = parseHeader(buf, mBase);
  if (!hdr) return;
  const le = hdr.le;
  const root = readIFD(buf, hdr.firstIFD, le, mBase);
  if (!root) return;

  const prevPtr = root.entries.get(0x0011);
  if (prevPtr) {
    const rel = num(value(buf, prevPtr, le));
    if (rel) {
      const pIfd = readIFD(buf, mBase + rel, le, mBase);
      if (pIfd) {
        const o = num(value(buf, pIfd.entries.get(T.JPEG_OFFSET), le));
        const l = num(value(buf, pIfd.entries.get(T.JPEG_LENGTH), le));
        if (o != null && l > 2048) {
          previews.push({
            offset: mBase + o,
            length: l,
            width: num(value(buf, pIfd.entries.get(T.IMAGE_WIDTH), le)) || 0,
            height: num(value(buf, pIfd.entries.get(T.IMAGE_LENGTH), le)) || 0,
            src: 'makernote',
          });
        }
      }
    }
  }
  // 镜头名（尼康 tag 0x0084 为镜头规格，0x0083 为镜头类型）
  const lens = root.entries.get(0x0084);
  if (lens && !tags.has(T.LENS_MODEL)) {
    const v = value(buf, lens, le);
    if (Array.isArray(v) && v.length >= 4) {
      const [f1, f2, a1, a2] = v;
      const fs = f1 === f2 ? `${f1}mm` : `${f1}-${f2}mm`;
      const as = a1 === a2 ? `f/${a1}` : `f/${a1}-${a2}`;
      tags.set('nikonLens', `${fs} ${as}`);
    }
  }
}

/** 从 JPEG 字节流读取尺寸（扫 SOFn 段） */
function jpegSize(buf, start = 0, end = buf.length) {
  if (buf[start] !== 0xff || buf[start + 1] !== 0xd8) return null;
  let p = start + 2;
  while (p + 4 < end) {
    if (buf[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = buf[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(p + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (p + 9 > end) break;
      return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
    }
    p += 2 + len;
  }
  return null;
}

/** 在整个 buffer 里暴力扫描独立 JPEG（CR3 / RAF 等非 TIFF 容器的兜底方案） */
function scanJpegs(buf) {
  const out = [];
  let p = 0;
  const n = buf.length;
  while (p < n - 3) {
    const soi = buf.indexOf('\xff\xd8\xff', p, 'latin1');
    if (soi < 0) break;
    // 找 EOI
    let q = soi + 2;
    let eoi = -1;
    while (q < n - 1) {
      if (buf[q] === 0xff) {
        const m = buf[q + 1];
        if (m === 0xd9) {
          eoi = q + 2;
          break;
        }
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff || m === 0x00) {
          q += 2;
          continue;
        }
        if (m === 0xd8) {
          q += 2;
          continue;
        }
        if (q + 4 > n) break;
        const len = buf.readUInt16BE(q + 2);
        if (len < 2) break;
        if (m === 0xda) {
          // 进入扫描数据，逐字节找 EOI
          q += 2 + len;
          while (q < n - 1) {
            if (buf[q] === 0xff && buf[q + 1] === 0xd9) {
              eoi = q + 2;
              break;
            }
            q++;
          }
          break;
        }
        q += 2 + len;
      } else q++;
    }
    if (eoi > soi) {
      const len = eoi - soi;
      if (len > 4096) {
        const sz = jpegSize(buf, soi, eoi) || { width: 0, height: 0 };
        out.push({ offset: soi, length: len, width: sz.width, height: sz.height, src: 'scan' });
      }
      p = eoi;
    } else {
      p = soi + 2;
    }
    if (out.length > 24) break;
  }
  return out;
}

/** 把原始 tag Map 转成好看的 EXIF 对象 */
function toExif(tags) {
  if (!tags) return {};
  const g = (k) => tags.get(k);
  const shutter = g(T.EXPOSURE_TIME);
  let shutterText;
  if (typeof shutter === 'number' && shutter > 0) {
    shutterText = shutter >= 1 ? `${Math.round(shutter * 10) / 10}s` : `1/${Math.round(1 / shutter)}s`;
  }
  const fn = g(T.F_NUMBER);
  const fl = g(T.FOCAL_LENGTH);
  const iso = g(T.ISO) ?? g(T.ISO_SPEED);
  const bias = g(T.EXPOSURE_BIAS);
  let date = g(T.DATE_ORIGINAL);
  if (typeof date === 'string' && /^\d{4}:\d{2}:\d{2}/.test(date)) {
    date = date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  }
  return {
    make: g(T.MAKE),
    model: g(T.MODEL),
    lens: g(T.LENS_MODEL) || g('nikonLens'),
    shutter: shutterText,
    aperture: typeof fn === 'number' && fn > 0 ? `f/${Math.round(fn * 10) / 10}` : undefined,
    iso: typeof iso === 'number' ? `ISO ${Math.round(Array.isArray(iso) ? iso[0] : iso)}` : undefined,
    focal: typeof fl === 'number' ? `${Math.round(fl)}mm` : undefined,
    focal35: typeof g(T.FOCAL_35) === 'number' ? `${Math.round(g(T.FOCAL_35))}mm` : undefined,
    ev: typeof bias === 'number' && bias !== 0 ? `${bias > 0 ? '+' : ''}${Math.round(bias * 10) / 10} EV` : undefined,
    date,
    orientation: num(g(T.ORIENTATION)) || 1,
    pixelX: num(g(T.EXIF_PIXEL_X)) || num(g(T.IMAGE_WIDTH)),
    pixelY: num(g(T.EXIF_PIXEL_Y)) || num(g(T.IMAGE_LENGTH)),
  };
}

/** 从 JPEG 文件头里找 APP1(Exif) 段并解析 */
function exifFromJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  const n = Math.min(buf.length, 1024 * 1024);
  while (p + 4 < n) {
    if (buf[p] !== 0xff) {
      p++;
      continue;
    }
    const m = buf[p + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      p += 2;
      continue;
    }
    if (m === 0xda || m === 0xd9) break;
    const len = buf.readUInt16BE(p + 2);
    if (m === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      return walkTiff(buf, p + 10);
    }
    p += 2 + len;
  }
  return null;
}

module.exports = { walkTiff, scanJpegs, jpegSize, toExif, exifFromJpeg, T };
