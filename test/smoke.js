/**
 * 端到端冒烟测试：真的把应用跑起来，驱动一遍完整选片流程并截图。
 * 用法：npx electron test/smoke.js
 * 截图输出到 shots/
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

require('../src/main/main.js'); // 复用真实主进程

const FOLDER = path.join(__dirname, '..', 'test-photos');
const SHOTS = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

app.whenReady().then(async () => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  await sleep(1500);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('没有窗口');
    return app.exit(1);
  }

  const errors = [];
  // 窗口被遮挡时 Chromium 会停止出帧，capturePage 会拿到旧帧
  win.setAlwaysOnTop(true);
  win.focus();
  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    const msg = typeof d === 'object' ? `${d.level}: ${d.message}` : `${args[1]}: ${args[2]}`;
    if (/error|warn/i.test(String(msg))) errors.push(msg);
    log('renderer >', msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('!! renderer 崩溃', JSON.stringify(d)));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const f = path.join(SHOTS, name + '.png');
    fs.writeFileSync(f, img.toPNG());
    log('截图', name);
  };

  await js(`window.__err=[];window.onerror=(m,s,l)=>__err.push(m+' @'+l);
            window.onunhandledrejection=(e)=>__err.push('unhandled: '+e.reason);true`);

  await sleep(600);
  await shot('01-空状态');

  log('打开文件夹', FOLDER);
  await js(`__pv.openFolder(${JSON.stringify(FOLDER)})`);
  await sleep(4000);
  await shot('02-网格');

  const stats = await js(`(()=>{const S=__pv.S;return {
      count:S.all.length, view:S.view.length, raw:S.all.filter(g=>g.isRaw).length,
      paired:S.all.filter(g=>g.hasPair).length, root:S.root, favDir:S.favDir,
      thumbLoaded:[...document.querySelectorAll('.card img')].filter(i=>i.classList.contains('on')).length,
      cards:document.querySelectorAll('.card').length}})()`);
  log('扫描结果', JSON.stringify(stats));

  log('进入大图');
  await js(`__pv.goTo(1); __pv.showLoupe()`);
  await sleep(2500);
  await shot('03-大图-竖构图');

  const li = await js(`(()=>{const S=__pv.S;return{name:S.view[S.cur].name,
      o:S.loupe.o,fit:+S.loupe.fit.toFixed(3),nat:S.loupe.natW+'x'+S.loupe.natH,
      transform:document.getElementById('loupe-img').style.transform,
      info:document.getElementById('info-list').textContent.slice(0,120),
      err:document.getElementById('loupe-error').hidden?null:document.getElementById('loupe-error').textContent}})()`);
  log('大图状态', JSON.stringify(li));

  log('100% 放大');
  await js(`__pv.toggle100()`);
  await sleep(900);
  await shot('04-大图-100%');

  await js(`__pv.toggle100()`);
  await sleep(400);

  log('收藏当前这张');
  const before = await js(`__pv.S.view[__pv.S.cur].name`);
  await js(`__pv.actFavorite()`);
  await sleep(1800);
  await shot('05-收藏后自动跳下一张');
  const favDir = path.join(FOLDER, '收藏');
  log('收藏夹内容', fs.existsSync(favDir) ? fs.readdirSync(favDir).join(', ') : '（未创建）');
  log('收藏的是', before);

  log('删除当前这张 → 回收站');
  const delName = await js(`__pv.S.view[__pv.S.cur].name`);
  const delFiles = await js(`JSON.stringify(__pv.S.view[__pv.S.cur].files)`);
  await js(`__pv.actDelete()`);
  await sleep(2000);
  await shot('06-删除后');
  const gone = JSON.parse(delFiles).every((f) => !fs.existsSync(f));
  log('删除', delName, '→ 文件已从原位置消失:', gone);

  log('撤销删除（从回收站还原）');
  await js(`__pv.actUndo()`);
  await sleep(4500);
  await shot('07-撤销还原后');
  const back = JSON.parse(delFiles).every((f) => fs.existsSync(f));
  log('还原结果:', back ? '✓ 文件已回到原位置' : '✗ 还原失败');

  log('切到收藏筛选');
  await js(`__pv.showGrid(); __pv.applyFilter('fav')`);
  await sleep(1500);
  await shot('08-收藏筛选');

  await js(`__pv.applyFilter('all')`);
  await sleep(800);
  await shot('09-回到全部');

  const counts = await js(`[...document.querySelectorAll('#filters .chip')].map(c=>c.textContent.trim()).join(' | ')`);
  log('筛选计数', counts);

  await js(`document.getElementById('btn-settings').click()`);
  await sleep(600);
  await shot('10-设置');
  await js(`document.getElementById('btn-close-settings').click()`);
  await sleep(400);
  await js(`document.getElementById('btn-help').click()`);
  await sleep(600);
  await shot('11-快捷键');
  await js(`document.getElementById('btn-close-help').click()`);
  await sleep(300);

  log('测试主题切换：点击顶栏按钮切换为亮色');
  await js(`document.getElementById('btn-theme').click()`);
  await sleep(800);
  await shot('12-亮色网格');

  log('测试主题切换：亮色大图模式');
  await js(`__pv.showLoupe()`);
  await sleep(1500);
  await shot('13-亮色大图');

  log('测试主题切换：按 T 键切换为暗色模式');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }))`);
  await sleep(800);
  await shot('14-暗色大图');

  log('测试主题切换：通过设置面板切换为亮色');
  await js(`__pv.showGrid()`);
  await sleep(400);
  await js(`document.getElementById('btn-settings').click()`);
  await sleep(400);
  await js(`document.getElementById('set-theme').value = 'light'`);
  await js(`document.getElementById('btn-close-settings').click()`);
  await sleep(800);
  await shot('15-亮色设置保存后');

  // 恢复暗色模式
  await js(`__pv.applyTheme('dark'); __pv.S.settings.theme = 'dark'; window.pv.setSettings({ theme: 'dark' })`);
  await sleep(300);

  const rendererErrors = await js(`window.__err`);
  log('渲染层错误:', rendererErrors.length ? JSON.stringify(rendererErrors) : '无');
  log('控制台报错:', errors.length ? JSON.stringify(errors.slice(0, 5)) : '无');

  log('完成，截图在 shots/');
  app.exit(rendererErrors.length ? 1 : 0);
});
