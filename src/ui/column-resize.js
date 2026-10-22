// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createLayoutMenu } from './layout-menu.js';

// Shared pointer and keyboard behavior; page owners choose columns and storage.
const DEFAULT_LEFT_PERCENT = 50;
const MIN_LEFT_PERCENT = 25;
const MAX_LEFT_PERCENT = 75;
const clampPercent = value => Number.isFinite(Number(value))
    ? Math.min(MAX_LEFT_PERCENT, Math.max(MIN_LEFT_PERCENT, Number(value))) : DEFAULT_LEFT_PERCENT;

const readSavedPercent = (storage, fallback, storageKey) => {
    try {
        const saved = JSON.parse(storage.getItem(storageKey));
        const value = typeof saved === 'number' ? saved : saved?.leftPercent;
        return Number.isFinite(value) ? clampPercent(value) : fallback;
    } catch { return fallback; }
};

const savePercent = (storage, leftPercent, storageKey) => {
    try { storage.setItem(storageKey, JSON.stringify({ leftPercent })); }
    catch { /* Page storage can be unavailable in hardened browsing modes. */ }
};

export function createColumnResize({ wrapper, handle, storage, storageKey, initialPercent = 50,
    leftName, rightName, leftProperty, rightProperty, resizingClass = 'bpb-column-resizing' }) {
    const doc = wrapper.ownerDocument;
    handle.classList.add('bpb-column-resize-handle');
    for (const [key, value] of Object.entries({ role: 'separator', 'aria-orientation': 'vertical',
        'aria-valuemin': '25', 'aria-valuemax': '75',
        'aria-keyshortcuts': 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End' })) handle.setAttribute(key, value);
    const storageArea = (() => {
        if (storage) return storage;
        try { return doc.defaultView.localStorage; }
        catch { return null; }
    })();
    let leftPercent = readSavedPercent(storageArea, initialPercent, storageKey);
    let drag = null, suppressClick = false;
    const menu = createLayoutMenu({ handle, label: 'Column widths', actions: () => [
        { label: `More room for ${leftName.toLowerCase()}`, disabled: leftPercent >= MAX_LEFT_PERCENT, run: () => resizeBy(5) },
        { label: `More room for ${rightName.toLowerCase()}`, disabled: leftPercent <= MIN_LEFT_PERCENT, run: () => resizeBy(-5) },
        { label: 'Reset column widths', run: () => { applyPercent(initialPercent); savePercent(storageArea, leftPercent, storageKey); } },
    ] });
    const resizeBy = delta => { applyPercent(leftPercent + delta); savePercent(storageArea, leftPercent, storageKey); };
    handle.addEventListener('click', event => {
        if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
        suppressClick = false; menu.toggle();
    });

    const applyPercent = value => {
        leftPercent = clampPercent(value);
        const rounded = Math.round(leftPercent);
        wrapper.style.setProperty(leftProperty, `${leftPercent}fr`);
        wrapper.style.setProperty(rightProperty, `${100 - leftPercent}fr`);
        wrapper.dataset.leftPercent = String(leftPercent);
        handle.setAttribute('aria-valuenow', String(rounded));
        handle.setAttribute('aria-valuetext', `${leftName} ${rounded}%; ${rightName} ${100 - rounded}%`);
        return leftPercent;
    };

    const pointerIdOf = event => Number.isInteger(event.pointerId) ? event.pointerId : 1;
    const releasePointer = pointerId => {
        try {
            if (!handle.releasePointerCapture) return;
            if (!handle.hasPointerCapture || handle.hasPointerCapture(pointerId)) {
                handle.releasePointerCapture(pointerId);
            }
        } catch { /* The browser may already have released capture. */ }
    };
    const finishDrag = ({ persist, restore } = {}) => {
        if (!drag) return;
        const { pointerId, startPercent } = drag;
        drag = null;
        doc.documentElement.classList.remove(resizingClass);
        releasePointer(pointerId);
        if (restore) applyPercent(startPercent);
        if (persist) savePercent(storageArea, leftPercent, storageKey);
    };

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        const rect = wrapper.getBoundingClientRect();
        const availableWidth = rect.width - handle.getBoundingClientRect().width;
        if (!(availableWidth > 0)) return;
        menu.close(); suppressClick = false;
        drag = {
            pointerId: pointerIdOf(event),
            startX: event.clientX,
            startPercent: leftPercent,
            availableWidth,
        };
        doc.documentElement.classList.add(resizingClass);
        try { handle.setPointerCapture?.(drag.pointerId); }
        catch { /* Pointer capture is an enhancement, not a mount gate. */ }
        event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
        suppressClick = true;
        applyPercent(drag.startPercent
            + (event.clientX - drag.startX) / drag.availableWidth * 100);
        event.preventDefault();
    });
    handle.addEventListener('pointerup', event => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
        finishDrag({ persist: true });
    });
    handle.addEventListener('pointercancel', event => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
        finishDrag({ persist: true });
    });
    handle.addEventListener('lostpointercapture', event => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
        finishDrag({ persist: true });
    });
    handle.addEventListener('keydown', event => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const step = event.shiftKey ? 5 : 1;
        let next = null;
        if (event.key === 'ArrowLeft') next = leftPercent - step;
        else if (event.key === 'ArrowRight') next = leftPercent + step;
        else if (event.key === 'Home') next = MIN_LEFT_PERCENT;
        else if (event.key === 'End') next = MAX_LEFT_PERCENT;
        if (next === null) return;
        event.preventDefault();
        applyPercent(next);
        savePercent(storageArea, leftPercent, storageKey);
    });
    handle.addEventListener('dblclick', event => {
        event.preventDefault();
        menu.close();
        applyPercent(initialPercent);
        savePercent(storageArea, leftPercent, storageKey);
    });
    doc.defaultView?.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !drag) return;
        event.preventDefault();
        finishDrag({ restore: true });
    }, true);
    doc.defaultView?.addEventListener('blur', () => finishDrag({ persist: true }));

    applyPercent(leftPercent);
    return { get leftPercent() { return leftPercent; }, applyPercent };
}
