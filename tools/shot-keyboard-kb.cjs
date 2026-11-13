#!/usr/bin/env node
/**
 * 模拟真机的新键盘链路：WebView 尺寸全程不变，Java 只逐帧调用 window.__appKeyboardInset(dp)。
 * 检查每一帧：
 *   1) 视口 / .app-container / .chat-main-area 的盒子和位置都不变（=> 壁纸不可能动）
 *   2) 输入栏底边 == 视口高度 - 键盘高度（跟手，不落后）
 *   3) 收起时同样逐帧回位，且整段单调（不允许回弹/来回跳）
 *   4) 消息区在贴底状态下始终贴着底
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(__dirname, '../android/app/src/main/assets/www');
const OUT = path.join(process.env.TEMP || '.', 'yy-build');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}
const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
});

const PROBE = `(()=>{
  const box = document.getElementById('chat-messages');
  const main = document.querySelector('#page-chat .chat-main-area').getBoundingClientRect();
  const foot = document.querySelector('#page-chat .chat-input-area').getBoundingClientRect();
  const cont = document.querySelector('.app-container').getBoundingClientRect();
  const panel = document.getElementById('chat-actions-panel').getBoundingClientRect();
  return JSON.stringify({
    inner: window.innerHeight,
    kb: document.documentElement.style.getPropertyValue('--kb').trim(),
    containerH: Math.round(cont.height),
    mainTop: Math.round(main.top),
    mainH: Math.round(main.height),
    msgH: Math.round(box.clientHeight),
    inputBottom: Math.round(foot.bottom),
    panelLift: Math.round(window.innerHeight - panel.bottom),
    atBottom: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight),
    bridge: typeof window.AndroidBridge,
    shell: document.documentElement.classList.contains('android-shell')
  });
})()`;

const KB_MAX = 344;   // 390x844 的手机上键盘大概这么高（CSS px = dp）
const STEPS = 20;


(async () => {
  const { server, port } = await serve();
  const cdpPort = 9341;
  const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + path.join(OUT, 'shot-profile-kb'), '--window-size=390,900', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await getJson('http://127.0.0.1:' + cdpPort + '/json/list');
      target = (list || []).find((t) => t.type === 'page');
      if (target) break;
    } catch (e) { /* wait */ }
    await sleep(250);
  }
  if (!target) { console.error('no target'); child.kill(); server.close(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  const send = (method, params) => new Promise((res) => { const id = (seq += 1); pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` });
  await sleep(9000);

  // 模拟 Java onPageFinished：补 android-shell 类，切到聊天页，塞一屏消息
  await send('Runtime.evaluate', { expression: `(()=>{
    document.documentElement.classList.add('android-shell');
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    document.getElementById('page-chat').classList.add('active');
    const box = document.getElementById('chat-messages');
    box.innerHTML = Array.from({length:40}).map((_,i)=>'<div style="height:56px;margin:6px 0;background:#fff8;border-radius:10px;display:flex;align-items:center;justify-content:center">msg '+(i+1)+'</div>').join('');
    box.scrollTop = box.scrollHeight;
  })()` });
  await sleep(700);

  const api = await send('Runtime.evaluate', { returnByValue: true, expression: 'typeof window.__appKeyboardInset' });
  console.log('typeof window.__appKeyboardInset =', api.result.result.value);

  const rows = [];
  const step = async (kb) => {
    // 真机上这一步是 Java 在 onProgress 里调 evaluateJavascript（同一帧）
    await send('Runtime.evaluate', { expression: `window.__appKeyboardInset(${kb});` });
    await sleep(34);
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: PROBE });
    rows.push(JSON.parse(r.result.result.value));
  };

  for (let i = 0; i <= STEPS; i += 1) await step((KB_MAX * i) / STEPS);
  for (let i = STEPS; i >= 0; i -= 1) await step((KB_MAX * i) / STEPS);

  const base = rows[0];
  let bad = 0;
  rows.forEach((r, i) => {
    const kb = Math.abs(Number.parseFloat(r.kb || '0') || 0);
    const gap = Math.abs(r.inputBottom - (r.inner - kb));
    const steady = r.containerH === base.containerH && r.mainTop === base.mainTop && r.mainH === base.mainH;
    const anchored = r.atBottom <= 2;
    if (gap > 1 || !steady || !anchored) bad += 1;
    if (i < 3 || i === STEPS || i === STEPS + 1 || i === rows.length - 1) {
      console.log(`f${String(i).padStart(3)} kb=${r.kb.padStart(8)} box(h=${r.mainH},top=${r.mainTop}) msgH=${r.msgH} input.bottom=${r.inputBottom} expect=${r.inner - kb} panelLift=${r.panelLift} atBottom=${r.atBottom} ${gap > 1 ? 'INPUT-GAP ' : ''}${steady ? '' : 'BOX-MOVED '}${anchored ? '' : 'NOT-AT-BOTTOM'}`);
    }
  });

  const up = rows.slice(0, STEPS + 1).map((r) => r.inputBottom);
  const down = rows.slice(STEPS + 1).map((r) => r.inputBottom);
  let nonMono = 0;
  for (let i = 1; i < up.length; i += 1) if (up[i] > up[i - 1] + 1) nonMono += 1;
  for (let i = 1; i < down.length; i += 1) if (down[i] < down[i - 1] - 1) nonMono += 1;

  console.log(`\nSHELL android-shell=${base.shell} AndroidBridge=${base.bridge}`);
  console.log(`box steady: ${rows.every((r) => r.containerH === base.containerH && r.mainTop === base.mainTop && r.mainH === base.mainH) ? 'yes (viewport & wallpaper never move)' : 'NO'}`);
  console.log(`monotonic: ${nonMono === 0 ? 'yes (no bounce back)' : 'NO (' + nonMono + ' reversals)'}`);
  console.log(bad === 0 && nonMono === 0
    ? `\n[PASS] ${rows.length} frames: input tracks keyboard exactly, wallpaper/container frozen, no bounce`
    : `\n[FAIL] ${bad} frames off, ${nonMono} reversals`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'shot-chat-kb.png'), Buffer.from(shot.result.data, 'base64'));

  ws.close(); child.kill(); server.close();
  process.exit(bad === 0 && nonMono === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
