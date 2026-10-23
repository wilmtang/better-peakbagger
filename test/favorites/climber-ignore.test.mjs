// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';
const load = (source, cid = 900002, options = {}) => loadPage(cid === 900001 ? 'climber-home.html' : 'climber-other.html', {
    bundles: ['content/climber-favorite.js'], settings: { favoritesSource: source }, fixtures: PAGE_FIXTURES,
    url: `https://www.peakbagger.com/climber/climber.aspx?cid=${cid}`, ...options });
test('ignore works in either source mode when the climber is neither a favorite nor a buddy', async () => {
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

const entry = { cid: 900002, name: 'Casey Alpine', addedAt: 1 };
const intent = status => ({ cid: 900002, ownerCid: 900001, name: 'Casey Alpine', action: 'add',
    token: 'pending-fixture', tabId: 7, status, checkOnly: false, leaseUntil: 0 });
test('durable Buddy intents block Ignore after reload, expiry and other-tab publication', async t => {
    for (const status of ['prepared', 'dispatched', 'confirmed']) {
        const dom = await load('custom', 900002, { local: { bpbBuddyIntents: [intent(status)] } });
        t.after(() => dom.window.close());
        const button = dom.window.document.getElementById('bpb-climber-ignore');
        await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-favorite')?.disabled === false);
        assert.equal(button.disabled, true, `${status} intent is not absence of a buddy`);
        assert.match(dom.window.document.getElementById('bpb-climber-membership-note').textContent, /Check buddy status/);
        button.click(); assert.equal(dom.chrome._localStore.bpbIgnoredClimbers, undefined);
        await dom.chrome.storage.local.set({ bpbBuddyIntents: [] });
        await waitFor(dom, () => !button.disabled);
        await dom.chrome.storage.local.set({ bpbBuddyIntents: [intent('dispatched')] });
        await waitFor(dom, () => button.disabled);
    }
});
test('unresolved Buddy protection does not prevent a safe Unignore removal', async t => {
    const dom = await load('custom', 900002, { local: { bpbBuddyIntents: [intent('dispatched')],
        bpbIgnoredClimbers: { schemaVersion: 1, revision: 1, entries: [entry] } } });
    t.after(() => dom.window.close());
    const button = dom.window.document.getElementById('bpb-climber-ignore');
    await waitFor(dom, () => button.textContent === 'Unignore' && !button.disabled);
    button.click();
    await waitFor(dom, () => button.textContent === 'Ignore' && button.getAttribute('aria-busy') === 'false');
    assert.equal(button.disabled, true);
    assert.equal(dom.chrome._localStore.bpbIgnoredClimbers.entries.length, 0);
    assert.equal(dom.chrome._localStore.bpbBuddyIntents.length, 1);
});
test('an active Buddy lease blocks only Buddy/Ignore additions, never unrelated actions', async t => {
    const dom = await load('custom', 900002, { local: { bpbBuddyIntents: [{ ...intent('prepared'), leaseUntil: Date.now() + 30000 }] } });
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    await waitFor(dom, () => doc.getElementById('BuddyButton').getAttribute('aria-disabled') === 'true'
        && doc.getElementById('bpb-climber-favorite')?.disabled === false);
    assert.equal(doc.getElementById('bpb-climber-ignore').disabled, true);
    assert.match(doc.getElementById('bpb-climber-membership-note').textContent, /in progress/);
    doc.getElementById('bpb-climber-favorite').click();
    await waitFor(dom, () => doc.getElementById('bpb-climber-favorite').getAttribute('aria-pressed') === 'true');
    assert.equal(dom.chrome._localStore.bpbFavoriteClimbers.entries.length, 1);
});
for (const first of ['favorite', 'ignore']) {
    test(`a pending ${first} save blocks the conflicting profile action`, async () => {
        let finish;
        const dom = await load('custom', 900002, { prepare(page) {
            const send = page.chrome.runtime.sendMessage.bind(page.chrome.runtime);
            Object.defineProperty(page.chrome.runtime, 'sendMessage', { value: message =>
                message.type === (first === 'favorite' ? 'FAVORITES_MUTATE' : 'IGNORED_MUTATE')
                    ? new Promise(resolve => { finish = async () => resolve(await send(message)); }) : send(message) });
        } });
        await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-favorite')?.disabled === false);
        const favorite = dom.window.document.getElementById('bpb-climber-favorite');
        const ignore = dom.window.document.getElementById('bpb-climber-ignore');
        const buddy = dom.window.document.getElementById('BuddyButton');
        await waitFor(dom, () => !favorite.disabled && !ignore.disabled);
        (first === 'favorite' ? favorite : ignore).click();
        await waitFor(dom, () => !!finish && (first === 'favorite' ? ignore.disabled : favorite.disabled));
        let nativeActions = 0;
        buddy.addEventListener('click', () => nativeActions++);
        if (first === 'ignore') {
            buddy.click();
            assert.equal(nativeActions, 0);
            assert.equal(buddy.getAttribute('aria-disabled'), 'true');
        } else ignore.click();
        await finish();
        await waitFor(dom, () => (first === 'favorite' ? favorite : ignore).getAttribute('aria-busy') === 'false');
        assert.equal(dom.chrome._localStore.bpbFavoriteClimbers?.entries.length || 0, first === 'favorite' ? 1 : 0);
        assert.equal(dom.chrome._localStore.bpbIgnoredClimbers?.entries.length || 0, first === 'ignore' ? 1 : 0);
        dom.window.close();
    });
}

test('an unconfirmed native Buddy addition blocks Ignore until the page confirms membership', async () => {
    const dom = await load('custom');
    const buddy = dom.window.document.getElementById('BuddyButton');
    const ignore = dom.window.document.getElementById('bpb-climber-ignore');
    await waitFor(dom, () => !ignore.disabled && buddy.getAttribute('aria-disabled') !== 'true');
    buddy.click();
    await waitFor(dom, () => ignore.disabled);
    assert.match(dom.window.document.getElementById('bpb-climber-membership-note').textContent, /Buddy List change pending/);
    ignore.click();
    assert.equal(dom.chrome._localStore.bpbIgnoredClimbers, undefined);
    buddy.value = 'Remove from My Buddy List';
    await waitFor(dom, () => !buddy.hasAttribute('data-bpb-buddy-pending'));
    assert.equal(ignore.disabled, true);
    const note = dom.window.document.getElementById('bpb-climber-membership-note');
    assert.equal(note.textContent, '');
    assert.equal(note.hidden, true);
    dom.window.close();
});

test('favorites quietly disable Ignore and allow deliberate removal before switching lists', async () => {
    const dom = await load('custom', 900002, { local: { bpbFavoriteClimbers: {
        schemaVersion: 1, entries: [{ ...entry, source: 'manual' }] } } });
    const button = id => dom.window.document.getElementById(id);
    await waitFor(dom, () => button('bpb-climber-favorite')?.textContent === '★');
    assert.equal(button('bpb-climber-ignore').disabled, true);
    assert.equal(button('bpb-climber-membership-note').textContent, '');
    assert.equal(button('bpb-climber-membership-note').hidden, true);
    assert.match(button('bpb-climber-ignore').title, /Remove from favorites to ignore/);
    assert.equal(button('bpb-climber-favorite').disabled, false);
    button('bpb-climber-ignore').click();
    assert.equal(dom.chrome._localStore.bpbIgnoredClimbers, undefined);
    button('bpb-climber-favorite').click();
    await waitFor(dom, () => !button('bpb-climber-ignore').disabled);
    button('bpb-climber-ignore').click();
    await waitFor(dom, () => button('bpb-climber-ignore').textContent === 'Unignore'
        && !button('bpb-climber-ignore').disabled && button('bpb-climber-favorite').disabled);
    assert.match(button('bpb-climber-membership-note').textContent, /Unignore to add/);
    assert.match(button('bpb-climber-favorite').getAttribute('aria-label'), /Unignore Casey Alpine/);
    button('bpb-climber-favorite').click();
    assert.equal(dom.chrome._localStore.bpbFavoriteClimbers.entries.length, 0);
    button('bpb-climber-ignore').click();
    await waitFor(dom, () => !button('bpb-climber-favorite').disabled);
    dom.window.close();
});

test('ignored climbers cannot use pointer or form submission to add a native climbing buddy', async () => {
    for (const source of ['custom', 'buddies']) {
        const dom = await load(source, 900002, { local: { bpbIgnoredClimbers: {
            schemaVersion: 1, revision: 1, entries: [entry] } } });
        const buddy = dom.window.document.getElementById('BuddyButton');
        await waitFor(dom, () => buddy.getAttribute('aria-disabled') === 'true'
            && /Unignore/.test(buddy.title));
        let nativeActions = 0;
        buddy.addEventListener('click', () => nativeActions++);
        buddy.form.addEventListener('submit', () => nativeActions++);
        assert.equal(buddy.dispatchEvent(new dom.window.MouseEvent('click', {
            bubbles: true, cancelable: true, button: 0, ctrlKey: true })), false);
        assert.equal(buddy.form.dispatchEvent(new dom.window.SubmitEvent('submit', {
            bubbles: true, cancelable: true, submitter: buddy })), false);
        assert.equal(nativeActions, 0);
        assert.equal(dom.window.sessionStorage.getItem('bpbPendingBuddyMutation'), null);
        dom.window.document.getElementById('bpb-climber-ignore').click();
        await waitFor(dom, () => buddy.getAttribute('aria-disabled') !== 'true');
        buddy.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        assert.equal(nativeActions, 1);
        dom.window.close();
    }
});

test('native and saved Buddy membership blocks Ignore, and native Remove stays available', async () => {
    const dom = await load('custom', 900002, { prepare(page) {
        page.window.document.getElementById('BuddyButton').value = 'Remove from My Buddy List';
    } });
    const buddy = dom.window.document.getElementById('BuddyButton');
    const ignore = dom.window.document.getElementById('bpb-climber-ignore');
    await waitFor(dom, () => /Remove from your Buddy List/.test(ignore.title));
    assert.equal(ignore.disabled, true);
    const note = dom.window.document.getElementById('bpb-climber-membership-note');
    assert.equal(note.textContent, '');
    assert.equal(note.hidden, true);
    assert.notEqual(buddy.getAttribute('aria-disabled'), 'true');
    buddy.value = 'Add to My Buddy List';
    await waitFor(dom, () => !ignore.disabled);
    await dom.chrome.storage.local.set({ bpbBuddyCache: { ownerCid: 900001,
        entries: [entry], fetchedAt: Date.now() } });
    await waitFor(dom, () => ignore.disabled);
    assert.match(ignore.title, /Buddy List/);
    assert.equal(note.textContent, '');
    assert.equal(note.hidden, true);
    await dom.chrome.storage.local.set({ bpbBuddyCache: { ownerCid: 900001, entries: [], fetchedAt: Date.now() } });
    await waitFor(dom, () => !ignore.disabled);
    dom.window.close();
});

test('legacy overlapping memberships offer removals without silently deleting either list', async () => {
    const dom = await load('custom', 900002, { local: {
        bpbIgnoredClimbers: { schemaVersion: 1, revision: 1, entries: [entry] },
        bpbFavoriteClimbers: { schemaVersion: 1, entries: [{ ...entry, source: 'manual' }] },
    } });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-favorite')?.textContent === '★');
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite').disabled, false);
    assert.equal(dom.window.document.getElementById('bpb-climber-ignore').disabled, false);
    assert.equal(dom.chrome._localStore.bpbFavoriteClimbers.entries.length, 1);
    assert.equal(dom.chrome._localStore.bpbIgnoredClimbers.entries.length, 1);
    dom.window.close();
});

test('pending ignored sync reserves profile add controls and releases them after reconciliation', async () => {
    const dom = await load('custom', 900002, { local: {
        bpbIgnoredSyncState: { pending: { result: [entry] } },
    } });
    const favorite = () => dom.window.document.getElementById('bpb-climber-favorite');
    await waitFor(dom, () => favorite()?.disabled
        && /Sync pending/.test(dom.window.document.getElementById('bpb-climber-membership-note').textContent));
    assert.equal(dom.window.document.getElementById('BuddyButton').getAttribute('aria-disabled'), 'true');
    await dom.chrome.storage.local.set({ bpbIgnoredSyncState: { pending: null } });
    await waitFor(dom, () => !favorite().disabled);
    dom.window.close();
});
test('own profile has no ignore control', async () => {
    const dom = await load('custom', 900001);
    assert.equal(dom.window.document.getElementById('bpb-climber-ignore'), null);
    dom.window.close();
});

test('signed-out profile Ignore identifies the saved account and offers recovery without changing its cache', async t => {
    const cache = { ownerCid: 900099, entries: [entry], fetchedAt: Date.now() };
    const dom = await load('custom', 900002, { local: { bpbBuddyCache: cache }, prepare: page => {
        [...page.window.document.querySelectorAll('div')].filter(div => /^\s*Logged in:/.test(div.textContent)).forEach(div => div.remove());
    } });
    t.after(() => dom.window.close());
    await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-membership-note').textContent.includes('previous Peakbagger account'));
    const button = dom.window.document.getElementById('bpb-climber-ignore');
    assert.equal(button.disabled, true); assert.match(button.title, /previous Peakbagger account/);
    assert.equal(dom.window.document.getElementById('bpb-climber-profile-retry').textContent, 'Open saved account');
    assert.deepEqual(dom.chrome._localStore.bpbBuddyCache, cache);
});
