// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, STORAGE_KEY, type SettingsStorageArea } from '../../src/settings/settings.ts';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';
import { settingsTransfer as Transfer } from '../../src/settings/settings-transfer.ts';

type Values = Record<string, unknown>;
const makeArea = (initial: Values = {}) => {
    const data: Values = { ...initial };
    const area: SettingsStorageArea & { data: Values } = {
        data,
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[String(key)]])),
        remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
        set: async values => { Object.assign(data, values); },
    };
    return area;
};
// A stored record, read as the fields these cases assert.
const record = (area: { data: Values }, key: string) => area.data[key] as Values | undefined;

test('migrated SNOTEL opt-outs persist independently through later weather changes', async () => {
    const area = makeArea({ [STORAGE_KEY]: { showWeather: false } });
    const store = createSettingsStore({ localArea: makeArea(), area, sendMessage: null });
    assert.equal((await store.requireCurrent()).showSnotel, false);
    assert.equal((await store.applyPatch({ showWeather: true })).showSnotel, false);
    await store.applyPatch({ showSnotel: true });
    assert.equal((await store.applyPatch({ showWeather: false })).showSnotel, true);
});

test('a settings mutation fails closed when the authoritative read fails', async () => {
    let writes = 0;
    const store = createSettingsStore({ localArea: makeArea(),
        area: {
            get: async () => { throw new Error('sync read failed'); },
            set: async () => { writes++; },
            remove: async () => {},
        },
        sendMessage: null,
    });

    await assert.rejects(store.applyPatch({ theme: 'dark' }), /sync read failed/);
    await assert.rejects(store.requireCurrent(), /sync read failed/,
        'privacy and preservation callers need the authoritative read failure');
    assert.equal(writes, 0, 'fallback defaults must never become the base of a mutation');
    assert.equal((await store.get()).theme, 'system', 'ordinary reads remain fail-soft');
});

test('a settings mutation propagates storage write failure and its queue recovers', async () => {
    const area = makeArea({ [STORAGE_KEY]: { theme: 'light', units: 'imperial' } });
    const nativeSet = area.set;
    let fail = true;
    area.set = async (values: Values) => {
        if (fail) {
            fail = false;
            throw new Error('sync write failed');
        }
        await nativeSet(values);
    };
    const store = createSettingsStore({ localArea: makeArea(), area, sendMessage: null });

    await assert.rejects(store.applyPatch({ theme: 'dark' }), /sync write failed/);
    const next = await store.applyPatch({ units: 'metric' });
    assert.equal(next.theme, 'light');
    assert.equal(next.units, 'metric');
});

test('a client mutation fails when the worker-owned settings route is absent', async () => {
    const area = makeArea({ [STORAGE_KEY]: { theme: 'light' } });
    let writes = 0;
    area.set = async () => { writes++; };
    const store = createSettingsStore({ localArea: makeArea(), area, sendMessage: async () => null });

    await assert.rejects(store.set({ theme: 'dark' }), /could not be saved/i);
    assert.equal(writes, 0, 'a client must not fall back to a competing local read-modify-write');
});

test('worker-owned settings patches preserve concurrent writes from separate contexts', async () => {
    const area = makeArea({ [STORAGE_KEY]: { theme: 'light', units: 'imperial' } });
    let releaseFirstRead!: () => void;
    let readCount = 0;
    const nativeGet = area.get;
    area.get = async (key?: string | string[] | null) => {
        readCount++;
        if (readCount === 1) await new Promise<void>(resolve => { releaseFirstRead = resolve; });
        return nativeGet(key);
    };

    const workerStore = createSettingsStore({ localArea: makeArea(), area, sendMessage: null });
    // The worker's SETTINGS_PATCH route, as the page clients message it.
    const route = async (message: unknown) => ({
        ok: true,
        settings: await workerStore.applyPatch((message as { patch: Values }).patch),
    });
    const firstContext = createSettingsStore({ localArea: makeArea(), area, sendMessage: route });
    const secondContext = createSettingsStore({ localArea: makeArea(), area, sendMessage: route });

    const themeWrite = firstContext.set({ theme: 'dark' });
    const unitsWrite = secondContext.set({ units: 'metric' });
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseFirstRead();
    await Promise.all([themeWrite, unitsWrite]);

    assert.equal(record(area, STORAGE_KEY)?.theme, 'dark');
    assert.equal(record(area, STORAGE_KEY)?.units, 'metric');
});

test('conditional settings restore yields to a newer queued patch', async () => {
    const area = makeArea({ [STORAGE_KEY]: { theme: 'light', units: 'imperial' } });
    const store = createSettingsStore({ localArea: makeArea(), area, sendMessage: null });
    const previous = await store.requireCurrent();
    const imported = await store.applyPatch({ theme: 'dark' });

    const newer = store.applyPatch({ units: 'metric' });
    const rollback = store.replaceIfCurrent(imported, previous);
    await newer;

    assert.deepEqual(await rollback, {
        replaced: false,
        current: await store.requireCurrent(),
    });
    assert.equal(record(area, STORAGE_KEY)?.theme, 'dark');
    assert.equal(record(area, STORAGE_KEY)?.units, 'metric');
});

test('legacy order migration fills missing lists without overwriting a newer choice', async () => {
    const area = makeArea();
    const store = createSettingsStore({ localArea: makeArea(), area, sendMessage: null });
    const selected = ['beta', 'gps', 'tr', 'link', 'fav'];
    await Promise.all([
        store.applyPatch({ betaPeakFilterOrder: selected }),
        store.applyPatch({ betaPeakFilterOrder: ['fav', 'gps', 'tr', 'link', 'beta'], betaPersonalFilterOrder: ['beta', 'link', 'tr', 'gps'] }, { onlyIfUnset: true }),
    ]);
    assert.deepEqual(record(area, STORAGE_KEY)?.betaPeakFilterOrder, selected);
    assert.deepEqual(record(area, STORAGE_KEY)?.betaPersonalFilterOrder, ['beta', 'link', 'tr', 'gps']);
});

test('two devices share personal preferences while keeping geometry and transfer consent local', async () => {
    const area = makeArea({ bpbSettings: { theme: 'dark', autoSettingsBackup: true, mapViewportWidth: 900 } });
    const firstLocal = makeArea({ bpbGithubAuth: { token: 'existing', repo: { name: 'backup' } },
        bpbPeakWeatherModelPast: 'gfs_global', bpbMapOverlayOpacityV1: { land: 80 },
        'bpbPhotoTool:anchor': { rotation: 45 }, bpbPhotoSharedStyle: { color: '#123456', opacity: 0.5 } });
    const secondLocal = makeArea();
    const first = createSettingsStore({ area, localArea: firstLocal });
    const second = createSettingsStore({ area, localArea: secondLocal });
    assert.equal((await second.requireCurrent()).autoSettingsBackup, false);
    await first.migrate(); await second.migrate();
    assert.equal((await first.requireCurrent()).autoSettingsBackup, true);
    await second.applyPatch({ mapViewportWidth: 500, autoSettingsBackup: false, theme: 'light' });
    assert.equal((await first.requireCurrent()).mapViewportWidth, 900);
    assert.equal((await first.requireCurrent()).theme, 'light');
    assert.equal((await second.requireCurrent()).mapViewportWidth, 500);
    assert.equal((await second.requireCurrent()).bpbPeakWeatherModelPast, 'gfs_global');
    assert.equal(((await second.requireCurrent() as Values)['bpbPhotoTool:anchor'] as { rotation?: number } | undefined)?.rotation, 45);
    for (const key of Schema.DEVICE_KEYS) assert.equal(Object.hasOwn(record(area, 'bpbSettings')!, key), false);
    const file = Transfer.buildPayload(await first.requireCurrent());
    for (const key of Schema.DEVICE_KEYS) (file.settings as Values)[key] = true; // even legacy imports cannot transfer consent
    const parsed = Transfer.parse(Transfer.serialize(file));
    assert.ok(parsed.ok);
    await second.applyPatch(parsed.settings);
    assert.equal((await second.requireCurrent()).autoSettingsBackup, false);
    assert.equal((await second.requireCurrent()).mapViewportWidth, 500);
    assert.equal(((await second.requireCurrent()).bpbMapOverlayOpacityV1 as { land?: number } | null)?.land, 80);
});

test('explicit synced values win over legacy local preferences and migration is idempotent', async () => {
    const area = makeArea({ bpbSettings: { bpbAscentWeatherModel: 'era5', bpbPhotoSharedStyle: null } });
    const localArea = makeArea({ bpbAscentWeatherModel: 'gfs_global', bpbPhotoSharedStyle: { color: '#abcdef' } });
    const store = createSettingsStore({ area, localArea });
    await store.migrate(); const snapshot = structuredClone(area.data);
    await store.migrate();
    assert.deepEqual(area.data, snapshot);
    assert.equal((await store.requireCurrent()).bpbAscentWeatherModel, 'era5');
    assert.equal((await store.requireCurrent()).bpbPhotoSharedStyle, null);
    assert.ok(Buffer.byteLength('bpbSettings' + JSON.stringify(record(area, 'bpbSettings'))) < 8192);
});

test('device settings fail closed and a failed synced write rolls back its local half', async () => {
    const area = makeArea(); const localArea = makeArea();
    const store = createSettingsStore({ area, localArea });
    await store.migrate(); const previous = structuredClone(localArea.data);
    area.set = async () => { throw new Error('quota'); };
    await assert.rejects(store.applyPatch({ theme: 'dark', autoSettingsBackup: true }), /quota/);
    assert.deepEqual(localArea.data, previous);
    localArea.data.bpbDeviceSettings = { schemaVersion: 99 };
    await assert.rejects(store.requireCurrent(), /unavailable/);
    assert.equal((await store.get()).autoSettingsBackup, false);
});

test('a fresh installation freezes local consent without publishing defaults to browser sync', async () => {
    const area = makeArea(), localArea = makeArea();
    const store = createSettingsStore({ area, localArea });
    await store.migrate();
    assert.equal(area.data.bpbSettings, undefined);
    assert.equal((record(localArea, 'bpbDeviceSettings')?.settings as Values | undefined)?.autoSettingsBackup, false);
    area.data.bpbSettings = { theme: 'dark', autoSettingsBackup: true };
    assert.equal((await store.requireCurrent()).theme, 'dark');
    assert.equal((await store.requireCurrent()).autoSettingsBackup, false);
});
