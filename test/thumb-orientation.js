const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../src/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FOLDER = path.join(__dirname, '..', 'test-photos');

app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  win.setAlwaysOnTop(true);
  win.focus();
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`__pv.openFolder(${JSON.stringify(FOLDER)})`);
  await sleep(4500);

  // 缩略图是 worker 里烤好方向的，检查烤出来的宽高是否与 EXIF 一致
  const rows = await js(`(async()=>{
    const out=[];
    for (const g of __pv.S.view) {
      const url = __pv._int.urlCache.get(g.primary);
      if (!url) { out.push({n:g.name, err:'无缩略图'}); continue; }
      const im = new Image(); im.src = url;
      await new Promise(r => { im.onload = r; im.onerror = r; });
      const r0 = await window.pv.preview(g.primary, 'full', 0);
      const o = r0.orientation || 1, sw = (o>=5&&o<=8);
      const 期望竖 = sw ? r0.width > r0.height : r0.height > r0.width;
      out.push({n:g.name, o, 缩略图:im.width+'x'+im.height,
                ok: 期望竖 === (im.height > im.width), 期望竖});
    }
    return out;
  })()`);
  let bad = 0;
  for (const r of rows) {
    if (r.err) { console.log('  ?', r.n, r.err); continue; }
    if (!r.ok) bad++;
    if (!r.ok || /ZS_|B_2|DSC_0005|DSC_0008/.test(r.n))
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.n} 方向=${r.o} 缩略图=${r.缩略图} ${r.ok ? '' : '（应为' + (r.期望竖 ? '竖' : '横') + '）'}`);
  }
  console.log(bad ? `✗ 缩略图有 ${bad} 张方向不对` : `✓ ${rows.length} 张缩略图方向全部正确`);
  app.exit(bad ? 1 : 0);
});
