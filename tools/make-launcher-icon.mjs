#!/usr/bin/env node
/**
 * 生成启动器图标（磨砂玻璃底 + 墨色图形）。
 *
 * 为什么需要这个脚本：
 *   8.0+ 的图标是「自适应图标」（mipmap-anydpi-v26/ic_launcher.xml），
 *   启动器只读它里面的 background/foreground，完全不会去看旧的 ic_launcher.png。
 *   所以直接替换 ic_launcher.png 或者只改 colors.xml 里的背景色都没用
 *   （前景 PNG 自带一层黑底，把背景色整块盖住了）。
 *
 * 这个脚本把前景插画的「黑底」抠成透明，按亮度重新上墨色，
 * 再把图标底换成不透明的磨砂玻璃质感（浅白渐变 + 细噪点 + 柔光），
 * 这样在任何壁纸/启动器上都不会因为半透明被垫色而变灰。
 *
 * 用法：node tools/make-launcher-icon.mjs [--ink=#241E1B] [--src=path/to/source.png]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const INK = hexToRgb(argOf('ink', '#241E1B'));
/** 传 --tint=#xxxxxx 可以给徽章图形换一套配色；不传就保留原插画的米金色 */
const TINT = argOf('tint', '') ? hexToRgb(argOf('tint', '')) : null;
// 源插画固定放在 tools/ 下，绝不从 res/ 里读——否则第二次运行会把上次的成品当原图，越跑越小
const SOURCE = argOf('src', path.join(ROOT, 'tools', 'launcher-source.png'));

/** 自适应图标前景安全区：108dp 画布里只有中间 66dp 是保证显示的 */
const FOREGROUND_SCALE = 0.62;

const DENSITIES = [
  { dir: 'mipmap-mdpi', fg: 108, legacy: 48 },
  { dir: 'mipmap-hdpi', fg: 162, legacy: 72 },
  { dir: 'mipmap-xhdpi', fg: 216, legacy: 96 },
  { dir: 'mipmap-xxhdpi', fg: 324, legacy: 144 },
  { dir: 'mipmap-xxxhdpi', fg: 432, legacy: 192 },
];

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng({ w, h, data }) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 解码 8bit 非隔行的 PNG（本工程里的图标都是 colorType 6/2） */
function decodePng(buf) {
  let pos = 8;
  const idat = [];
  let w = 0;
  let h = 0;
  let colorType = 6;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (bpp === 4) {
        out[o] = cur[x * 4];
        out[o + 1] = cur[x * 4 + 1];
        out[o + 2] = cur[x * 4 + 2];
        out[o + 3] = cur[x * 4 + 3];
      } else if (bpp === 3) {
        out[o] = cur[x * 3];
        out[o + 1] = cur[x * 3 + 1];
        out[o + 2] = cur[x * 3 + 2];
        out[o + 3] = 255;
      } else {
        out[o] = out[o + 1] = out[o + 2] = cur[x];
        out[o + 3] = 255;
      }
    }
    prev = cur;
  }
  return { w, h, data: out };
}


const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const smooth = (t) => t * t * (3 - 2 * t);

function sampleBilinear(src, x, y) {
  const x0 = Math.max(0, Math.min(src.w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(src.h - 1, Math.floor(y)));
  const x1 = Math.min(src.w - 1, x0 + 1);
  const y1 = Math.min(src.h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx, yy, ch) => src.data[(yy * src.w + xx) * 4 + ch];
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch += 1) {
    const a = at(x0, y0, ch);
    const b = at(x1, y0, ch);
    const c = at(x0, y1, ch);
    const d = at(x1, y1, ch);
    out[ch] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  return out;
}

/** 哈希噪声，用来做磨砂颗粒（纯函数，重复生成结果一致） */
function grain(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/** 不透明的「无色磨砂玻璃」底：上亮下暗的浅白渐变 + 左上柔光 + 细颗粒 */
function drawGlass(size) {
  const img = { w: size, h: size, data: Buffer.alloc(size * size * 4) };
  // 中性色（不带任何色相），上亮下暗，边缘收一层浅灰，读起来才像一整块玻璃
  const top = [251, 251, 252];
  const bottom = [206, 208, 212];
  for (let y = 0; y < size; y += 1) {
    const ty = smooth(y / (size - 1));
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1);
      const v = y / (size - 1);
      let color = mix(top, bottom, ty);
      const gx = u - 0.3;
      const gy = v - 0.22;
      const glow = Math.exp(-(gx * gx + gy * gy) / 0.05) * 0.32;
      const sx = u - 0.84;
      const sy = v - 0.9;
      const shade = Math.exp(-(sx * sx + sy * sy) / 0.1) * 0.1;
      // 玻璃边缘那圈内侧亮线
      const dx = u - 0.5;
      const dy = v - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) / 0.7071;
      const rim = d > 0.88 ? (d - 0.88) / 0.12 * 10 : 0;
      // 斜向那道玻璃反射，磨砂面被光扫过的感觉
      const band = Math.exp(-Math.pow((u + v - 1.02) / 0.16, 2)) * 14;
      const n = (grain(x, y) - 0.5) * 9;
      color = color.map((c) => Math.round(Math.min(255, Math.max(0, c * (1 + glow - shade) + rim + band + n))));
      const o = (y * size + x) * 4;
      img.data[o] = color[0];
      img.data[o + 1] = color[1];
      img.data[o + 2] = color[2];
      img.data[o + 3] = 255;
    }
  }
  return img;
}

/**
 * 把插画裁成一枚圆形徽章放在中间，四周留给磨砂玻璃底。
 * 直接整幅方形插画填满图标会露出直角、还会和玻璃底打架，
 * 圆形徽章既保留原画，又和圆角/圆形遮罩天然对齐。
 * tint: 传 [r,g,b] 时按亮度给图形重新上色，不传就保持原画配色。
 */
function drawPhoto(src, size, ratio, tint) {
  const img = { w: size, h: size, data: Buffer.alloc(size * size * 4) };
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size * ratio) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const aa = clamp01((radius + 0.5 - d) / 1.6);
      if (aa <= 0) continue;
      const u = (x + 0.5 - (cx - radius)) / (2 * radius);
      const v = (y + 0.5 - (cy - radius)) / (2 * radius);
      const sx = clamp01(u) * (src.w - 1);
      const sy = clamp01(v) * (src.h - 1);
      let [r, g, b] = sampleBilinear(src, sx, sy);
      if (tint) {
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const t = Math.pow(clamp01((lum - 0.05) / 0.75), 0.85);
        const dark = [Math.round(tint[0] * 0.32), Math.round(tint[1] * 0.32), Math.round(tint[2] * 0.32)];
        const tone = mix(dark, tint, t);
        [r, g, b] = tone;
      }
      const o = (y * size + x) * 4;
      // 徽章边缘压一圈浅色，看起来像贴在玻璃上的一张相片
      const edge = clamp01((d - (radius - Math.max(1, size * 0.012))) / Math.max(1, size * 0.012));
      const k = 1 - edge * 0.82;
      img.data[o] = Math.round(r * k + 255 * (1 - k));
      img.data[o + 1] = Math.round(g * k + 255 * (1 - k));
      img.data[o + 2] = Math.round(b * k + 255 * (1 - k));
      img.data[o + 3] = Math.round(255 * aa);
    }
  }
  return img;
}

function insideRounded(size, x, y, radius, round) {
  const half = size / 2;
  if (round) {
    const dx = x - half;
    const dy = y - half;
    return dx * dx + dy * dy <= half * half;
  }
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 旧式图标（Android 7 及以下）：玻璃底裁成圆角方/圆形，再把圆形徽章放上去 */
function drawLegacy(src, size, round) {
  const glass = drawGlass(size);
  const photo = drawPhoto(src, size, 0.62, TINT);
  const out = { w: size, h: size, data: Buffer.alloc(size * size * 4) };
  const radius = round ? size / 2 : size * 0.22;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!insideRounded(size, x + 0.5, y + 0.5, radius, round)) continue;
      const o = (y * size + x) * 4;
      out.data[o] = glass.data[o];
      out.data[o + 1] = glass.data[o + 1];
      out.data[o + 2] = glass.data[o + 2];
      out.data[o + 3] = 255;
      const a = photo.data[o + 3] / 255;
      if (a > 0) {
        out.data[o] = Math.round(photo.data[o] * a + out.data[o] * (1 - a));
        out.data[o + 1] = Math.round(photo.data[o + 1] * a + out.data[o + 1] * (1 - a));
        out.data[o + 2] = Math.round(photo.data[o + 2] * a + out.data[o + 2] * (1 - a));
      }
    }
  }
  return out;
}


function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('找不到源插画: ' + SOURCE);
    process.exit(1);
  }
  if (path.resolve(SOURCE).startsWith(RES)) {
    console.error('源插画不能放在 res/ 里（会被自己覆盖），请用 --src= 指到别处');
    process.exit(1);
  }
  const src = decodePng(fs.readFileSync(SOURCE));
  console.log(`源插画: ${path.relative(ROOT, SOURCE)} (${src.w}x${src.h})`);

  const backupDir = path.join(ROOT, '.icon-backup');
  fs.mkdirSync(backupDir, { recursive: true });

  for (const d of DENSITIES) {
    const dir = path.join(RES, d.dir);
    fs.mkdirSync(dir, { recursive: true });
    const files = {
      'ic_launcher_foreground.png': drawPhoto(src, d.fg, 0.6, TINT),
      'ic_launcher_background.png': drawGlass(d.fg),
      'ic_launcher.png': drawLegacy(src, d.legacy, false),
      'ic_launcher_round.png': drawLegacy(src, d.legacy, true),
    };
    for (const [name, img] of Object.entries(files)) {
      const target = path.join(dir, name);
      const backup = path.join(backupDir, d.dir + '-' + name);
      if (fs.existsSync(target) && !fs.existsSync(backup)) {
        fs.copyFileSync(target, backup);
      }
      fs.writeFileSync(target, encodePng(img));
    }
    console.log(`[${d.dir}] 前景 ${d.fg}px / 旧图标 ${d.legacy}px`);
  }
  console.log('完成。原始图标备份在 .icon-backup/（不参与打包，可随时回滚）');
}

main();

