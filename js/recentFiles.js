/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Recently opened models and projects for File ▸ Recent. A browser page cannot
// reopen a file by its path, so the file's bytes are kept in IndexedDB. Like
// uploaded textures (customTextures.js) they stay on this device.

const DB_NAME = 'bumpmesh-recent';
const DB_VERSION = 1;
const STORE = 'files';
export const RECENT_MAX = 8;
export const RECENT_MAX_BYTES = 64 * 1024 * 1024;   // bigger files are opened but not remembered

let _dbPromise = null;

function _db() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(err => { _dbPromise = null; throw err; });
  }
  return _dbPromise;
}

function _tx(mode, fn) {
  return _db().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store, r => { result = r; })).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

/** Entries without their bytes, newest first: { name, kind, size, time }. */
export async function listRecent() {
  try {
    const all = await _tx('readonly', (store, done) => {
      const req = store.getAll();
      req.onsuccess = () => done(req.result || []);
    });
    return all
      .sort((a, b) => b.time - a.time)
      .map(({ name, kind, size, time }) => ({ name, kind, size, time }));
  } catch {
    return [];
  }
}

/** Remember a file the user opened. Same name replaces the older entry; the oldest beyond RECENT_MAX are dropped. */
export async function addRecent(file, kind) {
  if (!file || file.size > RECENT_MAX_BYTES) return false;
  try {
    const blob = file.slice(0, file.size, file.type || 'application/octet-stream');
    await _tx('readwrite', (store) => {
      store.put({ name: file.name, kind, size: file.size, time: Date.now(), blob });
      const req = store.getAll();
      req.onsuccess = () => {
        const all = (req.result || []).sort((a, b) => b.time - a.time);
        for (const old of all.slice(RECENT_MAX)) store.delete(old.name);
      };
    });
    return true;
  } catch {
    return false;
  }
}

/** The stored file as a File, or null when it is gone. */
export async function getRecent(name) {
  try {
    const rec = await _tx('readonly', (store, done) => {
      const req = store.get(name);
      req.onsuccess = () => done(req.result || null);
    });
    return rec ? new File([rec.blob], rec.name, { type: rec.blob.type, lastModified: rec.time }) : null;
  } catch {
    return null;
  }
}

export async function clearRecent() {
  try { await _tx('readwrite', store => { store.clear(); }); } catch { /* nothing stored */ }
}
