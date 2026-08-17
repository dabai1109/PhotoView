'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pv', {
  // sandbox 环境下 webUtils 是否可用（Electron 32+ 已移除 File.path，拖拽全靠它）
  hasWebUtils: !!(webUtils && typeof webUtils.getPathForFile === 'function'),
  // 拖拽进来的 File 对象 → 真实路径
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file && file.path ? file.path : '';
    }
  },
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  isDirectory: (p) => ipcRenderer.invoke('fs:isDirectory', p),
  scanFolder: (root) => ipcRenderer.invoke('scan:folder', root),
  preview: (file, kind, box) => ipcRenderer.invoke('img:preview', { file, kind, box }),
  exif: (file) => ipcRenderer.invoke('img:exif', file),
  saveFavorites: (root, favList) => ipcRenderer.invoke('fav:save', { root, favList }),
  getFavorites: (root) => ipcRenderer.invoke('fav:get', root),
  trash: (files) => ipcRenderer.invoke('file:trash', files),
  restore: (files) => ipcRenderer.invoke('file:restore', files),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getSession: (root) => ipcRenderer.invoke('session:get', root),
  setSession: (root, data) => ipcRenderer.invoke('session:set', { root, data }),
  recent: () => ipcRenderer.invoke('recent:get'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  setNativeTheme: (isDark) => ipcRenderer.invoke('theme:apply', isDark),
});
