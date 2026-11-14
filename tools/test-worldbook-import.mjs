#!/usr/bin/env node
/**
 * 世界书导入分条测试。
 *
 * 直接抽取 app/index.html 里 ==WORLDBOOK_PURE_START== / ==WORLDBOOK_PURE_END== 之间的
 * 纯函数（不依赖 DOM / IndexedDB），用真实的 SillyTavern 卡片、独立世界书、旧版整块数据
 * 做断言，防止以后又把一本世界书塞回“一大段文本”。
 *
 * 用法：node tools/test-worldbook-import.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');

const startMark = '// ==WORLDBOOK_PURE_START==';
const endMark = '// ==WORLDBOOK_PURE_END==';
const start = html.indexOf(startMark);
const end = html.indexOf(endMark);
assert.ok(start > -1 && end > start, 'index.html 里找不到世界书纯函数标记');

const pureCode = html.slice(start + startMark.length, end);
const api = new Function(`${pureCode}
return {
    parseLoreKeyList,
    normalizeLoreEntry,
    parseLoreEntries,
    renderLoreEntryTitle,
    renderLoreEntriesContent,
    normalizeWorldBookRecord,
    normalizeStoredLoreEntry
};`)();

// 1) V2 角色卡（character_book.entries 是数组，字段是 snake_case）
const v2Book = {
    name: '艾莉丝的世界书',
    entries: [
        {
            id: 5,
            keys: ['魔法', '魔力'],
            secondary_keys: ['学院'],
            content: '魔法来自世界树。',
            enabled: true,
            insertion_order: 30,
            comment: '魔法体系',
            position: 'after_char',
            selective: true
        },
        { id: 6, keys: ['骑士团'], content: '骑士团驻扎在王都北门。', enabled: false, insertion_order: 20, comment: '骑士团' },
        { id: 7, keys: [], content: '这个世界有两轮月亮。', enabled: true, constant: true, insertion_order: 10, comment: '世界观' }
    ]
};
const v2Entries = api.parseLoreEntries(v2Book);
assert.equal(v2Entries.length, 3, 'V2 角色卡应拆成 3 条独立条目（禁用的也要保留，只是不注入）');
assert.deepEqual(v2Entries[0].keys, ['魔法', '魔力']);
assert.deepEqual(v2Entries[0].secondaryKeys, ['学院']);
assert.equal(v2Entries[0].order, 30);
assert.equal(v2Entries[0].position, 'after_char');
assert.equal(v2Entries[0].comment, '魔法体系');
assert.equal(v2Entries[0].selective, true);
assert.equal(v2Entries[1].enabled, false);
assert.equal(v2Entries[1].id, '6');
assert.equal(v2Entries[2].constant, true);

// 2) 注入文本：按 insertion_order 升序、跳过禁用条目、标题里带触发词
const rendered = api.renderLoreEntriesContent(v2Entries);
const blocks = rendered.split('\n\n');
assert.equal(blocks.length, 2, '禁用的条目不应出现在注入文本里');
assert.ok(blocks[0].startsWith('【世界观】'), '顺序靠前的常驻条目应排在最前');
assert.ok(blocks[1].startsWith('【魔法体系｜触发词：魔法、魔力】'), '条目标题要带触发词');
assert.ok(!rendered.includes('骑士团'), '禁用条目的正文不应泄漏进注入文本');

// 3) 独立世界书文件：entries 是对象 map，用 disable / key / keysecondary / order / 数字 position
const standaloneBook = {
    entries: {
        0: { uid: 0, key: ['王都', '首都'], keysecondary: ['城门'], comment: '王都', content: '王都建在山上。', disable: false, order: 3, position: 1 },
        1: { uid: 1, key: '龙', content: '龙族已经灭绝。', disable: true, order: 4, position: 0 },
        2: { uid: 2, key: '空内容', content: '   ', disable: false, order: 5 }
    }
};
const standaloneEntries = api.parseLoreEntries(standaloneBook);
assert.equal(standaloneEntries.length, 2, '空内容的条目应被丢弃');
assert.deepEqual(standaloneEntries[0].keys, ['王都', '首都']);
assert.deepEqual(standaloneEntries[0].secondaryKeys, ['城门']);
assert.equal(standaloneEntries[0].position, 'after_char');
assert.deepEqual(standaloneEntries[1].keys, ['龙'], '字符串 key 也要拆成数组');
assert.equal(standaloneEntries[1].enabled, false);
assert.equal(standaloneEntries[1].position, 'before_char');

// 4) 旧版本地世界书只有一整块 content：迁移成单条目，原文本不能丢
const legacyBook = api.normalizeWorldBookRecord({ id: 'wb_1', name: '旧书', content: '第一段\n第二段' });
assert.equal(legacyBook.id, 'wb_1');
assert.equal(legacyBook.entries.length, 1);
assert.equal(legacyBook.entries[0].content, '第一段\n第二段');
assert.equal(legacyBook.content, '【正文】\n第一段\n第二段');

// 5) 编辑器保存：字符串关键词拆开、order 转数字、启用/常驻/概率都要保住
const savedEntry = api.normalizeStoredLoreEntry({
    comment: ' 测试条目 ',
    keys: '魔法，魔力, mana',
    secondaryKeys: '学院',
    content: ' 内容正文 ',
    enabled: false,
    order: '30',
    constant: true,
    probability: '80'
});
assert.deepEqual(savedEntry.keys, ['魔法', '魔力', 'mana']);
assert.deepEqual(savedEntry.secondaryKeys, ['学院']);
assert.equal(savedEntry.order, 30);
assert.equal(savedEntry.enabled, false);
assert.equal(savedEntry.constant, true);
assert.equal(savedEntry.probability, 80);
assert.equal(savedEntry.comment, '测试条目');
assert.equal(savedEntry.content, '内容正文');
assert.ok(savedEntry.id.startsWith('le_'), '新条目要有自己的 id');

// 6) 渲染不修改传入数组的顺序；关键词支持中英文逗号
const orderProbe = [
    { id: 'b', content: 'B', order: 2, enabled: true, keys: [] },
    { id: 'a', content: 'A', order: 1, enabled: true, keys: [] }
];
api.renderLoreEntriesContent(orderProbe);
assert.deepEqual(orderProbe.map(item => item.id), ['b', 'a'], '渲染时不能打乱原数组');
assert.deepEqual(api.parseLoreKeyList(' 魔法, 魔力，mana '), ['魔法', '魔力', 'mana']);

console.log('[ok] 世界书导入分条测试全部通过');
