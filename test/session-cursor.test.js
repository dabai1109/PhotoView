'use strict';
/**
 * 会话游标恢复的回归测试（node --test，零依赖）。
 *
 * openFolder 会从 session 里读回「上次看到第几张」，但 applyFilter 紧接着
 * 又会用 S.view[S.cur] 做「保持当前选中」并在匹配不到时把 S.cur 归零 ——
 * 顺序一错，恢复出来的位置就被无声吃掉。这类顺序 bug 光看代码很容易漏，
 * 所以这里真的把 app.js 跑起来，驱动 window.__pv.openFolder 验证。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

/* ---------- 最小 DOM 桩：只要够 app.js 顶层跑通 + 网格渲染不炸 ---------- */

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
    children: [], dataset: {}, style: {}, _parent: null,
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

/** 加载 app.js 并返回它挂出来的调试入口 window.__pv */
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
  assert.ok(win.__pv && typeof win.__pv.openFolder === 'function', 'app.js 没有挂出 window.__pv.openFolder');
  return win.__pv;
}

/** n 张照片的假扫描结果 */
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

/** 每个相册各自的 session.cursor */
function makePv(sessions) {
  return {
    getSettings: () => Promise.resolve({ thumbSize: 220, theme: 'dark', showInfo: true }),
    setSettings: () => Promise.resolve({}),
    recent: () => Promise.resolve([]),
    scanFolder: (root) => Promise.resolve(fakeScan(sessions[root].count, root)),
    getSession: (root) => Promise.resolve({ cursor: sessions[root].cursor }),
    setSession: () => Promise.resolve(true),
    saveFavorites: () => Promise.resolve(0),
    getFavorites: () => Promise.resolve([]),
    preview: () => Promise.resolve({ ok: false }),
    putThumb: () => Promise.resolve(false),
    setNativeTheme: () => Promise.resolve(true),
    isDirectory: () => Promise.resolve(true),
  };
}

test('openFolder 恢复 session 里的游标位置', async () => {
  const pv = makePv({ 'D:/A': { count: 100, cursor: 42 } });
  const app = loadApp(pv);
  await app.openFolder('D:/A');
  assert.strictEqual(app.S.cur, 42, 'session 里的 cursor 应该被恢复，而不是被 applyFilter 归零');
  assert.strictEqual(app.S.view.length, 100);
});

test('换到第二个相册时不受上一个相册的 view 影响', async () => {
  const pv = makePv({ 'D:/A': { count: 100, cursor: 42 }, 'D:/B': { count: 50, cursor: 7 } });
  const app = loadApp(pv);
  await app.openFolder('D:/A');
  assert.strictEqual(app.S.cur, 42);
  // 这一步是原来的坑：applyFilter 会拿 A 的对象去 B 的 view 里 indexOf
  await app.openFolder('D:/B');
  assert.strictEqual(app.S.cur, 7, '第二次打开相册时游标同样要恢复');
  assert.strictEqual(app.S.view.length, 50);
});

test('越界 / 缺失的游标要被夹进合法范围', async () => {
  const pv = makePv({
    'D:/Big': { count: 10, cursor: 999 },
    'D:/None': { count: 10, cursor: undefined },
    'D:/Neg': { count: 10, cursor: -5 },
    'D:/Empty': { count: 0, cursor: 3 },
  });
  const app = loadApp(pv);
  await app.openFolder('D:/Big');
  assert.strictEqual(app.S.cur, 9, '超出张数时应夹到最后一张');
  await app.openFolder('D:/None');
  assert.strictEqual(app.S.cur, 0, '没有 cursor 时从第一张开始');
  await app.openFolder('D:/Neg');
  assert.strictEqual(app.S.cur, 0, '负数 cursor 应夹到 0');
  await app.openFolder('D:/Empty');
  assert.strictEqual(app.S.cur, 0, '空相册的游标必须是 0');
});
