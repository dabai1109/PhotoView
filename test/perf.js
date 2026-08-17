/**
 * 大图加载性能与方向正确性测试
 * 用法：npx electron test/perf.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../src/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FOLDER = path.join(__dirname, '..', 'test-photos');
const log = (...a) => console.log('[perf]', ...a);

app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  win.setAlwaysOnTop(true);
  win.focus();
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`window.__err=[];window.onerror=(m,s,l)=>__err.push(m+' @'+l);true`);

  await js(`__pv.openFolder(${JSON.stringify(FOLDER)})`);
  await sleep(4000);

  // 在渲染层测量：从切换指令发出，到 <img> 真正贴上高清图并完成布局
  await js(`window.__timeTo = async (i) => {
    const t0 = performance.now();
    __pv.goTo(i);
    const want = __pv.S.view[i].primary;
    // 等到 <img> 用的确实是全尺寸缓存里的那张，并且已经按它重新布局过
    // （只等 complete 会在 layout 之前就返回，量到的是上一张的排版）
    for (let k = 0; k < 400; k++) {
      const rec = __pv._int.fullCache.get(want);
      const img = document.getElementById('loupe-img');
      const L = __pv.S.loupe;
      const laidOut = rec && L.srcW === rec.w && L.srcH === rec.h &&
                      Math.abs(parseFloat(img.style.width || 0) - rec.w * L.fit) < 1.5;
      if (rec && !rec.error && img.src === rec.url && img.complete && img.naturalWidth && laidOut) {
        return { ms: Math.round(performance.now() - t0), nat: img.naturalWidth + 'x' + img.naturalHeight, o: L.o };
      }
      await new Promise(r => setTimeout(r, 10));
    }
    const rec = __pv._int.fullCache.get(want);
    const img = document.getElementById('loupe-img');
    return { ms: -1, why: JSON.stringify({ hasRec: !!rec, err: rec && rec.error,
      srcMatch: rec ? img.src === rec.url : null, complete: img.complete, nw: img.naturalWidth,
      cacheSize: __pv._int.fullCache.size }) };
  }; true`);

  await js(`__pv.goTo(0); __pv.showLoupe()`);
  await sleep(2500);

  log('冷启动（无缓存，顺序翻页）');
  const cold = [];
  for (let i = 1; i <= 5; i++) {
    const r = await js(`__timeTo(${i})`);
    cold.push(r.ms);
    log(`  第 ${i} 张: ${r.ms}ms  ${r.nat || ''}  方向=${r.o}  ${r.why || ''}`);
    await sleep(50); // 故意不给预取时间
  }

  log('正常翻页（预取生效：每张停留 500ms）');
  const warm = [];
  for (let i = 6; i <= 12; i++) {
    const r = await js(`__timeTo(${i})`);
    warm.push(r.ms);
    log(`  第 ${i} 张: ${r.ms}ms`);
    await sleep(500);
  }

  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  log(`连续快翻均值 ${avg(cold)}ms · 正常节奏均值 ${avg(warm)}ms`);

  log('方向：对比"屏幕上实际占的宽高"与 EXIF 应有的朝向');
  const orient = await js(`(async()=>{
    const out=[];
    for (let i=0;i<__pv.S.view.length;i++){
      await __timeTo(i);
      const S=__pv.S, o=S.loupe.o, sw=(o>=5&&o<=8);
      const img=document.getElementById('loupe-img');
      const rec=__pv._int.fullCache.get(S.view[i].primary);
      // 真实存储尺寸只能信主进程从 SOF 解出来的值，img.naturalWidth 会被 EXIF 影响
      const nw=rec.w||img.naturalWidth, nh=rec.h||img.naturalHeight;
      const r=img.getBoundingClientRect();          // 含 transform，就是屏幕上真实占的框
      const 期望竖 = sw ? nw>nh : nh>nw;
      const 实际竖 = r.height > r.width;
      out.push({n:S.view[i].name, o, 存储:nw+'x'+nh,
                屏幕:Math.round(r.width)+'x'+Math.round(r.height),
                ok: 期望竖===实际竖, 期望竖, 实际竖});
    }
    return out;
  })()`);
  let bad = 0;
  for (const r of orient) {
    if (!r.ok) bad++;
    log(`  ${r.ok ? '✓' : '✗'} ${r.n}  方向=${r.o}  存储=${r.存储} → 屏幕=${r.屏幕} ${r.实际竖 ? '竖' : '横'}${r.ok ? '' : `（应为${r.期望竖 ? '竖' : '横'}）`}`);
  }
  log(bad ? `✗ ${bad} 张方向不对` : `✓ ${orient.length} 张方向全部正确`);

  const errs = await js(`window.__err`);
  log('渲染层错误:', errs.length ? JSON.stringify(errs) : '无');
  app.exit(0);
});
