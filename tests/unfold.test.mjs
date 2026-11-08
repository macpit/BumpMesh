/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Unfold projection: a part made of flat faces is laid out like a box net,
// so the texture runs straight across every folded edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildUnfold, unfoldRegionAt, unfoldMap, unfoldPlaces } from '../js/unfold.js';

const box = (sx, sy, sz, seg = 1) => {
  const g = new THREE.BoxGeometry(sx, sy, sz, seg, seg, seg).toNonIndexed();
  g.translate(0, 0, sz / 2);
  return g.attributes.position.array.slice();
};

// The 12 edges of an axis-aligned box: midpoint and the two face normals.
function boxEdges(sx, sy, sz) {
  const out = [];
  const hx = sx / 2, hy = sy / 2;
  for (const [x, nx] of [[-hx, -1], [hx, 1]]) for (const [y, ny] of [[-hy, -1], [hy, 1]]) out.push({ p: [x, y, sz / 2], n1: [nx, 0, 0], n2: [0, ny, 0] });
  for (const [z, nz] of [[0, -1], [sz, 1]]) {
    for (const [x, nx] of [[-hx, -1], [hx, 1]]) out.push({ p: [x, 0, z], n1: [nx, 0, 0], n2: [0, 0, nz] });
    for (const [y, ny] of [[-hy, -1], [hy, 1]]) out.push({ p: [0, y, z], n1: [0, ny, 0], n2: [0, 0, nz] });
  }
  return out;
}


test('a box unfolds into 6 regions with 5 folded edges and 7 seams', () => {
  const tab = buildUnfold(box(20, 30, 40));
  assert.equal(tab.regionCount, 6);
  assert.equal(tab.seams, 7);
  let folded = 0;
  for (const e of boxEdges(20, 30, 40)) {
    const r1 = unfoldRegionAt(tab, ...e.p, ...e.n1), r2 = unfoldRegionAt(tab, ...e.p, ...e.n2);
    assert.ok(r1 >= 0 && r2 >= 0 && r1 !== r2);
    // Along the edge, both sides agree on folded edges.
    const a1 = unfoldMap(tab, r1, ...e.p), a2 = unfoldMap(tab, r2, ...e.p);
    const q = e.p.map((v, i) => v + (e.n1[i] === 0 && e.n2[i] === 0 ? 3 : 0)); // 3 mm along the edge
    const b1 = unfoldMap(tab, r1, ...q), b2 = unfoldMap(tab, r2, ...q);
    if (Math.hypot(a1.u - a2.u, a1.v - a2.v) < 1e-9 && Math.hypot(b1.u - b2.u, b1.v - b2.v) < 1e-9) folded++;
  }
  assert.equal(folded, 5);
});

test('every region map is length-preserving and flat', () => {
  const tab = buildUnfold(box(20, 30, 40));
  for (let r = 0; r < tab.regionCount; r++) {
    const m = tab.M.subarray(r * 6, r * 6 + 6);
    const lu = Math.hypot(m[0], m[1], m[2]), lv = Math.hypot(m[3], m[4], m[5]);
    assert.ok(Math.abs(lu - 1) < 1e-9 && Math.abs(lv - 1) < 1e-9);
    assert.ok(Math.abs(m[0]*m[3] + m[1]*m[4] + m[2]*m[5]) < 1e-9);
  }
});

test('folded flaps open outwards: each side of a folded edge lies on its own side of the hinge', () => {
  const tab = buildUnfold(box(20, 30, 40));
  for (const e of boxEdges(20, 30, 40)) {
    const r1 = unfoldRegionAt(tab, ...e.p, ...e.n1), r2 = unfoldRegionAt(tab, ...e.p, ...e.n2);
    const a1 = unfoldMap(tab, r1, ...e.p), a2 = unfoldMap(tab, r2, ...e.p);
    if (Math.hypot(a1.u - a2.u, a1.v - a2.v) > 1e-9) continue; // seam
    // A point 2 mm into each face, away from the edge (into face 1 = against n2).
    const in1 = e.p.map((v, i) => v - e.n2[i] * 2), in2 = e.p.map((v, i) => v - e.n1[i] * 2);
    const p1 = unfoldMap(tab, r1, ...in1), p2 = unfoldMap(tab, r2, ...in2);
    // Unfolded, the two points are 4 mm apart (2 + 2 across the hinge), not on top of each other.
    assert.ok(Math.abs(Math.hypot(p1.u - p2.u, p1.v - p2.v) - 4) < 1e-6, 'flap folded the wrong way');
  }
});

test('per-corner places of a refined mesh: length-preserving, continuous on folded edges', () => {
  const pos = box(20, 20, 20, 4);
  const tab = buildUnfold(box(20, 20, 20, 1));
  const uv = unfoldPlaces(tab, pos);
  for (let t = 0; t < pos.length / 9; t++) {
    const b = t * 9, c = t * 6;
    const l3 = Math.hypot(pos[b+3]-pos[b], pos[b+4]-pos[b+1], pos[b+5]-pos[b+2]);
    const l2 = Math.hypot(uv[c+2]-uv[c], uv[c+3]-uv[c+1]);
    assert.ok(Math.abs(l3 - l2) < 1e-4, `edge length ${l3} vs ${l2}`);
  }
});

test('an L-shaped part (non-convex edge) also unfolds without stretching', () => {
  // Two boxes side by side → one L-profile prism with a concave edge.
  const a = box(20, 10, 10), b = box(10, 10, 20);
  for (let i = 0; i < b.length; i += 3) b[i] += 5 - 10; // x ∈ [-10, 0]
  for (let i = 0; i < a.length; i += 3) a[i] += 10;      // x ∈ [0, 20]
  const tab = buildUnfold(Float32Array.from([...a, ...b]));
  assert.ok(tab.regionCount >= 6);
  for (let r = 0; r < tab.regionCount; r++) {
    const m = tab.M.subarray(r * 6, r * 6 + 6);
    assert.ok(Math.abs(Math.hypot(m[0], m[1], m[2]) - 1) < 1e-9);
  }
});

test('computeUV in unfold mode: the texture runs straight across a folded edge', async () => {
  const { computeUV, MODE_UNFOLD } = await import('../js/mapping.js');
  const pos = box(20, 20, 20);
  const tab = buildUnfold(pos);
  const bounds = { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 20 }, size: { x: 20, y: 20, z: 20 }, center: { x: 0, y: 0, z: 10 } };
  const s = { scaleU: 7, scaleV: 7, offsetU: 0, offsetV: 0, rotation: 0, unfold: tab };
  // Find a folded edge and step 0.05 mm to either side of it.
  let checked = 0;
  for (const e of boxEdges(20, 20, 20)) {
    const r1 = unfoldRegionAt(tab, ...e.p, ...e.n1), r2 = unfoldRegionAt(tab, ...e.p, ...e.n2);
    const a1 = unfoldMap(tab, r1, ...e.p), a2 = unfoldMap(tab, r2, ...e.p);
    if (Math.hypot(a1.u - a2.u, a1.v - a2.v) > 1e-9) continue;
    const p1 = e.p.map((v, i) => v - e.n2[i] * 0.05), p2 = e.p.map((v, i) => v - e.n1[i] * 0.05);
    const nrm = (n) => ({ x: n[0], y: n[1], z: n[2] });
    const uvA = computeUV({ x: p1[0], y: p1[1], z: p1[2] }, nrm(e.n1), MODE_UNFOLD, s, bounds);
    const uvB = computeUV({ x: p2[0], y: p2[1], z: p2[2] }, nrm(e.n2), MODE_UNFOLD, s, bounds);
    // 0.1 mm apart on the surface = 0.1/7 of a tile (mod 1).
    const du = Math.abs(uvA.u - uvB.u), dv = Math.abs(uvA.v - uvB.v);
    const d = Math.hypot(Math.min(du, 1 - du), Math.min(dv, 1 - dv));
    assert.ok(Math.abs(d - 0.1 / 7) < 1e-6, `jump of ${d} across a folded edge`);
    checked++;
  }
  assert.equal(checked, 5);
});

test('export pipeline in unfold mode: closed, manifold output', async () => {
  const { runExportPipeline } = await import('../js/exportPipeline.js');
  const positions = box(20, 20, 20);
  const w = 64, h = 64, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = (x % 16 < 4 || y % 16 < 4) ? 255 : 0; // square grid
    data.set([v, v, v, 255], (y * w + x) * 4);
  }
  const settings = {
    mappingMode: 9, scaleU: 5, scaleV: 5, amplitude: 0.6, offsetU: 0, offsetV: 0, rotation: 0,
    refineLength: 0.4, maxTriangles: 40000, bottomAngleLimit: 5, topAngleLimit: 0, mappingBlend: 1,
    seamBandWidth: 0.5, textureSmoothing: 0, capAngle: 20, boundaryFalloff: 0, symmetricDisplacement: false,
    noDownwardZ: false, smoothBottom: true, harvestFlatFaces: true, harvestTol: 0.005, regularizeEnabled: false,
    unfold: buildUnfold(positions),
  };
  const b = { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 20 }, size: { x: 20, y: 20, z: 20 }, center: { x: 0, y: 0, z: 10 } };
  const r = await runExportPipeline({ positions, faceWeights: null, softExclude: null, imageData: { data, width: w, height: h },
    imgWidth: w, imgHeight: h, settings, bounds: b, regularizeOpts: {}, mode: 'export' });
  assert.ok(r.repairStats);
  assert.equal(r.repairStats.open, 0);
  assert.equal(r.repairStats.nonManifold, 0);
});

test('seams go to the bottom and the vertical edges, never to the top edges', () => {
  const tab = buildUnfold(box(50, 50, 50));
  const kind = {};
  for (const e of boxEdges(50, 50, 50)) {
    const r1 = unfoldRegionAt(tab, ...e.p, ...e.n1), r2 = unfoldRegionAt(tab, ...e.p, ...e.n2);
    const a = unfoldMap(tab, r1, ...e.p), b = unfoldMap(tab, r2, ...e.p);
    const where = e.n2[2] === 1 ? 'top' : e.n2[2] === -1 ? 'bottom' : 'vertical';
    kind[where] = kind[where] || { folded: 0, seam: 0 };
    kind[where][Math.hypot(a.u - b.u, a.v - b.v) < 1e-9 ? 'folded' : 'seam']++;
  }
  assert.deepEqual(kind.top, { folded: 4, seam: 0 });
  assert.equal(kind.bottom.folded, 1);
  assert.equal(kind.vertical.seam, 4);
});

// Height maps for the seam fit (RGBA, red channel = height).
function image(W, H, fn) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.fill(fn(x / W, y / H) * 255, (y * W + x) * 4, (y * W + x) * 4 + 3);
  return { data, width: W, height: H };
}

test('seam fit: a square grid on a cube becomes seamless', async () => {
  const { fitUnfoldTiling } = await import('../js/unfold.js');
  const tab = buildUnfold(box(50, 50, 50));
  const grid = image(64, 64, (u, v) => (Math.abs(u - 0.5) < 0.15 || Math.abs(v - 0.5) < 0.15) ? 1 : 0);
  const cur = { scaleU: 17.3, scaleV: 17.3, offsetU: 0.13, offsetV: 0.41, rotation: 0 };
  const fit = fitUnfoldTiling(tab, grid, cur);
  assert.ok(fit.before > 0.2, `start must have visible seams (${fit.before})`);
  assert.ok(fit.after < 0.05, `fit must close the seams: ${fit.before} → ${fit.after}`);
  // Not necessarily a whole number of tiles: with wide bars a corner only has
  // to sit inside a bar crossing for the edge to show one continuous bar.
  // The fit keeps the size close to the user's (within the search range).
  assert.ok(Math.abs(Math.log(fit.scaleU / cur.scaleU)) < Math.log(1.35) + 1e-9);
});

test('seam fit never makes it worse, also for a pattern without symmetry', async () => {
  const { fitUnfoldTiling } = await import('../js/unfold.js');
  const tab = buildUnfold(box(40, 30, 20));
  let s = 7;
  const noise = image(32, 32, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s & 255) / 255; });
  const cur = { scaleU: 11, scaleV: 11, offsetU: 0, offsetV: 0, rotation: 0 };
  const fit = fitUnfoldTiling(tab, noise, cur);
  assert.ok(fit.after <= fit.before + 1e-12);
});
