// Gera build/icon.png e build/icon.ico (cubo isométrico com código de barras).
// Uso: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function faceUV(x, y, A, B, D) {
  const ux = B[0] - A[0], uy = B[1] - A[1], vx = D[0] - A[0], vy = D[1] - A[1];
  const det = ux * vy - uy * vx;
  const px = x - A[0], py = y - A[1];
  return [(px * vy - py * vx) / det, (ux * py - uy * px) / det];
}

// Retorna [r,g,b,a] (0..255) para um ponto no espaço 256x256
function shade(x, y) {
  // fundo: quadrado arredondado
  const r = 54, m = 8;
  const cx = Math.min(Math.max(x, m + r), 256 - m - r);
  const cy = Math.min(Math.max(y, m + r), 256 - m - r);
  const d = Math.hypot(x - cx, y - cy);
  if (d > r) return [0, 0, 0, 0];
  let col = mix(hex('#101a3f'), hex('#050816'), (y - m) / (256 - 2 * m));
  if (d > r - 3) col = mix(col, hex('#22d3ee'), 0.55);

  const top = [[128, 46], [204, 90], [128, 134], [52, 90]];
  const left = [[52, 90], [128, 134], [128, 218], [52, 174]];
  const right = [[128, 134], [204, 90], [204, 174], [128, 218]];

  // brilho sob o cubo
  const glow = Math.max(0, 1 - Math.hypot(x - 128, (y - 214) * 2.4) / 110);
  col = mix(col, hex('#22d3ee'), glow * 0.35);

  if (inPoly(x, y, top)) {
    const [u, v] = faceUV(x, y, [128, 46], [204, 90], [52, 90]);
    col = mix(hex('#a5f3fc'), hex('#67e8f9'), (u + v) / 2);
    if (u < 0.05 || v < 0.05 || u > 0.95 || v > 0.95) col = mix(col, [255, 255, 255], 0.6);
  } else if (inPoly(x, y, left)) {
    const [u, v] = faceUV(x, y, [52, 90], [128, 134], [52, 174]);
    col = mix(hex('#22d3ee'), hex('#0e7490'), v);
    const bars = [[0.12, 0.18], [0.22, 0.26], [0.3, 0.4], [0.44, 0.48], [0.53, 0.62], [0.66, 0.7], [0.75, 0.86]];
    if (v > 0.32 && v < 0.78 && bars.some(([a, b]) => u > a && u < b)) col = hex('#062a35');
    if (u > 0.97) col = mix(col, [255, 255, 255], 0.35);
  } else if (inPoly(x, y, right)) {
    const [, v] = faceUV(x, y, [128, 134], [204, 90], [128, 218]);
    col = mix(hex('#818cf8'), hex('#4338ca'), v);
  }
  return [...col, 255];
}

function render(size) {
  const S = 4; // supersampling
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = shade(((x + (sx + 0.5) / S) * 256) / size, ((y + (sy + 0.5) / S) * 256) / size);
          const a = c[3] / 255;
          acc = [acc[0] + c[0] * a, acc[1] + c[1] * a, acc[2] + c[2] * a, acc[3] + c[3]];
        }
      }
      const n = S * S;
      const alpha = acc[3] / n;
      const i = (y * size + x) * 4;
      const k = alpha > 0 ? 255 / alpha : 0;
      px[i] = Math.round((acc[0] / n) * k);
      px[i + 1] = Math.round((acc[1] / n) * k);
      px[i + 2] = Math.round((acc[2] / n) * k);
      px[i + 3] = Math.round(alpha);
    }
  }
  return px;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
const big = png(256);
fs.writeFileSync(path.join(out, 'icon.png'), big);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => (s === 256 ? big : png(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
console.log('Ícones gerados em', out);
