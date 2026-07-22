// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The masked Rainier capture is a 2.99 MB, 4,145-row stress fixture. Focused
// filter and sort behavior stays in npm test on the small full-column fixture;
// this separate gate proves the same built bundle handles the production-scale
// DOM without making every local test run parse it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPageWithBar } from '../../helpers/load-page.mjs';

const FIXTURE = '2296-rainier-y9999-sort-ascentdate.html';
const URL = 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=2296&sort=AscentDate&u=ft&y=9999';
const table = dom => dom.window.document.querySelector('table.gray');
const dataRows = dom => [...table(dom).rows].filter(row =>
    row.cells.length > 1 && row.cells[0].tagName === 'TD');
const visibleRows = dom => dataRows(dom).filter(row => row.style.display === '');
const sectionRows = dom => [...table(dom).rows].filter(row => row.cells.length === 1);
const dateTexts = dom => dataRows(dom).map(row => row.cells[1].textContent.trim());
const sectionLabels = dom => sectionRows(dom).map(row => row.textContent.trim());
const chipCount = (dom, label) => [...dom.window.document.querySelectorAll('.pbaf-chip')]
    .find(chip => chip.textContent.includes(label)).querySelector('.pbaf-count').textContent;
const sortControl = dom => [...dom.window.document.querySelectorAll('.pbaf-table-sort')]
    .find(control => control.firstChild.textContent.trim() === 'Ascent Date');

test('the full Rainier table filters and sorts completely', async () => {
    const dom = await loadPageWithBar(FIXTURE, { url: URL });

    assert.equal(dataRows(dom).length, 4145);
    assert.equal(sectionRows(dom).length, 75);
    assert.equal(chipCount(dom, 'Has beta'), '1339');
    assert.equal(chipCount(dom, 'Trip report'), '1224');
    assert.equal(chipCount(dom, 'GPS track'), '238');
    assert.equal(chipCount(dom, 'Link'), '151');
    assert.equal(visibleRows(dom).length, 1339);
    assert.ok(sectionRows(dom).some(row => row.style.display === 'none'));

    dom.window.document.querySelector('.pbaf-reset').click();
    assert.equal(visibleRows(dom).length, 4145);
    assert.ok(sectionRows(dom).every(row => row.style.display === ''));

    const datesBefore = dateTexts(dom);
    const sectionsBefore = sectionLabels(dom);
    sortControl(dom).click();
    assert.deepEqual(dateTexts(dom), datesBefore.slice().reverse());
    assert.deepEqual(sectionLabels(dom), sectionsBefore.slice().reverse());
    assert.equal(visibleRows(dom).length, 4145);
});
