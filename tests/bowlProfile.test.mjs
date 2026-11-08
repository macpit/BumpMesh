/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Ornaments ▸ Ring over the bowl: arc length from the bottom centre along the
// outer profile, the same for the inside and the outside wall.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildBowlTable, bowlArc } from '../js/bowlProfile.js';
import { stampFrame, stampUV } from '../js/mapping.js';

// An open cup: outer radius 30, inner 28, height 40, floor 2 mm thick.
function cup() {
  const parts = [];
  const add = (g) => parts.push(g.toNonIndexed().attributes.position.array);
  const outer = new THREE.CylinderGeometry(30, 30, 40, 64, 20, true); outer.rotateX(Math.PI / 2); outer.translate(0, 0, 20); add(outer);
  const inner = new THREE.CylinderGeometry(28, 28, 38, 64, 20, true); inner.rotateX(Math.PI / 2); inner.translate(0, 0, 21); add(inner);
  const floor = new THREE.CircleGeometry(30, 64); add(floor);
  const top = new THREE.CircleGeometry(28, 64); top.translate(0, 0, 2); add(top);
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test('arc length runs along the bottom, then up the wall', () => {
  const t = buildBowlTable(cup(), 0, 0);
  assert.ok(Math.abs(t.sTop - 70) < 1.5, `bottom 30 + wall 40 ≈ 70 (${t.sTop.toFixed(1)})`);
  assert.ok(Math.abs(bowlArc(t, 15, 0) - 15) < 0.8, 'on the bottom: the radius');
  assert.ok(Math.abs(bowlArc(t, 30, 25) - 55) < 1.5, 'on the outer wall: 30 + height');
});

test('inside and outside get the same arc length (as if punched through)', () => {
  const t = buildBowlTable(cup(), 0, 0);
  for (const z of [10, 20, 35]) {
    const outside = bowlArc(t, 30, z), inside = bowlArc(t, 28, z);
    assert.ok(Math.abs(outside - inside) < 0.8, `z ${z}: ${outside.toFixed(2)} vs ${inside.toFixed(2)}`);
  }
  // Inner floor (z = 2) matches the outer floor (z = 0) at the same radius.
  assert.ok(Math.abs(bowlArc(t, 12, 2) - bowlArc(t, 12, 0)) < 0.8);
});

test('ring over the bowl: the stamp frame uses it, every side faces it', () => {
  const pos = cup();
  const table = buildBowlTable(pos, 0, 0);
  const bounds = { min: { x: -30, y: -30, z: 0 }, max: { x: 30, y: 30, z: 40 }, size: { x: 60, y: 60, z: 40 }, center: { x: 0, y: 0, z: 20 } };
  const f = stampFrame({ mappingMode: 0, stampOnce: true, stampRing: true, stampRingPlace: 'bowl', stampBowl: table,
    stampCenterX: 0, stampCenterY: 0, stampCenterZ: 0, stampSide: 1, scaleU: 140, scaleV: 140, rotation: 0,
    textureAspectU: 1, textureAspectV: 1 }, bounds);
  assert.ok(f.bowl);
  // Outer wall at +x, half way up: arc 50 of radius 70 → u = 0.5 + 50/140.
  const out = stampUV({ x: 30, y: 0, z: 20 }, { x: 1, y: 0, z: 0 }, f);
  const inn = stampUV({ x: 28, y: 0, z: 20 }, { x: -1, y: 0, z: 0 }, f);
  assert.ok(Math.abs(out.u - (0.5 + 50 / 140)) < 0.01, `u ${out.u}`);
  assert.ok(Math.abs(out.v - 0.5) < 1e-6);
  assert.ok(out.cover > 0 && inn.cover > 0, 'outside and inside both covered');
  assert.ok(Math.abs(out.u - inn.u) < 0.01, 'same spot inside and out');
  // The underside faces down and still gets it.
  assert.ok(stampUV({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, f).cover > 0);
});

test('placement curve: through the lines, 1:1 beyond; gamma without lines; inverse', async () => {
  const { bowlWarp, bowlUnwarp } = await import('../js/bowlProfile.js');
  const lines = { pts: [[20, 10], [50, 60]], gamma: 1, R: 70 };
  assert.equal(bowlWarp(lines, 10), 5);
  assert.equal(bowlWarp(lines, 20), 10);
  assert.equal(bowlWarp(lines, 35), 35);
  assert.equal(bowlWarp(lines, 60), 70);
  const g = { pts: [], gamma: 2, R: 70 };
  assert.ok(bowlWarp(g, 35) < 35, 'gamma > 1 spreads the centre over more of the bottom');
  assert.ok(Math.abs(bowlWarp(g, 70) - 70) < 1e-9, 'the outer edge stays');
  for (const q of [5, 30, 65]) assert.ok(Math.abs(bowlWarp(lines, bowlUnwarp(lines, q, 70)) - q) < 1e-6);
});

test('lines move the image on the model', () => {
  const pos = cup();
  const table = buildBowlTable(pos, 0, 0);
  const bounds = { min: { x: -30, y: -30, z: 0 }, max: { x: 30, y: 30, z: 40 }, size: { x: 60, y: 60, z: 40 }, center: { x: 0, y: 0, z: 20 } };
  const base = { mappingMode: 0, stampOnce: true, stampRing: true, stampRingPlace: 'bowl', stampBowl: table,
    stampCenterX: 0, stampCenterY: 0, stampCenterZ: 0, stampSide: 1, scaleU: 140, scaleV: 140, rotation: 0,
    textureAspectU: 1, textureAspectV: 1 };
  // Image radius 0.5 (35 mm) put at the bottom edge (arc 30 of 70).
  const f = stampFrame({ ...base, stampBowlLines: [{ r: 0.5, s: 30 / table.sTop }] }, bounds);
  const atEdge = stampUV({ x: 29.9, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, f);
  assert.ok(Math.abs(atEdge.u - 0.75) < 0.01, `image radius 0.5 at the bottom edge (u ${atEdge.u})`);
});
