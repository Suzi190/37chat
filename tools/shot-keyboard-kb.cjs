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
    msgBottom: Math.round(box.getBoundingClientRect().bottom),
    inputBottom: Math.round(foot.bottom),
    panelTop: Math.round(panel.top),
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

  // 一次性跳变场景：Android 10 没有逐帧动画、个别 ROM 也不派发中间进度，
  // 键盘高度是从 0 直接跳到 344 的。这种「一步到位」同样必须贴底、不能落后。
  await step(0);
  await step(KB_MAX);
  const jumpIn = rows[rows.length - 1];
  await step(0);
  const jumpOut = rows[rows.length - 1];
  const jumpGap = Math.abs(jumpIn.inputBottom - (jumpIn.inner - KB_MAX));
  const jumpOk = jumpGap <= 1 && jumpIn.atBottom <= 2 && jumpOut.atBottom <= 2;
  console.log(`jump 0->${KB_MAX}: input.bottom=${jumpIn.inputBottom} expect=${jumpIn.inner - KB_MAX} atBottom=${jumpIn.atBottom} / back atBottom=${jumpOut.atBottom} ${jumpOk ? 'OK' : 'FAIL'}`);

  // 「更多功能」面板：打开时要贴到键盘上方，关回去之后必须重新藏到视口外（不能露一截）
  const probeNow = async () => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: PROBE });
    return JSON.parse(r.result.result.value);
  };
  await send('Runtime.evaluate', { expression: `document.getElementById('page-chat').classList.add('actions-panel-open');` });
  await sleep(700); // 等 0.4s 的 transform 过渡跑完
  await send('Runtime.evaluate', { expression: 'window.__appKeyboardInset(0);' });
  await sleep(60);
  const pOpen0 = await probeNow();
  await send('Runtime.evaluate', { expression: `window.__appKeyboardInset(${KB_MAX});` });
  await sleep(60);
  const pOpenKb = await probeNow();
  await send('Runtime.evaluate', { expression: `document.getElementById('page-chat').classList.remove('actions-panel-open');window.__appKeyboardInset(0);` });
  await sleep(700);
  const pBack = await probeNow();
  const panelOk = Math.abs(pOpen0.panelLift) <= 1                 // 无键盘：面板底边贴页面底
    && Math.abs(pOpenKb.panelLift - KB_MAX) <= 1                  // 有键盘：面板底边贴键盘顶
    && pBack.panelTop >= pBack.inner - 1;                         // 收回后完全在视口外
  console.log(`panel: open kb=0 lift=${pOpen0.panelLift}(expect 0)  open kb=${KB_MAX} lift=${pOpenKb.panelLift}(expect ${KB_MAX})  closed top=${pBack.panelTop}(expect >=${pBack.inner}) ${panelOk ? 'OK' : 'FAIL'}`);

  const base = rows[0];
  let bad = 0;
  let leaks = 0;
  rows.forEach((r, i) => {
    const kb = Math.abs(Number.parseFloat(r.kb || '0') || 0);
    const gap = Math.abs(r.inputBottom - (r.inner - kb));
    const steady = r.containerH === base.containerH && r.mainTop === base.mainTop && r.mainH === base.mainH;
    const anchored = r.atBottom <= 2;
    // 「更多功能」面板关闭时必须整个在视口之外，不能露出任何一截
    const panelHidden = r.panelTop >= r.inner - 1;
    // 消息区不能伸进键盘区域
    const msgInside = r.msgBottom <= r.inner - kb + 1;
    if (gap > 1 || !steady || !anchored) bad += 1;
    if (!panelHidden || !msgInside) leaks += 1;
    if (i < 3 || i === STEPS || i === STEPS + 1 || i === rows.length - 1) {
      console.log(`f${String(i).padStart(3)} kb=${r.kb.padStart(8)} box(h=${r.mainH},top=${r.mainTop}) msgH=${r.msgH} msgBottom=${r.msgBottom} input.bottom=${r.inputBottom} expect=${r.inner - kb} panelTop=${r.panelTop} ${gap > 1 ? 'INPUT-GAP ' : ''}${steady ? '' : 'BOX-MOVED '}${anchored ? '' : 'NOT-AT-BOTTOM '}${panelHidden ? '' : 'PANEL-LEAK '}${msgInside ? '' : 'MSG-INTO-KB'}`);
    }
  });

  const up = rows.slice(0, STEPS + 1).map((r) => r.inputBottom);
  const down = rows.slice(STEPS + 1, 2 * STEPS + 2).map((r) => r.inputBottom);
  let nonMono = 0;
  for (let i = 1; i < up.length; i += 1) if (up[i] > up[i - 1] + 1) nonMono += 1;
  for (let i = 1; i < down.length; i += 1) if (down[i] < down[i - 1] - 1) nonMono += 1;

  console.log(`\nSHELL android-shell=${base.shell} AndroidBridge=${base.bridge}`);
  console.log(`box steady: ${rows.every((r) => r.containerH === base.containerH && r.mainTop === base.mainTop && r.mainH === base.mainH) ? 'yes (viewport & wallpaper never move)' : 'NO'}`);
  console.log(`monotonic: ${nonMono === 0 ? 'yes (no bounce back)' : 'NO (' + nonMono + ' reversals)'}`);
  console.log(`no leak into keyboard area: ${leaks === 0 ? 'yes' : 'NO (' + leaks + ' frames leaked)'}`);
  console.log(bad === 0 && nonMono === 0 && jumpOk && panelOk && leaks === 0
    ? `\n[PASS] ${rows.length} frames: input tracks keyboard, wallpaper frozen, panel never leaks`
    : `\n[FAIL] ${bad} frames off, ${nonMono} reversals, jump=${jumpOk}, panel=${panelOk}, leaks=${leaks}`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'shot-chat-kb.png'), Buffer.from(shot.result.data, 'base64'));

  ws.close(); child.kill(); server.close();
  process.exit(bad === 0 && nonMono === 0 && jumpOk && panelOk && leaks === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
