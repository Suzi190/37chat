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

/** Dexie 的库名，改掉等于换一个空库，老用户的聊天记录会全部消失，所以必须原样保留 */
const DB_NAME = '37ChatDB';

/**
 * 开屏大字、标题、协议文案、提示词里都写着 37Chat，打包时统一换成「云曰」，
 * 只有 Dexie 库名（DB_NAME）不动，导出文件名换成纯 ASCII 的 yunyue。
 */
function rebrand(html) {
  const guard = '\u0001DBNAME\u0001';
  let out = html.split(DB_NAME).join(guard);
  out = out.split('37Chat').join(APP_NAME);
  out = out.split('`' + APP_NAME + '-data-').join('`yunyue-data-');
  return out.split(guard).join(DB_NAME);
}

/**
 * 启动自检脚本：插在 <head> 最前面，用纯 ES5 写，保证老 WebView 也能跑。
 * 作用是——页面卡在开屏时，把「为什么卡住」直接写在屏幕上，而不是一片死寂：
 *   1. 主脚本语法/运行时错误（老 WebView 不支持新语法时就是这里报）；
 *   2. 未处理的 Promise 拒绝；
 *   3. 8 秒还没进主界面 → 亮出跳过按钮 + 打印 WebView 版本和当前地址。
 */
const DIAG_SCRIPT = `<script>/* __YUNYUE_BOOT_DIAG__ */
(function () {
  var painted = false;
  function splashTextNode() {
    return document.querySelector('#app-splash-screen .splash-status-text');
  }
  function paint(msg, color) {
    var el = splashTextNode();
    if (!el) { return; }
    painted = true;
    el.textContent = msg;
    if (color) { el.style.color = color; }
    el.style.wordBreak = 'break-all';
    el.style.padding = '0 24px';
    el.style.textAlign = 'left';
    el.style.fontSize = '12px';
    el.style.lineHeight = '1.6';
    el.style.letterSpacing = '0';
  }
  function env() {
    var ua = navigator.userAgent || '';
    var chrome = (ua.match(/Chrome\\/([\\d.]+)/) || [])[1] || '?';
    return 'WebView ' + chrome + ' | ' + location.href;
  }
  window.addEventListener('error', function (ev) {
    if (!ev) { return; }
    var tgt = ev.target || {};
    if (tgt !== window && tgt !== document && tgt.tagName) { return; }
    var detail = ev.error ? (ev.error.stack || ev.error.message || String(ev.error)) : (ev.message || '未知错误');
    paint('启动脚本出错：' + String(detail).slice(0, 400), '#c62828');
  }, true);
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var detail = r ? (r.stack || r.message || String(r)) : '未知原因';
    paint('初始化失败：' + String(detail).slice(0, 400), '#c62828');
  });
  document.addEventListener('DOMContentLoaded', function () {
    // 2 秒自检：依赖脚本没加载出来时，主脚本会在顶层就抛错，页面看起来就是「卡住」
    setTimeout(function () {
      var splash = document.getElementById('app-splash-screen');
      if (!splash || splash.classList.contains('fade-out')) { return; }
      var miss = [];
      if (typeof Dexie === 'undefined') { miss.push('Dexie(vendor/dexie.min.js)'); }
      if (typeof window.markdownit === 'undefined') { miss.push('markdown-it(vendor/markdown-it.min.js)'); }
      if (!window.indexedDB) { miss.push('IndexedDB'); }
      if (miss.length) {
        paint('依赖没加载出来：' + miss.join('、') + ' | ' + env(), '#c62828');
      }
    }, 2000);
    // 3 秒自检：真正打开一次 IndexedDB。有些 ROM / 隐私空间里 indexedDB 对象存在但请求永远不回调，
    // 表现就是 loadData() 永不返回、开屏一直转圈，而且不会报错——这里把它挖出来。
    setTimeout(function () {
      var splash2 = document.getElementById('app-splash-screen');
      if (!splash2 || splash2.classList.contains('fade-out') || painted) { return; }
      try {
        var settled = false;
        var probe = window.indexedDB.open('__yunyue_probe__');
        probe.onsuccess = function () {
          settled = true;
          try { probe.result.close(); } catch (e) { }
          try { window.indexedDB.deleteDatabase('__yunyue_probe__'); } catch (e) { }
        };
        probe.onerror = function () {
          settled = true;
          paint('IndexedDB 打不开：' + ((probe.error && probe.error.name) || '未知') + ' | ' + env(), '#c62828');
        };
        probe.onblocked = function () { settled = true; };
        setTimeout(function () {
          if (!settled && !painted) {
            paint('IndexedDB 无响应（可能被系统/隐私空间禁用），数据没法读写 | ' + env(), '#c62828');
          }
        }, 4000);
      } catch (e) {
        paint('IndexedDB 不可用：' + e + ' | ' + env(), '#c62828');
      }
    }, 3000);
    setTimeout(function () {
      var splash = document.getElementById('app-splash-screen');
      if (!splash || splash.classList.contains('fade-out')) { return; }
      var btn = document.getElementById('splash-skip-btn');
      if (btn) { btn.style.display = 'block'; }
      var el = splashTextNode();
      if (el && !painted) {
        paint('初始化卡住了（8 秒未完成），点下面按钮可先进入 | ' + env(), '#c62828');
      }
    }, 8000);
  });
})();
</script>`;


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
  let out = rebrand(html);

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

  // 自检脚本放最前面，主脚本一有语法错误就能立刻显示出来
  if (!out.includes('__YUNYUE_BOOT_DIAG__')) {
    out = out.replace(/<head[^>]*>/, (tag) => tag + DIAG_SCRIPT);
  }

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
