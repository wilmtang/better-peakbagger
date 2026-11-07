// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settings } from '../settings/settings.js';
import { units } from '../ui/units.js';
import { createPageLifecycle } from '../ui/page-lifecycle.ts';

(() => {
    const stats = document.getElementById('StatsLabel');
    if (!stats) return;
    const columns = [];
    for (const heading of stats.querySelectorAll('th')) {
        const match = /^(Elev|Prom)-(m|ft)$/.exec(heading.textContent.trim());
        if (!match) continue;
        const table = heading.closest('table');
        const source = match[2] === 'm' ? units.METRIC : units.IMPERIAL;
        const cells = [];
        let valid = true;
        for (const row of [...table.rows].slice(heading.parentElement.rowIndex + 1)) {
            const cell = row.cells[heading.cellIndex];
            if (row.cells.length !== heading.parentElement.cells.length || !cell || cell.colSpan !== 1) {
                valid = false;
                break;
            }
            const text = cell.textContent.trim();
            if (/^(?:|—|–|-|\?)$/.test(text)) continue;
            // Native integer readings can include an invisible decimal span.
            // Reject unfamiliar content rather than relabeling an unconverted value.
            if (!/^[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(text)
                || cell.querySelector('a, input, button')) {
                valid = false;
                break;
            }
            const value = Number(text.replaceAll(',', '').replace('−', '-'));
            if (!Number.isFinite(value)) { valid = false; break; }
            cells.push({ cell, original: [...cell.childNodes],
                meters: source === units.METRIC ? value : value / units.FEET_PER_METER });
        }
        if (valid && cells.length) columns.push({ heading, prefix: match[1], source,
            original: [...heading.childNodes], cells, current: source });
    }
    if (!columns.length) return;

    let revision = 0;
    const apply = preference => {
        revision++;
        if (lifecycle.state !== 'active') return;
        for (const column of columns) {
            const target = units.resolveUnits(preference, () => column.source, 'elevation');
            if (target === column.current) continue;
            if (target === column.source) {
                column.heading.replaceChildren(...column.original);
                for (const entry of column.cells) entry.cell.replaceChildren(...entry.original);
            } else {
                column.heading.textContent = `${column.prefix}-${units.symbol('elevation', target)}`;
                for (const entry of column.cells) {
                    // The column heading already supplies the unit.
                    entry.cell.textContent = units.formatElevation(entry.meters, target).split(' ')[0];
                }
            }
            column.current = target;
        }
    };
    const refresh = async () => {
        const started = revision;
        const preference = await settings.get();
        if (started === revision) apply(preference);
    };
    const lifecycle = createPageLifecycle({
        onSuspend: () => { revision++; },
        onResume: () => { void refresh(); },
        onDispose: () => { revision++; unsubscribe(); },
    });
    const unsubscribe = settings.subscribe(apply);
    void refresh();
})();
