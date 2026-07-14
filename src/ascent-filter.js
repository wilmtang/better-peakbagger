// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — ascent-list filter and instant date-sort content script.
// Runs in the default isolated content-script world: it only reads ascent-table
// DOM, reorders existing rows, and persists PeakAscents chip preferences in the
// page's (same-origin) localStorage, so no page-global access is needed.

(() => {
    'use strict';

    // Chip on/off states and the Trip report word-count threshold are per-page
    // UI state kept in page localStorage (below). The shared extension settings
    // (chrome.storage) own only the cross-cutting "has beta" definition.
    const S = window.BPBSettings;

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

    // --- Early date-sort click guard ------------------------------------------
    // The instant date sort (below) only wires up once the DOM is parsed and the
    // filter has initialized. On a big ascent list the header renders and is
    // clickable well before that, so a click on "Ascent Date" / "[sort desc]" in
    // that window would fire a full-page server reload — exactly the sort we can
    // answer instantly in the DOM. This capture-phase guard installs
    // synchronously at document_start and holds those clicks until the sorter has
    // decided: it replays the last one instantly once ready, navigates it if the
    // page turns out not to be a candidate, and passes every other click through.
    // It targets only date-sort links inside a table header, so year-jump and
    // unit-toggle links that carry the same sort key navigate untouched.
    const dateSortTarget = target => {
        const anchor = target && target.closest ? target.closest('a[href]') : null;
        if (!anchor) return null;
        const header = anchor.closest('th');
        if (!header || !normalize(header.textContent).toLowerCase().startsWith('ascent date')) return null;
        let url;
        try { url = new URL(anchor.href, location.href); } catch (e) { return null; }
        const sort = (url.searchParams.get('sort') || '').toLowerCase();
        if (sort !== 'ascentdate' && sort !== 'ascentdated') return null;
        return { href: anchor.href, dir: sort === 'ascentdated' ? 'desc' : 'asc' };
    };

    let sortReady = false;      // instant sorter is wired and owns these clicks
    let sortOptOut = false;     // page isn't a candidate: let clicks navigate
    let pendingSortTarget = null;// a click held before the sorter decided
    let applyInstantSort = null;// (direction) => reorder in the DOM, set once ready

    document.addEventListener('click', event => {
        const target = dateSortTarget(event.target);
        if (!target || sortOptOut) return; // not ours, or navigation is allowed
        event.preventDefault();
        if (sortReady) applyInstantSort(target.dir);
        else pendingSortTarget = target;   // hold until the sorter decides
    }, true);

    // Called on any path that will NOT run the instant sorter, so a held click
    // isn't swallowed forever: fulfill it as a normal navigation and stop
    // intercepting.
    const optOutInstantSort = () => {
        if (sortOptOut || sortReady) return;
        sortOptOut = true;
        if (pendingSortTarget) {
            const { href } = pendingSortTarget;
            pendingSortTarget = null;
            try { location.href = href; } catch (e) { /* sandboxed */ }
        }
    };

    // --- Instant Ascent Date sort ---------------------------------------------
    // The native date header carries two backend sort links:
    //   "Ascent Date" -> sort=ascentdate  (oldest first)
    //   "[sort desc]" -> sort=ascentdated (newest first)
    // Replace that pair with one persistent toggle. When the table is already
    // date-sorted, the opposite direction is exactly the served order reversed
    // (sections reversed, rows within each section reversed), so the toggle can
    // answer instantly in the DOM with no date parsing — which matters because
    // date cells include "Unknown", partial and malformed values whose backend
    // ordering is opaque. Default views are date-ascending even when `sort` is
    // omitted; explicit non-date sorts still opt out to normal navigation.
    //
    // Runs synchronously, before init's awaited settings read, so the click guard
    // above is released — and any held click replayed — without waiting on the
    // chrome.storage round-trip.
    const setupInstantDateSort = ({ headerTexts, headerRow, sections, preamble, rows }) => {
        const dateIndex = headerTexts.findIndex(text => text.startsWith('ascent date'));
        if (dateIndex === -1) return optOutInstantSort();

        const sortKeyOf = anchor => {
            try { return (new URL(anchor.href, location.href).searchParams.get('sort') || '').toLowerCase(); }
            catch (e) { return ''; }
        };
        const anchors = Array.from(headerRow.cells[dateIndex].querySelectorAll('a[href]'));
        const links = {
            asc: anchors.find(a => sortKeyOf(a) === 'ascentdate'),
            desc: anchors.find(a => sortKeyOf(a) === 'ascentdated')
        };
        if (!links.asc || !links.desc) return optOutInstantSort();

        const urlSort = (new URLSearchParams(location.search).get('sort') || 'ascentdate').toLowerCase();
        if (urlSort !== 'ascentdate' && urlSort !== 'ascentdated') return optOutInstantSort();

        // Served direction: trust the year separators over the URL.
        const years = sections
            .map(section => parseInt(normalize(section.row.textContent), 10))
            .filter(Number.isFinite);
        const servedDir = years.length > 1
            ? (years[0] > years[years.length - 1] ? 'desc' : 'asc')
            : (urlSort === 'ascentdated' ? 'desc' : 'asc');

        const servedOrder = rows.slice(rows.indexOf(headerRow) + 1);
        const reversedOrder = [];
        for (let i = sections.length - 1; i >= 0; i--) {
            reversedOrder.push(sections[i].row);
            for (let j = sections[i].items.length - 1; j >= 0; j--) {
                reversedOrder.push(sections[i].items[j].row);
            }
        }
        for (let i = preamble.length - 1; i >= 0; i--) reversedOrder.push(preamble[i].row);

        const control = document.createElement('button');
        control.type = 'button';
        control.className = 'pbaf-date-sort';
        control.append('Ascent Date');
        const arrow = document.createElement('span');
        arrow.className = 'pbaf-sort-arrow';
        control.append(arrow);
        headerRow.cells[dateIndex].replaceChildren(control);

        let currentDir = servedDir;
        const paint = () => {
            arrow.textContent = currentDir === 'asc' ? ' ▲' : ' ▼';
            const current = currentDir === 'asc' ? 'oldest first' : 'newest first';
            const next = currentDir === 'asc' ? 'newest first' : 'oldest first';
            control.title = `Sorted ${current}. Click to sort ${next}.`;
            control.setAttribute('aria-label', `Ascent Date, sorted ${current}. Sort ${next}.`);
            headerRow.cells[dateIndex].setAttribute('aria-sort', currentDir === 'asc' ? 'ascending' : 'descending');
        };

        const applyDir = dir => {
            if (dir === currentDir) return;
            const fragment = document.createDocumentFragment();
            for (const row of (dir === servedDir ? servedOrder : reversedOrder)) fragment.appendChild(row);
            headerRow.parentNode.appendChild(fragment);
            currentDir = dir;
            paint();
            // Preserve the current row-set URL. Native header links often add or
            // change y=/j=/u= defaults; copying one would make reload/share show
            // a different list than the rows the user just sorted.
            try {
                const url = new URL(location.href);
                url.searchParams.set('sort', dir === 'asc' ? 'ascentdate' : 'ascentdated');
                history.replaceState(history.state, '', url.href);
            } catch (e) { /* sandboxed */ }
        };

        const toggle = () => applyDir(currentDir === 'asc' ? 'desc' : 'asc');
        control.addEventListener('click', toggle);
        control.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle();
        });

        // The document-level guard owns clicks caught before the native links
        // were replaced. Route them here now that the DOM sorter is ready.
        applyInstantSort = applyDir;
        sortReady = true;
        if (pendingSortTarget) {
            const { dir } = pendingSortTarget;
            pendingSortTarget = null;
            applyInstantSort(dir);
        }
        paint();
    };

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
.pbaf-date-sort { appearance: none; border: 0; padding: 0; background: transparent; color: navy;
    font: inherit; font-weight: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 1px; }
.pbaf-date-sort:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 2px; }
.pbaf-sort-arrow { font-size: 10px; opacity: .85; }
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

    const init = async () => {
        if (document.getElementById('pbaf-bar')) return;
        const table = document.querySelector('table.gray');
        if (!table) return optOutInstantSort();

        const rows = Array.from(table.rows);
        const headerRow = rows.find(row => row.cells.length > 1 && row.cells[0].tagName === 'TH');
        if (!headerRow) return optOutInstantSort();

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

        const dataRows = [];
        const sections = [];
        const preamble = []; // data rows before the first year separator
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
            else preamble.push(record);
        }
        if (!dataRows.length) return optOutInstantSort();

        // Wire the instant date sort now — synchronously, before the awaited
        // settings read below — so the click guard is released (and any held
        // click replayed) as early as possible, not after the storage round-trip.
        setupInstantDateSort({ headerTexts, headerRow, sections, preamble, rows });

        // Personal ClimbListC pages share the ascent-table structure and date
        // header, but the beta-filter feature belongs only to PeakAscents.
        if (!/\/peakascents\.aspx$/i.test(location.pathname)) return;

        if (columns.tr === null && columns.gps === null && columns.link === null) {
            renderCompactNotice(table);
            return;
        }

        const total = dataRows.length;
        const counts = {
            beta: dataRows.filter(r => r.beta).length,
            tr: dataRows.filter(r => r.words > 0).length,
            gps: dataRows.filter(r => r.gps).length,
            link: dataRows.filter(r => r.link).length
        };

        // What "has beta" means is user-configurable (extension settings);
        // the default matches any trip report, GPS track, or link.
        let betaCfg = { tr: true, trMinWords: 1, gps: true, link: true };
        const betaCfgFrom = settings => ({
            tr: settings.betaTr !== false,
            trMinWords: Math.max(1, parseInt(settings.betaTrMinWords, 10) || 1),
            gps: settings.betaGps !== false,
            link: settings.betaLink !== false
        });
        const betaOf = record =>
            (betaCfg.tr && record.words >= betaCfg.trMinWords) ||
            (betaCfg.gps && record.gps) ||
            (betaCfg.link && record.link);
        const betaTooltip = () => {
            const parts = [];
            if (betaCfg.tr) parts.push(betaCfg.trMinWords > 1 ? `a trip report of ≥ ${betaCfg.trMinWords} words` : 'a trip report');
            if (betaCfg.gps) parts.push('a GPS track');
            if (betaCfg.link) parts.push('a link');
            return `Only ascents with ${parts.join(' or ')} — hides entries with no climb beta. `
                + 'What counts as beta is configurable in the extension settings. Remembered across visits.';
        };
        const refreshBeta = () => {
            counts.beta = 0;
            for (const record of dataRows) {
                record.beta = betaOf(record);
                if (record.beta) counts.beta++;
            }
            if (chips.beta) {
                chips.beta.querySelector('.pbaf-count').textContent = String(counts.beta);
                chips.beta.title = betaTooltip();
            }
        };

        const state = loadState();
        // The Trip report chip's word threshold is per-page UI state and lives
        // in localStorage (state.minWords, above). The "has beta" definition is
        // centralized in extension settings.
        if (S) {
            try {
                betaCfg = betaCfgFrom(await S.get());
            } catch (e) { /* fall back to defaults */ }
        }
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
            makeChip('beta', 'Has beta', ''),
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
        refreshBeta();

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

        // Re-apply the beta definition if it changes in the options page /
        // another tab. (The Trip report word threshold is local UI state.)
        if (S && S.subscribe) {
            S.subscribe(settings => {
                const nextBeta = betaCfgFrom(settings);
                if (JSON.stringify(nextBeta) !== JSON.stringify(betaCfg)) {
                    betaCfg = nextBeta;
                    refreshBeta();
                    render();
                }
            });
        }
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
