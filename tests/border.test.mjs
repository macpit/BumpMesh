/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Ornaments ▸ Border: a cylindrical stamp with stampWrap repeats a whole
// number of times around the axis and covers only its height band.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stampFrame, stampUV, isStampActive, buildStampDepth } from '../js/mapping.js';

const bounds = { min: { x: -50, y: -50, z: 0 }, max: { x: 50, y: 50, z: 40 },
                 size: { x: 100, y: 100, z: 40 }, center: { x: 0, y: 0, z: 20 } };
const settings = {
  mappingMode: 3, stampOnce: true, stampWrap: true, stampRepeats: 8, stampBandWidth: 6,
  stampCenterX: null, stampCenterY: null, stampCenterZ: 20, scaleU: 10, scaleV: 10,
  textureAspectU: 1, textureAspectV: 1, rotation: 30,
};

test('border frame: repeats around, band width, no rotation, no depth map', () => {
  assert.ok(isStampActive(settings));
  const f = stampFrame(settings, bounds);
  assert.equal(f.wrap, true);
  assert.ok(Math.abs(f.sizeU - 2 * Math.PI * 50 / 8) < 1e-9);
  assert.equal(f.sizeV, 6);
  assert.equal(f.sinR, 0);
  assert.equal(buildStampDepth(new Float32Array(9), f), null);
});

test('border UV: covered all the way round inside the band, nowhere outside', () => {
  const f = stampFrame(settings, bounds);
  for (let k = 0; k < 360; k++) {
    const a = k * Math.PI / 180;
    const p = { x: 50 * Math.cos(a), y: 50 * Math.sin(a) };
    const n = { x: Math.cos(a), y: Math.sin(a), z: 0 };
    const inBand = stampUV({ ...p, z: 20 }, n, f);
    assert.ok(inBand.u >= 0 && inBand.u < 1, `u in [0,1) at ${k}°`);
    assert.ok(inBand.cover > 0.99, `covered at ${k}°`);
    assert.equal(stampUV({ ...p, z: 24 }, n, f).cover, 0, 'above the band');
    assert.equal(stampUV({ ...p, z: 16 }, n, f).cover, 0, 'below the band');
    // Inside walls (normal pointing at the axis) stay free.
    assert.equal(stampUV({ ...p, z: 20 }, { x: -n.x, y: -n.y, z: 0 }, f).cover, 0);
  }
});

test('border UV: whole repeats, so u matches across one repeat angle', () => {
  const f = stampFrame(settings, bounds);
  const at = (deg) => {
    const a = deg * Math.PI / 180;
    return stampUV({ x: 50 * Math.cos(a), y: 50 * Math.sin(a), z: 20 }, { x: Math.cos(a), y: Math.sin(a), z: 0 }, f).u;
  };
  for (const d of [-170, -95, -10, 0, 33, 120, 179]) {
    const u0 = at(d), u1 = at(d + 45);   // 360 / 8 repeats
    assert.ok(Math.abs(u0 - u1) < 1e-6 || Math.abs(Math.abs(u0 - u1) - 1) < 1e-6, `${d}°: ${u0} vs ${u1}`);
  }
});

test('plain stamp unchanged: no wrap, footprint bounded in u', () => {
  const f = stampFrame({ ...settings, stampWrap: false }, bounds);
  assert.equal(f.wrap, false);
  const back = stampUV({ x: 0, y: 50, z: 20 }, { x: 0, y: 1, z: 0 }, f);
  assert.equal(back.cover, 0);
});

// ── Ornament filament in the export ─────────────────────────────────────────
import * as THREE from 'three';
import { runExportPipeline } from '../js/exportPipeline.js';

function cylinder() {
  const g = new THREE.CylinderGeometry(20, 20, 40, 48, 8, false).toNonIndexed();
  g.rotateX(Math.PI / 2);   // Y-up → Z-up
  g.translate(0, 0, 20);
  return g.attributes.position.array.slice();
}

// One repeat: left half white (pattern), right half black.
function halfImage(w = 64, h = 32) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x < w / 2 ? 255 : 0;
    data.set([v, v, v, 255], (y * w + x) * 4);
  }
  return { data, width: w, height: h };
}

const cylBounds = { min: { x: -20, y: -20, z: 0 }, max: { x: 20, y: 20, z: 40 },
                    size: { x: 40, y: 40, z: 40 }, center: { x: 0, y: 0, z: 20 } };

function layerSettings(over) {
  return {
    mappingMode: 3, scaleU: 10, scaleV: 10, amplitude: 0, textureHeight: 0.5, invertDisplacement: false,
    offsetU: 0, offsetV: 0, rotation: 0, mappingBlend: 1, seamBandWidth: 0.5, capAngle: 20,
    symmetricDisplacement: false, boundaryFalloff: 0, cylinderCenterX: 0, cylinderCenterY: 0, cylinderRadius: 20,
    stampOnce: true, stampWrap: true, stampRepeats: 6, stampBandWidth: 8, stampCenterX: null, stampCenterY: null, stampCenterZ: 20,
    stampFilament: 3, ...over,
  };
}

async function runBorder(globalOver = {}, layerOver = {}, img = halfImage()) {
  return runExportPipeline({
    positions: cylinder(), faceWeights: null, softExclude: null,
    imageData: null, imgWidth: 0, imgHeight: 0,
    layers: [{ imageData: img, imgWidth: img.width, imgHeight: img.height, settings: layerSettings(layerOver),
               exclude: null, hardFaces: null, blendAdd: false, stampDepth: null }],
    settings: {
      mappingMode: 3, refineLength: 0.8, maxTriangles: 40000, bottomAngleLimit: 0, topAngleLimit: 0,
      smoothBottom: true, harvestFlatFaces: true, harvestTol: 0.005, regularizeEnabled: false,
      preserveUntextured: false, colorMode: 'off', colorBands: 2, colorThresholds: [50], ...globalOver,
    },
    bounds: cylBounds, regularizeOpts: {}, mode: 'export',
  });
}

function bandShare(r) {
  const n = r.positions.length / 9;
  let bandArea = 0, fil3Area = 0, outside = 0;
  for (let t = 0; t < n; t++) {
    const p = r.positions, b = t * 9;
    const cz = (p[b + 2] + p[b + 5] + p[b + 8]) / 3;
    const ux = p[b+3]-p[b], uy = p[b+4]-p[b+1], uz = p[b+5]-p[b+2];
    const vx = p[b+6]-p[b], vy = p[b+7]-p[b+1], vz = p[b+8]-p[b+2];
    const area = Math.hypot(uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx) / 2;
    const side = Math.abs(Math.hypot(p[b], p[b+1]) - 20) < 0.5 && cz > 0.1 && cz < 39.9;
    if (side && Math.abs(cz - 20) < 4) bandArea += area;
    if (r.faceLabels && r.faceLabels[t] === 2) { fil3Area += area; if (Math.abs(cz - 20) > 4.2) outside++; }
  }
  return { share: fil3Area / bandArea, outside };
}

// One repeat: grey rising from black (left) to white (right).
function rampImage(w = 64, h = 16) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round(255 * (x + 0.5) / w);
    data.set([v, v, v, 255], (y * w + x) * 4);
  }
  return { data, width: w, height: h };
}

// Where the filament-3 region starts within one repeat (u of its leftmost
// band vertex, the seam at u ≈ 0 left out): the ramp image takes the filament
// from there to the right end, so the share is 1 − that.
function angularShare(r) {
  const P = r.positions, uOf = (i) => ((Math.atan2(P[i + 1], P[i]) / (2 * Math.PI) * 6) % 1 + 1) % 1;
  let start = 1;
  for (let t = 0; t < P.length / 9; t++) {
    if (!r.faceLabels || r.faceLabels[t] !== 2) continue;
    for (let k = 0; k < 3; k++) {
      const i = t * 9 + k * 3;
      if (Math.abs(P[i + 2] - 20) > 4.05) continue;
      const u = uOf(i);
      if (u > 0.05 && u < 0.97) start = Math.min(start, u);
    }
  }
  return 1 - start;
}

test('color spread moves the cut: more spread, more of the pattern in the filament', async () => {
  for (const spread of [20, 50, 80]) {
    const r = await runBorder({}, { stampColorSpread: spread }, rampImage());
    assert.equal(bandShare(r).outside, 0);
    const share = angularShare(r);
    assert.ok(Math.abs(share - spread / 100) < 0.06, `spread ${spread}: share ${share.toFixed(2)}`);
    assert.equal(r.repairStats.open, 0);
    assert.equal(r.repairStats.nonManifold, 0);
  }
});

test('rows: the image repeats across the band height', () => {
  const f = stampFrame({ ...settings, stampRepeatsV: 3 }, bounds);
  assert.equal(f.repeatsV, 3);
  const n = { x: 0, y: -1, z: 0 };
  for (const z of [17.5, 19.2, 21.9]) {
    const st = stampUV({ x: 0, y: -50, z }, n, f);
    assert.ok(st.cover > 0);
    const expect = st.v * 3 - Math.floor(st.v * 3);
    assert.ok(Math.abs(st.sv - expect) < 1e-9);
  }
  // A plain stamp ignores rows.
  const plain = stampFrame({ ...settings, stampWrap: false, stampRepeatsV: 3 }, bounds);
  assert.equal(plain.repeatsV, 1);
});

test('flat border with a filament: labels inside the band only, about half of it, mesh closed', async () => {
  const r = await runBorder();
  assert.ok(r.faceLabels, 'labels present');
  const n = r.positions.length / 9;
  let fil3 = 0, outside = 0, bandArea = 0, fil3Area = 0;
  for (let t = 0; t < n; t++) {
    const p = r.positions, b = t * 9;
    const cz = (p[b + 2] + p[b + 5] + p[b + 8]) / 3;
    const ux = p[b+3]-p[b], uy = p[b+4]-p[b+1], uz = p[b+5]-p[b+2];
    const vx = p[b+6]-p[b], vy = p[b+7]-p[b+1], vz = p[b+8]-p[b+2];
    const area = Math.hypot(uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx) / 2;
    const side = Math.abs(Math.hypot(p[b], p[b+1]) - 20) < 0.5 && cz > 0.1 && cz < 39.9;
    if (side && Math.abs(cz - 20) < 4) bandArea += area;
    if (r.faceLabels[t] === 2) {
      fil3++; fil3Area += area;
      if (Math.abs(cz - 20) > 4.2) outside++;
    }
  }
  assert.ok(fil3 > 0, 'some faces on filament 3');
  assert.equal(outside, 0, 'no filament 3 outside the band');
  const share = fil3Area / bandArea;
  assert.ok(share > 0.4 && share < 0.6, `half the band (${share.toFixed(2)})`);
  assert.equal(r.repairStats.open, 0);
  assert.equal(r.repairStats.nonManifold, 0);
});

test('border without a filament: no labels', async () => {
  const r = await runBorder({}, { stampFilament: 0 });
  assert.equal(r.faceLabels, null);
});

test('raised border with a filament plus color by height: both cuts run, mesh closed', async () => {
  const r = await runBorder({ colorMode: 'height', colorBands: 2, colorThresholds: [50] }, { amplitude: 0.5 });
  assert.ok(r.faceLabels);
  const labels = new Set(r.faceLabels);
  assert.ok(labels.has(2), 'ornament filament present');
  assert.equal(r.repairStats.open, 0);
  assert.equal(r.repairStats.nonManifold, 0);
});
