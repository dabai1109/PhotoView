'use strict';
/**
 * 照片细节对比工作台 (Compare Studio) 单元测试
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
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
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
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
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
  assert.ok(win.__pv && typeof win.__pv.openCompare === 'function', 'app.js 没有导出 openCompare');
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
  scanFolder: async () => scanResult || fakeScan(5, root),
  preview: async () => ({ ok: true, data: new Uint8Array(10), orientation: 1, width: 4000, height: 3000, exif: {} }),
});

test('openCompare 从相册自动提取选中及下一张照片进行对比', async () => {
  const pv = makeMockPv('D:/Photos', fakeScan(4, 'D:/Photos'));
  const app = loadApp(pv);

  await app.openFolder('D:/Photos');
  assert.strictEqual(app.S.mode, 'grid');
  assert.strictEqual(app.S.view.length, 4);

  // 默认选中第 0 张，进入对比应自动带入 IMG_0.NEF 和 IMG_1.NEF
  app.openCompare();
  assert.strictEqual(app.S.mode, 'compare');
  assert.strictEqual(app.S.compare.items.length, 2);
  assert.strictEqual(app.S.compare.items[0].name, 'IMG_0.NEF');
  assert.strictEqual(app.S.compare.items[1].name, 'IMG_1.NEF');
  assert.strictEqual(app.S.compare.layout, '2-col');
  assert.strictEqual(app.S.compare.syncZoomPan, true);

  // 退出对比应返回网格视图
  app.closeCompare();
  assert.strictEqual(app.S.mode, 'grid');
});

test('openCompare 支持从外部直接拖入多个文件并自适应分屏布局', async () => {
  const pv = makeMockPv('D:/Photos', fakeScan(0, 'D:/Photos'));
  const app = loadApp(pv);

  // 外部拖入 3 张照片
  const externalFiles = ['C:/Users/Admin/Desktop/DSC_1001.JPG', 'C:/Users/Admin/Desktop/DSC_1002.NEF', 'C:/Users/Admin/Desktop/DSC_1003.ARW'];
  app.openCompare(externalFiles);

  assert.strictEqual(app.S.mode, 'compare');
  assert.strictEqual(app.S.compare.items.length, 3);
  assert.strictEqual(app.S.compare.items[0].ext, 'JPG');
  assert.strictEqual(app.S.compare.items[1].ext, 'NEF');
  assert.strictEqual(app.S.compare.items[2].ext, 'ARW');
  assert.strictEqual(app.S.compare.layout, '3-grid');

  // 外部拖入 4 张照片
  const fourFiles = [...externalFiles, 'C:/Users/Admin/Desktop/DSC_1004.CR3'];
  app.openCompare(fourFiles);
  assert.strictEqual(app.S.compare.items.length, 4);
  assert.strictEqual(app.S.compare.layout, '4-grid');
});

test('toggleCompare 可以在当前视图与对比模式间平滑切换', async () => {
  const pv = makeMockPv('D:/Photos', fakeScan(3, 'D:/Photos'));
  const app = loadApp(pv);

  await app.openFolder('D:/Photos');
  assert.strictEqual(app.S.mode, 'grid');

  app.toggleCompare();
  assert.strictEqual(app.S.mode, 'compare');

  app.toggleCompare();
  assert.strictEqual(app.S.mode, 'grid');
});

// 联动引擎的核心判定。渲染层在测试里是空跑的（querySelector 返回一次性假元素），
// 所以把「动哪几个槽位」抽成纯函数单独测 —— 这条挡的是「解锁单图后滚轮动的是别人」那个 bug。
test('syncTargets：解锁的槽位只动自己，锁定的槽位才参与全局联动', () => {
  const app = loadApp(makeMockPv('D:/Photos'));
  // app.js 跑在 vm 沙箱里，返回的数组带的是沙箱那份 Array.prototype，
  // deepStrictEqual 会因为原型不同而失败 —— 先拷回本 realm
  const targets = (items, idx, on) => Array.from(app.syncTargets(items, idx, on));
  const items = [{ locked: true }, { locked: true }, { locked: true }, { locked: true }];

  // 全部锁定 + 联动开 → 一起动
  assert.deepStrictEqual(targets(items, 0, true), [0, 1, 2, 3]);
  assert.deepStrictEqual(targets(items, 2, true), [0, 1, 2, 3]);

  // 联动总开关关掉 → 只动源槽位
  assert.deepStrictEqual(targets(items, 2, false), [2]);

  // 源槽位自己解锁 → 只能动它自己，绝不能变成「动其余全部、唯独不动它」
  const partly = [{ locked: true }, { locked: false }, { locked: true }];
  assert.deepStrictEqual(targets(partly, 1, true), [1]);

  // 在仍然锁定的槽位上操作 → 只带动其它锁定的，解锁的那张保持不动
  assert.deepStrictEqual(targets(partly, 0, true), [0, 2]);

  // 越界索引不应该炸
  assert.deepStrictEqual(targets(items, 9, true), []);
});

test('canonicalLayout 按张数挑分屏布局，且每种布局都装得下对应张数', () => {
  const app = loadApp(makeMockPv('D:/Photos'));
  assert.strictEqual(app.canonicalLayout(1), '2-col');
  assert.strictEqual(app.canonicalLayout(2), '2-col');
  assert.strictEqual(app.canonicalLayout(3), '3-grid');
  assert.strictEqual(app.canonicalLayout(4), '4-grid');
  assert.strictEqual(app.canonicalLayout(5), '6-grid');
  assert.strictEqual(app.canonicalLayout(6), '6-grid');
});

test('pickCompareWinner 定位到胜出的那张，而不是当前激活槽位那张', async () => {
  const pv = makeMockPv('D:/Photos', fakeScan(4, 'D:/Photos'));
  const app = loadApp(pv);

  await app.openFolder('D:/Photos');
  app.openCompare();
  assert.strictEqual(app.S.compare.items.length, 2);
  assert.strictEqual(app.S.compare.curSlot, 0); // 激活的是槽位 0

  // 在槽位 0 激活的状态下裁决槽位 1 胜出
  app.pickCompareWinner(1);

  assert.strictEqual(app.S.view[app.S.cur].name, 'IMG_1.NEF', '应该落在胜出者身上');
  assert.strictEqual(app.S.all[1].state, 'fav', '胜出者要被自动收藏');
  assert.notStrictEqual(app.S.mode, 'compare', '裁决后应该退出对比');
});

test('removeFromCompare 收缩布局并把 curSlot 夹回合法范围', async () => {
  const pv = makeMockPv('D:/Photos', fakeScan(6, 'D:/Photos'));
  const app = loadApp(pv);

  await app.openFolder('D:/Photos');
  app.openCompare(['D:/Photos/IMG_0.NEF', 'D:/Photos/IMG_1.NEF', 'D:/Photos/IMG_2.NEF', 'D:/Photos/IMG_3.NEF']);
  assert.strictEqual(app.S.compare.layout, '4-grid');

  app.S.compare.curSlot = 3;
  app.removeFromCompare(3);
  assert.strictEqual(app.S.compare.items.length, 3);
  assert.strictEqual(app.S.compare.layout, '3-grid');
  assert.strictEqual(app.S.compare.curSlot, 2, 'curSlot 不能停在已经不存在的槽位上');

  app.removeFromCompare(0);
  assert.strictEqual(app.S.compare.items.length, 2);
  assert.strictEqual(app.S.compare.layout, '2-col');
  assert.strictEqual(app.S.compare.items[0].name, 'IMG_1.NEF');
});
