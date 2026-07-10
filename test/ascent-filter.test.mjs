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

test('trip-report chip applies the settings word threshold', async () => {
    const dom = await loadPageWithBar(RAINIER, {
        url: RAINIER_URL,
        settings: { defaultMinTrWords: 100 }
    });

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
