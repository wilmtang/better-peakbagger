// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// A compact single-pointer alternative to dragging, with native buttons.
export function createLayoutMenu({ handle, label, actions }) {
    const doc = handle.ownerDocument, view = doc.defaultView;
    const menu = doc.createElement('div'); menu.className = 'bpb-layout-menu'; menu.hidden = true;
    menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', label);
    const expanded = value => { if (handle.getAttribute('role') !== 'separator') handle.setAttribute('aria-expanded', String(value)); };
    expanded(false);
    doc.body.append(menu);
    const close = () => { menu.hidden = true; expanded(false); };
    const open = () => {
        menu.replaceChildren();
        for (const action of actions()) {
            const button = doc.createElement('button'); button.type = 'button'; button.textContent = action.label;
            button.disabled = action.disabled === true;
            button.addEventListener('click', () => { close(); action.run(); handle.focus({ preventScroll: true }); });
            menu.append(button);
        }
        menu.hidden = false; expanded(true);
        const r = handle.getBoundingClientRect(), m = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(r.right - m.width, view.innerWidth - m.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(Math.max(8, r.top) + Math.min(r.height, 44), view.innerHeight - m.height - 8))}px`;
        menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    };
    const outside = event => { if (!menu.contains(event.target) && !handle.contains(event.target)) close(); };
    const key = event => {
        if (menu.hidden) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); handle.focus({ preventScroll: true }); }
        else if (event.key === 'Tab') {
            const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
            if (doc.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1))) {
                close(); handle.focus({ preventScroll: true });
            }
        }
    };
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', key, true);
    view.addEventListener('resize', close); view.addEventListener('blur', close); doc.addEventListener('scroll', close, true);
    return { close, toggle: () => menu.hidden ? open() : close(), dispose() {
        close(); menu.remove(); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true);
        view.removeEventListener('resize', close); view.removeEventListener('blur', close); doc.removeEventListener('scroll', close, true);
    } };
}
