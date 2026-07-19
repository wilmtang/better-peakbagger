// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — saved ascent page reader (ascent.aspx).
//
// Reads the fields the GitHub backup surface needs from a saved ascent page:
// the ascent id (the definitive identity, and the only source of it for a newly
// created ascent), whether the signed-in climber owns the ascent (an edit link
// to this aid — the ownership gate fails closed), the peak the ascent belongs
// to, the stored GPS-track download link, and, as a fallback for when no
// save-time snapshot exists, the rendered trip report converted to Markdown
// through the shared allowlisted AST.
//
// The reliable fields (aid, ownership, peak id/name, GPX link) come from stable
// URL shapes; the date, elevation, and report are best-effort and marked as such
// — they are cross-checked against, and usually superseded by, the save-time
// snapshot in the background. Selectors here are validated against a masked
// ascent.aspx fixture and confirmed on live Peakbagger before release.

import { reportMarkup as Markup } from './report-markup.js';

    const clean = value => (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim();

    const paramFrom = (href, name) => {
        try { return new URL(href, 'https://peakbagger.com/').searchParams.get(name); }
        catch { return null; }
    };

    // The first link whose path (case-insensitively) matches page and that
    // carries the wanted query id.
    const findLink = (doc, page, idParam) => {
        for (const a of doc.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (new RegExp(`(^|/)${page}\\?`, 'i').test(href) && paramFrom(href, idParam)) return a;
        }
        return null;
    };

    // Ownership: the signed-in climber sees an edit link for THIS ascent. No such
    // link (a visitor viewing someone else's ascent) means no affordance.
    const ownsAscent = (doc, ascentId) => {
        if (ascentId == null) return false;
        for (const a of doc.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (/ascentedit\.aspx\?/i.test(href) && String(paramFrom(href, 'aid')) === String(ascentId)) return true;
        }
        return false;
    };

    const readPeak = doc => {
        const link = findLink(doc, 'peak\\.aspx', 'pid');
        if (!link) return { id: null, name: '' };
        const id = Number(paramFrom(link.getAttribute('href'), 'pid'));
        return { id: Number.isFinite(id) ? id : null, name: clean(link.textContent) };
    };

    const gpxUrl = doc => {
        for (const a of doc.querySelectorAll('a[href]')) {
            if (/Download this GPS track/i.test(a.textContent || '')) return a.href || a.getAttribute('href');
        }
        return null;
    };

    // Best-effort trip-report Markdown for the no-snapshot fallback. The report
    // is inside an element tagged data-bpb-report by the analyzer, or the cell
    // following a "Trip Report" heading; convert its DOM through the shared AST.
    // Returns '' when the report container cannot be located.
    const reportMarkdown = doc => {
        let container = doc.querySelector('[data-bpb-report]');
        if (!container) {
            const marker = Array.from(doc.querySelectorAll('b, strong, h1, h2, h3, td'))
                .find(node => /trip report/i.test(node.textContent || '') && (node.textContent || '').length < 40);
            if (marker) {
                const cell = marker.closest('td');
                container = cell ? (cell.nextElementSibling || cell) : marker.parentElement;
            }
        }
        if (!container) return '';
        try { return Markup.astToMarkdown(Markup.domToAst(container)); }
        catch { return ''; }
    };

    // Peakbagger renders the date as "Ascent Date: Jul 12, 2026" (day/month may
    // be absent on a partial date). Parse a "Mon D, YYYY" or bare-year string to
    // ISO; '' when nothing parseable is found.
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const parseDateText = text => {
        const value = clean(text);
        const m = value.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
        if (m) {
            const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
            if (month >= 0) return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        }
        const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
        if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
        const yearOnly = value.match(/\b(\d{4})\b/);
        return yearOnly ? `${yearOnly[1]}-00-00` : '';
    };
    const parseDate = doc => {
        // The date and its label usually live in adjacent cells, so read the
        // cell that follows the "Ascent Date" label first, then fall back to a
        // scan of the page text.
        const label = Array.from(doc.querySelectorAll('td, th'))
            .find(cell => /ascent date/i.test(cell.textContent || '') && (cell.textContent || '').length < 40);
        if (label && label.nextElementSibling) {
            const parsed = parseDateText(label.nextElementSibling.textContent);
            if (parsed) return parsed;
        }
        const text = clean(doc.body ? doc.body.textContent : '');
        const near = text.match(/Ascent Date:?\s*(.{0,24})/i);
        return near ? parseDateText(near[1]) : '';
    };

    // Read everything the backup surface needs. `search` is location.search (the
    // aid lives there); `doc` defaults to the live document.
    const read = ({ doc = document, search = '' } = {}) => {
        const params = new URLSearchParams(search || '');
        const aidRaw = params.get('aid');
        const ascentId = aidRaw && Number.isFinite(Number(aidRaw)) ? Number(aidRaw) : null;
        const peak = readPeak(doc);
        return {
            ascentId,
            isOwner: ownsAscent(doc, ascentId),
            peak,
            date: parseDate(doc),
            gpxUrl: gpxUrl(doc),
            reportMarkdown: reportMarkdown(doc),
        };
    };

    const API = { read, ownsAscent, reportMarkdown, parseDate };

    export const ascentPage = API;
