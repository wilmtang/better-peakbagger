// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { paintReveal } from '../../src/favorites/report-controls.js';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';
const entry = cid => ({ cid, name: `Climber ${cid}`, addedAt: 1 });
const load = local => loadPage('peak-rainier.html', { fixtures: PAGE_FIXTURES,
    url: 'https://www.peakbagger.com/peak.aspx?pid=2296', bundles: ['content/peak-report-filter.js'],
    settings: { favoritesSource: 'custom' }, local });
const visible = dom => [...dom.window.document.querySelector('#bpb-selected-reports').rows]
    .slice(1).filter(row => row.cells.length === 6 && row.style.display !== 'none' && !row.hidden);
test('peak filter names the selected climber source and preserves the count and pressed state', async () => {
    const dom = await load({ bpbFavoriteClimbers: { schemaVersion: 1, entries: [{ ...entry(38769), source: 'manual' }] } });
    try {
        const button = dom.window.document.querySelector('.bpb-report-favorites');
        await waitFor(dom, () => button.textContent === '☆ Favorite climbers · 1');
        assert.match(button.title, /your favorite climbers/);
        button.click();
        await waitFor(dom, () => button.textContent === '★ Favorite climbers · 1' && button.disabled === false);
        assert.equal(button.getAttribute('aria-pressed'), 'true');
        await dom.chrome.storage.sync.set({ bpbSettings: { favoritesSource: 'buddies' } });
        await waitFor(dom, () => button.textContent === '★ Climbing buddies · 0');
        assert.match(button.title, /your climbing buddies/);
        assert.equal(button.getAttribute('aria-pressed'), 'true');
        await dom.chrome.storage.sync.set({ bpbSettings: { favoritesSource: 'custom' } });
        await waitFor(dom, () => button.textContent === '★ Favorite climbers · 1');
        assert.equal(button.getAttribute('aria-pressed'), 'true');
    } finally { dom.window.close(); }
});
test('peak reports compose ignores, favorites and temporary reveal without changing membership', async () => {
    const dom = await load({ bpbIgnoredClimbers: { schemaVersion: 1, revision: 1, entries: [entry(38769)] },
        bpbFavoriteClimbers: { schemaVersion: 1, entries: [{ ...entry(38769), source: 'manual' }] } });
    await waitFor(dom, () => dom.window.document.querySelector('#bpb-selected-reports')?.style.visibility !== 'hidden'
        && dom.window.document.querySelector('#bpb-peak-report-tools .bpb-report-status[role="status"]')?.textContent);
    const total = visible(dom).length;
    const tools = dom.window.document.querySelector('#bpb-peak-report-tools');
    tools.querySelector('.bpb-report-favorites').click();
    await waitFor(dom, () => dom.chrome._localStore.bpbPeakReportFilter?.favoritesOnly === true);
    assert.equal(visible(dom).length, 0);
    const reveal = [...tools.querySelectorAll('button')].find(b => /^Show ignored/.test(b.textContent));
    reveal.click();
    assert.equal(visible(dom).length, 1);
    assert.equal(dom.chrome._localStore.bpbIgnoredClimbers.entries.length, 1);
    const full = [...tools.querySelectorAll('button')].find(b => b.textContent === 'View full list');
    full.click(); assert.equal(visible(dom).length, total + 1);
    assert.equal(dom.chrome._localStore.bpbPeakReportFilter.favoritesOnly, true);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    assert.equal(visible(dom).length, 0);
    dom.window.close();
});
test('an active preference with empty favorites is honest, and malformed ignores leave reports readable', async () => {
    const dom = await load({ bpbPeakReportFilter: { schemaVersion: 1, favoritesOnly: true }, bpbIgnoredClimbers: { schemaVersion: 2 } });
    await waitFor(dom, () => dom.window.document.querySelector('#bpb-peak-report-tools')?.textContent.includes("Couldn't load ignored"));
    assert.equal(visible(dom).length, 0);
    const all = [...dom.window.document.querySelectorAll('#bpb-peak-report-tools button')].find(b => b.textContent === 'Show all reports');
    all.click();
    await waitFor(dom, () => visible(dom).length > 0);
    assert.ok(dom.window.document.querySelector('#bpb-peak-report-tools').textContent.includes("Couldn't load ignored climbers."));
    dom.window.close();
});

test('an unverified Buddy source offers sign-in and local favorites without discarding the saved filter', async t => {
    const dom = await loadPage('peak-rainier.html', { fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/peak.aspx?pid=2296', bundles: ['content/peak-report-filter.js'],
        settings: { favoritesSource: 'buddies' },
        local: { bpbPeakReportFilter: { schemaVersion: 1, favoritesOnly: true } },
        prepare: dom => {
            for (const div of dom.window.document.querySelectorAll('div')) {
                if (/^\s*Logged in:/.test(div.textContent)) div.remove();
            }
        } });
    t.after(() => dom.window.close());
    const tools = dom.window.document.getElementById('bpb-peak-report-tools');
    await waitFor(dom, () => tools?.textContent.includes('Peakbagger'));
    const links = [...tools.querySelectorAll('a')];
    assert.ok(links.some(a => a.textContent === 'Sign in to Peakbagger' && new URL(a.href).pathname === '/Default.aspx'));
    assert.ok(links.some(a => a.textContent === 'Use custom favorites…'));
    assert.equal(dom.chrome._localStore.bpbPeakReportFilter.favoritesOnly, true);
    assert.ok([...tools.querySelectorAll('button')].find(b => b.textContent === 'Retry').hidden);
});

test('saving the report preference retains focus and rejects duplicate activation', async () => {
    let finish, writes = 0;
    const dom = await loadPage('peak-rainier.html', { fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/peak.aspx?pid=2296', bundles: [process.env.BPB_REPORT_FILTER_BUNDLE || 'content/peak-report-filter.js'],
        settings: { favoritesSource: 'custom' }, prepare: d => {
            const send = d.chrome.runtime.sendMessage;
            Object.defineProperty(d.chrome.runtime, 'sendMessage', { value: message => message.type === 'PEAK_REPORT_PREFERENCE'
                ? (writes++, new Promise(resolve => { finish = () => resolve({ ok: true }); })) : send(message) });
        } });
    try {
        const button = dom.window.document.querySelector('.bpb-report-favorites');
        button.focus(); button.click(); await waitFor(dom, () => finish);
        assert.equal(button.disabled, false, 'busy control retains browser focus');
        assert.equal(button.getAttribute('aria-disabled'), 'true');
        button.click(); assert.equal(writes, 1);
        finish(); await waitFor(dom, () => button.getAttribute('aria-disabled') === 'false');
        assert.equal(dom.window.document.activeElement, button);
    } finally { dom.window.close(); }
});

test('report reveal feedback is hidden when empty and pluralizes matching counts', () => {
    const dom = new JSDOM('<button></button><span></span>'), doc = dom.window.document;
    try {
        const button = doc.querySelector('button'), status = doc.querySelector('span');
        paintReveal(button, status, { ignored: [1, 2], ignoredMatches: 2 }, false);
        assert.equal(status.hidden, true);
        paintReveal(button, status, { ignored: [1, 2, 3], ignoredMatches: 2 }, false);
        assert.equal(status.textContent, '2 match filters');
        assert.match(button.getAttribute('aria-description'), /2 match current filters/);
    } finally { dom.window.close(); }
});

test('a page without a recognized report table releases its storage subscriptions', async () => {
    const active = new Set();
    const dom = await loadPage('peak-rainier.html', { fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/peak.aspx?pid=2296', bundles: ['content/peak-report-filter.js'],
        prepare: d => {
            d.window.document.body.replaceChildren();
            d.chrome.storage.onChanged.addListener = fn => active.add(fn);
            d.chrome.storage.onChanged.removeListener = fn => active.delete(fn);
        } });
    try { assert.equal(active.size, 0); } finally { dom.window.close(); }
});
