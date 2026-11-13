const fs = require('fs');
const html = fs.readFileSync('d:/37chat/app/index.html', 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
fs.writeFileSync('d:/37chat/.tmp_check/inline.js', blocks.join('\n;\n'));
console.log('blocks=' + blocks.length + ' bytes=' + blocks.join('').length);
