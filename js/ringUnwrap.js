/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Ornaments ▸ Ring: round frames and medallions (an annulus drawn around the
// image centre). detectRing finds the inner and outer radius of the drawing;
// unwrapRing rolls the annulus out into a strip — angle across, radius down,
// the outer edge in the top row — so it can run around a wall as a border
// that closes exactly once.

/** Grey 0–1 at pixel (x, y), bilinear; 0 outside the image. */
function grey(data, w, h, x, y) {
  const fx = x - 0.5, fy = y - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h) ? 0 : data[(yy * w + xx) * 4] / 255;
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty)
       + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/**
 * Inner and outer radius (px) of the drawing around the image centre: the
 * radii where the strongest grey on a circle rises above a sixth of the
 * image's strongest. A medallion without a hole gets rIn = 0.
 * @returns {{cx: number, cy: number, rIn: number, rOut: number}}
 */
export function detectRing(data, w, h) {
  const cx = w / 2, cy = h / 2;
  const R = Math.floor(Math.min(w, h) / 2);
  const prof = new Float32Array(R + 1);
  let top = 0;
  for (let r = 0; r <= R; r++) {
    const n = Math.max(16, Math.ceil(2 * Math.PI * r));
    let m = 0;
    for (let k = 0; k < n; k++) {
      const a = 2 * Math.PI * k / n;
      const g = grey(data, w, h, cx + r * Math.cos(a), cy + r * Math.sin(a));
      if (g > m) m = g;
    }
    prof[r] = m;
    if (m > top) top = m;
  }
  const thr = top / 6;
  let rIn = 0, rOut = R;
  while (rIn < R && prof[rIn] <= thr) rIn++;
  while (rOut > rIn && prof[rOut] <= thr) rOut--;
  if (rOut <= rIn) return { cx, cy, rIn: 0, rOut: R };
  return { cx, cy, rIn: Math.max(0, rIn - 1), rOut: Math.min(R, rOut + 1) };
}

/**
 * The annulus rIn…rOut as a strip: column x is the angle 2π·x/width
 * (counter-clockwise from +x, with the image's y axis pointing down),
 * row 0 the outer edge, the last row the inner edge. Width follows the
 * outer circumference (at most maxWidth), height the ring's thickness.
 * With flip the strip is turned 180° (inner edge on top), for drawings
 * whose motifs stand on the outer edge.
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function unwrapRing(data, w, h, ring, { maxWidth = 4096, flip = false } = {}) {
  const { cx, cy, rIn, rOut } = ring;
  const width = Math.max(64, Math.min(maxWidth, Math.round(2 * Math.PI * rOut)));
  const scale = width / (2 * Math.PI * rOut);   // < 1 when capped: shrink the height alike
  const height = Math.max(4, Math.round((rOut - rIn) * scale));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const r = rOut - (y + 0.5) / height * (rOut - rIn);
    for (let x = 0; x < width; x++) {
      const a = 2 * Math.PI * (x + 0.5) / width;
      const g = Math.round(255 * grey(data, w, h, cx + r * Math.cos(a), cy - r * Math.sin(a)));
      // flip: the strip turned 180° — inner edge on top, read the right way up.
      const o = flip ? ((height - 1 - y) * width + (width - 1 - x)) * 4 : (y * width + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}
