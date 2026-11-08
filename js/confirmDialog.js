/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { t } from './i18n.js';

/**
 * In-app yes/no dialog. window.confirm is unreliable (embedded browsers drop
 * it and answer "cancel"), so questions that guard an action use this.
 * Resolves true for OK, false for Cancel, Escape or a click beside it.
 */
export function confirmDialog(message, okLabel = t('dialog.ok')) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'license-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const box = document.createElement('div');
    box.className = 'license-modal confirm-modal';
    const p = document.createElement('p');
    p.className = 'confirm-text';
    p.textContent = message;
    const row = document.createElement('div');
    row.className = 'confirm-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'scale-reset-btn confirm-cancel'; cancel.textContent = t('dialog.cancel');
    const ok = document.createElement('button');
    ok.type = 'button'; ok.className = 'export-go-btn confirm-ok'; ok.textContent = okLabel;
    row.append(cancel, ok);
    box.append(p, row);
    overlay.append(box);
    document.body.append(overlay);
    const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
    ok.focus();
  });
}
