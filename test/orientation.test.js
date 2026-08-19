'use strict';
/**
 * EXIF 方向回归测试（node --test，零依赖）。
 *
 * 缩略图和大图各有一套独立的方向数学：
 *   - decode-worker.js 的 orient()      → canvas 变换，把像素真的转过去
 *   - app.js 的 rotDeg() / mirrored()   → CSS transform，只在屏幕上转
 * 两套代码没有共用实现，历史上就出过「一边对一边错」的问题，
 * 所以这里直接读源文件，把 8 个方向逐一对着 EXIF 规范钉死。
 *
 * 用真实源文件而不是复制一份实现 —— 否则测试永远是绿的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const R = (p) => path.join(__dirname, '..', p);

/* ---------- 2D 仿射矩阵：[a,b,c,d,e,f]，x' = a x + c y + e，y' = b x + d y + f ---------- */
const ID = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
// 整数化：方向只涉及 0/±90/180，sin/cos 必须是干净的 0/±1
const rotM = (rad) => {
  const c = Math.round(Math.cos(rad));
  const s = Math.round(Math.sin(rad));
  return [c, s, -s, c, 0, 0];
};
const at = (m, x, y) => [Math.round(m[0] * x + m[2] * y + m[4]), Math.round(m[1] * x + m[3] * y + m[5])];

/**
 * EXIF 规范：存储图 (dw×dh) 的四角，摆正后应落在显示画布的哪一角。
 * 顺序固定为 左上 / 右上 / 右下 / 左下。
 */
const SPEC = {
  1: (x, y, w, h) => [x, y],
  2: (x, y, w, h) => [w - x, y],
  3: (x, y, w, h) => [w - x, h - y],
  4: (x, y, w, h) => [x, h - y],
  5: (x, y, w, h) => [y, x],
  6: (x, y, w, h) => [h - y, x],
  7: (x, y, w, h) => [h - y, w - x],
  8: (x, y, w, h) => [y, w - x],
};
const CORNERS = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const swaps = (o) => o >= 5 && o <= 8;

/* ---------- 从真实源文件里取出被测函数 ---------- */

/** decode-worker.js 是普通脚本：顶层只有函数声明 + self.onmessage 赋值，可以直接在沙箱里跑。 */
function loadWorkerOrient() {
  const ctx = { self: {} };
  vm.runInNewContext(fs.readFileSync(R('src/renderer/decode-worker.js'), 'utf8'), ctx);
  assert.strictEqual(typeof ctx.orient, 'function', 'decode-worker.js 里没找到 orient()，测试提取逻辑需同步更新');
  return ctx.orient;
}

/**
 * app.js 顶层会直接摸 DOM，整份跑不了；只把三个纯函数的声明抠出来。
 * 抠不到就直接失败 —— 绝不能悄悄跳过变成假绿。
 */
function loadAppHelpers() {
  const src = fs.readFileSync(R('src/renderer/app.js'), 'utf8');
  const ctx = {};
  for (const name of ['swapped', 'mirrored', 'rotDeg']) {
    const m = src.match(new RegExp(`^const ${name} = .*;$`, 'm'));
    assert.ok(m, `app.js 里没找到 ${name} 的单行声明，测试提取逻辑需同步更新`);
    vm.runInNewContext(m[0].replace(/^const\b/, 'var'), ctx);
    assert.strictEqual(typeof ctx[name], 'function', `${name} 没能取出来`);
  }
  return ctx;
}

/* ---------- 缩略图：canvas 变换 ---------- */

test('decode-worker orient() 把四角摆到 EXIF 规范要求的位置', () => {
  const orient = loadWorkerOrient();
  const dw = 100, dh = 60;

  for (let o = 1; o <= 8; o++) {
    // 复刻 makeThumb 里的画布尺寸决定方式
    const cw = swaps(o) ? dh : dw;
    const ch = swaps(o) ? dw : dh;

    let m = ID.slice();
    const fake = {
      translate: (x, y) => { m = mul(m, [1, 0, 0, 1, x, y]); },
      scale: (x, y) => { m = mul(m, [x, 0, 0, y, 0, 0]); },
      rotate: (r) => { m = mul(m, rotM(r)); },
    };
    orient(fake, o, dw, dh);

    const got = CORNERS(dw, dh).map(([x, y]) => at(m, x, y));
    const want = CORNERS(dw, dh).map(([x, y]) => SPEC[o](x, y, dw, dh).map(Math.round));
    assert.deepStrictEqual(got, want, `方向 ${o} 的 canvas 变换不对`);

    // 画到画布外 = 缩略图整张空白，而且还会被 put_thumb 写进磁盘缓存
    for (const [x, y] of got) {
      assert.ok(x >= 0 && y >= 0 && x <= cw && y <= ch, `方向 ${o} 有角点 (${x},${y}) 落在 ${cw}x${ch} 画布之外`);
    }
  }
});

/* ---------- 大图：CSS transform ---------- */

test('app.js rotDeg()/mirrored() 组出的 CSS transform 符合 EXIF 规范', () => {
  const { mirrored, rotDeg } = loadAppHelpers();
  const dw = 100, dh = 60;

  for (let o = 1; o <= 8; o++) {
    // applyTransform: `... scale(zoom) rotate(Ndeg)` 后面按需再接 ` scaleX(-1)`。
    // CSS transform-origin 默认在元素中心，所以用「以中心为原点」的坐标比较。
    let m = rotM((rotDeg(o) * Math.PI) / 180);
    if (mirrored(o)) m = mul(m, [-1, 0, 0, 1, 0, 0]);

    // 中心坐标下比较：把规范映射也搬到中心原点
    const cw = swaps(o) ? dh : dw;
    const ch = swaps(o) ? dw : dh;
    const got = CORNERS(dw, dh).map(([x, y]) => at(m, x - dw / 2, y - dh / 2));
    const want = CORNERS(dw, dh).map(([x, y]) => {
      const [sx, sy] = SPEC[o](x, y, dw, dh);
      return [Math.round(sx - cw / 2), Math.round(sy - ch / 2)];
    });
    assert.deepStrictEqual(got, want, `方向 ${o} 的 CSS transform 不对（rotDeg=${rotDeg(o)}, mirrored=${mirrored(o)}）`);
  }
});

test('swapped() 只在 5-8 交换宽高，两份实现必须一致', () => {
  const app = loadAppHelpers();
  const workerSrc = fs.readFileSync(R('src/renderer/decode-worker.js'), 'utf8');
  assert.match(workerSrc, /const swapped = \(o\) => o >= 5 && o <= 8;/, 'decode-worker.js 的 swapped 定义变了');
  for (let o = 1; o <= 8; o++) assert.strictEqual(app.swapped(o), o >= 5 && o <= 8, `swapped(${o}) 不对`);
});
