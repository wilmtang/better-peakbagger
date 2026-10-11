// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { changeBuddy, readBuddyProfile } from '../../src/favorites/buddy-client.js';
import { BUDDY_INTENTS_KEY } from '../../src/favorites/buddy-state.js';
import { makeChromeStub } from '../helpers/load-page.mjs';

const html = await readFile(new URL('../fixtures/pages/climber-buddy-form.html', import.meta.url), 'utf8');
const origin = 'https://www.peakbagger.com', url = `${origin}/climber/climber.aspx?cid=900002`;
const identity = { cid: 900002, ownerCid: 900001, origin };
const buddyHtml = buddy => buddy ? html.replace('Add this Climber as a Buddy', 'This Climber is one of your buddies.')
    .replaceAll('AddBuddy', 'RemoveBuddy').replace('Add to your Buddy List', 'Remove from your Buddy List') : html;
const response = (t, text, responseUrl = url) => {
    const dom = new JSDOM(text, { url: responseUrl }); t.after(() => dom.window.close());
    return { kind: 'ok', url: responseUrl, document: dom.window.document };
};
const harness = (t, { local = {}, settings = {}, buddy = false } = {}) => {
    const api = makeChromeStub({ bpbSettings: { favoritesSource: 'custom', ...settings } }, local);
    const h = { api, buddy, gets: 0, posts: [], owner: identity.ownerCid };
    h.change = (action = 'add', options = {}) => changeBuddy({ api, target: { cid: identity.cid, name: 'Casey Alpine' },
        ...identity, action, currentOwner: () => h.owner,
        fetchDocument: async () => { h.gets++; return response(t, buddyHtml(h.buddy)); },
        fetchResource: async (destination, options) => {
            const body = new URLSearchParams(options.init.body);
            assert.equal(options.init.redirect, 'error', 'native tokens must not follow a POST redirect');
            h.posts.push(body); assert.equal(destination, url);
            h.buddy = body.has('AddBuddy'); return { kind: 'ok', text: 'Untrusted POST response' };
        }, ...options });
    return h;
};

test('fresh native form fields submit only the intended action and confirmation synchronizes favorites', async t => {
    const h = harness(t);
    assert.equal((await h.change()).buddy, true);
    assert.equal(h.gets, 2); assert.equal(h.posts.length, 1);
    const body = h.posts[0];
    assert.equal(body.get('AddBuddy'), 'Add to your Buddy List');
    for (const name of ['RemoveBuddy', 'ContactTextBox', 'ContactButton', '__ASYNCPOST']) assert.equal(body.has(name), false);
    assert.equal(body.get('__VIEWSTATE'), 'synthetic-viewstate');
    assert.equal(h.api._localStore.bpbFavoriteClimbers.entries[0].source, 'buddy');
    assert.deepEqual(h.api._localStore[BUDDY_INTENTS_KEY], []);
    assert.equal((await h.change('remove')).buddy, false);
    assert.equal(h.posts[1].get('RemoveBuddy'), 'Remove from your Buddy List');
    assert.equal(h.api._localStore.bpbFavoriteClimbers.entries.length, 1, 'default removal preserves custom favorite');
    assert.deepEqual(h.api._localStore.bpbBuddyCache.entries, []);
});

test('explicit intent is idempotent with stale status, and opted-in removal synchronizes favorites', async t => {
    const h = harness(t, { buddy: true, settings: { removeFavoriteWhenBuddyRemoved: true } });
    assert.equal((await h.change('add')).buddy, true);
    assert.equal(h.posts.length, 0, 'an Add intent cannot toggle an existing buddy off');
    await h.change('remove');
    assert.deepEqual(h.api._localStore.bpbFavoriteClimbers.entries, []);
});

test('contradictory, unsupported and wrong-account/target forms cannot authorize a POST', t => {
    for (const text of [html.replace('Add this Climber as a Buddy', 'This Climber is one of your buddies.'),
        html.replace('./climber.aspx?cid=900002', 'https://example.com/climber/climber.aspx?cid=900002'),
        html.replace('name="AddBuddy"', 'name="ContactButton"'),
        html.replace('name="__VIEWSTATE"', 'name="unrelated-state"'),
        html.replace('synthetic-validation', ''), html.replace('cid=900001', 'cid=900009'),
        html.replace('<input id="AddBuddy"', '<input id="RemoveBuddy" name="RemoveBuddy" type="submit" value="Remove from your Buddy List"><input id="AddBuddy"')]) {
        assert.throws(() => readBuddyProfile(response(t, text), identity));
    }
    assert.throws(() => readBuddyProfile(response(t, html, url.replace('900002', '900003')), identity));
});

test('a lost POST response confirms through a new read; a failed read requires status check without replay', async t => {
    const h = harness(t);
    assert.equal((await h.change('add', { fetchResource: async () => { h.buddy = true; return { kind: 'transient' }; } })).buddy, true);
    await h.change('remove');
    let gets = 0;
    await assert.rejects(h.change('add', { fetchDocument: async () => {
        if (++gets === 2) throw new Error('offline');
        return response(t, buddyHtml(h.buddy));
    } }), /not confirmed/);
    const posts = h.posts.length;
    assert.equal(h.api._localStore[BUDDY_INTENTS_KEY][0].status, 'dispatched');
    await h.change('add', { checkOnly: true });
    assert.equal(h.posts.length, posts, 'recovery must never replay the write');
    assert.deepEqual(h.api._localStore[BUDDY_INTENTS_KEY], []);
});

test('account changes after dispatch preserve unresolved protection and never confirm another account', async t => {
    const h = harness(t);
    await assert.rejects(h.change('add', { fetchResource: async () => { h.owner = 900009; return { kind: 'ok' }; } }), /not confirmed/);
    assert.equal(h.api._localStore.bpbBuddyCache, undefined);
    assert.equal(h.api._localStore[BUDDY_INTENTS_KEY].length, 1);
});

test('an uncertain POST and unchanged profile cannot automatically release the pending intent', async t => {
    const h = harness(t);
    await assert.rejects(h.change('add', { fetchResource: async () => ({ kind: 'transient' }) }), /not confirmed/);
    assert.equal(h.api._localStore.bpbBuddyCache, undefined);
    assert.equal(h.api._localStore[BUDDY_INTENTS_KEY].length, 1);
    assert.equal((await h.change('add', { checkOnly: true })).buddy, false);
    assert.equal(h.posts.length, 0, 'explicit status recovery never repeats the server write');
});

test('Buddy success at the favorite limit is explicit, and recovery retries only local favorites', async t => {
    const entries = Array.from({ length: 1500 }, (_, i) => ({ cid: i + 1, name: 'Other Climber', addedAt: 1, source: 'manual' }));
    const h = harness(t, { local: { bpbFavoriteClimbers: { schemaVersion: 1, entries } } });
    const result = await h.change();
    assert.match(result.warning, /Buddy change saved/);
    assert.equal(h.api._localStore.bpbBuddyCache.entries[0].cid, identity.cid);
    await h.api.runtime.sendMessage({ type: 'FAVORITES_MUTATE', mutation: { kind: 'remove', cid: 1 } });
    assert.equal((await h.change('add', { checkOnly: true })).warning, '');
    assert.equal(h.posts.length, 1);
    assert.ok(h.api._localStore.bpbFavoriteClimbers.entries.some(entry => entry.cid === identity.cid));
});

test('a confirmed Buddy add with failed local favorites still permits explicit Buddy removal', async t => {
    const entries = Array.from({ length: 1500 }, (_, i) => ({ cid: i + 1, name: 'Other Climber', addedAt: 1, source: 'manual' }));
    const h = harness(t, { local: { bpbFavoriteClimbers: { schemaVersion: 1, entries } } });
    assert.match((await h.change()).warning, /Buddy change saved/);
    assert.equal((await h.change('remove')).buddy, false);
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.api._localStore[BUDDY_INTENTS_KEY], []);
});

test('a refused buddy POST exposes the rate limit without another read or automatic write retry', async t => {
    const h = harness(t);
    let posts = 0;
    await assert.rejects(h.change('add', { fetchResource: async () => {
        posts++; return { kind: 'transient', error: { source: 'peakbagger', code: 'rate-limit', retryAt: Date.now() + 60000 } };
    } }), /Peakbagger request limit reached/);
    assert.equal(posts, 1); assert.equal(h.gets, 1);
});
