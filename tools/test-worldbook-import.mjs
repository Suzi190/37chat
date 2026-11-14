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
    normalizeStoredLoreEntry,
    activateLoreEntries
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
        2: { uid: 2, key: '空内容', content: '   ', disable: false, order: 5 },
        3: { uid: 3, key: '作者注释', content: '作者注释前的提示。', disable: false, order: 6, position: 2 },
        4: { uid: 4, key: '深度', content: '按深度插入的提示。', disable: false, order: 7, position: 4 },
        5: { uid: 5, key: '示例', content: '示例消息前的提示。', disable: false, order: 8, position: 5 },
        6: { uid: 6, key: '出口', content: '出口插槽的内容。', disable: false, order: 9, position: 7 }
    }
};
const standaloneEntries = api.parseLoreEntries(standaloneBook);
assert.equal(standaloneEntries.length, 6, '空内容的条目应被丢弃');
assert.deepEqual(standaloneEntries[0].keys, ['王都', '首都']);
assert.deepEqual(standaloneEntries[0].secondaryKeys, ['城门']);
assert.equal(standaloneEntries[0].position, 'after_char');
assert.deepEqual(standaloneEntries[1].keys, ['龙'], '字符串 key 也要拆成数组');
assert.equal(standaloneEntries[1].enabled, false);
assert.equal(standaloneEntries[1].position, 'before_char');
// ST 的 world_info_position：2/3 是作者注释上/下，5/6 是示例消息上/下，7 是出口，不能都糊成 before_char/after_char
assert.equal(standaloneEntries[2].position, 'before_an', 'position 2 是作者注释前');
assert.equal(standaloneEntries[3].position, 'at_depth', 'position 4 是按深度插入');
assert.equal(standaloneEntries[4].position, 'em_top', 'position 5 是示例消息前');
assert.equal(standaloneEntries[5].position, 'outlet', 'position 7 是出口');

// 3.1) V2 卡里 position 也可能是 extensions.position（数字），同样要认得
const extensionPositionEntry = api.parseLoreEntries({
    entries: [{ id: 1, keys: ['x'], content: '扩展位置。', extensions: { position: 3 } }]
})[0];
assert.equal(extensionPositionEntry.position, 'after_an', 'extensions.position=3 是作者注释后');

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

// 7) 同 order 的条目必须保持原顺序，且 order 小的整体在前（对齐 ST 降序遍历 + unshift 的最终文本顺序）
const tieProbe = [
    { id: 'x', content: 'TIEX', order: 100, enabled: true, keys: [] },
    { id: 'y', content: 'TIEY', order: 100, enabled: true, keys: [] },
    { id: 'z', content: 'TIEZ', order: 50, enabled: true, keys: [] }
];
const tieRendered = api.renderLoreEntriesContent(tieProbe);
assert.ok(tieRendered.indexOf('TIEZ') < tieRendered.indexOf('TIEX'), 'order 小的应该排在前面');
assert.ok(tieRendered.indexOf('TIEX') < tieRendered.indexOf('TIEY'), 'order 相同时要保持条目原顺序');
assert.deepEqual(tieProbe.map(item => item.id), ['x', 'y', 'z'], '排序不能就地改动条目数组');

// 8) SillyTavern 式激活：常驻直接生效，关键词命中才注入，禁用/未命中都不进 prompt
const activationEntries = api.parseLoreEntries({
    entries: [
        { uid: 1, comment: '常驻', keys: [], content: 'COMMON', constant: true, order: 10 },
        { uid: 2, comment: '魔法', keys: ['魔法'], content: 'MAGIC', order: 20 },
        { uid: 3, comment: '骑士', keys: ['骑士'], content: 'KNIGHT', order: 30 },
        { uid: 4, comment: '学院', keys: ['魔法'], keysecondary: ['学院'], content: 'ACADEMY', order: 40, selective: true },
        { uid: 5, comment: '禁用', keys: ['魔法'], content: 'DISABLED', order: 50, disable: true }
    ]
});
assert.deepEqual(
    api.activateLoreEntries(activationEntries, '她走进了魔法学院').map(entry => entry.content),
    ['COMMON', 'MAGIC', 'ACADEMY'],
    '常驻 + 命中关键词的条目才注入，禁用条目永远不注入'
);
assert.deepEqual(
    api.activateLoreEntries(activationEntries, '今天天气不错').map(entry => entry.content),
    ['COMMON'],
    '没有关键词命中时只注入常驻条目'
);
assert.deepEqual(
    api.activateLoreEntries(activationEntries, '魔法').map(entry => entry.content),
    ['COMMON', 'MAGIC'],
    '次关键词没命中时，selective 条目不生效'
);

// 8.1) 次关键词的四种组合逻辑（ST selectiveLogic 0/1/2/3）
const logicEntries = api.parseLoreEntries({
    entries: [
        { uid: 1, keys: ['魔法'], keysecondary: ['学院', '塔'], content: 'AND_ANY', selective: true, selective_logic: 0, order: 1 },
        { uid: 2, keys: ['魔法'], keysecondary: ['学院', '塔'], content: 'NOT_ALL', selective: true, selective_logic: 1, order: 2 },
        { uid: 3, keys: ['魔法'], keysecondary: ['学院', '塔'], content: 'NOT_ANY', selective: true, selective_logic: 2, order: 3 },
        { uid: 4, keys: ['魔法'], keysecondary: ['学院', '塔'], content: 'AND_ALL', selective: true, selective_logic: 3, order: 4 }
    ]
});
assert.deepEqual(api.activateLoreEntries(logicEntries, '魔法学院').map(entry => entry.content), ['AND_ANY', 'NOT_ALL']);
assert.deepEqual(api.activateLoreEntries(logicEntries, '魔法学院塔').map(entry => entry.content), ['AND_ANY', 'AND_ALL']);
assert.deepEqual(api.activateLoreEntries(logicEntries, '魔法').map(entry => entry.content), ['NOT_ALL', 'NOT_ANY']);

// 8.2) 大小写、整词匹配、正则关键词
const caseEntries = api.parseLoreEntries({
    entries: [
        { uid: 1, keys: ['Mana'], content: 'CASE_SENSITIVE', case_sensitive: true, order: 1 },
        { uid: 2, keys: ['Mana'], content: 'CASE_INSENSITIVE', order: 2 }
    ]
});
assert.deepEqual(api.activateLoreEntries(caseEntries, 'mana 不够了').map(entry => entry.content), ['CASE_INSENSITIVE']);
assert.deepEqual(api.activateLoreEntries(caseEntries, 'Mana 见底').map(entry => entry.content), ['CASE_SENSITIVE', 'CASE_INSENSITIVE']);

const wholeWordEntry = api.parseLoreEntries({ entries: [{ uid: 1, keys: ['cat'], content: 'WHOLE', match_whole_words: true }] });
assert.deepEqual(api.activateLoreEntries(wholeWordEntry, 'category').map(entry => entry.content), []);
assert.deepEqual(api.activateLoreEntries(wholeWordEntry, 'a cat sleeps').map(entry => entry.content), ['WHOLE']);

const regexEntry = api.parseLoreEntries({ entries: [{ uid: 1, keys: ['/魔[法术]/'], content: 'REGEX' }] });
assert.deepEqual(api.activateLoreEntries(regexEntry, '魔术').map(entry => entry.content), ['REGEX'], 'ST 的 /regex/ 关键词也要能用');

// 8.3) 概率：100 恒定生效，0 永不生效，50 由随机数决定
const probabilityEntries = api.parseLoreEntries({
    entries: [
        { uid: 1, keys: ['魔法'], content: 'PROB_ALWAYS', probability: 100, order: 1 },
        { uid: 2, keys: ['魔法'], content: 'PROB_NEVER', probability: 0, order: 2 },
        { uid: 3, keys: ['魔法'], content: 'PROB_HALF', probability: 50, order: 3 }
    ]
});
assert.deepEqual(api.activateLoreEntries(probabilityEntries, '魔法', { random: () => 0.1 }).map(entry => entry.content), ['PROB_ALWAYS', 'PROB_HALF']);
assert.deepEqual(api.activateLoreEntries(probabilityEntries, '魔法', { random: () => 0.9 }).map(entry => entry.content), ['PROB_ALWAYS']);

// 8.4) 递归：已注入的条目正文可以再触发别的条目；prevent_recursion 截断这一层
const recursionEntries = api.parseLoreEntries({
    entries: [
        { uid: 1, keys: ['龙'], content: '龙族信仰「星辰」', order: 1 },
        { uid: 2, keys: ['星辰'], content: '星辰教会', order: 2 },
        { uid: 3, keys: ['教会'], content: '第三层设定', order: 3 }
    ]
});
assert.deepEqual(
    api.activateLoreEntries(recursionEntries, '一条龙').map(entry => entry.content),
    ['龙族信仰「星辰」', '星辰教会', '第三层设定'],
    '递归最多两轮，正好能串起三层'
);
const blockedRecursion = api.parseLoreEntries({
    entries: [
        { uid: 1, keys: ['龙'], content: '龙族信仰「星辰」', prevent_recursion: true, order: 1 },
        { uid: 2, keys: ['星辰'], content: '星辰教会', order: 2 }
    ]
});
assert.deepEqual(api.activateLoreEntries(blockedRecursion, '一条龙').map(entry => entry.content), ['龙族信仰「星辰」']);

// 8.5) 注入顺序：先按插入位置区段，再按 order（小号在前）
const positionOrderEntries = api.parseLoreEntries({
    entries: [
        { uid: 1, keys: ['魔法'], content: 'AFTER_CHAR', position: 1, order: 1 },
        { uid: 2, keys: ['魔法'], content: 'BEFORE_CHAR', position: 0, order: 99 }
    ]
});
assert.deepEqual(api.activateLoreEntries(positionOrderEntries, '魔法').map(entry => entry.content), ['BEFORE_CHAR', 'AFTER_CHAR']);

// 8.6) 没有关键词又没勾常驻的条目，和 ST 一样永远不会注入
const emptyKeyEntries = api.parseLoreEntries({ entries: [{ uid: 1, keys: [], content: 'NEVER' }] });
assert.deepEqual(api.activateLoreEntries(emptyKeyEntries, '随便什么文字').map(entry => entry.content), []);

console.log('[ok] 世界书导入分条测试全部通过');
