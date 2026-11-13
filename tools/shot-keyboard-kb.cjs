#!/usr/bin/env node
/**
 * 妯℃嫙鐪熸満鐨勬柊閿洏閾捐矾锛歐ebView 灏哄鍏ㄧ▼涓嶅彉锛孞ava 鍙€愬抚璋冪敤 window.__appKeyboardInset(dp)銆?
 * 妫€鏌ユ瘡涓€甯э細
 *   1) 瑙嗗彛 / .app-container / .chat-main-area 鐨勭洅瀛愬拰浣嶇疆閮戒笉鍙橈紙=> 澹佺焊涓嶅彲鑳藉姩锛?
 *   2) 杈撳叆鏍忓簳杈?== 瑙嗗彛楂樺害 - 閿洏楂樺害锛堣窡鎵嬶紝涓嶈惤鍚庯級
 *   3) 鏀惰捣鏃跺悓鏍烽€愬抚鍥炰綅锛屼笖鏁存鍗曡皟锛堜笉鍏佽鍥炲脊/鏉ュ洖璺筹級
 *   4) 娑堟伅鍖哄湪璐村簳鐘舵€佷笅濮嬬粓璐寸潃搴?
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

const KB_MAX = 344;   // 390x844 鐨勬墜鏈轰笂閿洏澶ф杩欎箞楂橈紙CSS px = dp锛?
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

  // 妯℃嫙 Java onPageFinished锛氳ˉ android-shell 绫伙紝鍒囧埌鑱婂ぉ椤碉紝濉炰竴灞忔秷鎭?
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

  // 键盘现在由页面内的 rAF 逐帧逼近目标（单帧最多 dt*4px），
  // 所以「设置完立刻断言」不再成立，必须先等它收敛到位再读。
  const probeRaw = async () => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: PROBE });
    return JSON.parse(r.result.result.value);
  };
  const setKb = async (kb, maxMs = 1500) => {
    await send('Runtime.evaluate', { expression: `window.__appKeyboardInset(${kb});` });
    const t0 = Date.now();
    let last = await probeRaw();
    while (Date.now() - t0 < maxMs) {
      const shown = Math.abs(Number.parseFloat(last.kb || '0') || 0);
      if (Math.abs(shown - kb) <= 0.6) return last;
      await sleep(30);
      last = await probeRaw();
    }
    return last;
  };


  const rows = [];
  const step = async (kb) => {
    // 鐪熸満涓婅繖涓€姝ユ槸 Java 鍦?onProgress 閲岃皟 evaluateJavascript锛堝悓涓€甯э級
    rows.push(await setKb(kb));
  };

  for (let i = 0; i <= STEPS; i += 1) await step((KB_MAX * i) / STEPS);
  for (let i = STEPS; i >= 0; i -= 1) await step((KB_MAX * i) / STEPS);

  // 涓€娆℃€ц烦鍙樺満鏅細Android 10 娌℃湁閫愬抚鍔ㄧ敾銆佷釜鍒?ROM 涔熶笉娲惧彂涓棿杩涘害锛?
  // 閿洏楂樺害鏄粠 0 鐩存帴璺冲埌 344 鐨勩€傝繖绉嶃€屼竴姝ュ埌浣嶃€嶅悓鏍峰繀椤昏创搴曘€佷笉鑳借惤鍚庛€?
  await setKb(0);
  const jumpStart = await probeRaw();
  // 一步跳到 344（Android 10 / 部分 ROM 不给中间帧）：单帧最多 dt*4px，
  // 必须在几帧里摊开，不能一帧闪到底；中间帧自身也要自洽（不能撕裂）。
  await send('Runtime.evaluate', { expression: `window.__appKeyboardInset(${KB_MAX});` });
  await sleep(34);
  const jumpMid = await probeRaw();
  const jumpIn = await setKb(KB_MAX);
  const jumpOut = await setKb(0);
  const jumpGap = Math.abs(jumpIn.inputBottom - (jumpIn.inner - KB_MAX));
  const midKb = Math.abs(Number.parseFloat(jumpMid.kb || '0') || 0);
  const midSelf = Math.abs(jumpMid.inputBottom - (jumpMid.inner - midKb)) <= 1;
  const midMoved = jumpMid.inputBottom < jumpStart.inputBottom - 1;
  const midNotDone = midKb > 1 && midKb < KB_MAX - 40;
  const jumpOk = jumpGap <= 1 && jumpIn.atBottom <= 2 && jumpOut.atBottom <= 2
    && midSelf && midMoved && midNotDone;
  console.log(`jump 0->${KB_MAX}: input.bottom=${jumpIn.inputBottom} expect=${jumpIn.inner - KB_MAX} atBottom=${jumpIn.atBottom} / back atBottom=${jumpOut.atBottom}`);
  console.log(`  step-limit @1frame: kb=${midKb.toFixed(0)} (expect 1..${KB_MAX - 40}) self-consistent=${midSelf} ${jumpOk ? 'OK' : 'FAIL'}`);
  console.log(`jump 0->${KB_MAX}: input.bottom=${jumpIn.inputBottom} expect=${jumpIn.inner - KB_MAX} atBottom=${jumpIn.atBottom} / back atBottom=${jumpOut.atBottom} ${jumpOk ? 'OK' : 'FAIL'}`);

  // 銆屾洿澶氬姛鑳姐€嶉潰鏉匡細鎵撳紑鏃惰璐村埌閿洏涓婃柟锛屽叧鍥炲幓涔嬪悗蹇呴』閲嶆柊钘忓埌瑙嗗彛澶栵紙涓嶈兘闇蹭竴鎴級
  // 序号防乱序：键盘动画期间 evaluateJavascript 一帧一发，晚到的旧帧必须被丢掉，
  // 否则 --kb 会「升—降—升」来回翻，屏幕上就是输入框乱跳。
  await setKb(0);
  await send('Runtime.evaluate', { expression: `window.__appKeyboardInset(${KB_MAX}, 7000);` });
  await sleep(300);
  const seqHi = await probeRaw();
  await send('Runtime.evaluate', { expression: `window.__appKeyboardInset(0, 6999);` });
  await sleep(300);
  const seqStale = await probeRaw();
  const seqHiKb = Math.abs(Number.parseFloat(seqHi.kb || '0') || 0);
  const seqStaleKb = Math.abs(Number.parseFloat(seqStale.kb || '0') || 0);
  const seqOk = Math.abs(seqHiKb - KB_MAX) <= 1 && seqStaleKb >= KB_MAX - 1;
  await send('Runtime.evaluate', { expression: `window.__appKeyboardInset(0, 7001);` });
  await sleep(400);
  console.log(`stale frame: new kb=${seqHiKb.toFixed(0)} then stale(seq-1) kb=${seqStaleKb.toFixed(0)} (expect stay ${KB_MAX}) ${seqOk ? 'OK' : 'FAIL'}`);

  // Chromium 的滚动锚定会在布局后自己改 scrollTop，和页面每帧的 scrollTop = scrollHeight 抢方向盘
  const anchorRes = await send('Runtime.evaluate', { returnByValue: true, expression: `getComputedStyle(document.getElementById('chat-messages')).overflowAnchor` });
  const anchorOk = anchorRes.result.result.value === 'none';
  console.log(`overflow-anchor: ${anchorRes.result.result.value} (expect none) ${anchorOk ? 'OK' : 'FAIL'}`);

  const probeNow = async () => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: PROBE });
    return JSON.parse(r.result.result.value);
  };
  await send('Runtime.evaluate', { expression: `document.getElementById('page-chat').classList.add('actions-panel-open');` });
  await sleep(700); // 绛?0.4s 鐨?transform 杩囨浮璺戝畬
  const pOpen0 = await setKb(0);
  const pOpenKb = await setKb(KB_MAX);
  await send('Runtime.evaluate', { expression: `document.getElementById('page-chat').classList.remove('actions-panel-open');` });
  await setKb(0);
  await sleep(700);
  const pBack = await probeNow();
  const panelOk = Math.abs(pOpen0.panelLift) <= 1                 // 鏃犻敭鐩橈細闈㈡澘搴曡竟璐撮〉闈㈠簳
    && Math.abs(pOpenKb.panelLift - KB_MAX) <= 1                  // 鏈夐敭鐩橈細闈㈡澘搴曡竟璐撮敭鐩橀《
    && pBack.panelTop >= pBack.inner - 1;                         // 鏀跺洖鍚庡畬鍏ㄥ湪瑙嗗彛澶?
  console.log(`panel: open kb=0 lift=${pOpen0.panelLift}(expect 0)  open kb=${KB_MAX} lift=${pOpenKb.panelLift}(expect ${KB_MAX})  closed top=${pBack.panelTop}(expect >=${pBack.inner}) ${panelOk ? 'OK' : 'FAIL'}`);

  // 鐪熸満鍏ㄩ潰灞忔湁 env(safe-area-inset-bottom)锛堢害 34px锛夛紝headless 閲屾亽涓?0锛?
  // 鐢ㄤ竴鏉′綆浼樺厛绾х殑瑙勫垯鎶婂畠妯℃嫙鍑烘潵锛氶敭鐩樺脊璧锋椂杩欐鐣欑櫧蹇呴』璁╃粰閿洏锛屽惁鍒欒緭鍏ユ鎮┖涓€鏉＄紳銆?
  await send('Runtime.evaluate', { expression: `(()=>{const s=document.createElement('style');s.id='test-safe-area';s.textContent='html.android-shell .chat-input-area{padding-bottom:44px;}';document.head.appendChild(s);})();` });
  const padOf = async () => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const e=document.querySelector('#page-chat .chat-input-area');return JSON.stringify({pad: Math.round(parseFloat(getComputedStyle(e).paddingBottom)), kbOpen: document.documentElement.classList.contains('kb-open')});})()` });
    return JSON.parse(r.result.result.value);
  };
  await setKb(0);
  const padClosed = await padOf();
  await setKb(KB_MAX);
  const padOpen = await padOf();
  await send('Runtime.evaluate', { expression: `document.getElementById('test-safe-area').remove();` });
  await setKb(0);
  const safeOk = Math.abs(padClosed.pad - 44) <= 1 && Math.abs(padOpen.pad - 10) <= 1 && padOpen.kbOpen === true;
  console.log(`safe-area: kb=0 pad=${padClosed.pad}(expect 44)  kb=${KB_MAX} pad=${padOpen.pad}(expect 10)  kb-open=${padOpen.kbOpen} ${safeOk ? 'OK' : 'FAIL'}`);

  // ---- 闈炶亰澶╅〉锛堣〃鍗?/ 缂栬緫 / 璇勮锛夊拰寮圭獥锛氶敭鐩樺脊鍑烘椂蹇呴』璁╁嚭閿洏楂樺害锛屽埆鎶婅緭鍏ユ鐩栦綇 ----
  await send('Runtime.evaluate', { expression: `(()=>{
    document.getElementById('page-chat').classList.remove('active');
    document.getElementById('page-chat-summary').classList.add('active');
  })();` });
  await setKb(KB_MAX);
  const pagePad = await (async () => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const p=document.getElementById('page-chat-summary');return JSON.stringify({pad: Math.round(parseFloat(getComputedStyle(p).paddingBottom)), chatPad: Math.round(parseFloat(getComputedStyle(document.getElementById('page-chat')).paddingBottom))});})()` });
    return JSON.parse(r.result.result.value);
  })();
  const pageOk = Math.abs(pagePad.pad - KB_MAX) <= 1 && pagePad.chatPad === 0; // 鑱婂ぉ椤典笉鑳介噸澶嶅悆涓€閬?

  await send('Runtime.evaluate', { expression: `(()=>{const ov=document.querySelector('.modal-overlay');ov.style.display='flex';})();` });
  await sleep(80);
  const modalPad = await (async () => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const ov=document.querySelector('.modal-overlay');return JSON.stringify({pad: Math.round(parseFloat(getComputedStyle(ov).paddingBottom))});})()` });
    return JSON.parse(r.result.result.value);
  })();
  const modalOk = Math.abs(modalPad.pad - KB_MAX) <= 1;

  // 瑙嗛閫氳瘽鐣岄潰锛堜篃鏄?.modal-overlay锛屼絾瀹瑰櫒鍐欐 75vh锛夊湪閿洏寮硅捣鏃惰鏀剁煯
  await send('Runtime.evaluate', { expression: `(()=>{document.getElementById('video-call-modal').style.display='flex';})();` });
  await sleep(80);
  const vc = await (async () => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const c=document.querySelector('#video-call-modal .video-call-container');const b=c.getBoundingClientRect();return JSON.stringify({h: Math.round(b.height), bottom: Math.round(b.bottom), inner: window.innerHeight});})()` });
    return JSON.parse(r.result.result.value);
  })();
  await send('Runtime.evaluate', { expression: `(()=>{document.getElementById('video-call-modal').style.display='none';})();` });
  const vcOk = vc.h <= vc.inner - KB_MAX - 39 && vc.bottom <= vc.inner - KB_MAX + 1;

  await send('Runtime.evaluate', { expression: `(()=>{
    document.querySelector('.modal-overlay').style.display='';
    document.getElementById('page-chat-summary').classList.remove('active');
    document.getElementById('page-chat').classList.add('active');
  })();` });
  await setKb(0);
  console.log(`other pages: padding-bottom=${pagePad.pad}(expect ${KB_MAX}) chat-page=${pagePad.chatPad}(expect 0) ${pageOk ? 'OK' : 'FAIL'}  | modal overlay=${modalPad.pad}(expect ${KB_MAX}) ${modalOk ? 'OK' : 'FAIL'}`);
  console.log(`video-call: container h=${vc.h}(expect <=${vc.inner - KB_MAX - 40}) bottom=${vc.bottom}(expect <=${vc.inner - KB_MAX}) ${vcOk ? 'OK' : 'FAIL'}`);

  const base = rows[0];
  let bad = 0;
  let leaks = 0;
  rows.forEach((r, i) => {
    const kb = Math.abs(Number.parseFloat(r.kb || '0') || 0);
    const gap = Math.abs(r.inputBottom - (r.inner - kb));
    const steady = r.containerH === base.containerH && r.mainTop === base.mainTop && r.mainH === base.mainH;
    const anchored = r.atBottom <= 2;
    // 銆屾洿澶氬姛鑳姐€嶉潰鏉垮叧闂椂蹇呴』鏁翠釜鍦ㄨ鍙ｄ箣澶栵紝涓嶈兘闇插嚭浠讳綍涓€鎴?
    const panelHidden = r.panelTop >= r.inner - 1;
    // 娑堟伅鍖轰笉鑳戒几杩涢敭鐩樺尯鍩?
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
  const allOk = bad === 0 && nonMono === 0 && jumpOk && panelOk && safeOk && pageOk
    && modalOk && vcOk && leaks === 0 && seqOk && anchorOk;
  console.log(allOk
    ? `\n[PASS] ${rows.length} frames: input tracks keyboard (step-limited, stale frames dropped), wallpaper frozen, panel never leaks, safe-area yields, other pages & modals clear the keyboard`
    : `\n[FAIL] ${bad} frames off, ${nonMono} reversals, jump=${jumpOk}, panel=${panelOk}, safe=${safeOk}, pages=${pageOk}, modal=${modalOk}, vc=${vcOk}, leaks=${leaks}, seq=${seqOk}, anchor=${anchorOk}`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'shot-chat-kb.png'), Buffer.from(shot.result.data, 'base64'));

  ws.close(); child.kill(); server.close();
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
