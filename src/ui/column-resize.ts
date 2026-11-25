// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createLayoutMenu } from './layout-menu.ts';

// Shared pointer and keyboard behavior; page owners choose columns and storage.
export type ColumnResizeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ColumnResizeOptions {
    wrapper: HTMLElement;
    handle: HTMLElement;
    storage?: ColumnResizeStorage | null;
    storageKey: string;
    initialPercent?: number;
    leftName: string;
    rightName: string;
    leftProperty: string;
    rightProperty: string;
    resizingClass?: string;
}

export interface ColumnResize {
    readonly leftPercent: number;
    applyPercent(value: number): number;
}

interface ColumnResizeDrag {
    pointerId: number;
    startX: number;
    startPercent: number;
    availableWidth: number;
}

const DEFAULT_LEFT_PERCENT = 50;
const MIN_LEFT_PERCENT = 25;
const MAX_LEFT_PERCENT = 75;
const clampPercent = (value: unknown): number => Number.isFinite(Number(value))
    ? Math.min(MAX_LEFT_PERCENT, Math.max(MIN_LEFT_PERCENT, Number(value))) : DEFAULT_LEFT_PERCENT;

const readSavedPercent = (storage: ColumnResizeStorage | null | undefined, fallback: number, storageKey: string): number => {
    try {
        const raw = storage?.getItem(storageKey);
        if (raw == null) return fallback;
        const saved: unknown = JSON.parse(raw);
        const value = typeof saved === 'number'
            ? saved
            : saved && typeof saved === 'object' ? (saved as { leftPercent?: unknown }).leftPercent : undefined;
        return typeof value === 'number' && Number.isFinite(value) ? clampPercent(value) : fallback;
    } catch { return fallback; }
};

const savePercent = (storage: ColumnResizeStorage | null | undefined, leftPercent: number, storageKey: string) => {
    try { storage?.setItem(storageKey, JSON.stringify({ leftPercent })); }
    catch { /* Page storage can be unavailable in hardened browsing modes. */ }
};

export function createColumnResize({
    wrapper,
    handle,
    storage,
    storageKey,
    initialPercent = 50,
    leftName,
    rightName,
    leftProperty,
    rightProperty,
    resizingClass = 'bpb-column-resizing',
}: ColumnResizeOptions): ColumnResize {
    const doc = wrapper.ownerDocument;
    handle.classList.add('bpb-column-resize-handle');
    for (const [key, value] of Object.entries({ role: 'separator', 'aria-orientation': 'vertical',
        'aria-valuemin': '25', 'aria-valuemax': '75',
        'aria-keyshortcuts': 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End' })) handle.setAttribute(key, value);
    const storageArea = (() => {
        if (storage) return storage;
        try { return doc.defaultView?.localStorage ?? null; }
        catch { return null; }
    })();
    let leftPercent = readSavedPercent(storageArea, initialPercent, storageKey);
    let drag: ColumnResizeDrag | null = null, suppressClick = false;
    const menu = createLayoutMenu({ handle, label: 'Column widths', actions: () => [
        { label: `More room for ${leftName.toLowerCase()}`, disabled: leftPercent >= MAX_LEFT_PERCENT, run: () => resizeBy(5) },
        { label: `More room for ${rightName.toLowerCase()}`, disabled: leftPercent <= MIN_LEFT_PERCENT, run: () => resizeBy(-5) },
        { label: 'Reset column widths', run: () => { applyPercent(initialPercent); savePercent(storageArea, leftPercent, storageKey); } },
    ] });
    const resizeBy = (delta: number) => { applyPercent(leftPercent + delta); savePercent(storageArea, leftPercent, storageKey); };
    handle.addEventListener('click', event => {
        if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
        suppressClick = false; menu.toggle();
    });

    const applyPercent = (value: number): number => {
        leftPercent = clampPercent(value);
        const rounded = Math.round(leftPercent);
        wrapper.style.setProperty(leftProperty, `${leftPercent}fr`);
        wrapper.style.setProperty(rightProperty, `${100 - leftPercent}fr`);
        wrapper.dataset.leftPercent = String(leftPercent);
        handle.setAttribute('aria-valuenow', String(rounded));
        handle.setAttribute('aria-valuetext', `${leftName} ${rounded}%; ${rightName} ${100 - rounded}%`);
        return leftPercent;
    };

    const pointerIdOf = (event: PointerEvent) => Number.isInteger(event.pointerId) ? event.pointerId : 1;
    const releasePointer = (pointerId: number) => {
        try {
            if (!handle.releasePointerCapture) return;
            if (!handle.hasPointerCapture || handle.hasPointerCapture(pointerId)) {
                handle.releasePointerCapture(pointerId);
            }
        } catch { /* The browser may already have released capture. */ }
    };
    const finishDrag = ({ persist = false, restore = false }: { persist?: boolean; restore?: boolean } = {}) => {
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
    const pointerTarget: EventTarget = doc.defaultView || handle;
    const onPointerMove = (event: PointerEvent) => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
        suppressClick = true;
        applyPercent(drag.startPercent
            + (event.clientX - drag.startX) / drag.availableWidth * 100);
        event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent) => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
        finishDrag({ persist: true });
    };
    const onPointerCancel = (event: PointerEvent) => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
        finishDrag({ restore: true });
    };
    pointerTarget.addEventListener('pointermove', onPointerMove as EventListener);
    pointerTarget.addEventListener('pointerup', onPointerUp as EventListener);
    pointerTarget.addEventListener('pointercancel', onPointerCancel as EventListener);
    handle.addEventListener('lostpointercapture', event => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
        finishDrag({ restore: true });
    });
    handle.addEventListener('keydown', event => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const step = event.shiftKey ? 5 : 1;
        let next: number | null = null;
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
    doc.defaultView?.addEventListener('blur', () => finishDrag({ restore: true }));

    applyPercent(leftPercent);
    return { get leftPercent() { return leftPercent; }, applyPercent };
}
