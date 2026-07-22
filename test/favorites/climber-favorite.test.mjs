// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';

const bundle = ['content/climber-favorite.js'];
const otherUrl = 'https://www.peakbagger.com/climber/climber.aspx?cid=900002';
const key = 'bpbFavoriteClimbers';
const cacheKey = 'bpbBuddyCache';
const pendingKey = 'bpbPendingBuddyMutation';
const buddyFixture = await readFile(new URL('../fixtures/pages/report-buddy-list.html', import.meta.url), 'utf8');
const pageResponse = text => ({ status: 200, headers: {}, text: async () => text });
const pendingMutation = action => JSON.stringify({ version: 1, action, cid: 900002, at: Date.now() });

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
    const heading = dom.window.document.querySelector('#TitleLabel h1');
    assert.equal(button.textContent, '☆');
    assert.equal(button.getAttribute('aria-label'), 'Add Casey Alpine to your Better Peakbagger favorites');
    assert.equal(button.title, 'Add Casey Alpine to your Better Peakbagger favorites');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(button.parentElement, heading.parentElement,
        'the compact action belongs beside the title instead of on a separate row');
    assert.equal(heading.nextElementSibling, button);
    assert.equal(button.parentElement.classList.contains('bpb-climber-favorite-host'), true);

    button.click();
    await waitFor(dom, () => dom.chrome._localStore[key].entries.some(entry => entry.cid === 900002));
    assert.equal(dom.chrome._localStore[key].entries.length, 2);
    assert.deepEqual(
        JSON.parse(JSON.stringify(dom.chrome._localStore[key].entries.find(entry => entry.cid === 900003))),
        existing
    );
    assert.equal(button.textContent, '★');
    assert.equal(button.getAttribute('aria-label'), 'Remove Casey Alpine from your Better Peakbagger favorite');

    button.click();
    await waitFor(dom, () => !dom.chrome._localStore[key].entries.some(entry => entry.cid === 900002));
    assert.equal(button.textContent, '☆');
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
    assert.equal(button.textContent, '★');

    await dom.chrome.storage.sync.set({ bpbSettings: { favoritesSource: 'buddies' } });
    await waitFor(dom, () => !dom.window.document.getElementById('bpb-climber-favorite'));
    assert.equal(dom.window.document.getElementById('TitleLabel').classList.contains('bpb-climber-favorite-host'), false);
});

test('native Buddy actions leave a short-lived refresh marker for the completed navigation', async () => {
    const dom = await loadOther({ settings: { favoritesSource: 'buddies' } });
    const nativeButton = dom.window.document.getElementById('BuddyButton');
    nativeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, button: 0 }));
    assert.deepEqual(JSON.parse(dom.window.sessionStorage.getItem(pendingKey)), {
        version: 1,
        action: 'add',
        cid: 900002,
        at: JSON.parse(dom.window.sessionStorage.getItem(pendingKey)).at,
    });
});

test('a confirmed Buddy addition refreshes the cache and joins a custom favorites list', async () => {
    const buddyWithCasey = buddyFixture
        .replaceAll('710483', '900002')
        .replaceAll('Alpine, Casey', 'Casey Alpine');
    const existing = { cid: 900003, name: 'Existing Favorite', addedAt: 1, source: 'manual' };
    const requests = [];
    const dom = await loadOther({
        settings: { favoritesSource: 'custom' },
        local: { [key]: { schemaVersion: 1, entries: [existing] } },
        prepare(page) {
            page.window.sessionStorage.setItem(pendingKey, pendingMutation('add'));
            page.window.fetch = async url => {
                requests.push(String(url));
                return pageResponse(buddyWithCasey);
            };
        },
    });
    await waitFor(dom, () => dom.chrome._localStore[cacheKey]?.entries?.some(entry => entry.cid === 900002));
    await waitFor(dom, () => dom.chrome._localStore[key]?.entries?.some(entry => entry.cid === 900002));
    assert.deepEqual(requests, ['https://www.peakbagger.com/report/report.aspx?r=b']);
    assert.equal(dom.window.sessionStorage.getItem(pendingKey), null);
    assert.deepEqual(
        JSON.parse(JSON.stringify(dom.chrome._localStore[key].entries.find(entry => entry.cid === 900003))),
        existing,
    );
    assert.equal(dom.chrome._localStore[key].entries.find(entry => entry.cid === 900002).source, 'buddy');
});

test('a Buddy removal keeps the custom favorite by default and removes it only when opted in', async () => {
    for (const removeFavoriteWhenBuddyRemoved of [false, true]) {
        const favorite = { cid: 900002, name: 'Casey Alpine', addedAt: 1, source: 'buddy' };
        const dom = await loadOther({
            settings: { favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved },
            local: { [key]: { schemaVersion: 1, entries: [favorite] } },
            prepare(page) {
                page.window.sessionStorage.setItem(pendingKey, pendingMutation('remove'));
                page.window.fetch = async () => pageResponse(buddyFixture);
            },
        });
        await waitFor(dom, () => dom.chrome._localStore[cacheKey]?.entries?.length === 6);
        if (removeFavoriteWhenBuddyRemoved) {
            await waitFor(dom, () => dom.chrome._localStore[key].entries.length === 0);
        } else {
            assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[key].entries)), [favorite]);
        }
    }
});

test('an unconfirmed Buddy action refreshes the cache without changing custom favorites', async () => {
    const dom = await loadOther({
        settings: { favoritesSource: 'custom' },
        prepare(page) {
            page.window.sessionStorage.setItem(pendingKey, pendingMutation('add'));
            page.window.fetch = async () => pageResponse(buddyFixture);
        },
    });
    await waitFor(dom, () => dom.chrome._localStore[cacheKey]?.entries?.length === 6);
    assert.equal(dom.chrome._localStore[key], undefined);
});
