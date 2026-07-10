// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — Ascent Beta Filter content script.
// Runs in the default isolated content-script world: it only reads the ascent
// table in the page DOM and persists chip preferences in the page's
// (same-origin) localStorage, so no page-global access is needed.

(() => {
    'use strict';

    const STORAGE_KEY = 'pbAscentBetaFilter.v1';
    const DEFAULT_STATE = { beta: true, tr: false, minWords: 1, gps: false, link: false };

    const loadState = () => {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            if (saved && typeof saved === 'object') return { ...DEFAULT_STATE, ...saved };
        } catch (e) { /* corrupted state -> defaults */ }
        return { ...DEFAULT_STATE };
    };

    const saveState = state => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
    };

    // Cells that "look empty" may contain a literal &nbsp; depending on column.
    const normalize = text => (text || '').replace(/\u00a0/g, ' ').trim();

    const STYLE = `
#pbaf-bar { position: sticky; top: 0; z-index: 400; box-sizing: border-box; margin: 10px 0; padding: 8px 12px;
    background: #fff; border: 1px solid #d5d5d0; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.06);
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #333; }
#pbaf-bar * { box-sizing: border-box; }
.pbaf-label { font-size: 10px; font-weight: 700; letter-spacing: .08em; color: #98988f; text-transform: uppercase; margin-right: 2px; }
.pbaf-divider { width: 1px; height: 18px; background: #e2e2dc; }
.pbaf-chip { appearance: none; display: inline-flex; align-items: center; gap: 5px; padding: 3px 11px;
    border: 1px solid #c8c8c2; border-radius: 999px; background: #fff; color: #3d3d38; font: inherit; cursor: pointer;
    transition: border-color .12s, background .12s, color .12s; user-select: none; }
.pbaf-chip:hover { border-color: #2f6b3f; color: #2f6b3f; }
.pbaf-chip:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 2px; }
.pbaf-chip[aria-pressed="true"] { background: #2f6b3f; border-color: #2f6b3f; color: #fff; }
.pbaf-chip .pbaf-count { font-size: 11px; color: #8b8b84; font-variant-numeric: tabular-nums; }
.pbaf-chip[aria-pressed="true"] .pbaf-count { color: #cfe3d4; }
.pbaf-tick { display: none; font-weight: 700; }
.pbaf-chip[aria-pressed="true"] .pbaf-tick { display: inline; }
.pbaf-words { display: inline-flex; align-items: center; gap: 4px; color: #55554f; }
.pbaf-words[hidden] { display: none; }
.pbaf-words input { width: 4.6em; padding: 2px 5px; border: 1px solid #c8c8c2; border-radius: 6px; font: inherit; color: #333; background: #fff; }
.pbaf-words input:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 1px; }
.pbaf-spacer { flex: 1 1 auto; }
.pbaf-status { color: #55554f; white-space: nowrap; }
.pbaf-status b { color: #141414; font-weight: 600; font-variant-numeric: tabular-nums; }
.pbaf-reset { appearance: none; border: none; background: none; padding: 0; font: inherit; color: #666;
    text-decoration: underline; text-underline-offset: 2px; cursor: pointer; white-space: nowrap; }
.pbaf-reset:hover { color: #2f6b3f; }
.pbaf-reset:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 2px; }
.pbaf-reset[hidden] { display: none; }
.pbaf-note { color: #55554f; }
.pbaf-note a { color: #2f6b3f; font-weight: 600; }
`;

    const injectStyle = () => {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);
    };

    const buildBarShell = () => {
        const bar = document.createElement('div');
        bar.id = 'pbaf-bar';
        const label = document.createElement('span');
        label.className = 'pbaf-label';
        label.textContent = 'Beta filter';
        bar.appendChild(label);
        return bar;
    };

    // The compact view (no y= in the URL) only renders Climber + Date columns,
    // so there is nothing to filter on. Point the user at the full table instead.
    const renderCompactNotice = table => {
        const params = new URLSearchParams(location.search);
        const pid = params.get('pid');
        if (!pid) return;

        const target = new URLSearchParams({ pid, y: '9999', sort: params.get('sort') || 'ascentdate' });
        if (params.get('u')) target.set('u', params.get('u'));

        const bar = buildBarShell();
        bar.style.position = 'static';
        const note = document.createElement('span');
        note.className = 'pbaf-note';
        note.append('This condensed view has no trip report / GPS / link data to filter. ');
        const link = document.createElement('a');
        link.href = 'PeakAscents.aspx?' + target.toString();
        link.textContent = 'Show all years with full details →';
        note.appendChild(link);
        bar.appendChild(note);
        table.parentNode.insertBefore(bar, table);
    };

    const init = () => {
        if (document.getElementById('pbaf-bar')) return;
        const table = document.querySelector('table.gray');
        if (!table) return;

        const rows = Array.from(table.rows);
        const headerRow = rows.find(row => row.cells.length > 1 && row.cells[0].tagName === 'TH');
        if (!headerRow) return;

        // Column order and presence vary by URL params (y=, u=, per-year views),
        // so columns must be resolved from header text on every load.
        const headerTexts = Array.from(headerRow.cells).map(cell => normalize(cell.textContent).toLowerCase());
        const findColumn = matcher => {
            const index = headerTexts.findIndex(matcher);
            return index === -1 ? null : index;
        };
        const columns = {
            tr: findColumn(text => text.startsWith('tr-words')),
            gps: findColumn(text => text === 'gps'),
            link: findColumn(text => text === 'link')
        };

        injectStyle();

        if (columns.tr === null && columns.gps === null && columns.link === null) {
            renderCompactNotice(table);
            return;
        }

        const dataRows = [];
        const sections = [];
        let currentSection = null;
        let pastHeader = false;
        for (const row of rows) {
            if (!pastHeader) {
                pastHeader = row === headerRow;
                continue;
            }
            if (row.cells.length === 1) {
                // Year separator row (single td with colspan)
                currentSection = { row, items: [] };
                sections.push(currentSection);
                continue;
            }
            if (row.cells.length < 2) continue;

            const cell = key => columns[key] === null ? null : (row.cells[columns[key]] || null);
            const trMatch = /^TR-(\d+)/.exec(normalize(cell('tr') && cell('tr').textContent));
            const record = {
                row,
                words: trMatch ? parseInt(trMatch[1], 10) : 0,
                gps: !!(cell('gps') && cell('gps').querySelector('img')),
                link: !!(cell('link') && cell('link').querySelector('a[href]')),
                visible: true
            };
            record.beta = record.words > 0 || record.gps || record.link;
            dataRows.push(record);
            if (currentSection) currentSection.items.push(record);
        }
        if (!dataRows.length) return;

        const total = dataRows.length;
        const counts = {
            beta: dataRows.filter(r => r.beta).length,
            tr: dataRows.filter(r => r.words > 0).length,
            gps: dataRows.filter(r => r.gps).length,
            link: dataRows.filter(r => r.link).length
        };

        const state = loadState();
        const bar = buildBarShell();
        const chips = {};

        const makeChip = (key, label, tooltip) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'pbaf-chip';
            button.title = tooltip;

            const tick = document.createElement('span');
            tick.className = 'pbaf-tick';
            tick.textContent = '✓';
            const count = document.createElement('span');
            count.className = 'pbaf-count';
            count.textContent = String(counts[key]);
            button.append(tick, label, count);

            button.addEventListener('click', () => {
                state[key] = !state[key];
                saveState(state);
                render();
            });
            chips[key] = button;
            return button;
        };

        const wordsWrap = document.createElement('span');
        wordsWrap.className = 'pbaf-words';
        const wordsInput = document.createElement('input');
        wordsInput.type = 'number';
        wordsInput.min = '1';
        wordsInput.step = '1';
        wordsInput.inputMode = 'numeric';
        wordsInput.setAttribute('aria-label', 'Minimum trip report word count');
        wordsInput.value = String(Math.max(1, parseInt(state.minWords, 10) || 1));
        wordsWrap.append('≥ ', wordsInput, ' words');
        wordsInput.addEventListener('input', () => {
            const value = parseInt(wordsInput.value, 10);
            state.minWords = Number.isFinite(value) && value > 0 ? value : 1;
            saveState(state);
            render();
        });

        const spacer = document.createElement('span');
        spacer.className = 'pbaf-spacer';

        const statusEl = document.createElement('span');
        statusEl.className = 'pbaf-status';
        statusEl.setAttribute('aria-live', 'polite');

        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'pbaf-reset';
        resetButton.textContent = 'Show all';
        resetButton.title = 'Turn off all filters (remembered for future visits)';
        resetButton.addEventListener('click', () => {
            state.beta = false;
            state.tr = false;
            state.gps = false;
            state.link = false;
            saveState(state);
            render();
        });

        const divider = document.createElement('span');
        divider.className = 'pbaf-divider';

        bar.append(
            makeChip('beta', 'Has beta',
                'Only ascents with a trip report, GPS track, or link — hides entries with no climb beta. Remembered across visits.'),
            divider,
            makeChip('tr', 'Trip report',
                'Only ascents with a written trip report of at least the chosen word count.'),
            wordsWrap,
            makeChip('gps', 'GPS track',
                'Only ascents with a GPS track.'),
            makeChip('link', 'Link',
                'Only ascents with an external link (blog, Strava, forum, ...).'),
            spacer,
            statusEl,
            resetButton
        );

        const render = () => {
            for (const [key, chip] of Object.entries(chips)) {
                chip.setAttribute('aria-pressed', String(!!state[key]));
            }
            wordsWrap.hidden = !state.tr;

            const minWords = Math.max(1, parseInt(state.minWords, 10) || 1);
            let shown = 0;
            for (const record of dataRows) {
                let visible = true;
                if (state.beta && !record.beta) visible = false;
                if (state.tr && record.words < minWords) visible = false;
                if (state.gps && !record.gps) visible = false;
                if (state.link && !record.link) visible = false;
                record.visible = visible;
                record.row.style.display = visible ? '' : 'none';
                if (visible) shown++;
            }
            for (const section of sections) {
                section.row.style.display = section.items.some(item => item.visible) ? '' : 'none';
            }

            const anyActive = state.beta || state.tr || state.gps || state.link;
            statusEl.textContent = '';
            const strong = document.createElement('b');
            if (anyActive) {
                strong.textContent = String(shown);
                const totalEl = document.createElement('b');
                totalEl.textContent = String(total);
                statusEl.append('Showing ', strong, ' of ', totalEl, ` ascent${total === 1 ? '' : 's'}`);
            } else {
                strong.textContent = String(total);
                statusEl.append(strong, ` ascent${total === 1 ? '' : 's'}`);
            }
            resetButton.hidden = !anyActive;
        };

        table.parentNode.insertBefore(bar, table);
        render();
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
