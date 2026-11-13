// 临时诊断：清空本地存储后打印默认布局坐标与渲染位置
import { setTimeout as sleep } from 'node:timers/promises';

const CDP_PORT = Number(process.env.CDP_PORT || 9334);
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181/';

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression, awaitPromise = false) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''));
  return res.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: APP_URL });
await sleep(1500);
await evaluate(`localStorage.clear()`);
await send('Page.reload');
await sleep(2500);
await sleep(1000);

const info = await evaluate(`(() => {
  const canvas = document.querySelector('.home-page-grid');
  const cr = canvas.getBoundingClientRect();
  const items = state.ui.homeLayout.pages[0].items.map(i => ({ kind: i.kind, key: i.key || i.type, x: i.x, y: i.y }));
  const els = Array.from(canvas.children).filter(c => c !== document.getElementById('home-profile-widget')).map(c => {
    const r = c.getBoundingClientRect();
    return { id: c.dataset.appKey || c.dataset.widgetId || c.className, left: Math.round(r.left - cr.left), top: Math.round(r.top - cr.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return {
    canvasWidth: Math.round(cr.width),
    canvasLeft: Math.round(cr.left),
    canvasHeight: Math.round(cr.height),
    profileHeight: document.getElementById('home-profile-widget').offsetHeight,
    layout: items,
    els
  };
})()`);
console.log(JSON.stringify(info, null, 2));
ws.close();
