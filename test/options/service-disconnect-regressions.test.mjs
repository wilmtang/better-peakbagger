import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGarminStore } from '../../src/garmin/garmin-store.js';
import { createGarminImports } from '../../src/garmin/garmin-imports.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';
import { loadOptions, registerCleanup } from '../helpers/options-helpers.mjs';
import { waitFor } from '../helpers/load-page.mjs';
registerCleanup();
const byId = (dom, id) => dom.window.document.getElementById(id);

test('GitHub reflects a connection restored in another settings window', async () => {
    let connected = true;
    const dom = await loadOptions({}, { prepareChrome: chrome => {
        chrome.permissions = { contains: async () => true };
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected, hasToken: connected,
                repo: { owner: 'fixture', name: 'backup' }, account: { login: 'fixture' } };
            if (message.type === 'GITHUB_AUTH_DISCONNECT') {
                connected = false; await chrome.storage.local.set({ bpbGithubAuth: null }); return { connected: false, hasToken: false };
            }
            if (message.type === 'GITHUB_IGNORED_LIST') return { ok: true, count: 0, state: { enabled: false, phase: 'idle' } };
            return { ok: true };
        };
    } });
    await waitFor(dom, () => !byId(dom, 'github-disconnect').hidden);
    byId(dom, 'github-disconnect').click();
    await waitFor(dom, () => /^Disconnected/.test(byId(dom, 'github-disconnect-status').textContent));
    byId(dom, 'github-panel').querySelector('button').focus();
    connected = true; await dom.chrome.storage.local.set({ bpbGithubAuth: { account: { login: 'fixture' } } });
    await waitFor(dom, () => /Connected as/.test(byId(dom, 'github-panel').textContent));
    assert.doesNotMatch(byId(dom, 'github-disconnect-status').textContent, /^Disconnected/);
    assert.equal(byId(dom, 'github-disconnect').hidden, false);
    assert.equal(dom.window.document.activeElement, byId(dom, 'github-disconnect'), 'A replaced Connect control hands focus to Disconnect');
});

test('GitHub credential removal in another window supersedes pending permission setup', async () => {
    let release, hasToken = true, permitted = false, begins = 0;
    const dom = await loadOptions({}, { prepareChrome: chrome => {
        chrome.permissions = { contains: async () => permitted,
            request: () => new Promise(resolve => { release = () => { permitted = true; resolve(true); }; }) };
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: false, hasToken };
            if (message.type === 'GITHUB_AUTH_BEGIN') { begins++; return { phase: 'polling', userCode: 'ABCD-EFGH', expiresIn: 900 }; }
            if (message.type === 'GITHUB_AUTH_STATE') return { phase: 'polling' };
            if (message.type === 'GITHUB_IGNORED_LIST') return { ok: true, count: 0, state: { enabled: false, phase: 'idle' } };
            return { ok: true };
        };
    } });
    await waitFor(dom, () => /Try again/.test(byId(dom, 'github-panel').textContent));
    byId(dom, 'github-panel').querySelector('button').click(); await waitFor(dom, () => !!release);
    hasToken = false; await dom.chrome.storage.local.set({ bpbGithubAuth: null });
    await waitFor(dom, () => /Connect a GitHub account/.test(byId(dom, 'github-panel').textContent));
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(begins, 0, 'An external credential removal must invalidate older setup');
    assert.equal(byId(dom, 'github-panel').querySelector('.github-code'), null);
    assert.match(byId(dom, 'github-panel').textContent, /Connect a GitHub account/);
});

for (const enabled of [true, false]) test(`Garmin polling reports an external reconnect with imports ${enabled ? 'on' : 'off'}`, async () => {
    let configured = true, failed = false, reads = 0;
    const timers = [];
    const dom = await loadOptions({ enableGarminInbox: enabled }, {
        prepareWindow: window => { window.setInterval = callback => (timers.push(callback), timers.length); },
        prepareChrome: chrome => { chrome.runtime.sendMessage = async message => {
            if (message.type === 'GARMIN_DISCONNECT') { configured = false; return { ok: true, configured: false, accessRemoved: true }; }
            if (['GARMIN_STATUS', 'GARMIN_CONNECTION_STATUS'].includes(message.type)) {
                reads++;
                if (failed) return { ok: false, error: { message: 'Status temporarily unavailable.' } };
                return { ok: true, configured, ...(message.type === 'GARMIN_STATUS' ? { enabled: configured, pending: 25, items: [] } : {}) };
            }
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: false, hasToken: false };
            return { ok: true };
        }; },
    });
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false });
    await waitFor(dom, () => !byId(dom, 'garmin-disconnect').hidden);
    byId(dom, 'garmin-disconnect').click();
    await waitFor(dom, () => byId(dom, 'garmin-disconnect').hidden);
    let before = reads; timers.forEach(callback => callback());
    await waitFor(dom, () => reads > before);
    assert.match(byId(dom, 'garmin-key-status').textContent, /^Disconnected/);
    failed = true; before = reads; timers.forEach(callback => callback());
    await waitFor(dom, () => reads > before);
    assert.match(byId(dom, 'garmin-key-status').textContent, /^Disconnected/, 'A failed status read does not undo confirmed removal');
    failed = false; configured = true; before = reads; timers.forEach(callback => callback());
    await waitFor(dom, () => reads > before && !byId(dom, 'garmin-disconnect').hidden);
    assert.equal(byId(dom, 'garmin-key-status').textContent, 'Connected on this device');
    assert.equal(byId(dom, 'garmin-key-status').classList.contains('is-error'), false);
});

test('Garmin local deletion replaces the earlier kept-drafts confirmation', async () => {
    const state = { configured: true, enabled: true, pending: 25, items: [] };
    const confirmations = [];
    const dom = await loadOptions({}, {
        prepareWindow: window => { window.confirm = message => (confirmations.push(message), true); },
        prepareChrome: chrome => { chrome.runtime.sendMessage = async message => {
            if (message.type === 'GARMIN_DISCONNECT') {
                state.configured = state.enabled = false;
                if (message.deleteData) state.pending = 0;
                return { ok: true, configured: false, accessRemoved: true };
            }
            if (message.type === 'GARMIN_STATUS') return { ok: true, ...state };
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: false, hasToken: false };
            return { ok: true };
        }; },
    });
    await waitFor(dom, () => !byId(dom, 'garmin-disconnect').hidden);
    byId(dom, 'garmin-disconnect').click();
    await waitFor(dom, () => byId(dom, 'garmin-disconnect').hidden && !byId(dom, 'garmin-disconnect').hasAttribute('aria-busy'));
    assert.match(byId(dom, 'garmin-key-status').textContent, /drafts are kept/);
    byId(dom, 'garmin-delete').click();
    await waitFor(dom, () => byId(dom, 'garmin-key-status').textContent === 'Not connected');
    assert.deepEqual(confirmations, ['Delete 25 local Garmin drafts and their import history?']);
    assert.equal(state.pending, 0);
});

for (const stage of ['permission', 'begin', 'poll']) test(`GitHub disconnect supersedes setup waiting for ${stage}`, async () => {
    let release, hasToken = true, permitted = false, begins = 0, held = true;
    const dom = await loadOptions({}, { accelerateGithubPoll: true, prepareChrome: chrome => {
        chrome.permissions = { contains: async () => permitted,
            request: async () => {
                if (stage === 'permission' && held) return new Promise(resolve => { release = () => { held = false; permitted = true; resolve(true); }; });
                permitted = true; return true;
            }, onAdded: { addListener() {} }, onRemoved: { addListener() {} } };
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: false, hasToken };
            if (message.type === 'GITHUB_AUTH_DISCONNECT') {
                hasToken = false; await chrome.storage.local.set({ bpbGithubAuth: null });
                return { connected: false, hasToken: false };
            }
            if (message.type === 'GITHUB_AUTH_BEGIN') {
                begins++;
                const reply = { phase: 'polling', userCode: 'ABCD-EFGH', expiresIn: 900 };
                if (stage === 'begin' && held) return new Promise(resolve => { release = () => { held = false; resolve(reply); }; });
                return reply;
            }
            if (message.type === 'GITHUB_AUTH_STATE') {
                if (stage === 'poll' && held) return new Promise(resolve => { release = () => { held = false; resolve({ phase: 'authorized' }); }; });
                return { phase: 'polling' };
            }
            if (message.type === 'GITHUB_IGNORED_LIST') return { ok: true, count: 0, state: { enabled: false, phase: 'idle' } };
            return { ok: true };
        };
    } });
    await waitFor(dom, () => /Try again/.test(byId(dom, 'github-panel').textContent));
    byId(dom, 'github-panel').querySelector('button').click();
    await waitFor(dom, () => !!release);
    byId(dom, 'github-disconnect').click();
    await waitFor(dom, () => /^Disconnected/.test(byId(dom, 'github-disconnect-status').textContent));
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(begins, stage === 'permission' ? 0 : 1, 'Older work must not start another sign-in after disconnect');
    assert.equal(byId(dom, 'github-panel').querySelector('.github-code'), null, 'A stale begin reply must not restore setup');
    assert.match(byId(dom, 'github-panel').textContent, /Connect a GitHub account/);
    byId(dom, 'github-panel').querySelector('button').click();
    await waitFor(dom, () => !!byId(dom, 'github-panel').querySelector('.github-code'));
    assert.equal(begins, stage === 'permission' ? 1 : 2, 'A new explicit Connect action still works');
});

test('GitHub disconnect discards a delayed repository-selection success', async () => {
    let release, connected = true;
    const repo = { owner: 'fixture', name: 'backup', fullName: 'fixture/backup' };
    const status = () => ({ connected, hasToken: connected, repo, account: { login: 'fixture' } });
    const dom = await loadOptions({}, { prepareChrome: chrome => {
        chrome.permissions = { contains: async () => true };
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS') return status();
            if (message.type === 'GITHUB_AUTH_DISCOVER') return { repos: [repo] };
            if (message.type === 'GITHUB_AUTH_SELECT_REPO') {
                const selected = status(); return new Promise(resolve => { release = () => resolve(selected); });
            }
            if (message.type === 'GITHUB_AUTH_DISCONNECT') {
                connected = false; await chrome.storage.local.set({ bpbGithubAuth: null }); return status();
            }
            if (message.type === 'GITHUB_IGNORED_LIST') return { ok: true, count: 0, state: { enabled: false, phase: 'idle' } };
            return { ok: true };
        };
    } });
    await waitFor(dom, () => /Change repository/.test(byId(dom, 'github-panel').textContent));
    [...byId(dom, 'github-panel').querySelectorAll('button')].find(button => button.textContent === 'Change repository').click();
    await waitFor(dom, () => !!byId(dom, 'github-panel').querySelector('.github-repo'));
    byId(dom, 'github-panel').querySelector('.github-repo').click(); await waitFor(dom, () => !!release);
    byId(dom, 'github-disconnect').click();
    await waitFor(dom, () => /^Disconnected/.test(byId(dom, 'github-disconnect-status').textContent));
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(byId(dom, 'status').textContent, 'GitHub disconnected', 'Stale setup must not announce repository selection');
    assert.match(byId(dom, 'github-panel').textContent, /Connect a GitHub account/);
});

test('Garmin deletion waits for a full draft count and becomes unavailable after status failure', async () => {
    const store = createGarminStore(new IDBFactory());
    await store.mutate(state => {
        state.connection = { key: 'fictional-audit-key', subject: '123', owner: '123', connectedDate: '2026-10-31' };
        for (let i = 1; i <= 25; i++) state.items[i] = { id: String(i), owner: '123', phase: 'waiting' };
    });
    let unavailable = true, statusReads = 0;
    const prefs = { ...Schema.DEFAULTS, enableGarminInbox: true };
    const ext = { runtime: { id: 'audit', getURL: file => `chrome-extension://audit/${file}` },
        permissions: { contains: async () => true, remove: async () => true }, alarms: { clear: async () => true } };
    const imports = createGarminImports({ store, ext, settings: { requireCurrent: async () => {
        if (unavailable) throw new Error('worker settings unavailable'); return prefs;
    } } });
    const sender = { id: 'audit', url: 'chrome-extension://audit/options/options.html', frameId: 0 };
    const confirmations = [], timers = [], writes = [];
    const dom = await loadOptions({ enableGarminInbox: false }, {
        prepareWindow: window => {
            window.confirm = message => { confirmations.push(message); return false; };
            window.setInterval = callback => (timers.push(callback), timers.length);
        },
        prepareChrome: chrome => { chrome.runtime.sendMessage = async message => {
            if (message.type.startsWith('GARMIN_')) {
                if (message.type === 'GARMIN_STATUS') statusReads++;
                if (message.type === 'GARMIN_DISCONNECT' && message.deleteData) writes.push(message);
                return imports.handle(message, sender);
            }
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: false, hasToken: false };
            return { ok: true };
        }; },
    });
    try {
        Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false });
        await waitFor(dom, () => !byId(dom, 'garmin-disconnect').hidden);
        await dom.chrome.storage.sync.set({ bpbSettings: { enableGarminInbox: true } });
        await waitFor(dom, () => !byId(dom, 'garmin-preferences').hidden && statusReads > 0);
        byId(dom, 'garmin-delete').closest('details').open = true;
        byId(dom, 'garmin-delete').click();
        assert.deepEqual(confirmations, [], 'Unknown draft counts must never be presented as zero');
        assert.equal(writes.length, 0);
        assert.equal(Object.keys((await store.read()).items).length, 25);
        unavailable = false;
        timers.forEach(callback => callback());
        await waitFor(dom, () => byId(dom, 'garmin-delete').getAttribute('aria-disabled') === 'false');
        byId(dom, 'garmin-delete').click();
        assert.deepEqual(confirmations, ['Delete 25 local Garmin drafts and their import history?']);
        assert.equal(writes.length, 0, 'Cancelling the correct confirmation preserves drafts');
        unavailable = true;
        const before = statusReads; timers.forEach(callback => callback());
        await waitFor(dom, () => statusReads > before && byId(dom, 'garmin-delete').getAttribute('aria-disabled') === 'true');
        byId(dom, 'garmin-delete').click();
        assert.equal(confirmations.length, 1, 'A failed refresh invalidates the previously known count');
    } finally { dom.window.close(); await store.close(); }
});
