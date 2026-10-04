// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';
const load = (source, cid = 900002) => loadPage(cid === 900001 ? 'climber-home.html' : 'climber-other.html', {
    bundles: ['content/climber-favorite.js'], settings: { favoritesSource: source }, fixtures: PAGE_FIXTURES,
    url: `https://www.peakbagger.com/climber/climber.aspx?cid=${cid}` });
test('ignore is independent of favorites source and native Buddy membership', async () => {
    for (const source of ['buddies', 'custom']) {
        const dom = await load(source);
        const button = dom.window.document.getElementById('bpb-climber-ignore');
        assert.ok(button);
        await waitFor(dom, () => !button.disabled);
        button.click();
        await waitFor(dom, () => button.textContent === 'Unignore' && !button.disabled);
        assert.equal(dom.chrome._localStore.bpbIgnoredClimbers.entries[0].cid, 900002);
        assert.equal(dom.chrome._localStore.bpbFavoriteClimbers, undefined);
        await dom.chrome.storage.sync.set({ bpbSettings: { favoritesSource: source === 'custom' ? 'buddies' : 'custom' } });
        assert.ok(button.isConnected);
        button.click();
        await waitFor(dom, () => button.textContent === 'Ignore' && !button.disabled);
        dom.window.close();
    }
});
test('own profile has no ignore control', async () => {
    const dom = await load('custom', 900001);
    assert.equal(dom.window.document.getElementById('bpb-climber-ignore'), null);
    dom.window.close();
});
