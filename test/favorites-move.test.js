'use strict';
/**
 * 「收藏 = 把文件移进收藏文件夹」这条链路的回归测试。
 *
 * 收藏从「往 favorites.txt 写一行」变成了「真的搬文件」，性质完全变了：
 * 前端记的路径必须一步不差地跟着磁盘走，方向搞反 / 少更新一处，
 * 结果就是界面显示已收藏、缩略图和大图却全裂（路径指向一个不存在的文件）。
 *
 * 所以这里用 helpers/fake-album.js 那个会记账的假文件系统跑真实操作序列，
 * 每一步都同时断言两件事：磁盘上文件在哪，S.all 里记的路径是不是同一个地方。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, tick } = require('./helpers/dom-app');
const { makeFakeAlbum, makePv } = require('./helpers/fake-album');

const ROOT = 'D:/Photos';

/** 一个平铺相册：n 张 NEF 直接躺在根目录 */
function flatAlbum(n = 3) {
  const files = {};
  for (let i = 0; i < n; i++) files[`${ROOT}/IMG_${i}.NEF`] = `raw-${i}`;
  return makeFakeAlbum(files);
}

/** 前端记的路径必须和假文件系统里真实存在的文件一一对上 */
function assertInSync(album, g) {
  for (const f of g.files) {
    assert.ok(album.exists(f), `S.all 里记着 ${f}，但磁盘上没有这个文件`);
  }
  assert.ok(g.files.includes(g.primary), `primary(${g.primary}) 必须在 files 里`);
  assert.strictEqual(g.dir, g.primary.slice(0, g.primary.lastIndexOf('/')), 'dir 要跟着 primary 走');
  assert.strictEqual(g.name, g.primary.slice(g.primary.lastIndexOf('/') + 1), 'name 要跟着 primary 走');
}

test('收藏把文件移进收藏文件夹，取消收藏移回原目录', async () => {
  const album = flatAlbum();
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  await app.actFavorite();

  assert.strictEqual(g.state, 'fav');
  assert.strictEqual(g.primary, `${ROOT}/收藏/IMG_0.NEF`);
  assert.ok(album.exists(`${ROOT}/收藏/IMG_0.NEF`), '文件要真的进收藏夹');
  assert.ok(!album.exists(`${ROOT}/IMG_0.NEF`), '原位置不该再有这个文件');
  assertInSync(album, g);

  await app.actFavorite(); // 再按一次 F = 取消收藏

  assert.strictEqual(g.state, 'none');
  assert.strictEqual(g.primary, `${ROOT}/IMG_0.NEF`);
  assert.ok(album.exists(`${ROOT}/IMG_0.NEF`), '要移回原目录');
  assert.ok(!album.exists(`${ROOT}/收藏/IMG_0.NEF`));
  assertInSync(album, g);
});

test('撤销收藏：文件回原位，路径同步跟回来', async () => {
  const album = flatAlbum();
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  await app.actFavorite();
  await app.actUndo();

  assert.strictEqual(g.state, 'none');
  assert.strictEqual(g.primary, `${ROOT}/IMG_0.NEF`);
  assert.ok(album.exists(`${ROOT}/IMG_0.NEF`));
  assert.ok(!album.exists(`${ROOT}/收藏/IMG_0.NEF`));
  assertInSync(album, g);
});

test('撤销「取消收藏」：文件必须真的回到收藏文件夹', async () => {
  const album = flatAlbum();
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  await app.actFavorite(); // 进收藏夹
  await app.actFavorite(); // 取消收藏，回原目录
  await app.actUndo(); // 撤销「取消收藏」 -> 应该再回收藏夹

  assert.strictEqual(g.state, 'fav');
  assert.ok(album.exists(`${ROOT}/收藏/IMG_0.NEF`), '撤销取消收藏后文件要回到收藏夹');
  assert.ok(!album.exists(`${ROOT}/IMG_0.NEF`), '原目录不该还留着');
  assertInSync(album, g);
});

test('撤销栈可以一路回退到底，磁盘和路径始终一致', async () => {
  const album = flatAlbum();
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  await app.actFavorite();
  await app.actFavorite();
  await app.actFavorite();

  for (let i = 0; i < 3; i++) {
    await app.actUndo();
    assertInSync(album, g);
  }

  assert.strictEqual(g.state, 'none');
  assert.strictEqual(g.primary, `${ROOT}/IMG_0.NEF`);
  assert.strictEqual(album.list().filter((p) => p.includes('IMG_0')).length, 1, '不能凭空多出一份拷贝');
});

test('RAW+JPG 配对整组一起搬，主名不许分家', async () => {
  const album = makeFakeAlbum({
    [`${ROOT}/sub/A.NEF`]: 'raw',
    [`${ROOT}/sub/A.JPG`]: 'jpg',
    [`${ROOT}/收藏/A.JPG`]: '别人家的 A.JPG', // 收藏夹里已经占了这个名字
  });
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view.find((x) => x.dir === `${ROOT}/sub`);
  assert.ok(g && g.files.length === 2, '前提：sub 下的 A.NEF + A.JPG 是一组');

  await app.actFavorite();

  const stems = g.files.map((f) => {
    const n = f.slice(f.lastIndexOf('/') + 1);
    return n.slice(0, n.lastIndexOf('.')).toLowerCase();
  });
  assert.strictEqual(stems[0], stems[1], '配对文件在收藏夹里必须共用同一个主名');
  assert.strictEqual(album.contentOf(`${ROOT}/收藏/A.JPG`), '别人家的 A.JPG', '不能覆盖同名的别人家文件');
  assertInSync(album, g);
});

test('重开相册后取消收藏，照片要回到它原来的子目录而不是相册根目录', async () => {
  const album = makeFakeAlbum({ [`${ROOT}/2026-08-23/IMG_9.NEF`]: 'raw-9' });
  const sessions = {};
  const app = loadApp(makePv(album, sessions));
  await app.openFolder(ROOT);

  await app.actFavorite();
  await tick(); // 等 debounce 的 saveSession 落盘
  assert.ok(album.exists(`${ROOT}/收藏/IMG_9.NEF`));

  // 关掉应用再打开：内存里的 _origFiles 全没了，只剩 session
  const app2 = loadApp(makePv(album, sessions));
  await app2.openFolder(ROOT);
  const g2 = app2.S.view[0];
  assert.strictEqual(g2.state, 'fav', '收藏夹里的照片重开后仍是已收藏');

  await app2.actFavorite(); // 取消收藏

  assert.ok(
    album.exists(`${ROOT}/2026-08-23/IMG_9.NEF`),
    `取消收藏应把照片放回 2026-08-23/，实际落在：${album.list().join(', ')}`
  );
  assertInSync(album, g2);
});

test('连按 F（键盘长按连发）只会搬一次，不会堆出两条撤销记录', async () => {
  const album = flatAlbum();
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  await Promise.all([app.actFavorite(), app.actFavorite(), app.actFavorite()]);

  assert.strictEqual(g.state, 'fav');
  assert.strictEqual(app.S.undo.length, 1, '一次收藏只该留一条撤销记录');
  assert.strictEqual(album.list().filter((p) => p.includes('IMG_0')).length, 1);
  assertInSync(album, g);
});

test('连按 F 取消收藏也只算一次：撤销栈不许多长出一条', async () => {
  const album = flatAlbum();
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  await app.actFavorite();
  // 连点取消收藏。第二次进来时文件已经回原位了，后端会当作「已还原」静默放过 ——
  // 没有锁的话这里会白白多出一条撤销记录，Ctrl+Z 得按两下才有反应
  await Promise.all([app.actFavorite(), app.actFavorite()]);

  assert.strictEqual(g.state, 'none');
  assert.strictEqual(app.S.undo.length, 2, '一次收藏 + 一次取消收藏 = 两条');

  await app.actUndo();
  assert.strictEqual(g.state, 'fav', '一次 Ctrl+Z 就该回到收藏状态');
  assertInSync(album, g);
});

test('收藏后再删除，撤销删除不会把状态弄丢', async () => {
  const album = flatAlbum();
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  await app.actFavorite();
  await app.actDelete();
  assert.strictEqual(g.state, 'del');

  await app.actUndo();
  assert.strictEqual(g.state, 'fav', '从回收站还原回来的还是收藏状态');
  assert.strictEqual(g.primary, `${ROOT}/收藏/IMG_0.NEF`, '路径仍指向收藏夹');
});

test('老的 favorites.txt 收藏（照片还在原处）取消时只摘星星，不搬文件', async () => {
  const album = makeFakeAlbum({ [`${ROOT}/sub/OLD.NEF`]: 'raw' });
  // 模拟扫描：1.5.0 的清单把这张记成收藏，但文件还躺在 sub 里
  const pv = makePv(album);
  const realScan = pv.scanFolder;
  pv.scanFolder = async (root) => {
    const r = await realScan(root);
    for (const g of r.groups) g.favored = true;
    r.hasLegacyFavorites = true;
    return r;
  };
  const app = loadApp(pv);
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  assert.strictEqual(g.state, 'fav', '老清单里的收藏升级后要还在');

  await app.actFavorite(); // 取消收藏

  assert.strictEqual(g.state, 'none');
  assert.ok(album.exists(`${ROOT}/sub/OLD.NEF`), '照片必须原地不动，不许被搬到相册根目录');
  assert.ok(!album.exists(`${ROOT}/OLD.NEF`));
  assertInSync(album, g);
});

test('有老清单的相册才回写 favorites.txt，新相册不碰', async () => {
  const written = [];
  const album = flatAlbum();
  const pv = makePv(album);
  pv.saveFavorites = async (root, list) => {
    written.push(list);
    return list.length;
  };

  const app = loadApp(pv);
  await app.openFolder(ROOT);
  await app.actFavorite();
  await tick();
  assert.strictEqual(written.length, 0, '没有 favorites.txt 的相册不该被撒上一个');

  const realScan = pv.scanFolder;
  pv.scanFolder = async (root) => ({ ...(await realScan(root)), hasLegacyFavorites: true });
  const app2 = loadApp(pv);
  await app2.openFolder(ROOT);
  await app2.actFavorite();
  await tick();
  assert.strictEqual(written.length, 1, '有老清单就要跟着更新，否则取消收藏下次刷新又冒出来');
});

test('搬文件时把缩略图缓存一起挪过去，别让网格闪回占位图', async () => {
  const album = flatAlbum();
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  const g = app.S.view[0];
  const oldPath = g.primary;
  app._int.urlCache.set(oldPath, 'blob:thumb-0');

  await app.actFavorite();

  assert.strictEqual(app._int.urlCache.get(g.primary), 'blob:thumb-0', '缓存要跟着新路径走');
  assert.ok(!app._int.urlCache.has(oldPath), '旧路径的缓存要清掉，不然白占着一个 objectURL');
});

test('对比工作台里按 F 也走同一条搬文件链路', async () => {
  const album = flatAlbum(2);
  const app = loadApp(makePv(album));
  await app.openFolder(ROOT);

  app.openCompare();
  const item = app.S.compare.items[0];
  const g = app.S.all.find((x) => x.id === item.id);

  await app.toggleSlotFav(0);

  assert.strictEqual(g.state, 'fav');
  assert.strictEqual(item.state, 'fav');
  assert.strictEqual(item.primary, g.primary, '槽位里的 primary 要跟着搬完的路径走');
  // 注意别用 deepStrictEqual：app.js 跑在 vm 沙箱里，两边的 Array 原型不是同一个
  assert.strictEqual(item.files.join('|'), g.files.join('|'), '槽位里的 files 也要同步，否则删除会打到旧路径');
  assertInSync(album, g);
});
