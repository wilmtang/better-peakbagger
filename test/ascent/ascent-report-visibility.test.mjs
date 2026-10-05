// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';
const list = { schemaVersion: 1, revision: 1, entries: [{ cid: 900002, name: 'Alex', addedAt: 1 }] };
const load = (options = {}) => loadPage('ascent-ignored-report.html', {
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1', fixtures: PAGE_FIXTURES,
    bundles: ['content/ascent-report-visibility.js'], local: { bpbIgnoredClimbers: list }, ...options });
test('the original heading and toggle stay together through reveal, hide, and unignore', async () => {
    let heading;
    const dom = await load({ prepare: page => {
        heading = page.window.document.querySelector('td[colspan="2"] h2');
        heading.id = 'original-report-heading';
    } });
    try {
        const doc = dom.window.document;
        await waitFor(dom, () => doc.querySelector('#bpb-ascent-report-content')?.parentElement.style.display === 'none');
        const cell = doc.querySelector('#bpb-ascent-report-content');
        const tools = doc.querySelector('#bpb-ascent-report-tools');
        const button = tools.querySelector('button'), status = tools.querySelector('[role="status"]');
        const parent = tools.parentElement;
        for (let toggle = 0; toggle < 4; toggle++) {
            assert.equal(doc.querySelectorAll('h2#original-report-heading').length, 1);
            assert.equal(heading.parentElement, parent);
            assert.equal(heading.nextElementSibling, tools);
            assert.equal(heading.hidden, false);
            assert.equal(tools.firstElementChild, button);
            assert.equal(status.textContent, 'Ignored climber');
            button.click();
        }
        await dom.chrome.storage.local.set({ bpbIgnoredClimbers: { ...list, revision: 2, entries: [] } });
        assert.equal(heading.parentElement, cell);
        assert.equal(cell.firstElementChild, heading);
        assert.equal(parent.parentElement.hidden, true);
        assert.equal(cell.parentElement.style.display, '');
        await dom.chrome.storage.local.set({ bpbIgnoredClimbers: { ...list, revision: 3 } });
        assert.equal(heading.parentElement, parent);
        assert.equal(heading.nextElementSibling, tools);
        assert.equal(parent.parentElement.hidden, false);
        assert.equal(cell.parentElement.style.display, 'none');
    } finally { dom.window.close(); }
});
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
test('srcdoc and dynamically enhanced report players are suspended while hidden', async () => {
    const source = '<video autoplay src="/example.mp4"></video>';
    const dom = await load({ prepare: page => {
        page.window.document.querySelector('iframe[title="Report video"]').setAttribute('srcdoc', source);
    } });
    const doc = dom.window.document;
    await waitFor(dom, () => doc.querySelector('#bpb-ascent-report-content')?.parentElement.style.display === 'none');
    const cell = doc.querySelector('#bpb-ascent-report-content'), original = cell.querySelector('iframe');
    assert.equal(original.hasAttribute('srcdoc'), false);
    const enhanced = doc.createElement('iframe'); enhanced.src = 'https://example.com/enhanced-player'; enhanced.srcdoc = source;
    cell.append(enhanced);
    await waitFor(dom, () => enhanced.src === 'about:blank' && !enhanced.hasAttribute('srcdoc'));
    const button = doc.querySelector('#bpb-ascent-report-tools button'); button.click();
    assert.equal(original.getAttribute('srcdoc'), source); assert.equal(enhanced.getAttribute('srcdoc'), source);
    assert.equal(enhanced.src, 'https://example.com/enhanced-player');
    button.click(); enhanced.srcdoc = '<audio autoplay></audio>';
    await waitFor(dom, () => !enhanced.hasAttribute('srcdoc'));
    button.click(); assert.equal(enhanced.srcdoc, '<audio autoplay></audio>');
    dom.window.close();
});
