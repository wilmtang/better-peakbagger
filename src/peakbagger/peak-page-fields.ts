// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native Peak.aspx fields shared by peak and ascent surfaces. Peakbagger serves
// two layouts: main-database peaks (positive ids) and user-submitted
// Provisional Peaks (negative ids). Accept only the documented variants of
// each field; anything missing or ambiguous stays unavailable.

const clean = (text: string | null | undefined) => (text || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export const PEAK_COORDINATE_LABEL = 'latitude/longitude (wgs84)';

// Provisional Peaks use negative ids; zero and signed zero are never peaks.
export function parsePeakId(text: string | null | undefined): number | null {
    if (!/^-?[1-9]\d*$/.test(text || '')) return null;
    const id = Number(text);
    return Number.isSafeInteger(id) ? id : null;
}

export interface PeakDecimalCoordinate {
    latitude: number;
    longitude: number;
    // Peakbagger's source digits, for URLs that should not round-trip a Number.
    latitudeText: string;
    longitudeText: string;
}

// Main peaks lead with "lat, lon (Dec Deg)" before DMS/UTM lines; Provisional
// Peaks put an unlabelled DMS line first. Parse only the single line that
// Peakbagger explicitly labels as decimal degrees, never the DMS or UTM forms.
export function readPeakDecimalCoordinate(cell: Element | null | undefined): PeakDecimalCoordinate | null {
    if (!cell) return null;
    const copy = cell.cloneNode(true) as Element;
    for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
    const text = copy.textContent || '';
    if ((text.match(/\(Dec Deg\)/gi) || []).length !== 1) return null;
    const line = text.split('\n').map(clean).find(value => /\(Dec Deg\)/i.test(value)) || '';
    const match = /^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\(Dec Deg\)/i.exec(line);
    if (!match) return null;
    const latitude = Number(match[1]), longitude = Number(match[2]);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
        || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
    return { latitude, longitude, latitudeText: match[1], longitudeText: match[2] };
}

const MEASURE = String.raw`[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:meters?|metres?|m|feet|foot|ft)`;
const UNLABELLED_ELEVATION = new RegExp(String.raw`^${MEASURE}\s*,\s*${MEASURE}$`, 'i');

// The elevation value, without its label: "14,406.2 feet, 4391.0 meters".
// Main peaks label it ("<h2>Elevation: …</h2>"). Provisional Peaks place the
// bare pair in the h2 immediately after the page's only h1; accept that form
// only when no labelled heading exists and the whole heading is the pair.
export function readPeakElevationText(doc: Document): string | null {
    const labelled = [...doc.querySelectorAll('h2')].filter(node => /^Elevation:/i.test(clean(node.textContent)));
    if (labelled.length > 1) return null;
    if (labelled.length === 1) return clean(labelled[0].textContent).replace(/^Elevation:\s*/i, '');
    const titles = doc.querySelectorAll('h1');
    const next = titles.length === 1 ? titles[0].nextElementSibling : null;
    const text = next?.tagName === 'H2' ? clean(next.textContent) : '';
    return UNLABELLED_ELEVATION.test(text) ? text : null;
}
