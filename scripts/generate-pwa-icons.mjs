#!/usr/bin/env node
/**
 * Generates the PWA icon set into public/icons/.
 *
 * WHY THIS EXISTS INSTEAD OF A COMMITTED BINARY:
 * the repo held no Grays artwork above 32x32 (public/favicon-32x32.webp, 504 B)
 * — every other logo file in the tree is the stock Create React App React mark.
 * Upscaling 32px to 512px would ship a blurry home-screen icon. So the mark is
 * drawn here as geometry: crisp at any size, diffable in review, and
 * regenerable in one command the moment the official artwork lands.
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * ⚠️ These are DERIVED from the existing portal favicon (a white "G" on a solid
 * disc), recoloured to Brand Red #B50B1D per the brand rules. They are a
 * faithful stand-in, NOT the official logo file — see the F19 report. When the
 * official asset arrives, replace public/icons/* and delete this script.
 *
 * No image dependencies: PNGs are encoded with node:zlib, which ships with node.
 * No AI-generated imagery — this is the brand mark as vector geometry.
 */

import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'public', 'icons');

// Brand Red — the only primary/CTA colour (brand rules).
const BRAND = [0xb5, 0x0b, 0x1d];
const WHITE = [0xff, 0xff, 0xff];

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, 8-bit, no interlace)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Raw scanlines, each prefixed with filter byte 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The mark: a white geometric "G" on a Brand Red disc.
// Coordinates are normalised to [-1, 1]; `scale` shrinks the mark for the
// maskable variant so Android's adaptive mask cannot crop it.
// ---------------------------------------------------------------------------

// Ring geometry (fractions of the half-canvas).
const R_OUT = 0.76;
const R_IN = 0.48;
// The G's mouth: the ring is cut away across this angular span, opening at the
// upper right (just above the 3-o'clock axis) the way a G's aperture does.
// Starts just below the 3-o'clock axis so the aperture's lower edge is always
// under the crossbar's top edge — otherwise a one-pixel sliver of ring survives
// between the two and reads as a nick in the letterform.
const GAP_FROM = -0.10; // radians
const GAP_TO = 0.62; // radians
// Crossbar: the horizontal tongue that makes a G out of a C. It sits directly
// under the aperture and points inward from the ring's outer edge.
const BAR_TOP = -0.04; // upper edge (maths y, +y up)
const BAR_BOTTOM = -0.24; // lower edge
const BAR_X0 = 0.30; // inner end

function inMark(x, y) {
  const d = Math.hypot(x, y);

  // Ring, minus the aperture.
  if (d >= R_IN && d <= R_OUT) {
    const a = Math.atan2(y, x);
    const inGap = a > GAP_FROM && a < GAP_TO;
    if (!inGap) return true;
  }

  // Crossbar, clipped to the disc so it never pokes out past the ring.
  if (x >= BAR_X0 && y <= BAR_TOP && y >= BAR_BOTTOM && d <= R_OUT) {
    return true;
  }

  return false;
}

function renderIcon(size, { scale = 1, background = 'disc' } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersampling for clean edges
  const half = size / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgHits = 0;
      let fgHits = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          // Normalised coords, y flipped so +y is up (maths convention).
          const nx = ((px + (sx + 0.5) / SS) - half) / half;
          const ny = -((py + (sy + 0.5) / SS) - half) / half;

          const bx = nx / scale;
          const by = ny / scale;

          const inBg = background === 'disc'
            ? Math.hypot(nx, ny) <= 0.98
            : true; // 'full' — maskable icons must paint edge to edge

          if (inBg) bgHits += 1;
          if (inBg && inMark(bx, by)) fgHits += 1;
        }
      }

      const total = SS * SS;
      const bgA = bgHits / total;
      const fgA = fgHits / total;
      const i = (py * size + px) * 4;

      if (bgA === 0) {
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
        continue;
      }

      // Composite white mark over the brand disc, then the disc over transparency.
      for (let c = 0; c < 3; c += 1) {
        rgba[i + c] = Math.round(BRAND[c] * (1 - fgA) + WHITE[c] * fgA);
      }
      rgba[i + 3] = Math.round(255 * bgA);
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });

const targets = [
  // Standard "any" icons — the disc reaches the canvas edge.
  { file: 'icon-192.png', size: 192, opts: { scale: 1, background: 'disc' } },
  { file: 'icon-512.png', size: 512, opts: { scale: 1, background: 'disc' } },
  // iOS home screen: full-bleed square (iOS composites transparency onto black),
  // with the mark inset so Safari's rounded-rect mask cannot clip the letterform.
  { file: 'apple-touch-icon-180.png', size: 180, opts: { scale: 0.78, background: 'full' } },
  // Maskable: mark shrunk into the central safe zone (Android crops to ~80%).
  { file: 'icon-512-maskable.png', size: 512, opts: { scale: 0.62, background: 'full' } },
];

for (const t of targets) {
  const png = renderIcon(t.size, t.opts);
  writeFileSync(path.join(outDir, t.file), png);
  console.log(`wrote public/icons/${t.file}  (${t.size}x${t.size}, ${png.length} B)`);
}

console.log('\nDerived from the existing portal favicon, recoloured to Brand Red #B50B1D.');
console.log('Replace with the official artwork when available.');
