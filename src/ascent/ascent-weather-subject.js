// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.js';

const clean = text => (text || '').replace(/\s+/g, ' ').trim();
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function strictWeatherDate(text) {
    const value = clean(text).replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i, '');
    let iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    const match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
    if (!iso && match) {
        const month = MONTHS.findIndex(name => match[1].toLowerCase() === name || match[1].toLowerCase() === name.slice(0, 3));
        if (month >= 0) iso = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    }
    if (!iso) return null;
    const ms = Date.parse(`${iso}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso ? iso : null;
}

const ownRows = table => [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table);
const label = row => clean(row.cells[0]?.textContent).replace(/:$/, '').toLowerCase();
const peakIdentity = (link, base) => {
    try {
        const url = new URL(link.getAttribute('href'), base);
        if (!isPeakbaggerUrl(url.href) || !/^\/peak\.aspx$/i.test(url.pathname)
            || !/^\d+$/.test(url.searchParams.get('pid') || '')) return null;
        const id = Number(url.searchParams.get('pid'));
        return Number.isSafeInteger(id) && id > 0 ? { id, name: clean(link.textContent), url: url.href } : null;
    } catch { return null; }
};

// Unlike backup's best-effort reader, this never scans arbitrary report text
// for dates or chooses the first peak link in the document.
export function readWeatherSubject(doc, pageUrl) {
    const unavailable = reason => ({ reason });
    let url;
    try { url = new URL(pageUrl); } catch { return unavailable('The saved ascent could not be identified.'); }
    if (!isPeakbaggerUrl(url.href) || !/^\/climber\/ascent\.aspx$/i.test(url.pathname)
        || url.searchParams.getAll('aid').length !== 1 || !/^[1-9]\d*$/.test(url.searchParams.get('aid') || '')) {
        return unavailable('The saved ascent could not be identified.');
    }
    const rows = [...doc.querySelectorAll('tr')].filter(row => row.cells.length === 2
        && /^(ascent )?date$/.test(label(row)) && !row.closest('#reportcell, .bpb-re-rendered'));
    if (rows.length !== 1) return unavailable('A complete, unambiguous ascent date is needed for weather.');
    const [dateRow] = rows;
    const date = strictWeatherDate(dateRow.cells[1].textContent);
    if (!date) return unavailable('A complete, valid ascent date is needed for weather.');
    const table = dateRow.closest('table');
    const peakRows = ownRows(table).filter(row => /^(peak|mountain)$/.test(label(row)));
    const links = [...doc.querySelectorAll('h1 a[href]'), ...peakRows.flatMap(row => [...row.cells[1].querySelectorAll('a[href]')])];
    const identities = links.map(link => peakIdentity(link, url)).filter(Boolean);
    if (!identities.length || new Set(identities.map(peak => peak.id)).size !== 1 || !identities[0].name) {
        return unavailable('The ascent’s summit could not be identified safely.');
    }
    return { date, peak: identities[0], table, dateText: clean(dateRow.cells[1].textContent) };
}

export function readWeatherSummit(doc, subject, responseUrl) {
    const url = new URL(responseUrl);
    if (!isPeakbaggerUrl(url.href) || !/^\/peak\.aspx$/i.test(url.pathname)
        || Number(url.searchParams.get('pid')) !== subject.peak.id) throw new Error('The summit page did not match this ascent.');
    const heading = clean(doc.querySelector('h1')?.textContent);
    const expected = subject.peak.name.toLowerCase();
    if (heading.toLowerCase() !== expected && !heading.toLowerCase().startsWith(`${expected},`)) {
        throw new Error('The summit page did not match this ascent.');
    }
    const rows = [...doc.querySelectorAll('tr')].filter(row => row.cells.length === 2 && label(row) === 'latitude/longitude (wgs84)');
    if (rows.length !== 1) throw new Error('The summit coordinates are unavailable.');
    const coordinate = /^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\(Dec Deg\)/i.exec(clean(rows[0].cells[1].textContent));
    const latitude = Number(coordinate?.[1]), longitude = Number(coordinate?.[2]);
    if (!coordinate || !Number.isFinite(latitude) || Math.abs(latitude) > 90
        || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error('The summit coordinates are unavailable.');
    const elevations = [...doc.querySelectorAll('h2')].filter(element => /^Elevation:/i.test(clean(element.textContent)));
    const match = elevations.length === 1 ? /([+-]?[\d,]+(?:\.\d+)?)\s*(?:meters|m)\b/i.exec(clean(elevations[0].textContent).replaceAll('−', '-')) : null;
    const meters = match ? Number(match[1].replaceAll(',', '')) : null;
    const elevation = Number.isFinite(meters) && meters >= -500 && meters <= 9000 ? meters : null;
    return { latitude, longitude, elevation };
}
