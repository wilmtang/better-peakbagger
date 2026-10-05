// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as nextTask } from 'node:timers/promises';
import { loadOptions, el, waitFor, registerCleanup } from '../helpers/options-helpers.mjs';
import { harness } from '../helpers/ignored-sync-harness.mjs';
import { createClimberListSync } from '../../src/background/climber-list-sync.js';

registerCleanup();

const syncControls = [
    ['favorites-auto-backup', 'autoFavoritesBackup'],
    ['settings-backup-auto', 'autoSettingsBackup'],
    ['photos-auto-backup', 'autoPhotoLibraryBackup'],
    ['github-auto-backup', 'autoGithubBackup'],
    ['github-delete-backup', 'removeGithubBackupOnDelete'],
];

const controlPage = async ({ connected = false, granted = false, settings = {}, local } = {}) => {
    const h = harness({ syncEnabled: null });
    h.connected = connected; h.granted = granted;
    h.permissionListeners = { added: new Set(), removed: new Set() };
    h.engine = createClimberListSync({ ...h.engineOptions,
        getAccess: async () => h.connected && h.granted ? h.engineOptions.getAccess()
            : { error: { code: 'not-connected' } },
    });
    h.dom = await loadOptions(settings, { local: local || h.values, prepareChrome: chrome => {
        h.storage.get = chrome.storage.local.get; h.storage.set = chrome.storage.local.set;
        chrome.permissions = { contains: async () => h.granted,
            onAdded: { addListener: listener => h.permissionListeners.added.add(listener) },
            onRemoved: { addListener: listener => h.permissionListeners.removed.add(listener) },
        };
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS' && h.authReply) return h.authReply();
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: h.connected, hasToken: h.connected,
                account: { login: 'me' }, repo: h.connected ? { owner: 'me', name: 'backup' } : null };
            if (message.type === 'GITHUB_IGNORED_LIST') return message.action === 'status'
                ? h.engine.status() : h.engine.action(message);
            if (message.type === 'GITHUB_PHOTOS_STATUS' && h.photosReply) return h.photosReply();
            if (message.type === 'GITHUB_PHOTOS_STATUS') return { ok: true,
                auto: chrome._store.bpbSettings.autoPhotoLibraryBackup === true, state: null };
            if (message.type === 'GITHUB_ASCENT_BACKUP_SUMMARY') return { ok: true, count: 0 };
            return { ok: true };
        };
    } });
    await waitFor(h.dom, () => /Connect GitHub|Backs up to/.test(el(h.dom, 'favorites-github-status').textContent)
        && !/Checking/.test(el(h.dom, 'ignored-github-status').textContent));
    return h;
};

test('disconnected and permission-denied GitHub controls retain preferences without allowing changes', async () => {
    for (const connected of [false, true]) {
        const h = await controlPage({ connected, settings: { enableGithubBackup: true,
            autoSettingsBackup: true, autoPhotoLibraryBackup: true, autoGithubBackup: true,
            removeGithubBackupOnDelete: true } });
        for (const id of ['favorites-auto-backup', 'ignored-sync-enable']) {
            const toggle = el(h.dom, id);
            assert.equal(toggle.checked, true, `${id} preserves the default-on preference`);
            assert.equal(toggle.disabled, true, `${id} needs both connection and permission`);
            toggle.click();
            assert.equal(toggle.checked, true, `${id} cannot silently opt out before setup`);
        }
        assert.equal(el(h.dom, 'settings-backup-github-actions').hidden, true);
        assert.equal(el(h.dom, 'photos-github-actions').hidden, true);
        assert.equal(el(h.dom, 'github-auto-backup'), null);
        assert.equal(el(h.dom, 'github-delete-backup'), null);
        assert.equal(el(h.dom, 'settings-backup-auto').checked, true);
        assert.equal(el(h.dom, 'photos-auto-backup').checked, true);
        assert.equal(h.reads, 0); assert.equal(h.writes, 0);
        assert.equal((await h.engine.status()).state.enabled, true);
    }
});

const accessSettled = (h, connected) => ['favorites-auto-backup', 'ignored-sync-enable']
    .every(id => el(h.dom, id).disabled === !connected)
    && el(h.dom, 'settings-backup-github-actions').hidden === !connected
    && el(h.dom, 'photos-github-actions').hidden === !connected
    && !!el(h.dom, 'github-auto-backup') === connected
    && /Connected as/.test(el(h.dom, 'github-panel').textContent) === connected;

test('host access revocation and regrant refresh every optional GitHub control without changing preferences', async () => {
    const h = await controlPage({ connected: true, granted: true, settings: { enableGithubBackup: true,
        autoSettingsBackup: true, autoPhotoLibraryBackup: true, autoGithubBackup: true,
        removeGithubBackupOnDelete: true } });
    await waitFor(h.dom, () => accessSettled(h, true));
    const reads = h.reads, writes = h.writes;
    const preferences = JSON.stringify(h.dom.chrome._store.bpbSettings);
    h.granted = false;
    for (const listener of h.permissionListeners.removed) listener({ origins: ['https://api.github.com/*'] });
    await waitFor(h.dom, () => accessSettled(h, false));
    assert.equal(el(h.dom, 'favorites-auto-backup').checked, true);
    assert.equal(el(h.dom, 'ignored-sync-enable').checked, true);
    h.granted = true;
    for (const listener of h.permissionListeners.added) listener({ origins: ['https://api.github.com/*'] });
    await waitFor(h.dom, () => accessSettled(h, true));
    for (const [id, key] of syncControls) assert.equal(el(h.dom, id).checked, true, key);
    assert.equal(JSON.stringify(h.dom.chrome._store.bpbSettings), preferences);
    assert.equal(h.reads, reads); assert.equal(h.writes, writes);
});

test('access notifications during device setup preserve the code until host access is revoked', async () => {
    let granted = false, hasToken = false;
    const added = new Set(), removed = new Set();
    const dom = await loadOptions({}, { prepareChrome: chrome => {
        chrome.permissions = {
            contains: async () => granted,
            onAdded: { addListener: listener => added.add(listener) },
            onRemoved: { addListener: listener => removed.add(listener) },
            request: async () => {
                granted = true;
                for (const listener of added) listener({ origins: ['https://github.com/*'] });
                return true;
            },
        };
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: false, hasToken };
            if (message.type === 'GITHUB_AUTH_BEGIN') {
                await chrome.storage.local.set({ bpbGithubAuth: null });
                return { phase: 'polling', userCode: 'ABCD-EFGH', expiresIn: 900 };
            }
            if (message.type === 'GITHUB_AUTH_STATE') return { phase: 'polling' };
            if (message.type === 'GITHUB_IGNORED_LIST') return { ok: true, count: 0,
                state: { enabled: true, phase: 'idle' } };
            return { ok: true };
        };
    } });
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('button'));
    el(dom, 'github-panel').querySelector('button').click();
    await waitFor(dom, () => el(dom, 'github-panel').querySelector('.github-code'));
    hasToken = true;
    await dom.chrome.storage.local.set({ bpbGithubAuth: { account: { login: 'me' } } });
    await nextTask(0);
    assert.equal(el(dom, 'github-panel').querySelector('.github-code')?.textContent, 'ABCD-EFGHCopy');
    granted = false;
    for (const listener of removed) listener({ origins: ['https://github.com/*'] });
    await waitFor(dom, () => /Connect GitHub/.test(el(dom, 'github-panel').textContent));
    assert.equal(el(dom, 'github-panel').querySelector('.github-code'), null);
});

test('older connection replies cannot repaint any section after a newer access refresh', async () => {
    const h = await controlPage({ connected: true, granted: true, settings: { enableGithubBackup: true } });
    await waitFor(h.dom, () => accessSettled(h, true));
    const pending = [];
    h.authReply = () => new Promise(resolve => pending.push(resolve));
    await h.dom.chrome.storage.local.set({ bpbGithubAuth: { repo: { owner: 'me', name: 'backup' } } });
    await waitFor(h.dom, () => pending.length === 5);
    h.authReply = null; h.connected = false;
    await h.dom.chrome.storage.local.set({ bpbGithubAuth: null });
    await waitFor(h.dom, () => accessSettled(h, false));
    for (const resolve of pending) resolve({ connected: true, hasToken: true,
        repo: { owner: 'me', name: 'backup' } });
    await nextTask(0);
    assert.equal(accessSettled(h, false), true);
});

test('connection changes from another settings tab preserve climber opt-outs through reconnect', async () => {
    const h = await controlPage({ connected: true, granted: true,
        settings: { enableGithubBackup: true, autoFavoritesBackup: false } });
    el(h.dom, 'ignored-sync-enable').click();
    await waitFor(h.dom, () => !el(h.dom, 'ignored-sync-enable').checked
        && !el(h.dom, 'ignored-github').hasAttribute('aria-busy'));
    const reads = h.reads, writes = h.writes;
    h.connected = false;
    await h.dom.chrome.storage.local.set({ bpbGithubAuth: null });
    await waitFor(h.dom, () => accessSettled(h, false));
    h.connected = true;
    await h.dom.chrome.storage.local.set({ bpbGithubAuth: { repo: { owner: 'me', name: 'backup' } } });
    await waitFor(h.dom, () => accessSettled(h, true));
    for (const [id] of syncControls) assert.equal(el(h.dom, id).checked, false, id);
    assert.equal(el(h.dom, 'ignored-sync-enable').checked, false);
    assert.equal((await h.engine.status()).state.enabled, false);
    assert.equal(h.reads, reads); assert.equal(h.writes, writes);
});

test('delayed connected replies cannot reopen backup controls after a newer disconnection', async () => {
    const h = await controlPage({ connected: true, granted: true });
    const pending = [];
    h.authReply = () => new Promise(resolve => pending.push(resolve));
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'));
    await waitFor(h.dom, () => pending.length === 2);
    h.authReply = null; h.connected = false;
    await h.dom.chrome.storage.local.set({ bpbGithubAuth: null });
    await waitFor(h.dom, () => el(h.dom, 'settings-backup-github-actions').hidden
        && el(h.dom, 'photos-github-actions').hidden && el(h.dom, 'favorites-auto-backup').disabled);
    for (const resolve of pending) resolve({ connected: true, hasToken: true,
        repo: { owner: 'me', name: 'backup' } });
    await nextTask(0);
    assert.equal(el(h.dom, 'settings-backup-github-actions').hidden, true);
    assert.equal(el(h.dom, 'photos-github-actions').hidden, true);
    assert.equal(el(h.dom, 'favorites-auto-backup').disabled, true);
});

test('a photo status snapshot cannot overwrite a newer automatic backup preference', async () => {
    const h = await controlPage({ connected: true, granted: true });
    let resolve;
    h.photosReply = () => new Promise(done => { resolve = done; });
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'));
    await waitFor(h.dom, () => !!resolve);
    el(h.dom, 'photos-auto-backup').click();
    await waitFor(h.dom, () => h.dom.chrome._store.bpbSettings.autoPhotoLibraryBackup === true
        && el(h.dom, 'photos-auto-backup').checked);
    resolve({ ok: true, auto: false, state: null });
    await nextTask(0);
    assert.equal(el(h.dom, 'photos-auto-backup').checked, true);
    assert.equal(h.dom.chrome._store.bpbSettings.autoPhotoLibraryBackup, true);
});

test('connected optional GitHub choices toggle both ways and preserve opt-outs on reload', async () => {
    const h = await controlPage({ connected: true, granted: true, settings: { enableGithubBackup: true } });
    assert.equal(el(h.dom, 'favorites-auto-backup').checked, true);
    assert.equal(el(h.dom, 'ignored-sync-enable').checked, true);
    for (const [id, key] of syncControls) {
        const initial = key === 'autoFavoritesBackup';
        assert.equal(el(h.dom, id).checked, initial, `${id} has the intended default`);
        for (const next of [!initial, initial, false]) {
            if (el(h.dom, id).checked !== next) el(h.dom, id).click();
            await waitFor(h.dom, () => h.dom.chrome._store.bpbSettings[key] === next
                && el(h.dom, id)?.checked === next);
        }
    }
    for (const next of [false, true, false]) {
        el(h.dom, 'ignored-sync-enable').click();
        await waitFor(h.dom, () => !el(h.dom, 'ignored-github').hasAttribute('aria-busy')
            && el(h.dom, 'ignored-sync-enable').checked === next);
        assert.equal((await h.engine.status()).state.enabled, next);
    }
    const reload = await controlPage({ connected: true, granted: true,
        settings: h.dom.chrome._store.bpbSettings, local: h.dom.chrome._localStore });
    for (const [id] of syncControls) assert.equal(el(reload.dom, id).checked, false, `${id} retains its opt-out`);
    assert.equal(el(reload.dom, 'ignored-sync-enable').checked, false);
});

test('failed writes restore every optional GitHub setting and report the error', async () => {
    const h = await controlPage({ connected: true, granted: true, settings: { enableGithubBackup: true,
        autoFavoritesBackup: true, autoSettingsBackup: true, autoPhotoLibraryBackup: true,
        autoGithubBackup: true, removeGithubBackupOnDelete: true } });
    await waitFor(h.dom, () => accessSettled(h, true));
    const preferences = JSON.stringify(h.dom.chrome._store.bpbSettings);
    h.dom.chrome.storage.sync.set = async () => { throw new Error('storage write failed'); };
    for (const [id] of [...syncControls, ['enable-github-backup']]) {
        el(h.dom, id).click();
        await waitFor(h.dom, () => el(h.dom, id)?.checked === true
            && !el(h.dom, 'status-error').hidden
            && /Settings couldn’t be saved/.test(el(h.dom, 'status-error-text').textContent));
        assert.equal(JSON.stringify(h.dom.chrome._store.bpbSettings), preferences, id);
    }
    await nextTask(0);
});
