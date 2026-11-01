import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGarminStore } from '../../src/garmin/garmin-store.js';
import { createGarminImports } from '../../src/garmin/garmin-imports.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { loadOptions, registerCleanup } from '../helpers/options-helpers.mjs';
import { waitFor } from '../helpers/load-page.mjs';
registerCleanup();
const byId = (dom, id) => dom.window.document.getElementById(id);

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
