// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadPage, PAGE_FIXTURES, waitFor, trustedInput, type LoadedPage } from '../helpers/fixture-page.mts';
import type { PageElement } from '../helpers/page-types.mts';

const bundle = ['content/climber-favorite.js'];
const otherUrl = 'https://www.peakbagger.com/climber/climber.aspx?cid=900002';
const key = 'bpbFavoriteClimbers';
const cacheKey = 'bpbBuddyCache';
const pendingKey = 'bpbPendingBuddyMutation';
const buddyFixture = await readFile(new URL('../fixtures/pages/report-buddy-list.html', import.meta.url), 'utf8');
const pageResponse = (text: string) => ({ status: 200, headers: {}, text: async () => text } as unknown as Response);
const pendingMutation = (action: 'add' | 'remove') => JSON.stringify({ version: 1, action, cid: 900002, at: Date.now() });

const loadOther = (options: Parameters<typeof loadPage>[1] = {}) => loadPage('climber-other.html', {
    fixtures: PAGE_FIXTURES,
    url: otherUrl,
    bundles: bundle,
    ...options,
});

test('profile favorite failures expose visible recovery and retain the real list state', async t => {
    const dom = await loadOther({ settings: { favoritesSource: 'custom' }, prepare(page: LoadedPage) {
        const send = page.chrome.runtime.sendMessage.bind(page.chrome.runtime);
        Object.defineProperty(page.chrome.runtime, 'sendMessage', { value: (message: { type?: string }) => message.type === 'FAVORITES_MUTATE'
            ? Promise.resolve({ ok: false, error: { message: 'Storage is unavailable. Your favorites were kept.' } }) : send(message) });
    } });
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    await waitFor(dom, () => doc.getElementById('bpb-climber-favorite')?.disabled === false);
    doc.getElementById('bpb-climber-favorite').click();
    await waitFor(dom, () => /Storage is unavailable/.test(doc.getElementById('bpb-climber-favorite').title));
    const feedback = doc.getElementById('bpb-climber-profile-feedback');
    assert.ok(feedback, 'failure must not be tooltip-only');
    assert.match(feedback.textContent ?? '', /Favorites not saved/);
    assert.equal(feedback.querySelector('button').hidden, false);
    assert.equal(doc.getElementById('bpb-climber-favorite').getAttribute('aria-pressed'), 'false');
    assert.match(doc.getElementById('bpb-climber-profile-announcement').textContent ?? '', /Storage is unavailable/);
});

test('supported native profile actions share the confirmed adapter and cross-tab reservation', async t => {
    const html = await readFile(new URL('../fixtures/pages/climber-buddy-form.html', import.meta.url), 'utf8');
    let buddy = false, posts = 0;
    const dom = await loadPage('climber-buddy-form.html', { fixtures: PAGE_FIXTURES, url: otherUrl,
        bundles: bundle, settings: { favoritesSource: 'custom' }, prepare(page: LoadedPage) {
            page.window.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
                if (init?.method === 'POST') { posts++; buddy = new URLSearchParams(String(init.body)).has('AddBuddy'); }
                const text = buddy ? html.replace('Add this Climber as a Buddy', 'This Climber is one of your buddies.')
                    .replaceAll('AddBuddy', 'RemoveBuddy').replace('Add to your Buddy List', 'Remove from your Buddy List') : html;
                return { ...pageResponse(text), url: String(url) };
            }) as unknown as typeof fetch;
        } });
    t.after(() => dom.window.close());
    await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-favorite')?.disabled === false);
    await trustedInput(dom.window.document.getElementById('AddBuddy'), { type: 'click' });
    await waitFor(dom, () => dom.window.document.getElementById('RemoveBuddy')?.disabled === false
        && dom.window.document.getElementById('RemoveBuddy')?.getAttribute('aria-disabled') !== 'true');
    assert.equal(posts, 1);
    assert.ok(dom.chrome._localStore[key]!.entries.some(entry => entry.cid === 900002));
    assert.deepEqual(dom.chrome._localStore.bpbBuddyIntents, []);
});

test('custom mode toggles the viewed climber without replacing other favorites', async t => {
    const existing = { cid: 900003, name: 'Existing Favorite', addedAt: 1, source: 'manual' };
    const dom = await loadOther({
        settings: { favoritesSource: 'custom' },
        local: { [key]: { schemaVersion: 1, entries: [existing] } },
    });
    t.after(() => dom.window.close());
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
    assert.equal(button.parentElement!.classList.contains('bpb-climber-favorite-host'), true);

    button.click();
    await waitFor(dom, () => dom.chrome._localStore[key]!.entries.some(entry => entry.cid === 900002));
    assert.equal(dom.chrome._localStore[key]!.entries.length, 2);
    assert.deepEqual(
        JSON.parse(JSON.stringify(dom.chrome._localStore[key]!.entries.find(entry => entry.cid === 900003))),
        existing,
    );
    const firstMutation = dom.chrome._favoriteMutations[0] as { kind: string; entry: { cid: number; name: string; addedAt: number; source: string } };
    assert.deepEqual(firstMutation, {
        kind: 'add',
        entry: {
            cid: 900002,
            name: 'Casey Alpine',
            addedAt: firstMutation.entry.addedAt,
            source: 'manual',
        },
    });
    assert.equal(button.textContent, '★');
    assert.equal(button.getAttribute('aria-label'), 'Remove Casey Alpine from your Better Peakbagger favorite');

    button.click();
    await waitFor(dom, () => !dom.chrome._localStore[key]!.entries.some(entry => entry.cid === 900002));
    assert.deepEqual(dom.chrome._favoriteMutations[1], { kind: 'remove', cid: 900002 });
    assert.equal(button.textContent, '☆');
});

test('Buddy List mode renders no custom favorite control', async t => {
    const dom = await loadOther({ settings: { favoritesSource: 'buddies' } });
    t.after(() => dom.window.close());
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite'), null);
});

test('your own climber page never offers to favorite yourself', async t => {
    const dom = await loadPage('climber-home.html', {
        fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/climber/climber.aspx?cid=900001',
        bundles: bundle,
        settings: { favoritesSource: 'custom' },
    });
    t.after(() => dom.window.close());
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite'), null);
});

test('the control follows live list and source changes', async t => {
    const dom = await loadOther({ settings: { favoritesSource: 'custom' } });
    t.after(() => dom.window.close());
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

test('native Buddy actions leave a short-lived refresh marker for the completed navigation', async t => {
    const dom = await loadOther({ settings: { favoritesSource: 'buddies' } });
    t.after(() => dom.window.close());
    const nativeButton = dom.window.document.getElementById('BuddyButton');
    await waitFor(dom, () => nativeButton.getAttribute('aria-disabled') !== 'true');
    assert.equal(nativeButton.classList.contains('bpb-native-buddy-action'), true);
    assert.match(
        dom.window.document.getElementById('bpb-native-buddy-action-style').textContent ?? '',
        /\.bpb-native-buddy-action:hover:not\(:disabled\)/,
    );
    nativeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, button: 0 }));
    const saved = JSON.parse(dom.window.sessionStorage.getItem(pendingKey)!) as { version: number; action: string; cid: number; at: number };
    assert.deepEqual(saved, {
        version: 1,
        action: 'add',
        cid: 900002,
        at: saved.at,
    });
});

test('an in-place Buddy addition refreshes Buddy-source membership after the native control is replaced', async t => {
    const buddyWithCasey = buddyFixture
        .replaceAll('710483', '900002')
        .replaceAll('Alpine, Casey', 'Casey Alpine');
    let requests = 0;
    const dom = await loadOther({
        settings: { favoritesSource: 'buddies' },
        prepare(page: LoadedPage) {
            page.window.fetch = (async () => {
                requests += 1;
                return pageResponse(buddyWithCasey);
            }) as unknown as typeof fetch;
        },
    });
    t.after(() => dom.window.close());
    const nativeButton = dom.window.document.getElementById('BuddyButton');
    await waitFor(dom, () => nativeButton.getAttribute('aria-disabled') !== 'true');
    nativeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, button: 0 }));
    const replacement = nativeButton.cloneNode() as PageElement;
    replacement.value = 'Remove from My Buddy List';
    nativeButton.replaceWith(replacement);

    await waitFor(dom, () => dom.chrome._localStore[cacheKey]?.entries?.some(entry => entry.cid === 900002));
    assert.equal(requests, 1);
    assert.equal(dom.window.sessionStorage.getItem(pendingKey), null);
    assert.equal(replacement.classList.contains('bpb-native-buddy-action'), true);
    assert.equal(dom.chrome._localStore[key], undefined);
});

test('in-place Buddy changes synchronize the custom list and honor opted-in removal', async t => {
    const buddyWithCasey = buddyFixture
        .replaceAll('710483', '900002')
        .replaceAll('Alpine, Casey', 'Casey Alpine');
    let included = false;
    let requests = 0;
    const dom = await loadOther({
        settings: { favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved: true },
        prepare(page: LoadedPage) {
            page.window.fetch = (async () => {
                requests += 1;
                return pageResponse(included ? buddyWithCasey : buddyFixture);
            }) as unknown as typeof fetch;
        },
    });
    t.after(() => dom.window.close());
    await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-favorite'));

    const replaceNativeControl = (value: string) => {
        const current = dom.window.document.getElementById('BuddyButton');
        current.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, button: 0 }));
        const replacement = current.cloneNode() as PageElement;
        replacement.value = value;
        current.replaceWith(replacement);
    };

    included = true;
    replaceNativeControl('Remove from My Buddy List');
    await waitFor(dom, () => dom.chrome._localStore[key]?.entries?.some(entry => entry.cid === 900002));
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite').textContent, '★');

    included = false;
    replaceNativeControl('Add to My Buddy List');
    await waitFor(dom, () => dom.chrome._localStore[key]?.entries?.every(entry => entry.cid !== 900002));
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite').textContent, '☆');
    assert.equal(dom.chrome._localStore[cacheKey]!.entries.some(entry => entry.cid === 900002), false);
    assert.equal(dom.window.sessionStorage.getItem(pendingKey), null);
    assert.equal(requests, 2);
});

test('overlapping in-place Buddy refreshes serialize epochs instead of failing as stale', async t => {
    const buddyWithCasey = buddyFixture
        .replaceAll('710483', '900002')
        .replaceAll('Alpine, Casey', 'Casey Alpine');
    const fetchResolvers: ((html: string) => void)[] = [];
    const publishResults: boolean[] = [];
    const dom = await loadOther({
        settings: { favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved: true },
        prepare(page: LoadedPage) {
            const send = page.chrome.runtime.sendMessage.bind(page.chrome.runtime);
            Object.defineProperty(page.chrome.runtime, 'sendMessage', {
                value: async (message: { type?: string; phase?: string }) => {
                    const result = await send(message);
                    if (message.type === 'BUDDY_CACHE_UPDATE' && message.phase === 'publish') {
                        publishResults.push(Boolean((result as { written?: boolean } | undefined)?.written));
                    }
                    return result;
                },
            });
            page.window.fetch = (() => new Promise<Response>(resolve => {
                fetchResolvers.push(html => resolve(pageResponse(html)));
            })) as unknown as typeof fetch;
        },
    });
    t.after(() => dom.window.close());
    await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-favorite'));

    const replaceNativeControl = (value: string) => {
        const current = dom.window.document.getElementById('BuddyButton');
        current.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, button: 0 }));
        const replacement = current.cloneNode() as PageElement;
        replacement.value = value;
        current.replaceWith(replacement);
    };

    replaceNativeControl('Remove from My Buddy List');
    await waitFor(dom, () => fetchResolvers.length === 1);

    // Fire the second in-place postback while the first report read is still held open.
    replaceNativeControl('Add to My Buddy List');
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(fetchResolvers.length, 1, 'second refresh must wait until the first cache transaction commits');

    fetchResolvers[0]!(buddyWithCasey);
    await waitFor(dom, () => fetchResolvers.length === 2);

    fetchResolvers[1]!(buddyFixture);
    await waitFor(dom, () => publishResults.length === 2
        && !dom.chrome._localStore[key]?.entries?.some(entry => entry.cid === 900002));
    assert.deepEqual(publishResults, [true, true]);
    assert.equal(dom.chrome._localStore[cacheKey]!.entries.some(entry => entry.cid === 900002), false);
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite').textContent, '☆');
    assert.equal(dom.window.document.getElementById('bpb-climber-favorite').getAttribute('aria-pressed'), 'false');
});

test('a confirmed Buddy addition refreshes the cache and joins a custom favorites list', async t => {
    const buddyWithCasey = buddyFixture
        .replaceAll('710483', '900002')
        .replaceAll('Alpine, Casey', 'Casey Alpine');
    const existing = { cid: 900003, name: 'Existing Favorite', addedAt: 1, source: 'manual' };
    const requests: string[] = [];
    const dom = await loadOther({
        settings: { favoritesSource: 'custom' },
        local: { [key]: { schemaVersion: 1, entries: [existing] } },
        prepare(page: LoadedPage) {
            page.window.sessionStorage.setItem(pendingKey, pendingMutation('add'));
            page.window.fetch = (async (url: RequestInfo | URL) => {
                requests.push(String(url));
                return pageResponse(buddyWithCasey);
            }) as unknown as typeof fetch;
        },
    });
    t.after(() => dom.window.close());
    await waitFor(dom, () => dom.chrome._localStore[cacheKey]?.entries?.some(entry => entry.cid === 900002));
    await waitFor(dom, () => dom.chrome._localStore[key]?.entries?.some(entry => entry.cid === 900002));
    assert.deepEqual(requests, ['https://www.peakbagger.com/report/report.aspx?r=b']);
    assert.equal(dom.window.sessionStorage.getItem(pendingKey), null);
    assert.deepEqual(
        JSON.parse(JSON.stringify(dom.chrome._localStore[key]!.entries.find(entry => entry.cid === 900003))),
        existing,
    );
    assert.equal(dom.chrome._localStore[key]!.entries.find(entry => entry.cid === 900002)!.source, 'buddy');
});

test('a Buddy removal keeps the custom favorite by default and removes it only when opted in', async () => {
    for (const removeFavoriteWhenBuddyRemoved of [false, true]) {
        const favorite = { cid: 900002, name: 'Casey Alpine', addedAt: 1, source: 'buddy' };
        const dom = await loadOther({
            settings: { favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved },
            local: { [key]: { schemaVersion: 1, entries: [favorite] } },
            prepare(page: LoadedPage) {
                page.window.sessionStorage.setItem(pendingKey, pendingMutation('remove'));
                page.window.fetch = (async () => pageResponse(buddyFixture)) as unknown as typeof fetch;
            },
        });
        try {
            await waitFor(dom, () => dom.chrome._localStore[cacheKey]?.entries?.length === 6);
            if (removeFavoriteWhenBuddyRemoved) {
                await waitFor(dom, () => dom.chrome._localStore[key]!.entries.length === 0);
            } else {
                assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[key]!.entries)), [favorite]);
            }
        } finally { dom.window.close(); }
    }
});

test('an unconfirmed Buddy action refreshes the cache without changing custom favorites', async t => {
    const dom = await loadOther({
        settings: { favoritesSource: 'custom' },
        prepare(page: LoadedPage) {
            page.window.sessionStorage.setItem(pendingKey, pendingMutation('add'));
            page.window.fetch = (async () => pageResponse(buddyFixture)) as unknown as typeof fetch;
        },
    });
    t.after(() => dom.window.close());
    await waitFor(dom, () => dom.chrome._localStore[cacheKey]?.entries?.length === 6);
    assert.equal(dom.chrome._localStore[key], undefined);
});

test('legacy buddy refresh reports limits without replacing saved favorites or the last cache', async () => {
    const existing = { cid: 900003, name: 'Existing Favorite', addedAt: 1, source: 'manual' };
    const dom = await loadOther({ settings: { favoritesSource: 'custom' },
        local: { [key]: { schemaVersion: 1, entries: [existing] } }, prepare(page: LoadedPage) {
            page.window.sessionStorage.setItem(pendingKey, pendingMutation('add'));
            page.window.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '60' } });
        } });
    try {
        await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-profile-feedback')?.textContent?.includes('Peakbagger request limit reached'));
        assert.equal(dom.chrome._localStore[key]!.entries.length, 1);
        assert.equal(dom.chrome._localStore[cacheKey], undefined);
        assert.match(dom.window.document.getElementById('bpb-climber-profile-feedback').textContent ?? '', /saved favorites were kept/);
        assert.equal(dom.window.document.getElementById('bpb-climber-profile-feedback').querySelector('details').open, false);
    } finally { dom.window.close(); }
});
