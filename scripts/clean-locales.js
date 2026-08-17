'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 打包后钩子：清理多余的 Chromium 本地化语言文件（保留中文和英文），减少 15MB~25MB 安装包体积
 */
exports.default = async function (context) {
  const appOutDir = context.appOutDir;
  let localesDir = '';

  if (context.electronPlatformName === 'win32') {
    localesDir = path.join(appOutDir, 'locales');
  } else if (context.electronPlatformName === 'darwin') {
    localesDir = path.join(appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }

  if (!fs.existsSync(localesDir)) return;

  const keepLocales = new Set(['zh-CN.pak', 'zh_CN.pak', 'zh-TW.pak', 'en-US.pak', 'en_US.pak', 'en.pak']);
  const keepLproj = new Set(['zh_CN.lproj', 'zh-Hans.lproj', 'en.lproj', 'en_US.lproj', 'Base.lproj']);

  try {
    const files = fs.readdirSync(localesDir);
    for (const f of files) {
      if (f.endsWith('.pak') && !keepLocales.has(f)) {
        fs.unlinkSync(path.join(localesDir, f));
      } else if (f.endsWith('.lproj') && !keepLproj.has(f)) {
        fs.rmSync(path.join(localesDir, f), { recursive: true, force: true });
      }
    }
  } catch (e) {
    console.warn('[clean-locales] 清理语言包跳过:', e.message);
  }
};
