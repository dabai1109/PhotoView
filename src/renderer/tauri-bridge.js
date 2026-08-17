'use strict';
/**
 * Tauri 2.0 桥接层：把 Tauri IPC 适配到 window.pv 接口，
 * 使得全部前端 UI 逻辑（app.js）100% 保持不变。
 *
 * 两个关键约定：
 *  1) 图片字节不走 JSON。get_preview 只返回元数据 + 一次性 token，
 *     字节由 take_preview_bytes 以二进制取回，在这里拼成 app.js 期望的 Uint8Array。
 *     （走 base64 data URI 的话 app.js 里的 r.data.buffer 会直接炸掉）
 *  2) 拖放由 Tauri 原生事件驱动。Tauri 拦截了 webview 的拖放，
 *     DOM 的 drop 事件收不到文件，而且 File 对象也没有 Electron 那个 .path，
 *     所以这里把原生事件翻译成 app.js 已经在监听的合成 DOM 事件。
 */
(function () {
  if (window.pv) return; // 如果已有 preload 注入则使用现有

  const getTauriInvoke = () => {
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
      return window.__TAURI__.core.invoke;
    }
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
      return window.__TAURI_INTERNALS__.invoke;
    }
    return null;
  };

  const invoke = async (cmd, args = {}) => {
    const fn = getTauriInvoke();
    if (!fn) {
      console.warn(`[Tauri Bridge] 未检测到 Tauri 环境，跳过调用: ${cmd}`);
      return null;
    }
    return await fn(cmd, args);
  };

  /* ---------- 二进制 ---------- */

  /** take_preview_bytes 返回的可能是 ArrayBuffer / TypedArray / 数字数组，统一成 Uint8Array */
  const toBytes = (v) => {
    if (!v) return new Uint8Array(0);
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (Array.isArray(v)) return new Uint8Array(v);
    return new Uint8Array(0);
  };

  /** 分块转 base64：一次性 String.fromCharCode(...bytes) 在几十 KB 上就会爆栈 */
  const toBase64 = (bytes) => {
    const u8 = toBytes(bytes);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  };

  const takeBytes = async (token) => {
    if (token === null || token === undefined) return new Uint8Array(0);
    return toBytes(await invoke('take_preview_bytes', { token }));
  };

  /**
   * 预览：先拿元数据，再把图片字节取回来挂到 r.data 上。
   * app.js 拿到的形状与原 Electron 版完全一致。
   */
  const preview = async (file, kind, box) => {
    const meta = await invoke('get_preview', {
      file,
      kind: kind === 'full' ? 'full' : 'thumb',
      boxSize: Math.max(0, Math.round(Number(box) || 0)),
    });
    if (!meta || !meta.ok) return meta;
    meta.data = await takeBytes(meta.token);
    if (!meta.data.length) return { ok: false, error: '预览数据已失效，请重试' };
    return meta;
  };

  window.pv = {
    hasWebUtils: false,
    // 拖放路径由下面的原生事件注入，这里只负责取出来
    pathForFile: (file) => (file && file.path ? file.path : ''),
    openFolderDialog: () => invoke('open_folder_dialog'),
    isDirectory: (p) => invoke('is_directory', { path: p }),
    scanFolder: (root) => invoke('scan_folder', { root }),
    preview,
    putThumb: (file, box, bytes) =>
      invoke('put_thumb', {
        file,
        boxSize: Math.max(0, Math.round(Number(box) || 0)),
        data: toBase64(bytes),
      }).catch(() => false),
    exif: async (file) => {
      const r = await invoke('get_preview', { file, kind: 'thumb', boxSize: 0 });
      if (!r) return null;
      if (r.token !== null && r.token !== undefined) await takeBytes(r.token); // 别把字节挂在 Rust 侧不放
      return r.exif || null;
    },
    saveFavorites: (root, favList) => invoke('save_favorites', { root, favList }),
    getFavorites: (root) => invoke('get_favorites', { root }),
    trash: (files) => invoke('trash_files', { files }),
    restore: (files) => invoke('restore_files', { files }),
    reveal: (p) => invoke('reveal_in_explorer', { path: p }),
    openPath: (p) => invoke('open_path', { path: p }),
    getSettings: () => invoke('get_settings'),
    setSettings: (patch) => invoke('set_settings', { patch }),
    getSession: (root) => invoke('get_session', { root }),
    setSession: (root, data) => invoke('set_session', { root, data }),
    recent: () => invoke('get_recent'),
    clearCache: () => invoke('clear_cache'),
    // 标题栏跟随主题需要原生窗口 API，暂不接；配色本身由 CSS 的 data-theme 负责
    setNativeTheme: () => Promise.resolve(true),
  };

  /* ---------- 原生拖放 → 合成 DOM 事件 ---------- */

  const fire = (type, dataTransfer) => {
    const evt = new Event(type, { cancelable: true, bubbles: false });
    if (dataTransfer) Object.defineProperty(evt, 'dataTransfer', { value: dataTransfer });
    window.dispatchEvent(evt);
  };

  const listenDragDrop = () => {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (!ev || typeof ev.listen !== 'function') return;
    const on = (name, cb) => {
      try {
        Promise.resolve(ev.listen(name, cb)).catch(() => {});
      } catch {}
    };

    on('tauri://drag-enter', () => fire('dragenter', { types: ['Files'] }));
    on('tauri://drag-leave', () => fire('dragleave', null));
    on('tauri://drag-drop', (e) => {
      const paths = (e && e.payload && e.payload.paths) || [];
      // app.js 会走 pv.pathForFile(f) 取路径，这里给出它认得的形状
      fire('drop', { files: paths.map((p) => ({ path: p })), types: ['Files'] });
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', listenDragDrop, { once: true });
  } else {
    listenDragDrop();
  }
})();
