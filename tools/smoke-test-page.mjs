#!/usr/bin/env node
/**
 * 页面启动冒烟测试：用本机的 Chrome/Edge（headless）真实跑一遍打包后的页面，
 * 确认「开屏能消失、能进首页、没有未捕获异常」。
 *
 * 为什么需要：像漏写 </script> 这种错误，浏览器只会静默白屏，
 * 表现就是「一直卡在开屏」，光看代码和 APK 大小都发现不了。
 * 这个脚本用 CDP 真实等待初始化跑完，然后再看页面状态。
 *
 * 用法：node tools/smoke-test-page.mjs [wwwDir]
 *   默认目录 android/app/src/main/assets/www
 * 要求 Node >= 22（用内置 WebSocket），本机装有 Chrome 或 Edge。
 * 注意：这是本地工具，不参与 CI（CI 上跑 check-html-syntax.mjs 就够了）。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function findBrowser() {
  const fromEnv = process.env.CHROME_PATH || process.env.EDGE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function startServer(root) {
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/') pathname = '/index.html';
    const file = path.join(root, pathname);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('需要 Node 22+（内置 WebSocket），当前: ' + process.version);
    process.exit(1);
  }
  const browser = findBrowser();
  if (!browser) {
    console.error('没找到 Chrome/Edge，可用 CHROME_PATH 环境变量指定');
    process.exit(1);
  }

  const wwwDir = path.resolve(process.cwd(), process.argv[2] || 'android/app/src/main/assets/www');
  if (!fs.existsSync(path.join(wwwDir, 'index.html'))) {
    console.error('目录里没有 index.html: ' + wwwDir + '\n先跑 node tools/prepare-apk-assets.mjs');
    process.exit(1);
  }

  const { server, port } = await startServer(wwwDir);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yy-smoke-'));
  const pageUrl = 'http://127.0.0.1:' + port + '/index.html';

  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=0',
    '--window-size=420,900',
    pageUrl,
  ], { stdio: 'ignore' });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let cdpPort = null;
  for (let i = 0; i < 80; i += 1) {
    if (fs.existsSync(portFile)) {
      // Windows 上这个文件刚写出来时会被浏览器短暂锁住，读失败就多试几次
      try {
        const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
        if (first) { cdpPort = first; break; }
      } catch (error) { /* 文件还在被占用，下一轮再读 */ }
    }
    await sleep(250);
  }
  if (!cdpPort) {
    console.error('浏览器没起来（拿不到 DevToolsActivePort）');
    child.kill(); server.close(); process.exit(1);
  }

  let target = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await getJson('http://127.0.0.1:' + cdpPort + '/json/list');
      target = (list || []).find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (target) break;
    } catch (error) { /* not ready */ }
    await sleep(250);
  }
  if (!target) {
    console.error('拿不到 CDP page target');
    child.kill(); server.close(); process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  let seq = 0;
  const send = (method, params) => new Promise((resolve) => {
    const id = (seq += 1);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      exceptions.push((d.exception && d.exception.description) || d.text || 'unknown');
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  await send('Runtime.enable');

  console.log('浏览器: ' + browser);
  console.log('页面:   ' + pageUrl);
  console.log('等 9 秒让初始化跑完 ...');
  await sleep(9000);

  const probe = `(() => {
    const s = document.getElementById('app-splash-screen');
    const cs = s ? getComputedStyle(s) : null;
    const status = document.querySelector('.splash-status-text');
    const active = document.querySelector('.page.active');
    return JSON.stringify({
      splashExists: !!s,
      splashDisplay: cs ? cs.display : null,
      splashOpacity: cs ? cs.opacity : null,
      statusText: status ? status.textContent.trim() : null,
      activePageId: active ? active.id : null,
      dexieType: typeof Dexie,
      markdownItType: typeof markdownit,
      indexedDbType: typeof indexedDB,
      visibleTextHead: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120) : ''
    });
  })()`;

  const response = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
  const value = response.result && response.result.result && response.result.result.value;
  const state = JSON.parse(value || '{}');

  ws.close();
  child.kill();
  server.close();

  const checks = [];
  const splashGone = !state.splashExists || state.splashDisplay === 'none' || state.splashOpacity === '0';
  checks.push([splashGone, '开屏已关闭（未关闭 = 初始化没走完）']);
  checks.push([!!state.activePageId, '有激活页面: ' + (state.activePageId || '无')]);
  checks.push([state.dexieType === 'function', 'Dexie 已加载: ' + state.dexieType]);
  checks.push([state.markdownItType === 'function', 'markdown-it 已加载: ' + state.markdownItType]);
  checks.push([exceptions.length === 0, '无未捕获异常' + (exceptions.length ? ': ' + exceptions[0] : '')]);

  console.log('');
  let failed = 0;
  for (const [ok, label] of checks) {
    if (!ok) failed += 1;
    console.log((ok ? '[PASS] ' : '[FAIL] ') + label);
  }
  console.log('页面可见文字: ' + (state.visibleTextHead || '(空)'));

  if (failed) {
    console.error('\n冒烟测试失败：页面没能正常启动。');
    process.exit(1);
  }
  console.log('\n冒烟测试通过：页面能正常启动到首页。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
