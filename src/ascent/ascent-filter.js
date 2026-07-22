// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — ascent-list filter and instant table-sort content script.
// Runs in the default isolated content-script world: it only reads list-table
// DOM, reorders existing rows, and persists PeakAscents chip preferences in the
// page's (same-origin) localStorage, so no page-global access is needed. The
// Buddy List reuses only the sorter; it has no beta data or filter surface.

import { settings as S } from '../settings/settings.js';
import { favoriteClimbers as F } from '../favorites/favorite-climbers.js';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.js';
import { fetchPeakbaggerDocument } from '../peakbagger/peakbagger-request.js';
import { numericParam, ownerClimberId } from '../profile/profile-backup-core.js';

    const pageParams = new URLSearchParams(location.search);
    const pagePathname = location.pathname.toLowerCase();
    const isAscentListPage = /\/climber\/(?:peakascents|climblistc)\.aspx$/.test(pagePathname);
    const isPeakAscentsPage = pagePathname.endsWith('/climber/peakascents.aspx');
    const isBuddyListPage = pagePathname.endsWith('/report/report.aspx')
        && (pageParams.get('r') || '').toLowerCase() === 'b';

    // This script runs at document_start; kick off the one settings read now, at
    // module load, so both the newest-first auto-sort and the "has beta"
    // definition reuse it instead of adding a storage round-trip to the critical
    // path. Buddy/report pages do not need ascent settings. Resolves to the
    // cleaned settings, or null on any read failure.
    const settingsPromise = S && isAscentListPage
        ? S.get().catch(() => null)
        : Promise.resolve(null);
    const favoritesPromise = isPeakAscentsPage
        ? chrome.storage.local.get([F.FAVORITES_KEY, F.BUDDY_CACHE_KEY]).catch(() => ({}))
        : Promise.resolve({});

    // Chip on/off states and the Trip report word-count threshold are per-page
    // UI state kept in page localStorage (below). The shared extension settings
    // (chrome.storage) own only the cross-cutting "has beta" definition.

    const STORAGE_KEY = 'pbAscentBetaFilter.v1';
    const DEFAULT_STATE = { beta: true, tr: false, minWords: 1, gps: false, link: false, fav: false };

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
        if (!isAscentListPage && !isBuddyListPage) return null;
        const anchor = target && target.closest ? target.closest('a[href]') : null;
        if (!anchor) return null;
        const header = anchor.closest('th');
        if (!header) return null;
        let url;
        try { url = new URL(anchor.href, location.href); } catch (e) { return null; }
        const rawKey = url.searchParams.get('sort') || '';
        const isBuddyHeader = isBuddyListPage && !!header.closest('#RGridView');
        if (!rawKey && !isBuddyHeader) return null;
        const lowerKey = rawKey.toLowerCase();
        const fallbackKey = normalize(header.textContent).toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (!lowerKey && !fallbackKey) return null;
        return {
            href: anchor.href,
            columnIndex: header.cellIndex,
            key: lowerKey === 'ascentdated' ? 'ascentdate' : (lowerKey || fallbackKey),
            dir: lowerKey === 'ascentdated' ? 'desc' : (lowerKey === 'ascentdate' ? 'asc' : null)
        };
    };

    let sortReady = false;       // instant sorter is wired and owns these clicks
    let sortOptOut = false;      // page isn't a candidate: let clicks navigate
    let pendingSortTarget = null;// a click held before the sorter decided
    let applyInstantSort = null; // (target) => reorder in the DOM, set once ready
    let userSorted = false;      // a header sort the user chose must beat the auto-flip

    document.addEventListener('click', event => {
        const target = tableSortTarget(event.target);
        if (!target || sortOptOut) return; // not ours, or navigation is allowed
        // Record the intent as soon as the click is captured — this fires for
        // clicks held before the sorter is wired AND for the later replay, so
        // the newest-first auto-flip never fights a sort the user picked.
        userSorted = true;
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
    const setupInstantTableSort = ({
        headerRow, sections, preamble, rows, dataRows, sortEveryHeader = false
    }) => {
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
            const rawKey = primary ? keyOf(primary) : '';
            if (!rawKey && !sortEveryHeader) return [];
            const label = normalize(primary && primary.textContent) || normalize(cell.textContent);
            const key = rawKey.toLowerCase()
                || label.toLowerCase().replace(/[^a-z0-9]+/g, '');
            if (!key || !label) return [];
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
        if (!sortable.length) {
            optOutInstantSort();
            return false;
        }

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
            let varied = false;
            for (let i = 1; i < dataRows.length && (ascending || descending); i++) {
                const compared = compareRecords(dataRows[i - 1], dataRows[i], column, 'asc', false);
                if (compared) varied = true;
                if (compared > 0) ascending = false;
                if (compared < 0) descending = false;
            }
            if (varied && ascending) return 'asc';
            if (varied && descending) return 'desc';
            return null;
        };

        const requestedSort = (new URLSearchParams(location.search).get('sort') || '').toLowerCase();
        const urlSort = requestedSort || (sortEveryHeader ? '' : 'ascentdate');
        const dateServed = !sortEveryHeader && (urlSort === 'ascentdate' || urlSort === 'ascentdated');
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
        if (sortEveryHeader) {
            // GridView pages do not expose their active sort in the URL. Mark a
            // column active only when its displayed values prove a direction;
            // all-equal action columns are not evidence of a served sort.
            for (const column of sortable) {
                const direction = inferDirection(column);
                if (!direction) continue;
                currentColumn = column;
                currentDir = direction;
                break;
            }
        } else if (dateServed) {
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
            if (column.key === 'ascentdate' && !sortEveryHeader) {
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
        return true;
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
.pbaf-chip:disabled { cursor: default; opacity: .55; border-color: #c8c8c2; color: #666; }
.pbaf-chip:disabled:hover { border-color: #c8c8c2; color: #666; }
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

    const cacheRenderedBuddyList = async () => {
        const pageCid = numericParam(location.href, 'cid', document.baseURI);
        const ownCid = ownerClimberId(document);
        // The signed-in report endpoint omits cid and derives the owner from
        // the session. An explicit cid must still match that owner so viewing
        // another climber's report can never replace the local cache.
        if (ownCid == null || (pageCid != null && pageCid !== ownCid)) return;
        const entries = F.parseBuddyDocument(document);
        await chrome.storage.local.set({
            [F.BUDDY_CACHE_KEY]: { ownerCid: ownCid, entries, fetchedAt: Date.now() }
        });
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
        if (!isAscentListPage && !isBuddyListPage) return optOutInstantSort();

        const table = document.querySelector(isBuddyListPage ? '#RGridView' : 'table.gray');
        if (!table) return optOutInstantSort();
        if (table.dataset.bpbInstantSort === 'ready') return;

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
                climberId: (() => {
                    const anchor = Array.from(row.querySelectorAll('a[href]')).find(candidate => {
                        try { return /\/climber\/climber\.aspx$/i.test(new URL(candidate.href, document.baseURI).pathname); }
                        catch (e) { return false; }
                    });
                    return anchor ? numericParam(anchor.href, 'cid', document.baseURI) : null;
                })(),
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
        // Cache even an empty signed-in Buddy List. Zero rows is valid data on
        // this report, not a reason to preserve an older non-empty cache.
        if (isBuddyListPage) void cacheRenderedBuddyList().catch(() => {});
        if (!dataRows.length) return optOutInstantSort();

        // Wire instant table sorting now — synchronously, before the awaited
        // settings read below — so the click guard is released (and any held
        // click replayed) as early as possible, not after the storage round-trip.
        const sorterMounted = setupInstantTableSort({
            headerRow, sections, preamble, rows, dataRows,
            sortEveryHeader: isBuddyListPage
        });
        if (!sorterMounted) return;
        table.dataset.bpbInstantSort = 'ready';

        // Buddy rows have no trip-report, GPS, or external-link beta signals.
        // Sorting is the complete feature on this surface: do not mount a
        // misleading filter/compact-view notice or apply ascent-list settings.
        if (isBuddyListPage) {
            return;
        }

        // Newest-ascents-first (opt-in). Flip a default oldest-first list to
        // descending once settings resolve — the rows are already in the DOM, so
        // this lands within a frame. Runs before the compact-view return so it
        // applies to date-only lists too.
        void settingsPromise.then(s => {
            if (!s || s.betaSortDateDesc !== true) return;
            if (new URLSearchParams(location.search).has('sort')) return; // an explicit URL sort wins
            if (userSorted || !applyInstantSort) return;                  // never fight a user's click
            applyInstantSort({ columnIndex: -1, key: 'ascentdate', dir: 'desc' });
        });

        if (columns.tr === null && columns.gps === null && columns.link === null) {
            renderCompactNotice(table);
            return;
        }

        const total = dataRows.length;
        const counts = {
            beta: dataRows.filter(r => r.beta).length,
            tr: dataRows.filter(r => r.words > 0).length,
            gps: dataRows.filter(r => r.gps).length,
            link: dataRows.filter(r => r.link).length,
            fav: 0,
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
        let currentSettings = null;
        if (S) {
            try {
                const s = await settingsPromise;
                if (s) {
                    currentSettings = s;
                    betaCfg = betaCfgFrom(s);
                }
            } catch (e) { /* fall back to defaults */ }
        }
        const initialFavorites = await favoritesPromise;
        const ownCid = ownerClimberId(document);
        const cacheForOwner = value => {
            const cache = F.cleanBuddyCache(value);
            return cache && ownCid != null && cache.ownerCid !== ownCid ? null : cache;
        };
        let favoritesSource = currentSettings && currentSettings.favoritesSource === 'custom' ? 'custom' : 'buddies';
        let favorites = F.cleanFavorites(initialFavorites[F.FAVORITES_KEY]);
        let buddyCache = cacheForOwner(initialFavorites[F.BUDDY_CACHE_KEY]);
        let favoriteIds = new Set();
        let favoriteAvailable = false;
        let favoriteLoadError = '';
        let buddyRefreshPromise = null;
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
            const labelEl = document.createElement('span');
            labelEl.className = 'pbaf-chip-label';
            labelEl.textContent = label;
            const count = document.createElement('span');
            count.className = 'pbaf-count';
            count.textContent = String(counts[key]);
            button.append(tick, labelEl, count);

            button.addEventListener('click', () => {
                state[key] = !state[key];
                saveState(state);
                render();
                if (key === 'fav' && state.fav) void refreshBuddyCache();
            });
            chips[key] = button;
            return button;
        };

        const favoriteTooltip = () => {
            if (favoriteLoadError) return favoriteLoadError;
            if (favoritesSource === 'custom') {
                return favorites.entries.length
                    ? 'Only ascents logged by climbers in your custom favorites list. Remembered across visits.'
                    : "No favorite climbers yet. Add them from a climber's page or in the extension settings.";
            }
            if (!buddyCache) {
                return ownCid == null
                    ? 'Sign in to Peakbagger to load your Buddy List.'
                    : 'Load your Peakbagger Buddy List and show only ascents logged by those climbers.';
            }
            if (!buddyCache.entries.length) return 'Your Peakbagger Buddy List is empty.';
            return F.isFresh(buddyCache)
                ? 'Only ascents logged by climbers on your Peakbagger Buddy List. Remembered across visits.'
                : 'Using your saved Buddy List while a fresh copy loads in the background.';
        };

        const refreshFavorites = () => {
            favoriteIds = F.favoriteSet(favoritesSource, favorites, buddyCache);
            favoriteAvailable = favoriteIds.size > 0;
            counts.fav = 0;
            for (const record of dataRows) {
                record.fav = record.climberId != null && favoriteIds.has(record.climberId);
                if (record.fav) counts.fav++;
            }
            if (chips.fav) {
                chips.fav.querySelector('.pbaf-chip-label').textContent = favoritesSource === 'custom'
                    ? 'Fav climbers'
                    : 'Climbing buddies';
                const count = chips.fav.querySelector('.pbaf-count');
                const countKnown = favoritesSource === 'custom' || buddyCache !== null;
                count.hidden = !countKnown;
                count.textContent = countKnown ? String(counts.fav) : '';
                chips.fav.title = favoriteTooltip();
                const canInitialLoad = favoritesSource === 'buddies'
                    && !buddyCache && ownCid != null && !favoriteLoadError;
                chips.fav.disabled = !favoriteAvailable && !canInitialLoad;
            }
        };

        const refreshBuddyCache = () => {
            if (!isPeakAscentsPage || favoritesSource !== 'buddies' || !state.fav
                || ownCid == null || F.isFresh(buddyCache) || buddyRefreshPromise) return buddyRefreshPromise;
            favoriteLoadError = '';
            if (chips.fav) chips.fav.title = buddyCache
                ? 'Using your saved Buddy List while a fresh copy loads in the background.'
                : 'Loading your Peakbagger Buddy List…';
            const url = F.buddyListUrl(ownCid, location.origin);
            buddyRefreshPromise = (async () => {
                const result = await fetchPeakbaggerDocument(url, { kind: 'buddies' });
                if (result.kind !== 'ok') throw result.error;
                const responseOwner = ownerClimberId(result.document);
                if (responseOwner !== ownCid) {
                    throw PeakbaggerError.failure('identity-mismatch', { resource: 'buddies' });
                }
                const nextCache = {
                    ownerCid: ownCid,
                    entries: F.parseBuddyDocument(result.document),
                    fetchedAt: Date.now(),
                };
                buddyCache = nextCache;
                try {
                    await chrome.storage.local.set({ [F.BUDDY_CACHE_KEY]: nextCache });
                } catch {
                    favoriteLoadError = PeakbaggerError.message(
                        PeakbaggerError.failure('storage', { resource: 'buddies' })
                    );
                }
            })().catch(error => {
                const message = PeakbaggerError.message(error && error.code
                    ? error
                    : PeakbaggerError.failure('network', { resource: 'buddies' }));
                favoriteLoadError = buddyCache ? `Using your saved Buddy List. ${message}` : message;
            }).finally(() => {
                buddyRefreshPromise = null;
                refreshFavorites();
                render();
            });
            return buddyRefreshPromise;
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
            state.fav = false;
            saveState(state);
            render();
        });

        const filterControls = [
            makeChip('beta', 'Has beta', ''),
            makeChip('tr', 'Trip report',
                'Only ascents with a written trip report of at least the chosen word count.'),
            wordsWrap,
            makeChip('gps', 'GPS track',
                'Only ascents with a GPS track.'),
            makeChip('link', 'Link',
                'Only ascents with an external link (blog, Strava, forum, ...).'),
        ];
        if (isPeakAscentsPage) filterControls.push(makeChip('fav', '', ''));
        bar.append(
            ...filterControls,
            spacer,
            statusEl,
            resetButton
        );
        refreshBeta();
        refreshFavorites();

        const render = () => {
            for (const [key, chip] of Object.entries(chips)) {
                const active = !!state[key] && (key !== 'fav' || favoriteAvailable);
                chip.setAttribute('aria-pressed', String(active));
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
                if (state.fav && favoriteAvailable && !record.fav) visible = false;
                record.visible = visible;
                record.row.style.display = visible ? '' : 'none';
                if (visible) shown++;
            }
            for (const section of sections) {
                section.row.style.display = section.items.some(item => item.visible) ? '' : 'none';
            }

            const anyActive = state.beta || state.tr || state.gps || state.link
                || (state.fav && favoriteAvailable);
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
        if (state.fav) void refreshBuddyCache();

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            let changed = false;
            if (changes[F.FAVORITES_KEY]) {
                favorites = F.cleanFavorites(changes[F.FAVORITES_KEY].newValue);
                changed = true;
            }
            if (changes[F.BUDDY_CACHE_KEY]) {
                buddyCache = cacheForOwner(changes[F.BUDDY_CACHE_KEY].newValue);
                favoriteLoadError = '';
                changed = true;
            }
            if (!changed) return;
            refreshFavorites();
            render();
        });

        // Re-apply the beta definition if it changes in the options page /
        // another tab. (The Trip report word threshold is local UI state.)
        if (S && S.subscribe) {
            S.subscribe(settings => {
                const nextBeta = betaCfgFrom(settings);
                const nextSource = settings.favoritesSource === 'custom' ? 'custom' : 'buddies';
                let changed = false;
                if (JSON.stringify(nextBeta) !== JSON.stringify(betaCfg)) {
                    betaCfg = nextBeta;
                    refreshBeta();
                    changed = true;
                }
                if (nextSource !== favoritesSource) {
                    favoritesSource = nextSource;
                    favoriteLoadError = '';
                    refreshFavorites();
                    changed = true;
                }
                if (changed) render();
                if (state.fav) void refreshBuddyCache();
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
