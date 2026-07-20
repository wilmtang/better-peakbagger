// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — save-time ascent snapshot serializer.
//
// This is the one place that knows Peakbagger's ascentedit.aspx form field
// names. At Save, the trip-report editor's flush hook calls build() to turn the
// live Form1 fields plus the editor's report (mode, submitted bracket markup,
// and the exact Markdown-source sidecar) into the browser-API-free snapshot that
// src/github-backup.js consumes. Keeping the DOM-name mapping here means the
// pure payload builder never learns an ASP.NET field name, and this module is
// unit-testable against the masked ascentedit fixture.
//
// The result also carries the identity the backup surface matches on later —
// climber, ascent (when editing), peak, and the normalized date — plus a stable
// `key` so a re-save overwrites its own pending snapshot rather than piling up.
// It does NOT read the token or touch the network; it only reads the form.

    const trim = value => (typeof value === 'string' ? value : value == null ? '' : String(value)).trim();
    const pad2 = value => String(value).padStart(2, '0');

    // Peakbagger dates are typed M/D/YYYY; partial dates leave the day (or month)
    // out. Normalize to the ISO-ish shape github-backup understands, using 00 for
    // an unknown month/day so the slug and JSON degrade gracefully.
    const normalizeDate = raw => {
        const t = trim(raw);
        if (!t) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
        let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) return `${m[3]}-${pad2(m[1])}-${pad2(m[2])}`;
        m = t.match(/^(\d{1,2})\/(\d{4})$/);           // M/YYYY (day unknown)
        if (m) return `${m[2]}-${pad2(m[1])}-00`;
        m = t.match(/^(\d{4})$/);                      // year only
        if (m) return `${m[1]}-00-00`;
        return t;
    };

    // ---- form field readers -----------------------------------------------

    const field = (form, name) => (form && form.elements ? form.elements[name] : null);

    const fieldValue = (form, name) => {
        const el = field(form, name);
        if (!el) return '';
        // A RadioNodeList (same-named group) exposes the chosen .value.
        return trim(el.value);
    };

    // The visible label for a control, for human-readable dropdown/radio text.
    const labelText = el => {
        if (!el) return '';
        if (el.labels && el.labels.length) return trim(el.labels[0].textContent);
        const next = el.nextElementSibling;
        if (next && next.tagName === 'LABEL') return trim(next.textContent);
        return '';
    };

    // The selected option's visible text (Precip, etc.), not its numeric code.
    const selectedText = (form, name) => {
        const el = field(form, name);
        if (!el || !el.options || el.selectedIndex < 0) return '';
        const option = el.options[el.selectedIndex];
        return option ? trim(option.textContent) : '';
    };

    // A "hours:minutes" time from Peakbagger's split Hr/Min inputs, or '' when
    // both are blank.
    const splitTime = (form, hrName, minName) => {
        const hr = fieldValue(form, hrName);
        const min = fieldValue(form, minName);
        if (!hr && !min) return '';
        return `${hr || '0'}:${pad2(min || '0')}`;
    };

    // Checked items of an ASP.NET CheckBoxList (Name$0, Name$1, …) as their
    // visible labels.
    const checkedList = (form, prefix) => {
        if (!form || !form.elements) return [];
        const labels = [];
        for (const el of form.elements) {
            if (el.type === 'checkbox' && el.checked && el.name && el.name.startsWith(`${prefix}$`)) {
                const text = labelText(el);
                if (text) labels.push(text);
            }
        }
        return labels;
    };

    // The chosen radio of an ASP.NET RadioButtonList as its visible label.
    const checkedRadioLabel = (form, prefix) => {
        if (!form || !form.elements) return '';
        for (const el of form.elements) {
            if (el.type === 'radio' && el.checked && el.name && el.name.startsWith(prefix)) {
                return labelText(el);
            }
        }
        return '';
    };

    // Added companions live in #OthersTable. OthersText is only the autocomplete
    // search box and is cleared after each Add, so it is never backup data.
    const readCompanions = form => {
        const table = form && form.ownerDocument ? form.ownerDocument.getElementById('OthersTable') : null;
        const registered = [];
        const others = [];
        if (!table) return { registered, others: '' };
        for (const row of Array.from(table.rows).slice(1)) {
            const cells = Array.from(row.cells);
            if (!cells.length) continue;
            const anchor = row.querySelector('a[href*="cid="]');
            if (anchor) {
                let id = null;
                try {
                    const rawId = new URL(anchor.href, 'https://peakbagger.com/').searchParams.get('cid');
                    if (/^\d+$/.test(rawId || '')) id = Number(rawId);
                } catch { /* malformed link */ }
                const name = trim(anchor.textContent);
                if (name) registered.push({ ...(Number.isFinite(id) ? { id } : {}), name });
                continue;
            }
            // The last cell normally contains only a Remove control. Read the
            // first cell so button labels and party-role controls cannot leak.
            const name = trim(cells[0].textContent);
            if (name) others.push(name);
        }
        return { registered, others: others.join(', ') };
    };

    // The peak identity from the peak <select>, falling back to the URL's pid.
    const readPeak = (form, params) => {
        const select = field(form, 'PeakListBox');
        let id = null;
        let name = '';
        if (select && select.options && select.selectedIndex >= 0) {
            const option = select.options[select.selectedIndex];
            if (option && trim(option.value)) { id = Number(option.value); name = trim(option.textContent); }
        }
        if (id == null && params && params.get('pid')) id = Number(params.get('pid'));
        return { id: Number.isFinite(id) ? id : null, name };
    };

    // ---- snapshot ----------------------------------------------------------

    // Build the save-time snapshot from the live form and the editor's report.
    // `params` is a URLSearchParams of the edit page's query (cid/aid/pid);
    // `report` is { markdown } — the final Markdown body the editor already
    // resolved (exact sidecar or bracket→Markdown), so this module needs no DOM.
    const build = ({ form, params, report = {}, extensionVersion = '' } = {}) => {
        const climberId = params && params.get('cid') ? Number(params.get('cid')) : null;
        const ascentId = params && params.get('aid') ? Number(params.get('aid')) : null;
        const peak = readPeak(form, params);
        const date = normalizeDate(fieldValue(form, 'DateText'));

        const ascent = {
            id: ascentId,
            date,
            suffix: fieldValue(form, 'SuffixText'),
            type: checkedRadioLabel(form, 'AscentTypeRBL'),
            route: fieldValue(form, 'RouteUp'),
            routeDown: fieldValue(form, 'RouteDn'),
            externalUrl: fieldValue(form, 'URLTB'),
            gainFt: fieldValue(form, 'GainFt'),
            lossFt: fieldValue(form, 'LossFt'),
            distanceUpMi: fieldValue(form, 'UpMi'),
            distanceDnMi: fieldValue(form, 'DnMi'),
            extraGainFt: fieldValue(form, 'ExUpFt'),
            extraLossFt: fieldValue(form, 'ExDnFt'),
            timeUp: splitTime(form, 'UpHr', 'UpMin'),
            timeDn: splitTime(form, 'DnHr', 'DnMin'),
            nightsOut: fieldValue(form, 'AscentNightsDD'),
            startFt: fieldValue(form, 'StartFt'),
            endFt: fieldValue(form, 'EndFt'),
            pointFt: fieldValue(form, 'PointFt'),
            quality: fieldValue(form, 'AscentQuality'),
            gear: checkedList(form, 'GearCheckBoxList'),
            companions: readCompanions(form),
            weather: {
                precip: selectedText(form, 'PrecipDD'),
                temperature: selectedText(form, 'TempDD'),
                wind: selectedText(form, 'WindDD'),
                visibility: selectedText(form, 'VisDD'),
                description: fieldValue(form, 'WeatherText'),
            },
        };

        const snapshot = {
            ascent,
            peak: { id: peak.id, name: peak.name },
            report: { markdown: typeof report.markdown === 'string' ? report.markdown : '' },
            backup: { extensionVersion: trim(extensionVersion), syncedAt: null },
        };

        return {
            key: identityKey({ climberId, peakId: peak.id, date }),
            identity: { climberId, ascentId, peakId: peak.id, date },
            snapshot,
        };
    };

    // A stable match key: same climber + peak + submitted date. A re-save
    // overwrites its own pending snapshot instead of accumulating duplicates.
    const identityKey = ({ climberId, peakId, date }) =>
        `${climberId ?? ''}|${peakId ?? ''}|${date ?? ''}`;

    const API = { build, identityKey, normalizeDate };

    export const ascentSnapshot = API;
