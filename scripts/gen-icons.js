// 生成 tabBar 图标（简约线性风格：首页=房屋，我的=人像），81x81 PNG
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 81, H = 81;
const OUT = path.join(__dirname, '..', 'miniprogram', 'assets');
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(pixels) {
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    for (let x = 0; x < W; x++) {
      const i = y * (1 + W * 4) + 1 + x * 4;
      raw[i] = pixels[y][x][0]; raw[i + 1] = pixels[y][x][1]; raw[i + 2] = pixels[y][x][2]; raw[i + 3] = pixels[y][x][3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const T = 6; // 线宽
function draw(kind, [r, g, b]) {
  const px = Array.from({ length: H }, () => Array.from({ length: W }, () => [0, 0, 0, 0]));
  const put = (x, y) => { if (x >= 0 && x < W && y >= 0 && y < H) px[y][x] = [r, g, b, 255]; };
  const line = (x1, y1, x2, y2, t = T) => {
    const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2) || 1;
    for (let s = 0; s <= steps; s++) {
      const x = x1 + (x2 - x1) * s / steps, y = y1 + (y2 - y1) * s / steps;
      for (let dx = -t / 2; dx < t / 2; dx++) for (let dy = -t / 2; dy < t / 2; dy++) put(Math.round(x + dx), Math.round(y + dy));
    }
  };
  const circle = (cx, cy, rr, t = T) => {
    for (let a = 0; a < 360; a += 0.5) {
      const x = cx + rr * Math.cos(a * Math.PI / 180), y = cy + rr * Math.sin(a * Math.PI / 180);
      for (let dx = -t / 2; dx < t / 2; dx++) for (let dy = -t / 2; dy < t / 2; dy++) put(Math.round(x + dx), Math.round(y + dy));
    }
  };
  if (kind === 'home') { // 屋顶 + 墙体
    line(40, 14, 12, 40); line(40, 14, 68, 40);
    line(20, 34, 20, 66); line(60, 34, 60, 66);
    line(20, 66, 60, 66);
    line(34, 66, 34, 48, 4); line(46, 66, 46, 48, 4); line(34, 48, 46, 48, 4);
  } else { // 人像：头 + 肩
    circle(40, 28, 13);
    circle(40, 74, 26);
    for (let x = 0; x < W; x++) if (px[64] && px[64][x][3]) for (let y = 64; y < H; y++) put(x, y);
  }
  return png(px);
}
const GRAY = [122, 129, 148], GOLD = [212, 180, 131];
fs.writeFileSync(path.join(OUT, 'home.png'), draw('home', GRAY));
fs.writeFileSync(path.join(OUT, 'home-active.png'), draw('home', GOLD));
fs.writeFileSync(path.join(OUT, 'user.png'), draw('user', GRAY));
fs.writeFileSync(path.join(OUT, 'user-active.png'), draw('user', GOLD));
console.log('icons written to', OUT);
