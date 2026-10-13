// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.js';
import { readWeatherSummit } from '../ascent/ascent-weather-subject.js';

export function readPeakWeatherSubject(doc, pageUrl) {
    let url;
    try { url = new URL(pageUrl); } catch { return null; }
    const id = Number(url.searchParams.get('pid'));
    if (!isPeakbaggerUrl(url.href) || !/^\/peak\.aspx$/i.test(url.pathname)
        || url.searchParams.getAll('pid').length !== 1 || !/^[1-9]\d*$/.test(url.searchParams.get('pid') || '')
        || !Number.isSafeInteger(id)) return null;
    const headings = doc.querySelectorAll('h1');
    const name = headings.length === 1 ? headings[0].textContent.replace(/\s+/g, ' ').trim() : '';
    if (!name) return null;
    try {
        const summit = readWeatherSummit(doc, { peak: { id, name } }, url.href);
        const nativeMap = doc.getElementById('Gmap');
        // The card owns a row immediately after the map, wherever the native
        // page places it. Mapless pages use the native right table's end.
        const rightTables = [...doc.querySelectorAll('table.gray[align]')]
            .filter(candidate => candidate.getAttribute('align').toLowerCase() === 'right'
                && candidate.parentElement === headings[0].parentElement);
        const table = nativeMap?.closest('table') || (rightTables.length === 1 ? rightTables[0] : null);
        if (!table || !table.tBodies.length || table.contains(headings[0])) return null;
        return { ...summit, name, table };
    } catch { return null; }
}
