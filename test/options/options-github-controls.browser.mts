// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://options.better-peakbagger.test
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as nextTask } from 'node:timers/promises';
import { loadOptions, el, waitFor, registerCleanup, type OptionsPage } from '../helpers/options-page.mts';
import { harness, syncState } from '../helpers/ignored-sync-harness.mts';
import type { PageChrome } from '../helpers/chrome-stub.mts';
import type { StubMessage } from '../helpers/page-types.mts';
import { createClimberListSync } from '../../src/background/climber-list-sync.ts';

registerCleanup();

const syncControls = [
    ['favorites-auto-backup', 'autoFavoritesBackup'],
    ['settings-backup-auto', 'autoSettingsBackup'],
    ['photos-auto-backup', 'autoPhotoLibraryBackup'],
    ['github-delete-backup', 'removeGithubBackupOnDelete'],
];

type Listener = (details: { origins: string[] }) => void;
type Reply = (reply: unknown) => void;
// The device settings the page writes, read back by key.
const deviceSetting = (dom: OptionsPage, key: string) =>
    (dom.chrome._localStore.bpbDeviceSettings?.settings as Record<string, unknown> | undefined)?.[key];
const controlPage = async ({ connected = false, granted = false, settings = {}, local }:
    { connected?: boolean; granted?: boolean; settings?: Record<string, unknown>; local?: Record<string, unknown> } = {}) => {
    const h = Object.assign(harness({ syncEnabled: true }), {
        connected, granted, authReads: 0,
        permissionListeners: { added: new Set<Listener>(), removed: new Set<Listener>() },
        authReply: null as (() => unknown) | null,
        photosReply: null as (() => unknown) | null,
        dom: undefined as unknown as OptionsPage,
    });
    h.engine = createClimberListSync({ ...h.engineOptions,
        getAccess: async () => h.connected && h.granted ? h.engineOptions.getAccess()
            : { error: { code: 'not-connected' } },
    });
    h.dom = await loadOptions({ autoFavoritesBackup: true, autoSettingsBackup: true, autoPhotoLibraryBackup: true, ...settings }, { local: local || h.values, prepareChrome: (chrome: PageChrome) => {
        h.storage.get = chrome.storage.local.get; h.storage.set = chrome.storage.local.set;
        chrome.permissions = { contains: async () => h.granted,
            onAdded: { addListener: (listener: Listener) => h.permissionListeners.added.add(listener) },
            onRemoved: { addListener: (listener: Listener) => h.permissionListeners.removed.add(listener) },
        };
        chrome.runtime.sendMessage = async (message: StubMessage) => {
            if (message.type === 'GITHUB_AUTH_STATUS') h.authReads++;
            if (message.type === 'GITHUB_AUTH_STATUS' && h.authReply) return h.authReply();
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: h.connected, hasToken: h.connected,
                account: { login: 'me' }, repo: h.connected ? { owner: 'me', name: 'backup' } : null };
            if (message.type === 'GITHUB_IGNORED_LIST') return message.action === 'status'
                ? h.engine.status() : h.engine.action(message);
            if (message.type === 'GITHUB_PHOTOS_STATUS' && h.photosReply) return h.photosReply();
            if (message.type === 'GITHUB_PHOTOS_STATUS') return { ok: true,
                auto: (chrome._localStore.bpbDeviceSettings?.settings as { autoPhotoLibraryBackup?: boolean } | undefined)?.autoPhotoLibraryBackup === true, state: null };
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
            assert.equal(toggle.checked, true, `${id} preserves the configured preference`);
            assert.equal(toggle.disabled, true, `${id} needs both connection and permission`);
            toggle.click();
            assert.equal(toggle.checked, true, `${id} cannot silently opt out before setup`);
        }
        assert.equal(el(h.dom, 'settings-backup-github-actions').hidden, true);
        assert.equal(el(h.dom, 'photos-github-actions').hidden, true);
        for (const id of ['settings-backup-auto', 'photos-auto-backup']) {
            assert.equal(el(h.dom, id).closest('.backup-automatic')!.hidden, true,
                `${id} stays hidden with its disconnected backup actions`);
        }
        assert.equal(el(h.dom, 'github-auto-backup'), null);
        assert.equal(el(h.dom, 'github-delete-backup'), null);
        assert.equal(el(h.dom, 'settings-backup-auto').checked, true);
        assert.equal(el(h.dom, 'photos-auto-backup').checked, true);
        assert.equal(h.reads, 0); assert.equal(h.writes, 0);
        assert.equal(syncState(await h.engine.status()).enabled, true);
    }
});

test('unrelated host permission changes do not refresh GitHub setup', async () => {
    const h = await controlPage({ connected: true, granted: true, settings: { enableGithubBackup: true } });
    await waitFor(h.dom, () => accessSettled(h, true));
    const reads = h.authReads;
    for (const listeners of Object.values(h.permissionListeners)) {
        for (const listener of listeners) listener({ origins: ['https://api.imgbb.com/*'] });
    }
    await nextTask(0);
    assert.equal(h.authReads, reads);
    assert.equal(accessSettled(h, true), true);
});

type ControlPage = Awaited<ReturnType<typeof controlPage>>;
const accessSettled = (h: ControlPage, connected: boolean) => ['favorites-auto-backup', 'ignored-sync-enable']
    .every(id => el(h.dom, id).disabled === !connected)
    && el(h.dom, 'settings-backup-github-actions').hidden === !connected
    && el(h.dom, 'photos-github-actions').hidden === !connected
    && ['settings-backup-auto', 'photos-auto-backup']
        .every(id => el(h.dom, id).closest('.backup-automatic')!.hidden === !connected)
    && !!el(h.dom, 'github-delete-backup') === connected
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
    const added = new Set<Listener>(), removed = new Set<Listener>();
    const dom = await loadOptions({}, { prepareChrome: (chrome: PageChrome) => {
        chrome.permissions = {
            contains: async () => granted,
            onAdded: { addListener: (listener: Listener) => added.add(listener) },
            onRemoved: { addListener: (listener: Listener) => removed.add(listener) },
            request: async () => {
                granted = true;
                for (const listener of added) listener({ origins: ['https://github.com/*'] });
                return true;
            },
        };
        chrome.runtime.sendMessage = async (message: StubMessage) => {
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
    await waitFor(dom, () => /access wasn’t granted/.test(el(dom, 'github-panel').textContent));
    assert.equal(el(dom, 'github-disconnect').hidden, false);
    assert.equal(el(dom, 'github-panel').querySelector('.github-code'), null);
});

test('older connection replies cannot repaint any section after a newer access refresh', async () => {
    const h = await controlPage({ connected: true, granted: true, settings: { enableGithubBackup: true } });
    await waitFor(h.dom, () => accessSettled(h, true));
    const pending: Reply[] = [];
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
        settings: { enableGithubBackup: true, autoFavoritesBackup: false,
            autoSettingsBackup: false, autoPhotoLibraryBackup: false } });
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
    assert.equal(syncState(await h.engine.status()).enabled, false);
    assert.equal(h.reads, reads); assert.equal(h.writes, writes);
});

test('delayed connected replies cannot reopen backup controls after a newer disconnection', async () => {
    const h = await controlPage({ connected: true, granted: true });
    const pending: Reply[] = [];
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
    const h = await controlPage({ connected: true, granted: true,
        settings: { autoPhotoLibraryBackup: false } });
    let resolve: Reply | undefined;
    h.photosReply = () => new Promise(done => { resolve = done; });
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'));
    await waitFor(h.dom, () => !!resolve);
    el(h.dom, 'photos-auto-backup').click();
    await waitFor(h.dom, () => deviceSetting(h.dom, 'autoPhotoLibraryBackup') === true
        && el(h.dom, 'photos-auto-backup').checked);
    resolve!({ ok: true, auto: false, state: null });
    await nextTask(0);
    assert.equal(el(h.dom, 'photos-auto-backup').checked, true);
    assert.equal(deviceSetting(h.dom, 'autoPhotoLibraryBackup'), true);
});

test('connected optional GitHub choices toggle both ways and preserve opt-outs on reload', async () => {
    const h = await controlPage({ connected: true, granted: true, settings: { enableGithubBackup: true } });
    assert.equal(el(h.dom, 'favorites-auto-backup').checked, true);
    assert.equal(el(h.dom, 'ignored-sync-enable').checked, true);
    for (const [id, key] of syncControls) {
        const initial = key !== 'removeGithubBackupOnDelete';
        assert.equal(el(h.dom, id).checked, initial, `${id} has the intended default`);
        for (const next of [!initial, initial, false]) {
            if (el(h.dom, id).checked !== next) el(h.dom, id).click();
            await waitFor(h.dom, () => deviceSetting(h.dom, key) === next
                && el(h.dom, id)?.checked === next);
        }
    }
    for (const next of [false, true, false]) {
        el(h.dom, 'ignored-sync-enable').click();
        await waitFor(h.dom, () => !el(h.dom, 'ignored-github').hasAttribute('aria-busy')
            && el(h.dom, 'ignored-sync-enable').checked === next);
        assert.equal(syncState(await h.engine.status()).enabled, next);
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
    h.dom.chrome.storage.local.set = async () => { throw new Error('storage write failed'); };
    for (const [id] of [...syncControls, ['enable-github-backup']]) {
        el(h.dom, id).click();
        await waitFor(h.dom, () => el(h.dom, id)?.checked === true
            && !el(h.dom, 'status-error').hidden
            && /Settings couldn’t be saved/.test(el(h.dom, 'status-error-text').textContent));
        assert.equal(JSON.stringify(h.dom.chrome._store.bpbSettings), preferences, id);
    }
    await nextTask(0);
});
