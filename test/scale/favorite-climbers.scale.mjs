// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The custom-list product bound is intentionally above ordinary fixture size.
// Keep its full DOM/render and explicit GitHub serialization cost in the scale
// gate rather than making every default test create 1,500 settings rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { evalBundle, makeChromeStub, waitFor } from '../helpers/load-page.mjs';
import { favoriteClimbers as F } from '../../src/favorite-climbers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAVORITES_KEY = 'bpbFavoriteClimbers';
const LIMIT = F.LIMIT;

test('settings renders and backs up the full 1,500-entry custom list', async () => {
    assert.equal(LIMIT, 1500);
    const html = await readFile(path.join(root, 'options', 'options.html'), 'utf8');
    const entries = Array.from({ length: LIMIT }, (_, index) => ({
        cid: 100000 + index,
        name: `Scale Climber ${String(index + 1).padStart(4, '0')}`,
        addedAt: index,
        source: index % 2 ? 'buddy' : 'manual',
    }));
    const dom = new JSDOM(html, {
        url: 'https://options.better-peakbagger.test/options/options.html#favorites',
        runScripts: 'outside-only',
    });
    const chrome = makeChromeStub({ bpbSettings: { favoritesSource: 'custom' } }, {
        [FAVORITES_KEY]: { schemaVersion: 1, entries },
    });
    let backupMessage = null;
    chrome.permissions = {
        request: async () => true,
        contains: async () => true,
        remove: async () => true,
    };
    chrome.runtime.sendMessage = (message, callback) => {
        let response = {};
        if (message.type === 'GITHUB_AUTH_STATUS') {
            response = {
                enabled: true,
                connected: true,
                hasToken: true,
                repo: { owner: 'scale', name: 'backup', fullName: 'scale/backup' },
            };
        } else if (message.type === 'GITHUB_FAVORITES_BACKUP') {
            backupMessage = message;
            response = {
                ok: true,
                result: { commitUrl: 'https://github.com/scale/backup/commit/full-list' },
            };
        }
        if (typeof callback === 'function') Promise.resolve().then(() => callback(response));
        return Promise.resolve(response);
    };
    dom.chrome = chrome;
    dom.window.chrome = chrome;
    dom.window.caches = { keys: async () => [] };

    await evalBundle(dom.window, 'options/options-head.js');
    await evalBundle(dom.window, 'options/options.js');
    await waitFor(dom, () => dom.window.document.querySelectorAll('.favorite-item').length === LIMIT, 10000);

    const rows = dom.window.document.querySelectorAll('.favorite-item');
    assert.equal(rows[0].dataset.cid, '101499', 'newest sort renders the last stored entry first');
    assert.equal(rows[LIMIT - 1].dataset.cid, '100000');
    assert.match(dom.window.document.getElementById('favorites-add-form').textContent, /1,500 climbers/);

    await waitFor(dom, () => !dom.window.document.getElementById('favorites-github-actions').hidden);
    dom.window.document.getElementById('favorites-backup').click();
    await waitFor(dom, () => backupMessage != null);
    const exported = JSON.parse(backupMessage.content);
    assert.equal(exported.entries.length, LIMIT);
    assert.deepEqual(exported.entries[0], entries[0]);
    assert.deepEqual(exported.entries.at(-1), entries.at(-1));
    await waitFor(dom, () => /Favorites backed up ✓/.test(
        dom.window.document.getElementById('favorites-github-status').textContent
    ));
});
