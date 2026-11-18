// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Capture immediately before replacing rows; restore only focus owned by that
// list. Identity wins over sorting, and disappearing rows use a nearby control.
export const listFocusRestorer = (
    list: HTMLElement,
    keyName: string,
    fallback: () => HTMLElement | null | undefined
): () => void => {
    const doc = list.ownerDocument;
    const focused = doc.activeElement as HTMLElement | null;
    const rows = [...list.children] as HTMLElement[];
    const row = rows.find(item => item.contains(focused));
    if (!row || !focused) return () => {};
    const key = row.dataset[keyName];
    const index = rows.indexOf(row);
    return () => {
        if (focused.isConnected || !([doc.body, doc.documentElement] as (Element | null)[]).includes(doc.activeElement)) return;
        const nextRows = [...list.children] as HTMLElement[];
        const next = nextRows.find(item => item.dataset[keyName] === key)
            || nextRows[Math.min(index, nextRows.length - 1)];
        const available = (control: HTMLElement | null | undefined): control is HTMLElement =>
            Boolean(control && !(control as { disabled?: boolean }).disabled && !control.closest('[hidden]'));
        const controls = [...(next?.querySelectorAll<HTMLElement>('a[href], button') || [])].filter(available);
        const equivalent = controls.find(control => focused.dataset.action
            ? control.dataset.action === focused.dataset.action : control.tagName === focused.tagName);
        const target = equivalent || controls[0] || fallback();
        if (available(target)) target.focus({ preventScroll: true });
    };
};
