/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Ornaments ▸ Ring: find a round frame's radii and roll it out into a strip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRing, unwrapRing } from '../js/ringUnwrap.js';

const N = 200;
// A ring from radius 60 to 90 px; inside it a marker wedge at angle 0 (towards +x).
function ringImage() {
  const d = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x + 0.5 - N / 2, dy = y + 0.5 - N / 2;
    const r = Math.hypot(dx, dy);
    const a = Math.atan2(-dy, dx);   // counter-clockwise, image y down
    let v = 0;
    if (r >= 60 && r <= 90) v = Math.abs(a) < 0.2 ? 255 : 120;
    d.set([v, v, v, 255], (y * N + x) * 4);
  }
  return d;
}

test('detectRing finds the inner and outer radius', () => {
  const r = detectRing(ringImage(), N, N);
  assert.equal(r.cx, 100); assert.equal(r.cy, 100);
  assert.ok(Math.abs(r.rIn - 60) <= 2, `rIn ${r.rIn}`);
  assert.ok(Math.abs(r.rOut - 90) <= 2, `rOut ${r.rOut}`);
});

test('a medallion without a hole starts at the centre', () => {
  const d = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = Math.hypot(x + 0.5 - 100, y + 0.5 - 100) < 70 ? 200 : 0;
    d.set([v, v, v, 255], (y * N + x) * 4);
  }
  const r = detectRing(d, N, N);
  assert.equal(r.rIn, 0);
  assert.ok(Math.abs(r.rOut - 70) <= 2);
});

test('unwrapRing: angle across, the marker at the left edge, thickness down', () => {
  const img = ringImage();
  const ring = { cx: 100, cy: 100, rIn: 60, rOut: 90 };
  const s = unwrapRing(img, N, N, ring);
  assert.equal(s.width, Math.round(2 * Math.PI * 90));
  assert.equal(s.height, 30);
  const at = (x, y) => s.data[(y * s.width + x) * 4];
  const mid = 15;
  assert.ok(at(2, mid) > 200, 'marker just after angle 0');
  assert.ok(at(s.width - 3, mid) > 200, 'and just before 2π (it wraps)');
  assert.ok(Math.abs(at(Math.round(s.width / 2), mid) - 120) < 10, 'ring grey half way round');
  // Narrow the ring: only the annulus is rolled out.
  const out = unwrapRing(img, N, N, { ...ring, rIn: 40, rOut: 110 });
  assert.ok(out.data[(2 * out.width + 300) * 4] < 10, 'outside the drawing stays black');
});

test('a very large ring is capped in width and keeps its proportions', () => {
  const s = unwrapRing(ringImage(), N, N, { cx: 100, cy: 100, rIn: 60, rOut: 90 }, { maxWidth: 283 });
  assert.equal(s.width, 283);
  assert.equal(s.height, Math.round(30 * 283 / (2 * Math.PI * 90)));
});

test('flip turns the strip 180°: inner edge on top, angle reversed', () => {
  const img = ringImage();
  const ring = { cx: 100, cy: 100, rIn: 60, rOut: 90 };
  const a = unwrapRing(img, N, N, ring);
  const b = unwrapRing(img, N, N, ring, { flip: true });
  assert.equal(b.width, a.width); assert.equal(b.height, a.height);
  for (const [x, y] of [[2, 3], [100, 10], [a.width - 5, a.height - 2]]) {
    assert.equal(b.data[(y * b.width + x) * 4], a.data[((a.height - 1 - y) * a.width + (a.width - 1 - x)) * 4]);
  }
});

test('detectRingLines finds the closed circles of a drawing', async () => {
  const { detectRingLines } = await import('../js/ringUnwrap.js');
  const d = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = Math.hypot(x + 0.5 - 100, y + 0.5 - 100);
    const a = Math.atan2(y + 0.5 - 100, x + 0.5 - 100);
    // circles at 40 and 80 px, a broken (dashed) circle at 60 px, spokes in between
    let v = (Math.abs(r - 40) < 2 || Math.abs(r - 80) < 2) ? 255 : 0;
    if (Math.abs(r - 60) < 2 && Math.sin(a * 12) > 0) v = 255;
    if (r > 42 && r < 78 && Math.abs(Math.sin(a * 8)) < 0.05) v = 255;
    d.set([v, v, v, 255], (y * N + x) * 4);
  }
  const lines = detectRingLines(d, N, N);
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.ok(Math.abs(lines[0] - 0.4) < 0.02 && Math.abs(lines[1] - 0.8) < 0.02);
});
