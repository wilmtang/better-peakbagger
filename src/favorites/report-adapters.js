// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { profileId } from './ignored-climbers.js';
import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.js';
const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
export const authorInCell = cell => {
    const links = [...cell.querySelectorAll('a[href]')];
    if (links.length !== 1) return null;
    return profileId(links[0].href, cell.ownerDocument.baseURI);
};
export const selectedReportTable = doc => {
    const candidates = [...doc.querySelectorAll('table.gray')].filter(table => {
        const headers = [...(table.rows[0]?.cells || [])].map(text);
        if (headers.join('|').toLowerCase() !== 'date|climber|type|gps|tr words|link') return false;
        const region = table.parentElement;
        // Only direct section text counts; descendant tables/neighboring
        // photos cannot lend this table a Selected Trip Reports identity.
        const section = [...region.childNodes].filter(node => node !== table && node.nodeName !== 'TABLE')
            .map(node => node.textContent).join(' ');
        return region.tagName === 'TD' && /\bAscent Info\b/i.test(section)
            && /\bSelected Trip Reports\b/i.test(section);
    });
    if (candidates.length !== 1) return null;
    const table = candidates[0];
    const records = [];
    for (const row of [...table.rows].slice(1)) {
        if (row.cells.length !== 6) return null;
        const links = [...row.cells[0].querySelectorAll('a[href]')];
        if (links.length !== 1) return null;
        try {
            const url = new URL(links[0].href, doc.baseURI);
            if (!isPeakbaggerUrl(url.href) || !/^\/climber\/ascent\.aspx$/i.test(url.pathname)
                || !/^\d+$/.test(url.searchParams.get('aid') || '')) return null;
        } catch { return null; }
        records.push({ row, climberId: authorInCell(row.cells[1]) });
    }
    return { table, records };
};

// Validated against a read-only authenticated page on 2026-10-01. The author
// h2 and report h2 are siblings of the same ascent surface. Navigation and
// links inside report prose are deliberately never author candidates.
export const ascentReport = doc => {
    const authors = [...doc.querySelectorAll('h2')].filter(h => /^Climber:\s*/i.test(text(h)));
    const headings = [...doc.querySelectorAll('h2')].filter(h => text(h) === 'Ascent Trip Report');
    if (authors.length !== 1 || headings.length !== 1) return null;
    const cid = authorInCell(authors[0]);
    const cell = headings[0].closest('td');
    const row = cell?.parentElement;
    const table = cell?.closest('table.gray');
    const surface = table?.parentElement.id === 'bpb-ascent-table-split'
        ? table.parentElement.parentElement : table?.parentElement;
    if (!cid || !table || row?.cells.length !== 1 || Number(cell.getAttribute('colspan')) !== 2
        || cell.firstElementChild !== headings[0]
        || !surface.contains(authors[0])
        || cell.querySelector('iframe#Gmap,iframe#MasterMap,form,input,button')) return null;
    const content = text(cell).replace(/^Ascent Trip Report\s*/, '');
    if (!content && !cell.querySelector('img,video,audio,iframe')) return null;
    return { cid, cell, row, heading: headings[0] };
};
