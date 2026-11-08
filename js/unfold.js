/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * unfold.js — the "Unfold" projection: lay the texture over a part made of
 * flat faces the way a cardboard box is folded from its net, so the pattern
 * runs straight across the edges instead of being projected onto every side
 * on its own (which cuts the relief off at each edge, leaving walls).
 *
 *  1. Regions: connected faces lying in one plane (normals within ~1°).
 *  2. Hinges: regions sharing an edge. A maximum spanning tree over the
 *     shared edge length decides which edges are folded open (texture
 *     continuous across them); the remaining edges are seams. Seams go where
 *     they show least: edges of downward-facing regions (the bed side) are
 *     folded last, edges of upward-facing regions (the top, seen most) first.
 *  3. Each region gets an affine map 3D → 2D in mm: the root region's own
 *     plane frame, every other region rotated about its hinge into its
 *     parent's plane (unfolded outwards) and mapped with the parent's frame.
 *
 * Curved surfaces work too as long as they are faceted (each facet a region,
 * strips of facets unroll along their long edges), but Etappe 1 targets flat
 * faces. A point is located with a uniform grid over the source triangles,
 * so any mesh lying on the part's surface (refined export mesh, 3D preview
 * mesh, paint split) can be mapped.
 *
 * Tables are plain typed arrays (structured-clone safe for the workers).
 */

import { QuantizedPointMap, IntPairMap } from './meshIndex.js';

const COPLANAR_COS = Math.cos(1 * Math.PI / 180);

/**
 * @param {Float32Array} positions  non-indexed source mesh (9 floats per triangle)
 * @returns {object} tables for unfoldPlace / unfoldPlaces
 */
export function buildUnfold(positions) {
  const triCount = (positions.length / 9) | 0;

  // ── Weld, face normals and areas ────────────────────────────────────────
  const map = new QuantizedPointMap(1e5, Math.min(triCount * 3, 1 << 22));
  const corner = new Int32Array(triCount * 3);
  let vCount = 0;
  for (let i = 0; i < triCount * 3; i++) {
    const id = map.getOrSet(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], vCount);
    if (map.inserted) vCount++;
    corner[i] = id;
  }
  const fn = new Float64Array(triCount * 3);
  const area = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const ux = positions[b+3]-positions[b], uy = positions[b+4]-positions[b+1], uz = positions[b+5]-positions[b+2];
    const vx = positions[b+6]-positions[b], vy = positions[b+7]-positions[b+1], vz = positions[b+8]-positions[b+2];
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const len = Math.hypot(nx, ny, nz);
    area[t] = len / 2;
    if (len > 0) { fn[t*3] = nx/len; fn[t*3+1] = ny/len; fn[t*3+2] = nz/len; }
  }

  // ── Edge → the two faces sharing it ─────────────────────────────────────
  const edges = new IntPairMap(Math.max(16, triCount * 2));
  let eCount = 0;
  const eFaceA = new Int32Array(triCount * 3).fill(-1);
  const eFaceB = new Int32Array(triCount * 3).fill(-1);
  const eLo = new Int32Array(triCount * 3), eHi = new Int32Array(triCount * 3);
  const eCorner = new Int32Array(triCount * 3); // a corner index holding eLo (for its position)
  const eCornerHi = new Int32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    if (area[t] === 0) continue;
    for (let k = 0; k < 3; k++) {
      const ca = t * 3 + k, cb = t * 3 + (k + 1) % 3;
      const a = corner[ca], b = corner[cb];
      if (a === b) continue;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const s = edges.getOrSet(lo, hi, eCount);
      if (edges.inserted) {
        eLo[s] = lo; eHi[s] = hi;
        eCorner[s] = a === lo ? ca : cb; eCornerHi[s] = a === lo ? cb : ca;
        eFaceA[s] = t; eCount++;
      } else if (eFaceB[s] === -1) eFaceB[s] = t;
      // a third face on one edge (non-manifold) is ignored
    }
  }

  // ── Regions: flood fill across edges between coplanar faces ────────────
  const faceRegion = new Int32Array(triCount).fill(-1);
  let regionCount = 0;
  const faceEdges = new Int32Array(triCount * 3).fill(-1);
  for (let t = 0; t < triCount; t++) {
    if (area[t] === 0) continue;
    for (let k = 0; k < 3; k++) {
      const a = corner[t*3+k], b = corner[t*3+(k+1)%3];
      if (a === b) continue;
      faceEdges[t*3+k] = edges.get(a < b ? a : b, a < b ? b : a);
    }
  }
  const stack = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (faceRegion[seed] !== -1 || area[seed] === 0) continue;
    const r = regionCount++;
    faceRegion[seed] = r;
    stack.push(seed);
    while (stack.length) {
      const t = stack.pop();
      for (let k = 0; k < 3; k++) {
        const s = faceEdges[t*3+k];
        if (s < 0) continue;
        const o = eFaceA[s] === t ? eFaceB[s] : eFaceA[s];
        if (o < 0 || faceRegion[o] !== -1) continue;
        if (fn[t*3]*fn[o*3] + fn[t*3+1]*fn[o*3+1] + fn[t*3+2]*fn[o*3+2] < COPLANAR_COS) continue;
        faceRegion[o] = r;
        stack.push(o);
      }
    }
  }
  // Degenerate faces join their first neighbour's region (or region 0).
  for (let t = 0; t < triCount; t++) if (faceRegion[t] === -1) faceRegion[t] = regionCount ? 0 : (regionCount = 1, 0);

  // Region normal (area weighted) and area.
  const rN = new Float64Array(regionCount * 3), rArea = new Float64Array(regionCount);
  for (let t = 0; t < triCount; t++) {
    const r = faceRegion[t];
    rArea[r] += area[t];
    for (let k = 0; k < 3; k++) rN[r*3+k] += fn[t*3+k] * area[t];
  }
  for (let r = 0; r < regionCount; r++) {
    const l = Math.hypot(rN[r*3], rN[r*3+1], rN[r*3+2]) || 1;
    rN[r*3] /= l; rN[r*3+1] /= l; rN[r*3+2] /= l;
  }

  // ── Hinges: shared length per region pair, longest edge as the hinge ───
  const pairs = new Map(); // "a,b" → { a, b, len, edge, edgeLen }
  for (let s = 0; s < eCount; s++) {
    const fa = eFaceA[s], fb = eFaceB[s];
    if (fa < 0 || fb < 0) continue;
    const ra = faceRegion[fa], rb = faceRegion[fb];
    if (ra === rb) continue;
    const p = eCorner[s] * 3, q = eCornerHi[s] * 3;
    const len = Math.hypot(positions[q]-positions[p], positions[q+1]-positions[p+1], positions[q+2]-positions[p+2]);
    const key = ra < rb ? ra * regionCount + rb : rb * regionCount + ra;
    let h = pairs.get(key);
    if (!h) { h = { a: Math.min(ra, rb), b: Math.max(ra, rb), len: 0, edge: s, edgeLen: 0 }; pairs.set(key, h); }
    h.len += len;
    if (len > h.edgeLen) { h.edgeLen = len; h.edge = s; }
  }

  // ── Maximum spanning tree (Kruskal on weighted shared length) ──────────
  // Weight: shared length, times 4 when a region faces up (top edges fold
  // first), times 0.01 when one faces down (bottom edges become the seams).
  const facing = (r) => rN[r*3+2];
  for (const h of pairs.values()) {
    const za = facing(h.a), zb = facing(h.b);
    h.weight = h.len * (Math.min(za, zb) < -0.5 ? 0.01 : Math.max(za, zb) > 0.5 ? 4 : 1);
  }
  const uf = new Int32Array(regionCount);
  for (let r = 0; r < regionCount; r++) uf[r] = r;
  const find = (x) => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
  const sorted = [...pairs.values()].sort((p, q) => q.weight - p.weight);
  const adj = Array.from({ length: regionCount }, () => []);
  for (const h of sorted) {
    const x = find(h.a), y = find(h.b);
    if (x === y) continue;
    uf[x] = y;
    h.tree = true;
    adj[h.a].push(h); adj[h.b].push(h);
  }

  // Seam edges (between regions not folded together), for fitUnfoldTiling:
  // ax ay az bx by bz, region A, region B, weight. Down-facing regions (the
  // bed side) weigh little. Capped: long curved seams are sampled.
  const seamList = [];
  for (let s = 0; s < eCount; s++) {
    const fa = eFaceA[s], fb = eFaceB[s];
    if (fa < 0 || fb < 0) continue;
    const ra = faceRegion[fa], rb = faceRegion[fb];
    if (ra === rb) continue;
    const h = pairs.get(ra < rb ? ra * regionCount + rb : rb * regionCount + ra);
    if (!h || h.tree) continue;
    seamList.push(s);
  }
  const seamStride = Math.max(1, Math.ceil(seamList.length / 4000));
  const seamEdges = [];
  for (let i = 0; i < seamList.length; i += seamStride) {
    const s = seamList[i];
    const ra = faceRegion[eFaceA[s]], rb = faceRegion[eFaceB[s]];
    const p = eCorner[s] * 3, q = eCornerHi[s] * 3;
    const w = Math.min(rN[ra*3+2], rN[rb*3+2]) < -0.5 ? 0.1 : 1;
    seamEdges.push(positions[p], positions[p+1], positions[p+2], positions[q], positions[q+1], positions[q+2], ra, rb, w);
  }

  // ── Region maps: root frame, then fold each child into its parent ──────
  const M = new Float64Array(regionCount * 6);   // rows u, v of the 2×3 map
  const T = new Float64Array(regionCount * 2);
  const done = new Uint8Array(regionCount);
  const rootFrame = (r) => {
    const nx = rN[r*3], ny = rN[r*3+1], nz = rN[r*3+2];
    let ux, uy, uz;
    if (Math.abs(nz) > 0.9) { ux = 1 - nx*nx; uy = -nx*ny; uz = -nx*nz; }      // X projected into the plane
    else { ux = -ny; uy = nx; uz = 0; }                                         // horizontal: Z × n
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    // v = n × u (right-handed seen from outside, "up" on side faces)
    const vx = ny*uz - nz*uy, vy = nz*ux - nx*uz, vz = nx*uy - ny*ux;
    M.set([ux, uy, uz, vx, vy, vz], r * 6);
    T[r*2] = 0; T[r*2+1] = 0;
  };
  // Components: every connected part gets its own root — the largest
  // upward-facing region if there is one (its frame is plain X/Y, so the
  // texture's Rotation means on top what it means everywhere else), else the
  // largest region.
  const order = [...Array(regionCount).keys()].sort((p, q) =>
    ((facing(q) > 0.5) - (facing(p) > 0.5)) || (rArea[q] - rArea[p]));
  const queue = [];
  for (const root of order) {
    if (done[root]) continue;
    rootFrame(root);
    done[root] = 1;
    queue.push(root);
    while (queue.length) {
      const P = queue.shift();
      for (const h of adj[P]) {
        const C = h.a === P ? h.b : h.a;
        if (done[C]) continue;
        // Hinge axis through a → b, rotating C's normal onto P's.
        const pa = eCorner[h.edge] * 3, pb = eCornerHi[h.edge] * 3;
        const ax = positions[pa], ay = positions[pa+1], az = positions[pa+2];
        let ex = positions[pb]-ax, ey = positions[pb+1]-ay, ez = positions[pb+2]-az;
        const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
        const cx = rN[C*3], cy = rN[C*3+1], cz = rN[C*3+2];
        const px = rN[P*3], py = rN[P*3+1], pz = rN[P*3+2];
        const crx = cy*pz - cz*py, cry = cz*px - cx*pz, crz = cx*py - cy*px;
        const theta = Math.atan2(crx*ex + cry*ey + crz*ez, cx*px + cy*py + cz*pz);
        const R = rotation(ex, ey, ez, theta);
        // M_C = M_P · R ;  T_C = M_P·a + T_P − M_C·a
        const mp = M.subarray(P*6, P*6+6);
        const mc = new Float64Array(6);
        for (let row = 0; row < 2; row++) {
          for (let col = 0; col < 3; col++) {
            mc[row*3+col] = mp[row*3]*R[col] + mp[row*3+1]*R[3+col] + mp[row*3+2]*R[6+col];
          }
        }
        M.set(mc, C * 6);
        for (let row = 0; row < 2; row++) {
          const pA = mp[row*3]*ax + mp[row*3+1]*ay + mp[row*3+2]*az + T[P*2+row];
          T[C*2+row] = pA - (mc[row*3]*ax + mc[row*3+1]*ay + mc[row*3+2]*az);
        }
        done[C] = 1;
        queue.push(C);
      }
    }
  }

  // ── Lookup grid over the source triangles ───────────────────────────────
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i+1], z = positions[i+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const tol = diag * 1e-4;
  const cell = Math.max(diag / 64, Math.cbrt(((maxX-minX+tol)*(maxY-minY+tol)*(maxZ-minZ+tol)) / Math.max(1, triCount)) * 2, 1e-6);
  const gx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const gy = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const gz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const cellStart = new Int32Array(gx * gy * gz + 1);
  const forCells = (t, fnc) => {
    const b = t * 9;
    const x0 = Math.min(positions[b], positions[b+3], positions[b+6]) - tol, x1 = Math.max(positions[b], positions[b+3], positions[b+6]) + tol;
    const y0 = Math.min(positions[b+1], positions[b+4], positions[b+7]) - tol, y1 = Math.max(positions[b+1], positions[b+4], positions[b+7]) + tol;
    const z0 = Math.min(positions[b+2], positions[b+5], positions[b+8]) - tol, z1 = Math.max(positions[b+2], positions[b+5], positions[b+8]) + tol;
    const i0 = Math.max(0, Math.floor((x0 - minX) / cell)), i1 = Math.min(gx - 1, Math.floor((x1 - minX) / cell));
    const j0 = Math.max(0, Math.floor((y0 - minY) / cell)), j1 = Math.min(gy - 1, Math.floor((y1 - minY) / cell));
    const k0 = Math.max(0, Math.floor((z0 - minZ) / cell)), k1 = Math.min(gz - 1, Math.floor((z1 - minZ) / cell));
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fnc((k * gy + j) * gx + i);
  };
  for (let t = 0; t < triCount; t++) if (area[t] > 0) forCells(t, (c) => { cellStart[c + 1]++; });
  for (let c = 0; c < gx * gy * gz; c++) cellStart[c + 1] += cellStart[c];
  const cellItems = new Int32Array(cellStart[gx * gy * gz]);
  const fill = cellStart.slice(0, gx * gy * gz);
  for (let t = 0; t < triCount; t++) if (area[t] > 0) forCells(t, (c) => { cellItems[fill[c]++] = t; });

  return {
    regionCount, M, T, faceRegion,
    tris: Float32Array.from(positions), faceNormals: Float32Array.from(fn),
    grid: { minX, minY, minZ, cell, gx, gy, gz, cellStart, cellItems, tol },
    seams: sorted.length - (regionCount - 1),
    seamEdges: Float64Array.from(seamEdges),
  };
}

// Rodrigues rotation matrix (row-major 3×3) about unit axis e by angle a.
function rotation(ex, ey, ez, a) {
  const c = Math.cos(a), s = Math.sin(a), k = 1 - c;
  return [
    c + ex*ex*k,    ex*ey*k - ez*s, ex*ez*k + ey*s,
    ey*ex*k + ez*s, c + ey*ey*k,    ey*ez*k - ex*s,
    ez*ex*k - ey*s, ez*ey*k + ex*s, c + ez*ez*k,
  ];
}

/**
 * Region of the source surface at point (x, y, z) facing (nx, ny, nz): the
 * triangle containing the point (within tolerance) whose normal matches best.
 * -1 when no triangle is near.
 */
export function unfoldRegionAt(tab, x, y, z, nx, ny, nz) {
  const g = tab.grid;
  const i = Math.floor((x - g.minX) / g.cell), j = Math.floor((y - g.minY) / g.cell), k = Math.floor((z - g.minZ) / g.cell);
  if (i < 0 || j < 0 || k < 0 || i >= g.gx || j >= g.gy || k >= g.gz) return -1;
  const c = (k * g.gy + j) * g.gx + i;
  const P = tab.tris, N = tab.faceNormals, tol = g.tol;
  let best = -1, bestScore = Infinity;
  for (let s = g.cellStart[c]; s < g.cellStart[c + 1]; s++) {
    const t = g.cellItems[s], b = t * 9;
    const fx = N[t*3], fy = N[t*3+1], fz = N[t*3+2];
    const dist = Math.abs((x - P[b]) * fx + (y - P[b+1]) * fy + (z - P[b+2]) * fz);
    if (dist > tol * 10) continue;
    // Inside the triangle (barycentric, with a tolerance band)?
    const e0x = P[b+3]-P[b], e0y = P[b+4]-P[b+1], e0z = P[b+5]-P[b+2];
    const e1x = P[b+6]-P[b], e1y = P[b+7]-P[b+1], e1z = P[b+8]-P[b+2];
    const px = x-P[b], py = y-P[b+1], pz = z-P[b+2];
    const d00 = e0x*e0x+e0y*e0y+e0z*e0z, d01 = e0x*e1x+e0y*e1y+e0z*e1z, d11 = e1x*e1x+e1y*e1y+e1z*e1z;
    const d20 = px*e0x+py*e0y+pz*e0z, d21 = px*e1x+py*e1y+pz*e1z;
    const den = d00*d11 - d01*d01;
    if (den <= 0) continue;
    const v = (d11*d20 - d01*d21) / den, w = (d00*d21 - d01*d20) / den, u = 1 - v - w;
    const out = Math.max(0, -u, -v, -w) * Math.sqrt(Math.max(d00, d11));
    if (out > tol * 10) continue;
    const facing = 1 - (nx*fx + ny*fy + nz*fz);
    const score = dist + out + facing * tol * 100;
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best < 0 ? -1 : tab.faceRegion[best];
}

/** Unfolded coordinates (mm) of a point in region r. */
export function unfoldMap(tab, r, x, y, z) {
  const m = tab.M, o = r * 6;
  return {
    u: m[o]*x + m[o+1]*y + m[o+2]*z + tab.T[r*2],
    v: m[o+3]*x + m[o+4]*y + m[o+5]*z + tab.T[r*2+1],
  };
}

/** Unfolded coordinates (mm) at a point with its normal; null off the surface. */
export function unfoldPlace(tab, x, y, z, nx, ny, nz) {
  const r = unfoldRegionAt(tab, x, y, z, nx, ny, nz);
  return r < 0 ? null : unfoldMap(tab, r, x, y, z);
}

/**
 * Per-corner unfolded coordinates of a mesh lying on the source surface (the
 * preview's `unfoldUV` attribute): each triangle is located once at its
 * centroid with its own normal, so all three corners use one region and the
 * texture stays affine across the triangle.
 * @returns {Float32Array} 2 floats per corner (mm)
 */
export function unfoldPlaces(tab, positions) {
  const triCount = (positions.length / 9) | 0;
  const out = new Float32Array(triCount * 6);
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const ux = positions[b+3]-positions[b], uy = positions[b+4]-positions[b+1], uz = positions[b+5]-positions[b+2];
    const vx = positions[b+6]-positions[b], vy = positions[b+7]-positions[b+1], vz = positions[b+8]-positions[b+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const cx = (positions[b]+positions[b+3]+positions[b+6]) / 3;
    const cy = (positions[b+1]+positions[b+4]+positions[b+7]) / 3;
    const cz = (positions[b+2]+positions[b+5]+positions[b+8]) / 3;
    let r = unfoldRegionAt(tab, cx, cy, cz, nx, ny, nz);
    if (r < 0) r = 0;
    for (let k = 0; k < 3; k++) {
      const p = unfoldMap(tab, r, positions[b+k*3], positions[b+k*3+1], positions[b+k*3+2]);
      out[t*6+k*2] = p.u; out[t*6+k*2+1] = p.v;
    }
  }
  return out;
}

// ── Seam fitting ─────────────────────────────────────────────────────────────
// Every point on a seam lies in two regions, so the texture is read at two
// places there. How much those two heights differ is the seam's visible
// mismatch. fitUnfoldTiling searches tile size (near the current one) and
// offset for the smallest weighted mismatch, measured with the actual height
// map — so whatever symmetry the pattern has (90° turns, mirror, half-tile
// shifts) is found without knowing it.

/**
 * Points along every seam, `spacing` mm apart (at least 2 per edge, at most
 * ~20k in all): unfolded coordinates (mm) on both sides + weight. Dense enough
 * that a pattern edge shifted along the seam cannot hide between samples.
 */
export function unfoldSeamSamples(tab, spacing = 1) {
  const e = tab.seamEdges, n = e.length / 9;
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.hypot(e[i*9+3]-e[i*9], e[i*9+4]-e[i*9+1], e[i*9+5]-e[i*9+2]);
  spacing = Math.max(spacing, total / 20000);
  const counts = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    counts[i] = Math.max(2, Math.ceil(Math.hypot(e[i*9+3]-e[i*9], e[i*9+4]-e[i*9+1], e[i*9+5]-e[i*9+2]) / spacing));
    m += counts[i];
  }
  const uA = new Float64Array(m), vA = new Float64Array(m), uB = new Float64Array(m), vB = new Float64Array(m);
  const w = new Float64Array(m);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 9, perEdge = counts[i];
    const len = Math.hypot(e[o+3]-e[o], e[o+4]-e[o+1], e[o+5]-e[o+2]);
    for (let j = 0; j < perEdge; j++, k++) {
      const t = (j + 0.5) / perEdge;
      const x = e[o] + (e[o+3]-e[o]) * t, y = e[o+1] + (e[o+4]-e[o+1]) * t, z = e[o+2] + (e[o+5]-e[o+2]) * t;
      const a = unfoldMap(tab, e[o+6], x, y, z), b = unfoldMap(tab, e[o+7], x, y, z);
      uA[k] = a.u; vA[k] = a.v; uB[k] = b.u; vB[k] = b.v;
      w[k] = e[o+8] * len / perEdge;   // weight by seam length
    }
  }
  return { uA, vA, uB, vB, w, count: k };
}

// Height map grey at tiled (u, v), bilinear on the red channel — the same
// convention as displacement.js sampleBilinear (V flipped).
function greyAt(img, u, v) {
  const W = img.width, H = img.height, d = img.data;
  u = u - Math.floor(u); v = 1 - (v - Math.floor(v));
  const fx = u * W - 0.5, fy = v * H - 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const x1 = (x0 + 1 + W) % W, y1 = (y0 + 1 + H) % H;
  x0 = ((x0 % W) + W) % W; y0 = ((y0 % H) + H) % H;
  const g = (x, y) => d[(y * W + x) * 4];
  return (g(x0, y0) * (1 - tx) * (1 - ty) + g(x1, y0) * tx * (1 - ty) + g(x0, y1) * (1 - tx) * ty + g(x1, y1) * tx * ty) / 255;
}

/**
 * Weighted RMS height difference across the seams (0 = seamless, grey units).
 * @param {object} t  { scaleU, scaleV (mm), offsetU, offsetV, rotation (deg),
 *   textureAspectU, textureAspectV } — as computeUV reads them
 */
export function seamError(samples, img, t, stride = 1) {
  const aU = t.textureAspectU ?? 1, aV = t.textureAspectV ?? 1;
  const ku = aU / t.scaleU, kv = aV / t.scaleV;
  const r = (t.rotation ?? 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const tile = (u, v) => {
    let uu = u * ku + t.offsetU, vv = v * kv + t.offsetV;
    if (r !== 0) { uu -= 0.5; vv -= 0.5; const ru = c * uu - s * vv; vv = s * uu + c * vv + 0.5; uu = ru + 0.5; }
    return [uu, vv];
  };
  let sum = 0, wsum = 0;
  for (let i = 0; i < samples.count; i += stride) {
    const [a1, a2] = tile(samples.uA[i], samples.vA[i]);
    const [b1, b2] = tile(samples.uB[i], samples.vB[i]);
    const d = greyAt(img, a1, a2) - greyAt(img, b1, b2);
    sum += samples.w[i] * d * d; wsum += samples.w[i];
  }
  return wsum > 0 ? Math.sqrt(sum / wsum) : 0;
}

/**
 * Tile size (within ±range of the current one, aspect kept) and offset with
 * the smallest seam mismatch. The current setting is always a candidate, so
 * the result is never worse; on ties the size closest to the current wins.
 * @returns {{scaleU, scaleV, offsetU, offsetV, before, after}}
 */
export function fitUnfoldTiling(tab, img, cur, opts = {}) {
  const samples = unfoldSeamSamples(tab, opts.spacing ?? Math.min(cur.scaleU, cur.scaleV) / 24);
  const before = seamError(samples, img, cur);
  if (!samples.count) return { ...pick(cur), before, after: before };
  const range = opts.range ?? 1.35, steps = opts.steps ?? 97, offSteps = opts.offSteps ?? 16;
  const ratio = cur.scaleV / cur.scaleU;
  const coarseStride = Math.max(1, Math.floor(samples.count / 600));
  const scored = [];
  for (let i = 0; i < steps; i++) {
    const f = Math.exp(Math.log(range) * (2 * i / (steps - 1) - 1));
    const su = cur.scaleU * f;
    for (let ou = 0; ou < offSteps; ou++) {
      for (let ov = 0; ov < offSteps; ov++) {
        const t = { ...cur, scaleU: su, scaleV: su * ratio, offsetU: ou / offSteps, offsetV: ov / offSteps };
        scored.push({ t, e: seamError(samples, img, t, coarseStride) + 0.002 * Math.abs(Math.log(f)) });
      }
    }
  }
  scored.sort((p, q) => p.e - q.e);
  // Refine the best few on every sample: finer size (within one coarse
  // step) and finer offset.
  const sizeStep = Math.exp(Math.log(range) * 2 / (steps - 1));
  let best = { t: cur, e: before };
  for (const { t } of scored.slice(0, 5)) {
    for (let ds = -4; ds <= 4; ds++) {
      const su = t.scaleU * Math.pow(sizeStep, ds / 4);
      for (let du = -2; du <= 2; du++) {
        for (let dv = -2; dv <= 2; dv++) {
          const c = { ...t, scaleU: su, scaleV: su * ratio,
            offsetU: t.offsetU + du / (offSteps * 4), offsetV: t.offsetV + dv / (offSteps * 4) };
          const e = seamError(samples, img, c) + 0.002 * Math.abs(Math.log(c.scaleU / cur.scaleU));
          if (e < best.e) best = { t: c, e };
        }
      }
    }
  }
  const out = pick(best.t);
  out.offsetU = ((out.offsetU % 1) + 1) % 1;
  out.offsetV = ((out.offsetV % 1) + 1) % 1;
  return { ...out, before, after: seamError(samples, img, best.t) };
}

const pick = (t) => ({ scaleU: t.scaleU, scaleV: t.scaleV, offsetU: t.offsetU, offsetV: t.offsetV });
