/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Left tool rail. Each icon is one step of the workflow (model, texture,
// projection, height, mask, colors, export); the settings panel shows only the
// sections tagged with that step's data-step. The export buttons sit in the
// panel footer and stay visible on every step. Clicking the active step again
// folds the panel away, like the collapse tab does.

const STORAGE_KEY = 'stlt-active-step';
const DEFAULT_STEP = 'texture';

export function initToolRail({ gallery, onLeave, onShow } = {}) {
  const rail = document.getElementById('tool-rail');
  const panel = document.getElementById('settings-panel');
  const main = rail.parentElement;
  const toggle = document.getElementById('sidebar-toggle');
  const buttons = [...rail.querySelectorAll('.rail-btn[data-step]')];
  const steps = new Set(buttons.map(b => b.dataset.step));
  let current = null;

  function setCollapsed(collapsed) {
    main.classList.toggle('sidebar-collapsed', collapsed);
    toggle?.setAttribute('aria-expanded', String(!collapsed));
  }

  function show(step) {
    if (!steps.has(step)) step = DEFAULT_STEP;
    if (current && current !== step) onLeave?.(current);
    current = step;
    panel.dataset.step = step;
    for (const sec of panel.querySelectorAll('[data-step]')) {
      sec.classList.toggle('step-off', sec.dataset.step !== step);
    }
    for (const b of buttons) {
      const on = b.dataset.step === step;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    panel.scrollTop = 0;
    onShow?.(step);
    try { localStorage.setItem(STORAGE_KEY, step); } catch { /* private mode */ }
  }

  for (const b of buttons) {
    b.addEventListener('click', () => {
      const step = b.dataset.step;
      if (gallery?.isOpen()) { gallery.close(); setCollapsed(false); show(step); return; }
      const collapsed = main.classList.contains('sidebar-collapsed');
      if (step === current && !collapsed) { setCollapsed(true); return; }
      if (collapsed) setCollapsed(false);
      show(step);
    });
  }

  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  show(saved || DEFAULT_STEP);

  return { show, get current() { return current; } };
}
