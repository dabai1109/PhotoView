/**
 * 解码 worker：把主进程给的 JPEG 字节解码 → 按 EXIF 方向摆正 → 缩放 → 重新编码成缩略图
 * 放在 worker 里跑，滚动网格时不卡主线程。
 */

function orient(ctx, o, dw, dh) {
  switch (o) {
    case 2: ctx.translate(dw, 0); ctx.scale(-1, 1); break;
    case 3: ctx.translate(dw, dh); ctx.rotate(Math.PI); break;
    case 4: ctx.translate(0, dh); ctx.scale(1, -1); break;
    case 5: ctx.rotate(0.5 * Math.PI); ctx.scale(1, -1); break;
    case 6: ctx.rotate(0.5 * Math.PI); ctx.translate(0, -dh); break;
    case 7: ctx.rotate(0.5 * Math.PI); ctx.translate(dw, -dh); ctx.scale(-1, 1); break;
    case 8: ctx.rotate(-0.5 * Math.PI); ctx.translate(-dw, 0); break;
  }
}

const swapped = (o) => o >= 5 && o <= 8;

async function makeThumb({ buf, box, orientation, srcW, srcH }) {
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const o = orientation || 1;

  let bmp;
  if (srcW > 0 && srcH > 0) {
    const long = Math.max(srcW, srcH);
    const s = Math.min(1, box / long);
    bmp = await createImageBitmap(blob, {
      imageOrientation: 'none',
      resizeWidth: Math.max(1, Math.round(srcW * s)),
      resizeHeight: Math.max(1, Math.round(srcH * s)),
      resizeQuality: 'high',
    });
  } else {
    bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
    const long = Math.max(bmp.width, bmp.height);
    if (long > box) {
      const s = box / long;
      const nb = await createImageBitmap(bmp, {
        resizeWidth: Math.max(1, Math.round(bmp.width * s)),
        resizeHeight: Math.max(1, Math.round(bmp.height * s)),
        resizeQuality: 'high',
      });
      bmp.close();
      bmp = nb;
    }
  }

  const dw = bmp.width;
  const dh = bmp.height;
  const cw = swapped(o) ? dh : dw;
  const ch = swapped(o) ? dw : dh;
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  orient(ctx, o, dw, dh);
  ctx.drawImage(bmp, 0, 0, dw, dh);
  bmp.close();

  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  const ab = await out.arrayBuffer();
  return { ab, w: cw, h: ch };
}

async function makeHistogram({ buf }) {
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const bmp = await createImageBitmap(blob, { imageOrientation: 'none', resizeWidth: 240, resizeQuality: 'pixelated' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    l[(0.2126 * R + 0.7152 * G + 0.0722 * B) | 0]++;
  }
  return { hist: { r: Array.from(r), g: Array.from(g), b: Array.from(b), l: Array.from(l) } };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'thumb') {
      const { ab, w, h } = await makeThumb(msg);
      self.postMessage({ id: msg.id, ok: true, ab, w, h }, [ab]);
    } else if (msg.type === 'hist') {
      const { hist } = await makeHistogram(msg);
      self.postMessage({ id: msg.id, ok: true, hist });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
