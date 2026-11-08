/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// #64: textured faces get their own filament in the 3MF export. The
// textured/untextured label is computed in displacement, carried through
// decimation and T-junction repair, and written as slicer paint data.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { runExportPipeline } from '../js/exportPipeline.js';
import { export3MF } from '../js/exporter.js';

const SIZE = 20;

function cube() {
  const g = new THREE.BoxGeometry(SIZE, SIZE, SIZE).toNonIndexed();
  g.translate(0, 0, SIZE / 2); // bottom on z = 0
  g.computeVertexNormals();
  return g.attributes.position.array.slice();
}

function noiseTexture(w = 64, h = 64) {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = s & 0xff;
    data.set([v, v, v, 255], i * 4);
  }
  return { data, width: w, height: h };
}

function settings(overrides = {}) {
  return {
    mappingMode: 5, scaleU: 0.5, scaleV: 0.5, amplitude: 0.5, textureHeight: 0.5,
    invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
    refineLength: 0.5, maxTriangles: 30000, lockScale: true,
    bottomAngleLimit: 5, topAngleLimit: 5, mappingBlend: 1, seamBandWidth: 0.5,
    textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
    symmetricDisplacement: false, noDownwardZ: false, smoothBottom: true,
    harvestFlatFaces: true, harvestTol: 0.005, snapSeamlessWrap: true,
    cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
    regularizeEnabled: false, preserveUntextured: false,
    ...overrides,
  };
}

async function run(overrides) {
  const positions = cube();
  const img = noiseTexture();
  const b = { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: SIZE },
              size: { x: SIZE, y: SIZE, z: SIZE }, center: { x: 0, y: 0, z: SIZE / 2 } };
  // Like main.js, angle-masked source faces arrive as exclusion weight 1, which
  // is what preserveUntextured locks in decimation.
  const faceWeights = new Float32Array(positions.length / 3);
  for (let t = 0; t < positions.length / 9; t++) {
    if (Math.abs(faceInfo(positions, t).nz) > 0.99) faceWeights.fill(1, t * 3, t * 3 + 3);
  }
  return runExportPipeline({
    positions, faceWeights, softExclude: null,
    imageData: img, imgWidth: img.width, imgHeight: img.height,
    settings: settings(overrides), bounds: b, regularizeOpts: {}, mode: 'export',
  });
}

function faceInfo(pos, t) {
  const b = t * 9;
  const ux = pos[b+3]-pos[b], uy = pos[b+4]-pos[b+1], uz = pos[b+5]-pos[b+2];
  const vx = pos[b+6]-pos[b], vy = pos[b+7]-pos[b+1], vz = pos[b+8]-pos[b+2];
  const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { nz: nz / len, cz: (pos[b+2] + pos[b+5] + pos[b+8]) / 3 };
}

for (const preserveUntextured of [false, true]) {
  test(`labels survive decimation + repair and match the cap faces (preserveUntextured=${preserveUntextured})`, async () => {
    const r = await run({ colorTexturedFaces: true, preserveUntextured });
    assert.ok(r.runDecimation, 'test must exercise decimation');
    assert.ok(r.repairStats, 'test must exercise T-junction repair');
    const triCount = r.positions.length / 9;
    assert.equal(r.faceLabels.length, triCount);

    let textured = 0, wrong = 0;
    for (let t = 0; t < triCount; t++) {
      const { nz, cz } = faceInfo(r.positions, t);
      const onCap = Math.abs(nz) > 0.999 && (Math.abs(cz) < 1e-3 || Math.abs(cz - SIZE) < 1e-3);
      if (r.faceLabels[t]) textured++;
      // Untextured = exactly the angle-masked top/bottom caps.
      if (!r.faceLabels[t] && !onCap) wrong++;
    }
    assert.equal(wrong, 0, 'untextured faces must all lie on the masked caps');
    assert.ok(textured > 0 && textured < triCount, 'both labels present');
    assert.equal(r.repairStats.open, 0);
    assert.equal(r.repairStats.nonManifold, 0);
  });
}

test('labels are off by default', async () => {
  const off = await run({});
  assert.equal(off.faceLabels, null);
});

function captureDownload(t) {
  let blob;
  t.mock.method(URL, 'createObjectURL', value => { blob = value; return 'blob:test'; });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, click() {} }), body: { appendChild() {}, removeChild() {} } };
  t.after(() => { globalThis.document = previous; });
  return () => blob;
}

const geometry = positions => ({ attributes: { position: { array: positions } } });
const twoTris = new Float32Array([0,0,0, 1,0,0, 0,1,0,  1,0,0, 1,1,0, 0,1,0]);

test('painted 3MF: textured faces carry extruder-2 paint, package is slicer-project shaped', async t => {
  const getBlob = captureDownload(t);
  await export3MF(geometry(twoTris), 'x.3mf', () => false, { faceLabels: new Uint8Array([0, 1]) });
  const files = unzipSync(new Uint8Array(await getBlob().arrayBuffer()));
  for (const f of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', '3D/_rels/3dmodel.model.rels',
                   '3D/Objects/Object_1.model', 'Metadata/model_settings.config', 'Metadata/slice_info.config']) {
    assert.ok(files[f], `missing ${f}`);
  }
  assert.ok(!files['Metadata/project_settings.config'], 'project settings must not be embedded');
  const mesh = strFromU8(files['3D/Objects/Object_1.model']);
  const tris = mesh.match(/<triangle [^>]*\/>/g);
  assert.equal(tris.length, 2);
  assert.ok(!/paint_color/.test(tris[0]), 'untextured face keeps the default extruder');
  assert.match(tris[1], /paint_color="8" slic3rpe:mmu_segmentation="8"/);
  assert.match(mesh, /xmlns:slic3rpe=/);
  const root = strFromU8(files['3D/3dmodel.model']);
  assert.match(root, /BambuStudio:3mfVersion/);
  assert.match(root, /<component p:path="\/3D\/Objects\/Object_1.model" objectid="1"/);
  assert.match(strFromU8(files['[Content_Types].xml']), /Extension="config"/);
});

test('no textured face → plain single-model 3MF', async t => {
  const getBlob = captureDownload(t);
  await export3MF(geometry(twoTris), 'x.3mf', () => false, { faceLabels: new Uint8Array([0, 0]) });
  const files = unzipSync(new Uint8Array(await getBlob().arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
});

test('label/triangle count mismatch is rejected', async () => {
  await assert.rejects(export3MF(geometry(twoTris), 'x.3mf', () => false, { faceLabels: new Uint8Array([1]) }));
});
