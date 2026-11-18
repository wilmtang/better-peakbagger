// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.ts';
import { parsePeakId } from '../peakbagger/peak-page-fields.ts';
import { readWeatherSummit, type WeatherSummit } from '../ascent/ascent-weather-subject.ts';

export interface PeakWeatherSubject extends WeatherSummit {
    name: string;
    table: HTMLTableElement;
}

// Accepts main-database and Provisional Peak pages alike: both carry the same
// native coordinate row and map table, and are identified by a nonzero pid.
export function readPeakWeatherSubject(doc: Document, pageUrl: string): PeakWeatherSubject | null {
    let url;
    try { url = new URL(pageUrl); } catch { return null; }
    const id = parsePeakId(url.searchParams.get('pid'));
    if (!isPeakbaggerUrl(url.href) || !/^\/peak\.aspx$/i.test(url.pathname)
        || url.searchParams.getAll('pid').length !== 1 || id === null) return null;
    const headings = doc.querySelectorAll('h1');
    const name = headings.length === 1 ? (headings[0].textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (!name) return null;
    try {
        const summit = readWeatherSummit(doc, { peak: { id, name } }, url.href);
        const nativeMap = doc.getElementById('Gmap');
        // The card owns a row immediately after the map, wherever the native
        // page places it. Mapless pages use the native right table's end.
        const rightTables = [...doc.querySelectorAll<HTMLTableElement>('table.gray[align]')]
            .filter(candidate => candidate.getAttribute('align')!.toLowerCase() === 'right'
                && candidate.parentElement === headings[0].parentElement);
        const table = nativeMap?.closest('table') || (rightTables.length === 1 ? rightTables[0] : null);
        if (!table || !table.tBodies.length || table.contains(headings[0])) return null;
        return { ...summit, name, table };
    } catch { return null; }
}
