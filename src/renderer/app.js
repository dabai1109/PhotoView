/* PhotoView — 选片主逻辑 */

const $ = (s) => document.querySelector(s);
const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/* ============ 状态 ============ */
const S = {
  root: null,
  favoritesFileName: 'favorites.txt',
  all: [],
  view: [],
  cur: 0,
  filter: 'all',
  mode: 'empty', // empty | grid | loupe | compare
  settings: {},
  session: { favorites: [], cursor: 0 },
  undo: [],
  loupe: { url: null, zoom: 1, fit: 1, panX: 0, panY: 0, o: 1, srcW: 0, srcH: 0, natW: 0, natH: 0, token: 0 },
  compare: {
    items: [],
    mode: 'split', // split | curtain | blink
    layout: '2-col', // 2-col | 2-row | 3-grid | 4-grid | 6-grid
    curSlot: 0,
    syncZoomPan: true,
    curtainSplit: 0.5,
    blinkIndex: 0,
    prevMode: 'grid',
  },
};

const swapped = (o) => o >= 5 && o <= 8;
const mirrored = (o) => o === 2 || o === 4 || o === 5 || o === 7;
// 注意 5 配 270、7 配 90，不是按数字顺序配的：applyTransform 是先 scaleX(-1) 再 rotate，
// 镜像会把旋转方向也翻过来。写成 5→90 / 7→270 的话这两个方向会互相显示成对方（差 180°）。
const rotDeg = (o) => (o === 3 || o === 4 ? 180 : o === 6 || o === 7 ? 90 : o === 5 || o === 8 ? 270 : 0);

const fmtSize = (n) =>
  n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';

/* ============ Worker 池 ============ */
const POOL_N = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
const pool = { ws: [], rr: 0, jobs: new Map(), seq: 1 };
for (let i = 0; i < POOL_N; i++) {
  const w = new Worker('decode-worker.js');
  w.onmessage = (e) => {
    const job = pool.jobs.get(e.data.id);
    if (!job) return;
    pool.jobs.delete(e.data.id);
    job(e.data);
  };
  pool.ws.push(w);
}
function workerCall(msg) {
  return new Promise((resolve) => {
    const id = pool.seq++;
    pool.jobs.set(id, resolve);
    const w = pool.ws[pool.rr++ % pool.ws.length];
    w.postMessage({ ...msg, id });
  });
}

/* ============ 缩略图服务 ============ */
const THUMB_BOX = 480;
const urlCache = new Map(); // file -> objectURL
const inflight = new Map();
let running = 0;
const queue = [];

function pump() {
  while (running < 5 && queue.length) {
    const job = queue.shift();
    if (job.cancelled && job.cancelled()) {
      job.drop(); // 丢弃也必须结掉 promise，否则 inflight 永远不释放
      continue;
    }
    running++;
    job.run().finally(() => {
      running--;
      pump();
    });
  }
}

function touchCache(file, url) {
  urlCache.set(file, url);
  if (urlCache.size > 900) {
    const k = urlCache.keys().next().value;
    const u = urlCache.get(k);
    urlCache.delete(k);
    if (u) URL.revokeObjectURL(u);
  }
}

function getThumb(file, cancelled, priority) {
  const hit = urlCache.get(file);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(file)) return inflight.get(file);

  const p = new Promise((resolve) => {
    const job = {
      cancelled,
      drop: () => resolve(null),
      run: async () => {
        try {
          const r = await window.pv.preview(file, 'thumb', THUMB_BOX);
          if (!r || !r.ok) return resolve(null);
          if (r.cached) {
            const url = URL.createObjectURL(new Blob([r.data], { type: 'image/jpeg' }));
            touchCache(file, url);
            return resolve(url);
          }
          const buf = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength);
          const needWorkerRotate = (r.orientation || 1) !== 1;
          const srcW = needWorkerRotate ? (r.storeW || r.width || 0) : (r.width || r.storeW || 0);
          const srcH = needWorkerRotate ? (r.storeH || r.height || 0) : (r.height || r.storeH || 0);
          const out = await workerCall({
            type: 'thumb',
            buf,
            box: THUMB_BOX,
            orientation: r.orientation || 1,
            srcW,
            srcH,
          });
          if (!out.ok) return resolve(null);
          const bytes = new Uint8Array(out.ab);
          window.pv.putThumb(file, THUMB_BOX, bytes);
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
          touchCache(file, url);
          resolve(url);
        } catch {
          resolve(null);
        }
      },
    };
    // 大图要用的缩略图插队，避免排在几十个网格任务后面
    if (priority) queue.unshift(job);
    else queue.push(job);
    pump();
  }).finally(() => inflight.delete(file));

  inflight.set(file, p);
  return p;
}

/* ============ 全尺寸预览缓存（大图秒开的关键） ============
   把已看过 / 预取到的大图连同解码结果留在内存里，前后翻页时直接命中，
   不用再走 IPC → 建 blob → 解码这条链路。
   上限必须比「对比工作台最多 6 张 + 大图前后预取」更大：evict 时会 revoke objectURL，
   容量卡得太死就会把某个正在显示的 <img> 的 URL 撤掉，下次重新赋 src 就是破图。 */
const FULL_MAX = 12;
const fullCache = new Map(); // file -> {url, blob, o, w, h, exif, fileSize, hist}
const fullInflight = new Map();

function evictFull(keep) {
  let guard = 0;
  while (fullCache.size > FULL_MAX && guard++ < 32) {
    const k = fullCache.keys().next().value;
    const v = fullCache.get(k);
    fullCache.delete(k);
    if (k === keep) {
      fullCache.set(k, v); // 当前正在看的挪到队尾，换下一个淘汰
      continue;
    }
    URL.revokeObjectURL(v.url);
  }
}

function clearFullCache() {
  for (const [, v] of fullCache) URL.revokeObjectURL(v.url);
  fullCache.clear();
}

function loadFull(file) {
  const hit = fullCache.get(file);
  if (hit) return Promise.resolve(hit);
  if (fullInflight.has(file)) return fullInflight.get(file);

  const p = (async () => {
    try {
      const r = await window.pv.preview(file, 'full', 0);
      if (!r || !r.ok) return { error: (r && r.error) || '无法读取这张照片的预览图' };
      const blob = new Blob([r.data], { type: r.mime || 'image/jpeg' });
      const rec = {
        url: URL.createObjectURL(blob),
        blob,
        o: r.orientation || 1,
        w: r.width || 0,
        h: r.height || 0,
        exif: r.exif || {},
        fileSize: r.fileSize,
        hist: null,
      };
      // 先入缓存再预热解码。decode() 在窗口被遮挡/最小化时可能一直不 resolve，
      // 所以绝不能 await 它，否则整张图就卡在这儿了。
      fullCache.set(file, rec);
      evictFull(file);
      try {
        const im = new Image();
        im.src = rec.url;
        const d = im.decode();
        if (d && d.catch) d.catch(() => { });
      } catch { }
      return rec;
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })();

  fullInflight.set(file, p);
  p.finally(() => fullInflight.delete(file));
  return p;
}

let prefetchTimer = null;
function schedulePrefetch() {
  clearTimeout(prefetchTimer);
  // 连续翻页时不抢当前这张的带宽，停下来才预取
  prefetchTimer = setTimeout(() => {
    // 网格里预取「选中的这张」，这样按回车进大图是瞬开的；大图里预取前后几张
    for (const d of S.mode === 'grid' ? [0, 1] : [1, -1, 2]) {
      const n = S.view[S.cur + d];
      if (n && !fullCache.has(n.primary)) loadFull(n.primary);
    }
  }, 160);
}

/* ============ 打开文件夹 ============ */
async function openFolder(root) {
  if (!root) return;
  S.root = root;
  clearFullCache();
  $('#empty').hidden = true;
  $('#topbar-tools').hidden = false;
  $('#folder-name').innerHTML = '正在扫描…';

  const [res, session] = await Promise.all([window.pv.scanFolder(root), window.pv.getSession(root)]);
  S.favoritesFileName = res.favoritesFileName || S.settings.favoritesFileName || 'favorites.txt';
  S.session = { cursor: 0, ...session };

  // 收藏状态直接由相册根目录的 favorites.txt (及全局 session) 决定
  S.all = res.groups.map((g) => ({
    ...g,
    state: g.favored ? 'fav' : 'none',
    meta: null,
  }));
  S.undo = [];
  S.filter = 'all';
  // 上一个相册的 view 必须先清掉：applyFilter 靠 S.view[S.cur] 做「保持当前选中」，
  // 留着旧数组的话它会拿上个相册的对象去 indexOf，永远匹配不上。
  S.view = [];
  S.cur = 0;

  const shortRoot = root.length > 60 ? '…' + root.slice(-58) : root;
  $('#folder-name').innerHTML = `<b>${escapeHtml(root.split(/[\\/]/).pop())}</b> · ${escapeHtml(shortRoot)}`;

  applyFilter('all');
  // 恢复上次看到哪张必须放在 applyFilter 之后 —— 它会把 S.cur 归零
  S.cur = Math.min(Math.max(0, Math.round(Number(S.session.cursor) || 0)), Math.max(0, S.view.length - 1));
  showGrid();
  if (!S.all.length) toast('这个文件夹里没有找到支持的照片格式', { err: true });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ============ 刷新当前文件夹 ============ */
async function refreshFolder() {
  if (!S.root) return;
  const btn = $('#btn-refresh');
  if (btn) btn.classList.add('spinning');

  const curId = S.view[S.cur]?.id;
  const prevFilter = S.filter;
  const prevMode = S.mode;

  try {
    const [res, session] = await Promise.all([window.pv.scanFolder(S.root), window.pv.getSession(S.root)]);
    S.favoritesFileName = res.favoritesFileName || S.settings.favoritesFileName || 'favorites.txt';
    S.session = { cursor: 0, ...session };

    S.all = res.groups.map((g) => ({
      ...g,
      state: g.favored ? 'fav' : 'none',
      meta: null,
    }));

    applyFilter(prevFilter);

    if (curId) {
      const idx = S.view.findIndex((g) => g.id === curId);
      if (idx >= 0) S.cur = idx;
      else S.cur = Math.min(S.cur, Math.max(0, S.view.length - 1));
    } else {
      S.cur = Math.min(S.cur, Math.max(0, S.view.length - 1));
    }

    updateCounts();
    refreshCards();

    if (prevMode === 'loupe' && S.view.length > 0) {
      buildFilmstrip();
      loadLoupe();
    } else {
      if (S.mode === 'grid') renderGrid(true);
      else showGrid();
      scrollCurrentIntoView();
    }

    toast(`已刷新 · 共 ${S.all.length} 张照片`);
  } catch (err) {
    toast('刷新失败：' + (err.message || err), { err: true });
  } finally {
    if (btn) setTimeout(() => btn.classList.remove('spinning'), 500);
  }
}

/* ============ 筛选 ============ */
function applyFilter(f) {
  const curItem = S.view[S.cur];
  S.filter = f;
  S.view =
    f === 'all' ? S.all.slice()
      : f === 'todo' ? S.all.filter((g) => g.state === 'none')
        : f === 'fav' ? S.all.filter((g) => g.state === 'fav')
          : S.all.filter((g) => g.state === 'del');

  const idx = curItem ? S.view.indexOf(curItem) : -1;
  S.cur = idx >= 0 ? idx : 0;

  for (const b of document.querySelectorAll('#filters .chip')) b.classList.toggle('active', b.dataset.filter === f);
  updateCounts();
  if (S.mode === 'grid') {
    renderGrid(true);
  } else if (S.mode === 'loupe') {
    if (!S.view.length) {
      showGrid();
    } else {
      buildFilmstrip();
      loadLoupe();
    }
  }
}

function updateCounts() {
  const n = { all: S.all.length, todo: 0, fav: 0, del: 0 };
  for (const g of S.all) {
    if (g.state === 'none') n.todo++;
    else if (g.state === 'fav') n.fav++;
    else n.del++;
  }
  for (const b of document.querySelectorAll('#filters .chip')) {
    const countEl = b.querySelector('b');
    if (countEl) countEl.textContent = n[b.dataset.filter] || 0;
  }
  const cur = S.view[S.cur];
  $('#counter').innerHTML = S.view.length
    ? `<b>${S.cur + 1}</b> / ${S.view.length}${cur ? ' · ' + escapeHtml(cur.name) : ''}`
    : '';
  const fav = cur && cur.state === 'fav';
  const actFavBtn = $('#act-fav');
  if (actFavBtn) {
    actFavBtn.classList.toggle('on', !!fav);
    const actText = actFavBtn.querySelector('.act-text');
    if (actText) actText.textContent = fav ? '已收藏' : '收藏';
    else actFavBtn.lastChild.textContent = fav ? ' 已收藏' : ' 收藏';
  }
  const actUndoBtn = $('#act-undo');
  if (actUndoBtn) {
    actUndoBtn.disabled = !S.undo.length;
    actUndoBtn.style.opacity = S.undo.length ? '1' : '.4';
  }
}

/* ============ 网格 ============ */
const gridScroll = $('#grid-scroll');
const gridCanvas = $('#grid-canvas');
const GAP = 10;
let layout = { cols: 1, cw: 200, ch: 150, rows: 0 };
const mounted = new Map(); // index -> element

function computeLayout() {
  const W = gridScroll.clientWidth - 28;
  const target = S.settings.thumbSize || 220;
  const cols = Math.max(1, Math.floor((W + GAP) / (target + GAP)));
  const cw = Math.floor((W - GAP * (cols - 1)) / cols);
  const ch = Math.round(cw * 0.74);
  const rows = Math.ceil(S.view.length / cols);
  layout = { cols, cw, ch, rows };
  gridCanvas.style.height = Math.max(0, rows * (ch + GAP) - GAP) + 'px';
}

function renderGrid(reset) {
  if (S.mode !== 'grid') return;
  if (reset) {
    for (const [, e] of mounted) e.remove();
    mounted.clear();
  }
  computeLayout();
  $('#grid-empty').hidden = S.view.length > 0;

  const { cols, cw, ch } = layout;
  const top = gridScroll.scrollTop;
  const h = gridScroll.clientHeight;
  const rowH = ch + GAP;
  const first = Math.max(0, Math.floor(top / rowH) - 2);
  const last = Math.min(layout.rows - 1, Math.ceil((top + h) / rowH) + 2);
  const from = first * cols;
  const to = Math.min(S.view.length - 1, (last + 1) * cols - 1);

  for (const [i, e] of mounted) {
    if (i < from || i > to) {
      e.remove();
      mounted.delete(i);
    }
  }
  for (let i = from; i <= to; i++) {
    let card = mounted.get(i);
    if (!card) {
      card = buildCard(i); // 内部会先登记到 mounted，再发起缩略图请求
      gridCanvas.appendChild(card);
    }
    const r = Math.floor(i / cols);
    const c = i % cols;
    card.style.width = cw + 'px';
    card.style.height = ch + 'px';
    card.style.left = c * (cw + GAP) + 'px';
    card.style.top = r * (ch + GAP) + 'px';
  }
}

function buildCard(i) {
  const g = S.view[i];
  const card = el('div', 'card');
  card.dataset.i = i;
  const ph = el('div', 'ph');
  ph.textContent = g.ext;
  card.appendChild(ph);

  const img = el('img');
  card.appendChild(img);

  const meta = el('div', 'meta');
  const nm = el('span', 'fname');
  nm.textContent = g.name;
  meta.appendChild(nm);
  if (g.hasPair) {
    const t = el('span', 'tag');
    t.textContent = '+JPG';
    meta.appendChild(t);
  }
  card.appendChild(meta);

  syncCard(card, g, i);
  // 必须先登记，getThumb 的取消判断依赖 mounted
  mounted.set(i, card);

  getThumb(g.primary, () => mounted.get(i) !== card).then((url) => {
    if (!url || !card.isConnected) return;
    img.src = url;
    img.onload = () => {
      img.classList.add('on');
      ph.remove();
    };
  });

  card.onclick = () => {
    S.cur = i;
    for (const [j, e] of mounted) e.classList.toggle('sel', j === i);
    updateCounts();
    schedulePrefetch(); // 选中就把大图备好，回车进大图是瞬开的
  };
  card.ondblclick = () => {
    S.cur = i;
    showLoupe();
  };
  return card;
}

function syncCard(card, g, i) {
  card.classList.toggle('sel', i === S.cur);
  card.classList.toggle('fav', g.state === 'fav');
  card.classList.toggle('del', g.state === 'del');
  const old = card.querySelector('.badge');
  if (old) old.remove();
  if (g.state !== 'none') {
    const b = el('div', 'badge' + (g.state === 'del' ? ' d' : ''));
    b.textContent = g.state === 'fav' ? '★' : '✕';
    card.appendChild(b);
  }
}

function refreshCards() {
  for (const [i, e] of mounted) {
    const g = S.view[i];
    if (g) syncCard(e, g, i);
  }
}

gridScroll.addEventListener('scroll', () => renderGrid(false), { passive: true });
window.addEventListener('resize', () => {
  if (S.mode === 'grid') renderGrid(true);
  else if (S.mode === 'loupe') layoutLoupe();
  else if (S.mode === 'compare') relayoutCompare();
});

function scrollCurrentIntoView() {
  const { cols, ch } = layout;
  const row = Math.floor(S.cur / cols);
  const y = row * (ch + GAP);
  const top = gridScroll.scrollTop;
  const h = gridScroll.clientHeight;
  if (y < top) gridScroll.scrollTop = y - GAP;
  else if (y + ch > top + h) gridScroll.scrollTop = y + ch - h + GAP;
}

/* ============ 视图切换 ============ */
function showGrid() {
  S.mode = 'grid';
  $('#grid-view').hidden = false;
  $('#loupe').hidden = true;
  $('#compare-view').hidden = true;
  $('#actionbar').hidden = false;
  $('#btn-grid').classList.add('on');
  const btnCmp = $('#btn-compare');
  if (btnCmp) btnCmp.classList.remove('on');
  renderGrid(true);
  scrollCurrentIntoView();
  refreshCards();
  updateCounts();
}

function showLoupe() {
  if (!S.view.length) return;
  S.mode = 'loupe';
  $('#grid-view').hidden = true;
  $('#loupe').hidden = false;
  $('#compare-view').hidden = true;
  $('#actionbar').hidden = false;
  $('#btn-grid').classList.remove('on');
  const btnCmp = $('#btn-compare');
  if (btnCmp) btnCmp.classList.remove('on');
  $('#loupe').classList.toggle('no-info', !S.settings.showInfo);
  buildFilmstrip();
  loadLoupe();
}

/* ==========================================================================
   照片细节对比工作台 (Compare Studio)
   ========================================================================== */

function makeCompareItem(gOrPath) {
  if (typeof gOrPath === 'string') {
    const fn = gOrPath.split(/[\\/]/).pop();
    const extMatch = fn.match(/\.([^.]+)$/);
    const ext = extMatch ? extMatch[1].toUpperCase() : 'IMG';
    return {
      id: gOrPath,
      name: fn,
      ext,
      primary: gOrPath,
      files: [gOrPath],
      state: 'none',
      size: 0,
      meta: null,
      zoom: 1,
      fit: 1,
      panX: 0,
      panY: 0,
      natW: 0,
      natH: 0,
      srcW: 0,
      srcH: 0,
      o: 1,
      locked: true,
    };
  }
  return {
    id: gOrPath.id || gOrPath.primary,
    name: gOrPath.name,
    ext: gOrPath.ext,
    primary: gOrPath.primary,
    files: gOrPath.files || [gOrPath.primary],
    state: gOrPath.state || 'none',
    size: gOrPath.size || 0,
    meta: gOrPath.meta || null,
    zoom: 1,
    fit: 1,
    panX: 0,
    panY: 0,
    natW: 0,
    natH: 0,
    srcW: 0,
    srcH: 0,
    o: 1,
    locked: true,
  };
}

/* 各布局能装下的槽位数。布局按钮随时可点，装不下时 CSS 那边有 grid-auto-rows: 1fr 兜底，
   这里只负责在增删槽位时挑一个合理的默认值。 */
const LAYOUT_CAP = { '2-col': 2, '2-row': 2, '3-grid': 3, '4-grid': 4, '6-grid': 6 };
const canonicalLayout = (n) => (n <= 2 ? '2-col' : n === 3 ? '3-grid' : n === 4 ? '4-grid' : '6-grid');

function autoCompareLayout() {
  // 用户手动选的布局正好装得下就尊重它（比如 2 张时选了上下分屏）
  if (LAYOUT_CAP[S.compare.layout] === S.compare.items.length) return;
  S.compare.layout = canonicalLayout(S.compare.items.length);
}

function openCompare(initialItems) {
  let items = [];
  if (initialItems && initialItems.length) {
    items = initialItems.map(makeCompareItem);
  } else {
    // 从当前相册中自动挑选 2 张（当前选中的与下一张）
    if (S.view.length >= 2) {
      const cur = S.view[S.cur];
      const next = S.view[S.cur + 1] || S.view[S.cur - 1];
      items = [cur, next].filter(Boolean).map(makeCompareItem);
    } else if (S.view.length === 1) {
      items = [makeCompareItem(S.view[0])];
    } else {
      toast('当前相册中没有可对比的照片，可直接拖入多张照片开始对比');
      return;
    }
  }

  S.compare.prevMode = S.mode === 'compare' ? 'grid' : S.mode;
  S.compare.items = items.slice(0, 6); // 最多支持 6 张对比
  S.compare.curSlot = 0;
  S.mode = 'compare';

  // 自适应选择分屏布局
  S.compare.layout = canonicalLayout(S.compare.items.length);

  $('#empty').hidden = true;
  $('#grid-view').hidden = true;
  $('#loupe').hidden = true;
  $('#actionbar').hidden = true;
  $('#compare-view').hidden = false;
  $('#btn-grid').classList.remove('on');
  const btnCmp = $('#btn-compare');
  if (btnCmp) btnCmp.classList.add('on');

  renderCompare();
  buildCompareFilmstrip();
  toast(`已进入细节对比 · 共 ${S.compare.items.length} 张照片`);
}

function closeCompare() {
  $('#compare-view').hidden = true;
  const btnCmp = $('#btn-compare');
  if (btnCmp) btnCmp.classList.remove('on');

  // 如果对比中选中了某张在相册中的照片，回到该照片
  const curItem = S.compare.items[S.compare.curSlot];
  if (curItem) {
    const idx = S.view.findIndex((g) => g.primary === curItem.primary || g.id === curItem.id);
    if (idx >= 0) S.cur = idx;
  }

  if (S.compare.prevMode === 'loupe' && S.view.length) {
    showLoupe();
  } else if (S.view.length) {
    showGrid();
  } else {
    S.mode = 'empty';
    $('#empty').hidden = false;
    $('#topbar-tools').hidden = true;
  }
}

function toggleCompare() {
  if (S.mode === 'compare') closeCompare();
  else openCompare();
}

/* 只刷新浮岛按钮态。切同步锁 / 换激活槽位这类操作不该把整个舞台重建一遍 ——
   renderSplitCompare 会 innerHTML='' 重来，六张图会一起闪一下加载遮罩。 */
function updateCompareDock() {
  for (const pill of document.querySelectorAll('#cmp-mode-pills .cmp-pill')) {
    pill.classList.toggle('active', pill.dataset.cmpMode === S.compare.mode);
  }
  for (const btn of document.querySelectorAll('#cmp-layout-btns .cmp-icon-btn')) {
    btn.classList.toggle('active', btn.dataset.cmpLayout === S.compare.layout);
  }
  const syncBtn = $('#btn-cmp-sync');
  if (syncBtn) syncBtn.classList.toggle('active', S.compare.syncZoomPan);
}

/* 同上：只同步槽位的激活态与收藏态，不重建 DOM */
function syncSlotChrome() {
  for (const slot of document.querySelectorAll('#compare-split-stage .compare-slot')) {
    const idx = +slot.dataset.idx;
    const item = S.compare.items[idx];
    if (!item) continue;
    slot.classList.toggle('active', idx === S.compare.curSlot);
    const favBtn = slot.querySelector('.slot-btn.fav');
    if (favBtn) favBtn.classList.toggle('active', item.state === 'fav');
  }
  syncCompareFilmstrip();
}

function renderCompare() {
  if (S.mode !== 'compare') return;

  updateCompareDock();

  const splitStage = $('#compare-split-stage');
  const curtainStage = $('#compare-curtain-stage');
  const blinkStage = $('#compare-blink-stage');

  if (S.compare.mode === 'split') {
    splitStage.hidden = false;
    curtainStage.hidden = true;
    blinkStage.hidden = true;
    renderSplitCompare();
  } else if (S.compare.mode === 'curtain') {
    splitStage.hidden = true;
    curtainStage.hidden = false;
    blinkStage.hidden = true;
    renderCurtainCompare();
  } else if (S.compare.mode === 'blink') {
    splitStage.hidden = true;
    curtainStage.hidden = true;
    blinkStage.hidden = false;
    renderBlinkCompare();
  }
}

/* ---------- 分屏渲染与视口联动 ---------- */
function renderSplitCompare() {
  const stage = $('#compare-split-stage');
  stage.className = `compare-split-stage layout-${S.compare.layout}`;
  stage.innerHTML = '';

  S.compare.items.forEach((item, idx) => {
    const slot = el('div', 'compare-slot' + (idx === S.compare.curSlot ? ' active' : ''));
    slot.dataset.idx = idx;

    // 头部信息栏
    const header = el('div', 'slot-header');

    const badgeGroup = el('div', 'slot-badge-group');
    const numBadge = el('div', 'slot-num');
    numBadge.textContent = idx + 1;
    const nameSpan = el('div', 'slot-name');
    nameSpan.textContent = item.name;
    nameSpan.title = item.name;
    const tagSpan = el('div', 'slot-tag');
    tagSpan.textContent = item.ext;
    badgeGroup.append(numBadge, nameSpan, tagSpan);

    const exifPill = el('div', 'slot-exif-pill');
    exifPill.innerHTML = '<span>载入参数…</span>';

    const actions = el('div', 'slot-actions');

    // 收藏按钮
    const btnFav = el('button', 'slot-btn fav' + (item.state === 'fav' ? ' active' : ''));
    btnFav.title = '标记收藏 (F)';
    btnFav.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
    btnFav.onclick = (e) => {
      e.stopPropagation();
      toggleSlotFav(idx);
    };

    // 独立联动锁
    const btnLock = el('button', 'slot-btn lock' + (item.locked ? '' : ' unlocked'));
    btnLock.title = item.locked ? '参与全局联动 (已锁定)' : '单独微调视角 (已解锁)';
    btnLock.innerHTML = item.locked
      ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
      : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
    btnLock.onclick = (e) => {
      e.stopPropagation();
      item.locked = !item.locked;
      btnLock.classList.toggle('unlocked', !item.locked);
      btnLock.title = item.locked ? '参与全局联动 (已锁定)' : '单独微调视角 (已解锁)';
      btnLock.innerHTML = item.locked
        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
      toast(item.locked ? `槽位 ${idx + 1} 已加入全局联动` : `槽位 ${idx + 1} 已解除联动（可独立平移缩放）`);
    };

    // 胜出裁决 (Winner)
    const btnWin = el('button', 'slot-btn winner');
    btnWin.title = '胜出裁决：选定此张并退出对比 (W)';
    btnWin.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.45 1-1 1H7"/><path d="M14 14.66V17c0 .55.45 1 1 1h2"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>';
    btnWin.onclick = (e) => {
      e.stopPropagation();
      pickCompareWinner(idx);
    };

    // 移除槽位
    const btnDel = el('button', 'slot-btn del');
    btnDel.title = '从对比中移除 (Del)';
    btnDel.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    btnDel.onclick = (e) => {
      e.stopPropagation();
      removeFromCompare(idx);
    };

    actions.append(btnFav, btnLock, btnWin, btnDel);
    header.append(badgeGroup, exifPill, actions);
    slot.appendChild(header);

    // 视口区域
    const viewport = el('div', 'slot-viewport');
    const img = el('img');
    img.draggable = false;
    viewport.appendChild(img);

    const zoomTag = el('div', 'slot-zoom-tag');
    zoomTag.hidden = true;
    viewport.appendChild(zoomTag);

    const loading = el('div', 'slot-loading');
    loading.innerHTML = '<div class="spinner-ring"></div><span>加载高清预览…</span>';
    viewport.appendChild(loading);

    slot.appendChild(viewport);
    stage.appendChild(slot);

    // 点击激活槽位（视口内部的点击交给 pointerup 判定 —— 那边要区分拖拽和单击）
    slot.onclick = (e) => {
      if (e.target && e.target.closest && e.target.closest('.slot-viewport')) return;
      S.compare.curSlot = idx;
      syncSlotChrome();
    };

    // 载入大图
    loadFull(item.primary).then((rec) => {
      if (!slot.isConnected) return;
      loading.remove();
      if (rec.error) {
        exifPill.innerHTML = '<span style="color:var(--del)">读取失败</span>';
        return;
      }
      item.meta = { orientation: rec.o, width: rec.w, height: rec.h, exif: rec.exif, fileSize: rec.fileSize };
      item.o = rec.o || 1;
      item.srcW = rec.w || 0;
      item.srcH = rec.h || 0;

      // 渲染 EXIF 胶囊
      renderSlotExif(exifPill, rec.exif);

      img.src = rec.url;
      img.onload = () => {
        img.classList.add('loaded');
        layoutSlot(item, slot);
      };
      if (img.complete && img.naturalWidth) {
        img.classList.add('loaded');
        layoutSlot(item, slot);
      }
    });

    // 视口交互：滚轮与平移
    bindSlotViewportEvents(item, slot, idx);
  });
}

function renderSlotExif(pillEl, exif) {
  if (!exif) {
    pillEl.innerHTML = '<span>无 EXIF</span>';
    return;
  }
  const parts = [];
  if (exif.aperture) parts.push(`<b>${escapeHtml(exif.aperture)}</b>`);
  if (exif.shutter) parts.push(`<b>${escapeHtml(exif.shutter)}</b>`);
  if (exif.iso) parts.push(`<b>${escapeHtml(exif.iso)}</b>`);
  if (exif.focal) parts.push(`<b>${escapeHtml(exif.focal)}</b>`);
  pillEl.innerHTML = parts.length ? parts.join(' · ') : '<span>已就绪</span>';
}

function bindSlotViewportEvents(item, slot, idx) {
  const vp = slot.querySelector('.slot-viewport');
  const img = slot.querySelector('img');

  // 滚轮缩放
  vp.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0018);
      zoomSlot(idx, factor, e.clientX, e.clientY);
    },
    { passive: false }
  );

  // 指针拖拽平移
  let drag = null;
  vp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, moved: false };
    vp.setPointerCapture(e.pointerId);
  });

  vp.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    panSlot(idx, dx, dy);
  });

  const endDrag = () => {
    drag = null;
    // panSlot 是给「所有联动槽位」都加上 panning 的，收尾时也要全部清掉，
    // 只清自己的话其余槽位会一直停在 grabbing 光标上
    for (const s of document.querySelectorAll('.compare-slot')) s.classList.remove('panning');
  };

  vp.addEventListener('pointerup', () => {
    if (drag && !drag.moved) {
      // 单击切换当前槽位
      S.compare.curSlot = idx;
      syncSlotChrome();
    }
    endDrag();
  });
  // 指针被系统取消（例如触控被手势接管）时也要收尾，否则 drag 会一直挂着
  vp.addEventListener('pointercancel', endDrag);

  // 双击 1:1 放大切换
  vp.ondblclick = () => {
    img.classList.add('smooth');
    const targetZoom = item.zoom === 1 ? 1 / Math.max(0.01, item.fit || 1) : 1;
    setSlotZoom(idx, targetZoom);
    setTimeout(() => img.classList.remove('smooth'), 200);
  };
}

const compareSlotEl = (i) => document.querySelector(`.compare-slot[data-idx="${i}"]`);

function layoutSlot(item, slot) {
  const img = slot.querySelector('img');
  const vp = slot.querySelector('.slot-viewport');
  if (!img || !vp) return;

  const o = item.o || 1;
  const nw = item.srcW || img.naturalWidth;
  const nh = item.srcH || img.naturalHeight;
  if (!nw || !nh) return;

  item.natW = nw;
  item.natH = nh;
  const sw = swapped(o) ? nh : nw;
  const sh = swapped(o) ? nw : nh;

  const box = vp.getBoundingClientRect();
  const pad = 24;
  const fit = Math.min((box.width - pad) / Math.max(1, sw), (box.height - pad) / Math.max(1, sh));
  item.fit = fit > 0 ? fit : 0.01;

  img.style.width = nw * item.fit + 'px';
  img.style.height = nh * item.fit + 'px';
  // 窗口尺寸变了之后旧的 pan 可能已经越界，重排时必须重新夹一次
  clampSlotPan(item, slot);
  applySlotTransform(item, slot);
}

function applySlotTransform(item, slot) {
  const img = slot.querySelector('img');
  const zoomTag = slot.querySelector('.slot-zoom-tag');
  if (!img) return;

  const { zoom, panX, panY, o } = item;
  const mir = mirrored(o) ? ' scaleX(-1)' : '';
  img.style.transform = `translate(-50%,-50%) translate(${panX}px,${panY}px) scale(${zoom}) rotate(${rotDeg(o)}deg)${mir}`;

  slot.classList.toggle('zoomed', zoom > 1);
  if (zoomTag) {
    if (zoom !== 1) {
      zoomTag.hidden = false;
      zoomTag.textContent = `${Math.round(item.fit * zoom * 100)}%`;
    } else {
      zoomTag.hidden = true;
    }
  }
}

/* 通用平移夹取：把图片摆正并缩放后算出屏幕尺寸，不让它整个被拖出视口 */
function clampItemPan(item, vp, margin = 30) {
  if (!vp) return;
  const { zoom, fit, natW, natH, o } = item;
  if (!natW || !natH) return;
  const sw = (swapped(o) ? natH : natW) * fit * zoom;
  const sh = (swapped(o) ? natW : natH) * fit * zoom;
  const box = vp.getBoundingClientRect();
  const mx = Math.max(0, (sw - box.width) / 2 + margin);
  const my = Math.max(0, (sh - box.height) / 2 + margin);
  item.panX = Math.max(-mx, Math.min(mx, item.panX));
  item.panY = Math.max(-my, Math.min(my, item.panY));
}

function clampSlotPan(item, slot) {
  clampItemPan(item, slot && slot.querySelector('.slot-viewport'));
}

/* 视口联动要作用到哪几个槽位。
   关键：源槽位自己解锁时只动它自己 —— 「解锁单图微调」的语义是把这张从联动里摘出来，
   而不是拿它去推别人。写成无条件收集 locked 槽位的话，解锁后滚轮会动所有别的图，
   唯独手底下这张纹丝不动，正好反了。纯函数，便于单测。 */
function syncTargets(items, idx, syncOn) {
  const src = items && items[idx];
  if (!src) return [];
  if (!syncOn || !src.locked) return [idx];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i] && items[i].locked) out.push(i);
  }
  return out;
}

/* 把光标锚点归一化成「相对视口中心的比例」。
   各槽位视口大小可能不同（3 屏布局主图更大），按比例映射才能让联动的几张
   缩放时锚住同一个相对位置，否则源图绕光标、其余绕中心，滚两下焦点就散了。 */
function slotAnchor(idx, cx, cy) {
  if (cx == null || cy == null) return null;
  const slot = compareSlotEl(idx);
  const vp = slot && slot.querySelector('.slot-viewport');
  if (!vp) return null;
  const b = vp.getBoundingClientRect();
  if (!b.width || !b.height) return null;
  return { fx: (cx - (b.left + b.width / 2)) / b.width, fy: (cy - (b.top + b.height / 2)) / b.height };
}

function zoomSlot(idx, factor, cx, cy) {
  const anchor = slotAnchor(idx, cx, cy);

  for (const t of syncTargets(S.compare.items, idx, S.compare.syncZoomPan)) {
    const it = S.compare.items[t];
    const slot = compareSlotEl(t);
    const vp = slot && slot.querySelector('.slot-viewport');
    if (!it || !vp) continue;

    const oldZ = it.zoom || 1;
    const newZ = Math.max(1, Math.min(24, oldZ * factor));
    it.zoom = newZ;

    if (newZ === 1) {
      it.panX = 0;
      it.panY = 0;
    } else if (anchor) {
      const box = vp.getBoundingClientRect();
      const ax = anchor.fx * box.width;
      const ay = anchor.fy * box.height;
      it.panX = ax - ((ax - it.panX) * newZ) / oldZ;
      it.panY = ay - ((ay - it.panY) * newZ) / oldZ;
    }

    clampSlotPan(it, slot);
    applySlotTransform(it, slot);
  }
}

function setSlotZoom(idx, targetZoom) {
  for (const t of syncTargets(S.compare.items, idx, S.compare.syncZoomPan)) {
    const it = S.compare.items[t];
    const slot = compareSlotEl(t);
    if (!it || !slot) continue;

    it.zoom = Math.max(1, Math.min(24, targetZoom));
    if (it.zoom === 1) {
      it.panX = 0;
      it.panY = 0;
    }
    clampSlotPan(it, slot);
    applySlotTransform(it, slot);
  }
}

function panSlot(idx, dx, dy) {
  for (const t of syncTargets(S.compare.items, idx, S.compare.syncZoomPan)) {
    const it = S.compare.items[t];
    const slot = compareSlotEl(t);
    if (!it || !slot || it.zoom <= 1) continue;

    slot.classList.add('panning');
    it.panX += dx;
    it.panY += dy;
    clampSlotPan(it, slot);
    applySlotTransform(it, slot);
  }
}

/* 1:1 焦点对齐。zoom 是各自 fit 之上的倍率，而 fit 按各自像素尺寸算 ——
   所以要真的「都是 100%」，必须每张各自取 1/fit，不能共用一个 zoom 值。 */
function sync100() {
  if (S.compare.mode === 'split') {
    const allZoomed = S.compare.items.every((it) => it.zoom > 1);
    for (let i = 0; i < S.compare.items.length; i++) {
      const it = S.compare.items[i];
      const slot = compareSlotEl(i);
      if (!slot) continue;
      const img = slot.querySelector('img');
      if (img) img.classList.add('smooth');
      it.zoom = allZoomed ? 1 : 1 / Math.max(0.01, it.fit);
      if (it.zoom === 1) {
        it.panX = 0;
        it.panY = 0;
      }
      clampSlotPan(it, slot);
      applySlotTransform(it, slot);
      if (img) setTimeout(() => img.classList.remove('smooth'), 200);
    }
    toast(allZoomed ? '已重置为适应屏幕' : '已全部 100% (1:1) 焦点对齐放大');
    return;
  }

  // 卷帘 / 闪烁：两张共用同一个 zoom 和同一组 pan，一起切。
  // 1:1 的基准取「当前实际显示的那张」—— 闪烁模式下 A/B 的 fit 是各自算的
  const base = pairFitBase();
  if (!base) return;
  const back = base.zoom > 1;
  const z = back ? 1 : 1 / Math.max(0.01, base.fit || 1);
  for (const it of [S.compare.items[0], S.compare.items[1]]) {
    if (!it) continue;
    it.zoom = z;
    if (back) {
      it.panX = 0;
      it.panY = 0;
    }
  }
  if (S.compare.mode === 'curtain') applyCurtainTransform();
  else applyBlinkTransform();
  toast(back ? '已重置为适应屏幕' : '已 100% (1:1) 焦点对齐放大');
}

function resetCompareFit() {
  for (let i = 0; i < S.compare.items.length; i++) {
    const it = S.compare.items[i];
    it.zoom = 1;
    it.panX = 0;
    it.panY = 0;
    const slot = compareSlotEl(i);
    if (slot) applySlotTransform(it, slot);
  }
  if (S.compare.mode === 'curtain') applyCurtainTransform();
  else if (S.compare.mode === 'blink') applyBlinkTransform();
  toast('已全部重置为适应屏幕');
}

/* 窗口尺寸变化后重新计算 fit —— 三种模式的 layout 都只在 img.onload 里跑过一次 */
function relayoutCompare() {
  if (S.mode !== 'compare') return;
  if (S.compare.mode === 'split') {
    for (let i = 0; i < S.compare.items.length; i++) {
      const slot = compareSlotEl(i);
      if (slot) layoutSlot(S.compare.items[i], slot);
    }
  } else if (S.compare.mode === 'curtain') {
    layoutCurtainImages();
  } else {
    layoutBlinkImage();
  }
}

/* ---------- 卷帘对比渲染 ---------- */
function renderCurtainCompare() {
  if (S.compare.items.length < 2) {
    toast('卷帘对比需要至少 2 张照片', { err: true });
    S.compare.mode = 'split';
    renderCompare();
    return;
  }
  const itemA = S.compare.items[0];
  const itemB = S.compare.items[1];

  $('#curtain-badge-a').textContent = `A · ${itemA.name}`;
  $('#curtain-badge-b').textContent = `B · ${itemB.name}`;

  const imgA = $('#curtain-img-a');
  const imgB = $('#curtain-img-b');
  const box = $('#curtain-box');
  const divider = $('#curtain-divider');

  box.style.setProperty('--split-x', `${Math.round(S.compare.curtainSplit * 100)}%`);

  loadFull(itemA.primary).then((recA) => {
    if (recA && !recA.error) {
      itemA.o = recA.o || 1;
      itemA.srcW = recA.w || 0;
      itemA.srcH = recA.h || 0;
      imgA.src = recA.url;
      imgA.onload = () => layoutCurtainImages();
    }
  });

  loadFull(itemB.primary).then((recB) => {
    if (recB && !recB.error) {
      itemB.o = recB.o || 1;
      itemB.srcW = recB.w || 0;
      itemB.srcH = recB.h || 0;
      imgB.src = recB.url;
      imgB.onload = () => layoutCurtainImages();
    }
  });

  // 卷帘分割线拖动
  let draggingDivider = false;
  divider.onpointerdown = (e) => {
    draggingDivider = true;
    divider.setPointerCapture(e.pointerId);
  };
  divider.onpointermove = (e) => {
    if (!draggingDivider) return;
    const rect = box.getBoundingClientRect();
    const pct = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    S.compare.curtainSplit = pct;
    box.style.setProperty('--split-x', `${(pct * 100).toFixed(2)}%`);
  };
  divider.onpointerup = divider.onpointercancel = () => (draggingDivider = false);

  // 卷帘缩放与平移
  box.onwheel = (e) => {
    e.preventDefault();
    setPairZoom(box, (itemA.zoom || 1) * Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
    applyCurtainTransform();
  };

  let dragBox = null;
  box.onpointerdown = (e) => {
    if (e.target.closest('#curtain-divider')) return;
    dragBox = { x: e.clientX, y: e.clientY };
    box.classList.add('panning');
    box.setPointerCapture(e.pointerId);
  };
  box.onpointermove = (e) => {
    if (!dragBox || itemA.zoom <= 1) return;
    const dx = e.clientX - dragBox.x;
    const dy = e.clientY - dragBox.y;
    dragBox.x = e.clientX;
    dragBox.y = e.clientY;
    itemA.panX += dx;
    itemA.panY += dy;
    clampItemPan(itemA, box);
    itemB.panX = itemA.panX;
    itemB.panY = itemA.panY;
    applyCurtainTransform();
  };
  box.onpointerup = box.onpointercancel = () => {
    dragBox = null;
    box.classList.remove('panning');
  };
}

function layoutCurtainImages() {
  const box = $('#curtain-box');
  const imgA = $('#curtain-img-a');
  const imgB = $('#curtain-img-b');
  const itemA = S.compare.items[0];
  const itemB = S.compare.items[1];
  if (!itemA || !itemB || !box) return;

  const rect = box.getBoundingClientRect();
  const nw = itemA.srcW || imgA.naturalWidth || 1000;
  const nh = itemA.srcH || imgA.naturalHeight || 800;
  const sw = swapped(itemA.o) ? nh : nw;
  const sh = swapped(itemA.o) ? nw : nh;

  const fit = Math.min((rect.width - 24) / sw, (rect.height - 24) / sh);
  itemA.fit = fit > 0 ? fit : 0.01;
  itemB.fit = itemA.fit;
  // clampItemPan 要靠 natW/natH 算屏幕尺寸，卷帘这边也得填上
  itemA.natW = nw;
  itemA.natH = nh;
  itemB.natW = nw;
  itemB.natH = nh;

  imgA.style.width = nw * itemA.fit + 'px';
  imgA.style.height = nh * itemA.fit + 'px';
  imgB.style.width = nw * itemA.fit + 'px';
  imgB.style.height = nh * itemA.fit + 'px';

  clampItemPan(itemA, box);
  itemB.panX = itemA.panX;
  itemB.panY = itemA.panY;
  applyCurtainTransform();
}

function applyCurtainTransform() {
  const imgA = $('#curtain-img-a');
  const imgB = $('#curtain-img-b');
  const itemA = S.compare.items[0];
  const itemB = S.compare.items[1];
  if (!itemA || !itemB) return;

  const mirA = mirrored(itemA.o) ? ' scaleX(-1)' : '';
  const mirB = mirrored(itemB.o) ? ' scaleX(-1)' : '';

  imgA.style.transform = `translate(-50%,-50%) translate(${itemA.panX}px,${itemA.panY}px) scale(${itemA.zoom}) rotate(${rotDeg(itemA.o)}deg)${mirA}`;
  imgB.style.transform = `translate(-50%,-50%) translate(${itemB.panX}px,${itemB.panY}px) scale(${itemB.zoom}) rotate(${rotDeg(itemB.o)}deg)${mirB}`;
}

/* 卷帘两张共用一个 fit（都按 A 算）；闪烁是各自 fit，基准取当前显示的那张 */
const pairFitBase = () =>
  (S.compare.mode === 'blink' ? S.compare.items[S.compare.blinkIndex] : null) || S.compare.items[0];

/* 卷帘 / 闪烁：两张图共用一个容器、一组 zoom 与 pan，缩放锚到光标。
   A 是基准，B 无条件跟随，保证两张始终严格重合 —— 否则重叠对比就没意义了。 */
function setPairZoom(boxEl, z, cx, cy) {
  const a = S.compare.items[0];
  const b = S.compare.items[1];
  if (!a || !boxEl) return;

  const r = boxEl.getBoundingClientRect();
  const ax = cx == null ? 0 : cx - (r.left + r.width / 2);
  const ay = cy == null ? 0 : cy - (r.top + r.height / 2);
  const oldZ = a.zoom || 1;
  const nz = Math.max(1, Math.min(24, z));

  a.zoom = nz;
  if (nz === 1) {
    a.panX = 0;
    a.panY = 0;
  } else {
    a.panX = ax - ((ax - a.panX) * nz) / oldZ;
    a.panY = ay - ((ay - a.panY) * nz) / oldZ;
    clampItemPan(a, boxEl);
  }
  if (b) {
    b.zoom = a.zoom;
    b.panX = a.panX;
    b.panY = a.panY;
  }
}

function setPairPan(boxEl, dx, dy) {
  const a = S.compare.items[0];
  const b = S.compare.items[1];
  if (!a || (a.zoom || 1) <= 1) return;
  a.panX += dx;
  a.panY += dy;
  clampItemPan(a, boxEl);
  if (b) {
    b.panX = a.panX;
    b.panY = a.panY;
  }
}

/* ---------- A/B 闪烁对比渲染 ---------- */
function renderBlinkCompare() {
  if (S.compare.items.length < 2) {
    toast('A/B 对比需要至少 2 张照片', { err: true });
    S.compare.mode = 'split';
    renderCompare();
    return;
  }
  const itemA = S.compare.items[0];
  const itemB = S.compare.items[1];
  const curItem = S.compare.blinkIndex === 0 ? itemA : itemB;

  $('#blink-tag-a').classList.toggle('active', S.compare.blinkIndex === 0);
  $('#blink-tag-b').classList.toggle('active', S.compare.blinkIndex === 1);
  $('#blink-tag-a').textContent = `A · ${itemA.name}`;
  $('#blink-tag-b').textContent = `B · ${itemB.name}`;

  const img = $('#blink-img');

  // 另一张先预热进 fullCache，否则第一次按 Tab 要等一趟 IPC，谈不上「毫秒级交替」
  const other = S.compare.blinkIndex === 0 ? itemB : itemA;
  if (other && !fullCache.has(other.primary)) loadFull(other.primary);

  loadFull(curItem.primary).then((rec) => {
    if (rec && !rec.error) {
      curItem.o = rec.o || 1;
      curItem.srcW = rec.w || 0;
      curItem.srcH = rec.h || 0;
      img.onload = () => layoutBlinkImage();
      img.src = rec.url;
      if (img.complete && img.naturalWidth) layoutBlinkImage();
    }
  });

  $('#blink-tag-a').onclick = () => {
    S.compare.blinkIndex = 0;
    renderBlinkCompare();
  };
  $('#blink-tag-b').onclick = () => {
    S.compare.blinkIndex = 1;
    renderBlinkCompare();
  };
}

function applyBlinkTransform() {
  const img = $('#blink-img');
  const item = S.compare.items[S.compare.blinkIndex];
  if (!img || !item) return;
  const mir = mirrored(item.o) ? ' scaleX(-1)' : '';
  img.style.transform = `translate(-50%,-50%) translate(${item.panX}px,${item.panY}px) scale(${item.zoom}) rotate(${rotDeg(item.o)}deg)${mir}`;
}

function layoutBlinkImage() {
  const box = $('#blink-box');
  const img = $('#blink-img');
  const item = S.compare.items[S.compare.blinkIndex];
  if (!item || !box || !img) return;

  const rect = box.getBoundingClientRect();
  const nw = item.srcW || img.naturalWidth || 1000;
  const nh = item.srcH || img.naturalHeight || 800;
  const sw = swapped(item.o) ? nh : nw;
  const sh = swapped(item.o) ? nw : nh;

  const fit = Math.min((rect.width - 24) / sw, (rect.height - 24) / sh);
  item.fit = fit > 0 ? fit : 0.01;
  item.natW = nw;
  item.natH = nh;
  img.style.width = nw * item.fit + 'px';
  img.style.height = nh * item.fit + 'px';

  clampItemPan(item, box);
  applyBlinkTransform();
}

/* A/B 闪烁的用途就是揪微跑焦和眨眼 —— 放不到 100% 等于废掉，所以这里要有缩放和平移。
   绑一次即可：renderBlinkCompare 每按一次 Tab 都会跑，在里面绑会把进行中的拖拽丢掉。 */
function initBlinkInteractions() {
  const box = $('#blink-box');
  if (!box || !box.addEventListener) return;

  box.addEventListener(
    'wheel',
    (e) => {
      if (S.mode !== 'compare' || S.compare.mode !== 'blink') return;
      e.preventDefault();
      const a = S.compare.items[0];
      if (!a) return;
      setPairZoom(box, (a.zoom || 1) * Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
      applyBlinkTransform();
    },
    { passive: false }
  );

  let drag = null;
  const end = () => {
    drag = null;
    box.classList.remove('panning');
  };

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.blink-indicator')) return;
    drag = { x: e.clientX, y: e.clientY, moved: false };
    box.classList.add('panning');
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    setPairPan(box, dx, dy);
    applyBlinkTransform();
  });
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);

  box.addEventListener('dblclick', () => {
    if (S.mode !== 'compare' || S.compare.mode !== 'blink') return;
    const base = pairFitBase();
    if (!base) return;
    setPairZoom(box, (base.zoom || 1) === 1 ? 1 / Math.max(0.01, base.fit || 1) : 1);
    applyBlinkTransform();
  });
}

function toggleBlink() {
  if (S.compare.mode !== 'blink') {
    S.compare.mode = 'blink';
    renderCompare();
    return;
  }
  S.compare.blinkIndex = S.compare.blinkIndex === 0 ? 1 : 0;
  renderBlinkCompare();
}

/* ---------- 底部对比胶片条 ---------- */
/* 和 #filmstrip 一样走懒加载：直接对整本相册调 getThumb 的话，
   2000 张的文件夹一进对比就会把 worker 池塞满，正在加载的几张大图反而被拖死。 */
const cmpStripObserver = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const it = en.target;
      cmpStripObserver.unobserve(it);
      const p = it.dataset.primary;
      if (!p) continue;
      getThumb(p, () => !it.isConnected).then((u) => {
        if (!u || !it.isConnected) return;
        const img = it.querySelector('img');
        if (!img) return;
        img.src = u;
        img.onload = () => img.classList.add('on');
      });
    }
  },
  { root: $('#compare-filmstrip'), rootMargin: '300px' }
);

function buildCompareFilmstrip() {
  const stripEl = $('#compare-filmstrip');
  stripEl.innerHTML = '';

  const list = S.view.length ? S.view : S.compare.items;
  list.forEach((g) => {
    const it = el('div', 'cmp-fs-item');
    it.dataset.primary = g.primary;

    const inCmpIdx = S.compare.items.findIndex((item) => item.primary === g.primary);
    if (inCmpIdx >= 0) {
      it.classList.add('in-compare');
      const badge = el('div', 'cmp-fs-badge');
      badge.textContent = inCmpIdx + 1;
      it.appendChild(badge);
    }
    if (inCmpIdx === S.compare.curSlot) it.classList.add('cur-slot');

    const img = el('img');
    it.appendChild(img);

    it.onclick = () => {
      // 索引必须点击时现算：加/减槽位之后闭包里捕获的那个早就过期了
      const cur = S.compare.items.findIndex((item) => item.primary === g.primary);
      if (cur >= 0) {
        S.compare.curSlot = cur;
        syncSlotChrome();
        return;
      }
      if (S.compare.items.length < 6) {
        S.compare.items.push(makeCompareItem(g));
        S.compare.curSlot = S.compare.items.length - 1;
      } else {
        S.compare.items[S.compare.curSlot] = makeCompareItem(g);
      }
      autoCompareLayout();
      renderCompare();
      buildCompareFilmstrip();
    };

    stripEl.appendChild(it);
    if (cmpStripObserver.observe) cmpStripObserver.observe(it);
  });
}

function syncCompareFilmstrip() {
  const stripEl = $('#compare-filmstrip');
  for (const it of stripEl.children) {
    const p = it.dataset.primary;
    const inCmpIdx = S.compare.items.findIndex((item) => item.primary === p);
    it.classList.toggle('in-compare', inCmpIdx >= 0);
    it.classList.toggle('cur-slot', inCmpIdx === S.compare.curSlot);
    const badge = it.querySelector('.cmp-fs-badge');
    if (inCmpIdx >= 0) {
      if (!badge) {
        const b = el('div', 'cmp-fs-badge');
        b.textContent = inCmpIdx + 1;
        it.appendChild(b);
      } else {
        badge.textContent = inCmpIdx + 1;
      }
    } else if (badge) {
      badge.remove();
    }
  }
}

/* ---------- 槽位操作 ---------- */
function toggleSlotFav(idx) {
  const item = S.compare.items[idx];
  if (!item) return;
  // 外部拖进来的照片不属于当前相册，saveSession 靠 S.root + S.all 落盘，收藏无处可写 ——
  // 与其弹一句骗人的「已收藏」，不如直说
  const g = S.all.find((x) => x.primary === item.primary || x.id === item.id);
  if (!g) {
    toast(`「${item.name}」不在当前相册中，收藏无法保存`, { err: true });
    return;
  }
  if (g.state === 'del') {
    toast('这张已经在回收站里了');
    return;
  }

  if (g.state === 'fav') {
    g.state = 'none';
    S.undo.push({ kind: 'unfav', g });
    toast(`已取消收藏 · ${item.name}`);
  } else {
    g.state = 'fav';
    S.undo.push({ kind: 'fav', g });
    toast(`★ 已收藏 · ${item.name}`);
  }
  item.state = g.state;

  saveSession();
  syncSlotChrome();
  updateCounts();
}

function pickCompareWinner(idx) {
  const item = S.compare.items[idx];
  if (!item) return;
  // 必须先把 curSlot 指到胜出者：closeCompare 是按 curSlot 回定位 S.cur 的，
  // 不然在槽位 0 激活时点槽位 2 的奖杯，最后打开的会是槽位 0 那张
  S.compare.curSlot = idx;
  toast(`👑 胜出裁决：已选择「${item.name}」`);
  if (item.state !== 'fav') toggleSlotFav(idx);
  // 胜出者在相册里就直接进大图细看，否则按原来的视图退
  if (S.view.some((g) => g.primary === item.primary || g.id === item.id)) S.compare.prevMode = 'loupe';
  closeCompare(); // 内部已经会回 loupe / grid，外面不要再调一次
}

function removeFromCompare(idx) {
  if (S.compare.items.length <= 1) {
    toast('至少保留 1 张对比照片');
    return;
  }
  const removed = S.compare.items.splice(idx, 1)[0];
  S.compare.curSlot = Math.max(0, Math.min(S.compare.curSlot, S.compare.items.length - 1));
  S.compare.layout = canonicalLayout(S.compare.items.length);

  renderCompare();
  buildCompareFilmstrip();
  toast(`已移出对比 · ${removed.name}`);
}

function replaceCompareSlot(idx, newPath) {
  S.compare.items[idx] = makeCompareItem(newPath);
  S.compare.curSlot = idx;
  renderCompare();
  buildCompareFilmstrip();
  toast(`槽位 ${idx + 1} 已替换为 ${newPath.split(/[\\/]/).pop()}`);
}

function addSlotFromAlbum() {
  if (S.compare.items.length >= 6) {
    toast('最多支持同时对比 6 张照片');
    return;
  }
  // 从未在对比池中的相册照片中追加一张
  const nextItem = S.view.find((g) => !S.compare.items.some((it) => it.primary === g.primary));
  if (nextItem) {
    S.compare.items.push(makeCompareItem(nextItem));
    S.compare.curSlot = S.compare.items.length - 1;
    autoCompareLayout();
    renderCompare();
    buildCompareFilmstrip();
    toast(`已添加对比照片 · ${nextItem.name}`);
  } else {
    toast('可通过底部胶片条或从文件夹直接拖入新照片添加对比');
  }
}

/* 把一张照片塞进对比池：没满就追加，满了就替换当前槽位 */
function pushCompareItem(gOrPath) {
  if (S.compare.items.length < 6) {
    S.compare.items.push(makeCompareItem(gOrPath));
    S.compare.curSlot = S.compare.items.length - 1;
  } else {
    S.compare.items[S.compare.curSlot] = makeCompareItem(gOrPath);
  }
  autoCompareLayout();
}

/* ============ 大图 ============ */
const stage = $('#stage');
const loupeImg = $('#loupe-img');

async function loadLoupe() {
  const g = S.view[S.cur];
  if (!g) return;
  const token = ++S.loupe.token;

  updateCounts();
  syncFilmstrip();
  $('#loupe-error').hidden = true;
  renderStageBadges(g);

  // 命中缓存（预取过或看过）→ 直接上高清图，没有黑屏也没有模糊过渡
  const cached = fullCache.get(g.primary);
  if (cached && !cached.error) {
    $('#loupe-loading').hidden = true;
    applyFull(g, cached, token);
    schedulePrefetch();
    return;
  }

  $('#loupe-loading').hidden = false;
  renderInfo(g, null);

  // 没缓存：先用缩略图垫一下，避免黑屏（缩略图请求插队）
  const th = urlCache.get(g.primary);
  if (th) setLoupeImage(th, 1, true);
  else
    getThumb(g.primary, () => token !== S.loupe.token, true).then((u) => {
      if (u && token === S.loupe.token && !fullCache.has(g.primary)) setLoupeImage(u, 1, true);
    });

  const rec = await loadFull(g.primary);
  if (token !== S.loupe.token) return;
  $('#loupe-loading').hidden = true;

  if (rec.error) {
    $('#loupe-error').textContent = rec.error;
    $('#loupe-error').hidden = false;
    return;
  }
  applyFull(g, rec, token);
  schedulePrefetch();
}

function applyFull(g, rec, token) {
  g.meta = { orientation: rec.o, width: rec.w, height: rec.h, exif: rec.exif, fileSize: rec.fileSize };
  setLoupeImage(rec.url, rec.o, false, rec.w, rec.h);
  renderInfo(g, { ok: true, exif: rec.exif, width: rec.w, height: rec.h });
  if (S.settings.showHistogram) drawHistogramFor(rec, token);
  else $('#histogram').getContext('2d').clearRect(0, 0, 4000, 4000);
}

async function drawHistogramFor(rec, token) {
  if (rec.hist) return drawHistogram(rec.hist);
  $('#histogram').getContext('2d').clearRect(0, 0, 4000, 4000);
  const ab = await rec.blob.arrayBuffer();
  const h = await workerCall({ type: 'hist', buf: ab });
  if (!h.ok) return;
  rec.hist = h.hist;
  if (token === S.loupe.token) drawHistogram(h.hist);
}

function setLoupeImage(url, o, isPlaceholder, srcW, srcH) {
  S.loupe.o = isPlaceholder ? 1 : o || 1;
  // 主进程从 JPEG SOF 解出来的真实存储尺寸。不能用 img.naturalWidth：
  // 开了 image-orientation:none 之后渲染不转向，但 naturalWidth 报的仍是转向后的值。
  S.loupe.srcW = isPlaceholder ? 0 : srcW || 0;
  S.loupe.srcH = isPlaceholder ? 0 : srcH || 0;
  S.loupe.zoom = 1;
  S.loupe.panX = 0;
  S.loupe.panY = 0;
  $('#loupe').classList.remove('zoomed');
  $('#zoom-hint').hidden = true;
  loupeImg.classList.remove('smooth');
  loupeImg.onload = () => layoutLoupe();
  loupeImg.src = url;
  if (loupeImg.complete && loupeImg.naturalWidth) layoutLoupe();
}

function layoutLoupe() {
  const o = S.loupe.o;
  // 主进程给的是"解码之后"的尺寸，和 img.naturalWidth 一致；拿不到时直接用 natural
  let nw = S.loupe.srcW || loupeImg.naturalWidth;
  let nh = S.loupe.srcH || loupeImg.naturalHeight;
  if (!nw || !nh) return;
  S.loupe.natW = nw;
  S.loupe.natH = nh;
  const sw = swapped(o) ? nh : nw; // 摆正后在屏幕上的宽
  const sh = swapped(o) ? nw : nh;
  const box = stage.getBoundingClientRect();
  const pad = 24;
  const fit = Math.min((box.width - pad) / sw, (box.height - pad) / sh);
  S.loupe.fit = fit;
  loupeImg.style.width = nw * fit + 'px';
  loupeImg.style.height = nh * fit + 'px';
  applyTransform();
}

function applyTransform() {
  const { zoom, panX, panY, o } = S.loupe;
  const mir = mirrored(o) ? ' scaleX(-1)' : '';
  loupeImg.style.transform =
    `translate(-50%,-50%) translate(${panX}px,${panY}px) scale(${zoom}) rotate(${rotDeg(o)}deg)${mir}`;
  const pct = Math.round(S.loupe.fit * zoom * 100);
  const hint = $('#zoom-hint');
  if (zoom !== 1) {
    hint.hidden = false;
    hint.textContent = pct + '%';
  } else hint.hidden = true;
  $('#loupe').classList.toggle('zoomed', zoom !== 1);
}

function setZoom(z, cx, cy) {
  const box = stage.getBoundingClientRect();
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  const px = cx == null ? centerX : cx;
  const py = cy == null ? centerY : cy;
  const old = S.loupe.zoom;
  const nz = Math.max(1, Math.min(24, z));
  const dx = px - centerX - S.loupe.panX;
  const dy = py - centerY - S.loupe.panY;
  S.loupe.panX = px - centerX - (dx * nz) / old;
  S.loupe.panY = py - centerY - (dy * nz) / old;
  S.loupe.zoom = nz;
  if (nz === 1) {
    S.loupe.panX = 0;
    S.loupe.panY = 0;
  }
  clampPan();
  applyTransform();
}

function clampPan() {
  const { zoom, fit, natW, natH, o } = S.loupe;
  const sw = (swapped(o) ? natH : natW) * fit * zoom;
  const sh = (swapped(o) ? natW : natH) * fit * zoom;
  const box = stage.getBoundingClientRect();
  const mx = Math.max(0, (sw - box.width) / 2 + 40);
  const my = Math.max(0, (sh - box.height) / 2 + 40);
  S.loupe.panX = Math.max(-mx, Math.min(mx, S.loupe.panX));
  S.loupe.panY = Math.max(-my, Math.min(my, S.loupe.panY));
}

function toggle100() {
  loupeImg.classList.add('smooth');
  setZoom(S.loupe.zoom === 1 ? 1 / S.loupe.fit : 1);
  setTimeout(() => loupeImg.classList.remove('smooth'), 200);
}

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0016);
  setZoom(S.loupe.zoom * factor, e.clientX, e.clientY);
}, { passive: false });

let drag = null;
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.nav-arrow')) return;
  drag = { x: e.clientX, y: e.clientY, px: S.loupe.panX, py: S.loupe.panY, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
  if (S.loupe.zoom === 1) return;
  $('#loupe').classList.add('panning');
  S.loupe.panX = drag.px + dx;
  S.loupe.panY = drag.py + dy;
  clampPan();
  applyTransform();
});
stage.addEventListener('pointerup', (e) => {
  $('#loupe').classList.remove('panning');
  if (drag && !drag.moved && !e.target.closest('.nav-arrow')) toggle100();
  drag = null;
});

function renderStageBadges(g) {
  const box = $('#stage-badges');
  box.innerHTML = '';
  const add = (txt, cls) => {
    const b = el('div', 'sbadge ' + (cls || ''));
    b.textContent = txt;
    box.appendChild(b);
  };
  if (g.state === 'fav') add('★ 已收藏', 'f');
  if (g.state === 'del') add('✕ 已删除（在回收站）', 'd');
  add(g.ext + (g.hasPair ? ' + JPG' : ''));
}

/* ============ 信息面板 ============ */
function renderInfo(g, r) {
  $('#info-name').textContent = g.name;
  const parts = [g.ext, fmtSize(g.size)];
  if (g.hasPair) parts.push(g.files.length + ' 个文件');
  $('#info-sub').textContent = parts.join(' · ');

  const list = $('#info-list');
  list.innerHTML = '';
  const ex = (r && r.exif) || (g.meta && g.meta.exif) || {};
  const rows = [
    ['相机', [ex.make, ex.model].filter(Boolean).join(' ').replace(/NIKON CORPORATION\s*/i, 'Nikon ')],
    ['镜头', ex.lens],
    ['光圈', ex.aperture],
    ['快门', ex.shutter],
    ['ISO', ex.iso],
    ['焦距', ex.focal ? ex.focal + (ex.focal35 && ex.focal35 !== ex.focal ? `（等效 ${ex.focal35}）` : '') : null],
    ['曝光补偿', ex.ev],
    ['拍摄时间', ex.date],
    ['尺寸', ex.pixelX ? (swapped(ex.orientation) ? `${ex.pixelY} × ${ex.pixelX}（竖幅）` : `${ex.pixelX} × ${ex.pixelY}`) : null],
  ];
  const longSide = ex.pixelX ? Math.max(ex.pixelX, ex.pixelY) : 0;
  if (r && r.ok && r.width && longSide && Math.max(r.width, r.height) < longSide * 0.9) {
    rows.push(['预览图', `${r.width} × ${r.height}（RAW 内嵌，非全尺寸）`]);
  }
  for (const [k, v] of rows) {
    if (!v) continue;
    const dt = el('dt');
    dt.textContent = k;
    const dd = el('dd');
    dd.textContent = v;
    list.append(dt, dd);
  }
  const dt = el('dt');
  dt.textContent = '位置';
  const dd = el('dd');
  dd.textContent = g.dir;
  list.append(dt, dd);
}

function drawHistogram(h) {
  const c = $('#histogram');
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = (c.width = c.clientWidth * devicePixelRatio);
  const H = (c.height = 84 * devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  let max = 0;
  for (let i = 1; i < 255; i++) max = Math.max(max, h.r[i], h.g[i], h.b[i]);
  if (!max) return;

  ctx.globalCompositeOperation = 'screen';
  const drawChannel = (arr, fillColor, strokeColor) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) {
      const y = H - Math.min(1, arr[i] / max) * (H - 4);
      ctx.lineTo((i / 255) * W, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    if (strokeColor) {
      ctx.beginPath();
      for (let i = 0; i < 256; i++) {
        const y = H - Math.min(1, arr[i] / max) * (H - 4);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo((i / 255) * W, y);
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1 * devicePixelRatio;
      ctx.stroke();
    }
  };

  drawChannel(h.r, 'rgba(239, 68, 68, 0.45)', 'rgba(248, 113, 113, 0.7)');
  drawChannel(h.g, 'rgba(34, 197, 94, 0.45)', 'rgba(74, 222, 128, 0.7)');
  drawChannel(h.b, 'rgba(56, 189, 248, 0.45)', 'rgba(125, 211, 252, 0.7)');
  ctx.globalCompositeOperation = 'source-over';
}

/* ============ 胶片条 ============ */
const strip = $('#filmstrip');
function buildFilmstrip() {
  strip.innerHTML = '';
  S.view.forEach((g, i) => {
    const it = el('div', 'fs-item');
    it.dataset.i = i;
    const img = el('img');
    it.appendChild(img);
    it.onclick = () => {
      S.cur = i;
      loadLoupe();
    };
    strip.appendChild(it);
  });
  syncFilmstrip();
  lazyStrip();
}

const stripObserver = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const it = en.target;
      stripObserver.unobserve(it);
      const g = S.view[+it.dataset.i];
      if (!g) continue;
      getThumb(g.primary, () => !it.isConnected).then((u) => {
        if (!u || !it.isConnected) return;
        const img = it.querySelector('img');
        img.src = u;
        img.onload = () => img.classList.add('on');
      });
    }
  },
  { root: strip, rootMargin: '300px' }
);

function lazyStrip() {
  for (const it of strip.children) stripObserver.observe(it);
}

function syncFilmstrip() {
  for (const it of strip.children) {
    const i = +it.dataset.i;
    const g = S.view[i];
    if (!g) continue;
    it.classList.toggle('cur', i === S.cur);
    it.classList.toggle('fav', g.state === 'fav');
    it.classList.toggle('del', g.state === 'del');
  }
  const cur = strip.children[S.cur];
  if (cur) {
    const l = cur.offsetLeft;
    const w = cur.offsetWidth;
    const sl = strip.scrollLeft;
    const sw = strip.clientWidth;
    if (l < sl + 40 || l + w > sl + sw - 40) strip.scrollTo({ left: l - sw / 2 + w / 2, behavior: 'smooth' });
  }
}

/* ============ 动作：收藏 / 删除 / 撤销 ============ */
let saveTimer = null;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!S.root) return;
    const favList = [];
    for (const g of S.all) {
      if (g.state === 'fav') favList.push(g.id);
    }
    // 写入相册根目录的 favorites.txt
    window.pv.saveFavorites(S.root, favList);
    // 记录全局 session
    window.pv.setSession(S.root, { favorites: favList, cursor: S.cur });
  }, 200);
}

function afterAction(g, advance) {
  const stillIn = S.view.indexOf(g);
  if (stillIn < 0) {
    // 当前筛选下这张已经消失，索引不动就自动落到下一张
    applyFilter(S.filter);
    S.cur = Math.min(S.cur, Math.max(0, S.view.length - 1));
  } else if (advance && S.cur < S.view.length - 1) {
    S.cur++;
  }
  updateCounts();
  refreshCards();
  if (S.mode === 'grid') {
    renderGrid(true);
    scrollCurrentIntoView();
  } else {
    if (!S.view.length) return showGrid();
    buildFilmstrip();
    loadLoupe();
  }
  saveSession();
}

async function actFavorite() {
  const g = S.view[S.cur];
  if (!g || g.state === 'del') return;

  if (g.state === 'fav') {
    g.state = 'none';
    S.undo.push({ kind: 'unfav', g });
    toast(`已取消收藏 · ${g.name}`);
    afterAction(g, false);
    return;
  }

  g.state = 'fav';
  S.undo.push({ kind: 'fav', g });
  toast(`★ 已收藏 · ${g.name}`);
  afterAction(g, S.settings.autoAdvanceOnFavorite);
}

async function actDelete() {
  const g = S.view[S.cur];
  if (!g) return;
  if (g.state === 'del') return toast('这张已经在回收站里了');
  if (S.settings.confirmDelete && !confirm(`把「${g.name}」移到回收站？`)) return;

  const r = await window.pv.trash(g.files);
  if (!r.ok && !r.done.length) return toast('删除失败：' + (r.errors[0] && r.errors[0].error), { err: true });

  const wasFav = g.state === 'fav';
  g.state = 'del';
  S.undo.push({ kind: 'del', g, files: r.done, wasFav });
  toast(`已移到回收站 · ${g.name}`, { undo: true });
  afterAction(g, S.settings.autoAdvanceOnDelete);
}

async function actUndo() {
  const a = S.undo.pop();
  if (!a) return toast('没有可以撤销的操作');
  const g = a.g;

  if (a.kind === 'del') {
    toast('正在从回收站还原…');
    const r = await window.pv.restore(a.files);
    if (!r.ok) {
      S.undo.push(a);
      toast('自动还原失败，请到 Windows 回收站手动还原', { err: true });
      return;
    }
    g.state = a.wasFav ? 'fav' : 'none';
    toast(`已还原 ${g.name}`);
  } else if (a.kind === 'fav') {
    g.state = 'none';
    toast(`已取消收藏 ${g.name}`);
  } else if (a.kind === 'unfav') {
    g.state = 'fav';
    toast(`已恢复收藏 ${g.name}`);
  }

  applyFilter(S.filter);
  const i = S.view.indexOf(g);
  if (i >= 0) S.cur = i;
  updateCounts();
  refreshCards();
  if (S.mode === 'grid') {
    renderGrid(true);
    scrollCurrentIntoView();
  } else {
    buildFilmstrip();
    loadLoupe();
  }
  saveSession();
}

/* ============ 导航 ============ */
function go(delta) {
  if (!S.view.length) return;
  const n = Math.max(0, Math.min(S.view.length - 1, S.cur + delta));
  if (n === S.cur) return;
  S.cur = n;
  if (S.mode === 'loupe') loadLoupe();
  else {
    refreshCards();
    scrollCurrentIntoView();
    renderGrid(false);
    for (const [j, e] of mounted) e.classList.toggle('sel', j === S.cur);
    updateCounts();
    schedulePrefetch();
  }
  saveSession();
}
function goTo(i) {
  S.cur = Math.max(0, Math.min(S.view.length - 1, i));
  if (S.mode === 'loupe') loadLoupe();
  else {
    refreshCards();
    scrollCurrentIntoView();
    renderGrid(false);
    updateCounts();
    schedulePrefetch();
  }
}

/* ============ 提示条 ============ */
function toast(msg, opts = {}) {
  const wrap = $('#toast-wrap');
  const t = el('div', 'toast' + (opts.err ? ' err' : ''));
  const s = el('span');
  s.textContent = msg;
  t.appendChild(s);
  if (opts.undo) {
    const b = el('button', 't-undo');
    b.textContent = '撤销';
    b.onclick = () => {
      remove();
      actUndo();
    };
    t.appendChild(b);
  }
  wrap.appendChild(t);
  const remove = () => {
    if (!t.isConnected) return;
    t.classList.add('fade');
    setTimeout(() => t.remove(), 260);
  };
  setTimeout(remove, opts.err ? 6000 : 3200);
  while (wrap.children.length > 3) wrap.firstChild.remove();
}
window.toast = toast;

/* ============ 主题管理 ============ */
function getEffectiveTheme(pref) {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(themeSetting) {
  const effective = getEffectiveTheme(themeSetting);
  document.documentElement.setAttribute('data-theme', effective);
  if (window.pv && window.pv.setNativeTheme) {
    window.pv.setNativeTheme(effective === 'dark');
  }
  const btnTheme = $('#btn-theme');
  if (btnTheme) {
    btnTheme.title = effective === 'dark' ? '切换到亮色主题 (T)' : '切换到暗色主题 (T)';
  }
  // 如果在大图视图且直方图打开，重绘直方图
  if (S.mode === 'loupe' && S.settings.showHistogram) {
    const cur = S.view[S.cur];
    if (cur) {
      const rec = fullCache.get(cur.primary);
      if (rec && rec.hist) drawHistogram(rec.hist);
    }
  }
}

async function toggleTheme() {
  const curEffective = getEffectiveTheme(S.settings.theme || 'dark');
  const nextTheme = curEffective === 'dark' ? 'light' : 'dark';
  S.settings.theme = nextTheme;
  applyTheme(nextTheme);
  await window.pv.setSettings({ theme: nextTheme });
  toast(nextTheme === 'light' ? '已切换至亮色主题 (Studio Light)' : '已切换至暗色主题 (Obsidian Dark)');
}

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (S.settings.theme === 'system') {
      applyTheme('system');
    }
  });
}

/* ============ 键盘 ============ */
document.addEventListener('keydown', (e) => {
  if (e.target && typeof e.target.matches === 'function' && e.target.matches('input, select, textarea')) return;
  const modalOpen = !$('#settings-modal').hidden || !$('#help-modal').hidden;
  if (modalOpen) {
    if (e.key === 'Escape') {
      $('#settings-modal').hidden = true;
      $('#help-modal').hidden = true;
    }
    return;
  }
  if (S.mode === 'empty') {
    if (e.key.toLowerCase() === 't') {
      e.preventDefault();
      return toggleTheme();
    }
    return;
  }

  // 对比模式专属快捷键
  if (S.mode === 'compare') {
    if (e.key === 'Escape') {
      e.preventDefault();
      return closeCompare();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      return toggleBlink();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      return removeFromCompare(S.compare.curSlot);
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const k = e.key.toLowerCase();
    switch (k) {
      case 'c':
        e.preventDefault();
        return closeCompare();
      case 's':
        e.preventDefault();
        S.compare.syncZoomPan = !S.compare.syncZoomPan;
        updateCompareDock();
        toast(S.compare.syncZoomPan ? '🔗 已开启全局视口同步联动' : '🔓 已关闭视口联动（各槽位独立控制）');
        return;
      case 'z':
        e.preventDefault();
        return sync100();
      case 'w':
        e.preventDefault();
        return pickCompareWinner(S.compare.curSlot);
      case 'f':
        e.preventDefault();
        return toggleSlotFav(S.compare.curSlot);
      case 'x':
      case 'd':
        e.preventDefault();
        return removeFromCompare(S.compare.curSlot);
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6': {
        // 必须包一层块作用域：switch 里裸放 const 是全 switch 共享的，
        // 以后谁加一条 fallthrough 就是 TDZ 报错
        const slotIdx = parseInt(k, 10) - 1;
        if (slotIdx >= 0 && slotIdx < S.compare.items.length) {
          e.preventDefault();
          S.compare.curSlot = slotIdx;
          syncSlotChrome();
        }
        return;
      }
      case 't':
        e.preventDefault();
        return toggleTheme();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return actUndo();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    return refreshFolder();
  }
  if (e.key === 'F5') {
    e.preventDefault();
    return refreshFolder();
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const k = e.key;
  switch (k) {
    case 'ArrowRight': e.preventDefault(); return go(1);
    case 'ArrowLeft': e.preventDefault(); return go(-1);
    case 'ArrowDown': e.preventDefault(); return go(S.mode === 'grid' ? layout.cols : 1);
    case 'ArrowUp': e.preventDefault(); return go(S.mode === 'grid' ? -layout.cols : -1);
    case 'PageDown': e.preventDefault(); return go(S.mode === 'grid' ? layout.cols * 3 : 10);
    case 'PageUp': e.preventDefault(); return go(S.mode === 'grid' ? -layout.cols * 3 : -10);
    case 'Home': e.preventDefault(); return goTo(0);
    case 'End': e.preventDefault(); return goTo(S.view.length - 1);
    case 'Enter': e.preventDefault(); return S.mode === 'grid' ? showLoupe() : showGrid();
    case ' ': e.preventDefault(); return S.mode === 'grid' ? showLoupe() : showGrid();
    case 'Escape': e.preventDefault(); return S.mode === 'loupe' ? showGrid() : null;
    case 'Delete': case 'Backspace': e.preventDefault(); return actDelete();
  }
  switch (k.toLowerCase()) {
    case 'c': e.preventDefault(); return openCompare();
    case 'f': e.preventDefault(); return actFavorite();
    case 'x': e.preventDefault(); return actDelete();
    case 'd': e.preventDefault(); return actDelete();
    case 'r': e.preventDefault(); return refreshFolder();
    case 'g': e.preventDefault(); return showGrid();
    case 't': e.preventDefault(); return toggleTheme();
    case 'z': e.preventDefault(); return S.mode === 'loupe' ? toggle100() : showLoupe();
    case 'i':
      e.preventDefault();
      S.settings.showInfo = !S.settings.showInfo;
      window.pv.setSettings({ showInfo: S.settings.showInfo });
      $('#loupe').classList.toggle('no-info', !S.settings.showInfo);
      if (S.mode === 'loupe') layoutLoupe();
      return;
    case '1': return applyFilter('all');
    case '2': return applyFilter('todo');
    case '3': return applyFilter('fav');
    case '4': return applyFilter('del');
  }
});

/* ============ 拖拽 ============ */
/* Tauri 开了 dragDropEnabled 之后 webview 的原生 HTML5 拖放被接管，
   桥接层把事件直接 dispatch 到 window（bubbles:false）—— 槽位上挂 drop 监听收不到任何东西，
   所以「拖到某个槽位精准替换」只能靠落点坐标 + elementFromPoint 判定。 */
function compareSlotAt(x, y) {
  if (S.mode !== 'compare' || S.compare.mode !== 'split') return null;
  if (x == null || y == null) return null;
  if (typeof document.elementFromPoint !== 'function') return null;
  const t = document.elementFromPoint(x, y);
  return (t && t.closest && t.closest('.compare-slot')) || null;
}

function markCompareDropTarget(slot) {
  for (const s of document.querySelectorAll('.compare-slot')) s.classList.toggle('drop-target', s === slot);
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth !== 1) return;
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  // 对比模式下不盖全屏蒙版：那层 backdrop blur 会把槽位高亮整个糊掉，
  // 看不见拖到了哪个槽位就谈不上「精准替换」
  if (S.mode !== 'compare') $('#drop-overlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  markCompareDropTarget(compareSlotAt(e.clientX, e.clientY));
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    markCompareDropTarget(null);
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const dropSlot = compareSlotAt(e.clientX, e.clientY);
  markCompareDropTarget(null);

  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;
  const paths = files.map((f) => window.pv.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;

  for (const p of paths) {
    if (await window.pv.isDirectory(p)) return openFolder(p);
  }

  // 单张落在某个槽位上 → 精准替换该槽位；多张则走下面的入池逻辑
  if (dropSlot && paths.length === 1) return replaceCompareSlot(+dropSlot.dataset.idx, paths[0]);

  // 已经在对比里 → 往对比池里加，而不是把整组换掉
  if (S.mode === 'compare') {
    const room = 6 - S.compare.items.length;
    if (room <= 0) {
      toast('对比池已满（最多 6 张），可把照片拖到某个槽位上替换');
      return;
    }
    const added = paths.slice(0, room);
    for (const p of added) pushCompareItem(p);
    renderCompare();
    buildCompareFilmstrip();
    toast(
      added.length < paths.length
        ? `已加入 ${added.length} 张，对比最多 6 张`
        : `已载入对比照片 · 共 ${S.compare.items.length} 张`
    );
    return;
  }

  // 拖入多张照片（2 张及以上）→ 直接进入细节对比工作台！
  if (paths.length >= 2) return openCompare(paths);

  // 单张照片且非对比模式 → 打开它所在的目录并定位
  const dir = paths[0].replace(/[\\/][^\\/]+$/, '');
  await openFolder(dir);
  const i = S.view.findIndex((g) => g.files.some((f) => f.toLowerCase() === paths[0].toLowerCase()));
  if (i >= 0) {
    S.cur = i;
    showLoupe();
  }
});

/* ============ 按钮 / 设置 ============ */
$('#btn-choose').onclick = async () => openFolder(await window.pv.openFolderDialog());
$('#btn-open').onclick = async () => openFolder(await window.pv.openFolderDialog());
$('#btn-refresh').onclick = refreshFolder;
$('#btn-grid').onclick = () => (S.mode === 'grid' ? showLoupe() : showGrid());
$('#btn-compare').onclick = toggleCompare;
$('#btn-theme').onclick = toggleTheme;
$('#btn-help').onclick = () => ($('#help-modal').hidden = false);
$('#btn-close-help').onclick = () => ($('#help-modal').hidden = true);
$('#act-fav').onclick = actFavorite;
$('#act-del').onclick = actDelete;
$('#act-undo').onclick = actUndo;
$('#nav-prev').onclick = () => go(-1);
$('#nav-next').onclick = () => go(1);
$('#btn-reveal').onclick = () => {
  const g = S.view[S.cur];
  if (g) window.pv.reveal(g.primary);
};
for (const b of document.querySelectorAll('#filters .chip')) b.onclick = () => applyFilter(b.dataset.filter);

/* 对比工作台顶栏浮岛按钮绑定 */
for (const pill of document.querySelectorAll('#cmp-mode-pills .cmp-pill')) {
  pill.onclick = () => {
    S.compare.mode = pill.dataset.cmpMode;
    renderCompare();
  };
}
for (const btn of document.querySelectorAll('#cmp-layout-btns .cmp-icon-btn')) {
  btn.onclick = () => {
    S.compare.layout = btn.dataset.cmpLayout;
    renderCompare();
  };
}
$('#btn-cmp-sync').onclick = () => {
  S.compare.syncZoomPan = !S.compare.syncZoomPan;
  updateCompareDock();
  toast(S.compare.syncZoomPan ? '🔗 视口同步联动已开启' : '🔓 视口联动已关闭（独立微调）');
};
$('#btn-cmp-100').onclick = sync100;
$('#btn-cmp-fit').onclick = resetCompareFit;
$('#btn-cmp-add').onclick = addSlotFromAlbum;
$('#btn-cmp-close').onclick = closeCompare;
initBlinkInteractions();

$('#zoom-grid').oninput = (e) => {
  S.settings.thumbSize = +e.target.value;
  if (S.mode === 'grid') renderGrid(true);
};
$('#zoom-grid').onchange = () => window.pv.setSettings({ thumbSize: S.settings.thumbSize });

$('#btn-settings').onclick = () => {
  $('#set-theme').value = S.settings.theme || 'dark';
  $('#set-favname').value = S.settings.favoritesFileName || 'favorites.txt';
  $('#set-group').checked = S.settings.groupRawJpeg;
  $('#set-recursive').checked = S.settings.recursive;
  $('#set-adv-fav').checked = S.settings.autoAdvanceOnFavorite;
  $('#set-adv-del').checked = S.settings.autoAdvanceOnDelete;
  $('#set-confirm').checked = S.settings.confirmDelete;
  $('#settings-modal').hidden = false;
};
$('#btn-close-settings').onclick = async () => {
  const newTheme = $('#set-theme').value;
  const themeChanged = S.settings.theme !== newTheme;
  const patch = {
    theme: newTheme,
    favoritesFileName: $('#set-favname').value.trim() || 'favorites.txt',
    groupRawJpeg: $('#set-group').checked,
    recursive: $('#set-recursive').checked,
    autoAdvanceOnFavorite: $('#set-adv-fav').checked,
    autoAdvanceOnDelete: $('#set-adv-del').checked,
    confirmDelete: $('#set-confirm').checked,
  };
  S.settings = await window.pv.setSettings(patch);
  if (themeChanged) applyTheme(S.settings.theme);
  $('#settings-modal').hidden = true;
};
$('#btn-clear-cache').onclick = async () => {
  await window.pv.clearCache();
  for (const [, u] of urlCache) URL.revokeObjectURL(u);
  urlCache.clear();
  toast('缩略图缓存已清空');
  if (S.mode === 'grid') renderGrid(true);
};
for (const m of ['#settings-modal', '#help-modal']) {
  $(m).onclick = (e) => {
    if (e.target === $(m)) $(m).hidden = true;
  };
}
for (const btn of document.querySelectorAll('.modal-close-btn')) {
  btn.onclick = (e) => {
    const m = e.target.closest('.modal');
    if (m) m.hidden = true;
  };
}

/* ============ 启动 ============ */
// 调试 / 自动化测试入口
window.__pv = {
  S,
  openFolder,
  refreshFolder,
  showGrid,
  showLoupe,
  openCompare,
  closeCompare,
  toggleCompare,
  renderCompare,
  relayoutCompare,
  syncTargets,
  canonicalLayout,
  pickCompareWinner,
  removeFromCompare,
  applyFilter,
  actFavorite,
  actDelete,
  actUndo,
  go,
  goTo,
  toggle100,
  toggleTheme,
  applyTheme,
  _int: { getThumb, urlCache, inflight, queue, pool, fullCache, loadFull, get running() { return running; } },
};

(async function init() {
  S.settings = await window.pv.getSettings();
  applyTheme(S.settings.theme || 'dark');
  $('#zoom-grid').value = S.settings.thumbSize;

  const recent = await window.pv.recent();
  const box = $('#recent');
  if (recent && recent.length) {
    const title = el('div', 'recent-item');
    title.style.color = 'var(--fg-3)';
    title.style.direction = 'ltr';
    title.textContent = '最近打开';
    box.appendChild(title);
    for (const r of recent.slice(0, 5)) {
      const it = el('button', 'recent-item');
      it.textContent = r;
      it.title = r;
      it.onclick = () => openFolder(r);
      box.appendChild(it);
    }
  }
})();

