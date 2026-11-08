/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * colorBands.js — color by height: split the displaced mesh along height
 * contour lines so every triangle lies in exactly one height band, and the
 * 3MF writer can give each band its own filament.
 *
 * Height is the composited displacement in mm (displacement.js `acc`, the
 * same quantity the preview shader's compositeHeight() returns), normalised
 * to 0..1 over the texture's possible range (heightRangeMm). Band k covers
 * [T[k-1], T[k]) of that normalised height; band 0 is also the filament of
 * every untextured face.
 *
 * Watertightness: a contour crosses a triangle edge at exactly one point per
 * threshold. That point is computed once per edge, in canonical (lower id
 * first) direction, so both triangles sharing the edge get bit-identical
 * coordinates and the mesh stays closed. A crossing closer than `snapMm` to
 * an edge's end would produce a sliver that slicers delete (opening a hole);
 * instead the vertex's height is snapped onto the threshold, which removes
 * that crossing on every edge at once.
 */

import { QuantizedPointMap, IntPairMap } from './meshIndex.js';

/** Slicers address at most 16 extruders (OrcaSlicer's EnforcerBlockerType). */
export const MAX_FILAMENTS = 16;

/**
 * Range of the composited displacement in mm, for normalising heights.
 * A layer spans [0, amp] ([amp, 0] when pushing in), or ±|amp|/2 when symmetric; several layers
 * span the union (blend-add layers can exceed it — those heights clamp).
 * @param {object} settings  global settings (single-texture mode)
 * @param {Array<{settings: object}>|null} [layers]
 * @returns {{min: number, max: number}}
 */
export function heightRangeMm(settings, layers = null) {
  const list = layers && layers.length ? layers.map(l => l.settings) : [settings];
  let min = Infinity, max = -Infinity;
  for (const s of list) {
    // amplitude is negative with "push in" (invertDisplacement): the relief
    // then spans [amp, 0] and the deepest point is height 0 %.
    const amp = +s.amplitude || 0;
    const lo = s.symmetricDisplacement ? -Math.abs(amp) / 2 : Math.min(0, amp);
    const hi = s.symmetricDisplacement ? Math.abs(amp) / 2 : Math.max(0, amp);
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  }
  if (!(max > min)) { min = 0; max = 1; }
  return { min, max };
}

/**
 * Sorted 0..1 thresholds from the user's percent values for `bands` bands.
 * @param {number} bands  2..4
 * @param {number[]} percents  at least bands-1 values, 0..100
 */
export function bandThresholds(bands, percents) {
  const n = Math.max(0, Math.min(bands, MAX_FILAMENTS) - 1);
  return percents.slice(0, n).map(p => Math.min(1, Math.max(0, p / 100))).sort((a, b) => a - b);
}

/** Band index of a normalised height: number of thresholds at or below it. */
export function bandOf(h, T) {
  let k = 0;
  while (k < T.length && h >= T[k]) k++;
  return k;
}

/**
 * Split a non-indexed triangle soup along the height contours.
 *
 * @param {Float32Array} positions  9 floats per triangle
 * @param {Float32Array} heights    3 normalised heights per triangle (per corner);
 *   copies of one position must carry the same height
 * @param {Uint8Array|null} textured  per triangle, 1 = textured. Untextured
 *   triangles are never split by their own heights; they are only split where
 *   a textured neighbour's contour ends on a shared edge, and stay band 0.
 * @param {number[]} T  sorted thresholds in (0, 1)
 * @param {object} [opts]
 * @param {number} [opts.snapMm=1e-3]  minimum distance of a contour crossing
 *   from an edge's end (smaller crossings snap onto the vertex)
 * @returns {{positions: Float32Array, labels: Uint8Array, parent: Int32Array,
 *   cutEdges: number}}  labels = band per output triangle; parent = source
 *   triangle of each output triangle
 */
export function cutHeightBands(positions, heights, textured, T, opts = {}) {
  const snapMm = opts.snapMm ?? 1e-3;
  const triCount = (positions.length / 9) | 0;

  // ── Weld positions (copies are bit-identical after displacement) ────────
  const map = new QuantizedPointMap(1e6, Math.min(triCount * 3, 1 << 22));
  let vx = new Float64Array(Math.max(16, triCount * 2));
  let vy = new Float64Array(vx.length), vz = new Float64Array(vx.length), vh = new Float64Array(vx.length);
  // opts.carry: another per-corner value (per position) interpolated onto
  // the cut points and returned per output corner — lets a second cut run on
  // the result (ornament filament cut, then color by height).
  const carry = opts.carry || null;
  let vc = carry ? new Float64Array(vx.length) : null;
  let vCount = 0;
  const corner = new Int32Array(triCount * 3);
  const grow = () => {
    const n = vx.length * 2;
    const g = (a) => { const b = new Float64Array(n); b.set(a); return b; };
    vx = g(vx); vy = g(vy); vz = g(vz); vh = g(vh);
    if (vc) vc = g(vc);
  };
  for (let i = 0; i < triCount * 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const id = map.getOrSet(x, y, z, vCount);
    if (map.inserted) {
      if (vCount >= vx.length) grow();
      vx[id] = x; vy[id] = y; vz[id] = z; vh[id] = heights[i];
      if (vc) vc[id] = carry[i];
      vCount++;
    }
    corner[i] = id;
  }

  const isTextured = (t) => !textured || textured[t] === 1;
  const crossing = (ha, hb, Tk) => (ha < Tk && hb > Tk) || (hb < Tk && ha > Tk);

  // ── Snap heights that would put a crossing within snapMm of a vertex ────
  // Snapping vh onto Tk exactly removes the crossing on every edge of that
  // vertex (a vertex AT the threshold is a contour point itself). A few
  // passes settle chains where one snap creates a new short crossing.
  if (T.length) {
    for (let pass = 0; pass < 4; pass++) {
      let changed = 0;
      for (let t = 0; t < triCount; t++) {
        if (!isTextured(t)) continue;
        for (let e = 0; e < 3; e++) {
          const a = corner[t * 3 + e], b = corner[t * 3 + (e + 1) % 3];
          const ha = vh[a], hb = vh[b];
          if (bandOf(ha, T) === bandOf(hb, T)) continue;
          const len = Math.hypot(vx[b] - vx[a], vy[b] - vy[a], vz[b] - vz[a]);
          for (const Tk of T) {
            if (!crossing(ha, hb, Tk)) continue;
            const s = (Tk - ha) / (hb - ha);
            if (s * len < snapMm) { vh[a] = Tk; changed++; break; }
            if ((1 - s) * len < snapMm) { vh[b] = Tk; changed++; break; }
          }
        }
      }
      if (!changed) break;
    }
  }

  // ── Contour points per edge (only edges of textured triangles) ──────────
  // cutStart[slot] / cutCount[slot] index into the cut-vertex list, ordered
  // from the edge's lower vertex id to the higher one.
  const edges = new IntPairMap(Math.max(16, triCount * 2));
  let eCount = 0;
  let cutStart = new Int32Array(Math.max(16, triCount));
  let cutCount = new Int32Array(cutStart.length);
  const cutIds = [];
  let cutEdges = 0;
  const addVertex = (x, y, z, h, c = 0) => {
    if (vCount >= vx.length) grow();
    vx[vCount] = x; vy[vCount] = y; vz[vCount] = z; vh[vCount] = h;
    if (vc) vc[vCount] = c;
    return vCount++;
  };
  for (let t = 0; t < triCount; t++) {
    if (!isTextured(t)) continue;
    for (let e = 0; e < 3; e++) {
      const p = corner[t * 3 + e], q = corner[t * 3 + (e + 1) % 3];
      const lo = p < q ? p : q, hi = p < q ? q : p;
      const slot = edges.getOrSet(lo, hi, eCount);
      if (!edges.inserted) continue;
      if (eCount >= cutStart.length) {
        const g = (a) => { const b = new Int32Array(a.length * 2); b.set(a); return b; };
        cutStart = g(cutStart); cutCount = g(cutCount);
      }
      eCount++;
      cutStart[slot] = cutIds.length;
      const hl = vh[lo], hh = vh[hi];
      if (bandOf(hl, T) === bandOf(hh, T)) continue;
      // Thresholds strictly between the ends, in order from lo to hi.
      const ks = [];
      for (let k = 0; k < T.length; k++) if (crossing(hl, hh, T[k])) ks.push(k);
      if (hl > hh) ks.reverse();
      for (const k of ks) {
        const s = (T[k] - hl) / (hh - hl);
        cutIds.push(addVertex(
          vx[lo] + (vx[hi] - vx[lo]) * s,
          vy[lo] + (vy[hi] - vy[lo]) * s,
          vz[lo] + (vz[hi] - vz[lo]) * s,
          T[k],
          vc ? vc[lo] + (vc[hi] - vc[lo]) * s : 0));
      }
      cutCount[slot] = ks.length;
      if (ks.length) cutEdges++;
    }
  }

  // ── Re-triangulate ──────────────────────────────────────────────────────
  const outPos = [];
  const outLab = [];
  const outPar = [];
  const outCarry = [];
  const ring = [];
  const pushTri = (a, b, c, label, parent) => {
    // Skip exact zero-area triangles (collinear contour points on one edge);
    // dropping them cannot open a hole because they cover no area.
    const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a];
    const wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (cx * cx + cy * cy + cz * cz < 1e-24) return;
    outPos.push(vx[a], vy[a], vz[a], vx[b], vy[b], vz[b], vx[c], vy[c], vz[c]);
    if (vc) outCarry.push(vc[a], vc[b], vc[c]);
    outLab.push(label);
    outPar.push(parent);
  };

  for (let t = 0; t < triCount; t++) {
    const tex = isTextured(t);
    // Boundary ring: corners with the contour points of each edge between them.
    ring.length = 0;
    let edgesWithCuts = 0;
    for (let e = 0; e < 3; e++) {
      const p = corner[t * 3 + e], q = corner[t * 3 + (e + 1) % 3];
      ring.push(p);
      const lo = p < q ? p : q, hi = p < q ? q : p;
      const slot = edges.get(lo, hi);
      if (slot === -1 || cutCount[slot] === 0) continue;
      edgesWithCuts++;
      const n = cutCount[slot], s0 = cutStart[slot];
      if (p === lo) for (let i = 0; i < n; i++) ring.push(cutIds[s0 + i]);
      else for (let i = n - 1; i >= 0; i--) ring.push(cutIds[s0 + i]);
    }

    if (!tex) {
      // Untextured: keep band 0, only conform to contour points that a
      // textured neighbour put on a shared edge.
      if (edgesWithCuts === 0) {
        pushTri(ring[0], ring[1], ring[2], 0, t);
      } else {
        // Fan from a new centroid vertex: never collinear with any edge.
        const a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2];
        const m = addVertex((vx[a] + vx[b] + vx[c]) / 3, (vy[a] + vy[b] + vy[c]) / 3,
          (vz[a] + vz[b] + vz[c]) / 3, 0, vc ? (vc[a] + vc[b] + vc[c]) / 3 : 0);
        for (let i = 0; i < ring.length; i++) pushTri(m, ring[i], ring[(i + 1) % ring.length], 0, t);
      }
      continue;
    }

    if (edgesWithCuts === 0) {
      const hc = (vh[ring[0]] + vh[ring[1]] + vh[ring[2]]) / 3;
      pushTri(ring[0], ring[1], ring[2], bandOf(hc, T), t);
      continue;
    }

    // Height is linear over the triangle, so each band's part is the convex
    // polygon of ring points whose height lies in [T[k-1], T[k]] (contour
    // points belong to both neighbouring bands). Fan-triangulate it.
    const kMin = bandOf(Math.min(vh[ring[0]], ...ring.map(i => vh[i])), T);
    const kMax = bandOf(Math.max(...ring.map(i => vh[i])), T);
    for (let k = kMin; k <= kMax; k++) {
      const lo = k === 0 ? -Infinity : T[k - 1];
      const hi = k === T.length ? Infinity : T[k];
      const poly = ring.filter(i => vh[i] >= lo && vh[i] <= hi);
      if (poly.length < 3) continue;
      // A polygon touching its band only at the upper bound is empty.
      let sum = 0;
      for (const i of poly) sum += vh[i];
      if (bandOf(sum / poly.length, T) !== k) continue;
      for (let i = 1; i + 1 < poly.length; i++) pushTri(poly[0], poly[i], poly[i + 1], k, t);
    }
  }

  return {
    positions: Float32Array.from(outPos),
    labels: Uint8Array.from(outLab),
    parent: Int32Array.from(outPar),
    carried: vc ? Float32Array.from(outCarry) : null,
    cutEdges,
  };
}

/**
 * TriangleSelector state string for a whole (unsplit) triangle painted with
 * extruder `state` (1-based), as written by PrusaSlicer
 * (`slic3rpe:mmu_segmentation`) and Bambu Studio / OrcaSlicer (`paint_color`).
 * The leaf nibble is (state << 2) for states 1-2; from state 3 on it is 0xC
 * followed by (state - 3) in 15-steps with 0xF continuation nibbles, written
 * most-significant first. Verified against reverse-engineered slicer exports
 * in PR #121.
 * @param {number} state  1..16 (1 = the object's default extruder)
 */
export function paintStateCode(state) {
  if (state < 1 || state > MAX_FILAMENTS) throw new Error(`paint state ${state} out of range 1..${MAX_FILAMENTS}`);
  if (state === 1) return '4';
  if (state === 2) return '8';
  const rel = state - 3;
  return (rel % 15).toString(16).toUpperCase() + 'F'.repeat(Math.floor(rel / 15)) + 'C';
}

/**
 * Height distribution of a height map, as share of SURFACE per normalised
 * height bin — what the band shares of a print depend on.
 *
 * Without slopes every texel counts once (the map seen from above). With
 * slopes (the relief's mm per grey step and texel), each texel is weighted by
 * its true surface area sqrt(1 + |grad|^2) and spread over the heights it
 * spans towards its neighbours. That is what makes a steep wall count: a
 * 2 mm wall is invisible from above but carries every height from bottom to
 * top — on a sharp texture like a maze it is most of the surface.
 *
 * @param {{data: Uint8ClampedArray, width?: number, height?: number}} imageData
 *   greyscale RGBA (red channel)
 * @param {boolean} pushIn  negative amplitude: the deepest point is white
 * @param {object} [opts]
 * @param {number} [opts.bins=100]
 * @param {number} [opts.slopeU=0]  mm of relief per grey unit per texel step
 *   along U: |amplitude| * width / sizeU(mm); same for V
 * @param {number} [opts.slopeV=0]
 * @returns {Float64Array} shares per bin, summing to 1, with `.areaFactor`:
 *   textured surface after displacement per unit of surface before it
 */
export function heightHistogram(imageData, pushIn, opts = {}) {
  const bins = opts.bins ?? 100;
  const sU = opts.slopeU || 0, sV = opts.slopeV || 0;
  const d = imageData.data;
  const w = imageData.width || (d.length >> 2), h = imageData.height || 1;
  const hist = new Float64Array(bins);
  if (!w || !h) return hist;
  // Large maps: a sample grid of ~260k texels is plenty for 100 bins.
  const stride = Math.max(1, Math.ceil(Math.sqrt(w * h / 262144)));
  const grey = (x, y) => {
    x = (x + w) % w; y = (y + h) % h;
    const v = d[(y * w + x) * 4] / 255;
    return pushIn ? 1 - v : v;
  };
  const binOf = (v) => Math.min(bins - 1, Math.max(0, Math.floor(v * bins)));
  let total = 0, samples = 0;
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const c = grey(x, y);
      samples++;
      if (!sU && !sV) { hist[binOf(c)]++; total++; continue; }
      const l = grey(x - 1, y), r = grey(x + 1, y), u = grey(x, y - 1), dn = grey(x, y + 1);
      const gx = (r - l) / 2 * sU, gy = (dn - u) / 2 * sV;
      const weight = Math.sqrt(1 + gx * gx + gy * gy);
      // The texel's patch reaches half way to each neighbour.
      const lo = Math.min(c, (c + l) / 2, (c + r) / 2, (c + u) / 2, (c + dn) / 2);
      const hi = Math.max(c, (c + l) / 2, (c + r) / 2, (c + u) / 2, (c + dn) / 2);
      const b0 = binOf(lo), b1 = binOf(hi);
      if (b0 === b1) {
        hist[b0] += weight;
      } else {
        const span = hi - lo;
        for (let b = b0; b <= b1; b++) {
          const overlap = Math.min(hi, (b + 1) / bins) - Math.max(lo, b / bins);
          if (overlap > 0) hist[b] += weight * overlap / span;
        }
      }
      total += weight;
    }
  }
  if (total > 0) for (let b = 0; b < bins; b++) hist[b] /= total;
  hist.areaFactor = samples > 0 ? total / samples : 1;
  return hist;
}

/** Shares of a height histogram per band for thresholds T (0..1). */
export function bandShares(hist, T) {
  const shares = new Array(T.length + 1).fill(0);
  const bins = hist.length;
  for (let b = 0; b < bins; b++) shares[bandOf((b + 0.5) / bins, T)] += hist[b];
  return shares;
}
