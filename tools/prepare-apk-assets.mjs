#!/usr/bin/env node
/**
 * 把 Web 端（app/）同步进 Android 工程（android/app/src/main/assets/www/）。
 *
 * APK 构建前必须先跑这个脚本；生成出来的 www/ 是构建产物，不要提交（见 .gitignore）。
 *
 * 顺带做两处只有打包才需要的微调：
 *   1. viewport 加 interactive-widget=resizes-content —— 键盘弹出时让页面跟着缩小，
 *      聊天输入框不会被键盘挡住（全屏 + adjustResize 在 Android 上不生效）；
 *   2. 页面标题改成「云曰」，任务切换器里显示的名字和图标保持一致。
 *
 * 用法：node tools/prepare-apk-assets.mjs
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'app');
const DEST_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');

const APP_NAME = '云曰';

async function copyVendor() {
  const src = path.join(SRC_DIR, 'vendor');
  try {
    await stat(src);
  } catch {
    return 0;
  }
  await cp(src, path.join(DEST_DIR, 'vendor'), { recursive: true });
  return countFiles(path.join(DEST_DIR, 'vendor'));
}

async function countFiles(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}

function patchHtml(html) {
  let out = html;

  if (!out.includes('interactive-widget=')) {
    out = out.replace(/viewport-fit=cover/, 'viewport-fit=cover, interactive-widget=resizes-content');
  }

  if (/<title>[^<]*<\/title>/.test(out)) {
    out = out.replace(/<title>[^<]*<\/title>/, `<title>${APP_NAME}</title>`);
  }
  out = out.replace(
    /<meta name="apple-mobile-web-app-title" content="[^"]*">/,
    `<meta name="apple-mobile-web-app-title" content="${APP_NAME}">`
  );

  return out;
}

async function main() {
  const htmlPath = path.join(SRC_DIR, 'index.html');
  const html = await readFile(htmlPath, 'utf8');

  await rm(DEST_DIR, { recursive: true, force: true });
  await mkdir(DEST_DIR, { recursive: true });

  await writeFile(path.join(DEST_DIR, 'index.html'), patchHtml(html), 'utf8');
  const vendorCount = await copyVendor();

  const { size } = await stat(path.join(DEST_DIR, 'index.html'));
  console.log(`[assets] index.html -> ${path.relative(ROOT, DEST_DIR)}/index.html (${(size / 1024).toFixed(0)} KB)`);
  console.log(`[assets] vendor/ 复制了 ${vendorCount} 个文件`);
  console.log('[assets] 只打包 index.html 和 vendor/，app/ 里的 *.bak*.html 不会进 APK');
}

main().catch((error) => {
  console.error('[assets] 同步失败:', error);
  process.exit(1);
});
