// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFavoritesPage, el, waitFor, registerCleanup, peakbaggerFetch } from '../helpers/options-helpers.mjs';
registerCleanup();
test('Ignored tab adds confirmed identities, supports search, and undoes only the removed entry', async () => {
    const dom = await loadFavoritesPage({}, { prepareWindow: window => {
        window.fetch = peakbaggerFetch({ climberCid: 900002 });
    } });
    el(dom, 'ignored-tab').click();
    assert.equal(el(dom, 'ignored-workspace').hidden, false);
    await waitFor(dom, () => !el(dom, 'ignored-add-button').disabled);
    el(dom, 'ignored-add-input').value = '900002';
    el(dom, 'ignored-add-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(dom, () => dom.chrome._localStore.bpbIgnoredClimbers?.entries.length === 1);
    assert.equal(el(dom, 'ignored-list').querySelector('.favorite-name').textContent, 'Alex Doe');
    el(dom, 'ignored-list').querySelector('button').click();
    await waitFor(dom, () => !el(dom, 'ignored-undo').hidden);
    const current = dom.chrome._localStore.bpbIgnoredClimbers;
    await dom.chrome.storage.local.set({ bpbIgnoredClimbers: { ...current, revision: current.revision + 1,
        entries: [{ cid: 900003, name: '<script>other</script>', addedAt: 1 }] } });
    el(dom, 'ignored-undo-button').click();
    await waitFor(dom, () => dom.chrome._localStore.bpbIgnoredClimbers.entries.length === 2);
    assert.equal(el(dom, 'ignored-list').querySelector('script'), null);
    el(dom, 'ignored-search').value = '900003';
    el(dom, 'ignored-search').dispatchEvent(new dom.window.Event('input'));
    assert.equal(el(dom, 'ignored-list').children.length, 1);
});
