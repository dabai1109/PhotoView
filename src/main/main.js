'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const { pathToFileURL } = require('url');

const { getPreview, readExif } = require('./preview');
const { scanFolder } = require('./scan');
const store = require('./store');
const thumbs = require('./thumbs');
const fileops = require('./fileops');

// 过滤 Chromium DevTools 内部调试协议探测日志 (如 Autofill / VE logging)
app.commandLine.appendSwitch('log-level', '3');

let win = null;
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function applyTitleBarTheme(isDark) {
  if (!win || win.isDestroyed()) return;
  if (isDark) {
    nativeTheme.themeSource = 'dark';
    try {
      win.setTitleBarOverlay({ color: '#17171a', symbolColor: '#b9b9c0', height: 38 });
    } catch {}
  } else {
    nativeTheme.themeSource = 'light';
    try {
      win.setTitleBarOverlay({ color: '#ffffff', symbolColor: '#27272a', height: 38 });
    } catch {}
  }
}

// 用自定义协议加载页面：file:// 下 Chromium 不允许创建 Web Worker
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function registerProtocol() {
  protocol.handle('app', async (req) => {
    try {
      const u = new URL(req.url);
      let rel = decodeURIComponent(u.pathname);
      if (!rel || rel === '/') rel = '/index.html';
      const file = path.join(RENDERER, path.normalize(rel));
      if (!file.startsWith(RENDERER)) return new Response('forbidden', { status: 403 });
      return await net.fetch(pathToFileURL(file).toString());
    } catch (e) {
      return new Response(String(e), { status: 404 });
    }
  });
}

function createWindow() {
  const s = store.getSettings();
  const isLight = s.theme === 'light' || (s.theme === 'system' && !nativeTheme.shouldUseDarkColors);
  const isDark = !isLight;

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: isDark ? '#08080a' : '#f4f4f7',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: isDark
      ? { color: '#17171a', symbolColor: '#b9b9c0', height: 38 }
      : { color: '#ffffff', symbolColor: '#27272a', height: 38 },
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false, // 切到别的窗口时缩略图也继续解码
    },
  });

  win.setIcon(ICON_PATH);
  Menu.setApplicationMenu(null);
  win.loadURL('app://photoview/index.html');
  win.once('ready-to-show', () => win.show());
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  // 禁止把拖进来的文件当作页面导航
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(process.execPath);
  }
  registerProtocol();
  createWindow();
  setTimeout(() => thumbs.prune(), 8000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

/* ---------------- IPC ---------------- */

ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '选择照片文件夹',
    buttonLabel: '开始选片',
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('fs:isDirectory', async (_e, p) => {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
});

ipcMain.handle('scan:folder', async (_e, root) => {
  const s = store.getSettings();
  const fileName = s.favoritesFileName || 'favorites.txt';
  const groups = await scanFolder(root, {
    recursive: s.recursive,
    group: s.groupRawJpeg,
    excludeDirs: [],
  });

  // 从相册根目录下的 favorites.txt / json 读取收藏记录
  const localFavs = await fileops.readFavorites(root, fileName);
  const favSet = new Set(localFavs.map((x) => x.trim().toLowerCase()));

  for (const g of groups) {
    const gId = g.id.toLowerCase();
    const gName = g.name.toLowerCase();
    const gBase = g.base.toLowerCase();
    g.favored =
      favSet.has(gId) ||
      favSet.has(gName) ||
      favSet.has(gBase) ||
      g.files.some((f) => {
        const rel = path.relative(root, f).toLowerCase();
        const base = path.basename(f).toLowerCase();
        return favSet.has(rel) || favSet.has(base);
      });
  }

  await store.recentFolders(root);
  return { ok: true, root, groups, favoritesFileName: fileName };
});

ipcMain.handle('img:preview', async (_e, { file, kind, box }) => {
  try {
    if (kind === 'thumb') {
      const hit = await thumbs.get(file, box);
      if (hit) return { ok: true, cached: true, data: hit.data, orientation: 1 };
    }
    const r = await getPreview(file, kind === 'full' ? 'full' : 'thumb');
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      cached: false,
      data: r.data,
      mime: r.mime,
      orientation: r.orientation, // 渲染层还需要补的旋转（解码器已处理的话就是 1）
      exifOrientation: r.exifOrientation,
      storeW: r.storeW, // 文件里实际存的尺寸，worker 缩放要用
      storeH: r.storeH,
      width: r.width, // 解码之后的尺寸，大图布局要用
      height: r.height,
      exif: r.exif,
      fileSize: r.fileSize,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('img:putThumb', async (_e, { file, box, bytes }) => thumbs.put(file, box, bytes));

ipcMain.handle('img:exif', async (_e, file) => readExif(file));

ipcMain.handle('fav:get', async (_e, root) => {
  const s = store.getSettings();
  const fileName = s.favoritesFileName || 'favorites.txt';
  return fileops.readFavorites(root, fileName);
});

ipcMain.handle('fav:save', async (_e, { root, favList }) => {
  const s = store.getSettings();
  const fileName = s.favoritesFileName || 'favorites.txt';
  return fileops.writeFavorites(root, fileName, favList);
});

ipcMain.handle('file:trash', async (_e, files) => fileops.trash(files));

ipcMain.handle('file:restore', async (_e, files) => fileops.restoreFromRecycleBin(files));

ipcMain.handle('shell:reveal', async (_e, p) => {
  shell.showItemInFolder(path.normalize(p));
  return true;
});

ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(path.normalize(p)));

ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  if (patch.theme) {
    const isLight = patch.theme === 'light' || (patch.theme === 'system' && !nativeTheme.shouldUseDarkColors);
    applyTitleBarTheme(!isLight);
  }
  return store.setSettings(patch);
});
ipcMain.handle('session:get', (_e, root) => store.getSession(root));
ipcMain.handle('session:set', (_e, { root, data }) => store.setSession(root, data));
ipcMain.handle('recent:get', () => store.recentFolders());
ipcMain.handle('cache:clear', () => thumbs.clear());
ipcMain.handle('theme:apply', (_e, isDark) => applyTitleBarTheme(isDark));

ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));
