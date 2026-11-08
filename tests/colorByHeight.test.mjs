/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Color by height through the real export pipeline: contour cut after
// displacement, labels through decimation and T-junction repair, manifold
// output, and the painted 3MF with one filament per band.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { runExportPipeline } from '../js/exportPipeline.js';
import { export3MF } from '../js/exporter.js';

const SIZE = 20;

function cube() {
  const g = new THREE.BoxGeometry(SIZE, SIZE, SIZE).toNonIndexed();
  g.translate(0, 0, SIZE / 2);
  return g.attributes.position.array.slice();
}

// Smooth waves: a realistic height field (contours are long closed curves).
function wavesTexture(w = 128, h = 128) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 127.5 + 127.5 * Math.sin(2 * Math.PI * x / w * 2) * Math.cos(2 * Math.PI * y / h * 2);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

function settings(overrides = {}) {
  return {
    mappingMode: 5, scaleU: 0.5, scaleV: 0.5, amplitude: 0.8, textureHeight: 0.5,
    invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
    refineLength: 0.4, maxTriangles: 60000, lockScale: true,
    bottomAngleLimit: 5, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
    textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
    symmetricDisplacement: false, noDownwardZ: false, smoothBottom: true,
    harvestFlatFaces: true, harvestTol: 0.005, snapSeamlessWrap: true,
    cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
    regularizeEnabled: false, preserveUntextured: true,
    ...overrides,
  };
}

async function run(overrides) {
  const positions = cube();
  const faceWeights = new Float32Array(positions.length / 3);
  for (let t = 0; t < positions.length / 9; t++) {
    const b = t * 9;
    if (positions[b + 2] < 1e-6 && positions[b + 5] < 1e-6 && positions[b + 8] < 1e-6) faceWeights.fill(1, t * 3, t * 3 + 3);
  }
  const img = wavesTexture();
  const b = { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: SIZE },
              size: { x: SIZE, y: SIZE, z: SIZE }, center: { x: 0, y: 0, z: SIZE / 2 } };
  return runExportPipeline({
    positions, faceWeights, softExclude: null,
    imageData: img, imgWidth: img.width, imgHeight: img.height,
    settings: settings(overrides), bounds: b, regularizeOpts: {}, mode: 'export',
  });
}

const BANDS = { colorMode: 'height', colorBands: 3, colorThresholds: [40, 70] };

test('color by height: three bands through decimation + repair, manifold', async () => {
  const r = await run(BANDS);
  assert.ok(r.runDecimation && r.repairStats, 'must exercise decimation and repair');
  const tris = r.positions.length / 9;
  assert.equal(r.faceLabels.length, tris);
  const counts = [0, 0, 0, 0];
  for (const l of r.faceLabels) counts[l]++;
  assert.ok(counts[0] > 0 && counts[1] > 0 && counts[2] > 0, `all three bands present: ${counts}`);
  assert.equal(counts[3], 0);
  assert.equal(r.repairStats.open, 0);
  assert.equal(r.repairStats.nonManifold, 0);
  assert.equal(r.repairStats.slivers, 0);
  const plain = await run({});
  console.log(`  triangles: plain ${plain.positions.length / 9}, by height ${tris} ` +
    `(target ${settings().maxTriangles}); bands ${counts.slice(0, 3)}`);
});

test('the bottom (untextured, angle-masked) stays on filament 1', async () => {
  const r = await run(BANDS);
  const p = r.positions;
  for (let t = 0; t < r.faceLabels.length; t++) {
    const b = t * 9;
    if (p[b + 2] === 0 && p[b + 5] === 0 && p[b + 8] === 0) assert.equal(r.faceLabels[t], 0);
  }
});

test('painted 3MF carries one paint code per band', async (t) => {
  const r = await run(BANDS);
  let blob;
  t.mock.method(URL, 'createObjectURL', v => { blob = v; return 'blob:x'; });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const prev = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, click() {} }), body: { appendChild() {}, removeChild() {} } };
  t.after(() => { globalThis.document = prev; });
  const geometry = { attributes: { position: { array: r.positions } } };
  await export3MF(geometry, 'x.3mf', () => false, { faceLabels: r.faceLabels });
  const mesh = strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))['3D/Objects/Object_1.model']);
  const n8 = (mesh.match(/paint_color="8"/g) || []).length;
  const n0C = (mesh.match(/paint_color="0C"/g) || []).length;
  // Exported triangles can be fewer (the writer welds; no triangles drop on a
  // repaired mesh) — counts must match the labels exactly.
  const want1 = r.faceLabels.filter(l => l === 1).length, want2 = r.faceLabels.filter(l => l === 2).length;
  assert.equal(n8, want1);
  assert.equal(n0C, want2);
});
