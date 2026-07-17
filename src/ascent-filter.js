// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — ascent-list filter and instant table-sort content script.
// Runs in the default isolated content-script world: it only reads ascent-table
// DOM, reorders existing rows, and persists PeakAscents chip preferences in the
// page's (same-origin) localStorage, so no page-global access is needed.

(() => {
    'use strict';

    // Chip on/off states and the Trip report word-count threshold are per-page
    // UI state kept in page localStorage (below). The shared extension settings
    // (chrome.storage) own only the cross-cutting "has beta" definition.
    const S = globalThis.BPBSettings;

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

    // --- Early table-sort click guard -----------------------------------------
    // The client-side sorter (below) only wires up once the DOM is parsed. On a
    // large ascent list the header is clickable well before then, so hold native
    // sort-link clicks until the sorter has decided whether it owns this table.
    // Links outside table headers (year jumps, unit toggles, etc.) are untouched.
    const tableSortTarget = target => {
        const anchor = target && target.closest ? target.closest('a[href]') : null;
        if (!anchor) return null;
        const header = anchor.closest('th');
        if (!header) return null;
        let url;
        try { url = new URL(anchor.href, location.href); } catch (e) { return null; }
        const rawKey = url.searchParams.get('sort') || '';
        if (!rawKey) return null;
        const lowerKey = rawKey.toLowerCase();
        return {
            href: anchor.href,
            columnIndex: header.cellIndex,
            key: lowerKey === 'ascentdated' ? 'ascentdate' : lowerKey,
            dir: lowerKey === 'ascentdated' ? 'desc' : (lowerKey === 'ascentdate' ? 'asc' : null)
        };
    };

    let sortReady = false;       // instant sorter is wired and owns these clicks
    let sortOptOut = false;      // page isn't a candidate: let clicks navigate
    let pendingSortTarget = null;// a click held before the sorter decided
    let applyInstantSort = null; // (target) => reorder in the DOM, set once ready

    document.addEventListener('click', event => {
        const target = tableSortTarget(event.target);
        if (!target || sortOptOut) return; // not ours, or navigation is allowed
        event.preventDefault();
        if (sortReady) applyInstantSort(target);
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

    // --- Instant table sorting ------------------------------------------------
    // Replace every native backend sort link with a button that reorders only the
    // rows already on the page. Date-sorted pages keep Peakbagger's exact served
    // order so Unknown, partial, and malformed dates retain backend semantics.
    // Other columns use values already present in their cells; their sort is
    // stable and type-aware for numbers, presence flags, icons, and dates.
    const setupInstantTableSort = ({ headerRow, sections, preamble, rows, dataRows }) => {
        const keyOf = anchor => {
            try { return new URL(anchor.href, location.href).searchParams.get('sort') || ''; }
            catch (e) { return ''; }
        };
        const numericKeys = new Set([
            'words', 'vertpeakft', 'tripupft', 'totalkm', 'tripkm',
            'quality', 'elevft', 'promft'
        ]);
        const descendingFirstKeys = new Set([
            ...numericKeys, 'gps', 'routestring', 'gearstring', 'urllink'
        ]);
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

        const sortable = Array.from(headerRow.cells).flatMap((cell, index) => {
            const anchors = Array.from(cell.querySelectorAll('a[href]'));
            const primary = anchors.find(anchor => keyOf(anchor).toLowerCase() !== 'ascentdated');
            if (!primary) return [];
            const rawKey = keyOf(primary);
            if (!rawKey) return [];
            const key = rawKey.toLowerCase();
            const label = normalize(primary.textContent) || normalize(cell.textContent);
            return [{
                id: `${index}:${key}`,
                index,
                key,
                label,
                defaultDir: descendingFirstKeys.has(key) ? 'desc' : 'asc',
                cell,
                control: null,
                arrow: null
            }];
        });
        if (!sortable.length) return optOutInstantSort();

        dataRows.forEach((record, index) => {
            record.sortIndex = index;
            record.sortValues = new Map();
        });
        const readValueAt = (record, column) => {
            const cell = record.row.cells[column.index];
            if (!cell) return '';

            if (column.key === 'ascentdate') {
                const text = normalize(cell.textContent);
                const match = /(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(text);
                if (!match) return [0, 0, 0, text.toLowerCase()];
                return [
                    parseInt(match[1], 10),
                    match[2] ? parseInt(match[2], 10) : 0,
                    match[3] ? parseInt(match[3], 10) : 0,
                    text.slice(match.index + match[0].length).replace(/[()]/g, '').trim().toLowerCase()
                ];
            }
            if (column.key === 'words') return record.words;
            if (column.key === 'gps') return record.gps ? 1 : 0;
            if (column.key === 'urllink') return cell.querySelector('a[href]') ? 1 : 0;
            if (numericKeys.has(column.key)) {
                const match = /-?\d+(?:\.\d+)?/.exec(normalize(cell.textContent).replace(/,/g, ''));
                return match ? parseFloat(match[0]) : 0;
            }
            if (column.key === 'routestring' || column.key === 'gearstring') {
                return Array.from(cell.querySelectorAll('img')).map(image => {
                    const src = image.getAttribute('src') || '';
                    return src.slice(src.lastIndexOf('/') + 1);
                }).join('|');
            }

            const text = normalize(cell.textContent);
            if (text) return text;
            return Array.from(cell.querySelectorAll('img')).map(image =>
                normalize(image.title || image.alt || image.getAttribute('src'))
            ).join('|');
        };
        const valueAt = (record, column) => {
            if (!record.sortValues.has(column.id)) {
                record.sortValues.set(column.id, readValueAt(record, column));
            }
            return record.sortValues.get(column.id);
        };
        const compareValues = (left, right) => {
            if (Array.isArray(left) && Array.isArray(right)) {
                for (let i = 0; i < Math.max(left.length, right.length); i++) {
                    const compared = compareValues(left[i] ?? '', right[i] ?? '');
                    if (compared) return compared;
                }
                return 0;
            }
            if (typeof left === 'number' && typeof right === 'number') return left - right;
            return collator.compare(String(left), String(right));
        };
        const compareRecords = (left, right, column, dir, stable = true) => {
            const compared = compareValues(valueAt(left, column), valueAt(right, column));
            if (compared) return dir === 'asc' ? compared : -compared;
            return stable ? left.sortIndex - right.sortIndex : 0;
        };
        const inferDirection = column => {
            let ascending = true;
            let descending = true;
            for (let i = 1; i < dataRows.length && (ascending || descending); i++) {
                const compared = compareRecords(dataRows[i - 1], dataRows[i], column, 'asc', false);
                if (compared > 0) ascending = false;
                if (compared < 0) descending = false;
            }
            if (ascending) return 'asc';
            if (descending) return 'desc';
            return null;
        };

        const urlSort = (new URLSearchParams(location.search).get('sort') || 'ascentdate').toLowerCase();
        const dateServed = urlSort === 'ascentdate' || urlSort === 'ascentdated';
        const years = sections
            .map(section => parseInt(normalize(section.row.textContent), 10))
            .filter(Number.isFinite);
        const servedDateDir = years.length > 1
            ? (years[0] > years[years.length - 1] ? 'desc' : 'asc')
            : (urlSort === 'ascentdated' ? 'desc' : 'asc');
        const servedOrder = rows.slice(rows.indexOf(headerRow) + 1);
        const reversedDateOrder = [];
        for (let i = sections.length - 1; i >= 0; i--) {
            reversedDateOrder.push(sections[i].row);
            for (let j = sections[i].items.length - 1; j >= 0; j--) {
                reversedDateOrder.push(sections[i].items[j].row);
            }
        }
        for (let i = preamble.length - 1; i >= 0; i--) reversedDateOrder.push(preamble[i].row);
        const knownRows = new Set([
            ...dataRows.map(record => record.row),
            ...sections.map(section => section.row)
        ]);
        const otherRows = servedOrder.filter(row => !knownRows.has(row));
        reversedDateOrder.push(...otherRows);

        const appendRecords = (records, showSections) => {
            const fragment = document.createDocumentFragment();
            for (const section of sections) section.row.hidden = !showSections;
            for (const record of records) fragment.appendChild(record.row);
            for (const row of otherRows) fragment.appendChild(row);
            for (const section of sections) fragment.appendChild(section.row);
            headerRow.parentNode.appendChild(fragment);
        };

        let currentColumn = null;
        let currentDir = null;
        if (dateServed) {
            currentColumn = sortable.find(column => column.key === 'ascentdate') || null;
            currentDir = currentColumn ? servedDateDir : null;
        } else {
            const servedColumn = sortable.find(column => column.key === urlSort) || null;
            const servedDirection = servedColumn && inferDirection(servedColumn);
            if (servedDirection) {
                currentColumn = servedColumn;
                currentDir = servedDirection;
            }
        }

        const directionWords = (column, dir) => {
            if (column.key === 'ascentdate') return dir === 'asc' ? 'oldest first' : 'newest first';
            return dir === 'asc' ? 'ascending' : 'descending';
        };
        const paint = () => {
            for (const column of sortable) {
                const active = currentColumn && currentColumn.id === column.id;
                column.cell.removeAttribute('aria-sort');
                column.arrow.textContent = active ? (currentDir === 'asc' ? ' ▲' : ' ▼') : '';
                if (active) {
                    const current = directionWords(column, currentDir);
                    const nextDir = currentDir === 'asc' ? 'desc' : 'asc';
                    const next = directionWords(column, nextDir);
                    column.cell.setAttribute('aria-sort', currentDir === 'asc' ? 'ascending' : 'descending');
                    column.control.title = `Sorted ${current}. Click to sort ${next}.`;
                    column.control.setAttribute('aria-label', `${column.label}, sorted ${current}. Sort ${next}.`);
                } else {
                    const first = directionWords(column, column.defaultDir);
                    column.control.title = `Sort ${first}.`;
                    column.control.setAttribute('aria-label', `${column.label}. Sort ${first}.`);
                }
            }
        };

        const apply = (column, dir) => {
            if (!column || (currentColumn && currentColumn.id === column.id && currentDir === dir)) return;

            if (column.key === 'ascentdate' && dateServed) {
                for (const section of sections) section.row.hidden = false;
                const order = dir === servedDateDir ? servedOrder : reversedDateOrder;
                const fragment = document.createDocumentFragment();
                for (const row of order) fragment.appendChild(row);
                headerRow.parentNode.appendChild(fragment);
            } else {
                const sorted = dataRows.slice().sort((left, right) => compareRecords(left, right, column, dir));
                appendRecords(sorted, column.key === 'ascentdate');
            }

            currentColumn = column;
            currentDir = dir;
            paint();

            // Date has native ascending/descending URL keys. Preserve the current
            // row-set parameters without adopting defaults from a header link.
            if (column.key === 'ascentdate') {
                try {
                    const url = new URL(location.href);
                    url.searchParams.set('sort', dir === 'asc' ? 'ascentdate' : 'ascentdated');
                    history.replaceState(history.state, '', url.href);
                } catch (e) { /* sandboxed */ }
            }
        };

        for (const column of sortable) {
            const control = document.createElement('button');
            control.type = 'button';
            control.className = 'pbaf-table-sort' + (column.key === 'ascentdate' ? ' pbaf-date-sort' : '');
            control.append(column.label);
            const arrow = document.createElement('span');
            arrow.className = 'pbaf-sort-arrow';
            control.appendChild(arrow);
            column.control = control;
            column.arrow = arrow;
            column.cell.replaceChildren(control);

            const toggle = () => {
                const dir = currentColumn && currentColumn.id === column.id
                    ? (currentDir === 'asc' ? 'desc' : 'asc')
                    : column.defaultDir;
                apply(column, dir);
            };
            control.addEventListener('click', toggle);
            control.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggle();
            });
        }

        // Route header clicks held during DOM parsing through the corresponding
        // client-side control now that all native links have been replaced.
        applyInstantSort = target => {
            const column = sortable.find(candidate => candidate.index === target.columnIndex)
                || sortable.find(candidate => candidate.key === target.key);
            if (column) apply(column, target.dir || column.defaultDir);
        };
        sortReady = true;
        if (pendingSortTarget) {
            const target = pendingSortTarget;
            pendingSortTarget = null;
            applyInstantSort(target);
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
.pbaf-table-sort { appearance: none; border: 0; padding: 0; background: transparent; color: navy;
    font: inherit; font-weight: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 1px; }
.pbaf-table-sort:focus-visible { outline: 2px solid #2f6b3f; outline-offset: 2px; }
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

        // Wire instant table sorting now — synchronously, before the awaited
        // settings read below — so the click guard is released (and any held
        // click replayed) as early as possible, not after the storage round-trip.
        setupInstantTableSort({ headerRow, sections, preamble, rows, dataRows });

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

        bar.append(
            makeChip('beta', 'Has beta', ''),
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

    // Any unexpected failure after the click guard is installed must release
    // held sort clicks back to native navigation instead of swallowing them.
    const start = () => init().catch(error => {
        optOutInstantSort();
        console.error('Better Peakbagger ascent filter failed:', error);
    });

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
