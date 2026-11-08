/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Ornaments ▸ Ring "over the bowl": a round image laid over a round model
// from the centre of its bottom, the image radius measured along the
// surface. The model's outer profile (half-section around the axis: from the
// axis along the bottom, then up the wall to the top) gives every point an
// arc length — the distance from the bottom centre along the outside. A
// point anywhere on the model (also the inside wall) takes the arc length of
// the nearest profile point, so the inside and the outside carry the pattern
// at the same place, as if punched through.
//
// The arc lengths are tabulated on an nr × nz grid over (radius, height);
// the CPU and the preview shader read the same table bilinearly.

/**
 * @param {Float32Array|number[]} pos  triangle soup (x, y, z per corner)
 * @param {number} cx @param {number} cy  axis position
 * @returns {{data: Float32Array, nr: number, nz: number, rMax: number,
 *   zMin: number, zMax: number, sTop: number, profile: number[][]}}
 */
export function buildBowlTable(pos, cx, cy, { nr = 128, nz = 128, bins = 96 } = {}) {
  let zMin = Infinity, zMax = -Infinity, rMax = 0;
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const z = pos[i * 3 + 2];
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    const r = Math.hypot(pos[i * 3] - cx, pos[i * 3 + 1] - cy);
    if (r > rMax) rMax = r;
  }
  const h = Math.max(zMax - zMin, 1e-6);
  rMax = Math.max(rMax, 1e-6);

  // Outer radius per height band, sampled along every triangle edge so a
  // band with no corner of the outer wall still sees that wall (and not
  // only the inside).
  const rOut = new Float64Array(bins).fill(-1);
  const band = h / bins;
  const put = (x, y, z) => {
    const k = Math.min(bins - 1, Math.max(0, Math.floor((z - zMin) / h * bins)));
    const r = Math.hypot(x - cx, y - cy);
    if (r > rOut[k]) rOut[k] = r;
  };
  for (let t = 0; t < n / 3; t++) {
    for (let e = 0; e < 3; e++) {
      const a = (t * 3 + e) * 3, b = (t * 3 + (e + 1) % 3) * 3;
      const steps = Math.min(512, Math.ceil(Math.abs(pos[b + 2] - pos[a + 2]) / band) + 1);
      for (let k = 0; k <= steps; k++) {
        const q = k / steps;
        put(pos[a] + (pos[b] - pos[a]) * q, pos[a + 1] + (pos[b + 1] - pos[a + 1]) * q, pos[a + 2] + (pos[b + 2] - pos[a + 2]) * q);
      }
    }
  }
  // Empty bands (sparse meshes): carry the neighbours over.
  let last = -1;
  for (let k = 0; k < bins; k++) { if (rOut[k] >= 0) last = rOut[k]; else if (last >= 0) rOut[k] = last; }
  last = -1;
  for (let k = bins - 1; k >= 0; k--) { if (rOut[k] >= 0) last = rOut[k]; else rOut[k] = Math.max(0, last); }

  // Profile: axis → along the bottom → up the outside to the top.
  const profile = [[0, zMin], [rOut[0], zMin]];
  for (let k = 0; k < bins; k++) profile.push([rOut[k], zMin + (k + 0.5) / bins * h]);
  profile.push([rOut[bins - 1], zMax]);
  const cum = [0];
  for (let i = 1; i < profile.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  }

  const data = new Float32Array(nr * nz);
  for (let j = 0; j < nz; j++) {
    const z = zMin + j / (nz - 1) * h;
    for (let i = 0; i < nr; i++) {
      const r = i / (nr - 1) * rMax;
      let best = Infinity, s = 0;
      for (let k = 1; k < profile.length; k++) {
        const [ax, az] = profile[k - 1], [bx, bz] = profile[k];
        const dx = bx - ax, dz = bz - az;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((r - ax) * dx + (z - az) * dz) / len2)) : 0;
        const ex = ax + t * dx - r, ez = az + t * dz - z;
        const d2 = ex * ex + ez * ez;
        if (d2 < best) { best = d2; s = cum[k - 1] + t * (cum[k] - cum[k - 1]); }
      }
      data[j * nr + i] = s;
    }
  }
  return { data, nr, nz, rMax, zMin, zMax, sTop: cum[cum.length - 1], profile, cum };
}

/** Arc length (mm from the bottom centre along the surface) at radius r, height z — bilinear. */
export function bowlArc(table, r, z) {
  const { data, nr, nz, rMax, zMin, zMax } = table;
  const fx = Math.max(0, Math.min(nr - 1, r / rMax * (nr - 1)));
  const fz = Math.max(0, Math.min(nz - 1, (z - zMin) / Math.max(zMax - zMin, 1e-6) * (nz - 1)));
  const x0 = Math.min(nr - 2, Math.floor(fx)), z0 = Math.min(nz - 2, Math.floor(fz));
  const tx = fx - x0, tz = fz - z0;
  const a = data[z0 * nr + x0], b = data[z0 * nr + x0 + 1];
  const c = data[(z0 + 1) * nr + x0], d = data[(z0 + 1) * nr + x0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** The outer profile point (radius, height) at arc length s — where a line at s runs around the model. */
export function bowlPointAt(table, s) {
  const { profile, cum } = table;
  if (s <= 0) return profile[0];
  for (let k = 1; k < profile.length; k++) {
    if (s <= cum[k]) {
      const t = (s - cum[k - 1]) / Math.max(cum[k] - cum[k - 1], 1e-9);
      return [profile[k - 1][0] + t * (profile[k][0] - profile[k - 1][0]),
              profile[k - 1][1] + t * (profile[k][1] - profile[k - 1][1])];
    }
  }
  return profile[profile.length - 1];
}

/**
 * Ring over the bowl ▸ placement curve: arc length on the model (mm) → arc
 * length in the image's own scale (mm at the chosen diameter). With lines
 * (pts: [s, q] pairs, s ascending) it runs piecewise-linear through them and
 * through (0, 0), and 1 : 1 beyond the last; without, a power curve
 * q = R·(s/R)^gamma spreads the middle (gamma > 1: the image's centre takes
 * more of the bottom) or squeezes it (gamma < 1).
 */
export function bowlWarp(warp, s) {
  if (!warp || s <= 0) return Math.max(0, s);
  const { pts, gamma, R } = warp;
  if (pts && pts.length) {
    let ps = 0, pq = 0;
    for (const [ks, kq] of pts) {
      if (s <= ks) return pq + (s - ps) / Math.max(ks - ps, 1e-9) * (kq - pq);
      ps = ks; pq = kq;
    }
    return pq + (s - ps);
  }
  if (!gamma || gamma === 1) return s;
  return R * Math.pow(s / R, gamma);
}

/** Inverse of bowlWarp (monotonic): the model arc length where image arc length q lands. */
export function bowlUnwarp(warp, q, sMax) {
  let lo = 0, hi = Math.max(sMax, q) * 4 + 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (bowlWarp(warp, mid) < q) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
