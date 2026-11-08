/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Header menu bar (File, Info). Click a title to open its menu; while one is
// open, hovering another title switches to it, as in desktop apps. Picking an
// item, clicking outside or Escape closes it. Controls inside a menu (the
// language select, the theme buttons) leave it open.

export function initMenuBar(root, { onOpen } = {}) {
  const menus = [...root.querySelectorAll('.menu')];
  let openMenu = null;

  const btnOf = m => m.querySelector('.menu-btn');

  function close() {
    if (!openMenu) return;
    openMenu.classList.remove('open');
    btnOf(openMenu).setAttribute('aria-expanded', 'false');
    openMenu = null;
  }

  function open(menu) {
    if (openMenu === menu) return;
    close();
    openMenu = menu;
    menu.classList.add('open');
    btnOf(menu).setAttribute('aria-expanded', 'true');
    onOpen?.(menu.id);
  }

  for (const menu of menus) {
    const btn = btnOf(menu);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu === menu) close(); else open(menu);
    });
    btn.addEventListener('mouseenter', () => { if (openMenu && openMenu !== menu) open(menu); });
    // Capture phase: some items stop propagation in their own handlers.
    menu.querySelector('.menu-pop').addEventListener('click', (e) => {
      if (e.target.closest('.menu-item')) close();
    }, true);
  }

  // Links to other sites always open in a new tab, also in embedded browsers
  // that would otherwise load target="_blank" in the app's own tab.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[target="_blank"][href^="http"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    window.open(a.href, '_blank', 'noopener');
  });

  document.addEventListener('pointerdown', (e) => {
    if (openMenu && !openMenu.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) { const b = btnOf(openMenu); close(); b.focus(); }
  });

  return { close, open: id => { const m = menus.find(x => x.id === id); if (m) open(m); } };
}
