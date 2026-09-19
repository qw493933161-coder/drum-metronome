// Zero-dependency PNG icon generator (uses only Node's built-in zlib) so the
// PWA manifest has real installable icons without pulling in any image libs.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdrData),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const BG = hex('#1b1d29');
const ACCENT = hex('#ff6b4a');
const WHITE = hex('#f2f3f7');

function draw(size, { maskable }) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const cornerR = maskable ? 0 : size * 0.22;

  // bars: 5 vertical bars, heights as fraction of usable bar area, alternating colors
  const heights = [0.38, 0.66, 1.0, 0.66, 0.38];
  const colors = [WHITE, ACCENT, WHITE, ACCENT, WHITE];
  const safeScale = maskable ? 0.62 : 0.82; // keep content inside the safe circle for maskable icons
  const barAreaW = size * safeScale;
  const barAreaH = size * safeScale;
  const barCount = heights.length;
  const gap = barAreaW * 0.06;
  const barW = (barAreaW - gap * (barCount - 1)) / barCount;
  const baseY = cy + barAreaH / 2;
  const startX = cx - barAreaW / 2;
  const radius = barW * 0.28;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      let r = BG[0], g = BG[1], b = BG[2], a = 255;

      if (cornerR > 0) {
        // rounded-square alpha mask (transparent outside the squircle corners)
        const inCornerX = x < cornerR || x > size - cornerR;
        const inCornerY = y < cornerR || y > size - cornerR;
        if (inCornerX && inCornerY) {
          const ccx = x < cornerR ? cornerR : size - cornerR;
          const ccy = y < cornerR ? cornerR : size - cornerR;
          const dist = Math.hypot(x - ccx, y - ccy);
          if (dist > cornerR) a = 0;
        }
      }

      for (let bi = 0; bi < barCount; bi++) {
        const bx0 = startX + bi * (barW + gap);
        const bx1 = bx0 + barW;
        const bh = barAreaH * heights[bi];
        const by0 = baseY - bh;
        const by1 = baseY;
        if (x >= bx0 - radius && x <= bx1 + radius && y >= by0 - radius && y <= by1) {
          // rounded top corners only, cheap approximation: skip the two very-top corner squares
          const nearTop = y < by0 + radius;
          const leftCorner = x < bx0 + radius;
          const rightCorner = x > bx1 - radius;
          let inside = true;
          if (nearTop && leftCorner) inside = Math.hypot(x - (bx0 + radius), y - (by0 + radius)) <= radius;
          else if (nearTop && rightCorner) inside = Math.hypot(x - (bx1 - radius), y - (by0 + radius)) <= radius;
          else inside = x >= bx0 && x <= bx1 && y >= by0 && y <= by1;
          if (inside && x >= bx0 && x <= bx1) {
            r = colors[bi][0]; g = colors[bi][1]; b = colors[bi][2];
          }
        }
      }

      buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = a;
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

[
  { size: 192, name: 'icon-192.png', maskable: false },
  { size: 512, name: 'icon-512.png', maskable: false },
  { size: 512, name: 'icon-maskable-512.png', maskable: true }
].forEach(({ size, name, maskable }) => {
  const rgba = draw(size, { maskable });
  const png = encodePng(size, size, rgba);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('wrote', name, `${size}x${size}`, png.length + ' bytes');
});
