/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Export ▸ Print: resolution and triangle limit from nozzle, layer height and quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { computeTriEdges } from '../js/subdivisionEstimate.js';
import { printTargets, lineWidth, layerOptions, defaultLayer, subdivisionBudget } from '../js/printProfile.js';

function sphere(r) {
  const g = new THREE.SphereGeometry(r, 48, 24).toNonIndexed();
  return { triEdges: computeTriEdges(g), surfaceArea: 4 * Math.PI * r * r };
}
const CAP = 32_000_000;

test('line widths and layer defaults follow the slicer profiles', () => {
  assert.ok(Math.abs(lineWidth(0.4) - 0.42) < 1e-9);
  assert.ok(Math.abs(lineWidth(0.2) - 0.22) < 1e-9);
  assert.equal(defaultLayer(0.4), 0.20);
  assert.equal(defaultLayer(0.2), 0.10);
  assert.ok(layerOptions(0.4).includes(0.20) && layerOptions(0.2).includes(0.10));
});

test('a small model gets the edge nozzle and layer ask for', () => {
  const m = sphere(20);
  const mid = printTargets({ ...m, nozzle: 0.4, layer: 0.2, quality: 'mid', cap: CAP });
  assert.equal(mid.edge, 0.2);    // pixel = min(0.42 line, 2 × 0.20 layer) = 0.40
  assert.equal(mid.capped, false);
  const low = printTargets({ ...m, nozzle: 0.4, layer: 0.2, quality: 'low', cap: CAP });
  assert.equal(low.edge, 0.4);
  const max = printTargets({ ...m, nozzle: 0.4, layer: 0.2, quality: 'max', cap: CAP });
  assert.equal(max.edge, 0.14);
  assert.ok(low.maxTriangles < mid.maxTriangles && mid.maxTriangles < max.maxTriangles);
  // max keeps every subdivided triangle (to the slider step)
  assert.ok(Math.abs(max.maxTriangles - max.subdivided) <= 10_000);
});

test('a finer nozzle gives a finer edge, a coarser one a coarser edge', () => {
  const m = sphere(20);
  const e = (nozzle) => printTargets({ ...m, nozzle, layer: defaultLayer(nozzle), quality: 'mid', cap: CAP }).edge;
  assert.ok(e(0.2) < e(0.4) && e(0.4) < e(0.6) && e(0.6) < e(0.8));
  assert.equal(e(0.2), 0.1);
});

test('the layer height counts: finer layers, finer edge, up to the line width', () => {
  const m = sphere(10);
  const e = (layer) => printTargets({ ...m, nozzle: 0.4, layer, quality: 'mid', cap: CAP }).edge;
  assert.equal(e(0.08), 0.08);
  assert.equal(e(0.12), 0.12);
  assert.equal(e(0.20), 0.2);
  assert.equal(e(0.24), 0.21);   // two layers are wider than a line: the line limits
  assert.equal(e(0.28), 0.21);
});

test('a large model is held to the subdivision budget', () => {
  const m = sphere(175);   // 385,000 mm²
  for (const quality of ['low', 'mid', 'max']) {
    const t = printTargets({ ...m, nozzle: 0.4, layer: 0.2, quality, cap: CAP });
    assert.ok(t.subdivided <= subdivisionBudget(quality, CAP) * 1.02, `${quality}: ${t.subdivided}`);
    if (quality !== 'low') assert.equal(t.capped, true);
  }
  const mid = printTargets({ ...m, nozzle: 0.4, layer: 0.2, quality: 'mid', cap: CAP });
  const max = printTargets({ ...m, nozzle: 0.4, layer: 0.2, quality: 'max', cap: CAP });
  assert.ok(max.edge < mid.edge);
  // a device with the smaller cap gets a coarser max
  const small = printTargets({ ...m, nozzle: 0.4, layer: 0.2, quality: 'max', cap: 16_000_000 });
  assert.ok(small.edge > max.edge);
});

test('file sizes follow the triangle limit', () => {
  const t = printTargets({ ...sphere(20), nozzle: 0.4, layer: 0.2, quality: 'mid', cap: CAP });
  assert.equal(t.bytesStl, 84 + 50 * t.maxTriangles);
  assert.equal(t.bytes3mf, Math.round(t.maxTriangles * 11.5));
});
