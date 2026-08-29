// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — resizable saved-ascent table split.
//
// Peakbagger's legacy ascent.aspx markup floats the trip-report and summary
// tables at hard-coded 49% / 50% widths. A long report can therefore be
// squeezed beside a mostly empty summary, and the floats can wrap even though
// their declared percentages appear to fit. This module recognizes that exact
// pair, moves it into one grid, and owns only the split between the two tables.
// The preference is harmless per-page UI state and follows the ascent-filter
// precedent by living in the Peakbagger origin's localStorage.

import { dom as Dom } from '../ui/dom.js';

const STORAGE_KEY = 'pbAscentTableSplit.v1';
const DEFAULT_LEFT_PERCENT = 50;
const MIN_LEFT_PERCENT = 25;
const MAX_LEFT_PERCENT = 75;
const HANDLE_WIDTH = 13;

const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
const clampPercent = value => {
    const number = Number(value);
    return Number.isFinite(number)
        ? Math.min(MAX_LEFT_PERCENT, Math.max(MIN_LEFT_PERCENT, number))
        : DEFAULT_LEFT_PERCENT;
};

const widthPercent = table => {
    const match = String(table?.getAttribute('width') || '').match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
    return match ? Number(match[1]) : null;
};

const defaultPercentFor = (left, right) => {
    const leftWidth = widthPercent(left);
    const rightWidth = widthPercent(right);
    const total = leftWidth + rightWidth;
    return Number.isFinite(leftWidth) && Number.isFinite(rightWidth) && total > 0
        ? clampPercent(leftWidth / total * 100)
        : DEFAULT_LEFT_PERCENT;
};

const readSavedPercent = (storage, fallback) => {
    try {
        const saved = JSON.parse(storage.getItem(STORAGE_KEY));
        const value = typeof saved === 'number' ? saved : saved?.leftPercent;
        return Number.isFinite(value) ? clampPercent(value) : fallback;
    } catch { return fallback; }
};

const savePercent = (storage, leftPercent) => {
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ leftPercent })); }
    catch { /* Page storage can be unavailable in hardened browsing modes. */ }
};

const findTablePair = doc => {
    const tables = Array.from(doc.querySelectorAll('table.gray'));
    // HTML table text joins adjacent cells without whitespace (for example,
    // "Ascent Trip ReportDate:"). Search the normalized phrase without a
    // trailing word boundary so the real legacy markup remains detectable.
    const left = tables.find(table => /ascent trip report/i.test(normalize(table.textContent)));
    if (!left) return null;
    const right = left.nextElementSibling;
    if (!right?.matches('table.gray')
            || !/summary total data/i.test(normalize(right.textContent))) return null;
    return { left, right };
};

export const mountAscentTableSplit = ({
    doc = document,
    storage,
} = {}) => {
    if (doc.getElementById('bpb-ascent-table-split')) return null;
    const pair = findTablePair(doc);
    if (!pair) return null;

    const { left, right } = pair;
    const wrapper = Dom.element('div', {
        id: 'bpb-ascent-table-split',
    });
    const handle = Dom.element('button', {
        id: 'bpb-ascent-table-resize-handle',
        type: 'button',
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-valuemin': String(MIN_LEFT_PERCENT),
        'aria-valuemax': String(MAX_LEFT_PERCENT),
        'aria-keyshortcuts': 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End',
        title: 'Drag to resize the trip report and summary. Double-click to reset.',
    });
    handle.setAttribute('aria-label', 'Resize trip report and summary tables');

    left.before(wrapper);
    left.classList.add('bpb-ascent-table-split__table', 'bpb-ascent-table-split__report');
    right.classList.add('bpb-ascent-table-split__table', 'bpb-ascent-table-split__summary');
    wrapper.append(left, handle, right);

    const storageArea = (() => {
        if (storage) return storage;
        try { return globalThis.localStorage; }
        catch { return null; }
    })();
    const initialPercent = defaultPercentFor(left, right);
    let leftPercent = readSavedPercent(storageArea, initialPercent);
    let drag = null;

    const applyPercent = value => {
        leftPercent = clampPercent(value);
        const rounded = Math.round(leftPercent);
        wrapper.style.setProperty('--bpb-ascent-report-share', `${leftPercent}fr`);
        wrapper.style.setProperty('--bpb-ascent-summary-share', `${100 - leftPercent}fr`);
        wrapper.dataset.leftPercent = String(leftPercent);
        handle.setAttribute('aria-valuenow', String(rounded));
        handle.setAttribute('aria-valuetext', `Trip report ${rounded}%; summary ${100 - rounded}%`);
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
        doc.documentElement.classList.remove('bpb-ascent-table-split-resizing');
        releasePointer(pointerId);
        if (restore) applyPercent(startPercent);
        if (persist) savePercent(storageArea, leftPercent);
    };

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        const rect = wrapper.getBoundingClientRect();
        const availableWidth = rect.width - HANDLE_WIDTH;
        if (!(availableWidth > 0)) return;
        drag = {
            pointerId: pointerIdOf(event),
            startX: event.clientX,
            startPercent: leftPercent,
            availableWidth,
        };
        doc.documentElement.classList.add('bpb-ascent-table-split-resizing');
        try { handle.setPointerCapture?.(drag.pointerId); }
        catch { /* Pointer capture is an enhancement, not a mount gate. */ }
        event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
        if (!drag || pointerIdOf(event) !== drag.pointerId) return;
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
        savePercent(storageArea, leftPercent);
    });
    handle.addEventListener('dblclick', event => {
        event.preventDefault();
        applyPercent(initialPercent);
        savePercent(storageArea, leftPercent);
    });
    doc.defaultView?.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !drag) return;
        event.preventDefault();
        finishDrag({ restore: true });
    }, true);
    doc.defaultView?.addEventListener('blur', () => finishDrag({ persist: true }));

    applyPercent(leftPercent);
    return {
        wrapper,
        handle,
        left,
        right,
        get leftPercent() { return leftPercent; },
        applyPercent,
    };
};

export const ascentTableSplit = {
    mount: mountAscentTableSplit,
    findTablePair,
    storageKey: STORAGE_KEY,
};
