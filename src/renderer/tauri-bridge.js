'use strict';
/**
 * Tauri 2.0 桥接层：将 Tauri IPC 无缝适配到 window.pv 接口，
 * 使得全部前端 UI 逻辑（app.js）100% 保持不变。
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
      console.warn(`[Tauri Bridge] 未检测到 Tauri 环境，模拟调用: ${cmd}`);
      return null;
    }
    return await fn(cmd, args);
  };

  window.pv = {
    hasWebUtils: false,
    pathForFile: (file) => (file && file.path ? file.path : ''),
    openFolderDialog: () => invoke('open_folder_dialog'),
    isDirectory: (p) => invoke('is_directory', { path: p }),
    scanFolder: (root) => invoke('scan_folder', { root }),
    preview: (file, kind, box) => invoke('get_preview', { file, kind: kind || 'thumb' }),
    putThumb: () => Promise.resolve(true),
    exif: (file) => invoke('get_preview', { file, kind: 'thumb' }).then((r) => (r ? r.exif : null)),
    saveFavorites: (root, favList) => invoke('save_favorites', { root, favList }),
    getFavorites: (root) => invoke('get_favorites', { root }),
    trash: (files) => invoke('trash_files', { files }),
    restore: () => Promise.resolve({ ok: false, error: '请在系统回收站中手动还原' }),
    reveal: (p) => invoke('reveal_in_explorer', { path: p }),
    openPath: (p) => invoke('open_path', { path: p }),
    getSettings: () => invoke('get_settings'),
    setSettings: (patch) => invoke('set_settings', { patch }),
    getSession: (root) => Promise.resolve({ root, favorites: [], cursor: 0 }),
    setSession: () => Promise.resolve(true),
    recent: () => invoke('get_recent'),
    clearCache: () => Promise.resolve(true),
    setNativeTheme: () => Promise.resolve(true),
  };
})();
