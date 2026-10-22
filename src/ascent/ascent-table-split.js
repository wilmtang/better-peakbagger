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
import { createColumnResize } from '../ui/column-resize.js';

const STORAGE_KEY = 'pbAscentTableSplit.v1';
const DEFAULT_LEFT_PERCENT = 50;
const MIN_LEFT_PERCENT = 25;
const MAX_LEFT_PERCENT = 75;

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

const findTablePair = doc => {
    const tables = Array.from(doc.querySelectorAll('table.gray'));
    // HTML table text joins adjacent cells without whitespace (for example,
    // "Ascent Trip ReportDate:"). Search the normalized phrase without a
    // trailing word boundary so the real legacy markup remains detectable.
    const left = tables.find(table => {
        if (/ascent trip report/i.test(normalize(table.textContent))) return true;
        // Ascents without report prose omit that heading. Recognize their
        // own metadata rows, not matching words inside prose or nested tables.
        const labels = new Set(Array.from(table.rows, row =>
            normalize(row.cells[0]?.textContent).toLowerCase()));
        return ['date:', 'ascent type:', 'peak:'].every(label => labels.has(label));
    });
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
    const reportColumn = Dom.element('div', {
        id: 'bpb-ascent-report-column',
        class: 'bpb-ascent-table-split__report-column',
    });
    const summaryColumn = Dom.element('div', {
        id: 'bpb-ascent-summary-column',
        class: 'bpb-ascent-table-split__summary-column',
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
    wrapper.append(reportColumn, handle, summaryColumn);
    reportColumn.append(left);
    summaryColumn.append(right);

    // CSS height:auto releases fixed heights while shrinking. Preserve an
    // authored ratio, or a height-only size cap, without waiting for image load
    // or rewriting the report's width/height attributes.
    for (const image of wrapper.querySelectorAll('img[height]')) {
        const height = Number(image.getAttribute('height'));
        if (!Number.isFinite(height) || height <= 0) continue;
        const width = Number(image.getAttribute('width'));
        if (Number.isFinite(width) && width > 0) {
            image.style.setProperty('--bpb-ascent-image-aspect-ratio', `${width} / ${height}`);
        } else if (!image.hasAttribute('width')) {
            image.style.setProperty('--bpb-ascent-image-max-height', `${height}px`);
        }
    }

    const resize = createColumnResize({ wrapper, handle, storage, storageKey: STORAGE_KEY,
        initialPercent: defaultPercentFor(left, right), leftName: 'Trip report', rightName: 'summary',
        leftProperty: '--bpb-ascent-report-share', rightProperty: '--bpb-ascent-summary-share',
        resizingClass: 'bpb-ascent-table-split-resizing' });

    return {
        wrapper,
        handle,
        left,
        right,
        reportColumn,
        summaryColumn,
        get leftPercent() { return resize.leftPercent; },
        applyPercent: resize.applyPercent,
    };
};

export const ascentTableSplit = {
    mount: mountAscentTableSplit,
    storageKey: STORAGE_KEY,
};
