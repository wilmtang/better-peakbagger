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

const ignoredEntry = cid => ({ cid, name: `Climber ${cid}`, addedAt: cid });
const loadDeferredIgnored = async (ids = [1, 2, 3]) => {
    const calls = [];
    const dom = await loadFavoritesPage({}, {
        local: { bpbIgnoredClimbers: { schemaVersion: 1, revision: 1, entries: ids.map(ignoredEntry) } },
        prepareChrome: chrome => {
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            Object.defineProperty(chrome.runtime, 'sendMessage', {
                value: message => message.type === 'IGNORED_MUTATE'
                    ? new Promise(resolve => calls.push({ resolve, apply: () => send(message) }))
                    : send(message),
            });
        },
    });
    el(dom, 'ignored-tab').click();
    await waitFor(dom, () => !el(dom, 'ignored-add-button').disabled);
    const finish = async (index, error = '') => {
        calls[index].resolve(error ? { ok: false, error: { message: error } } : await calls[index].apply());
        await waitFor(dom, () => el(dom, 'ignored-list').getAttribute('aria-busy') === 'false');
    };
    const control = (cid, kind = 'button') => el(dom, 'ignored-list').querySelector(`[data-cid="${cid}"] ${kind}`);
    return { dom, calls, finish, control };
};

for (const { ids, removed, next } of [
    { ids: [1, 2, 3], removed: 3, next: 2 },
    { ids: [1, 2, 3], removed: 1, next: 2 },
    { ids: [1], removed: 1, next: null },
]) {
    test(`unignoring ${removed} from ${ids.length} rows keeps pending focus and selects a visible successor`, async () => {
        const { dom, calls, finish, control } = await loadDeferredIgnored(ids);
        control(removed).focus();
        control(removed).click();
        assert.equal(dom.window.document.activeElement, control(removed));
        assert.equal(control(removed).getAttribute('aria-disabled'), 'true');
        control(removed).click();
        assert.equal(calls.length, 1, 'a busy control must not submit a second mutation');

        // Real worker storage notifications can arrive before its reply.
        const reply = await calls[0].apply();
        await waitFor(dom, () => !control(removed));
        const expected = next ? control(next) : el(dom, 'ignored-add-input');
        assert.equal(dom.window.document.activeElement, expected);
        calls[0].resolve(reply);
        await waitFor(dom, () => el(dom, 'ignored-list').getAttribute('aria-busy') === 'false');
        assert.equal(dom.window.document.activeElement, next ? control(next) : expected);

        el(dom, 'ignored-undo-button').focus();
        el(dom, 'ignored-undo-button').click();
        assert.equal(el(dom, 'ignored-undo-button').getAttribute('aria-disabled'), 'true');
        el(dom, 'ignored-undo-button').click();
        assert.equal(calls.length, 2, 'a pending undo must not submit a second restoration');
        await finish(1);
        assert.equal(dom.window.document.activeElement, control(removed));
        assert.equal(el(dom, 'ignored-undo').hidden, true);
    });
}

test('failed unignore and undo retain their focused action for retry', async () => {
    const { dom, finish, control } = await loadDeferredIgnored();
    control(3).focus(); control(3).click();
    await finish(0, 'Could not save ignored climbers.');
    assert.equal(dom.window.document.activeElement, control(3));
    assert.equal(control(3).getAttribute('aria-disabled'), 'false');
    assert.match(el(dom, 'ignored-status').textContent, /Could not save/);
    assert.equal(el(dom, 'ignored-undo').hidden, true);

    control(3).click(); await finish(1);
    el(dom, 'ignored-undo-button').focus(); el(dom, 'ignored-undo-button').click();
    await finish(2, 'Could not restore ignored climber.');
    assert.equal(dom.window.document.activeElement, el(dom, 'ignored-undo-button'));
    assert.equal(el(dom, 'ignored-undo-button').getAttribute('aria-disabled'), 'false');
    assert.equal(el(dom, 'ignored-undo').hidden, false);
});

test('pending unignore and undo leave focus elsewhere alone', async () => {
    const { dom, finish, control } = await loadDeferredIgnored();
    control(3).focus(); control(3).click();
    el(dom, 'ignored-search').focus();
    await finish(0);
    assert.equal(dom.window.document.activeElement, el(dom, 'ignored-search'));

    el(dom, 'ignored-undo-button').focus(); el(dom, 'ignored-undo-button').click();
    el(dom, 'favorites-tab').focus(); el(dom, 'favorites-tab').click();
    await finish(1);
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-tab'));
});

test('storage refresh preserves profile-link focus and undo respects a changed search', async () => {
    const { dom, finish, control } = await loadDeferredIgnored();
    control(3, 'a').focus();
    const current = dom.chrome._localStore.bpbIgnoredClimbers;
    await dom.chrome.storage.local.set({ bpbIgnoredClimbers: { ...current, revision: 2,
        entries: [...current.entries, ignoredEntry(4)] } });
    await waitFor(dom, () => !!control(4));
    assert.equal(dom.window.document.activeElement, control(3, 'a'));

    control(3).focus(); control(3).click(); await finish(0);
    el(dom, 'ignored-search').value = 'Climber 4';
    el(dom, 'ignored-search').dispatchEvent(new dom.window.Event('input'));
    el(dom, 'ignored-undo-button').focus(); el(dom, 'ignored-undo-button').click();
    await finish(1);
    assert.equal(control(3), null, 'Undo must not clear the active search');
    assert.equal(dom.window.document.activeElement, el(dom, 'ignored-add-input'));
});
