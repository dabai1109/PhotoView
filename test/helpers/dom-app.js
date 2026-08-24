'use strict';
/**
 * app.js 的最小运行环境：一套够用的 DOM 桩 + 把 app.js 塞进 vm 跑起来。
 *
 * app.js 是浏览器脚本，顶层就会 $('#xxx') 到处摸元素、建 Worker、量尺寸。
 * 这里的桩只保证「顶层跑通 + 网格/大图渲染不炸」，不追求还原真实布局。
 */
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src/renderer/app.js'), 'utf8'), sandbox);
  assert.ok(win.__pv && typeof win.__pv.openFolder === 'function', 'app.js 没有挂出 window.__pv.openFolder');
  return win.__pv;
}

/** 等一会儿，让 app.js 里 debounce 的 saveSession / 微任务跑完 */
const tick = (ms = 260) => new Promise((r) => setTimeout(r, ms));

module.exports = { loadApp, makeEl, makeCtx2d, tick };
