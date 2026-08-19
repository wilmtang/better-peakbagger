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
const chip = (dom, label) => [...dom.window.document.querySelectorAll('.pbaf-chip')]
    .find(control => control.textContent.includes(label));
const chipCount = (dom, label) => chip(dom, label).querySelector('.pbaf-count').textContent;
const sortControl = dom => [...dom.window.document.querySelectorAll('.pbaf-table-sort')]
    .find(control => control.firstChild.textContent.trim() === 'Ascent Date');

test('the full Rainier table filters and sorts completely', async () => {
    const displayWrites = { rows: 0, sections: 0 };
    const frames = { scheduled: 0, painted: 0 };
    const dom = await loadPageWithBar(FIXTURE, {
        url: URL,
        prepare: page => {
            const requestFrame = page.window.requestAnimationFrame.bind(page.window);
            page.window.requestAnimationFrame = callback => {
                frames.scheduled++;
                return requestFrame(timestamp => {
                    frames.painted++;
                    callback(timestamp);
                });
            };
        },
    });

    const instrumentDisplay = (style, key) => Object.defineProperty(style, 'display', {
        configurable: true,
        get: () => style.getPropertyValue('display'),
        set: value => {
            displayWrites[key]++;
            if (value) style.setProperty('display', value);
            else style.removeProperty('display');
        },
    });
    dataRows(dom).forEach(row => instrumentDisplay(row.style, 'rows'));
    sectionRows(dom).forEach(row => instrumentDisplay(row.style, 'sections'));

    assert.equal(dataRows(dom).length, 4145);
    assert.equal(sectionRows(dom).length, 75);
    assert.equal(chipCount(dom, 'Has beta'), '1339');
    assert.equal(chipCount(dom, 'Trip report'), '1224');
    assert.equal(chipCount(dom, 'GPS track'), '238');
    assert.equal(chipCount(dom, 'Link'), '151');
    assert.equal(visibleRows(dom).length, 4145,
        'first use must preserve every production-scale host row');
    assert.ok(sectionRows(dom).every(row => row.style.display === ''));

    chip(dom, 'Has beta').click();
    assert.equal(visibleRows(dom).length, 1339);
    assert.ok(sectionRows(dom).some(row => row.style.display === 'none'));
    dom.window.document.querySelector('.pbaf-reset').click();
    assert.equal(visibleRows(dom).length, 4145);
    assert.ok(sectionRows(dom).every(row => row.style.display === ''));

    chip(dom, 'Trip report').click();
    const beforeRows = dataRows(dom).map(row => row.style.display);
    const beforeSections = sectionRows(dom).map(row => row.style.display);
    displayWrites.rows = 0;
    displayWrites.sections = 0;
    frames.scheduled = 0;
    frames.painted = 0;
    const wordsInput = dom.window.document.querySelector('.pbaf-words input');
    for (const value of ['1', '10', '100']) {
        wordsInput.value = value;
        wordsInput.dispatchEvent(new dom.window.Event('input'));
    }
    assert.equal(frames.scheduled, 1, 'one typing burst schedules one render frame');
    assert.equal(JSON.parse(dom.window.localStorage.getItem('pbAscentBetaFilter.v1')).minWords, 100,
        'the accessible control state is persisted immediately');
    await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    assert.equal(frames.painted, 2, 'the second frame is only the test wait, not another product render');

    const afterRows = dataRows(dom).map(row => row.style.display);
    const afterSections = sectionRows(dom).map(row => row.style.display);
    assert.equal(displayWrites.rows,
        beforeRows.filter((value, index) => value !== afterRows[index]).length,
        'only rows whose visibility changed receive a style write');
    assert.equal(displayWrites.sections,
        beforeSections.filter((value, index) => value !== afterSections[index]).length,
        'only sections whose visibility changed receive a style write');

    displayWrites.rows = 0;
    displayWrites.sections = 0;
    wordsInput.dispatchEvent(new dom.window.Event('input'));
    await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    assert.equal(displayWrites.rows, 0, 'a no-op threshold performs no row style writes');
    assert.equal(displayWrites.sections, 0, 'a no-op threshold performs no section style writes');

    dom.window.document.querySelector('.pbaf-reset').click();
    assert.equal(visibleRows(dom).length, 4145);

    const datesBefore = dateTexts(dom);
    const sectionsBefore = sectionLabels(dom);
    sortControl(dom).click();
    assert.deepEqual(dateTexts(dom), datesBefore.slice().reverse());
    assert.deepEqual(sectionLabels(dom), sectionsBefore.slice().reverse());
    assert.equal(visibleRows(dom).length, 4145);
});
