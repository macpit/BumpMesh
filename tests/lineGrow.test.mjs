/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Ornaments ▸ Thicker lines: growLines widens the bright pattern by rx / ry px.
import test from 'node:test';
import assert from 'node:assert/strict';
import { growLines } from '../js/lineGrow.js';

function img(w, h, on) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = on(x, y) ? 255 : 0;
    d.set([v, v, v, 255], (y * w + x) * 4);
  }
  return d;
}
const width = (d, w, y) => { let n = 0; for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] >= 128) n++; return n; };

test('a one-pixel line grows by the radius on each side', () => {
  const w = 60, h = 20, d = img(w, h, (x) => x === 30);
  for (const r of [0, 2, 5]) assert.equal(width(growLines(d, w, h, r, r), w, 10), 1 + 2 * r);
});

test('separate radii across and down', () => {
  const w = 40, h = 40, d = img(w, h, (x, y) => x === 20 && y === 20);
  const o = growLines(d, w, h, 6, 2);
  assert.equal(width(o, w, 20), 13);
  let down = 0; for (let y = 0; y < h; y++) if (o[(y * w + 20) * 4] >= 128) down++;
  assert.equal(down, 5);
});

test('wrap: a line at the edge grows over into the other side only when tiling', () => {
  const w = 30, h = 10, d = img(w, h, (x) => x === 0);
  const plain = growLines(d, w, h, 3, 3);
  const wrapped = growLines(d, w, h, 3, 3, { wrapX: true });
  assert.equal(plain[(5 * w + 28) * 4], 0);
  assert.ok(wrapped[(5 * w + 28) * 4] >= 128);
  assert.equal(width(wrapped, w, 5), 7);
});

test('the source is left alone and grey parts are never darkened', () => {
  const w = 20, h = 4, d = img(w, h, (x) => x === 10);
  d[(1 * w + 2) * 4] = 90;   // a faint grey dot, below mid grey
  const copy = d.slice();
  const o = growLines(d, w, h, 2, 2);
  assert.deepEqual(d, copy);
  assert.equal(o[(1 * w + 2) * 4], 90);
});
