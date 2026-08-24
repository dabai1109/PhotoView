'use strict';
/**
 * 会记账的假相册：一个内存文件系统 + 一份和 Rust 侧对齐的 favorite/unfavorite 实现。
 *
 * 收藏改成「真的搬文件」以后，前端每一步都得拿着后端返回的 {from,to} 去改自己
 * 记的路径。以前的测试桩是「把 from/to 无脑对调」，方向搞反也照样返回一个看着
 * 合理的结果，等于把 bug 一起糊过去了。这里的假文件系统严格照抄 src-tauri/src/fav.rs：
 *
 *   - 源文件不在 -> 直接报错
 *   - 目标名被占 -> 整批共用同一个 " (n)" 后缀（RAW+JPG 不能分家）
 *   - 待还原的文件已经在原位 -> 当成已还原，不做任何移动
 *
 * 最后那条是关键：方向写反的调用在真实后端里是「静默什么都没做」，
 * 只有桩也这么表现，测试才能抓住它。
 */

const RAW_EXTS = new Set(['nef', 'nrw', 'cr2', 'cr3', 'dng', 'arw', 'raf', 'orf', 'rw2', 'pef']);

const lower = (s) => s.toLowerCase();
const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const stemOf = (n) => (n.lastIndexOf('.') > 0 ? n.slice(0, n.lastIndexOf('.')) : n);
const extOf = (n) => (n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.') + 1) : '');

/** "a.jpg" + 1 -> "a (1).jpg" */
function decorate(name, n) {
  if (n === 0) return name;
  const ext = extOf(name);
  return `${stemOf(name)} (${n})${ext ? '.' + ext : ''}`;
}

function makeFakeAlbum(initial) {
  // lower(path) -> { path, content }
  const store = new Map();
  for (const [p, content] of Object.entries(initial)) {
    store.set(lower(p), { path: p, content });
  }

  const exists = (p) => store.has(lower(p));
  const list = () => [...store.values()].map((v) => v.path).sort();
  const contentOf = (p) => (store.get(lower(p)) || {}).content;

  function move(from, to) {
    const rec = store.get(lower(from));
    if (!rec) throw new Error(`假文件系统：${from} 不存在`);
    store.delete(lower(from));
    store.set(lower(to), { path: to, content: rec.content });
  }

  /** 整批共用一个防冲突后缀：全都不撞名的最小 n */
  function uniqueBatch(targetDir, names) {
    for (let n = 0; n < 10000; n++) {
      const cands = names.map((name) => `${targetDir}/${decorate(name, n)}`);
      if (cands.every((c) => !exists(c))) return cands;
    }
    throw new Error('假文件系统：找不到可用文件名');
  }

  /** 对齐 fav::favorite_files */
  async function favoriteFiles(root, files) {
    if (!files || !files.length) return [];
    for (const f of files) {
      if (!exists(f)) throw new Error(`文件不存在：${f}`);
    }
    const favDir = `${root}/收藏`;
    const out = new Array(files.length);
    const pending = [];
    files.forEach((f, i) => {
      if (lower(dirOf(f)) === lower(favDir)) out[i] = { from: f, to: f }; // 已经在收藏夹里
      else pending.push({ i, f });
    });
    const dests = uniqueBatch(favDir, pending.map((x) => nameOf(x.f)));
    pending.forEach((x, k) => {
      move(x.f, dests[k]);
      out[x.i] = { from: x.f, to: dests[k] };
    });
    return out;
  }

  /** 对齐 fav::unfavorite_files —— 把 {from,to} 这一步移动倒回去 */
  async function unfavoriteFiles(moves) {
    const out = new Array(moves.length);
    const pending = [];
    moves.forEach((m, i) => {
      if (m.from === m.to) {
        out[i] = { ...m };
        return;
      }
      if (!exists(m.to)) {
        if (exists(m.from)) {
          out[i] = { ...m }; // 已经在原位，什么都不做
          return;
        }
        throw new Error(`找不到待还原的收藏文件：${m.to}`);
      }
      pending.push({ i, m });
    });

    // 同一个目标目录的一批共用后缀，否则配对文件会在原目录里分家
    const byDir = new Map();
    for (const x of pending) {
      const d = dirOf(x.m.from);
      if (!byDir.has(lower(d))) byDir.set(lower(d), { dir: d, items: [] });
      byDir.get(lower(d)).items.push(x);
    }
    for (const { dir, items } of byDir.values()) {
      const dests = uniqueBatch(dir, items.map((x) => nameOf(x.m.from)));
      items.forEach((x, k) => {
        move(x.m.to, dests[k]);
        out[x.i] = { from: x.m.to, to: dests[k] };
      });
    }
    return out;
  }

  /** 对齐 scan::scan_folder：同目录同主名归一组，落在收藏夹里的就是已收藏 */
  function scan(root) {
    const favDir = `${root}/收藏`;
    const groups = new Map();
    for (const p of list()) {
      if (!lower(p).startsWith(lower(root) + '/')) continue;
      const key = lower(`${dirOf(p)}|${stemOf(nameOf(p))}`);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const out = [];
    for (const files of groups.values()) {
      files.sort();
      const primary = files.find((f) => RAW_EXTS.has(lower(extOf(nameOf(f))))) || files[0];
      const inFav = lower(dirOf(primary)).startsWith(lower(favDir));
      out.push({
        id: primary.slice(root.length + 1),
        dir: dirOf(primary),
        base: stemOf(nameOf(primary)),
        name: nameOf(primary),
        files: files.slice(),
        sizes: files.map(() => 1000),
        primary,
        ext: extOf(nameOf(primary)).toUpperCase(),
        isRaw: RAW_EXTS.has(lower(extOf(nameOf(primary)))),
        hasPair: files.length > 1,
        size: 1000 * files.length,
        mtime: 0,
        favored: inFav,
      });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      ok: true,
      root,
      favoritesFileName: 'favorites.txt',
      favoritesFolderName: '收藏',
      groups: out,
    };
  }

  return { exists, list, contentOf, favoriteFiles, unfavoriteFiles, scan };
}

/**
 * window.pv 桩。sessions 是一个共享对象，setSession 真的往里写 ——
 * 这样「关掉应用再打开」就能用同一份 session 复现。
 */
function makePv(album, sessions = {}, settings = {}) {
  return {
    getSettings: async () => ({ thumbSize: 220, theme: 'dark', showInfo: true, ...settings }),
    setSettings: async (patch) => ({ thumbSize: 220, theme: 'dark', showInfo: true, ...settings, ...patch }),
    recent: async () => [],
    isDirectory: async () => true,
    scanFolder: async (root) => album.scan(root),
    getSession: async (root) => ({ cursor: 0, ...(sessions[root] || {}) }),
    setSession: async (root, data) => {
      sessions[root] = { ...(sessions[root] || {}), ...data };
      return true;
    },
    favoriteFiles: (root, files) => album.favoriteFiles(root, files),
    unfavoriteFiles: (moves) => album.unfavoriteFiles(moves),
    saveFavorites: async () => 0,
    trash: async (files) => ({ ok: true, done: files, errors: [] }),
    restore: async () => ({ ok: true }),
    preview: async () => ({ ok: false }),
    putThumb: async () => false,
    setNativeTheme: async () => true,
  };
}

module.exports = { makeFakeAlbum, makePv };
