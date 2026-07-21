// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — saved ascent page reader (ascent.aspx).
//
// Reads the fields the GitHub backup surface needs from a saved ascent page:
// the ascent id (the definitive identity, and the only source of it for a newly
// created ascent), whether the signed-in climber owns the ascent (an edit link
// to this aid — the ownership gate fails closed), the peak the ascent belongs
// to, and the stored GPS-track download link. Raw backup fields and report
// content come from the owner-only edit form instead; the rendered display page
// is intentionally not a backup data source.
//
// The reliable fields (aid, ownership, peak id/name, GPX link) come from stable
// URL shapes; the date is best-effort and used only as a fallback when the
// persisted form omits it. Selectors here are validated against a masked
// ascent.aspx fixture and confirmed on live Peakbagger before release.

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

    // Ownership: the signed-in climber sees an edit link for THIS ascent. Keep
    // the exact link as well as the boolean so the backup surface can read the
    // complete persisted form instead of rebuilding from the lossy display page.
    const ascentEditLink = (doc, ascentId) => {
        if (ascentId == null) return null;
        for (const a of doc.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (/ascentedit\.aspx\?/i.test(href) && String(paramFrom(href, 'aid')) === String(ascentId)) return a;
        }
        return null;
    };
    const ownsAscent = (doc, ascentId) => ascentEditLink(doc, ascentId) != null;

    const readPeak = doc => {
        const link = findLink(doc, 'peak\\.aspx', 'pid');
        if (!link) return { id: null, name: '' };
        const id = Number(paramFrom(link.getAttribute('href'), 'pid'));
        return { id: Number.isFinite(id) ? id : null, name: clean(link.textContent) };
    };

    // Find the stored-track download link. Peakbagger's link text ("Download
    // this GPS track…") has been the stable signal, but match the href
    // (GPXFile.aspx, plus the legacy GetAscentGPX.aspx) as a fallback so a future
    // rewording of the link text does not silently drop the track.
    const gpxUrl = doc => {
        for (const a of doc.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (/Download this GPS track/i.test(a.textContent || '') || /GPXFile\.aspx|GetAscentGPX\.aspx/i.test(href)) {
                return a.href || href;
            }
        }
        return null;
    };

    // Peakbagger renders the display-page label as "Date:" (older fixtures and
    // some page variants use "Ascent Date:"). Parse a "Mon D, YYYY" or
    // bare-year string to ISO; '' when nothing parseable is found.
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
        // The date and its label live in adjacent cells. Match the complete
        // label so unrelated table cells containing the word "date" cannot win.
        const label = Array.from(doc.querySelectorAll('td, th'))
            .find(cell => /^(?:ascent\s+)?date\s*:?$/i.test(clean(cell.textContent || '')));
        if (label && label.nextElementSibling) {
            const parsed = parseDateText(label.nextElementSibling.textContent);
            if (parsed) return parsed;
        }
        const text = clean(doc.body ? doc.body.textContent : '');
        const near = text.match(/(?:Ascent\s+)?Date:?\s*(.{0,24})/i);
        return near ? parseDateText(near[1]) : '';
    };

    // Read everything the backup surface needs. `search` is location.search (the
    // aid lives there); `doc` defaults to the live document.
    const read = ({ doc = document, search = '' } = {}) => {
        const params = new URLSearchParams(search || '');
        const aidRaw = params.get('aid');
        const ascentId = aidRaw && Number.isFinite(Number(aidRaw)) ? Number(aidRaw) : null;
        const peak = readPeak(doc);
        const editLink = ascentEditLink(doc, ascentId);
        return {
            ascentId,
            isOwner: editLink != null,
            editUrl: editLink ? (editLink.href || editLink.getAttribute('href')) : null,
            peak,
            date: parseDate(doc),
            gpxUrl: gpxUrl(doc),
        };
    };

    const API = { read, ownsAscent, ascentEditLink, parseDate };

    export const ascentPage = API;
