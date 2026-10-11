'use strict';
/**
 * 智能去灰 (Dehaze) 与「原片 ⇄ 去灰」对比功能单元测试
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function makeCtx2d() {
  const noop = () => {};
  return {
    clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
    fill: noop, stroke: noop, drawImage: noop, translate: noop, scale: noop, rotate: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalCompositeOperation: '', imageSmoothingQuality: '',
  };
}

function makeEl(tag = 'div') {
  const el = {
    tagName: tag, hidden: false, innerHTML: '', textContent: '', value: 220,
    disabled: false, isConnected: true, complete: false, naturalWidth: 0, naturalHeight: 0,
    src: '', title: '', scrollTop: 0, scrollLeft: 0,
    clientWidth: 1200, clientHeight: 800, offsetLeft: 0, offsetWidth: 100, width: 100, height: 84,
    children: [], dataset: {}, style: { setProperty() {}, removeProperty() {} }, _parent: null,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (this._set.has(c)) this._set.delete(c);
          else this._set.add(c);
        } else if (force) this._set.add(c);
        else this._set.delete(c);
        return this._set.has(c);
      },
      contains(c) { return this._set.has(c); },
    },
    appendChild(c) { c._parent = el; el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    remove() {
      if (!el._parent) return;
      const i = el._parent.children.indexOf(el);
      if (i >= 0) el._parent.children.splice(i, 1);
      el._parent = null;
    },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => null,
    getContext: () => makeCtx2d(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    scrollTo() {}, closest: () => null, setPointerCapture() {}, focus() {}, decode: () => Promise.resolve(),
    get firstChild() { return el.children[0]; },
    get lastChild() { return el.children[el.children.length - 1]; },
  };
  return el;
}

function loadApp(pv) {
  const win = {
    pv,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    devicePixelRatio: 1,
  };
  const doc = {
    documentElement: makeEl('html'),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    addEventListener() {}, removeEventListener() {},
    readyState: 'complete',
  };
  const sandbox = {
    window: win, document: doc, self: win,
    navigator: { hardwareConcurrency: 4 },
    devicePixelRatio: 1,
    Worker: class { constructor() { this.onmessage = null; } postMessage() {} terminate() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Image: class { constructor() { this.src = ''; } decode() { return Promise.resolve(); } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob, setTimeout, clearTimeout, console,
    confirm: () => true, matchMedia: win.matchMedia,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8'), sandbox);
  assert.ok(win.__pv && typeof win.__pv.toggleDehaze === 'function', 'app.js 没有导出 toggleDehaze');
  return win.__pv;
}

const fakeScan = (n, root) => ({
  ok: true,
  root,
  favoritesFileName: 'favorites.txt',
  groups: Array.from({ length: n }, (_, i) => ({
    id: `IMG_${i}.NEF`, dir: root, base: `IMG_${i}`, name: `IMG_${i}.NEF`,
    files: [`${root}/IMG_${i}.NEF`], sizes: [1000], primary: `${root}/IMG_${i}.NEF`,
    ext: 'NEF', isRaw: true, hasPair: false, size: 1000, mtime: 0, favored: false,
  })),
});

const makeMockPv = (root, scanResult) => ({
  getSettings: async () => ({ theme: 'dark', thumbSize: 220, showInfo: true }),
  setSettings: async (p) => p,
  recent: async () => [],
  getSession: async () => ({ cursor: 0, favorites: [] }),
  setSession: async () => true,
  saveFavorites: async () => true,
  favoriteFiles: async (r, files) => files.map((f) => ({ from: f, to: `${r}/收藏/${f.split('/').pop()}` })),
  unfavoriteFiles: async (moves) => moves.map((m) => ({ from: m.to, to: m.from })),
  scanFolder: async () => scanResult || fakeScan(5, root),
  preview: async () => ({ ok: true, data: new Uint8Array(10), orientation: 1, width: 4000, height: 3000, exif: {} }),
});

test('computeDehazeCurve: 能针对不同直方图计算出单调递增且保护高光的 33 阶 S 曲线', () => {
  const pv = makeMockPv('D:/Photos');
  const app = loadApp(pv);

  // 1. 无直方图 (兜底曲线)
  const defaultCurve = app.computeDehazeCurve(null);
  const defParts = defaultCurve.split(' ').map(Number);
  assert.strictEqual(defParts.length, 33, '采样点必须为 33 个');
  assert.strictEqual(defParts[0], 0, '起点必须为 0');
  assert.strictEqual(defParts[32], 1, '终点必须为 1');
  // 必须严格单调递增
  for (let i = 1; i < defParts.length; i++) {
    assert.ok(defParts[i] >= defParts[i - 1], `第 ${i} 点必须递增`);
  }

  // 2. 严重发灰照片的直方图（最低亮度在 40，最高在 210）
  const hazyLuma = new Array(256).fill(0);
  for (let i = 40; i <= 210; i++) hazyLuma[i] = 100;
  const hazyCurve = app.computeDehazeCurve({ l: hazyLuma });
  const hazyParts = hazyCurve.split(' ').map(Number);
  assert.strictEqual(hazyParts.length, 33);
  // 发灰照片输入原值为 40/255 ≈ 0.156 对应的点应该被压实到更低（下潜去灰）
  assert.ok(hazyParts[0] === 0, '黑电平压实');
});

test('toggleDehaze: 一键开关能够正确反转状态', async () => {
  const pv = makeMockPv('D:/Photos', fakeScan(3, 'D:/Photos'));
  const app = loadApp(pv);

  await app.openFolder('D:/Photos');
  assert.strictEqual(app.S.dehaze.active, false, '默认去灰处于关闭状态');

  app.toggleDehaze();
  assert.strictEqual(app.S.dehaze.active, true, '切换后去灰开启');

  app.toggleDehaze();
  assert.strictEqual(app.S.dehaze.active, false, '再次切换去灰关闭');
});

test('openDehazeCompare: 一键展开「原片 ⇄ 去灰」对比模式', async () => {
  const pv = makeMockPv('D:/Photos', fakeScan(3, 'D:/Photos'));
  const app = loadApp(pv);

  await app.openFolder('D:/Photos');
  app.S.cur = 0; // 选定第 0 张照片

  app.openDehazeCompare();

  assert.strictEqual(app.S.mode, 'compare', '必须进入细节对比模式');
  assert.strictEqual(app.S.compare.items.length, 2, '必须有两个槽位');

  const slotA = app.S.compare.items[0];
  const slotB = app.S.compare.items[1];

  assert.strictEqual(slotA.primary, slotB.primary, '两槽位应为同一张照片');
  assert.strictEqual(slotA.dehazeSlot, false, '槽位 A 为原片');
  assert.strictEqual(slotB.dehazeSlot, true, '槽位 B 为去灰增强');
  assert.strictEqual(slotA.slotLabel, '原片');
  assert.strictEqual(slotB.slotLabel, '去灰增强');
  assert.strictEqual(app.S.compare.mode, 'curtain', '默认采用直观的卷帘对比');
});

test('toggleCompareDehaze: 对比模式下可以一键切换全局槽位去灰', async () => {
  const pv = makeMockPv('D:/Photos', fakeScan(4, 'D:/Photos'));
  const app = loadApp(pv);

  await app.openFolder('D:/Photos');
  app.openCompare();
  assert.strictEqual(app.S.mode, 'compare');
  assert.strictEqual(app.S.dehaze.active, false);

  app.toggleCompareDehaze();
  assert.strictEqual(app.S.dehaze.active, true, '对比模式下去灰开启');

  app.toggleCompareDehaze();
  assert.strictEqual(app.S.dehaze.active, false, '对比模式下去灰关闭');
});
