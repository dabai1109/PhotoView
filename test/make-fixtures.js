/**
 * 生成测试素材：test-photos/
 *  - 若干真实 JPEG（取自系统壁纸）
 *  - 若干合成 NEF：TIFF 结构与真实尼康 NEF 一致，内嵌的预览是一张真实可解码的 JPEG，
 *    带完整 EXIF 和不同的 Orientation，用来端到端验证 RAW 通路与旋转
 *  - 一组 NEF + JPG 同名配对文件
 * 用法：node test/make-fixtures.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'test-photos');
const SRC_DIRS = ['C:/Windows/Web/Wallpaper'];

function findJpegs(dir, out = []) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findJpegs(p, out);
    else if (/\.jpe?g$/i.test(e.name)) out.push(p);
  }
  return out;
}

/* ---- TIFF 构造 ---- */
const TSZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
const eSize = (e) => (e.type === 2 ? e.value.length + 1 : e.type === 5 ? e.value.length * 8 : TSZ[e.type] * (Array.isArray(e.value) ? e.value.length : 1));
const eCount = (e) => (e.type === 2 ? e.value.length + 1 : e.type === 5 ? e.value.length : Array.isArray(e.value) ? e.value.length : 1);

function buildNef(jpeg, opts) {
  const { model, lens, orientation, iso, shutter, fnum, focal, date, w, h } = opts;
  const ifd0 = [
    { tag: 0x00fe, type: 4, value: 1 },
    { tag: 0x0100, type: 3, value: 160 },
    { tag: 0x0101, type: 3, value: 120 },
    { tag: 0x010f, type: 2, value: 'NIKON CORPORATION' },
    { tag: 0x0110, type: 2, value: model },
    { tag: 0x0112, type: 3, value: orientation },
    { tag: 0x014a, type: 4, value: [0, 0] },
    { tag: 0x8769, type: 4, value: 0 },
  ];
  const ifdRaw = [
    { tag: 0x00fe, type: 4, value: 0 },
    { tag: 0x0100, type: 4, value: w },
    { tag: 0x0101, type: 4, value: h },
    { tag: 0x0103, type: 3, value: 34713 },
  ];
  const ifdPrev = [
    { tag: 0x00fe, type: 4, value: 1 },
    { tag: 0x0100, type: 4, value: 0 },
    { tag: 0x0101, type: 4, value: 0 },
    { tag: 0x0103, type: 3, value: 6 },
    { tag: 0x0201, type: 4, value: 0 },
    { tag: 0x0202, type: 4, value: jpeg.length },
  ];
  const ifdExif = [
    { tag: 0x829a, type: 5, value: [shutter] },
    { tag: 0x829d, type: 5, value: [fnum] },
    { tag: 0x8827, type: 3, value: iso },
    { tag: 0x9003, type: 2, value: date },
    { tag: 0x920a, type: 5, value: [focal] },
    { tag: 0xa002, type: 4, value: w },
    { tag: 0xa003, type: 4, value: h },
    { tag: 0xa434, type: 2, value: lens },
  ];

  // 从 JPEG 里读出真实尺寸填进预览 IFD
  const sz = (() => {
    let p = 2;
    while (p + 4 < jpeg.length) {
      if (jpeg[p] !== 0xff) { p++; continue; }
      const m = jpeg[p + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      if (m === 0xd9 || m === 0xda) break;
      const len = jpeg.readUInt16BE(p + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { h: jpeg.readUInt16BE(p + 5), w: jpeg.readUInt16BE(p + 7) };
      p += 2 + len;
    }
    return { w: 0, h: 0 };
  })();
  ifdPrev[1].value = sz.w;
  ifdPrev[2].value = sz.h;

  const ifdSize = (i) => 2 + 12 * i.length + 4;
  const off0 = 8;
  const offRaw = off0 + ifdSize(ifd0);
  const offPrev = offRaw + ifdSize(ifdRaw);
  const offExif = offPrev + ifdSize(ifdPrev);
  const valueBase = offExif + ifdSize(ifdExif);
  let vsize = 0;
  for (const e of [...ifd0, ...ifdRaw, ...ifdPrev, ...ifdExif]) {
    const s = eSize(e);
    if (s > 4) vsize += s + (s % 2);
  }
  const jpegOff = valueBase + vsize;
  ifd0[6].value = [offRaw, offPrev];
  ifd0[7].value = offExif;
  ifdPrev[4].value = jpegOff;

  const buf = Buffer.alloc(jpegOff + jpeg.length);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(off0, 4);

  let vp = valueBase;
  const writeIFD = (ifd, at) => {
    buf.writeUInt16LE(ifd.length, at);
    let p = at + 2;
    for (const e of ifd) {
      buf.writeUInt16LE(e.tag, p);
      buf.writeUInt16LE(e.type, p + 2);
      buf.writeUInt32LE(eCount(e), p + 4);
      const s = eSize(e);
      const target = s > 4 ? vp : p + 8;
      if (s > 4) { buf.writeUInt32LE(vp, p + 8); vp += s + (s % 2); }
      if (e.type === 2) { buf.write(e.value, target, 'latin1'); buf[target + e.value.length] = 0; }
      else if (e.type === 5) e.value.forEach(([n, d], i) => { buf.writeUInt32LE(n, target + i * 8); buf.writeUInt32LE(d, target + i * 8 + 4); });
      else if (e.type === 3) (Array.isArray(e.value) ? e.value : [e.value]).forEach((v, i) => buf.writeUInt16LE(v, target + i * 2));
      else (Array.isArray(e.value) ? e.value : [e.value]).forEach((v, i) => buf.writeUInt32LE(v, target + i * 4));
      p += 12;
    }
    buf.writeUInt32LE(0, p);
  };
  writeIFD(ifd0, off0);
  writeIFD(ifdRaw, offRaw);
  writeIFD(ifdPrev, offPrev);
  writeIFD(ifdExif, offExif);
  jpeg.copy(buf, jpegOff);
  return buf;
}

/** 给一张 JPEG 注入 APP1(Exif) 段，只写 Orientation —— 相机竖拍出片就是这样：
 *  像素本身是横的，靠 Orientation 标签告诉软件要转 90°。用来验证不会被转两次。 */
function injectOrientation(jpeg, orientation) {
  const entries = [
    { tag: 0x0112, type: 3, value: orientation },
    { tag: 0x010f, type: 2, value: 'NIKON CORPORATION' },
    { tag: 0x0110, type: 2, value: 'NIKON Z 8' },
  ];
  const ifdSize = 2 + 12 * entries.length + 4;
  let vsize = 0;
  for (const e of entries) {
    const s = eSize(e);
    if (s > 4) vsize += s + (s % 2);
  }
  const tiff = Buffer.alloc(8 + ifdSize + vsize);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(entries.length, 8);
  let p = 10;
  let vp = 8 + ifdSize;
  for (const e of entries) {
    tiff.writeUInt16LE(e.tag, p);
    tiff.writeUInt16LE(e.type, p + 2);
    tiff.writeUInt32LE(eCount(e), p + 4);
    const s = eSize(e);
    const target = s > 4 ? vp : p + 8;
    if (s > 4) {
      tiff.writeUInt32LE(vp, p + 8);
      vp += s + (s % 2);
    }
    if (e.type === 2) {
      tiff.write(e.value, target, 'latin1');
      tiff[target + e.value.length] = 0;
    } else tiff.writeUInt16LE(e.value, target);
    p += 12;
  }
  tiff.writeUInt32LE(0, p);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

const pool = [];
for (const d of SRC_DIRS) findJpegs(d, pool);
if (!pool.length) {
  console.error('没找到可用的样张，请手动放几张 JPEG 到 test-photos/');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const bodies = ['NIKON Z 8', 'NIKON D850', 'NIKON Z 6III'];
const lenses = ['NIKKOR Z 24-70mm f/2.8 S', 'NIKKOR Z 85mm f/1.2 S', 'AF-S NIKKOR 70-200mm f/2.8E'];
const orients = [1, 1, 6, 1, 8, 1, 1, 3];

let n = 0;
for (let i = 0; i < 18; i++) {
  const srcPath = pool[i % pool.length];
  const jpeg = fs.readFileSync(srcPath);
  const seq = String(i + 1).padStart(4, '0');

  if (i % 3 === 0) {
    // 真实 JPEG 直出
    fs.writeFileSync(path.join(OUT, `DSC_${seq}.JPG`), jpeg);
  } else {
    const nef = buildNef(jpeg, {
      model: bodies[i % bodies.length],
      lens: lenses[i % lenses.length],
      orientation: orients[i % orients.length],
      iso: [64, 100, 400, 1600, 6400][i % 5],
      shutter: [[1, 200], [1, 60], [1, 1000], [1, 8]][i % 4],
      fnum: [[18, 10], [28, 10], [40, 10], [12, 10]][i % 4],
      focal: [[24, 1], [85, 1], [200, 1], [35, 1]][i % 4],
      date: `2026:08:${String(10 + (i % 6)).padStart(2, '0')} 1${i % 9}:2${i % 6}:00`,
      w: 8256,
      h: 5504,
    });
    fs.writeFileSync(path.join(OUT, `DSC_${seq}.NEF`), nef);
    // 每隔几张配一个同名 JPG，测试 RAW+JPG 合并
    if (i % 5 === 2) fs.writeFileSync(path.join(OUT, `DSC_${seq}.JPG`), jpeg);
  }
  n++;
}

// 子文件夹，测试递归扫描
fs.mkdirSync(path.join(OUT, '第二机位'), { recursive: true });
for (let i = 0; i < 4; i++) {
  const jpeg = fs.readFileSync(pool[(i + 3) % pool.length]);
  fs.writeFileSync(
    path.join(OUT, '第二机位', `B_${i + 1}.NEF`),
    buildNef(jpeg, {
      model: 'NIKON Z f', lens: 'NIKKOR Z 40mm f/2', orientation: i === 1 ? 6 : 1,
      iso: 800, shutter: [1, 125], fnum: [20, 10], focal: [40, 1],
      date: '2026:08:16 15:30:00', w: 6048, h: 4032,
    })
  );
}

// 竖拍出片：像素是横的，靠 EXIF Orientation 标记旋转。浏览器会自动转一次，
// 我们的代码也会转一次，如果不禁用浏览器的自动转向就会转成横的（曾经的 bug）
for (const [i, o] of [[1, 6], [2, 8], [3, 3]]) {
  const jpeg = fs.readFileSync(pool[i % pool.length]);
  fs.writeFileSync(path.join(OUT, `ZS_${i}_竖拍o${o}.JPG`), injectOrientation(jpeg, o));
}

const files = fs.readdirSync(OUT);
console.log(`已生成 ${OUT}`);
console.log(`  ${files.filter((f) => /\.NEF$/i.test(f)).length} 个 NEF、${files.filter((f) => /\.JPG$/i.test(f)).length} 个 JPG，外加子文件夹「第二机位」4 个 NEF`);
