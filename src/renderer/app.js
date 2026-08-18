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
  mode: 'empty', // empty | grid | loupe
  settings: {},
  session: { favorites: [], cursor: 0 },
  undo: [],
  loupe: { url: null, zoom: 1, fit: 1, panX: 0, panY: 0, o: 1, srcW: 0, srcH: 0, natW: 0, natH: 0, token: 0 },
};

const swapped = (o) => o >= 5 && o <= 8;
const mirrored = (o) => o === 2 || o === 4 || o === 5 || o === 7;
const rotDeg = (o) => (o === 3 || o === 4 ? 180 : o === 5 || o === 6 ? 90 : o === 7 || o === 8 ? 270 : 0);

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
   不用再走 IPC → 建 blob → 解码这条链路。 */
const FULL_MAX = 6;
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
        if (d && d.catch) d.catch(() => {});
      } catch {}
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
  S.cur = Math.min(S.session.cursor || 0, Math.max(0, S.all.length - 1));

  const shortRoot = root.length > 60 ? '…' + root.slice(-58) : root;
  $('#folder-name').innerHTML = `<b>${escapeHtml(root.split(/[\\/]/).pop())}</b> · ${escapeHtml(shortRoot)}`;

  applyFilter('all');
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
  $('#actionbar').hidden = false;
  $('#btn-grid').classList.add('on');
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
  $('#actionbar').hidden = false;
  $('#btn-grid').classList.remove('on');
  $('#loupe').classList.toggle('no-info', !S.settings.showInfo);
  buildFilmstrip();
  loadLoupe();
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
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1 && e.dataTransfer.types.includes('Files')) $('#drop-overlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const files = [...(e.dataTransfer.files || [])];
  if (!files.length) return;
  const paths = files.map((f) => window.pv.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  for (const p of paths) {
    if (await window.pv.isDirectory(p)) return openFolder(p);
  }
  // 拖进来的是文件 → 打开它所在的目录
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
window.__pv = { S, openFolder, refreshFolder, showGrid, showLoupe, applyFilter, actFavorite, actDelete, actUndo, go, goTo, toggle100, toggleTheme, applyTheme,
  _int: { getThumb, urlCache, inflight, queue, pool, fullCache, loadFull, get running() { return running; } } };

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
