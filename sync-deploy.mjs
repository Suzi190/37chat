// 把 app/index.html 同步为部署用的单文件版本 37chat-deployed.html
// 两者唯一差异：三个本地 vendor 路径换回 CDN，其余内容逐字一致。
// 用法：node sync-deploy.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(root, 'app', 'index.html');
const targetPath = join(root, '37chat-deployed.html');

const REPLACEMENTS = [
    ['vendor/fontawesome/css/all.min.css', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'],
    ['vendor/markdown-it.min.js', 'https://cdn.jsdelivr.net/npm/markdown-it@14.0.0/dist/markdown-it.min.js'],
    ['vendor/dexie.min.js', 'https://unpkg.com/dexie/dist/dexie.js']
];

let html = readFileSync(sourcePath, 'utf8');

REPLACEMENTS.forEach(([from, to]) => {
    const hits = html.split(from).length - 1;
    if (hits !== 1) {
        console.error(`[sync-deploy] 期望 "${from}" 出现 1 次，实际 ${hits} 次 —— 已中止，避免写坏部署文件`);
        process.exit(1);
    }
    html = html.split(from).join(to);
});

// 兜底校验：不能残留本地 vendor 引用，否则部署后会 404
const leftover = html.match(/vendor\/(fontawesome|markdown-it|dexie)/g);
if (leftover) {
    console.error(`[sync-deploy] 仍有本地引用未替换: ${leftover.join(', ')}`);
    process.exit(1);
}

writeFileSync(targetPath, html, 'utf8');
console.log(`[sync-deploy] 已生成 ${targetPath} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
console.log('[sync-deploy] 3 处 CDN 替换完成，其余内容与 app/index.html 逐字一致');
