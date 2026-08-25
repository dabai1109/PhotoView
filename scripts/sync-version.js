'use strict';

const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '../package.json');
const cargoPath = path.join(__dirname, '../src-tauri/Cargo.toml');

if (!fs.existsSync(pkgPath)) {
  console.error('[Version Sync] 错误: 找不到 package.json');
  process.exit(1);
}

if (!fs.existsSync(cargoPath)) {
  console.error('[Version Sync] 错误: 找不到 src-tauri/Cargo.toml');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;

if (!version) {
  console.error('[Version Sync] 错误: package.json 中没有 version 字段');
  process.exit(1);
}

let cargo = fs.readFileSync(cargoPath, 'utf8');

// 精确替换 [package] 块下的 version = "x.y.z"
const updatedCargo = cargo.replace(
  /(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
  `$1"${version}"`
);

if (cargo === updatedCargo && !cargo.includes(`version = "${version}"`)) {
  console.error('[Version Sync] 警告: 未能匹配并替换 Cargo.toml 中的版本号');
  process.exit(1);
}

fs.writeFileSync(cargoPath, updatedCargo, 'utf8');
console.log(`[Version Sync] 成功同步版本号: v${version} -> src-tauri/Cargo.toml`);
