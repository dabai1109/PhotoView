/**
 * 解析器自测：不依赖 Electron，直接 `node test/parser.test.js`
 * 构造一个结构与真实 NEF 一致的 TIFF 文件（IFD0 + SubIFD(raw) + SubIFD(预览) + Exif IFD），
 * 验证内嵌 JPEG 预览能被准确定位、EXIF 能被正确解析。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { getPreview } = require('../src/main/preview');

/* ---------- 造一张 >2KB 的合法 JPEG（1×1 像素 + 大注释段） ---------- */
function makeJpeg(padBytes, w = 1620, h = 1080) {
  const soi = Buffer.from([0xff, 0xd8]);
  // COM 段：ff fe + len + 内容
  const comLen = padBytes + 2;
  const com = Buffer.concat([
    Buffer.from([0xff, 0xfe, comLen >> 8, comLen & 0xff]),
    Buffer.alloc(padBytes, 0x41),
  ]);
  // SOF0：precision 8, height, width, 1 component
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0x7f]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, com, sof, sos, eoi]);
}

/* ---------- TIFF 构造器（小端） ---------- */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

function entrySize(e) {
  if (e.type === 2) return e.value.length + 1;
  if (e.type === 5) return e.value.length * 8;
  return TYPE_SIZE[e.type] * (Array.isArray(e.value) ? e.value.length : 1);
}
function entryCount(e) {
  if (e.type === 2) return e.value.length + 1;
  if (e.type === 5) return e.value.length;
  return Array.isArray(e.value) ? e.value.length : 1;
}

function buildFixture(pad = 0) {
  const jpegBig = makeJpeg(60000, 1620, 1080);
  const jpegSmall = makeJpeg(9000, 320, 213);

  const ifd0 = [
    { tag: 0x0100, type: 3, value: 160 },
    { tag: 0x0101, type: 3, value: 120 },
    { tag: 0x010f, type: 2, value: 'NIKON CORPORATION' },
    { tag: 0x0110, type: 2, value: 'NIKON D850' },
    { tag: 0x0112, type: 3, value: 6 },
    { tag: 0x014a, type: 4, value: [0, 0] }, // 占位，稍后填 SubIFD 偏移
    { tag: 0x8769, type: 4, value: 0 },
  ];
  const ifdRaw = [
    { tag: 0x00fe, type: 4, value: 0 },
    { tag: 0x0100, type: 4, value: 8288 },
    { tag: 0x0101, type: 4, value: 5520 },
    { tag: 0x0103, type: 3, value: 34713 }, // 尼康压缩 RAW，不是预览
  ];
  const ifdPrev = [
    { tag: 0x0100, type: 4, value: 1620 },
    { tag: 0x0101, type: 4, value: 1080 },
    { tag: 0x0103, type: 3, value: 6 },
    { tag: 0x0201, type: 4, value: 0 },
    { tag: 0x0202, type: 4, value: jpegBig.length },
  ];
  const ifdExif = [
    { tag: 0x829a, type: 5, value: [[1, 250]] },
    { tag: 0x829d, type: 5, value: [[28, 10]] },
    { tag: 0x8827, type: 3, value: 400 },
    { tag: 0x9003, type: 2, value: '2026:08:16 10:20:30' },
    { tag: 0x9204, type: 5, value: [[-1, 3]] },
    { tag: 0x920a, type: 5, value: [[85, 1]] },
    { tag: 0xa002, type: 4, value: 8256 },
    { tag: 0xa003, type: 4, value: 5504 },
    { tag: 0xa434, type: 2, value: 'NIKKOR Z 85mm f/1.2 S' },
  ];

  const sizeOf = (ifd) => 2 + 12 * ifd.length + 4;
  const off0 = 8;
  const offRaw = off0 + sizeOf(ifd0);
  const offPrev = offRaw + sizeOf(ifdRaw);
  const offExif = offPrev + sizeOf(ifdPrev);
  const valueBase = offExif + sizeOf(ifdExif);

  // 值区大小
  const all = [...ifd0, ...ifdRaw, ...ifdPrev, ...ifdExif];
  let valueSize = 0;
  for (const e of all) {
    const s = entrySize(e);
    if (s > 4) valueSize += s + (s % 2);
  }
  const jpegSmallOff = valueBase + valueSize;
  const jpegBigOff = jpegSmallOff + jpegSmall.length;
  const total = jpegBigOff + jpegBig.length;

  // 回填偏移
  ifd0[5].value = [offRaw, offPrev];
  ifd0[6].value = offExif;
  ifdPrev[3].value = jpegBigOff;
  // IFD0 自己也带一张小缩略图（很多 NEF 都这样）
  ifd0.push({ tag: 0x0201, type: 4, value: jpegSmallOff });
  ifd0.push({ tag: 0x0202, type: 4, value: jpegSmall.length });

  // 加了两个条目 → 所有偏移都要重算，直接重来一遍
  const off0b = 8;
  const offRawB = off0b + sizeOf(ifd0);
  const offPrevB = offRawB + sizeOf(ifdRaw);
  const offExifB = offPrevB + sizeOf(ifdPrev);
  const valueBaseB = offExifB + sizeOf(ifdExif);
  let valueSizeB = 0;
  for (const e of [...ifd0, ...ifdRaw, ...ifdPrev, ...ifdExif]) {
    const s = entrySize(e);
    if (s > 4) valueSizeB += s + (s % 2);
  }
  const smallOffB = valueBaseB + valueSizeB + pad; // pad 模拟夹在中间的 RAW 数据
  const bigOffB = smallOffB + jpegSmall.length;
  const totalB = bigOffB + jpegBig.length;

  ifd0[5].value = [offRawB, offPrevB];
  ifd0[6].value = offExifB;
  ifd0[7].value = smallOffB;
  ifdPrev[3].value = bigOffB;

  const buf = Buffer.alloc(totalB);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(off0b, 4);

  let vp = valueBaseB;
  const writeIFD = (ifd, at) => {
    buf.writeUInt16LE(ifd.length, at);
    let p = at + 2;
    for (const e of ifd) {
      buf.writeUInt16LE(e.tag, p);
      buf.writeUInt16LE(e.type, p + 2);
      buf.writeUInt32LE(entryCount(e), p + 4);
      const s = entrySize(e);
      const target = s > 4 ? vp : p + 8;
      if (s > 4) {
        buf.writeUInt32LE(vp, p + 8);
        vp += s + (s % 2);
      }
      if (e.type === 2) {
        buf.write(e.value, target, 'latin1');
        buf[target + e.value.length] = 0;
      } else if (e.type === 5) {
        e.value.forEach(([n, d], i) => {
          buf.writeUInt32LE(n < 0 ? n >>> 0 : n, target + i * 8);
          buf.writeUInt32LE(d, target + i * 8 + 4);
        });
      } else if (e.type === 3) {
        const arr = Array.isArray(e.value) ? e.value : [e.value];
        arr.forEach((v, i) => buf.writeUInt16LE(v, target + i * 2));
      } else {
        const arr = Array.isArray(e.value) ? e.value : [e.value];
        arr.forEach((v, i) => buf.writeUInt32LE(v, target + i * 4));
      }
      p += 12;
    }
    buf.writeUInt32LE(0, p);
  };
  writeIFD(ifd0, off0b);
  writeIFD(ifdRaw, offRawB);
  writeIFD(ifdPrev, offPrevB);
  writeIFD(ifdExif, offExifB);

  jpegSmall.copy(buf, smallOffB);
  jpegBig.copy(buf, bigOffB);
  return { buf, jpegBig, jpegSmall };
}

/* ---------- 跑测试 ---------- */
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-test-'));
  const nef = path.join(dir, 'DSC_0001.NEF');
  const { buf, jpegBig, jpegSmall } = buildFixture();
  fs.writeFileSync(nef, buf);

  let pass = 0;
  const check = (name, fn) => {
    try {
      fn();
      console.log('  ✓', name);
      pass++;
    } catch (e) {
      console.log('  ✗', name, '\n     ', e.message);
      process.exitCode = 1;
    }
  };

  console.log('NEF 内嵌预览提取');
  const full = await getPreview(nef, 'full');
  check('取到最大预览图', () => assert.ok(full.ok, full.error));
  check('预览字节与写入的完全一致', () => assert.ok(full.data.equals(jpegBig)));
  check('预览尺寸 1620×1080', () => assert.strictEqual(`${full.width}×${full.height}`, '1620×1080'));
  check('识别出 2 张候选预览', () => assert.strictEqual(full.previewCount, 2));

  const thumb = await getPreview(nef, 'thumb');
  check('缩略图挑到长边≥900 的那张（跳过 320px 的小图）', () => assert.ok(thumb.data.equals(jpegBig)));

  console.log('EXIF 解析');
  const ex = full.exif;
  check('机身 NIKON D850', () => assert.strictEqual(ex.model, 'NIKON D850'));
  check('镜头 NIKKOR Z 85mm f/1.2 S', () => assert.strictEqual(ex.lens, 'NIKKOR Z 85mm f/1.2 S'));
  check('快门 1/250s', () => assert.strictEqual(ex.shutter, '1/250s'));
  check('光圈 f/2.8', () => assert.strictEqual(ex.aperture, 'f/2.8'));
  check('ISO 400', () => assert.strictEqual(ex.iso, 'ISO 400'));
  check('焦距 85mm', () => assert.strictEqual(ex.focal, '85mm'));
  check('方向 6（需要旋转 90°）', () => assert.strictEqual(ex.orientation, 6));
  check('拍摄时间格式化', () => assert.strictEqual(ex.date, '2026-08-16 10:20:30'));
  check('原图尺寸 8256×5504', () => assert.strictEqual(`${ex.pixelX}×${ex.pixelY}`, '8256×5504'));

  console.log('非 TIFF 容器（CR3/RAF 之类）暴力扫描兜底');
  const cr3 = path.join(dir, 'IMG_0002.CR3');
  fs.writeFileSync(cr3, Buffer.concat([Buffer.alloc(2048, 0x11), jpegSmall, Buffer.alloc(500, 0x22), jpegBig]));
  const r3 = await getPreview(cr3, 'full');
  check('扫描到内嵌 JPEG 并取最大的一张', () => assert.ok(r3.ok && r3.data.equals(jpegBig)));

  console.log('普通 JPEG');
  const jpg = path.join(dir, 'x.jpg');
  fs.writeFileSync(jpg, jpegBig);
  const rj = await getPreview(jpg, 'full');
  check('直接返回原文件并读到尺寸', () => assert.ok(rj.ok && rj.width === 1620 && rj.height === 1080));

  console.log('大文件：预览图偏移在 1MB 头部之外（真实 NEF 的常态）');
  const bigNef = path.join(dir, 'DSC_9999.NEF');
  const big = buildFixture(3 * 1024 * 1024); // 中间塞 3MB 模拟 RAW 数据
  fs.writeFileSync(bigNef, big.buf);
  const rb = await getPreview(bigNef, 'full');
  check('仍能按字节范围定点取出预览', () => assert.ok(rb.ok && rb.data.equals(big.jpegBig)));
  check('EXIF 依然完整', () => assert.strictEqual(rb.exif.model, 'NIKON D850'));

  console.log('损坏文件');
  const broken = path.join(dir, 'broken.NEF');
  fs.writeFileSync(broken, Buffer.alloc(60000, 0x00));
  const rk = await getPreview(broken, 'full');
  check('不抛异常，返回可读的错误信息', () => assert.ok(!rk.ok && typeof rk.error === 'string'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} 项通过${process.exitCode ? '，有失败项' : '，全部通过'}`);
})();
