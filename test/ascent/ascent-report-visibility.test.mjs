// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';
const list = { schemaVersion: 1, revision: 1, entries: [{ cid: 900002, name: 'Alex', addedAt: 1 }] };
const load = (options = {}) => loadPage('ascent-ignored-report.html', {
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1', fixtures: PAGE_FIXTURES,
    bundles: ['content/ascent-report-visibility.js'], local: { bpbIgnoredClimbers: list }, ...options });
test('detail hiding retains nodes and metadata; reveal suspends/restores media and recovers focus', async () => {
    let paused = 0;
    const dom = await load({ prepare: page => {
        page.window.HTMLMediaElement.prototype.pause = () => { paused++; };
        for (const media of page.window.document.querySelectorAll('video,audio')) Object.defineProperty(media, 'paused', { value: false });
        page.window.document.querySelector('iframe[title="Report video"]').src = 'https://example.com/video';
    } });
    const doc = dom.window.document;
    await waitFor(dom, () => doc.querySelector('#bpb-ascent-report-content')?.parentElement.style.display === 'none');
    const cell = doc.querySelector('#bpb-ascent-report-content'), map = doc.querySelector('#Gmap');
    const link = cell.querySelector('a'), frame = cell.querySelector('iframe');
    assert.equal(paused, 2); assert.equal(frame.src, 'about:blank'); assert.equal(map.src, 'about:blank');
    const button = doc.querySelector('#bpb-ascent-report-tools button'); button.click();
    assert.equal(cell.parentElement.style.display, ''); assert.equal(frame.src, 'https://example.com/video');
    link.focus(); button.click();
    assert.equal(doc.activeElement, button); assert.equal(cell.querySelector('a'), link);
    button.click(); dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    assert.equal(cell.parentElement.style.display, 'none');
    await dom.chrome.storage.local.set({ bpbIgnoredClimbers: { ...list, revision: 2, entries: [] } });
    assert.equal(cell.parentElement.style.display, ''); assert.equal(frame.src, 'https://example.com/video');
    dom.window.close();
});
test('ambiguous authors and empty reports get no placeholder', async () => {
    for (const prepare of [page => page.window.document.querySelector('main > h2').remove(),
        page => { const cell = page.window.document.querySelector('td[colspan="2"]'); cell.replaceChildren(cell.querySelector('h2')); }]) {
        const dom = await load({ prepare });
        assert.equal(dom.window.document.querySelector('#bpb-ascent-report-tools'), null); dom.window.close();
    }
});
