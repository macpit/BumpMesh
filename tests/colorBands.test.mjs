/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Color by height: cutting the mesh along height contours must keep it
// closed and manifold, put every triangle in exactly one band, and never
// create the zero-area slivers slicers delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cutHeightBands, bandOf, bandThresholds, heightRangeMm, paintStateCode } from '../js/colorBands.js';
import { countEdgeDefects, countAreaSlivers } from '../js/meshRepair.js';
import { decimate } from '../js/decimation.js';

const SIZE = 20;

// Closed, subdivided box: 2 * 6 * seg^2 triangles, bottom at z = 0.
function box(seg = 8) {
  const g = new THREE.BoxGeometry(SIZE, SIZE, SIZE, seg, seg, seg).toNonIndexed();
  g.translate(0, 0, SIZE / 2);
  return g.attributes.position.array.slice();
}

const geo = (positions) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return g;
};

// Height = any function of position, sampled per corner.
const heightsOf = (positions, fn) => {
  const h = new Float32Array(positions.length / 3);
  for (let i = 0; i < h.length; i++) h[i] = fn(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  return h;
};

function centroid(p, t) {
  const b = t * 9;
  return [(p[b] + p[b + 3] + p[b + 6]) / 3, (p[b + 1] + p[b + 4] + p[b + 7]) / 3, (p[b + 2] + p[b + 5] + p[b + 8]) / 3];
}

function assertClosed(positions, msg) {
  const d = countEdgeDefects(geo(positions));
  assert.equal(d.open, 0, `${msg}: open edges`);
  assert.equal(d.nonManifold, 0, `${msg}: non-manifold edges`);
  assert.equal(countAreaSlivers(geo(positions)), 0, `${msg}: zero-area slivers`);
}

test('horizontal contours: closed mesh, every triangle in the band of its height', () => {
  const pos = box(8);
  // Thresholds deliberately off the grid lines (grid step 2.5 mm).
  const T = [0.26, 0.51, 0.77];
  const r = cutHeightBands(pos, heightsOf(pos, (x, y, z) => z / SIZE), null, T);
  assert.ok(r.cutEdges > 0, 'contours must cut edges');
  assert.equal(r.labels.length, r.positions.length / 9);
  assertClosed(r.positions, 'cut box');
  const n = r.labels.length;
  const seen = new Set();
  for (let t = 0; t < n; t++) {
    const [, , cz] = centroid(r.positions, t);
    assert.equal(r.labels[t], bandOf(cz / SIZE, T), `triangle ${t} at z=${cz.toFixed(3)}`);
    seen.add(r.labels[t]);
    // No triangle straddles a contour: all corners within its band (closed).
    const b = t * 9;
    for (let c = 0; c < 3; c++) {
      const h = r.positions[b + c * 3 + 2] / SIZE;
      const k = r.labels[t];
      if (k > 0) assert.ok(h >= T[k - 1] - 1e-6);
      if (k < T.length) assert.ok(h <= T[k] + 1e-6);
    }
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test('decimation keeps every band within 0.02 mm of its contours and reaches the target', async () => {
  const pos = box(24);
  const T = [0.26, 0.51, 0.77];
  const r = cutHeightBands(pos, heightsOf(pos, (x, y, z) => z / SIZE), null, T);
  const target = 3000;
  const out = await decimate(geo(r.positions), target, null, false, 0.005, null, false, r.labels);
  const p = out.attributes.position.array, L = out.userData.faceLabels;
  assert.equal(L.length, p.length / 9);
  assert.ok(L.length <= target * 1.02, `${L.length} triangles for target ${target}`);
  assertClosed(p, 'decimated bands');
  const tol = 0.02 + 1e-4; // LABEL_EDGE_TOL in mm
  for (let t = 0; t < L.length; t++) {
    const k = L[t];
    for (let c = 0; c < 3; c++) {
      const z = p[t * 9 + c * 3 + 2];
      if (k > 0) assert.ok(z >= T[k - 1] * SIZE - tol, `band ${k} vertex at z=${z}`);
      if (k < T.length) assert.ok(z <= T[k] * SIZE + tol, `band ${k} vertex at z=${z}`);
    }
  }
});

test('diagonal contours cross many triangles without opening the mesh', () => {
  const pos = box(10);
  const T = [0.3, 0.45, 0.7];
  const r = cutHeightBands(pos, heightsOf(pos, (x, y, z) => (x + y + 2 * z + 40) / 80), null, T);
  assertClosed(r.positions, 'diagonal');
});

test('contours passing within snap distance of vertices are snapped, not split into slivers', () => {
  const pos = box(8);
  // Threshold 0.5 sits on the z = 10 grid line, plus a sub-micron wobble:
  // every crossing lands within ~1e-4 mm of a vertex.
  const T = [0.5];
  const r = cutHeightBands(pos, heightsOf(pos, (x, y, z) => z / SIZE + 1e-6 * Math.sin(x * 7 + y * 3)), null, T);
  assertClosed(r.positions, 'near-vertex');
  for (let t = 0; t < r.labels.length; t++) {
    const b = t * 9;
    for (let i = 0; i < 9; i += 3) {
      for (let j = i + 3; j < 9; j += 3) {
        const d = Math.hypot(r.positions[b + i] - r.positions[b + j], r.positions[b + i + 1] - r.positions[b + j + 1],
          r.positions[b + i + 2] - r.positions[b + j + 2]);
        assert.ok(d >= 1e-3 - 1e-9, `edge of ${d} mm is shorter than the snap distance`);
      }
    }
  }
});

test('untextured faces stay band 0 and conform to neighbouring contours', () => {
  const pos = box(8);
  const tri = pos.length / 9;
  // Untextured: the +X side (all its corners at x = +10).
  const textured = new Uint8Array(tri);
  for (let t = 0; t < tri; t++) {
    const b = t * 9;
    textured[t] = (pos[b] > 9.999 && pos[b + 3] > 9.999 && pos[b + 6] > 9.999) ? 0 : 1;
  }
  const T = [0.26, 0.51, 0.77];
  const r = cutHeightBands(pos, heightsOf(pos, (x, y, z) => z / SIZE), textured, T);
  assertClosed(r.positions, 'with untextured side');
  for (let t = 0; t < r.labels.length; t++) {
    if (!textured[r.parent[t]]) assert.equal(r.labels[t], 0);
  }
});

test('no thresholds: geometry passes through unchanged', () => {
  const pos = box(4);
  const r = cutHeightBands(pos, heightsOf(pos, () => 0.5), null, []);
  assert.deepEqual(r.positions, pos);
  assert.ok(r.labels.every(l => l === 0));
});

test('thresholds and height range helpers', () => {
  assert.deepEqual(bandThresholds(3, [70, 30, 90]), [0.3, 0.7]);
  assert.deepEqual(bandThresholds(2, [50]), [0.5]);
  assert.deepEqual(heightRangeMm({ amplitude: 0.6, symmetricDisplacement: false }), { min: 0, max: 0.6 });
  assert.deepEqual(heightRangeMm({}, [{ settings: { amplitude: 1, symmetricDisplacement: true } },
    { settings: { amplitude: 0.4 } }]), { min: -0.5, max: 0.5 });
});

test('paint state codes match the slicer TriangleSelector encoding', () => {
  assert.equal(paintStateCode(1), '4');
  assert.equal(paintStateCode(2), '8');
  assert.equal(paintStateCode(3), '0C');
  assert.equal(paintStateCode(4), '1C');
  assert.equal(paintStateCode(16), 'DC');
  assert.throws(() => paintStateCode(17));
});
