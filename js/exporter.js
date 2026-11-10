/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { strToU8 } from 'fflate';
import { QuantizedPointMap } from './meshIndex.js';
import { zipChunks } from './zipStream.js';
import { paintStateCode, MAX_FILAMENTS } from './colorBands.js';

/**
 * Trigger a browser download for a binary buffer.
 * @param {ArrayBuffer|Uint8Array|Blob} buffer
 * @param {string} filename
 * @param {string} [mime]
 */
function triggerDownload(buffer, filename, mime = 'application/octet-stream') {
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Fast binary STL exporter — writes directly from BufferGeometry arrays.
 *
 * Eliminates Three.js STLExporter overhead:
 * - No Mesh/Material creation
 * - No identity matrix multiplication per vertex
 * - No redundant normal recomputation
 * - Bulk Uint8Array.set() instead of per-float DataView calls
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position + normal
 * @param {string} [filename]
 */
export function exportSTL(geometry, filename = 'textured.stl') {
  const posArr = geometry.attributes.position.array;
  const norArr = geometry.attributes.normal
    ? geometry.attributes.normal.array
    : null;
  const triCount = (posArr.length / 9) | 0;

  // Binary STL: 80-byte header + 4-byte tri count + 50 bytes per triangle
  const bufLen = 84 + 50 * triCount;
  const buffer = new ArrayBuffer(bufLen);
  const bytes  = new Uint8Array(buffer);
  const view   = new DataView(buffer);

  // Header: 80 bytes (already zero-filled)
  view.setUint32(80, triCount, true);

  // Reinterpret source arrays as raw bytes for bulk copy
  const posSrc = new Uint8Array(posArr.buffer, posArr.byteOffset, posArr.byteLength);
  const norSrc = norArr
    ? new Uint8Array(norArr.buffer, norArr.byteOffset, norArr.byteLength)
    : null;

  for (let i = 0; i < triCount; i++) {
    const dst    = 84 + i * 50;
    const srcOff = i * 36; // 9 floats * 4 bytes

    if (norSrc) {
      // Normal: copy first vertex normal (12 bytes) — flat shading, all 3 identical
      bytes.set(norSrc.subarray(srcOff, srcOff + 12), dst);
    } else {
      // Compute face normal from cross product
      const b = i * 9;
      const ux = posArr[b+3]-posArr[b], uy = posArr[b+4]-posArr[b+1], uz = posArr[b+5]-posArr[b+2];
      const vx = posArr[b+6]-posArr[b], vy = posArr[b+7]-posArr[b+1], vz = posArr[b+8]-posArr[b+2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
      view.setFloat32(dst,     nx/len, true);
      view.setFloat32(dst + 4, ny/len, true);
      view.setFloat32(dst + 8, nz/len, true);
    }

    // Vertices: 36 bytes (3 vertices * 3 floats * 4 bytes)
    bytes.set(posSrc.subarray(srcOff, srcOff + 36), dst + 12);

    // Attribute byte count: 0 (already zero-filled)
  }

  triggerDownload(buffer, filename);
}

/**
 * 3MF exporter — builds a ZIP-packaged XML mesh in the Microsoft 3D
 * Manufacturing core format (2015/02).
 *
 * Vertices are deduplicated (positions quantized to 4 decimals, i.e. 0.0001 mm
 * tolerance) so the output is both smaller than binary STL and round-trippable
 * by this project's own 3MF loader.
 *
 * With `faceLabels` each face is painted for filament label + 1 (textured
 * faces #64, or height bands from colorBands.js); label 0 stays on the
 * object's default extruder 1. See paintedPackage() for the package layout.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position attribute
 * @param {string} [filename]
 * @param {() => boolean} [shouldAbort]
 * @param {object} [opts]
 * @param {Uint8Array|null} [opts.faceLabels]  per-face filament - 1
 * @returns {Promise<void>}
 */
export async function export3MF(geometry, filename = 'textured.3mf', shouldAbort = () => false, opts = {}) {
  if (shouldAbort()) throw new Error('Aborted');
  const posArr = geometry.attributes.position.array;

  const triCount = (posArr.length / 9) | 0;

  // ── Deduplicate vertices ─────────────────────────────────────────────────
  // Weld on the 1e4 grid (0.0001 mm cells), matching the 4-decimal precision
  // the coordinates are written with below — safely below the resolution of
  // any FDM/SLA printer and far tighter than float32 rounding noise from the
  // displacement pipeline. The pipeline snaps coordinates onto this exact
  // grid in resolveTJunctions before export, so welding here only merges
  // bit-identical (or grid-identical) points.
  const indexMap  = new QuantizedPointMap(1e4, Math.min(triCount * 3, 1 << 22));
  const uniqueXYZ = [];   // flat [x,y,z,x,y,z,...]
  const triIdx    = new Uint32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    for (let j = 0; j < 3; j++) {
      const b = i * 9 + j * 3;
      const x = posArr[b];
      const y = posArr[b + 1];
      const z = posArr[b + 2];
      const idx = indexMap.getOrSet(x, y, z, uniqueXYZ.length / 3);
      if (indexMap.inserted) uniqueXYZ.push(x, y, z);
      triIdx[i * 3 + j] = idx;
    }
  }

  const faceLabels = opts.faceLabels || null;
  if (faceLabels && faceLabels.length !== triCount) {
    throw new Error('3MF export: face labels do not match the triangle count');
  }
  if (faceLabels && faceLabels.some(l => l > 0)) {
    const blob = await zipChunks(paintedPackage(uniqueXYZ, triIdx, faceLabels), shouldAbort);
    if (shouldAbort()) throw new Error('Aborted');
    triggerDownload(blob, filename);
    return;
  }

  // ── Static package files ─────────────────────────────────────────────────
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '</Types>\n';

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rel-1" Target="/3D/3dmodel.model" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  // ── Zip and download ─────────────────────────────────────────────────────
  const blob = await zipChunks([
    ['[Content_Types].xml', [strToU8(contentTypesXml)]],
    ['_rels/.rels', [strToU8(relsXml)]],
    ['3D/3dmodel.model', modelChunks(uniqueXYZ, triIdx)],
  ], shouldAbort);
  if (shouldAbort()) throw new Error('Aborted');
  triggerDownload(blob, filename);
}

// Generate bounded XML chunks directly into the compressor. Keeping all XML
// chunks and then concatenating them used two full uncompressed mesh copies.
//
// `layout` lets the painted package reuse the streaming writer: its own
// <model>/<object> header and footer, plus `triAttr(i)` returning extra
// attributes for triangle i. The default reproduces the plain export exactly.
const PLAIN_LAYOUT = {
  head: '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    '<resources>\n<object id="1" type="model">\n',
  tail: '</object>\n</resources>\n' +
    '<build>\n<item objectid="1"/>\n</build>\n</model>\n',
  triAttr: null,
};

function* modelChunks(vertices, indices, layout = PLAIN_LAYOUT) {
  const enc = new TextEncoder();
  const threshold = 1 << 20;
  const triAttr = layout.triAttr;
  let pending = layout.head + '<mesh>\n<vertices>\n';
  const fmt = (n) => {
    // 4 decimals matches the dedup precision; strip trailing zeros and ".".
    let s = n.toFixed(4);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  };
  for (let i = 0; i < vertices.length; i += 3) {
    // Preserve the existing four-decimal coordinate representation.
    pending += `<vertex x="${fmt(vertices[i])}" y="${fmt(vertices[i+1])}" z="${fmt(vertices[i+2])}"/>\n`;
    if (pending.length >= threshold) { yield enc.encode(pending); pending = ''; }
  }
  pending += '</vertices>\n<triangles>\n';
  for (let i = 0; i < indices.length; i += 3) {
    const extra = triAttr ? triAttr(i / 3) : '';
    pending += `<triangle v1="${indices[i]}" v2="${indices[i+1]}" v3="${indices[i+2]}"${extra}/>\n`;
    if (pending.length >= threshold) { yield enc.encode(pending); pending = ''; }
  }
  pending += '</triangles>\n</mesh>\n' + layout.tail;
  yield enc.encode(pending);
}

// ── Painted 3MF (per-face filaments: #64 and color by height) ──────────────
//
// Slicers store per-face filament assignments as a TriangleSelector state
// string per triangle: `paint_color` (Bambu Studio, OrcaSlicer) and
// `slic3rpe:mmu_segmentation` (PrusaSlicer), same encoding (paintStateCode
// in colorBands.js). Faces without the attribute keep the object's extruder 1.
//
// Package layout taken from PR #121 (birnam), which tested it against Bambu
// Studio, OrcaSlicer, Snapmaker Orca and PrusaSlicer: a single-file 3MF with
// only paint attributes loads in PrusaSlicer but Bambu-family slicers treat a
// foreign 3MF as "geometry only" and drop the paint. They keep it when the
// package looks like their own project: root model with the
// BambuStudio:3mfVersion metadata whose object is a <component> pointing at
// the mesh in 3D/Objects/, plus Metadata/model_settings.config and
// slice_info.config. No project_settings.config — even a minimal one makes
// Bambu/Orca fabricate broken presets on import. This project's own loader
// reads the component layout, so the file still round-trips.
const NS_CORE  = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const NS_BAMBU = 'http://schemas.bambulab.com/package/2021';
const NS_PROD  = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const NS_SLIC3R = 'http://schemas.slic3r.org/3mf/2017/06';
// Label L paints filament L + 1; label 0 keeps the object's extruder 1.
const PAINT_ATTR = Array.from({ length: MAX_FILAMENTS }, (_, l) => {
  if (l === 0) return '';
  const code = paintStateCode(l + 1);
  return ` paint_color="${code}" slic3rpe:mmu_segmentation="${code}"`;
});

function uuid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : '00000000-0000-4000-8000-000000000000';
}

/**
 * Where a painted model stands on the plate. A project file is placed exactly
 * where its build item says (no auto-centring like for a plain mesh), and the
 * slicers' plate starts at its front-left corner: a model left around the
 * coordinate origin would hang over that corner, half below the bed. The
 * mesh keeps its own coordinates (parts exported separately still fit
 * together); only the build item moves it: its bottom onto the bed, its
 * middle to the middle of a 256 mm plate — or, when it is wider than that,
 * as far as it needs to start at the plate's corner.
 */
export function plateTransform(vertices) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
  }
  if (!(maxX >= minX)) return '1 0 0 0 1 0 0 0 1 0 0 0';
  const PLATE = 256;
  const tx = Math.max(PLATE / 2, (maxX - minX) / 2) - (minX + maxX) / 2;
  const ty = Math.max(PLATE / 2, (maxY - minY) / 2) - (minY + maxY) / 2;
  const f = (v) => String(+v.toFixed(4));
  return `1 0 0 0 1 0 0 0 1 ${f(tx)} ${f(ty)} ${f(-minZ)}`;
}

function paintedPackage(vertices, indices, faceLabels) {
  const MESH_ID = 1, ROOT_ID = 2;
  const name = 'Textured';

  const meshLayout = {
    head: '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" ` +
      `xmlns:BambuStudio="${NS_BAMBU}" xmlns:slic3rpe="${NS_SLIC3R}" ` +
      `xmlns:p="${NS_PROD}" requiredextensions="p">\n` +
      `<resources>\n<object id="${MESH_ID}" p:UUID="${uuid()}" type="model">\n`,
    tail: '</object>\n</resources>\n<build/>\n</model>\n',
    triAttr: (t) => {
      const attr = PAINT_ATTR[faceLabels[t]];
      if (attr === undefined) throw new Error(`3MF export: filament ${faceLabels[t] + 1} exceeds ${MAX_FILAMENTS}`);
      return attr;
    },
  };

  const rootModelXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" ` +
    `xmlns:BambuStudio="${NS_BAMBU}" xmlns:p="${NS_PROD}" requiredextensions="p">\n` +
    '<metadata name="Application">BumpMesh</metadata>\n' +
    '<metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
    '<resources>\n' +
    `<object id="${ROOT_ID}" p:UUID="${uuid()}" type="model">\n<components>\n` +
    `<component p:path="/3D/Objects/Object_1.model" objectid="${MESH_ID}" ` +
    `p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n` +
    '</components>\n</object>\n</resources>\n' +
    `<build p:UUID="${uuid()}">\n` +
    `<item objectid="${ROOT_ID}" p:UUID="${uuid()}" transform="${plateTransform(vertices)}" printable="1"/>\n` +
    '</build>\n</model>\n';

  const modelSettingsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
    `<object id="${ROOT_ID}">\n` +
    `<metadata key="name" value="${name}"/>\n` +
    '<metadata key="extruder" value="1"/>\n' +
    `<part id="${MESH_ID}" subtype="normal_part">\n` +
    `<metadata key="name" value="${name}"/>\n` +
    '<metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n' +
    '</part>\n</object>\n' +
    '<plate>\n<metadata key="plater_id" value="1"/>\n' +
    '<metadata key="plater_name" value=""/>\n<metadata key="locked" value="false"/>\n' +
    `<model_instance>\n<metadata key="object_id" value="${ROOT_ID}"/>\n` +
    '<metadata key="instance_id" value="0"/>\n<metadata key="identify_id" value="1"/>\n' +
    '</model_instance>\n</plate>\n' +
    `<assemble>\n<assemble_item object_id="${ROOT_ID}" instance_id="0" ` +
    'transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0"/>\n</assemble>\n</config>\n';

  const sliceInfoXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n<header>\n' +
    '<header_item key="X-BBL-Client-Type" value="slicer"/>\n' +
    '<header_item key="X-BBL-Client-Version" value=""/>\n' +
    '</header>\n</config>\n';

  // Every OPC part needs a resolvable content type; PrusaSlicer's reader
  // rejects the package if the Metadata/*.config parts have none.
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '<Default Extension="config" ContentType="application/octet-stream"/>\n' +
    '</Types>\n';

  const rel = (target) =>
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    `<Relationship Id="rel-1" Target="${target}" ` +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  return [
    ['[Content_Types].xml', [strToU8(contentTypesXml)]],
    ['_rels/.rels', [strToU8(rel('/3D/3dmodel.model'))]],
    ['3D/3dmodel.model', [strToU8(rootModelXml)]],
    ['3D/_rels/3dmodel.model.rels', [strToU8(rel('/3D/Objects/Object_1.model'))]],
    ['3D/Objects/Object_1.model', modelChunks(vertices, indices, meshLayout)],
    ['Metadata/model_settings.config', [strToU8(modelSettingsXml)]],
    ['Metadata/slice_info.config', [strToU8(sliceInfoXml)]],
  ];
}
