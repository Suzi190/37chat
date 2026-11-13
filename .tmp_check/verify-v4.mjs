// 桌面 v4 验证：尺寸回归原版 + 网格吸附 + 让位 + 行数不限 + 持久化
// 直接测部署用的单文件（file://），也就是用户双击打开的那份
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';

const CDP_PORT = Number(process.env.CDP_PORT_V4 || 9340);
const APP_URL = process.env.APP_URL || 'file:///D:/37chat/37chat-deployed.html';
const OUT = process.env.OUT_DIR || 'd:/37chat/.tmp_check';

const consoleErrors = [];

async function findPageTarget() {
  let lastError = null;
  let lastList = null;
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      lastList = pages.map(t => t.url);
      // 忽略扩展 / 同步弹窗等页面，优先用我们自己的 about:blank 或目标页面
      const page = pages.find(t => /^(file:|http:\/\/127\.0\.0\.1|http:\/\/localhost)/.test(t.url))
        || pages.find(t => t.url === 'about:blank')
        || pages[0];
      if (page) return page;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`找不到可调试的页面目标（lastError=${lastError && (lastError.message + ' / ' + (lastError.cause && lastError.cause.message))} list=${JSON.stringify(lastList)}）`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) (this.handlers.get(msg.method) || []).forEach(fn => fn(msg.params));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }
}

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
const cdp = new Cdp(ws);

cdp.on('Runtime.consoleAPICalled', (params) => {
  if (params.type !== 'error') return;
  const text = (params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
  consoleErrors.push(`console.error: ${text}`);
});
cdp.on('Runtime.exceptionThrown', (params) => {
  const d = params.exceptionDetails || {};
  consoleErrors.push(`exception: ${d.text} ${d.exception?.description || ''}`.trim());
});
cdp.on('Log.entryAdded', (params) => {
  const e = params.entry || {};
  if (e.level === 'error') consoleErrors.push(`log: ${e.text} (${e.url || ''})`);
});

await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 430, height: 932, deviceScaleFactor: 2, mobile: true
});

const evaluate = async (expression, awaitPromise = false) => {
  const res = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true
  });
  if (res.exceptionDetails) {
    throw new Error(`页面内异常: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
  }
  return res.result.value;
};

const waitFor = async (expression, timeout = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch { /* 页面正在跳转 */ }
    await sleep(300);
  }
  throw new Error(`等待超时: ${expression}`);
};

const shot = async (name) => {
  await evaluate(`(() => {
    let s = document.getElementById('__freeze_anim');
    if (!s) { s = document.createElement('style'); s.id = '__freeze_anim'; document.head.appendChild(s); }
    s.textContent = '*, *::before, *::after { animation-play-state: paused !important; }';
  })()`);
  await sleep(150);
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(`${OUT}/${name}.png`, Buffer.from(res.data, 'base64'));
  await evaluate(`(() => { const s = document.getElementById('__freeze_anim'); if (s) s.remove(); })()`);
};

const shotEl = async (selector, name) => {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    return true;
  })()`);
  await sleep(800);
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  if (!box || !box.width || !box.height) return;
  await evaluate(`(() => {
    let s = document.getElementById('__freeze_anim');
    if (!s) { s = document.createElement('style'); s.id = '__freeze_anim'; document.head.appendChild(s); }
    s.textContent = '*, *::before, *::after { animation-play-state: paused !important; }';
  })()`);
  await sleep(150);
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 }
  });
  await writeFile(`${OUT}/${name}.png`, Buffer.from(res.data, 'base64'));
  await evaluate(`(() => { const s = document.getElementById('__freeze_anim'); if (s) s.remove(); })()`);
};

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ->  ' + extra : ''}`);
};

await cdp.send('Page.navigate', { url: APP_URL });
await waitFor(`document.querySelectorAll('.home-page-grid .home-app').length > 0`, 45000);
await sleep(2000);
await evaluate(`(async () => {
  state.ui.homeLayout = null;
  renderHomeDesktop();
  await saveUiState();
  return true;
})()`, true);
await cdp.send('Page.reload');
await waitFor(`document.querySelectorAll('.home-page-grid .home-app').length > 0`, 45000);
await sleep(2000);

// 页面内测试工具（按住长拖 -> 松手吸附）
await evaluate(`(() => {
  const stateRef = () => state.ui.homeLayout;
  window.__v4 = {
    layout: () => stateRef(),
    item: (key) => stateRef().pages.flatMap(p => p.items).find(i => i.kind === 'app' && i.key === key),
    keyAt: (col, row) => {
      const hit = stateRef().pages[0].items.find(i => i.x === col && i.y === row);
      return hit ? (hit.key || hit.id) : null;
    },
    noOverlap: () => {
      let ok = true;
      (stateRef().pages || []).forEach(page => {
        const occupied = new Set();
        page.items.forEach(item => {
          if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) { ok = false; return; }
          const span = getHomeItemSpan(item);
          for (let dx = 0; dx < span.cols; dx += 1) {
            for (let dy = 0; dy < span.rows; dy += 1) {
              const key = (item.x + dx) + ',' + (item.y + dy);
              if (occupied.has(key)) ok = false;
              occupied.add(key);
            }
          }
        });
      });
      return ok;
    },
    dragTo: async (key, col, row) => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const pageEl = document.querySelector('#home-pages-track .home-page');
      const canvas = pageEl.querySelector('.home-page-grid');
      const metrics = getHomeGridMetrics(canvas);
      const topOffset = getHomeCanvasTopOffset(canvas);
      const el = canvas.querySelector('.home-app[data-app-key="' + key + '"]');
      if (!el) return { error: 'missing element: ' + key };
      const canvasRect = canvas.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      const fromLeft = rect.left - canvasRect.left;
      const fromTop = rect.top - canvasRect.top;
      const toX = startX + ((metrics.padX + col * metrics.colUnit) - fromLeft);
      const toY = startY + ((topOffset + row * metrics.rowUnit) - fromTop);
      const opts = (x, y) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 11, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y });

      el.dispatchEvent(new PointerEvent('pointerdown', opts(startX, startY)));
      await wait(780);
      const editing = document.getElementById('page-home').classList.contains('home-editing');
      for (let i = 1; i <= 16; i += 1) {
        document.dispatchEvent(new PointerEvent('pointermove', opts(startX + (toX - startX) * i / 16, startY + (toY - startY) * i / 16)));
        await wait(28);
      }
      document.dispatchEvent(new PointerEvent('pointerup', opts(toX, toY)));
      await wait(950);
      const item = window.__v4.item(key);
      return {
        editing,
        x: item ? item.x : null,
        y: item ? item.y : null,
        noOverlap: window.__v4.noOverlap(),
        canvasHeight: Math.round(canvas.getBoundingClientRect().height),
        pageScrollHeight: Math.round(pageEl.scrollHeight),
        draggingCleaned: !document.querySelector('.home-app.dragging')
      };
    }
  };
  return true;
})()`, true);

// 1. 尺寸是否回到原版（这是用户最在意的“图1 的样子”）
const dims = await evaluate(`(() => {
  const canvas = document.querySelector('#home-pages-track .home-page .home-page-grid');
  const cr = canvas.getBoundingClientRect();
  const icon = document.querySelector('.home-app .icon-wrapper').getBoundingClientRect();
  const banner = document.getElementById('home-banner').getBoundingClientRect();
  const avatar = document.querySelector('.home-profile-avatar').getBoundingClientRect();
  const mainText = document.getElementById('home-main-text');
  const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const profile = document.getElementById('home-profile-widget');
  const apps = Array.from(document.querySelectorAll('.home-app'));
  return {
    icon: Math.round(icon.width),
    banner: Math.round(banner.height),
    avatar: Math.round(avatar.width),
    mainFont: parseFloat(getComputedStyle(mainText).fontSize),
    rootFont,
    lefts: Array.from(new Set(apps.map(a => Math.round(a.getBoundingClientRect().left - cr.left)))).sort((a, b) => a - b),
    gap: Math.round(Math.min.apply(null, apps.map(a => a.getBoundingClientRect().top)) - profile.getBoundingClientRect().bottom),
    version: state.ui.homeLayout.version,
    pages: document.querySelectorAll('#home-pages-track .home-page').length,
    apps: apps.length,
    noOverlap: window.__v4.noOverlap()
  };
})()`);
check('部署版已是最新布局（version=4）', dims.version === 4, `version=${dims.version}`);
check('横幅回到原版 220px', dims.banner === 220, `banner=${dims.banner}px`);
check('头像回到原版 80px', dims.avatar >= 80 && dims.avatar <= 86, `avatar=${dims.avatar}px`);
check('昵称回到原版 1.4rem', Math.abs(dims.mainFont - dims.rootFont * 1.4) < 0.3, `font=${dims.mainFont}/${(dims.rootFont * 1.4).toFixed(1)}`);
check('图标 60px + 4 列对齐', dims.icon === 60 && dims.lefts.length === 4, `icon=${dims.icon} lefts=${dims.lefts.join('/')}`);
check('图标行与资料卡间距 ≈ 40px', dims.gap >= 34 && dims.gap <= 46, `gap=${dims.gap}`);
check('默认 1 页 8 图标且无重叠', dims.pages === 1 && dims.apps === 8 && dims.noOverlap === true, `pages=${dims.pages} apps=${dims.apps}`);
await shot('v4-01-default');

// 2. 拖到空白处（第 3 行第 1 列）—— 松手吸附整格，其它图标上移补位
const beforeAt00 = await evaluate(`window.__v4.keyAt(0, 0)`);
const d1 = await evaluate(`window.__v4.dragTo('chat', 0, 2)`, true);
check('长按进入编辑并可拖动', d1.editing === true && d1.draggingCleaned === true, `editing=${d1.editing} cleaned=${d1.draggingCleaned}`);
check('拖到第 3 行松手吸附到整格 (0,2)', d1.x === 0 && d1.y === 2, `x=${d1.x} y=${d1.y}`);
check('放置后所有图标仍无重叠', d1.noOverlap === true, '');
await shot('v4-02-drag-row3');

// 3. 拖回第 1 格 -> 原来占位的图标被挤走（真机让位语义，不是交换）
const midAt00 = await evaluate(`window.__v4.keyAt(0, 0)`);
const d2 = await evaluate(`window.__v4.dragTo('chat', 0, 0)`, true);
const afterAt00 = await evaluate(`window.__v4.keyAt(0, 0)`);
const afterCount = await evaluate(`window.__v4.layout().pages.flatMap(p => p.items).length`);
check('拖回第 1 格吸附 (0,0)', d2.x === 0 && d2.y === 0, `x=${d2.x} y=${d2.y}`);
check('原占位图标让位（不是交换）', afterAt00 === 'chat' && !!midAt00 && midAt00 !== 'chat' && d2.noOverlap === true,
  `mid=${midAt00} after=${afterAt00}`);
check('让位后图标一个不少', afterCount === 8, `items=${afterCount}`);
await shot('v4-03-push-down');

// 4. 放到第 4 行：行数不限，画布跟着变高
const d3 = await evaluate(`window.__v4.dragTo('chat', 3, 3)`, true);
check('可放到第 4 行（行数不设上限）', d3.x === 3 && d3.y === 3, `x=${d3.x} y=${d3.y}`);
check('画布随内容自动增高', d3.pageScrollHeight >= 700 && d3.noOverlap === true, `scrollHeight=${d3.pageScrollHeight}`);
await shot('v4-04-drag-row4');

// 5. 刷新后位置保持，且全部是整数格坐标
await sleep(700);
await evaluate(`location.reload()`);
await waitFor(`document.querySelectorAll('.home-page-grid .home-app').length > 0`, 45000);
await sleep(2000);
const persisted = await evaluate(`(() => {
  const layout = state.ui.homeLayout;
  const chat = layout.pages.flatMap(p => p.items).find(i => i.kind === 'app' && i.key === 'chat');
  return {
    version: layout.version,
    x: chat ? chat.x : null,
    y: chat ? chat.y : null,
    allInteger: layout.pages.every(p => p.items.every(i => !Number.isFinite(i.x) || (Number.isInteger(i.x) && Number.isInteger(i.y))))
  };
})()`);
check('刷新后坐标保持不变 (3,3)', persisted.x === 3 && persisted.y === 3, `x=${persisted.x} y=${persisted.y}`);
check('坐标全部为整数格', persisted.allInteger === true, `version=${persisted.version}`);

// 6. 跨页拖动：拖到屏幕右边缘停留自动翻页，再在第 2 页松手
const crossPage = await evaluate(`(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  document.getElementById('page-home').classList.add('home-editing');
  document.getElementById('home-edit-add-page').click();
  await wait(900);
  scrollToHomePage(0, 'auto');
  await wait(900);
  const track = document.getElementById('home-pages-track');
  const firstPage = document.querySelectorAll('#home-pages-track .home-page')[0];
  const canvas = firstPage.querySelector('.home-page-grid');
  const el = canvas.querySelector('.home-app[data-app-key="characters"]');
  const rect = el.getBoundingClientRect();
  const sx = rect.left + rect.width / 2;
  const sy = rect.top + rect.height / 2;
  const opts = (x, y) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 21, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y });

  el.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy)));
  await wait(780);
  const trackRect = track.getBoundingClientRect();
  const edgeX = trackRect.right - 10;
  for (let i = 1; i <= 8; i += 1) {
    document.dispatchEvent(new PointerEvent('pointermove', opts(sx + (edgeX - sx) * i / 8, sy)));
    await wait(30);
  }
  await wait(1000);
  const scrolled = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const centerX = trackRect.left + trackRect.width / 2;
  const centerY = trackRect.top + 320;
  for (let i = 1; i <= 10; i += 1) {
    document.dispatchEvent(new PointerEvent('pointermove', opts(edgeX + (centerX - edgeX) * i / 10, sy + (centerY - sy) * i / 10)));
    await wait(30);
  }
  await wait(250);
  document.dispatchEvent(new PointerEvent('pointerup', opts(centerX, centerY)));
  await wait(1100);

  const layout = state.ui.homeLayout;
  const onPage0 = layout.pages[0].items.some(i => i.kind === 'app' && i.key === 'characters');
  const onPage1 = layout.pages[1].items.some(i => i.kind === 'app' && i.key === 'characters');
  const apps = layout.pages.flatMap(p => p.items).filter(i => i.kind === 'app').length;
  return { scrolled, onPage0, onPage1, apps, pages: layout.pages.length };
})()`, true);
check('拖到右边缘停住可自动翻页', crossPage.scrolled >= 1, `scrolled=${crossPage.scrolled}`);
check('跨页拖放成功（图标搬到第 2 页）', crossPage.onPage1 === true && crossPage.onPage0 === false, `p0=${crossPage.onPage0} p1=${crossPage.onPage1}`);
check('跨页后图标总数不变', crossPage.apps === 8, `apps=${crossPage.apps}`);
await shot('v4-05-cross-page');

// 回到第 1 页、退出编辑模式再做小屏检查
await evaluate(`(() => { setHomeEditing(false); scrollToHomePage(0, 'auto'); return true; })()`, true);
await sleep(900);

// 7. 320px 小屏（图标 60 / 4 列 / 不横向溢出）
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });
await sleep(1000);
const narrow = await evaluate(`(() => {
  const pageEl = document.querySelectorAll('#home-pages-track .home-page')[0];
  const canvas = pageEl.querySelector('.home-page-grid');
  const cr = canvas.getBoundingClientRect();
  const icon = pageEl.querySelector('.home-app .icon-wrapper').getBoundingClientRect();
  const banner = document.getElementById('home-banner').getBoundingClientRect();
  const lefts = Array.from(new Set(Array.from(pageEl.querySelectorAll('.home-app')).map(a => Math.round(a.getBoundingClientRect().left - cr.left)))).sort((a, b) => a - b);
  return {
    icon: Math.round(icon.width),
    banner: Math.round(banner.height),
    editing: document.getElementById('page-home').classList.contains('home-editing'),
    lefts,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  };
})()`);
check('320px 宽仍是 60px 图标 + 4 列', narrow.icon === 60 && narrow.lefts.length === 4, `icon=${narrow.icon} lefts=${narrow.lefts.join('/')}`);
check('320px 宽无横向溢出', narrow.overflowX === false, `overflowX=${narrow.overflowX}`);
await shot('v4-05-narrow-320');

// 8. 五个新内置小组件：只作为「添加小组件」面板里的选项，不会自动出现在桌面
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await sleep(900);
const resetHome = await evaluate(`(async () => {
  state.ui.homeLayout = null;
  renderHomeDesktop();
  const layout = getHomeLayout();
  while (layout.pages.length < 6) layout.pages.push({ id: generateUniqueId(), items: [] });
  layout.pages.forEach(page => { page.items = []; });
  layout.activeIndex = 0;
  state.ui.homeLayout = layout;
  renderHomeDesktop();
  await saveUiState();
  return { pages: layout.pages.length, widgets: document.querySelectorAll('.home-widget').length };
})()`, true);
check('重置后桌面没有任何小组件（新组件不会自动上桌面）', resetHome.widgets === 0, `widgets=${resetHome.widgets}`);

const widgetSheet = await evaluate(`(() => {
  openHomeWidgetSheet();
  const list = Array.from(document.querySelectorAll('.home-sheet-item')).map(it => ({
    type: it.dataset.widgetType,
    name: (it.querySelector('.home-sheet-item-name') || {}).textContent || '',
    sizes: Array.from(it.querySelectorAll('.home-sheet-size-btn')).map(b => b.textContent)
  }));
  closeHomeWidgetSheet();
  return { list };
})()`);
const sheetByType = {};
widgetSheet.list.forEach(it => { sheetByType[it.type] = it; });
check('「添加小组件」面板里出现六个新组件',
  ['polaroid-duo', 'polaroid-trio', 'diary-calendar', 'little-joys', 'photo-single', 'note-chat'].every(t => !!sheetByType[t]),
  widgetSheet.list.map(i => i.type).join('/'));
check('面板尺寸选项为 2×2 / 4×2 / 4×4 / 4×2 / 2×2 / 4×1',
  (sheetByType['polaroid-duo'] || {}).sizes?.join() === '2×2'
  && (sheetByType['polaroid-trio'] || {}).sizes?.join() === '4×2'
  && (sheetByType['diary-calendar'] || {}).sizes?.join() === '4×4'
  && (sheetByType['little-joys'] || {}).sizes?.join() === '4×2'
  && (sheetByType['photo-single'] || {}).sizes?.join() === '2×2'
  && (sheetByType['note-chat'] || {}).sizes?.join() === '4×1',
  `duo=${(sheetByType['polaroid-duo'] || {}).sizes} trio=${(sheetByType['polaroid-trio'] || {}).sizes} cal=${(sheetByType['diary-calendar'] || {}).sizes} joys=${(sheetByType['little-joys'] || {}).sizes} photo=${(sheetByType['photo-single'] || {}).sizes} note=${(sheetByType['note-chat'] || {}).sizes}`);

const addSheetWidget = (type, sizeText, pageIndex) => evaluate(`(() => {
  const layout = getHomeLayout();
  layout.activeIndex = ${pageIndex};
  state.ui.homeLayout = layout;
  openHomeWidgetSheet();
  const item = document.querySelector('.home-sheet-item[data-widget-type="${type}"]');
  if (!item) { closeHomeWidgetSheet(); return { error: 'no sheet item' }; }
  const btn = Array.from(item.querySelectorAll('.home-sheet-size-btn')).find(b => b.textContent === '${sizeText}');
  if (!btn) { closeHomeWidgetSheet(); return { error: 'no size button' }; }
  btn.click();
  return { ok: !document.getElementById('home-widget-sheet').classList.contains('active') };
})()`);

const addDuo = await addSheetWidget('polaroid-duo', '2×2', 0);
await sleep(500);
const addTrio = await addSheetWidget('polaroid-trio', '4×2', 1);
await sleep(500);
const addCal = await addSheetWidget('diary-calendar', '4×4', 2);
await sleep(500);
const addJoys = await addSheetWidget('little-joys', '4×2', 3);
await sleep(500);
const addPhoto = await addSheetWidget('photo-single', '2×2', 4);
await sleep(500);
const addNote = await addSheetWidget('note-chat', '4×1', 5);
await sleep(900);
check('点面板尺寸按钮即可把六个组件分别加到六页',
  addDuo.ok === true && addTrio.ok === true && addCal.ok === true && addJoys.ok === true && addPhoto.ok === true && addNote.ok === true,
  `${JSON.stringify([addDuo, addTrio, addCal, addJoys, addPhoto, addNote])}`);

const widgetGeom = await evaluate(`(() => {
  const lum = (color) => {
    const m = String(color).match(/[\\d.]+/g);
    return m ? Math.round(Number(m[0]) * 0.299 + Number(m[1]) * 0.587 + Number(m[2]) * 0.114) : 255;
  };
  // 无色磨砂玻璃：只看白色 alpha（r=g=b=255），确认没有灰/蓝色调
  const glassOf = (el) => {
    const card = el.querySelector('.hw-glass');
    if (!card) return { missing: true };
    const cs = getComputedStyle(card);
    const stops = (cs.backgroundImage.match(/rgba?\\([^)]+\\)/g) || []).map(s => s.match(/[\\d.]+/g).map(Number));
    const textEl = card.querySelector('.hwlj-title') || card.querySelector('.hwcal-dates span') || card.querySelector('.hwph-date')
      || card.querySelector('.hwno-text') || card.querySelector('.hwno-bubble');
    return {
      blur: cs.backdropFilter || cs.webkitBackdropFilter || '',
      stops: stops.map(s => s.join('/')).join(' '),
      colorless: stops.length > 0 && stops.every(s => Math.abs(s[0] - s[1]) < 2 && Math.abs(s[1] - s[2]) < 2 && s[0] > 248),
      alpha: stops.length ? Math.max(...stops.map(s => (s[3] === undefined ? 1 : s[3]))) : 1,
      textLum: textEl ? lum(getComputedStyle(textEl).color) : -1
    };
  };
  const info = (type) => {
    const el = document.querySelector('.home-widget[data-widget-type="' + type + '"]');
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    return {
      cls: el.className,
      w: Math.round(r.width),
      h: Math.round(r.height),
      slots: el.querySelectorAll('[data-photo]').length,
      cards: el.querySelectorAll('.hwp-card').length,
      plain: el.classList.contains('hw-plain'),
      bg: getComputedStyle(el).backgroundColor,
      shadow: getComputedStyle(el).boxShadow,
      title: (el.querySelector('.hwlj-title') || {}).textContent || '',
      sub: (el.querySelector('.hwlj-sub') || {}).textContent || '',
      action: el.querySelectorAll('.hwlj-action').length,
      stamp: (el.querySelector('.hwph-date') || {}).textContent || '',
      hint: (el.querySelector('.hwph-hint') || {}).textContent || '',
      bubbles: Array.from(el.querySelectorAll('.hwno-bubble')).map(b => b.textContent),
      textOverflow: (() => {
        const t = el.querySelector('.hwno-text');
        return t ? getComputedStyle(t).textOverflow : '';
      })(),
      // 药丸形：圆角半径 ≥ 高度的一半
      pillShape: Array.from(el.querySelectorAll('.hwno-bubble')).every(b => {
        const r = parseFloat(getComputedStyle(b).borderTopLeftRadius);
        return Number.isFinite(r) && r >= b.offsetHeight / 2 - 1;
      }),
      // 气泡铺满整行（只让出圆头像的位置）
      pillWide: Array.from(el.querySelectorAll('.hwno-row')).every((row) => {
        const bubble = row.querySelector('.hwno-bubble');
        return !!bubble && bubble.offsetWidth >= row.offsetWidth - 24;
      }),
      // 圆头像压在气泡端头（两者要叠在一起，不是并排）
      avatarOverlap: Array.from(el.querySelectorAll('.hwno-row')).every((row) => {
        const avatar = row.querySelector('.hwno-avatar');
        const bubble = row.querySelector('.hwno-bubble');
        if (!avatar || !bubble) return false;
        const a = avatar.getBoundingClientRect();
        const b = bubble.getBoundingClientRect();
        return b.left < a.right - 4 && a.left < b.right && a.top < b.bottom && b.top < a.bottom;
      }),
      avatarRound: Array.from(el.querySelectorAll('.hwno-avatar')).map(a => getComputedStyle(a).borderRadius),
      avatarBox: Array.from(el.querySelectorAll('.hwno-avatar')).map(a => Math.round(a.getBoundingClientRect().width)),
      bubbleFits: Array.from(el.querySelectorAll('.hwno-text')).every(t => t.scrollWidth <= t.clientWidth + 1),
      rowInside: (() => {
        // 两行是歪的，会稍微压到 .home-widget 的 10px 内边距上，但必须落在整块组件盒子里
        const c = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll('.hwno-row')).every(r => {
          const b = r.getBoundingClientRect();
          return b.left >= c.left - 1 && b.right <= c.right + 1 && b.top >= c.top - 1 && b.bottom <= c.bottom + 1;
        });
      })(),
      slotFills: (() => {
        const card = el.querySelector('.hwph');
        const slot = el.querySelector('.hwph > .hwp-slot');
        if (!card || !slot) return false;
        const c = card.getBoundingClientRect();
        const s = slot.getBoundingClientRect();
        return Math.abs(s.width - c.width) < 1.5 && Math.abs(s.height - c.height) < 1.5;
      })(),
      glass: glassOf(el),
      overflowY: el.scrollHeight > el.clientHeight + 2,
      overflowX: el.scrollWidth > el.clientWidth + 2
    };
  };
  const calEl = document.querySelector('.home-widget[data-widget-type="diary-calendar"]');
  const rail = calEl && calEl.querySelector('.hwcal-rail');
  const panel = calEl && calEl.querySelector('.hwcal-panel');
  const rr = rail && rail.getBoundingClientRect();
  const pr = panel && panel.getBoundingClientRect();
  const span44 = getHomeItemSpan({ kind: 'widget', size: '4x4' });
  return {
    duo: info('polaroid-duo'),
    trio: info('polaroid-trio'),
    cal: info('diary-calendar'),
    joy: info('little-joys'),
    photo: info('photo-single'),
    note: info('note-chat'),
    calendarRight: !!(rr && pr && pr.left >= rr.right - 1),
    dates: calEl ? calEl.querySelectorAll('.hwcal-dates span').length : 0,
    today: calEl ? calEl.querySelectorAll('.hwcal-dates .is-today').length : 0,
    chips: calEl ? Array.from(calEl.querySelectorAll('.hwcal-chip')).map(c => c.textContent) : [],
    span44,
    layoutSizes: state.ui.homeLayout.pages.map(p => p.items.filter(i => i.kind === 'widget').map(i => i.size)),
    slotsInLayout: state.ui.homeLayout.pages.map(p => p.items.filter(i => i.kind === 'widget').length)
  };
})()`);
check('2×2 拍立得：尺寸 2 列 2 行 + 两张卡片', /hw-size-2x2/.test(widgetGeom.duo.cls || '') && widgetGeom.duo.h === 185 && widgetGeom.duo.cards === 2,
  `cls=${widgetGeom.duo.cls} h=${widgetGeom.duo.h} cards=${widgetGeom.duo.cards}`);
check('4×2 拍立得：整行宽 + 三张卡片', /hw-size-4x2/.test(widgetGeom.trio.cls || '') && widgetGeom.trio.h === 185 && widgetGeom.trio.cards === 3,
  `cls=${widgetGeom.trio.cls} w=${widgetGeom.trio.w} cards=${widgetGeom.trio.cards}`);
check('4×4 大组件：占满 4 列 4 行（785 高 385）', /hw-size-4x4/.test(widgetGeom.cal.cls || '') && widgetGeom.cal.h === 385 && widgetGeom.cal.w === widgetGeom.trio.w,
  `cls=${widgetGeom.cal.cls} w=${widgetGeom.cal.w} h=${widgetGeom.cal.h}`);
check('4×4 右侧是日历：7 列日期 + 今天高亮 + 左列图片位', widgetGeom.calendarRight === true && widgetGeom.dates === 14 && widgetGeom.today === 1 && widgetGeom.cal.slots === 5,
  `right=${widgetGeom.calendarRight} dates=${widgetGeom.dates} today=${widgetGeom.today} slots=${widgetGeom.cal.slots}`);
check('4×4 日历含时间/电量/存储信息条', widgetGeom.chips.length === 4 && widgetGeom.chips.some(t => /Time/.test(t)) && widgetGeom.chips.some(t => /Battery/.test(t)),
  widgetGeom.chips.join(' | '));
check('六个组件都写进布局且尺寸正确', widgetGeom.layoutSizes.map(s => s.join()).join(';') === '2x2;4x2;4x4;4x2;2x2;4x1', widgetGeom.layoutSizes.map(s => s.join()).join(';'));
check('组件内容不溢出容器', widgetGeom.duo.overflowY !== true && widgetGeom.trio.overflowX !== true && widgetGeom.cal.overflowY !== true && widgetGeom.joy.overflowY !== true && widgetGeom.photo.overflowY !== true && widgetGeom.note.overflowY !== true,
  `duo=${widgetGeom.duo.overflowY} trio=${widgetGeom.trio.overflowX} cal=${widgetGeom.cal.overflowY} joy=${widgetGeom.joy.overflowY} photo=${widgetGeom.photo.overflowY} note=${widgetGeom.note.overflowY}`);
const isTransparent = (bg) => !bg || bg === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(bg);
check('两个拍立得外层透明（没有白色底板/阴影）',
  isTransparent(widgetGeom.duo.bg) && isTransparent(widgetGeom.trio.bg)
  && widgetGeom.duo.shadow === 'none' && widgetGeom.trio.shadow === 'none'
  && widgetGeom.duo.plain === true && widgetGeom.trio.plain === true,
  `duo=${widgetGeom.duo.bg}/${widgetGeom.duo.shadow} trio=${widgetGeom.trio.bg}/${widgetGeom.trio.shadow}`);
check('手帐日历也改成自己画的玻璃卡（外层不再有白底板）',
  widgetGeom.cal.plain === true && isTransparent(widgetGeom.cal.bg) && widgetGeom.cal.shadow === 'none'
  && widgetGeom.cal.glass.missing !== true,
  `plain=${widgetGeom.cal.plain} bg=${widgetGeom.cal.bg} shadow=${widgetGeom.cal.shadow}`);

// 无色磨砂玻璃：三层都要「只有白 alpha + 背景模糊 + 深色字」，不能有灰色调
const glassKeys = ['joy', 'cal', 'photo', 'note'];
check('小确幸 / 手帐日历 / 照片 / 小纸条都是无色磨砂玻璃（无色偏 + 模糊 + 深色字）',
  glassKeys.every(k => {
    const g = widgetGeom[k].glass;
    return g && g.missing !== true && /blur/.test(g.blur) && g.colorless === true && g.alpha < 0.8 && g.textLum >= 0 && g.textLum < 130;
  }),
  glassKeys.map(k => `${k}[${widgetGeom[k].glass.stops} | ${widgetGeom[k].glass.blur} | lum=${widgetGeom[k].glass.textLum}]`).join('  '));

// 2×2 照片组件：一整张照片 + 右上角日期
check('2×2 照片：卡片内铺满图片位 + 日期小牌 + 空态提示',
  /hw-size-2x2/.test(widgetGeom.photo.cls || '') && widgetGeom.photo.h === 185
  && widgetGeom.photo.slots === 1 && widgetGeom.photo.slotFills === true
  && /^\d{1,2}\/\d{1,2} 周[日一二三四五六]$/.test(widgetGeom.photo.stamp)
  && widgetGeom.photo.hint === '点一下放照片',
  `h=${widgetGeom.photo.h} slots=${widgetGeom.photo.slots} fills=${widgetGeom.photo.slotFills} stamp="${widgetGeom.photo.stamp}" hint="${widgetGeom.photo.hint}"`);

// 拍立得卡片形状：竖长方形 + 旋转后仍完整落在容器内
const polaroidShape = await evaluate(`(() => {
  const pick = (sel) => Array.from(document.querySelectorAll(sel)).map(card => {
    const r = card.getBoundingClientRect();
    const box = card.parentElement.getBoundingClientRect();
    return {
      w: Math.round(card.offsetWidth),
      h: Math.round(card.offsetHeight),
      ratio: +(card.offsetHeight / card.offsetWidth).toFixed(2),
      inside: r.left >= box.left - 1 && r.top >= box.top - 1 && r.right <= box.right + 1 && r.bottom <= box.bottom + 1
    };
  });
  return { duo: pick('.hwpl-2x2 .hwp-card'), trio: pick('.hwpl-4x2 .hwp-card') };
})()`);
const shapeList = [...polaroidShape.duo, ...polaroidShape.trio];
check('拍立得卡片是竖长方形（高/宽 ≥ 1.3）且旋转后不出容器',
  shapeList.length === 5 && shapeList.every(c => c.ratio >= 1.3) && shapeList.every(c => c.inside === true),
  shapeList.map(c => `${c.w}x${c.h}=${c.ratio}${c.inside ? '' : '(越界)'}`).join('  '));

// 小确幸（4×2）：尺寸、三张方图、标题副标题、圆形按钮、毛玻璃底 + 第一格点阵
check('4×2 小确幸：整行宽 + 三张方图 + 标题/副标题 + 圆形按钮',
  /hw-size-4x2/.test(widgetGeom.joy.cls || '') && widgetGeom.joy.w === widgetGeom.trio.w && widgetGeom.joy.h === 185
  && widgetGeom.joy.slots === 3 && widgetGeom.joy.cards === 0
  && widgetGeom.joy.title === 'Little joys' && widgetGeom.joy.sub === 'Make every day count.'
  && widgetGeom.joy.action === 1,
  `w=${widgetGeom.joy.w} h=${widgetGeom.joy.h} slots=${widgetGeom.joy.slots} title="${widgetGeom.joy.title}" sub="${widgetGeom.joy.sub}" action=${widgetGeom.joy.action}`);

const joysLook = await evaluate(`(() => {
  const el = document.querySelector('.home-widget[data-widget-type="little-joys"]');
  if (!el) return { missing: true };
  const card = el.querySelector('.hwlj');
  const dots = el.querySelector('.hwp-slot-dots');
  const slotBoxes = Array.from(el.querySelectorAll('.hwp-slot')).map(s => {
    const r = s.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  const cs = getComputedStyle(card);
  const ds = dots ? getComputedStyle(dots) : null;
  const cardRect = card.getBoundingClientRect();
  const innerRect = el.querySelector('.home-widget-inner').getBoundingClientRect();
  return {
    bgImage: cs.backgroundImage,
    blur: cs.backdropFilter || cs.webkitBackdropFilter || '',
    color: cs.color,
    dotsImage: ds ? ds.backgroundImage : '',
    dotsIcon: dots && dots.querySelector('i') ? getComputedStyle(dots.querySelector('i')).display : 'none',
    fits: cardRect.width <= innerRect.width + 1 && cardRect.height <= innerRect.height + 1,
    slotBoxes
  };
})()`);
check('小确幸是半透明毛玻璃卡（透出壁纸）+ 第一格点阵 + 三格近正方形',
  joysLook.missing !== true
  && /linear-gradient/.test(joysLook.bgImage) && /blur/.test(joysLook.blur)
  && /radial-gradient/.test(joysLook.dotsImage) && joysLook.dotsIcon === 'none'
  && joysLook.fits === true
  && joysLook.slotBoxes.length === 3
  && joysLook.slotBoxes.every(b => b.w > 0 && Math.abs(b.h / b.w - 1) < 0.25),
  `blur=${joysLook.blur} fits=${joysLook.fits} slots=${joysLook.slotBoxes.map(b => `${b.w}x${b.h}`).join(' ')}`);

const joysAction = await evaluate(`(() => {
  const el = document.querySelector('.home-widget[data-widget-type="little-joys"]');
  const before = (el.querySelector('.hwlj-sub') || {}).textContent || '';
  const btn = el.querySelector('.hwlj-action');
  if (btn) btn.click();
  const after = (el.querySelector('.hwlj-sub') || {}).textContent || '';
  const item = state.ui.homeLayout.pages[3].items.find(i => i.type === 'little-joys');
  return { before, after, noteIndex: item && item.data ? item.data.noteIndex : null };
})()`);
check('小确幸右下角圈子点一下换一句并写进布局',
  joysAction.before === 'Make every day count.' && joysAction.after === 'Small things, big days.' && joysAction.noteIndex === 1,
  `${joysAction.before} -> ${joysAction.after} (noteIndex=${joysAction.noteIndex})`);


// 图片位可替换：写入 dataURL 后渲染成 <img> 并落回布局
const widgetSwap = await evaluate(`(() => {
  const layout = state.ui.homeLayout;
  const duo = layout.pages[0].items.find(i => i.type === 'polaroid-duo');
  if (!duo) return { missing: true };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#e07e79"/></svg>';
  duo.data = duo.data || {};
  duo.data.photoA = 'data:image/svg+xml;base64,' + btoa(svg);
  state.ui.homeLayout = layout;
  renderHomeDesktop();
  const slot = document.querySelector('.hwpl-2x2 [data-photo="photoA"]');
  const savedItem = state.ui.homeLayout.pages[0].items.find(i => i.type === 'polaroid-duo');
  return {
    hasPhoto: !!slot && slot.classList.contains('has-photo'),
    imgs: slot ? slot.querySelectorAll('img').length : 0,
    persisted: !!(savedItem && typeof savedItem.data.photoA === 'string' && savedItem.data.photoA.indexOf('data:image') === 0)
  };
})()`);
check('图片位可换图（写入 dataURL 后渲染为 img 并留在布局里）',
  widgetSwap.hasPhoto === true && widgetSwap.imgs === 1 && widgetSwap.persisted === true,
  `hasPhoto=${widgetSwap.hasPhoto} imgs=${widgetSwap.imgs} persisted=${widgetSwap.persisted}`);

// 照片组件（2×2）：换图后整块铺满，空态提示自动隐藏
const photoSwap = await evaluate(`(() => {
  const layout = state.ui.homeLayout;
  const item = layout.pages[4].items.find(i => i.type === 'photo-single');
  if (!item) return { missing: true };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#7fa0c0"/></svg>';
  item.data = item.data || {};
  item.data.photo = 'data:image/svg+xml;base64,' + btoa(svg);
  state.ui.homeLayout = layout;
  renderHomeDesktop();
  const slot = document.querySelector('.hwph [data-photo="photo"]');
  const hint = document.querySelector('.hwph-hint');
  return {
    hasPhoto: !!slot && slot.classList.contains('has-photo'),
    imgs: slot ? slot.querySelectorAll('img').length : 0,
    hintHidden: hint ? getComputedStyle(hint).display === 'none' : false
  };
})()`);
check('照片组件换图后铺满卡片并隐藏空态提示',
  photoSwap.hasPhoto === true && photoSwap.imgs === 1 && photoSwap.hintHidden === true,
  JSON.stringify(photoSwap));

// 4×1 小纸条：两条铺满整行的药丸气泡，圆头像压在气泡两端，整体无色磨砂玻璃
const NOTE_TEXT_A = '˚₊ ♡ 私たちの永遠の幸福 @Avery ♡ ₊˚';
const NOTE_TEXT_B = '˚₊ ♡ I love you #Evan .♡ ♡ ₊˚';
check('4×1 小纸条：整行药丸气泡 + 头像压住气泡两端 + 居中小字',
  /hw-size-4x1/.test(widgetGeom.note.cls || '') && widgetGeom.note.w === widgetGeom.trio.w && widgetGeom.note.h === 85
  && widgetGeom.note.slots === 2
  && widgetGeom.note.avatarRound.length === 2 && widgetGeom.note.avatarRound.every(r => r === '50%')
  && widgetGeom.note.avatarBox.every(w => w >= 28 && w <= 32)
  && widgetGeom.note.avatarOverlap === true
  && widgetGeom.note.pillShape === true && widgetGeom.note.pillWide === true
  && widgetGeom.note.bubbles.length === 2
  && widgetGeom.note.bubbles[0] === NOTE_TEXT_A
  && widgetGeom.note.bubbles[1] === NOTE_TEXT_B
  && widgetGeom.note.textOverflow === 'ellipsis'
  && widgetGeom.note.bubbleFits === true && widgetGeom.note.rowInside === true,
  `w=${widgetGeom.note.w} h=${widgetGeom.note.h} slots=${widgetGeom.note.slots} avatars=${widgetGeom.note.avatarBox.join('/')} overlap=${widgetGeom.note.avatarOverlap} pill=${widgetGeom.note.pillShape}/${widgetGeom.note.pillWide} bubbles=${JSON.stringify(widgetGeom.note.bubbles)} fits=${widgetGeom.note.bubbleFits} inside=${widgetGeom.note.rowInside}`);

const noteEdit = await evaluate(`(() => {
  const el = document.querySelector('.home-widget[data-widget-type="note-chat"]');
  if (!el) return { missing: true };
  const first = el.querySelectorAll('.hwno-bubble')[0];
  if (!first) return { noBubble: true };
  first.click();
  const overlay = document.querySelector('.hwno-editor');
  if (!overlay) return { noEditor: true };
  const card = overlay.querySelector('.hwno-editor-card');
  const cs = getComputedStyle(card);
  // 注意：getComputedStyle 是活对象，元素移除后就空了，必须先取成字符串
  const bgImage = cs.backgroundImage;
  const blur = cs.backdropFilter || cs.webkitBackdropFilter || '';
  const input = overlay.querySelector('.hwno-editor-input');
  const prefill = input.value;
  input.value = '今天也要好好吃饭呀';
  overlay.querySelector('.hwno-editor-btn.is-primary').click();
  const closed = !document.querySelector('.hwno-editor');
  const after = (document.querySelector('.home-widget[data-widget-type="note-chat"] .hwno-bubble') || {}).textContent || '';
  const item = state.ui.homeLayout.pages[5].items.find(i => i.type === 'note-chat');
  const stops = (bgImage.match(/rgba?\\([^)]+\\)/g) || []).map(s => s.match(/[\\d.]+/g).map(Number));
  return {
    prefill, closed, after,
    saved: item && item.data ? item.data.textA : null,
    glassColorless: stops.length > 0 && stops.every(s => Math.abs(s[0] - s[1]) < 2 && Math.abs(s[1] - s[2]) < 2 && s[0] > 248),
    blur
  };
})()`);
check('点气泡弹出无色磨砂玻璃改字层（预填当前字）→ 确定后写回布局并重渲染',
  noteEdit.missing !== true && noteEdit.prefill === NOTE_TEXT_A
  && noteEdit.closed === true && noteEdit.after === '今天也要好好吃饭呀'
  && noteEdit.saved === '今天也要好好吃饭呀'
  && noteEdit.glassColorless === true && /blur/.test(noteEdit.blur || ''),
  `prefill="${noteEdit.prefill}" closed=${noteEdit.closed} after="${noteEdit.after}" saved="${noteEdit.saved}" glass=${noteEdit.glassColorless}/${noteEdit.blur}`);

const noteEsc = await evaluate(`(() => {
  const el = document.querySelector('.home-widget[data-widget-type="note-chat"]');
  const second = el.querySelectorAll('.hwno-bubble')[1];
  second.click();
  const overlay = document.querySelector('.hwno-editor');
  if (!overlay) return { noEditor: true };
  overlay.querySelector('.hwno-editor-input').value = '不要保存这句';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const closed = !document.querySelector('.hwno-editor');
  const text = (document.querySelectorAll('.home-widget[data-widget-type="note-chat"] .hwno-bubble')[1] || {}).textContent || '';
  const item = state.ui.homeLayout.pages[5].items.find(i => i.type === 'note-chat');
  return { closed, text, saved: item && item.data ? item.data.textB : null };
})()`);
check('改字层按 Esc 取消：不写入布局', noteEsc.closed === true && noteEsc.text === NOTE_TEXT_B && noteEsc.saved === undefined,
  JSON.stringify(noteEsc));

// 截图：四个组件各自的样子 + 「添加小组件」面板
await evaluate(`(() => {
  const item = state.ui.homeLayout.pages[3].items.find(i => i.type === 'little-joys');
  if (item && item.data) item.data.noteIndex = 0; // 截图用回默认那句
  const photo = state.ui.homeLayout.pages[4].items.find(i => i.type === 'photo-single');
  if (photo && photo.data) delete photo.data.photo; // 截图用空态（玻璃底最清楚）
  // 小纸条：文字回默认，两个圆头像放两张底色，截图更接近参考图
  const note = state.ui.homeLayout.pages[5].items.find(i => i.type === 'note-chat');
  if (note) {
    note.data = note.data || {};
    delete note.data.textA;
    delete note.data.textB;
    const avatar = (bg, fg) => 'data:image/svg+xml;base64,' + btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">'
      + '<rect width="80" height="80" fill="' + bg + '"/>'
      + '<circle cx="40" cy="31" r="13" fill="' + fg + '"/>'
      + '<rect x="17" y="50" width="46" height="34" rx="15" fill="' + fg + '"/></svg>'
    );
    note.data.noteA = avatar('#c9d6e4', '#7d8ea3');
    note.data.noteB = avatar('#e3d3cd', '#a98a80');
  }
  renderHomeDesktop();
  return true;
})()`);
await sleep(400);
await shotEl('.home-widget[data-widget-type="little-joys"]', 'v4-11-widget-little-joys-wallpaper');
await shotEl('.home-widget[data-widget-type="photo-single"]', 'v4-13-widget-photo-wallpaper');
await shotEl('.home-widget[data-widget-type="diary-calendar"]', 'v4-14-widget-calendar-wallpaper');
await shotEl('.home-widget[data-widget-type="note-chat"]', 'v4-15-widget-note-wallpaper');
await evaluate(`(() => {
  document.querySelectorAll('.home-page-empty').forEach(el => { el.style.display = 'none'; });
  // 临时给桌面加一层蓝灰底，方便看出拍立得/毛玻璃外层是透明的
  document.querySelectorAll('.home-page').forEach(p => {
    p.dataset.prevBg = p.style.background;
    p.style.background = 'linear-gradient(135deg, #dbe6f0 0%, #c3d2e2 100%)';
  });
  return true;
})()`);
await sleep(400);
await shotEl('.home-widget[data-widget-type="polaroid-duo"]', 'v4-06-widget-2x2');
await shotEl('.home-widget[data-widget-type="polaroid-trio"]', 'v4-07-widget-4x2');
await shotEl('.home-widget[data-widget-type="diary-calendar"]', 'v4-08-widget-4x4');
await shotEl('.home-widget[data-widget-type="little-joys"]', 'v4-10-widget-little-joys');
await shotEl('.home-widget[data-widget-type="photo-single"]', 'v4-12-widget-photo-2x2');
await shotEl('.home-widget[data-widget-type="note-chat"]', 'v4-16-widget-note-4x1');
await evaluate(`(() => {
  document.querySelectorAll('.home-page').forEach(p => { p.style.background = p.dataset.prevBg || ''; delete p.dataset.prevBg; });
  return true;
})()`);
await evaluate(`scrollToHomePage(0, 'auto')`);
await sleep(900);
await evaluate(`openHomeWidgetSheet()`);
await sleep(700);
await shot('v4-09-widget-sheet');
await evaluate(`closeHomeWidgetSheet()`);

await sleep(300);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await sleep(700);

check('无 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failures = results.filter(r => !r.ok);
const summary = results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  ->  ' + r.extra : ''}`).join('\n');
await writeFile(`${OUT}/verify-v4-result.txt`, `${summary}\n\n==== ${results.length - failures.length}/${results.length} 通过 ====\n`, 'utf8');
console.log(`\n==== ${results.length - failures.length}/${results.length} 通过 ====`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(` - ${f.name} ${f.extra}`));
  process.exitCode = 1;
}
ws.close();


