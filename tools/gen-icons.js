// Regenerates icons/icon{16,32,48,128}.png
//
// Run with:  node tools/gen-icons.js
//
// No dependencies — a minimal RGBA PNG encoder built on Node's zlib. The art is
// the extension's own visual language: a dark rounded tile with an orange
// "margin" ring around a green "padding" ring around a light content square.

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "icons");

// ---------------------------------------------------------------- PNG encoder
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- drawing
function makeIcon(N) {
  const buf = Buffer.alloc(N * N * 4); // fully transparent

  const px = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const i = (y * N + x) * 4;
    const sa = a / 255;
    const da = buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };
  const fill = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) px(x, y, c);
  };
  const stroke = (x0, y0, x1, y1, t, c) => {
    fill(x0, y0, x1, y0 + t, c);
    fill(x0, y1 - t, x1, y1, c);
    fill(x0, y0, x0 + t, y1, c);
    fill(x1 - t, y0, x1, y1, c);
  };

  const BG = [0x24, 0x25, 0x2b, 255];
  const ORANGE = [0xf6, 0xb2, 0x6b, 255];
  const GREEN = [0x87, 0xc8, 0x82, 255];
  const CONTENT = [0xe8, 0xea, 0xed, 255];

  // Rounded-rectangle background.
  const r = Math.max(2, Math.round(N * 0.16));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const cx = Math.min(Math.max(fx, r), N - r);
      const cy = Math.min(Math.max(fy, r), N - r);
      if ((fx - cx) ** 2 + (fy - cy) ** 2 <= r * r) px(x, y, BG);
    }
  }

  const t = Math.max(1, Math.round(N * 0.055));
  stroke(N * 0.16, N * 0.16, N * 0.84, N * 0.84, t, ORANGE);
  stroke(N * 0.32, N * 0.32, N * 0.68, N * 0.68, t, GREEN);
  fill(N * 0.43, N * 0.43, N * 0.57, N * 0.57, CONTENT);

  return encodePNG(N, buf);
}

fs.mkdirSync(OUT, { recursive: true });
for (const N of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(OUT, `icon${N}.png`), makeIcon(N));
  console.log(`wrote icons/icon${N}.png`);
}
