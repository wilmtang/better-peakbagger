// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from './helpers/load-page.mjs';

const bundle = ['content/climber-favorite.js'];
const otherUrl = 'https://www.peakbagger.com/climber/climber.aspx?cid=900002';
const key = 'bpbFavoriteClimbers';

const loadOther = options => loadPage('climber-other.html', {
    fixtures: PAGE_FIXTURES,
    url: otherUrl,
    bundles: bundle,
    ...options,
});

test('custom mode toggles the viewed climber without replacing other favorites', async () => {
    const existing = { cid: 900003, name: 'Existing Favorite', addedAt: 1, source: 'manual' };
    const dom = await loadOther({
        settings: { favoritesSource: 'custom' },
        local: { [key]: { schemaVersion: 1, entries: [existing] } },
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-favorite'));
    const button = dom.window.document.getElementById('bpb-climber-favorite');
    assert.equal(button.textContent, '☆ Add to favorites');
    assert.equal(button.getAttribute('aria-pressed'), 'false');

    button.click();
    await waitFor(dom, () => dom.chrome._localStore[key].entries.some(entry => entry.cid === 900002));
    assert.equal(dom.chrome._localStore[key].entries.length, 2);
    assert.deepEqual(
        JSON.parse(JSON.stringify(dom.chrome._localStore[key].entries.find(entry => entry.cid === 900003))),
        existing
    );
    assert.equal(button.textContent, '★ In your favorites — remove');

    button.click();
    await waitFor(dom, () => !dom.chrome._localStore[key].entries.some(entry => entry.cid === 900002));
    assert.equal(button.textContent, '☆ Add to favorites');
});

test('Buddy List mode renders no custom favorite control', async () => {
    const dom = await loadOther({ settings: { favoritesSource: 'buddies' } });
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite'), null);
});

test('your own climber page never offers to favorite yourself', async () => {
    const dom = await loadPage('climber-home.html', {
        fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/climber/climber.aspx?cid=900001',
        bundles: bundle,
        settings: { favoritesSource: 'custom' },
    });
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite'), null);
});

test('the control follows live list and source changes', async () => {
    const dom = await loadOther({ settings: { favoritesSource: 'custom' } });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-favorite'));
    const button = dom.window.document.getElementById('bpb-climber-favorite');

    await dom.chrome.storage.local.set({
        [key]: {
            schemaVersion: 1,
            entries: [{ cid: 900002, name: 'Casey Alpine', addedAt: 1, source: 'manual' }],
        },
    });
    assert.equal(button.textContent, '★ In your favorites — remove');

    await dom.chrome.storage.sync.set({ bpbSettings: { favoritesSource: 'buddies' } });
    await waitFor(dom, () => !dom.window.document.getElementById('bpb-climber-favorite'));
});
