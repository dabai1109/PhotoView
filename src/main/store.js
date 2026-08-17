'use strict';
/** 设置与选片进度的本地持久化 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DEFAULTS = {
  favoritesFileName: 'favorites.txt', // 记录在相册根目录下的文件名（支持 .txt 或 .json）
  groupRawJpeg: true,
  recursive: true,
  autoAdvanceOnFavorite: true,
  autoAdvanceOnDelete: true,
  confirmDelete: false,
  thumbSize: 220,
  sortBy: 'name', // name | date | size
  showInfo: true,
  showHistogram: true,
  openLoupeOnDrop: false,
  theme: 'dark', // dark | light | system
};

let cache = null;
const userDir = () => app.getPath('userData');
const settingsFile = () => path.join(userDir(), 'settings.json');
const sessionDir = () => path.join(userDir(), 'sessions');

function getSettings() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

async function setSettings(patch) {
  cache = { ...getSettings(), ...patch };
  await fsp.mkdir(userDir(), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

const keyOf = (root) => crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);

async function getSession(root) {
  try {
    const raw = await fsp.readFile(path.join(sessionDir(), keyOf(root) + '.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { root, favorites: {}, cursor: 0 };
  }
}

async function setSession(root, data) {
  await fsp.mkdir(sessionDir(), { recursive: true });
  await fsp.writeFile(path.join(sessionDir(), keyOf(root) + '.json'), JSON.stringify({ ...data, root }), 'utf8');
  return true;
}

async function recentFolders(add) {
  const f = path.join(userDir(), 'recent.json');
  let list = [];
  try {
    list = JSON.parse(await fsp.readFile(f, 'utf8'));
  } catch {}
  if (add) {
    list = [add, ...list.filter((x) => x.toLowerCase() !== add.toLowerCase())].slice(0, 12);
    await fsp.mkdir(userDir(), { recursive: true });
    await fsp.writeFile(f, JSON.stringify(list), 'utf8');
  }
  return list;
}

module.exports = { getSettings, setSettings, getSession, setSession, recentFolders, DEFAULTS };
