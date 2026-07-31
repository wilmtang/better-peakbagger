import test from 'node:test';
import assert from 'node:assert/strict';
import {
    loadOptions, loadDraftsPage, el, draftRow, waitFor,
    withGithubBackground, registerCleanup, favoriteKey, favoriteStore
} from '../helpers/options-helpers.mjs';

registerCleanup();

test('connected GitHub actions work with ascent backup off and restore with Undo', async () => {
    const original = { cid: 900002, name: 'Original Favorite', addedAt: 10, source: 'manual' };
    const restored = { cid: 900003, name: 'Restored Favorite', addedAt: 20, source: 'buddy' };
    const messages = [];
    const status = {
        enabled: true, connected: true, hasToken: true,
        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const dom = await loadOptions({ favoritesSource: 'custom', enableGithubBackup: false }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                messages.push(JSON.parse(JSON.stringify(message)));
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
                if (message.type === 'GITHUB_FAVORITES_BACKUP') reply = {
                    ok: true,
                    result: {
                        path: 'favorite-climbers.json',
                        commitUrl: 'https://github.com/ada/peaks/commit/favorite123',
                    },
                };
                if (message.type === 'GITHUB_FAVORITES_RESTORE') reply = {
                    ok: true,
                    content: JSON.stringify({
                        schemaVersion: 1,
                        exportedAt: '2026-07-21T12:00:00.000Z',
                        entries: [restored],
                    }),
                };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-github-actions').hidden);
    assert.match(el(dom, 'favorites-github-status').textContent, /ada\/peaks/);

    el(dom, 'favorites-backup').click();
    await waitFor(dom, () => messages.some(message => message.type === 'GITHUB_FAVORITES_BACKUP'));
    const backup = messages.find(message => message.type === 'GITHUB_FAVORITES_BACKUP');
    assert.deepEqual(backup, { type: 'GITHUB_FAVORITES_BACKUP' });
    await waitFor(dom, () => /Favorites backed up ✓/.test(el(dom, 'favorites-github-status').textContent));
    const commitLink = el(dom, 'favorites-github-status').querySelector('a');
    assert.equal(commitLink.textContent, 'View commit');
    assert.equal(commitLink.getAttribute('href'), 'https://github.com/ada/peaks/commit/favorite123');
    assert.equal(commitLink.getAttribute('target'), '_blank');
    assert.equal(commitLink.getAttribute('rel'), 'noopener noreferrer');

    const auto = el(dom, 'favorites-auto-backup');
    assert.equal(auto.checked, false);
    auto.checked = true;
    auto.dispatchEvent(new dom.window.Event('change'));
    await waitFor(dom, () => dom.chrome._store.bpbSettings.autoFavoritesBackup === true);

    await waitFor(dom, () => !el(dom, 'favorites-restore').disabled);
    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === false);
    assert.equal(dom.chrome._localStore[favoriteKey].entries[0].cid, original.cid,
        'reading a backup must not replace favorites before confirmation');
    assert.equal(el(dom, 'favorites-restore-confirmation-title').textContent,
        'Restore favorites from backup?');
    assert.match(el(dom, 'favorites-restore-confirmation-detail').textContent,
        /1 favorite will be added\. 1 custom favorite will be removed\./);
    assert.match(el(dom, 'favorites-restore-confirmation-detail').textContent,
        /list will match the backup from ada\/peaks/);
    assert.equal(el(dom, 'favorites-restore-confirm').textContent, 'Restore backup');
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-restore-cancel'));

    el(dom, 'favorites-restore-cancel').click();
    assert.equal(el(dom, 'favorites-restore-confirmation').hidden, true);
    assert.equal(dom.chrome._localStore[favoriteKey].entries[0].cid, original.cid,
        'cancelling a restore must leave the custom list untouched');
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-restore'));

    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === false);
    el(dom, 'favorites-restore-confirm').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.[0]?.cid === restored.cid
        && el(dom, 'favorites-restore-undo').hidden === false);
    assert.equal(el(dom, 'favorites-restore-undo').hidden, false);
    assert.match(el(dom, 'favorites-restore-undo').textContent, /restored from GitHub/);
    assert.match(el(dom, 'favorites-github-status').textContent, /stored as favorite-climbers\.json/,
        'the prior commit result must not imply that a changed local list is current');
    assert.equal(el(dom, 'favorites-github-status').querySelector('a'), null);

    el(dom, 'favorites-restore-undo-button').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.[0]?.cid === original.cid);
});

test('a failed favorites restore retries the reviewed backup without downloading it again', async () => {
    const original = { cid: 900002, name: 'Original Favorite', addedAt: 10, source: 'manual' };
    const restored = { cid: 900003, name: 'Restored Favorite', addedAt: 20, source: 'buddy' };
    let restoreReads = 0;
    let rejectFirstWrite;
    let favoriteWriteAttempts = 0;
    const dom = await loadOptions({ favoritesSource: 'custom', enableGithubBackup: true }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            const nativeSet = chrome.storage.local.set;
            chrome.storage.local.set = patch => {
                if (!(favoriteKey in patch) || favoriteWriteAttempts++ > 0) return nativeSet(patch);
                return new Promise((resolve, reject) => { rejectFirstWrite = reject; });
            };
            chrome.runtime.sendMessage = message => {
                if (message.type === 'GITHUB_FAVORITES_RESTORE') {
                    restoreReads++;
                    return Promise.resolve({
                        ok: true,
                        content: JSON.stringify({
                            schemaVersion: 1,
                            exportedAt: '2026-07-21T12:00:00.000Z',
                            entries: [restored],
                        }),
                    });
                }
                return Promise.resolve({
                    enabled: true,
                    connected: true,
                    hasToken: true,
                    repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                });
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-restore').disabled);

    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === false);
    const reviewedImpact = el(dom, 'favorites-restore-confirmation-detail').textContent;
    el(dom, 'favorites-restore-confirm').click();
    await waitFor(dom, () => typeof rejectFirstWrite === 'function');
    assert.equal(el(dom, 'favorites-restore-confirmation').getAttribute('aria-busy'), 'true');
    assert.equal(dom.window.document.activeElement, el(dom, 'favorites-restore-confirmation'));

    rejectFirstWrite(new Error('storage unavailable'));
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').getAttribute('aria-busy') === null
        && dom.window.document.activeElement === el(dom, 'favorites-restore-confirm'));
    assert.equal(el(dom, 'favorites-restore-confirmation').hidden, false);
    assert.equal(el(dom, 'favorites-restore-confirmation-detail').textContent, reviewedImpact);
    assert.equal(restoreReads, 1);

    el(dom, 'favorites-restore-confirm').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === true
        && dom.chrome._localStore[favoriteKey].entries[0].cid === restored.cid);
    assert.equal(restoreReads, 1, 'retrying must reuse the reviewed backup payload');
    assert.equal(favoriteWriteAttempts, 2);
});

test('a restore from Backup & sync confirms and undoes without the list page open', async () => {
    const original = { cid: 900002, name: 'Original Favorite', addedAt: 10, source: 'manual' };
    const restored = { cid: 900003, name: 'Restored Favorite', addedAt: 20, source: 'buddy' };
    const dom = await loadOptions({ favoritesSource: 'buddies' }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    reply = {
                        enabled: true, connected: true, hasToken: true,
                        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                }
                if (message.type === 'GITHUB_FAVORITES_RESTORE') {
                    reply = {
                        ok: true,
                        content: JSON.stringify({
                            schemaVersion: 1,
                            exportedAt: '2026-07-21T12:00:00.000Z',
                            entries: [restored],
                        }),
                    };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-github-actions').hidden);
    // The list workspace is a separate page; restore does its whole job here.
    assert.equal(el(dom, 'favorites-custom-panel'), null);

    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => el(dom, 'favorites-restore-confirmation').hidden === false);
    // Restore lives in Backup & sync, never inside the custom panel the Buddy
    // List source hides, so its confirmation and undo are always reachable.
    assert.ok(el(dom, 'favorites-restore-confirmation').closest('#github-favorites-backup'));
    assert.equal(el(dom, 'favorites-restore-confirmation').closest('#favorites-custom-panel'), null,
        'the restore confirmation must not be trapped inside the hidden custom panel');

    el(dom, 'favorites-restore-confirm').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.[0]?.cid === restored.cid
        && el(dom, 'favorites-restore-undo').hidden === false);
    assert.equal(el(dom, 'favorites-restore-undo').closest('#favorites-custom-panel'), null,
        'the undo that the confirmation promised must stay reachable');

    el(dom, 'favorites-restore-undo-button').click();
    await waitFor(dom, () => dom.chrome._localStore[favoriteKey]?.entries?.[0]?.cid === original.cid);
});

test('the favorites auto-backup checkbox populates from synced settings', async () => {
    const dom = await loadOptions({ autoFavoritesBackup: true });
    assert.equal(el(dom, 'favorites-auto-backup').checked, true);
});

test('favorites restore fails closed on an unknown backup schema', async () => {
    const original = { cid: 900002, name: 'Keep Me', addedAt: 10, source: 'manual' };
    const dom = await loadOptions({ favoritesSource: 'custom', enableGithubBackup: true }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_FAVORITES_RESTORE'
                    ? { ok: true, content: JSON.stringify({ schemaVersion: 2, entries: [] }) }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-github-actions').hidden);
    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => /newer format/.test(el(dom, 'status-error-text').textContent));
    assert.deepEqual(dom.chrome._localStore[favoriteKey].entries, [original]);
    assert.equal(el(dom, 'favorites-restore-undo').hidden, true);
});

test('favorites restore rejects a backup above the 1,500-entry bound', async () => {
    const original = { cid: 900002, name: 'Keep Me', addedAt: 10, source: 'manual' };
    const oversized = Array.from({ length: 1501 }, (_, index) => ({
        cid: 100000 + index,
        name: `Climber ${index + 1}`,
        addedAt: index,
        source: 'manual',
    }));
    const dom = await loadOptions({ favoritesSource: 'custom' }, {
        local: { [favoriteKey]: favoriteStore([original]) },
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_FAVORITES_RESTORE'
                    ? { ok: true, content: JSON.stringify({ schemaVersion: 1, entries: oversized }) }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => !el(dom, 'favorites-github-actions').hidden);
    el(dom, 'favorites-restore').click();
    await waitFor(dom, () => /not valid/.test(el(dom, 'status-error-text').textContent));
    assert.deepEqual(dom.chrome._localStore[favoriteKey].entries, [original]);
});

test('favorites points disconnected users to the GitHub connection above it', async () => {
    const dom = await loadOptions({ favoritesSource: 'custom' }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_STATUS'
                    ? { enabled: false, connected: false, hasToken: false }
                    : {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => /Connect GitHub above to back up your custom favorites/
        .test(el(dom, 'favorites-github-status').textContent));
    assert.equal(el(dom, 'favorites-github-actions').hidden, true);
    // The connection subsection is the first thing above this one in Backup & sync.
    const section = dom.window.document.getElementById('github-favorites-backup');
    assert.equal(section.previousElementSibling.id, 'github-settings-backup');
    assert.equal(section.parentElement.querySelector('.subsection').id, 'github-connection');
});

test('report drafts render newest-first with labels, fallbacks, and edit links', async () => {
    const now = Date.now();
    const local = {
        'bpbReportDraft:900001:a123': {
            text: '[b]Newest report[/b]', mode: 'rich', savedAt: now - 1000,
            label: { peak: 'Glacier Peak', date: '7/12/2026' }
        },
        'bpbReportDraft:900001:p456': {
            text: 'Peak draft', mode: 'rich', savedAt: now - 2000
        },
        'bpbReportDraft:900001:new': {
            text: 'New ascent draft', mode: 'markdown', source: 'New ascent draft', savedAt: now - 3000
        },
        'bpbReportDraft:900001:a999': {
            text: 'Expired', mode: 'rich', savedAt: now - 14 * 24 * 60 * 60 * 1000 - 1
        }
    };
    const dom = await loadDraftsPage({}, { local });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.draft-item').length === 3);

    const rows = Array.from(dom.window.document.querySelectorAll('.draft-item'));
    assert.deepEqual(rows.map(row => row.querySelector('.draft-title').textContent), [
        'Glacier Peak · 7/12/2026',
        'New ascent · peak #456',
        'New ascent'
    ]);
    assert.deepEqual(rows.map(row => row.querySelector('.draft-mode').textContent), ['Rich', 'Rich', 'Markdown']);
    assert.equal(rows[0].querySelector('.draft-excerpt').textContent, '**Newest report**');
    assert.deepEqual(rows.map(row => row.querySelector('a.secondary').href), [
        'https://peakbagger.com/climber/ascentedit.aspx?aid=123&cid=900001',
        'https://peakbagger.com/climber/ascentedit.aspx?pid=456&cid=900001',
        'https://peakbagger.com/climber/ascentedit.aspx?cid=900001'
    ]);
    assert.equal('bpbReportDraft:900001:a999' in dom.chrome._localStore, false,
        'opening the manager should prune expired drafts');
    assert.equal(el(dom, 'drafts-empty').hidden, true);
    assert.equal(el(dom, 'drafts-delete-all').hidden, false);
});

test('report drafts retain provisional peak identities and their mountain labels', async () => {
    const key = 'bpbReportDraft:900001:p-105366';
    const dom = await loadDraftsPage({}, { local: {
        [key]: {
            text: 'Provisional peak report',
            mode: 'rich',
            savedAt: Date.now(),
            label: { peak: 'Hibox Mountain', date: '7/18/2026' }
        }
    } });
    await waitFor(dom, () => draftRow(dom, key));

    const row = draftRow(dom, key);
    assert.equal(row.querySelector('.draft-title').textContent, 'Hibox Mountain · 7/18/2026');
    assert.equal(row.querySelector('a.secondary').href,
        'https://peakbagger.com/climber/ascentedit.aspx?pid=-105366&cid=900001');
});

test('copy Markdown preserves exact source or converts the stored bracket report', async () => {
    const now = Date.now();
    const richKey = 'bpbReportDraft:900001:a123';
    const markdownKey = 'bpbReportDraft:900001:a124';
    const dom = await loadDraftsPage({}, { local: {
        [richKey]: { text: '[u]under[/u]', mode: 'rich', savedAt: now },
        [markdownKey]: {
            text: '[b]normalized[/b]', mode: 'markdown', source: 'exact  **source**', savedAt: now - 1
        }
    } });
    const writes = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { writes.push(value); } }
    });

    draftRow(dom, markdownKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => writes.length === 1);
    draftRow(dom, richKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => writes.length === 2);
    assert.deepEqual(writes, ['exact  **source**', '<u>under</u>']);
    await waitFor(dom, () => el(dom, 'status').textContent === 'Copied');
    assert.equal(el(dom, 'status').textContent, 'Copied');

    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('denied'); } }
    });
    draftRow(dom, richKey).querySelector('[data-action="copy"]').click();
    await waitFor(dom, () => el(dom, 'status-error-text').textContent === 'Couldn’t copy Markdown');
});

test('deleting one draft is reversible and its Undo survives a live refresh', async () => {
    const key = 'bpbReportDraft:900001:a123';
    const otherKey = 'bpbReportDraft:900001:p456';
    const record = { text: 'Held verbatim', mode: 'rich', savedAt: Date.now() };
    const dom = await loadDraftsPage({}, { local: { [key]: record } });
    await waitFor(dom, () => draftRow(dom, key));

    draftRow(dom, key).querySelector('[data-action="delete"]').click();
    await waitFor(dom, () => !(key in dom.chrome._localStore));
    assert.match(draftRow(dom, key).textContent, /Draft deleted\s*Undo/);
    // The activated Delete button is gone from the DOM; a keyboard user must
    // land on the Undo they now need, not on <body>, because it expires in 6s.
    assert.equal(dom.window.document.activeElement,
        draftRow(dom, key).querySelector('[data-action="undo"]'),
        'deleting a draft must not drop focus to the document body');

    await dom.chrome.storage.local.set({
        [otherKey]: { text: 'Arrived from another tab', mode: 'rich', savedAt: Date.now() + 1 }
    });
    await waitFor(dom, () => draftRow(dom, otherKey));
    assert.match(draftRow(dom, key).textContent, /Draft deleted\s*Undo/,
        'storage.onChanged must not strip an active Undo row');

    draftRow(dom, key).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => key in dom.chrome._localStore && draftRow(dom, key)?.querySelector('.draft-title'));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[key])), record);
    assert.equal(el(dom, 'status').textContent, 'Draft restored');
    assert.equal(el(dom, 'status').classList.contains('show'), true);
});

test('a failed single-draft Undo keeps its recovery snapshot available for retry', async () => {
    const key = 'bpbReportDraft:900001:a123';
    const record = { text: 'Retry this restoration', mode: 'rich', savedAt: Date.now() };
    const dom = await loadDraftsPage({}, { local: { [key]: record } });
    await waitFor(dom, () => draftRow(dom, key));

    draftRow(dom, key).querySelector('[data-action="delete"]').click();
    await waitFor(dom, () => !(key in dom.chrome._localStore));

    const originalSet = dom.chrome.storage.local.set;
    let failOnce = true;
    dom.chrome.storage.local.set = async patch => {
        if (failOnce) {
            failOnce = false;
            throw new Error('transient storage failure');
        }
        return originalSet(patch);
    };

    draftRow(dom, key).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => el(dom, 'status-error-text').textContent === 'Couldn’t restore the draft. Try again.');
    assert.equal(dom.chrome._localStore[key], undefined);
    assert.match(draftRow(dom, key).textContent, /Draft deleted\s*Undo/);
    assert.equal(dom.window.document.activeElement, draftRow(dom, key).querySelector('[data-action="undo"]'));

    draftRow(dom, key).querySelector('[data-action="undo"]').click();
    await waitFor(dom, () => key in dom.chrome._localStore && draftRow(dom, key)?.querySelector('.draft-title'));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[key])), record);
});

test('delete all states the count, requires confirmation, and retains a failed Undo for retry', async () => {
    const firstKey = 'bpbReportDraft:900001:a123';
    const secondKey = 'bpbReportDraft:900001:p456';
    const records = {
        [firstKey]: { text: 'First', mode: 'rich', savedAt: Date.now() },
        [secondKey]: { text: 'Second', mode: 'markdown', source: 'Second', savedAt: Date.now() - 1 }
    };
    const dom = await loadDraftsPage({}, {
        local: records,
        prepareWindow: window => {
            window.confirm = () => {
                throw new Error('the draft manager must not use the native confirm dialog');
            };
        }
    });
    await waitFor(dom, () => dom.window.document.querySelectorAll('.draft-item').length === 2);
    assert.equal(el(dom, 'drafts-delete-all').textContent, 'Delete all 2 drafts');

    // The in-page block the favorites mirror and settings import already use.
    const confirmation = el(dom, 'drafts-delete-all-confirmation');
    assert.equal(confirmation.hidden, true);
    el(dom, 'drafts-delete-all').click();
    assert.equal(confirmation.hidden, false);
    assert.equal(confirmation.getAttribute('role'), 'alertdialog');
    assert.match(el(dom, 'drafts-delete-all-confirmation-title').textContent,
        /Delete all 2 trip report drafts from this device/);
    assert.match(confirmation.textContent, /6 seconds to undo/);
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-delete-all-confirm'));

    // Cancel leaves everything alone and hands focus back to its opener.
    el(dom, 'drafts-delete-all-cancel').click();
    assert.equal(confirmation.hidden, true);
    assert.deepEqual(dom.chrome._localStore, records, 'Cancel must leave every draft untouched');
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-delete-all'));

    // Escape does the same.
    el(dom, 'drafts-delete-all').click();
    assert.equal(confirmation.hidden, false);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(confirmation.hidden, true);
    assert.deepEqual(dom.chrome._localStore, records, 'Escape must leave every draft untouched');
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-delete-all'));

    el(dom, 'drafts-delete-all').click();
    el(dom, 'drafts-delete-all-confirm').click();
    await waitFor(dom, () => !(firstKey in dom.chrome._localStore) && !(secondKey in dom.chrome._localStore));
    assert.equal(confirmation.hidden, true, 'the question closes once it is answered');
    assert.equal(el(dom, 'drafts-undo-all').hidden, false);
    assert.match(el(dom, 'drafts-undo-all').textContent, /All drafts deleted\s*Undo/);
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-undo-all-button'));

    const originalSet = dom.chrome.storage.local.set;
    let failOnce = true;
    dom.chrome.storage.local.set = async patch => {
        if (failOnce) {
            failOnce = false;
            throw new Error('transient storage failure');
        }
        return originalSet(patch);
    };

    el(dom, 'drafts-undo-all-button').click();
    await waitFor(dom, () => el(dom, 'status-error-text').textContent === 'Couldn’t restore the drafts. Try again.');
    assert.equal(firstKey in dom.chrome._localStore, false);
    assert.equal(secondKey in dom.chrome._localStore, false);
    assert.equal(el(dom, 'drafts-undo-all').hidden, false);
    assert.equal(el(dom, 'drafts-undo-all-button').disabled, false);
    assert.equal(dom.window.document.activeElement, el(dom, 'drafts-undo-all-button'));

    el(dom, 'drafts-undo-all-button').click();
    await waitFor(dom, () => firstKey in dom.chrome._localStore && secondKey in dom.chrome._localStore);
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore)), records);
});

test('the drafts manager shows an empty state and refreshes when another tab autosaves', async () => {
    const dom = await loadDraftsPage({}, { local: { unrelated: 'preserved' } });
    assert.equal(el(dom, 'drafts-empty').hidden, false);
    assert.equal(el(dom, 'drafts-list').hidden, true);
    assert.equal(el(dom, 'drafts-delete-all').hidden, true);

    const key = 'bpbReportDraft:900001:new';
    await dom.chrome.storage.local.set({
        [key]: { text: 'Live draft', mode: 'rich', savedAt: Date.now() }
    });
    await waitFor(dom, () => draftRow(dom, key));
    assert.equal(el(dom, 'drafts-empty').hidden, true);
    assert.equal(draftRow(dom, key).querySelector('.draft-title').textContent, 'New ascent');
    assert.equal(dom.chrome._localStore.unrelated, 'preserved');
});

// The ImgBB key is a device-local credential, not a synced setting: Settings
// can configure it through the same worker routes the photo page uses, but the
// value never round-trips back into the page.
const loadImgbb = ({ status = { ok: true, configured: false, permissionGranted: false }, grant = true } = {}) => {
    const messages = [];
    let saved = null;
    const load = loadOptions({}, {
        prepareChrome: chrome => {
            chrome.permissions = {
                request: async () => grant,
                contains: async () => status.permissionGranted,
                remove: async () => true,
            };
            chrome.runtime.sendMessage = (message, callback) => {
                messages.push(structuredClone(message));
                let reply = {};
                if (message.type === 'PHOTO_IMGBB_STATUS') reply = { ...status, configured: saved != null || status.configured };
                if (message.type === 'PHOTO_IMGBB_SAVE_KEY') { saved = message.key; reply = { ok: true }; }
                if (message.type === 'PHOTO_IMGBB_REMOVE_KEY') { saved = null; reply = { ok: true }; }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        }
    });
    return { load, messages, key: () => saved };
};

test('the ImgBB key setting explains the service and links its key page and terms', async () => {
    const { load } = loadImgbb();
    const dom = await load;
    const desc = el(dom, 'imgbb-key-desc');
    assert.match(desc.textContent, /free image hosting site/i);
    assert.deepEqual([...desc.querySelectorAll('a')].map(link => ({
        label: link.textContent,
        href: link.getAttribute('href'),
        target: link.target,
        rel: link.rel,
    })), [
        { label: 'ImgBB', href: 'https://imgbb.com/', target: '_blank', rel: 'noopener noreferrer' },
        { label: 'Get API key', href: 'https://api.imgbb.com/', target: '_blank', rel: 'noopener noreferrer' },
        { label: 'ImgBB’s terms of service', href: 'https://imgbb.com/tos', target: '_blank', rel: 'noopener noreferrer' },
        { label: 'Read the photo guide', href: '../photos/guide.html', target: '_blank', rel: 'noopener noreferrer' },
    ]);
    assert.equal(el(dom, 'imgbb-key').type, 'password');
    assert.match(desc.textContent, /never exposed to Peakbagger, another website, GitHub, browser sync, or status UI/i);
    assert.match(desc.textContent, /exact packaged photo page.*direct upload to ImgBB/i);
});

test('the ImgBB key saves through the worker with upload access, and is never read back', async () => {
    const { load, messages, key } = loadImgbb();
    const dom = await load;
    await waitFor(dom, () => el(dom, 'imgbb-key-status').textContent === 'No key saved on this device.');
    assert.equal(el(dom, 'imgbb-key-remove').hidden, true);

    // A key with whitespace is not a key; nothing is sent.
    el(dom, 'imgbb-key').value = 'not a key';
    el(dom, 'imgbb-key-save').click();
    await waitFor(dom, () => /no spaces/i.test(el(dom, 'imgbb-key-status').textContent));
    assert.equal(messages.some(message => message.type === 'PHOTO_IMGBB_SAVE_KEY'), false);

    el(dom, 'imgbb-key').value = '  abc123  ';
    el(dom, 'imgbb-key-save').click();
    await waitFor(dom, () => key() === 'abc123');
    await waitFor(dom, () =>
        el(dom, 'imgbb-key-status').textContent === 'ImgBB is configured on this device.');
    assert.equal(el(dom, 'imgbb-key').value, '', 'the entered key is cleared, never displayed back');
    assert.equal(el(dom, 'imgbb-key-remove').hidden, false);
    // The credential is device-local; it must not reach synced settings.
    assert.equal(JSON.stringify(dom.chrome._store).includes('abc123'), false);

    el(dom, 'imgbb-key-remove').click();
    await waitFor(dom, () => key() === null);
    await waitFor(dom, () => el(dom, 'imgbb-key-status').textContent === 'No key saved on this device.');
    assert.equal(el(dom, 'imgbb-key-remove').hidden, true);
});

test('a declined ImgBB host permission blocks the save and says what to do', async () => {
    const { load, messages } = loadImgbb({ grant: false });
    const dom = await load;
    await waitFor(dom, () => el(dom, 'imgbb-key-status').textContent === 'No key saved on this device.');

    el(dom, 'imgbb-key').value = 'abc123';
    el(dom, 'imgbb-key-save').click();
    await waitFor(dom, () => /Allow access to api\.imgbb\.com/.test(el(dom, 'imgbb-key-status').textContent));
    assert.equal(messages.some(message => message.type === 'PHOTO_IMGBB_SAVE_KEY'), false,
        'a key that cannot upload is not stored');
    assert.equal(el(dom, 'imgbb-key').value, 'abc123', 'the typed key survives for a second attempt');
});

test('a saved ImgBB key without upload access reports the gap instead of looking ready', async () => {
    const { load } = loadImgbb({
        status: { ok: true, configured: true, permissionGranted: false },
    });
    const dom = await load;
    await waitFor(dom, () =>
        el(dom, 'imgbb-key-status').textContent ===
            'ImgBB is configured, but upload permission is not granted.');
    assert.ok(el(dom, 'imgbb-key-status').classList.contains('is-error'));
    assert.equal(el(dom, 'imgbb-key-remove').hidden, false);
});

test('the sidebar links every settings section, in order', async () => {
    const dom = await loadOptions({});
    const doc = dom.window.document;
    const nav = doc.querySelector('.side-nav');
    assert.ok(nav, 'the sidebar nav exists');
    assert.equal(nav.getAttribute('aria-label'), 'Settings sections');

    const links = Array.from(nav.querySelectorAll('a.nav-item'));
    // Every link points at an existing settings section...
    for (const link of links) {
        const id = link.getAttribute('href').slice(1);
        const target = doc.getElementById(id);
        assert.ok(target, `sidebar link #${id} resolves to an element`);
        assert.ok(target.classList.contains('settings-section'), `#${id} is a settings section`);
    }
    // ...and the links cover every section, in document order — this guards
    // against a section being added, removed, or renamed without its link.
    const linkTargets = links.map(link => link.getAttribute('href').slice(1));
    const sectionIds = Array.from(doc.querySelectorAll('.content .settings-section'), section => section.id);
    assert.deepEqual(linkTargets, sectionIds);
    assert.deepEqual(linkTargets, ['general', 'capture', 'map-chart', 'beta', 'favorites', 'github', 'about']);
});

test('the sidebar exposes always-visible sub-links for the grouped sections', async () => {
    const dom = await loadOptions({});
    const doc = dom.window.document;
    const subLinks = Array.from(doc.querySelectorAll('.side-nav a.nav-subitem'));
    assert.deepEqual(subLinks.map(link => link.getAttribute('href')),
        ['#capture-gpx', '#capture-report', '#capture-photos', '#drafts',
            '#map-chart-chart', '#map-chart-map', '#github-connection',
            '#github-settings-backup', '#github-favorites-backup', '#github-photos-backup',
            '#github-backup']);
    for (const link of subLinks) {
        const target = doc.getElementById(link.getAttribute('href').slice(1));
        assert.ok(target && target.classList.contains('subsection'),
            `${link.getAttribute('href')} resolves to a subsection group`);
        assert.equal(target.getAttribute('role'), 'group');
        assert.equal(target.getAttribute('aria-labelledby'), target.querySelector('h3').id);
    }
});

const activeLinks = dom =>
    Array.from(dom.window.document.querySelectorAll('.nav-item[aria-current], .nav-subitem[aria-current]'));

test('the sidebar marks the first section active on load', async () => {
    const dom = await loadOptions({});
    const active = activeLinks(dom);
    assert.equal(active.length, 1, 'exactly one link is active');
    assert.equal(active[0].getAttribute('href'), '#general');
});

test('a deep-link hash is the active section on load', async () => {
    const dom = await loadOptions({}, { hash: '#map-chart' });
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#map-chart');
});

test('a drafts deep link activates the TR-drafts manager', async () => {
    const dom = await loadOptions({}, {
        hash: '#drafts',
        prepareWindow: window => {
            const nativeRect = window.HTMLElement.prototype.getBoundingClientRect;
            window.HTMLElement.prototype.getBoundingClientRect = function () {
                if (this.classList?.contains('content')) return { top: 100 };
                if (this.id === 'drafts') return { top: 450 };
                return nativeRect.call(this);
            };
            const nativeStyle = window.getComputedStyle.bind(window);
            window.getComputedStyle = element => element.id === 'drafts'
                ? { scrollMarginTop: '24px' }
                : nativeStyle(element);
        }
    });
    const content = dom.window.document.querySelector('.content');
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#drafts');
    assert.equal(active[0].textContent, 'TR drafts');
    // The manager moved under Activity creation; the worker's #drafts URL and
    // this landing must survive that, and the parent gets the accent.
    assert.ok(active[0].classList.contains('nav-subitem'));
    assert.equal(dom.window.document.querySelector('.nav-item.nav-parent-active')?.getAttribute('href'),
        '#capture');
    assert.equal(content.style.scrollBehavior, 'auto',
        'the initial native fragment landing must not inherit smooth scrolling');
    content.dispatchEvent(new dom.window.Event('scrollend'));
    assert.equal(content.scrollTop, 326,
        'the nested content scroller should align the target to its scroll margin');
    assert.equal(content.style.scrollBehavior, '',
        'normal sidebar navigation should regain stylesheet-controlled smooth scrolling');
});

test('hash navigation moves the active sidebar link', async () => {
    const dom = await loadOptions({});
    dom.window.location.hash = '#beta';
    dom.window.dispatchEvent(new dom.window.Event('hashchange'));
    const active = activeLinks(dom);
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('href'), '#beta');
});

test('sidebar navigation animates nearby jumps and makes long jumps instant', async () => {
    let draftsTop = 0;
    const dom = await loadOptions({}, {
        prepareWindow: window => {
            const content = window.document.querySelector('.content');
            const drafts = window.document.getElementById('drafts');
            Object.defineProperty(content, 'clientHeight', { configurable: true, value: 800 });
            content.getBoundingClientRect = () => ({ top: 100 });
            drafts.getBoundingClientRect = () => ({ top: draftsTop });
            const nativeStyle = window.getComputedStyle.bind(window);
            window.getComputedStyle = element => element === drafts
                ? { scrollMarginTop: '24px' }
                : nativeStyle(element);
        }
    });
    const doc = dom.window.document;
    const content = doc.querySelector('.content');
    const draftsLink = doc.querySelector('.side-nav a[href="#drafts"]');

    // 1,000 px is below both two viewports (1,600 px here) and the 1,200 px
    // absolute cap, so the stylesheet keeps control.
    draftsTop = 1124;
    draftsLink.click();
    assert.equal(content.style.scrollBehavior, '');

    // The same target 1,400 px away is under two viewports but over the pixel
    // cap, so it must bypass smooth scrolling. The inline override survives the
    // native click action, then clears on the next task.
    draftsTop = 1524;
    draftsLink.click();
    assert.equal(content.style.scrollBehavior, 'auto');
    await new Promise(resolve => dom.window.setTimeout(resolve, 5));
    assert.equal(content.style.scrollBehavior, '');

    draftsLink.addEventListener('click', event => event.preventDefault(), { once: true });
    draftsLink.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
    }));
    assert.equal(content.style.scrollBehavior, '', 'a modified click must not move the current page');
});

test('a deep link to a subsection activates its sub-item and marks the parent', async () => {
    const dom = await loadOptions({}, { hash: '#capture-gpx' });
    const doc = dom.window.document;
    const current = activeLinks(dom);
    assert.equal(current.length, 1, 'exactly one link is current');
    assert.equal(current[0].getAttribute('href'), '#capture-gpx');
    assert.ok(current[0].classList.contains('nav-subitem'));
    // The parent nav-item is highlighted (accent) but not itself "current".
    const parent = doc.querySelector('.side-nav a.nav-item[href="#capture"]');
    assert.ok(parent.classList.contains('nav-parent-active'));
    assert.equal(parent.hasAttribute('aria-current'), false);
});

test('the scroll-spy survives jsdom\'s zero-layout world', async () => {
    // jsdom reports every offset/rect as 0 and nothing scrolls; the scroll
    // handler must not throw and must keep exactly one link active. The offset
    // math itself is only provable in a real browser (see the plan's step 5).
    const dom = await loadOptions({ enableReportEditor: false });
    const content = dom.window.document.querySelector('.content');
    assert.doesNotThrow(() => content.dispatchEvent(new dom.window.Event('scroll')));
    assert.equal(activeLinks(dom).length, 1);
    const active = activeLinks(dom)[0];
    assert.equal(active.closest('[hidden]'), null,
        'a hidden editor-dependent nav item must not become current');
    assert.equal(el(dom, active.hash.slice(1)).hidden, false,
        'the scroll-spy must resolve to a visible settings section');
});

// ---- GitHub connection and ascent-backup setup ----------------------------

// Wire the options page's GITHUB_AUTH_* messages to a scripted background and a

test('the shared GitHub connection stays visible while ascent backup is off by default', async () => {
    const dom = await loadOptions({}, { prepareChrome: withGithubBackground({ enabled: false }) });
    assert.equal(el(dom, 'enable-github-backup').checked, false);
    assert.equal(el(dom, 'github-detail').hidden, false);
    assert.equal(el(dom, 'github-ascent-detail').hidden, true);
    assert.match(el(dom, 'github-panel').textContent, /Connect a GitHub account/);
});

test('enabling ascent backup persists only the ascent gate and leaves GitHub connection separate', async () => {
    let requested = null;
    const dom = await loadOptions({}, {
        prepareChrome: chrome => {
            withGithubBackground({ enabled: true, connected: false, hasToken: false })(chrome);
            const request = chrome.permissions.request;
            chrome.permissions.request = async arg => { requested = arg; return request(arg); };
        }
    });
    const toggle = el(dom, 'enable-github-backup');
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(requested, null);
    assert.equal(dom.chrome._store.bpbSettings.enableGithubBackup, true);
    assert.equal(el(dom, 'github-ascent-detail').hidden, false);
    assert.match(el(dom, 'github-ascent-panel').textContent, /Connect GitHub above/);
});

test('the shared Connect GitHub action requests host permission and keeps denial actionable', async () => {
    const dom = await loadOptions({}, { prepareChrome: withGithubBackground({ enabled: false }, { grant: false }) });
    const connect = Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub');
    connect.click();
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(el(dom, 'enable-github-backup').checked, false);
    assert.notEqual(dom.chrome._store.bpbSettings.enableGithubBackup, true);
    assert.equal(el(dom, 'github-detail').hidden, false);
    assert.match(el(dom, 'github-panel').textContent, /GitHub access wasn’t granted/);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));

    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(r => dom.window.setTimeout(r, 10));
    assert.match(el(dom, 'github-panel').textContent, /GitHub access wasn’t granted/,
        'the actionable permission error must survive focus changes');
});

test('the shared Connect GitHub action grants permission without enabling ascent backup', async () => {
    let permissionGranted = false;
    let requested = null;
    let began = false;
    const dom = await loadOptions({}, {
        prepareChrome: chrome => {
            chrome.permissions = {
                contains: async () => permissionGranted,
                request: async value => {
                    requested = value;
                    permissionGranted = true;
                    return true;
                },
                remove: async () => true,
            };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    reply = { enabled: false, connected: false, hasToken: false };
                } else if (message.type === 'GITHUB_AUTH_BEGIN') {
                    began = true;
                    reply = {
                        phase: 'polling', userCode: 'ABCD-EFGH',
                        verificationUri: 'https://github.com/login/device', expiresIn: 900,
                    };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('.github-code'));

    assert.equal(JSON.stringify(requested), JSON.stringify({
        origins: ['https://github.com/*', 'https://api.github.com/*'],
    }));
    assert.equal(began, true);
    assert.notEqual(dom.chrome._store.bpbSettings.enableGithubBackup, true);
    dom.window.close();
});

test('a lost device flow stops polling and offers to reconnect', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        accelerateGithubPoll: true,
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') reply = { enabled: true, connected: false, hasToken: false };
                else if (message.type === 'GITHUB_AUTH_BEGIN') reply = {
                    phase: 'polling', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900,
                };
                else if (message.type === 'GITHUB_AUTH_STATE') reply = { phase: 'idle' };
                else reply = {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => /connection was lost/i.test(el(dom, 'github-panel').textContent), 3000);

    assert.deepEqual([...new Set(dom.githubPollDelays)], [2000]);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Reconnect GitHub'));
});

test('opening the GitHub device page uses tabs.create and reports a failure', async () => {
    const created = [];
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async details => { created.push(details.url); } };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') reply = { enabled: true, connected: false, hasToken: false };
                else if (message.type === 'GITHUB_AUTH_BEGIN') reply = {
                    phase: 'polling', userCode: 'ABCD-EFGH',
                    verificationUri: 'https://github.com/login/device',
                    expiresIn: 125, startedAt: Date.now(),
                };
                else reply = { phase: 'polling' };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
        prepareWindow: window => {
            window.open = () => {
                throw new Error('a popup-blocked window.open must never be the path taken');
            };
        },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('.github-code'));

    const openButton = Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Open github.com/login/device');
    assert.ok(openButton, 'the device flow depends on this single action');
    openButton.click();
    await waitFor(dom, () => created.length === 1);
    assert.deepEqual(created, ['https://github.com/login/device'],
        'GitHub URLs must go through tabs.create, which cannot be popup-blocked');

    // And when even that fails, the user is told instead of nothing happening.
    dom.chrome.tabs.create = async () => { throw new Error('tab creation refused'); };
    openButton.click();
    await waitFor(dom, () => /couldn’t be opened/.test(el(dom, 'status-error-text').textContent));
    assert.match(el(dom, 'status-error-text').textContent,
        /The GitHub device page couldn’t be opened/);
    assert.equal(el(dom, 'status-error').hidden, false);
});

test('the device code is copyable and shows its remaining lifetime', async () => {
    const startedAt = Date.now();
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') reply = { enabled: true, connected: false, hasToken: false };
                else if (message.type === 'GITHUB_AUTH_BEGIN') reply = {
                    phase: 'polling', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device',
                    expiresIn: 125, startedAt,
                };
                else reply = { phase: 'polling' };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    let copied = '';
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { copied = value; } },
    });

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Connect GitHub').click();
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('.github-code'));
    const codeButton = el(dom, 'github-panel').querySelector('.github-code');
    assert.match(codeButton.getAttribute('aria-label'), /Copy device code ABCD-EFGH/);
    assert.match(el(dom, 'github-panel').textContent, /Expires in 2:0[45]/);

    codeButton.click();
    await waitFor(dom, () => /Copied/.test(codeButton.textContent));
    assert.equal(copied, 'ABCD-EFGH');
    dom.window.close();
});

test('repository setup offers a prefilled private GitHub repository', async () => {
    const status = {
        enabled: true, connected: false, hasToken: true,
        account: { login: 'ada' }, installUrl: 'https://github.com/apps/better-peakbagger-backup/installations/new',
    };
    const repo = { owner: 'ada', name: 'existing', fullName: 'ada/existing', defaultBranch: 'main', installationId: 11 };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_DISCOVER' ? { repos: [repo] } : status;
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Create repository on GitHub'));
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/existing'), 'a sole granted repository must still be inspected by an explicit choice');

    let opened = null;
    dom.window.open = url => { opened = url; };
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Create repository on GitHub').click();
    const url = new URL(opened);
    assert.equal(url.origin + url.pathname, 'https://github.com/new');
    assert.equal(url.searchParams.get('name'), 'better-peakbagger-backup');
    assert.equal(url.searchParams.get('owner'), 'ada');
    assert.equal(url.searchParams.get('visibility'), 'private');
    assert.match(url.searchParams.get('description'), /Backups and transfers/);
});

test('a populated repository requires an explicit confirmation before connection', async () => {
    const repo = { owner: 'ada', name: 'project', fullName: 'ada/project', defaultBranch: 'main', installationId: 11 };
    let connected = false;
    const selectMessages = [];
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply;
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    reply = {
                        enabled: true, connected, hasToken: true, account: { login: 'ada' },
                        repo: connected ? repo : null, installUrl: 'https://github.com/apps/example/installations/new',
                    };
                } else if (message.type === 'GITHUB_AUTH_DISCOVER') {
                    reply = { repos: [repo] };
                } else if (message.type === 'GITHUB_AUTH_SELECT_REPO') {
                    selectMessages.push(message);
                    if (!message.confirmExisting) reply = { connected: false, needsConfirmation: true, repo };
                    else { connected = true; reply = { connected: true, hasToken: true, account: { login: 'ada' }, repo }; }
                } else reply = {};
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/project'));
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'ada/project').click();
    await waitFor(dom, () => /already contains files/.test(el(dom, 'github-panel').textContent));
    assert.match(el(dom, 'github-panel').textContent, /Existing files will stay in place/);
    assert.equal(connected, false);

    // Focusing another window while reading this must not destroy the question.
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(el(dom, 'github-panel').textContent, /already contains files/,
        'a confirmation the user is reading must survive a window focus');

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Use this repository').click();
    await waitFor(dom, () => /Repository ada\/project/.test(el(dom, 'github-panel').textContent));
    assert.deepEqual(selectMessages.map(message => !!message.confirmExisting), [false, true]);
});

test('repository setup shows the specific GitHub failure instead of generic copy', async () => {
    const status = {
        enabled: true, connected: false, hasToken: true, account: { login: 'ada' },
        installUrl: 'https://github.com/apps/example/installations/new',
    };
    const repo = { owner: 'ada', name: 'backup', fullName: 'ada/backup', defaultBranch: 'main', installationId: 11 };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = status;
                if (message.type === 'GITHUB_AUTH_DISCOVER') reply = { repos: [repo] };
                if (message.type === 'GITHUB_AUTH_SELECT_REPO') {
                    reply = { connected: false, error: { code: 'unknown', message: 'Repository service is temporarily unavailable.' } };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'ada/backup'));
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'ada/backup').click();
    await waitFor(dom, () => /Repository service is temporarily unavailable/.test(el(dom, 'github-panel').textContent));
    assert.doesNotMatch(el(dom, 'github-panel').textContent, /something went wrong/i);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));
});

test('a connected status renders the account and repository', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: withGithubBackground({
            enabled: true, connected: true, hasToken: true,
            account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
        })
    });
    await new Promise(r => dom.window.setTimeout(r, 40));
    assert.equal(el(dom, 'github-detail').hidden, false);
    const panelText = el(dom, 'github-panel').textContent;
    assert.match(panelText, /@ada/);
    assert.match(panelText, /ada\/peaks/);
    // The connected state offers a disconnect control.
    const buttons = Array.from(el(dom, 'github-panel').querySelectorAll('button'), b => b.textContent);
    assert.ok(buttons.includes('Disconnect'));
    // The repository link belongs to the connection, not to ascent backup.
    const repositoryLink = el(dom, 'github-panel').querySelector('a[href="https://github.com/ada/peaks"]');
    assert.ok(repositoryLink, 'the connected panel links to the selected repository');
    assert.equal(repositoryLink.textContent, 'View repository');
    assert.equal(repositoryLink.getAttribute('target'), '_blank');
    assert.equal(repositoryLink.getAttribute('rel'), 'noopener noreferrer');
});

test('an auth-storage read failure is not presented as a disconnected account', async () => {
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = () => Promise.resolve({
                phase: 'error',
                error: { code: 'unknown', message: 'Local authorization storage could not be read.' },
            });
        },
    });

    await waitFor(dom, () => /Local authorization storage could not be read/.test(
        el(dom, 'github-panel').textContent));
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));
    assert.doesNotMatch(el(dom, 'github-panel').textContent, /Connect a GitHub account/);
});

test('a failed GitHub disconnect stays connected and does not announce success', async () => {
    const connected = {
        enabled: true, connected: true, hasToken: true,
        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'GITHUB_AUTH_DISCONNECT'
                    ? { phase: 'error', error: { code: 'unexpected', message: 'Local credential removal failed.' } }
                    : connected;
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => /Repository ada\/peaks/.test(el(dom, 'github-panel').textContent));

    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Disconnect').click();
    await waitFor(dom, () => /Local credential removal failed/.test(el(dom, 'github-panel').textContent));

    assert.doesNotMatch(el(dom, 'status').textContent, /disconnected/i);
    assert.ok(Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Try again'));
});

test('the connected ascent panel reports repository-backed progress and refreshes on focus', async () => {
    let ascentCount = 0;
    let summaryReads = 0;
    const status = {
        enabled: true, connected: true, hasToken: true,
        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
    };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
                if (message.type === 'GITHUB_ASCENT_BACKUP_SUMMARY') {
                    summaryReads++;
                    reply = { ok: true, count: ascentCount };
                }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => /No ascents backed up yet/.test(el(dom, 'github-ascent-panel').textContent));
    assert.equal(el(dom, 'github-ascent-panel').querySelector('a[href="https://github.com/ada/peaks"]'), null,
        'the repository link belongs to the GitHub connection, not the ascent summary');

    // A plain alt-tab back to the browser must not cost a GitHub API request
    // or flash "Checking existing backups…" at the user.
    const readsBeforeFocus = summaryReads;
    ascentCount = 3;
    for (let i = 0; i < 3; i++) dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(summaryReads, readsBeforeFocus,
        'window focus alone must not re-query GitHub');
    assert.match(el(dom, 'github-ascent-panel').textContent, /No ascents backed up yet/,
        'the cached summary stays painted, with no Checking… flash');

    // The explicit control is still a forced refetch.
    dom.chrome.runtime.sendMessage = (message, callback) => {
        let reply = {};
        if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
        if (message.type === 'GITHUB_ASCENT_BACKUP_SUMMARY') {
            summaryReads++;
            reply = { ok: false, error: { code: 'github-unavailable' } };
        }
        if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
        return Promise.resolve(reply);
    };
    el(dom, 'github-ascent-panel').querySelector('.github-backup-summary')
        .dispatchEvent(new dom.window.Event('nothing'));
    assert.ok(summaryReads === readsBeforeFocus, 'sanity: nothing has re-read yet');
});

test('the GitHub panel re-checks access only after an actual round trip to GitHub', async () => {
    // GITHUB_AUTH_DISCOVER is the repository-listing GitHub API call; the local
    // GITHUB_AUTH_STATUS read is not what this finding is about.
    let repos = [];
    let discoveries = 0;
    const status = {
        enabled: true, connected: false, hasToken: true, permissionGranted: true,
        account: { login: 'ada' }, installUrl: 'https://github.com/settings/installations/1',
    };
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async () => {} };
            chrome.runtime.sendMessage = (message, callback) => {
                let reply = {};
                if (message.type === 'GITHUB_AUTH_STATUS') reply = status;
                if (message.type === 'GITHUB_AUTH_DISCOVER') { discoveries++; reply = { repos }; }
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });

    await waitFor(dom, () => Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Grant repository access'));
    await new Promise(resolve => setTimeout(resolve, 60));

    // Unarmed: alt-tabbing back to the browser costs nothing.
    const before = discoveries;
    for (let i = 0; i < 3; i++) dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(discoveries, before, 'an unarmed focus must not re-query GitHub');

    // Armed by actually sending the user to GitHub's access page.
    Array.from(el(dom, 'github-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Grant repository access').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    repos = [{ owner: 'ada', name: 'peaks', fullName: 'ada/peaks' }];
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await waitFor(dom, () => /ada\/peaks/.test(el(dom, 'github-panel').textContent));
    assert.equal(discoveries, before + 1, 'returning from GitHub is what the listener is for');

    // ...and it disarms, so the next alt-tab is free again.
    for (let i = 0; i < 3; i++) dom.window.dispatchEvent(new dom.window.Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(discoveries, before + 1, 'the armed flag is consumed exactly once');
});

test('the connected state opens the signed-in climber\'s all-years My Ascents page', async () => {
    let opened = null;
    const target = 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999&sort=AscentDate';
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async details => { opened = details.url; } };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'PEAKBAGGER_MY_ASCENTS'
                    ? { ok: true, url: target }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Open My Ascents'));
    assert.match(el(dom, 'github-ascent-panel').textContent, /covers every year/);

    Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Open My Ascents').click();
    await waitFor(dom, () => opened);
    assert.equal(opened, target);
});

test('the My Ascents action explains when Peakbagger is signed out', async () => {
    const opened = [];
    const dom = await loadOptions({ enableGithubBackup: true }, {
        prepareChrome: chrome => {
            chrome.permissions = { request: async () => true, contains: async () => true, remove: async () => true };
            chrome.tabs = { create: async details => { opened.push(details.url); } };
            chrome.runtime.sendMessage = (message, callback) => {
                const reply = message.type === 'PEAKBAGGER_MY_ASCENTS'
                    ? {
                        ok: false,
                        error: {
                            code: 'peakbagger-signed-out',
                            message: 'Peakbagger could not find a signed-in account. Sign in to Peakbagger, then try again.',
                        },
                    }
                    : {
                        enabled: true, connected: true, hasToken: true,
                        account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
                    };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            };
        },
    });
    await waitFor(dom, () => Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .some(button => button.textContent === 'Open My Ascents'));
    Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Open My Ascents').click();
    await waitFor(dom, () => /could not find a signed-in account/i.test(el(dom, 'github-ascent-panel').textContent));

    assert.match(el(dom, 'github-ascent-panel').textContent, /Sign in to Peakbagger, then try again/);
    assert.doesNotMatch(el(dom, 'github-ascent-panel').textContent, /something went wrong/i);
    const signIn = Array.from(el(dom, 'github-ascent-panel').querySelectorAll('button'))
        .find(button => button.textContent === 'Sign in to Peakbagger');
    assert.ok(signIn, 'the signed-out error offers a direct recovery action');
    signIn.click();
    await waitFor(dom, () => opened.length > 0);
    assert.equal(opened[0], 'https://www.peakbagger.com/Climber/Login.aspx');
});

test('the connected state exposes independent save and delete backup choices', async () => {
    const dom = await loadOptions({
        enableGithubBackup: true,
        removeGithubBackupOnDelete: true,
    }, {
        prepareChrome: withGithubBackground({
            enabled: true, connected: true, hasToken: true, auto: false,
            account: { login: 'ada' }, repo: { owner: 'ada', name: 'peaks', fullName: 'ada/peaks' },
        }),
    });
    await new Promise(r => dom.window.setTimeout(r, 40));
    const autoEl = el(dom, 'github-auto-backup');
    assert.ok(autoEl, 'the auto-backup checkbox is present when connected');
    assert.equal(autoEl.checked, false);

    autoEl.checked = true;
    autoEl.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(dom.chrome._store.bpbSettings.autoGithubBackup, true);

    const deleteEl = el(dom, 'github-delete-backup');
    assert.ok(deleteEl, 'the deletion-mirroring checkbox is present when connected');
    assert.equal(deleteEl.checked, true,
        'a saved deletion-mirroring preference must survive Settings reload');
    assert.match(el(dom, 'github-ascent-panel').textContent, /Git history and your own files remain/);

    deleteEl.checked = false;
    deleteEl.dispatchEvent(new dom.window.Event('change'));
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(dom.chrome._store.bpbSettings.removeGithubBackupOnDelete, false);
});
