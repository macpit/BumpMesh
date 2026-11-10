/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Export ▸ Print: the export's resolution and triangle limit derived from
// what the printer can reproduce instead of from numbers the user has to
// guess.
//
// Across a layer (X/Y) the smallest printable structure is one extrusion
// line — nozzle + 0.02 mm in the slicers' default profiles (0.42 mm for a
// 0.4 nozzle, 0.22 mm for a 0.2). In height (Z) it is one layer, and a wall
// shows its relief in steps of a layer. The printer's "pixel" is therefore
// the smaller of one line and two layers (a line is about two default
// layers wide, so both limits meet at the slicers' defaults); mesh edges of
// half that resolve everything the printer can follow.
//
//   low  edge = one pixel           keeps 1/4 of the subdivided triangles
//   mid  edge = half a pixel        keeps 1/2
//   max  edge = a third of a pixel  keeps all (only flat faces collapse)
//
// The edge never goes below what the subdivision's triangle budget allows
// on this model: a quarter of the device's safety cap for low, half of it
// for mid, and nine tenths for max (the cap is 32 M triangles on
// Chrome/Edge with 8 GB or more, 16 M elsewhere).

import { simulateFromEdges, solveBudgetEdge } from './subdivisionEstimate.js';

export const NOZZLES = [0.2, 0.4, 0.6, 0.8];
export const QUALITIES = ['low', 'mid', 'max'];

/** Layer heights the slicers offer per nozzle, and the usual default. */
const LAYERS = {
  0.2: [0.06, 0.08, 0.10, 0.12, 0.14],
  0.4: [0.08, 0.12, 0.16, 0.20, 0.24, 0.28],
  0.6: [0.18, 0.24, 0.30, 0.36, 0.42],
  0.8: [0.24, 0.32, 0.40, 0.48, 0.56],
};
const DEFAULT_LAYER = { 0.2: 0.10, 0.4: 0.20, 0.6: 0.30, 0.8: 0.40 };

export const layerOptions = (nozzle) => LAYERS[nozzle] || LAYERS[0.4];
export const defaultLayer = (nozzle) => DEFAULT_LAYER[nozzle] ?? 0.20;
/** Default extrusion line width (mm) of a nozzle. */
export const lineWidth = (nozzle) => nozzle + 0.02;

const EDGE_SHARE = { low: 1, mid: 0.5, max: 1 / 3 };     // of the printer's pixel
/** The smallest structure the printer resolves (mm): one line across, two layers in height. */
export const printPixel = (nozzle, layer) => Math.min(lineWidth(nozzle), 2 * layer);
const KEEP_SHARE = { low: 0.25, mid: 0.5, max: 1 };      // of the subdivided triangles
const OUT_MAX    = { low: 2_000_000, mid: 8_000_000, max: 32_000_000 };
const MIN_EDGE = 0.05;
const TRIS_PER_AREA = 4 / Math.sqrt(3);   // equilateral cover, start value for the budget solver

// Measured on textured exports: a 3MF (deflated XML) takes about 11.5 bytes
// per triangle, painted or not; a binary STL exactly 50 plus its header.
const BYTES_3MF_PER_TRI = 11.5;

/** Subdivision budget (triangles) per quality; `cap` is the device's safety cap. */
export function subdivisionBudget(quality, cap) {
  if (quality === 'low') return cap * 0.25;
  if (quality === 'mid') return cap * 0.5;
  return cap * 0.9;
}

/**
 * @param {object} a
 * @param {Float64Array} a.triEdges    per-triangle edge lengths (computeTriEdges)
 * @param {number} a.surfaceArea       mm²
 * @param {number} a.nozzle @param {number} a.layer  mm
 * @param {'low'|'mid'|'max'} a.quality
 * @param {number} a.cap               subdivision safety cap (triangles) on this device
 * @returns {{edge: number, wantEdge: number, capped: boolean, subdivided: number,
 *   maxTriangles: number, bytes3mf: number, bytesStl: number}}
 */
export function printTargets({ triEdges, surfaceArea, nozzle, layer, quality, cap }) {
  const q = QUALITIES.includes(quality) ? quality : 'mid';
  const wantEdge = Math.max(MIN_EDGE, printPixel(nozzle, layer) * EDGE_SHARE[q]);
  const budget = subdivisionBudget(q, cap);
  const budgetEdge = solveBudgetEdge(triEdges, budget,
    Math.sqrt(TRIS_PER_AREA * surfaceArea / Math.max(budget, 1)));
  const capped = budgetEdge > wantEdge;
  // Rounded up to the slider's step, so the estimate stays inside the budget.
  const edge = Math.ceil(Math.max(wantEdge, budgetEdge) * 100 - 1e-9) / 100;
  const subdivided = simulateFromEdges(triEdges, edge);
  const maxTriangles = Math.max(10_000, Math.min(OUT_MAX[q],
    Math.round(subdivided * KEEP_SHARE[q] / 10_000) * 10_000));
  return {
    edge, wantEdge, capped, subdivided, maxTriangles,
    bytes3mf: Math.round(maxTriangles * BYTES_3MF_PER_TRI),
    bytesStl: 84 + 50 * maxTriangles,
  };
}

/** How many layers a relief of `height` mm spans. */
export const reliefLayers = (height, layer) => Math.abs(height) / Math.max(layer, 1e-6);
