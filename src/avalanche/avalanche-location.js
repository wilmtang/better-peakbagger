// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const normalize = value => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const aliases = new Map([
    ['usa', 'united states'], ['us', 'united states'], ['u.s.', 'united states'],
    ['u.s.a.', 'united states'], ['united states of america', 'united states'],
    ['czechia', 'czech republic'], ['slovak republic', 'slovakia'],
    ['uk', 'united kingdom'], ['u.k.', 'united kingdom'],
    ['great britain', 'united kingdom'], ['scotland', 'united kingdom'],
    ['svalbard', 'norway'], ['svalbard and jan mayen', 'norway'],
]);

// Delimiters are evidence of separate native values; adjacent names, prose,
// annotations, and substring matches are never evidence of country identity.
// Unknown names survive for the resolver to report its own missing coverage.
export function parsePeakNations(text) {
    if (typeof text !== 'string' || text.length > 800) return [];
    const parts = text.split(/[\n,;/]/).map(normalize);
    if (parts.length > 8 || parts.some(value => !value || value.length > 100)) return [];
    return [...new Set(parts.map(value => aliases.get(value) || value))];
}

export function readPeakNations(peakTable) {
    const rows = [...peakTable.querySelectorAll('tr')].filter(row =>
        row.closest('table') === peakTable
        && normalize(row.cells[0]?.textContent || '') === 'nation');
    if (rows.length !== 1 || rows[0].cells.length !== 2) return [];
    const cell = rows[0].cells[1].cloneNode(true);
    if (cell.querySelector('table')) return [];
    for (const br of cell.querySelectorAll('br')) br.replaceWith('\n');
    return parsePeakNations(cell.textContent);
}
