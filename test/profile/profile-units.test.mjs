// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';

const headers = doc => [...doc.querySelectorAll('#StatsLabel th')].filter(node => /^(Elev|Prom)-/.test(node.textContent));
const reading = heading => heading.parentElement.nextElementSibling.cells[heading.cellIndex];
const load = options => loadPage('climber-home.html', { fixtures: PAGE_FIXTURES,
    url: 'https://www.peakbagger.com/climber/climber.aspx?cid=900002',
    bundles: ['content/profile-units.js'], ...options });
const change = (dom, settings) => dom.chrome.storage.sync.set({ bpbSettings: settings });

test('profile elevation and prominence follow metric BPB units on another climber and your own profile', async t => {
    for (const cid of [900001, 900002]) {
        const dom = await load({ url: `https://www.peakbagger.com/climber/climber.aspx?cid=${cid}`,
            settings: { units: 'metric' } });
        t.after(() => dom.window.close());
        const [elev, prom] = headers(dom.window.document);
        await waitFor(dom, () => elev.textContent === 'Elev-m');
        assert.equal(reading(elev).textContent, '4420');
        assert.equal(prom.textContent, 'Prom-m');
        assert.equal(reading(prom).textContent, '4036');
        assert.equal(elev.parentElement.nextElementSibling.cells[0].querySelector('a').textContent, 'Sample Peak 1');
        assert.match(dom.window.document.getElementById('StatsLabel').textContent, /Vertical Gain:\s*4,270 ft/);
    }
});

test('metric native profiles use the elevation override and restore their original nodes without rounding drift', async t => {
    let original;
    const dom = await load({ settings: { units: 'metric', elevationUnits: 'imperial' }, prepare(page) {
        const [elev, prom] = headers(page.window.document);
        elev.textContent = 'Elev-m';
        prom.textContent = 'Prom-m';
        reading(elev).textContent = '4391.0';
        reading(prom).innerHTML = '4,036<span style="visibility:hidden">.0</span>';
        original = reading(prom).lastChild;
    } });
    t.after(() => dom.window.close());
    const [elev, prom] = headers(dom.window.document);
    await waitFor(dom, () => elev.textContent === 'Elev-ft');
    assert.equal(reading(elev).textContent, '14406');
    assert.equal(reading(prom).textContent, '13241');
    for (let i = 0; i < 3; i++) {
        await change(dom, { units: 'imperial', elevationUnits: 'metric' });
        assert.equal(elev.textContent, 'Elev-m');
        assert.equal(reading(elev).textContent, '4391.0');
        assert.equal(reading(prom).lastChild, original);
        await change(dom, { units: 'imperial' });
        assert.equal(reading(elev).textContent, '14406');
    }
    await change(dom, { units: 'auto' });
    assert.equal(elev.textContent, 'Elev-m');
    assert.equal(prom.textContent, 'Prom-m');
    assert.equal(reading(prom).lastChild, original);
});

test('matching units and auto preserve native precision, markup and unrelated profile text', async t => {
    const dom = await load({ settings: { units: 'auto' } });
    t.after(() => dom.window.close());
    const [elev, prom] = headers(dom.window.document);
    const original = dom.window.document.getElementById('StatsLabel').innerHTML;
    await change(dom, { units: 'imperial' });
    assert.equal(dom.window.document.getElementById('StatsLabel').innerHTML, original);
    await change(dom, { units: 'metric' });
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(dom.window.document.getElementById('StatsLabel'), { childList: true, subtree: true });
    await change(dom, { units: 'metric', temperatureUnits: 'imperial' });
    assert.equal(observer.takeRecords().length, 0, 'unrelated or repeated preferences must not rewrite the tables');
    observer.disconnect();
    await change(dom, { units: 'auto' });
    assert.equal(elev.textContent, 'Elev-ft');
    assert.equal(prom.textContent, 'Prom-ft');
    assert.equal(dom.window.document.getElementById('StatsLabel').innerHTML, original);
});

test('unfamiliar values keep their table in its native units while recognized tables still convert', async t => {
    const dom = await load({ settings: { units: 'metric' }, prepare(page) {
        reading(headers(page.window.document)[0]).textContent = '4,391 to 4,400';
    } });
    t.after(() => dom.window.close());
    const [elev, prom] = headers(dom.window.document);
    await waitFor(dom, () => prom.textContent === 'Prom-m');
    assert.equal(elev.textContent, 'Elev-ft');
    assert.equal(reading(elev).textContent, '4,391 to 4,400');
    assert.equal(reading(prom).textContent, '4036');
});

test('zero, negative elevations and missing readings retain their meaning', async t => {
    const dom = await load({ settings: { units: 'metric' }, prepare(page) {
        const rows = headers(page.window.document)[0].closest('table').rows;
        for (const [index, value] of ['0', '−100', '—', '', '?'].entries()) rows[index + 2].cells[1].textContent = value;
    } });
    t.after(() => dom.window.close());
    const elev = headers(dom.window.document)[0];
    await waitFor(dom, () => elev.textContent === 'Elev-m');
    assert.deepEqual([...elev.closest('table').rows].slice(2, 7).map(row => row.cells[1].textContent), ['0', '-30', '—', '', '?']);
});

test('a newer setting wins over a slow initial settings read', async t => {
    let release;
    const dom = await load({ settings: { units: 'imperial' }, prepare(page) {
        const get = page.chrome.storage.sync.get;
        page.chrome.storage.sync.get = async key => {
            const snapshot = await get(key);
            return new Promise(resolve => { release = () => resolve(snapshot); });
        };
    } });
    t.after(() => dom.window.close());
    await waitFor(dom, () => !!release);
    await change(dom, { units: 'metric' });
    release();
    // Let the released initial read finish without a newer publication hiding it.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(headers(dom.window.document)[0].textContent, 'Elev-m');
});

test('restoring a cached profile reconciles units, and disposed profiles stop subscribing', async t => {
    const dom = await load({ settings: { units: 'metric' } });
    t.after(() => dom.window.close());
    const elev = headers(dom.window.document)[0];
    await waitFor(dom, () => elev.textContent === 'Elev-m');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    await change(dom, { units: 'imperial' });
    assert.equal(elev.textContent, 'Elev-m');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(dom, () => elev.textContent === 'Elev-ft');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: false }));
    await change(dom, { units: 'metric' });
    assert.equal(elev.textContent, 'Elev-ft');
});
