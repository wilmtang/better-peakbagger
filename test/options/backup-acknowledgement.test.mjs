// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { favoriteClimbers as Favorites } from '../../src/favorites/favorite-climbers.js';
import { settingsTransfer as Transfer } from '../../src/settings/settings-transfer.js';
import { loadOptions, el, waitFor, favoriteKey, favoriteStore, registerCleanup } from '../helpers/options-helpers.mjs';

registerCleanup();

for (const kind of ['favorites', 'settings']) {
    for (const change of ['edit', 'repository', 'superseded', 'missing identity']) {
        test(`${kind} backup acknowledges its worker snapshot across ${change}`, async () => {
            const original = favoriteStore([{ cid: 900002, name: 'First', addedAt: 10, source: 'manual' }]);
            let repo = 'ada/peaks';
            let finish;
            const type = kind === 'favorites' ? 'GITHUB_FAVORITES_BACKUP' : 'GITHUB_SETTINGS_BACKUP';
            const button = kind === 'favorites' ? 'favorites-backup' : 'settings-backup-github-backup';
            const status = kind === 'favorites' ? 'favorites-github-status' : 'settings-backup-github-status';
            const dom = await loadOptions({ theme: 'dark' }, {
                local: { [favoriteKey]: original },
                prepareChrome: chrome => {
                    chrome.permissions = { contains: async () => true, request: async () => true };
                    chrome.runtime.sendMessage = async message => {
                        if (message.type === 'GITHUB_AUTH_STATUS') return { connected: true, repo: { fullName: repo } };
                        if (message.type === type) return new Promise(resolve => { finish = resolve; });
                        return {};
                    };
                },
            });
            await waitFor(dom, () => !el(dom, button).disabled);
            el(dom, button).click();
            await waitFor(dom, () => !!finish);
            const signature = kind === 'favorites' ? Favorites.backupSignature(original) : Transfer.signature({ theme: 'dark' });
            if (change === 'edit') {
                if (kind === 'favorites') await dom.chrome.storage.local.set({ [favoriteKey]: favoriteStore([
                    ...original.entries, { cid: 900003, name: 'Second', addedAt: 20, source: 'manual' },
                ]) });
                else await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'light' } });
                // The subscription must consume the new snapshot before the old reply lands.
                if (kind === 'favorites') await waitFor(dom, () => dom.chrome._localStore[favoriteKey].entries.length === 2);
                else await waitFor(dom, () => el(dom, 'theme').value === 'light');
            }
            if (change === 'repository') {
                repo = 'ada/new-peaks';
                await dom.chrome.storage.local.set({ bpbGithubAuth: { repo: { fullName: repo } } });
                await waitFor(dom, () => el(dom, status).textContent.includes('Working') || el(dom, button).disabled);
            }
            finish({ ok: true, result: { commitUrl: 'https://github.com/ada/peaks/commit/old',
                ...(change === 'missing identity' ? {} : { repo: 'ada/peaks', signature }),
                superseded: change === 'superseded' } });
            await waitFor(dom, () => !el(dom, button).disabled);
            assert.doesNotMatch(el(dom, status).textContent, /backed up ✓/);
            assert.equal(el(dom, status).querySelector('a'), null, 'do not link a different snapshot as current');
            if (['edit', 'superseded'].includes(change)) assert.match(el(dom, status).textContent, /Newer changes need backup/);
            if (change === 'repository') await waitFor(dom, () => el(dom, status).textContent.includes(repo));
            if (change === 'missing identity') assert.match(el(dom, 'status-error-text').textContent, /could not be confirmed/);

            // A later matching acknowledgement must recover the normal persistent success.
            finish = null;
            el(dom, button).click();
            await waitFor(dom, () => !!finish);
            const currentSignature = kind === 'favorites'
                ? Favorites.backupSignature(dom.chrome._localStore[favoriteKey])
                : Transfer.signature(dom.chrome._store.bpbSettings);
            finish({ ok: true, result: { repo, signature: currentSignature, superseded: false,
                commitUrl: `https://github.com/${repo}/commit/current` } });
            await waitFor(dom, () => /backed up ✓/.test(el(dom, status).textContent));
            assert.equal(el(dom, status).querySelector('a').href, `https://github.com/${repo}/commit/current`);
        });
    }
}
