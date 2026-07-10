// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fixture-based tests for the Ascent Beta Filter content script.
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPageWithBar } from './helpers/load-page.mjs';

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

    assert.equal(dataRows(dom).length, 3904);
    assert.equal(sectionRows(dom).length, 75);
    assert.equal(chipCount(dom, 'Has beta'), '1272');
    assert.equal(chipCount(dom, 'Trip report'), '1163');
    assert.equal(chipCount(dom, 'GPS track'), '221');
    assert.equal(chipCount(dom, 'Link'), '143');

    // "Has beta" is on by default.
    assert.equal(status(dom), 'Showing 1272 of 3904 ascents');
    assert.equal(visibleRows(dom).length, 1272);
    // Year sections with no visible rows collapse.
    assert.ok(sectionRows(dom).some(r => r.style.display === 'none'));
});

test('"Show all" reveals every row', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });

    dom.window.document.querySelector('.pbaf-reset').click();
    assert.equal(visibleRows(dom).length, 3904);
    assert.equal(status(dom), '3904 ascents');
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
    assert.ok(expected > 0 && expected < 1163);
    assert.equal(visibleRows(dom).length, expected);
});

test('"has beta" definition comes from settings (GPS-only)', async () => {
    const dom = await loadPageWithBar(RAINIER, {
        url: RAINIER_URL,
        settings: { betaTr: false, betaLink: false }
    });
    assert.equal(chipCount(dom, 'Has beta'), '221');
    assert.equal(visibleRows(dom).length, 221);
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
    assert.equal(chipCount(dom, 'Has beta'), '1272');
});

test('beta definition changes apply live via storage.onChanged', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });
    assert.equal(chipCount(dom, 'Has beta'), '1272');

    await dom.chrome.storage.sync.set({ bpbSettings: { betaTr: false, betaLink: false } });
    await new Promise(resolve => dom.window.setTimeout(resolve, 10));

    assert.equal(chipCount(dom, 'Has beta'), '221');
    assert.equal(visibleRows(dom).length, 221);
});

const dateAnchor = (dom, key) =>
    [...dom.window.document.querySelectorAll('table.gray th a')].find(a =>
        (new dom.window.URL(a.href)).searchParams.get('sort')?.toLowerCase() === key);
const dateTexts = dom => dataRows(dom).map(r => r.cells[1].textContent.trim());
const sectionLabels = dom => sectionRows(dom).map(r => r.textContent.trim());
const arrow = dom => dom.window.document.querySelector('.pbaf-sort-arrow');

test('[sort desc] toggles instantly: rows reversed, URL rewritten, no navigation', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });

    assert.equal(arrow(dom).textContent.trim(), '▲');
    const before = dateTexts(dom);
    const labelsBefore = sectionLabels(dom);

    dateAnchor(dom, 'ascentdated').click();

    assert.equal(dom.window.location.href, dateAnchor(dom, 'ascentdated').href);
    assert.equal(arrow(dom).textContent.trim(), '▼');
    assert.deepEqual(dateTexts(dom), before.slice().reverse());
    assert.deepEqual(sectionLabels(dom), labelsBefore.slice().reverse());
    // The active filter survives the reorder untouched.
    assert.equal(visibleRows(dom).length, 1272);
    assert.equal(dateAnchor(dom, 'ascentdated').getAttribute('aria-current'), 'true');

    // Toggle back restores the served order exactly.
    dateAnchor(dom, 'ascentdate').click();
    assert.deepEqual(dateTexts(dom), before);
    assert.equal(arrow(dom).textContent.trim(), '▲');
    assert.ok(dom.window.location.search.match(/sort=ascentdate(&|$)/i));
});

test('clicking the already-active direction is a no-op (no reload)', async () => {
    const dom = await loadPageWithBar(RAINIER, { url: RAINIER_URL });
    const before = dateTexts(dom);
    dateAnchor(dom, 'ascentdate').click();
    assert.deepEqual(dateTexts(dom), before);
    assert.equal(dom.window.location.href, RAINIER_URL);
});

test('a desc-served page starts with the ▼ indicator and reverses to asc', async () => {
    const dom = await loadPageWithBar('21500-y9998-sort-ascentdated.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=21500&u=ft&y=9998&sort=ascentdated'
    });
    assert.equal(arrow(dom).textContent.trim(), '▼');
    const before = dateTexts(dom);
    dateAnchor(dom, 'ascentdate').click();
    assert.deepEqual(dateTexts(dom), before.slice().reverse());
    assert.equal(arrow(dom).textContent.trim(), '▲');
});

test('non-date sorts are not hijacked', async () => {
    const dom = await loadPageWithBar('8241-y9999-sort-quality.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=8241&u=ft&y=9999&sort=Quality'
    });
    assert.equal(arrow(dom), null);
});

test('views whose sort links change the row set are not hijacked', async () => {
    // Default "Most Recent Year" view: page URL has no y=, links carry y=9998.
    const dom = await loadPageWithBar('2296-rainier-default-recent-year.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=2296'
    });
    assert.equal(arrow(dom), null);
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
