// 临时验证脚本：无头 Edge + CDP，检查桌面系统（分页 / 拖拽 / 小组件 / 持久化）
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';

const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181/';
const OUT = process.env.OUT_DIR || 'd:/37chat/.tmp_check';
const WIDTH = Number(process.env.VP_WIDTH || 430);
const HEIGHT = Number(process.env.VP_HEIGHT || 932);

const consoleErrors = [];

async function findPageTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error('找不到可调试的页面目标');
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
      if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach(fn => fn(msg.params));
      }
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
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true
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

const waitFor = async (expression, timeout = 25000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch { /* 页面可能正在跳转 */ }
    await sleep(300);
  }
  throw new Error(`等待超时: ${expression}`);
};

const shot = async (name) => {
  // 无头模式下，无限 wiggle 动画会让合成器迟迟不出稳定帧，截图前先冻结动画
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

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ->  ' + extra : ''}`);
};

await cdp.send('Page.navigate', { url: APP_URL });
await waitFor(`document.querySelectorAll('.home-page-grid .home-app').length > 0`, 30000);
await sleep(1200);
// 每次从干净的默认桌面开始（布局存在 IndexedDB 里，localStorage.clear() 清不掉）
await evaluate(`(async () => {
  state.ui.homeLayout = null;
  if (typeof renderHomeDesktop === 'function') renderHomeDesktop();
  await saveUiState();
  return true;
})()`, true);
await cdp.send('Page.reload');
await waitFor(`document.querySelectorAll('.home-page-grid .home-app').length > 0`, 30000);
await sleep(1200);

// 1. 默认桌面
const initial = await evaluate(`(() => ({
  pages: document.querySelectorAll('#home-pages-track .home-page').length,
  apps: Array.from(document.querySelectorAll('.home-page-grid .home-app')).map(a => a.dataset.appKey),
  dots: document.querySelectorAll('#home-page-dots .home-page-dot').length,
  profileInFirstGrid: !!document.querySelector('#home-pages-track .home-page:nth-child(1) .home-page-grid #home-profile-widget'),
  banner: !!document.getElementById('home-banner'),
  mainText: (document.getElementById('home-main-text') || {}).textContent || '',
  subText: (document.getElementById('home-sub-text') || {}).textContent || '',
  widgets: window.HomeWidgets.list().map(d => d.type),
  canvasPosition: getComputedStyle(document.querySelector('.home-page-grid')).position,
  appPosition: (() => { const a = document.querySelector('.home-app'); return a ? getComputedStyle(a).position : ''; })(),
  iconSize: (() => { const el = document.querySelector('.home-app .icon-wrapper'); return el ? Math.round(el.getBoundingClientRect().width) : 0; })(),
  bannerHeight: (() => { const el = document.getElementById('home-banner'); return el ? Math.round(el.getBoundingClientRect().height) : 0; })(),
  avatarSize: (() => { const el = document.querySelector('.home-profile-avatar'); return el ? Math.round(el.getBoundingClientRect().width) : 0; })(),
  mainFontSize: (() => { const el = document.getElementById('home-main-text'); return el ? parseFloat(getComputedStyle(el).fontSize) : 0; })(),
  rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
  allPositioned: state.ui.homeLayout.pages[0].items.every(i => Number.isFinite(i.x) && Number.isFinite(i.y)),
  firstAppTopOffset: (() => {
    const app = document.querySelector('.home-app');
    const canvas = document.querySelector('.home-page-grid');
    return app && canvas ? Math.round(app.getBoundingClientRect().top - canvas.getBoundingClientRect().top) : -1;
  })(),
  gapBelowProfile: (() => {
    const canvas = document.querySelector('.home-page-grid');
    const profile = document.getElementById('home-profile-widget');
    const app = document.querySelector('.home-app');
    if (!canvas || !profile || !app) return -1;
    const cr = canvas.getBoundingClientRect();
    const profileBottom = profile.getBoundingClientRect().bottom - cr.top;
    const appTop = app.getBoundingClientRect().top - cr.top;
    return Math.round(appTop - profileBottom);
  })(),
  columns: (() => {
    const canvas = document.querySelector('.home-page-grid');
    if (!canvas) return [];
    const cr = canvas.getBoundingClientRect();
    const set = new Set(Array.from(document.querySelectorAll('.home-app')).map(a => Math.round(a.getBoundingClientRect().left - cr.left)));
    return Array.from(set).sort((a, b) => a - b);
  })(),
  trackScrollable: (() => { const t = document.getElementById('home-pages-track'); return t.scrollWidth > t.clientWidth + 1; })()
}))()`);
check('默认只有 1 页', initial.pages === 1, `pages=${initial.pages}`);
check('8 个入口图标齐全', initial.apps.length === 8, initial.apps.join(','));
check('资料卡固定在第 1 页网格内', initial.profileInFirstGrid && initial.banner, `banner=${initial.banner}`);
check('资料卡文本已填充', !!initial.mainText && !!initial.subText, `${initial.mainText} / ${initial.subText}`);
check('小组件注册表可用', initial.widgets.length === 1 && initial.widgets[0] === 'example-clock', initial.widgets.join(','));
check('图标尺寸恢复原版 60px', initial.iconSize === 60, `icon=${initial.iconSize}px`);
check('资料卡尺寸恢复原版（横幅 220 / 头像 80 / 标题 1.4rem）',
  initial.bannerHeight === 220 && initial.avatarSize >= 80 && initial.avatarSize <= 86
  && Math.abs(initial.mainFontSize - initial.rootFontSize * 1.4) < 0.3,
  `banner=${initial.bannerHeight} avatar=${initial.avatarSize} font=${initial.mainFontSize}/${(initial.rootFontSize * 1.4).toFixed(1)}`);
check('画布支持自由定位', initial.canvasPosition === 'relative' && initial.appPosition === 'absolute', `${initial.canvasPosition}/${initial.appPosition}`);
check('所有项都带自由坐标', initial.allPositioned === true, '');
check('图标仍排在资料卡下方', initial.firstAppTopOffset >= 380, `offset=${initial.firstAppTopOffset}`);
check('图标行与资料卡间距 ≈ 原版 40px', initial.gapBelowProfile >= 34 && initial.gapBelowProfile <= 46, `gap=${initial.gapBelowProfile}`);
check('默认 4 列对齐', initial.columns.length === 4, `lefts=${initial.columns.join('/')}`);
check('单页时无横向滚动', initial.trackScrollable === false, `scrollable=${initial.trackScrollable}`);
await shot('01-home-default');

// 2. 长按进入编辑 + 自由拖动到任意位置（不是格子里换位）
const drag = await evaluate(`(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const canvas = document.querySelector('#home-pages-track .home-page .home-page-grid');
  const apps = Array.from(canvas.querySelectorAll('.home-app'));
  const from = apps[0];
  const key = from.dataset.appKey;
  const r1 = from.getBoundingClientRect();
  const beforeLeft = Math.round(r1.left);
  const beforeTop = Math.round(r1.top);
  const startX = r1.left + r1.width / 2;
  const startY = r1.top + r1.height / 2;
  const colUnit = r1.width + 15;
  const rowUnit = 100;
  const targetX = startX + colUnit * 1.4;
  const targetY = startY + rowUnit * 3.2;
  const evOpts = (x, y) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y });

  from.dispatchEvent(new PointerEvent('pointerdown', evOpts(startX, startY)));
  await wait(760);
  const editing = document.getElementById('page-home').classList.contains('home-editing');
  const editBarShown = getComputedStyle(document.getElementById('home-edit-bar')).display !== 'none';
  const dragging = from.classList.contains('dragging');
  let followed = false;
  for (let i = 1; i <= 14; i++) {
    const x = startX + (targetX - startX) * i / 14;
    const y = startY + (targetY - startY) * i / 14;
    document.dispatchEvent(new PointerEvent('pointermove', evOpts(x, y)));
    await wait(30);
    if (i === 14) followed = Math.abs(from.getBoundingClientRect().left - beforeLeft) > 20;
  }
  document.dispatchEvent(new PointerEvent('pointerup', evOpts(targetX, targetY)));
  await wait(900);

  const el = document.querySelector('.home-app[data-app-key="' + key + '"]');
  const after = el ? el.getBoundingClientRect() : null;
  const item = state.ui.homeLayout.pages[0].items.find(i => i.kind === 'app' && i.key === key);
  return {
    key, editing, editBarShown, dragging, followed,
    movedX: after ? Math.round(after.left - beforeLeft) : 0,
    movedY: after ? Math.round(after.top - beforeTop) : 0,
    x: item ? item.x : null,
    y: item ? item.y : null,
    draggingCleaned: !document.querySelector('.home-app.dragging')
  };
})()`, true);
check('长按进入编辑模式', drag.editing === true && drag.editBarShown === true, `editing=${drag.editing} bar=${drag.editBarShown}`);
check('拖动时元素跟手移动', drag.dragging === true && drag.followed === true, `dragging=${drag.dragging} followed=${drag.followed}`);
check('可以停在格与格之间（自由坐标）', drag.movedX > 20 && drag.x !== null && Math.abs(drag.x - Math.round(drag.x)) > 0.05, `dx=${drag.movedX} x=${drag.x}`);
check('可以放到原网格以外的位置', drag.movedY > 150 && drag.y !== null && drag.y >= 2, `dy=${drag.movedY} y=${drag.y}`);
check('拖拽结束清理拖动态', drag.draggingCleaned === true, '');
await shot('02-home-editing-after-drag');

// 3. 刷新后持久化
await sleep(700);
await evaluate(`location.reload()`);
await sleep(1500);
await waitFor(`document.querySelectorAll('.home-page-grid .home-app').length > 0`, 30000);
await sleep(1200);
const persisted = await evaluate(`(() => {
  const key = ${JSON.stringify(drag.key)};
  const item = state.ui.homeLayout.pages[0].items.find(i => i.kind === 'app' && i.key === key);
  const el = document.querySelector('.home-app[data-app-key="' + key + '"]');
  const rect = el ? el.getBoundingClientRect() : null;
  return {
    x: item ? item.x : null,
    y: item ? item.y : null,
    left: rect ? Math.round(rect.left) : -1,
    top: rect ? Math.round(rect.top) : -1,
    editing: document.getElementById('page-home').classList.contains('home-editing')
  };
})()`);
check('刷新后自由坐标保持', persisted.x === drag.x && persisted.y === drag.y, `期望 ${drag.x},${drag.y} 实际 ${persisted.x},${persisted.y}`);
check('刷新后图标渲染在记录位置', persisted.left > 0 && persisted.top > 0, `${persisted.left},${persisted.top}`);
check('刷新后不在编辑模式', persisted.editing === false, '');

// 4. 新增页面 + 打开小组件面板
const addPage = await evaluate(`(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  document.getElementById('page-home').classList.add('home-editing');
  document.getElementById('home-edit-add-page').click();
  await wait(700);
  const pages = document.querySelectorAll('#home-pages-track .home-page').length;
  const dots = document.querySelectorAll('#home-page-dots .home-page-dot').length;
  const second = document.querySelectorAll('#home-pages-track .home-page')[1];
  const emptyHint = !!(second && second.querySelector('.home-page-empty'));
  document.getElementById('home-edit-add-widget').click();
  await wait(400);
  const sheetOpen = document.getElementById('home-widget-sheet').classList.contains('active');
  const sheetItems = document.querySelectorAll('.home-sheet-item').length;
  const sizeBtns = Array.from(document.querySelectorAll('.home-sheet-size-btn')).map(b => b.textContent);
  return { pages, dots, emptyHint, sheetOpen, sheetItems, sizeBtns };
})()`, true);
check('编辑模式下新增页面', addPage.pages === 2 && addPage.dots === 2, `pages=${addPage.pages} dots=${addPage.dots}`);
check('新页面有空页提示', addPage.emptyHint === true, '');
check('小组件面板可打开', addPage.sheetOpen === true && addPage.sheetItems === 1, `items=${addPage.sheetItems} sizes=${(addPage.sizeBtns || []).join('/')}`);
await shot('03-widget-sheet');

const addWidget = await evaluate(`(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  document.querySelector('.home-sheet-size-btn').click();
  await wait(900);
  const widgets = Array.from(document.querySelectorAll('#home-pages-track .home-widget'));
  const first = widgets[0];
  return {
    count: widgets.length,
    sizeClass: first ? first.className : '',
    hasClockText: first ? /\\d{2}:\\d{2}/.test(first.textContent) : false,
    sizeInLayout: state.ui.homeLayout.pages[1].items.filter(i => i.kind === 'widget').map(i => i.size)
  };
})()`, true);
check('小组件已添加到当前页', addWidget.count === 1, `count=${addWidget.count}`);
check('小组件尺寸生效', /hw-size-2x2/.test(addWidget.sizeClass), addWidget.sizeClass);
check('示例小组件渲染出内容', addWidget.hasClockText === true, '');
check('小组件写入布局', addWidget.sizeInLayout.join(',') === '2x2', addWidget.sizeInLayout.join(','));
await shot('04-widget-added');

// 5. 刷新后小组件仍在
await sleep(700);
await evaluate(`location.reload()`);
await sleep(1500);
await waitFor(`document.querySelectorAll('.home-page-grid .home-app').length > 0`, 30000);
await sleep(1200);
const persistedWidget = await evaluate(`(() => ({
  pages: document.querySelectorAll('#home-pages-track .home-page').length,
  widgets: document.querySelectorAll('#home-pages-track .home-widget').length,
  activeIdx: state.ui.homeLayout.activeIndex,
  clockRendered: /\\d{2}:\\d{2}/.test((document.querySelector('#home-pages-track .home-widget') || {}).textContent || '')
}))()`);
check('刷新后页面数与小组件保持', persistedWidget.pages === 2 && persistedWidget.widgets === 1, `pages=${persistedWidget.pages} widgets=${persistedWidget.widgets}`);
check('刷新后小组件重新渲染', persistedWidget.clockRendered === true, '');

// 6. 编辑模式下删除小组件 + 删除页面
const cleanup = await evaluate(`(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const page = document.getElementById('page-home');
  page.classList.add('home-editing');
  const secondPage = document.querySelectorAll('#home-pages-track .home-page')[1];
  const r = secondPage.getBoundingClientRect();
  secondPage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: r.left + 6, clientY: r.bottom - 40 }));
  await wait(900);
  const editing = page.classList.contains('home-editing');
  const removeBtn = document.querySelector('.home-widget-remove');
  const removeVisible = removeBtn ? getComputedStyle(removeBtn).display !== 'none' : false;
  if (removeBtn) removeBtn.click();
  await wait(800);
  const afterRemove = document.querySelectorAll('#home-pages-track .home-widget').length;
  const delDot = document.querySelector('.home-dot-del');
  const delVisible = delDot ? getComputedStyle(delDot).display !== 'none' : false;
  if (delDot) delDot.click();
  await wait(800);
  return {
    editing, removeVisible, afterRemove, delVisible,
    pagesAfterDelete: document.querySelectorAll('#home-pages-track .home-page').length,
    dotsAfterDelete: document.querySelectorAll('#home-page-dots .home-page-dot').length,
    layoutPages: state.ui.homeLayout.pages.length
  };
})()`, true);
check('空白长按保持编辑模式', cleanup.editing === true, '');
check('编辑模式显示小组件删除按钮', cleanup.removeVisible === true, '');
check('小组件删除生效', cleanup.afterRemove === 0, `remaining=${cleanup.afterRemove}`);
check('空页显示删除入口', cleanup.delVisible === true, '');
check('删除页面生效', cleanup.pagesAfterDelete === 1 && cleanup.layoutPages === 1, `pages=${cleanup.pagesAfterDelete}/${cleanup.layoutPages}`);

// 7. 资料卡变高（改字号 / 换主题）时图标自动跟随，不会压住资料卡
const gapFollow = await evaluate(`(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const profile = document.getElementById('home-profile-widget');
  const app = document.querySelector('.home-page');
  const firstApp = app ? app.querySelector('.home-app') : null;
  const canvas = firstApp ? firstApp.closest('.home-page-grid') : null;
  const gap = () => {
    const el = canvas ? canvas.querySelector('.home-app') : null;
    return el ? Math.round(el.getBoundingClientRect().top - profile.getBoundingClientRect().bottom) : -999;
  };
  const before = gap();
  const beforeTop = firstApp ? firstApp.style.top : null;
  profile.style.paddingBottom = '60px';
  await wait(700);
  const after = gap();
  const afterTop = firstApp ? firstApp.style.top : null;
  const diag = {
    pages: document.querySelectorAll('.home-page').length,
    pageIndex: firstApp ? firstApp.dataset.pageIndex : null,
    canvasTop: canvas ? getHomeCanvasTopOffset(canvas) : null
  };
  profile.style.paddingBottom = '';
  await wait(500);
  const restored = gap();
  return { before, after, restored, beforeTop, afterTop, diag };
})()`, true);
check('资料卡变高后图标自动跟随', Math.abs(gapFollow.after - gapFollow.before) <= 2 && gapFollow.after >= 30, `${gapFollow.before} -> ${gapFollow.after} top ${gapFollow.beforeTop}->${gapFollow.afterTop} ${JSON.stringify(gapFollow.diag)}`);
check('资料卡恢复后间距复原', Math.abs(gapFollow.restored - gapFollow.before) <= 2, `restored=${gapFollow.restored}`);

// 8. 小屏 320px 适配
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });
await evaluate(`document.getElementById('page-home').classList.remove('home-editing')`);
await sleep(700);
const small = await evaluate(`(() => {
  const canvas = document.querySelector('.home-page-grid');
  const icon = document.querySelector('.home-app .icon-wrapper');
  const r = icon.getBoundingClientRect();
  const track = document.getElementById('home-pages-track');
  const cr = canvas.getBoundingClientRect();
  const minLeft = Math.min.apply(null, Array.from(document.querySelectorAll('.home-app')).map(a => a.getBoundingClientRect().left));
  return {
    iconWidth: Math.round(r.width),
    minLeftInCanvas: Math.round(minLeft - cr.left),
    canvasWidth: Math.round(cr.width),
    trackWidth: Math.round(track.clientWidth),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    trackScrollWidth: track.scrollWidth,
    trackClientWidth: track.clientWidth
  };
})()`);
check('320px 下图标仍是 60px', small.iconWidth === 60, small.iconWidth);
check('320px 下仍贴左内边距 25px', small.minLeftInCanvas >= 20 && small.minLeftInCanvas <= 30, `left=${small.minLeftInCanvas}`);
check('320px 下画布宽度跟随屏幕', Math.abs(small.canvasWidth - small.trackWidth) <= 1, `${small.canvasWidth}/${small.trackWidth}`);
check('320px 下页面无横向溢出', small.overflowX === false, `overflowX=${small.overflowX}`);
check('320px 下单页不产生横向滚动', small.trackScrollWidth <= small.trackClientWidth + 1, `${small.trackScrollWidth}/${small.trackClientWidth}`);
await shot('05-home-320');

// 9. 旧版本布局（只有顺序、没有坐标）自动迁移成自由坐标
await evaluate(`(() => {
  state.ui.homeLayout = {
    version: 1,
    activeIndex: 0,
    pages: [{ id: 'legacy_p1', items: [
      { kind: 'app', key: 'characters' },
      { kind: 'app', key: 'chat' },
      { kind: 'widget', id: 'legacy_w1', type: 'example-clock', size: '2x2', data: {} }
    ] }]
  };
  renderHomeDesktop();
  return saveUiState();
})()`, true).catch(() => null);
await sleep(900);
await evaluate(`location.reload()`).catch(() => null);
await sleep(2000);
await waitFor(`document.querySelectorAll('.home-page-grid .home-app').length > 0`, 30000);
await sleep(1200);
const legacy = await evaluate(`(() => {
  const items = state.ui.homeLayout.pages[0].items;
  const canvas = document.querySelector('.home-page-grid');
  const cr = canvas.getBoundingClientRect();
  const els = Array.from(canvas.querySelectorAll('.home-app, .home-widget'));
  return {
    allPositioned: items.every(i => Number.isFinite(i.x) && Number.isFinite(i.y)),
    hasWidget: items.some(i => i.kind === 'widget'),
    appsBackfilled: new Set(items.filter(i => i.kind === 'app').map(i => i.key)).size,
    inCanvas: els.every(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().left >= cr.left - 1),
    tops: els.map(el => Math.round(el.getBoundingClientRect().top - cr.top))
  };
})()`);
check('旧版布局自动补全自由坐标', legacy.allPositioned === true, '');
check('旧版布局保留小组件', legacy.hasWidget === true, '');
check('旧版布局自动补回 8 个入口', legacy.appsBackfilled === 8, `apps=${legacy.appsBackfilled}`);
check('迁移后所有项都在画布内可见', legacy.inCanvas === true, `tops=${legacy.tops.join(',')}`);

// 8. 控制台
const realErrors = consoleErrors.filter(e => !/favicon/i.test(e));
check('控制台无报错', realErrors.length === 0, realErrors.slice(0, 6).join(' | '));

const failed = results.filter(r => !r.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} 项通过 ==`);
await writeFile(`${OUT}/result.json`, JSON.stringify({ results, consoleErrors }, null, 2));
if (failed.length) process.exitCode = 1;
ws.close();



