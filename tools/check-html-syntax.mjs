#!/usr/bin/env node
/**
 * 检查 HTML 里的内联 <script> 能不能编译。
 *
 * 为什么需要这个：app/index.html 里插入「安卓壳适配」时漏了一个 </script>，
 * 浏览器就把后面的 HTML 注释和第二个 <script> 全当成了主脚本的一部分，
 * 于是 1.4MB 的主脚本报 SyntaxError: Invalid or unexpected token（全角括号），
 * 一行 JS 都没执行 —— 表现就是开屏一直转圈、看不到任何报错。
 * 这种错误在浏览器里只会静默白屏，肉眼极难发现，所以放进 CI 里卡住。
 *
 * 用法：node tools/check-html-syntax.mjs [file...]
 * 不传参数时检查 app/index.html 与 android 的 assets/www/index.html。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const DEFAULT_TARGETS = [
  'app/index.html',
  'android/app/src/main/assets/www/index.html',
];

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function lineText(text, line) {
  const row = text.split('\n')[line - 1];
  return row === undefined ? '' : row.trim().slice(0, 160);
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const problems = [];
  const notes = [];
  let inlineCount = 0;
  let match;
  while ((match = SCRIPT_RE.exec(text)) !== null) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    inlineCount += 1;
    const code = match[2] || '';
    const startLine = lineOf(text, match.index);

    try {
      // 用 V8 自己编译一遍：语法错误这里就会抛
      new vm.Script(code, { filename: `${path.basename(file)}#${inlineCount}` });
    } catch (error) {
      const hit = String(error.stack || '').match(/#\d+:(\d+)/);
      const line = hit ? startLine + Number(hit[1]) - 1 : startLine;
      // 语法错误的行号可能落在被"吞进来"的 HTML 上，附近有 <!-- 基本就是漏写 </script>
      const around = text.split('\n').slice(Math.max(0, line - 6), line + 2).join('\n');
      problems.push({
        where: `内联脚本 #${inlineCount}（第 ${startLine} 行起）`,
        line,
        message: error.message,
        snippet: lineText(text, line),
        hint: around.includes('<!--')
          ? '这里出现了 HTML 注释 <!--：多半是上一段脚本漏写 </script>，后面的注释被当成 JS 了'
          : '',
      });
    }
  }
  return { inlineCount, problems, notes };
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
let failed = 0;

for (const target of targets) {
  const file = path.resolve(process.cwd(), target);
  if (!fs.existsSync(file)) {
    console.log(`[skip] ${target} 不存在`);
    continue;
  }
  const { inlineCount, problems, notes } = checkFile(file);
  for (const note of notes) console.log(`[warn] ${target}: ${note}`);
  if (!problems.length) {
    console.log(`[ok]   ${target} —— ${inlineCount} 段内联脚本，语法全部通过`);
    continue;
  }
  failed += 1;
  console.error(`[fail] ${target} —— ${problems.length} 段内联脚本编译失败`);
  for (const p of problems) {
    console.error(`   ${p.where} 第 ${p.line} 行: ${p.message}`);
    if (p.snippet) console.error(`     > ${p.snippet}`);
    if (p.hint) console.error(`     ! ${p.hint}`);
  }
}

if (failed) {
  console.error('\n内联脚本有语法错误：页面会白屏卡在开屏，先修好再打包。');
  process.exit(1);
}
