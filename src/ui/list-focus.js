// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Capture immediately before replacing rows; restore only focus owned by that
// list. Identity wins over sorting, and disappearing rows use a nearby control.
export const listFocusRestorer = (list, keyName, fallback) => {
    const doc = list.ownerDocument;
    const focused = doc.activeElement;
    const rows = [...list.children];
    const row = rows.find(item => item.contains(focused));
    if (!row) return () => {};
    const key = row.dataset[keyName];
    const index = rows.indexOf(row);
    return () => {
        if (focused.isConnected || ![doc.body, doc.documentElement].includes(doc.activeElement)) return;
        const nextRows = [...list.children];
        const next = nextRows.find(item => item.dataset[keyName] === key)
            || nextRows[Math.min(index, nextRows.length - 1)];
        const available = control => control && !control.disabled && !control.closest('[hidden]');
        const controls = [...(next?.querySelectorAll('a[href], button') || [])].filter(available);
        const equivalent = controls.find(control => focused.dataset.action
            ? control.dataset.action === focused.dataset.action : control.tagName === focused.tagName);
        const target = equivalent || controls[0] || fallback();
        if (available(target)) target.focus({ preventScroll: true });
    };
};

