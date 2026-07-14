// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fixture-based tests for the Ascent Beta Filter content script.
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, loadPageWithBar, PAGE_FIXTURES, waitFor } from './helpers/load-page.mjs';

const RAINIER = '2296-rainier-y9999-sort-ascentdate.html';
const RAINIER_URL = 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=2296&sort=AscentDate&u=ft&y=9999';

const bar = dom => dom.window.document.getElementById('pbaf-bar');
const table = dom => dom.window.document.querySelector('table.gray');
const status = dom => dom.window.document.querySelector('.pbaf-status').textContent;
const chip = (dom, label) =>
    [...dom.window.document.querySelectorAll('.pbaf-chip')].find(c => c.textContent.includes(label));
const chipCount = (dom, label) => chip(dom, label).querySelector('.pbaf-count').textContent;

// Same row classification the content script uses: table.rows skips rows of
// nested icon tables; >1 cells excludes year-separator and stray empty rows.
const dataRows = dom => [...table(dom).rows].filter(r => r.cells.length > 1 && r.cells[0].tagName === 'TD');
const visibleRows = dom => dataRows(dom).filter(r => r.style.display === '');
const sectionRows = dom => [...table(dom).rows].filter(r => r.cells.length === 1);

test('parses the full Rainier table and filters to beta by default', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });

    assert.equal(dataRows(dom).length, 4145);
    assert.equal(sectionRows(dom).length, 75);
    assert.equal(chipCount(dom, 'Has beta'), '1339');
    assert.equal(chipCount(dom, 'Trip report'), '1224');
    assert.equal(chipCount(dom, 'GPS track'), '238');
    assert.equal(chipCount(dom, 'Link'), '151');

    // "Has beta" is on by default.
    assert.equal(status(dom), 'Showing 1339 of 4145 ascents');
    assert.equal(visibleRows(dom).length, 1339);
    // Year sections with no visible rows collapse.
    assert.ok(sectionRows(dom).some(r => r.style.display === 'none'));
});

test('filter chips form one group without a divider after Has beta', async () => {
    const dom = await loadPageWithBar('1039-default-full-columns.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1039'
    });

    assert.equal(bar(dom).querySelector('.pbaf-divider'), null);
    assert.deepEqual(
        [...bar(dom).querySelectorAll('.pbaf-chip')].map(control => control.childNodes[1].textContent.trim()),
        ['Has beta', 'Trip report', 'GPS track', 'Link']
    );
});

test('"Show all" reveals every row', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });

    dom.window.document.querySelector('.pbaf-reset').click();
    assert.equal(visibleRows(dom).length, 4145);
    assert.equal(status(dom), '4145 ascents');
    assert.ok(sectionRows(dom).every(r => r.style.display === ''));
});

test('trip-report chip applies its inline word threshold', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });

    // The threshold is per-page UI state, edited through the inline input.
    const wordsInput = dom.window.document.querySelector('.pbaf-words input');
    wordsInput.value = '100';
    wordsInput.dispatchEvent(new dom.window.Event('input'));

    chip(dom, 'Trip report').click();
    // Independent expectation: rows whose TR cell reports >= 100 words.
    // (Every such row also counts as beta, so stacking with "Has beta" is a no-op.)
    const expected = dataRows(dom).filter(r => {
        const m = /^TR-(\d+)/.exec(r.cells[4].textContent.trim());
        return m && parseInt(m[1], 10) >= 100;
    }).length;
    assert.ok(expected > 0 && expected < 1224);
    assert.equal(visibleRows(dom).length, expected);
});

test('"has beta" definition comes from settings (GPS-only)', async () => {
    const dom = await loadPageWithBar(RAINIER, {
        url: RAINIER_URL,
        settings: { betaTr: false, betaLink: false }
    });
    assert.equal(chipCount(dom, 'Has beta'), '238');
    assert.equal(visibleRows(dom).length, 238);
    assert.match(chip(dom, 'Has beta').title, /GPS track/);
    assert.doesNotMatch(chip(dom, 'Has beta').title, /trip report/);
});

test('beta trip-report signal honors its own word threshold', async () => {
    const dom = await loadPageWithBar(RAINIER, {
        url: RAINIER_URL,
        settings: { betaGps: false, betaLink: false, betaTrMinWords: 100 }
    });
    const expected = dataRows(dom).filter(r => {
        const m = /^TR-(\d+)/.exec(r.cells[4].textContent.trim());
        return m && parseInt(m[1], 10) >= 100;
    }).length;
    assert.ok(expected > 0);
    assert.equal(chipCount(dom, 'Has beta'), String(expected));
    assert.equal(visibleRows(dom).length, expected);
    assert.match(chip(dom, 'Has beta').title, /≥ 100 words/);
});

test('an all-off beta definition falls back to all-on', async () => {
    const dom = await loadPageWithBar(RAINIER, {
        url: RAINIER_URL,
        settings: { betaTr: false, betaGps: false, betaLink: false }
    });
    assert.equal(chipCount(dom, 'Has beta'), '1339');
});

test('beta definition changes apply live via storage.onChanged', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });
    assert.equal(chipCount(dom, 'Has beta'), '1339');

    await dom.chrome.storage.sync.set({ bpbSettings: { betaTr: false, betaLink: false } });
    await new Promise(resolve => dom.window.setTimeout(resolve, 10));

    assert.equal(chipCount(dom, 'Has beta'), '238');
    assert.equal(visibleRows(dom).length, 238);
});

const dateTexts = dom => dataRows(dom).map(r => r.cells[1].textContent.trim());
const sectionLabels = dom => sectionRows(dom).map(r => r.textContent.trim());
const tableSortControl = (dom, label) =>
    [...dom.window.document.querySelectorAll('.pbaf-table-sort')]
        .find(control => control.firstChild.textContent.trim() === label);
const sortControl = dom => tableSortControl(dom, 'Ascent Date');
const arrow = dom => sortControl(dom)?.querySelector('.pbaf-sort-arrow') || null;

test('the date header is one persistent toggle with no backend links', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });

    assert.equal(arrow(dom).textContent.trim(), '▲');
    assert.equal(sortControl(dom).textContent.trim(), 'Ascent Date ▲');
    assert.equal(sortControl(dom).tagName, 'BUTTON');
    assert.equal(sortControl(dom).type, 'button');
    assert.equal(sortControl(dom).closest('th').getAttribute('aria-sort'), 'ascending');
    assert.equal(sortControl(dom).closest('th').querySelectorAll('a[href]').length, 0);
    const before = dateTexts(dom);
    const labelsBefore = sectionLabels(dom);

    sortControl(dom).click();

    assert.equal(arrow(dom).textContent.trim(), '▼');
    assert.equal(sortControl(dom).closest('th').getAttribute('aria-sort'), 'descending');
    assert.match(dom.window.location.search, /sort=ascentdated(&|$)/i);
    assert.deepEqual(dateTexts(dom), before.slice().reverse());
    assert.deepEqual(sectionLabels(dom), labelsBefore.slice().reverse());
    // The active filter survives the reorder untouched.
    assert.equal(visibleRows(dom).length, 1339);

    // Clicking the same control restores the served order exactly.
    sortControl(dom).click();
    assert.deepEqual(dateTexts(dom), before);
    assert.equal(arrow(dom).textContent.trim(), '▲');
    assert.ok(dom.window.location.search.match(/sort=ascentdate(&|$)/i));
});

test('capture guard intercepts native header sort links but lets year links navigate', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });
    const { document, MouseEvent } = dom.window;

    // Recreate the native header link that exists before initialization replaces
    // the pair. The document-start guard must prevent its navigation and route
    // the requested direction through the now-ready DOM sorter.
    const nativeHeader = document.createElement('th');
    nativeHeader.innerHTML = '<a href="?pid=2296&sort=ascentdated&u=ft&y=9998">Ascent Date</a>';
    document.body.appendChild(nativeHeader);
    const header = nativeHeader.querySelector('a');
    const headerEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    header.dispatchEvent(headerEvent);
    assert.equal(headerEvent.defaultPrevented, true);
    assert.equal(arrow(dom).textContent.trim(), '▼');

    // A year-jump-style link is outside a th, so the guard must leave it alone.
    const jump = document.createElement('a');
    jump.href = 'PeakAscents.aspx?pid=2296&sort=ascentdate&u=ft&y=1999';
    jump.textContent = '1999';
    document.body.appendChild(jump);
    let preventedByGuard = null;
    jump.addEventListener('click', event => {
        preventedByGuard = event.defaultPrevented;
        event.preventDefault(); // Keep jsdom from attempting a real navigation.
    });
    const jumpEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    jump.dispatchEvent(jumpEvent);
    assert.equal(preventedByGuard, false);
});

test('a desc-served page starts with the ▼ indicator and reverses to asc', async () => {
    const dom = await loadPageWithBar('21500-y9998-sort-ascentdated.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=21500&u=ft&y=9998&sort=ascentdated'
    });
    assert.equal(arrow(dom).textContent.trim(), '▼');
    const before = dateTexts(dom);
    sortControl(dom).click();
    assert.deepEqual(dateTexts(dom), before.slice().reverse());
    assert.equal(arrow(dom).textContent.trim(), '▲');
});

test('a non-date-served page replaces backend links and preserves its active sort', async () => {
    const dom = await loadPageWithBar('8241-y9999-sort-quality.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=8241&u=ft&y=9999&sort=Quality'
    });

    assert.ok(sortControl(dom));
    assert.equal(tableSortControl(dom, 'Qlty').closest('th').getAttribute('aria-sort'), 'descending');
    assert.equal(tableSortControl(dom, 'Qlty').querySelector('.pbaf-sort-arrow').textContent.trim(), '▼');
    assert.equal(table(dom).querySelectorAll('th a[href]').length, 0);
});

test('all native sortable headers become client-side controls', async () => {
    const dom = await loadPageWithBar('1039-default-full-columns.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1039'
    });
    const header = [...table(dom).rows].find(row => row.cells[0]?.tagName === 'TH');
    const labels = [...header.querySelectorAll('.pbaf-table-sort')]
        .map(control => control.firstChild.textContent.trim());

    assert.deepEqual(labels, [
        'Climber', 'Ascent Date', 'Type', 'GPS', 'TR-Words', 'Route',
        'Gain-Ft', 'Mi', 'Route Icons', 'Gear Icons', 'Qlty', 'Link'
    ]);
    assert.equal(header.querySelectorAll('a[href]').length, 0);
    assert.ok([...header.querySelectorAll('.pbaf-table-sort')].every(control => control.type === 'button'));
});

test('text and numeric controls sort existing rows in both directions', async () => {
    const dom = await loadPageWithBar('1039-default-full-columns.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1039'
    });
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const climbers = () => dataRows(dom).map(row => row.cells[0].textContent.trim());
    const words = () => dataRows(dom).map(row => {
        const match = /TR-(\d+)/.exec(row.cells[4].textContent.trim());
        return match ? parseInt(match[1], 10) : 0;
    });
    const isOrdered = (values, compare) => values.every((value, index) =>
        index === 0 || compare(values[index - 1], value) <= 0
    );

    tableSortControl(dom, 'Climber').click();
    assert.ok(isOrdered(climbers(), (left, right) => collator.compare(left, right)));
    assert.ok(sectionRows(dom).every(row => row.hidden));

    tableSortControl(dom, 'Climber').click();
    assert.ok(isOrdered(climbers(), (left, right) => collator.compare(right, left)));

    tableSortControl(dom, 'TR-Words').click();
    assert.ok(isOrdered(words(), (left, right) => right - left));
    tableSortControl(dom, 'TR-Words').click();
    assert.ok(isOrdered(words(), (left, right) => left - right));
});

test('switching back to date restores exact rows and year separators', async () => {
    const dom = await loadPageWithBar('1039-default-full-columns.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=1039'
    });
    const datesBefore = dateTexts(dom);
    const sectionsBefore = sectionLabels(dom);

    tableSortControl(dom, 'GPS').click();
    assert.ok(sectionRows(dom).every(row => row.hidden));

    sortControl(dom).click();
    assert.deepEqual(dateTexts(dom), datesBefore);
    assert.deepEqual(sectionLabels(dom), sectionsBefore);
    assert.ok(sectionRows(dom).every(row => !row.hidden));
});

test('default views sort their current rows without adopting backend-link params', async () => {
    // The native links add y=9998, but the current table is already a complete
    // sortable row set. Reordering it must preserve the default-view URL.
    const dom = await loadPageWithBar('2296-rainier-default-recent-year.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=2296'
    });
    const before = dateTexts(dom);
    sortControl(dom).click();
    assert.deepEqual(dateTexts(dom), before.slice().reverse());
    assert.equal(new dom.window.URL(dom.window.location.href).searchParams.get('y'), null);
    assert.equal(new dom.window.URL(dom.window.location.href).searchParams.get('sort'), 'ascentdated');
});

test('personal ClimbListC pages retain the beta bar and persistent date toggle', async () => {
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=40786'
    });
    await waitFor(dom, () => bar(dom) && sortControl(dom));

    assert.ok(bar(dom));
    assert.match(status(dom), /^Showing \d+ of 38 ascents$/);
    assert.equal(sortControl(dom).textContent.trim(), 'Ascent Date ▲');
    assert.equal(sortControl(dom).tabIndex, 0);
    const visibleBefore = visibleRows(dom).length;
    const before = dateTexts(dom);
    sortControl(dom).dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: ' ', bubbles: true, cancelable: true
    }));
    assert.deepEqual(dateTexts(dom), before.slice().reverse());
    assert.equal(visibleRows(dom).length, visibleBefore);
    const url = new dom.window.URL(dom.window.location.href);
    assert.equal(url.searchParams.get('cid'), '40786');
    assert.equal(url.searchParams.get('y'), null);
    assert.equal(url.searchParams.get('sort'), 'ascentdated');
});

test('personal all-years date URLs toggle in place', async () => {
    const dom = await loadPage('climber-ascents.html', {
        fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=40786&sort=AscentDate&u=ft&j=-1&y=9999'
    });
    await waitFor(dom, () => bar(dom) && sortControl(dom));

    assert.ok(bar(dom));
    const before = dateTexts(dom);
    sortControl(dom).click();
    assert.deepEqual(dateTexts(dom), before.slice().reverse());
    const url = new dom.window.URL(dom.window.location.href);
    assert.equal(url.searchParams.get('y'), '9999');
    assert.equal(url.searchParams.get('j'), '-1');
    assert.equal(url.searchParams.get('sort'), 'ascentdated');
});

test('renders on a non-date sort (flat table, no year sections)', async () => {
    const dom = await loadPageWithBar('8241-y9999-sort-quality.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=8241&u=ft&y=9999&sort=Quality'
    });
    assert.ok(bar(dom));
    assert.equal(sectionRows(dom).length, 0);
});

test('renders on the default "Most Recent Year" view', async () => {
    const dom = await loadPageWithBar('2296-rainier-default-recent-year.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=2296'
    });
    assert.ok(bar(dom));
});
