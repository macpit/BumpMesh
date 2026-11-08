/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Colors ▸ Paint filaments: a per-source-face filament (1-based, 0 = none)
// reaches the export as face labels through subdivision, displacement,
// decimation and T-junction repair, and wins over the automatic split.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { runExportPipeline } from '../js/exportPipeline.js';

const SIZE = 20;

function cube() {
  const g = new THREE.BoxGeometry(SIZE, SIZE, SIZE).toNonIndexed();
  g.translate(0, 0, SIZE / 2);
  return g.attributes.position.array.slice();
}

function noiseTexture(w = 64, h = 64) {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 777;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = s & 0xff;
    data.set([v, v, v, 255], i * 4);
  }
  return { data, width: w, height: h };
}

const faceNormal = (p, t) => {
  const b = t * 9;
  const ux = p[b+3]-p[b], uy = p[b+4]-p[b+1], uz = p[b+5]-p[b+2];
  const vx = p[b+6]-p[b], vy = p[b+7]-p[b+1], vz = p[b+8]-p[b+2];
  const n = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
  const l = Math.hypot(...n) || 1;
  return n.map(c => c / l);
};

async function run(colorMode, filamentFaces) {
  const positions = cube();
  const img = noiseTexture();
  const b = { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: SIZE },
              size: { x: SIZE, y: SIZE, z: SIZE }, center: { x: 0, y: 0, z: SIZE / 2 } };
  return runExportPipeline({
    positions, faceWeights: null, softExclude: null,
    imageData: img, imgWidth: img.width, imgHeight: img.height, filamentFaces,
    settings: {
      mappingMode: 5, scaleU: 0.5, scaleV: 0.5, amplitude: 0.4, textureHeight: 0.4,
      invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
      refineLength: 0.6, maxTriangles: 20000, lockScale: true,
      bottomAngleLimit: 0, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
      textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
      symmetricDisplacement: false, noDownwardZ: false, smoothBottom: true,
      harvestFlatFaces: true, harvestTol: 0.005, snapSeamlessWrap: true,
      regularizeEnabled: false, preserveUntextured: false,
      colorMode, colorBands: 2, colorThresholds: [50],
    },
    bounds: b, regularizeOpts: {}, mode: 'export',
  });
}

// The two triangles of the +X face (BoxGeometry face order: +X first) painted filament 3.
function paintPlusX() {
  const f = new Uint8Array(12);
  f[0] = f[1] = 3;
  return f;
}

for (const mode of ['off', 'height']) {
  test(`painted faces export as their filament (Assign ${mode})`, async () => {
    const r = await run(mode, paintPlusX());
    assert.ok(r.faceLabels, 'labels present');
    assert.ok(r.runDecimation, 'test must exercise decimation');
    const n = r.positions.length / 9;
    assert.equal(r.faceLabels.length, n);
    let onPlusX = 0, plusXPainted = 0, elsewhere3 = 0;
    for (let t = 0; t < n; t++) {
      const [nx] = faceNormal(r.positions, t);
      const cx = (r.positions[t*9] + r.positions[t*9+3] + r.positions[t*9+6]) / 3;
      const isPlusX = cx > SIZE / 2 - 1.5 && nx > 0.3;
      if (isPlusX) { onPlusX++; if (r.faceLabels[t] === 2) plusXPainted++; }
      else if (r.faceLabels[t] === 2 && cx < SIZE / 2 - 3) elsewhere3++;
    }
    assert.ok(onPlusX > 0);
    assert.ok(plusXPainted / onPlusX > 0.95, `+X face is filament 3 (${plusXPainted}/${onPlusX})`);
    assert.equal(elsewhere3, 0, 'no filament 3 away from the painted face');
    if (mode === 'off') {
      // Assign off: everything unpainted stays on filament 1.
      for (let t = 0; t < n; t++) assert.ok(r.faceLabels[t] === 0 || r.faceLabels[t] === 2);
    }
    assert.equal(r.repairStats.open, 0);
    assert.equal(r.repairStats.nonManifold, 0);
  });
}

test('no paint, Assign off: no labels (plain 3MF)', async () => {
  const r = await run('off', new Uint8Array(12));
  assert.equal(r.faceLabels, null);
});
