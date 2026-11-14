#!/usr/bin/env node
/**
 * 世界书导入端到端测试（真实浏览器 + 真实 IndexedDB）。
 *
 * 往页面里丢一张带 character_book 的 SillyTavern V2 角色卡 JSON，然后断言：
 *   1. 世界书被存成「一本」，entries 是按条拆开的，而不是一整块 content；
 *   2. 禁用条目、触发词、顺序、position 都跟着过来；
 *   3. 世界书列表显示「2/3 条条目」，点开编辑器能看到 3 条独立条目。
 *
 * 用法：node tools/test-worldbook-ui.mjs [wwwDir]
 *   默认目录 android/app/src/main/assets/www（先跑 node tools/prepare-apk-assets.mjs）
 * 要求 Node >= 22（内置 WebSocket），本机装有 Chrome 或 Edge。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    '.ttf': 'font/ttf'
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
        '/usr/bin/microsoft-edge'
    ];
    return candidates.find(file => fs.existsSync(file)) || null;
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
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
            });
        }).on('error', reject);
    });
}

const cardJson = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: '端到端测试角色',
        description: '用于测试世界书拆分',
        personality: '安静',
        scenario: '',
        first_mes: '你好，我是端到端测试角色。',
        mes_example: '',
        character_book: {
            name: '端到端测试世界书',
            entries: [
                { id: 0, keys: ['魔法', '魔力'], secondary_keys: [], content: '魔法来自世界树。', enabled: true, insertion_order: 30, comment: '魔法体系', position: 'after_char' },
                { id: 1, keys: ['骑士团'], content: '骑士团驻扎在北门。', enabled: false, insertion_order: 20, comment: '骑士团' },
                { id: 2, keys: [], content: '这里有两轮月亮。', enabled: true, constant: true, insertion_order: 10, comment: '世界观' }
            ]
        }
    }
});

function dumpWorldBooksScript() {
    return `new Promise(resolve => {
        const request = indexedDB.open('37ChatDB');
        request.onerror = () => resolve(JSON.stringify({ error: 'open failed' }));
        request.onsuccess = () => {
            const database = request.result;
            const tx = database.transaction(['worldBooks', 'characters'], 'readonly');
            const booksRequest = tx.objectStore('worldBooks').getAll();
            const charsRequest = tx.objectStore('characters').getAll();
            tx.onerror = () => resolve(JSON.stringify({ error: 'tx failed' }));
            tx.oncomplete = () => resolve(JSON.stringify({
                books: (booksRequest.result || []).map(book => ({
                    id: book.id,
                    name: book.name,
                    folder: book.folder,
                    content: book.content,
                    entries: (book.entries || []).map(entry => ({
                        comment: entry.comment,
                        keys: entry.keys,
                        secondaryKeys: entry.secondaryKeys,
                        content: entry.content,
                        enabled: entry.enabled,
                        constant: entry.constant,
                        order: entry.order,
                        position: entry.position
                    }))
                })),
                chars: (charsRequest.result || []).map(char => ({ name: char.name, worldBookIds: char.worldBookIds }))
            }));
        };
    })`;
}

function probeEditorScript() {
    return `(() => {
        const items = Array.from(document.querySelectorAll('#worldbooks-list .list-item'));
        const normalize = element => (element.textContent || '').replace(/\\s+/g, ' ').trim();
        const listTexts = items.map(normalize);
        const targetItem = items.find(item => normalize(item).includes('端到端测试世界书'));
        if (targetItem) targetItem.click();
        const editors = Array.from(document.querySelectorAll('#worldbook-entries .wb-entry'));
        const first = editors[0];
        return JSON.stringify({
            listTexts,
            clicked: !!targetItem,
            editorCount: editors.length,
            countLabel: (document.getElementById('worldbook-entry-count') || {}).textContent || '',
            comments: editors.map(item => item.querySelector('.wb-entry-comment').value),
            firstKeys: first ? first.querySelector('.wb-entry-keys').value : '',
            firstContent: first ? first.querySelector('.wb-entry-content').value : '',
            modalDisplay: getComputedStyle(document.getElementById('worldbook-modal')).display
        });
    })()`;
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
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yy-wb-e2e-'));
    const pageUrl = 'http://127.0.0.1:' + port + '/index.html';
    const child = spawn(browser, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + profile,
        '--remote-debugging-port=0',
        '--window-size=420,900',
        pageUrl
    ], { stdio: 'ignore' });

    const cleanup = () => {
        try { child.kill(); } catch (error) { /* 浏览器可能已经退出 */ }
        try { server.close(); } catch (error) { /* ignore */ }
    };

    const portFile = path.join(profile, 'DevToolsActivePort');
    let cdpPort = null;
    for (let i = 0; i < 80; i += 1) {
        if (fs.existsSync(portFile)) {
            try {
                const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
                if (first) { cdpPort = first; break; }
            } catch (error) { /* 文件被占用，下一轮再读 */ }
        }
        await sleep(250);
    }
    if (!cdpPort) { cleanup(); assert.fail('浏览器没起来（拿不到 DevToolsActivePort）'); }

    let target = null;
    for (let i = 0; i < 40; i += 1) {
        try {
            const list = await getJson('http://127.0.0.1:' + cdpPort + '/json/list');
            target = (list || []).find(item => item.type === 'page' && item.webSocketDebuggerUrl);
            if (target) break;
        } catch (error) { /* not ready */ }
        await sleep(250);
    }
    if (!target) { cleanup(); assert.fail('拿不到 CDP page target'); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    const exceptions = [];
    let seq = 0;
    const send = (method, params) => new Promise(resolve => {
        const id = (seq += 1);
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
    ws.addEventListener('message', event => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        if (msg.method === 'Runtime.exceptionThrown') {
            const detail = msg.params.exceptionDetails || {};
            exceptions.push((detail.exception && detail.exception.description) || detail.text || 'unknown');
        }
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', reject);
    });
    await send('Runtime.enable');

    const evaluate = async (expression, awaitPromise = false) => {
        const response = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise,
            userGesture: true
        });
        const result = response.result || {};
        if (result.exceptionDetails) {
            throw new Error('页面执行出错: ' + JSON.stringify(result.exceptionDetails).slice(0, 400));
        }
        return result.result ? result.result.value : undefined;
    };

    console.log('浏览器: ' + browser);
    console.log('页面:   ' + pageUrl);
    console.log('等 10 秒让初始化跑完 ...');
    await sleep(10000);

    // 1) 丢一张带 character_book 的 V2 卡片进去
    const dispatched = await evaluate(`(async () => {
        window.__wbAlerts = [];
        window.alert = message => { window.__wbAlerts.push(String(message)); };
        const file = new File([${JSON.stringify(cardJson)}], 'e2e-worldbook-card.json', { type: 'application/json' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const input = document.getElementById('character-card-input');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'dispatched';
    })()`, true);
    assert.equal(dispatched, 'dispatched');

    await sleep(2500);

    // 2) 读 IndexedDB：世界书必须是「一本 + 多条 entries」
    const dump = JSON.parse(await evaluate(dumpWorldBooksScript(), true));
    if (dump.error) { cleanup(); assert.fail('读 IndexedDB 失败: ' + dump.error); }

    // 3) 列表 + 编辑器
    const ui = JSON.parse(await evaluate(probeEditorScript()));
    const alerts = JSON.parse(await evaluate('JSON.stringify(window.__wbAlerts || [])'));

    ws.close();
    cleanup();

    assert.equal(dump.books.length, 1, '应该只生成一本世界书');
    const book = dump.books[0];
    assert.equal(book.name, '端到端测试世界书');
    assert.equal(book.folder, '角色卡导入');
    assert.equal(book.entries.length, 3, '世界书要拆成 3 条条目（不是一整块）');

    const magic = book.entries.find(entry => entry.comment === '魔法体系');
    assert.ok(magic, '找不到「魔法体系」条目');
    assert.deepEqual(magic.keys, ['魔法', '魔力']);
    assert.equal(magic.order, 30);
    assert.equal(magic.position, 'after_char');
    assert.equal(magic.enabled, true);

    const knight = book.entries.find(entry => entry.comment === '骑士团');
    assert.ok(knight, '找不到「骑士团」条目');
    assert.equal(knight.enabled, false, '禁用状态要保留');

    const world = book.entries.find(entry => entry.comment === '世界观');
    assert.ok(world, '找不到「世界观」条目');
    assert.equal(world.constant, true);

    assert.ok(book.content.includes('【魔法体系｜触发词：魔法、魔力】'), 'content 里要带条目标题和触发词');
    assert.ok(!book.content.includes('骑士团驻扎在北门'), '禁用条目不应进入 content');
    assert.ok(book.content.indexOf('【世界观】') < book.content.indexOf('【魔法体系'), 'content 要按顺序排');

    assert.equal(dump.chars.length, 1, '应该只生成一个角色');
    assert.deepEqual(dump.chars[0].worldBookIds, [book.id], '角色要绑定这本世界书');

    assert.ok(ui.clicked, '世界书列表里找不到这本世界书，实际: ' + JSON.stringify(ui.listTexts));
    assert.ok(ui.listTexts.some(text => text.includes('端到端测试世界书') && text.includes('2/3 条条目')), '列表应显示 2/3 条条目，实际: ' + JSON.stringify(ui.listTexts));
    assert.equal(ui.editorCount, 3, '编辑器要渲染出 3 条条目');
    assert.equal(ui.countLabel, '3');
    assert.ok(ui.comments.includes('魔法体系') && ui.comments.includes('骑士团') && ui.comments.includes('世界观'), '条目标题要显示出来，实际: ' + JSON.stringify(ui.comments));
    assert.equal(ui.modalDisplay, 'flex', '点开世界书应弹出编辑器');
    assert.equal(exceptions.length, 0, '页面不应有未捕获异常: ' + exceptions[0]);

    console.log('导入提示: ' + (alerts[0] || '(无)').replace(/\n/g, ' | '));
    console.log('世界书: ' + book.name + ' / ' + book.entries.length + ' 条条目');
    console.log('列表项: ' + (ui.listTexts.find(text => text.includes('端到端测试世界书')) || ''));
    console.log('\n世界书导入端到端测试全部通过');
}

main().catch(error => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
});
