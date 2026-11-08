/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Ornaments ▸ Thicker lines: widens the bright parts of a height map (the
// pattern) by a radius given separately in x and y (pixels), so thin lines
// of a single-line SVG get printable. Exact Euclidean distance transform
// (Felzenszwalb & Huttenlocher) on the pixels at or above mid grey, scaled so
// the ellipse rx × ry becomes the unit circle; the new edge is anti-aliased
// over about one pixel. With wrapX / wrapY the map is treated as tiling in
// that direction (a border repeats around and its rows stack).

const INF = 1e20;

/** 1D squared distance transform of f (length n) into d; v, z scratch. */
function dt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Transform one line (src stride/offset) with scale s (distance units per
 * pixel step); periodic lines are processed three times over and the middle
 * copy kept.
 */
function line(src, off, stride, n, s, wrap, buf) {
  const m = wrap ? 3 * n : n;
  const { f, d, v, z } = buf;
  const inv = 1 / (s * s);
  for (let i = 0; i < m; i++) {
    const val = src[off + (i % n) * stride];
    f[i] = val >= INF ? INF : val * inv;
  }
  dt1d(f, m, d, v, z);
  const base = wrap ? n : 0;
  for (let i = 0; i < n; i++) src[off + i * stride] = Math.min(INF, d[base + i] * s * s);
}

/**
 * @param {Uint8ClampedArray} data  RGBA, grey in R (as the height samplers read it)
 * @param {number} w @param {number} h
 * @param {number} rx @param {number} ry  growth radius in pixels (≥ 0)
 * @param {{wrapX?: boolean, wrapY?: boolean}} [opts]
 * @returns {Uint8ClampedArray} a new RGBA buffer (opaque grey)
 */
export function growLines(data, w, h, rx, ry, opts = {}) {
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  if (!(rx > 0) && !(ry > 0)) return out;
  rx = Math.max(rx, 1e-3); ry = Math.max(ry, 1e-3);
  const D = new Float64Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4] >= 128) { D[i] = 0; any = true; } else D[i] = INF;
  }
  if (!any) return out;
  const n = 3 * Math.max(w, h) + 2;
  const buf = { f: new Float64Array(n), d: new Float64Array(n), v: new Int32Array(n), z: new Float64Array(n + 1) };
  // Distances in units of the radius: one pixel step is 1/rx across, 1/ry down.
  for (let y = 0; y < h; y++) line(D, y * w, 1, w, 1 / rx, !!opts.wrapX, buf);
  for (let x = 0; x < w; x++) line(D, x, w, h, 1 / ry, !!opts.wrapY, buf);
  // Anti-aliasing ramp of about one pixel, in radius units.
  const aa = 1 / Math.max(1, Math.min(rx, ry));
  for (let i = 0; i < w * h; i++) {
    if (D[i] >= INF) continue;
    const dist = Math.sqrt(D[i]);
    const t = Math.max(0, Math.min(1, (1 + aa * 0.5 - dist) / aa));
    if (t <= 0) continue;
    const g = Math.round(255 * t);
    const o = i * 4;
    if (g > out[o]) { out[o] = out[o + 1] = out[o + 2] = g; }
    out[o + 3] = 255;
  }
  return out;
}
