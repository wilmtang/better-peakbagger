// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions, el, registerCleanup } from '../helpers/options-helpers.mjs';
import { waitFor } from '../helpers/load-page.mjs';
import { harness, entry } from '../helpers/ignored-sync-harness.mjs';
import { createGithubRoutes } from '../../src/background/github-routes.js';
import * as I from '../../src/favorites/ignored-climbers.js';
registerCleanup();
test('backup preview describes both sides, restore uses replacement counts and guarded Undo', async () => {
    const h = harness({ remote: [entry(2)] });
    const dom = await loadOptions({ enableGithubBackup: true }, { local: h.values, prepareChrome: chrome => {
        h.storage.get = chrome.storage.local.get; h.storage.set = chrome.storage.local.set;
        chrome.permissions = { contains: async () => true };
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: true, repo: { owner: 'me', name: 'backup' } };
            if (message.type === 'GITHUB_IGNORED_LIST') return message.action === 'status' ? h.engine.status() : h.engine.action(message);
            if (message.type === I.MUTATE_MESSAGE) return h.store.mutate(message.mutation);
            return { ok: true };
        };
    } });
    await waitFor(dom, () => !el(dom, 'ignored-backup').disabled);
    el(dom, 'ignored-backup').click(); await waitFor(dom, () => !el(dom, 'ignored-review').hidden);
    assert.equal(el(dom, 'ignored-review-mode').value, 'device');
    assert.match(el(dom, 'ignored-review-impact').textContent, /1 added and 1 removed on GitHub/);
    el(dom, 'ignored-review-cancel').click(); await waitFor(dom, () => el(dom, 'ignored-review').hidden);
    el(dom, 'ignored-restore').click(); await waitFor(dom, () => !el(dom, 'ignored-review').hidden);
    assert.match(el(dom, 'ignored-review-impact').textContent, /1 added and 1 removed on this device/);
    el(dom, 'ignored-review-confirm').click(); await waitFor(dom, () => !el(dom, 'ignored-restore-undo').hidden);
    assert.deepEqual((await h.store.read()).entries, [entry(2)]);
    el(dom, 'ignored-restore-undo').click(); await waitFor(dom, () => el(dom, 'ignored-restore-undo').hidden);
    assert.deepEqual((await h.store.read()).entries, [entry(1)]);
});
test('ignored GitHub routes accept only exact packaged settings and manager pages', async () => {
    const h = harness();
    const routes = createGithubRoutes({ ext: { storage: { local: h.storage }, runtime: { getURL: path => `chrome-extension://own/${path}` } },
        ignoredStore: h.store, now: Date.now, resolveGithubAccess: h.engineOptions.getAccess });
    for (const url of ['https://www.peakbagger.com/climber/climber.aspx?cid=1', 'chrome-extension://other/options/options.html',
        'chrome-extension://own/options/options.html/extra', 'chrome-extension://own/photos/photos.html']) {
        assert.equal((await routes.handlers.GITHUB_IGNORED_LIST({ action: 'backup' }, { url })).error.code, 'forbidden');
    }
    assert.equal(routes.isExtensionOnly('GITHUB_IGNORED_LIST'), true);
    for (const url of ['chrome-extension://own/options/options.html#favorites', 'chrome-extension://own/options/favorites.html#ignored']) {
        assert.equal((await routes.handlers.GITHUB_IGNORED_LIST({ action: 'status' }, { url })).ok, true);
    }
    assert.equal(h.writes, 0);
});
