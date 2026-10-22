// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createColumnResize } from './column-resize.js';

export function mountPeakTableSplit(doc) {
    if (doc.getElementById('bpb-peak-table-split')) return null;
    const right = doc.getElementById('Gmap')?.closest('table');
    const left = right?.previousElementSibling;
    // Match the native adjacent pair, never an outer page table or a table
    // mentioned inside prose. Simplified/no-map pages keep their old layout.
    if (!left?.matches('table') || ![...left.rows].some(row =>
        row.cells[0]?.textContent.trim().toLowerCase() === 'latitude/longitude (wgs84)')) return null;
    const make = (tag, id) => { const node = doc.createElement(tag); node.id = id; return node; };
    const wrapper = make('div', 'bpb-peak-table-split');
    const details = make('div', 'bpb-peak-details-column'), map = make('div', 'bpb-peak-map-column');
    const handle = make('button', 'bpb-peak-table-resize-handle'); handle.type = 'button';
    handle.setAttribute('aria-label', 'Resize peak details and map columns');
    handle.title = 'Drag to resize peak details and map. Double-click to reset.';
    left.before(wrapper); wrapper.append(details, handle, map);
    details.append(left);
    if (typeof map.moveBefore === 'function') map.moveBefore(right, null); else map.append(right);
    left.classList.add('bpb-peak-native-table'); right.classList.add('bpb-peak-native-table');
    const width = node => Number(node.getAttribute('width')?.match(/^(\d+(?:\.\d+)?)%$/)?.[1]);
    const a = width(left), b = width(right), initialPercent = a > 0 && b > 0 ? a / (a + b) * 100 : 50;
    const resize = createColumnResize({ wrapper, handle, storageKey: 'pbPeakTableSplit.v1', initialPercent,
        leftName: 'Peak details', rightName: 'map', leftProperty: '--bpb-peak-details-share', rightProperty: '--bpb-peak-map-share' });
    return { wrapper, handle, details, map, resize };
}
