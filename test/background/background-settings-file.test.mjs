// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsFileRoutes } from '../../src/background/settings-file-routes.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { settingsTransfer as Transfer } from '../../src/settings/settings-transfer.js';
import { imgbbAuth as ImgbbAuth } from '../../src/photos/imgbb-auth.js';

const makeArea = (initial = {}) => {
    const values = structuredClone(initial);
    return {
        values,
        async get(key) { return { [key]: structuredClone(values[key]) }; },
        async set(patch) { Object.assign(values, structuredClone(patch)); },
        async remove(key) { delete values[key]; },
    };
};

const harness = ({ settings = { theme: 'dark', units: 'imperial' }, imgbb = null } = {}) => {
    const sync = makeArea({ bpbSettings: settings });
    const local = makeArea(imgbb ? {
        [ImgbbAuth.STORAGE_KEY]: { key: imgbb, savedAt: '2026-07-29T12:00:00.000Z' },
    } : {});
    const settingsStore = {
        requireCurrent: async () => Schema.clean((await sync.get('bpbSettings')).bpbSettings),
        applyPatch: async patch => {
            const current = Schema.clean((await sync.get('bpbSettings')).bpbSettings);
            const next = Schema.clean({ ...current, ...patch });
            await sync.set({ bpbSettings: next });
            return next;
        },
    };
    const keyStore = ImgbbAuth.createKeyStore(local);
    const ext = {
        runtime: {
            getURL: path => `chrome-extension://test-extension/${path}`,
            getManifest: () => ({ version: '3.3.0' }),
        },
    };
    const routes = createSettingsFileRoutes({ ext, settings: settingsStore, keyStore });
    return { routes, sync, local, settingsStore, keyStore };
};

const optionsSender = {
    url: 'chrome-extension://test-extension/options/options.html#github-settings-backup',
};
const straySender = {
    url: 'chrome-extension://test-extension/options/favorites.html',
};

test('manual file export includes schema settings and the ImgBB API key', async () => {
    const h = harness({ imgbb: 'secret-imgbb-key' });
    const response = await h.routes.handlers.SETTINGS_FILE_EXPORT({}, optionsSender);

    assert.equal(response.ok, true);
    const parsed = Transfer.parse(response.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.theme, 'dark');
    assert.deepEqual(parsed.apiKeys, { imgbb: 'secret-imgbb-key' });
    assert.match(response.exportedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(
        (await h.routes.handlers.SETTINGS_FILE_EXPORT({}, straySender)).error.code,
        'forbidden'
    );
});

test('manual file import replaces settings and the API key, including an explicit empty key', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const configured = Transfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'new-imgbb-key' },
    });
    const imported = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(configured),
    }, optionsSender);

    assert.equal(imported.ok, true);
    assert.equal(h.sync.values.bpbSettings.theme, 'light');
    assert.equal(h.sync.values.bpbSettings.units, 'metric');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'new-imgbb-key');

    const empty = Transfer.buildPayload({ theme: 'dark' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T13:00:00.000Z',
        apiKeys: { imgbb: null },
    });
    assert.equal((await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(empty),
    }, optionsSender)).ok, true);
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY], undefined);
});

test('legacy imports preserve the destination API key', async () => {
    const h = harness({ imgbb: 'keep-imgbb-key' });
    const legacy = JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: 1,
        settings: { theme: 'light' },
    });
    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({ content: legacy }, optionsSender);

    assert.equal(response.ok, true);
    assert.equal(response.apiKeysImported, false);
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'keep-imgbb-key');
});

test('a failed API-key write rolls settings back to their previous values', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const nativeSetKey = h.keyStore.setKey;
    let failOnce = true;
    h.keyStore.setKey = async (...args) => {
        if (failOnce) {
            failOnce = false;
            throw new Error('local write failed');
        }
        return nativeSetKey(...args);
    };
    const payload = Transfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'new-imgbb-key' },
    });
    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'import-failed');
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(h.sync.values.bpbSettings.units, 'imperial');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'old-imgbb-key');
});
