// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Units panel's typed boundary and the SETTINGS_PATCH route it writes
// through. Requests and replies cross a real structured clone, as runtime
// messaging does, and land on the worker's actual settings mutation path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, STORAGE_KEY } from '../../src/settings/settings.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.ts';
import {
    SETTINGS_PATCH, settingsPatchRoute,
    type SettingsPatchReply, type SettingsPatchRequest, type SettingsPatchRoute,
} from '../../options/settings-patch-route.ts';
import {
    UNIT_SETTING_KEYS, projectUnitSettings, resetUnitOverridesPatch, unitSettingsPatch,
    type UnitSettings, type UnitSettingsOptions, type UnitSettingsPatch,
} from '../../options/unit-settings-contract.ts';

type Data = Record<string, unknown>;
type StoreDependencies = NonNullable<Parameters<typeof createSettingsStore>[0]>;
const makeArea = (initial: Data = {}) => {
    const data: Data = { ...initial };
    return {
        data,
        get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
        remove: async (key: string) => { delete data[key]; },
        set: async (values: Data) => { Object.assign(data, values); },
    };
};

// A worker that applies patches the way background.ts's SETTINGS_PATCH case
// does, behind a transport that structured-clones both directions.
const wire = (stored: Data = {}) => {
    const area = makeArea({ [STORAGE_KEY]: stored });
    // The fakes implement only the calls the store makes.
    const worker = createSettingsStore({ area, localArea: makeArea(), onChanged: null, sendMessage: null } as unknown as StoreDependencies);
    const requests: unknown[] = [];
    let reply = async (request: SettingsPatchRequest): Promise<unknown> => ({
        ok: true, settings: await worker.applyPatch(request.patch, { onlyIfUnset: request.onlyIfUnset === true }),
    } satisfies SettingsPatchReply);
    const route = settingsPatchRoute(async request => {
        const received = structuredClone(request);
        requests.push(received);
        return structuredClone(await reply(received));
    });
    return { area, route, requests, reply: (next: typeof reply) => { reply = next; } };
};

// Reactive state libraries hand out nested proxies; none of them can be cloned.
const reactive = <T extends object>(value: T): T => new Proxy(value, {
    get: (target, key, receiver) => {
        const field = Reflect.get(target, key, receiver);
        return field && typeof field === 'object' ? reactive(field) : field;
    },
});

test('unit patches are rebuilt from nested proxies as frozen allowlisted plain data', async () => {
    const state = reactive({
        ...Schema.DEFAULTS,
        units: 'metric', temperatureUnits: 'imperial',
        theme: 'dark', githubToken: 'never-sent', nested: { deeper: { value: 1 } },
    });
    assert.throws(() => structuredClone(state), { name: 'DataCloneError' }, 'the fixture really is uncloneable');
    assert.throws(() => structuredClone(state.nested), { name: 'DataCloneError' });

    const patch = unitSettingsPatch(state);
    assert.equal(Object.getPrototypeOf(patch), Object.prototype);
    assert.ok(Object.isFrozen(patch));
    assert.deepEqual(Object.keys(patch), [...UNIT_SETTING_KEYS]);
    assert.deepEqual(patch, {
        units: 'metric', distanceUnits: 'default', elevationUnits: 'default',
        temperatureUnits: 'imperial', precipitationUnits: 'default', windUnits: 'default',
    });
    assert.deepEqual(structuredClone(patch), patch);

    const { area, route, requests } = wire({ theme: 'light', units: 'imperial' });
    const saved = await route.set(unitSettingsPatch(reactive({ units: 'metric', theme: 'dark' })));
    assert.deepEqual(requests, [{ type: SETTINGS_PATCH, patch: { units: 'metric' } }], 'only approved fields cross the wire');
    assert.equal(saved.units, 'metric');
    assert.equal(saved.theme, 'light');
    assert.deepEqual((area.data[STORAGE_KEY] as Data).theme, 'light');
});

test('unit patches validate through the shared schema and reset only the overrides', () => {
    assert.deepEqual(unitSettingsPatch({}), {});
    for (const [key, value] of [['units', 'default'], ['units', 'kelvin'], ['windUnits', 'auto'], ['distanceUnits', 3]] as const) {
        assert.throws(() => unitSettingsPatch({ [key]: value }), RangeError, `${key}: ${String(value)}`);
    }
    assert.deepEqual(resetUnitOverridesPatch(), {
        distanceUnits: 'default', elevationUnits: 'default',
        temperatureUnits: 'default', precipitationUnits: 'default', windUnits: 'default',
    });
});

test('the panel projection holds exactly the unit keys, cleaned', () => {
    const projected = projectUnitSettings({ units: 'nautical', windUnits: 'metric', theme: 'dark', temperatureUnits: 7 });
    assert.ok(Object.isFrozen(projected));
    assert.deepEqual(projected, {
        units: 'auto', distanceUnits: 'default', elevationUnits: 'default',
        temperatureUnits: 'default', precipitationUnits: 'default', windUnits: 'metric',
    });
    assert.deepEqual(projectUnitSettings(null), projectUnitSettings({}));
    assert.deepEqual(projectUnitSettings(reactive({ units: 'imperial' })).units, 'imperial');
});

test('a successful reply resolves with the cleaned stored settings and onlyIfUnset stays on the wire', async () => {
    const { route, requests, reply } = wire({ units: 'imperial' });
    const settings = await route.set({ windUnits: 'metric' });
    assert.equal(settings.windUnits, 'metric');
    assert.equal(settings.units, 'imperial');

    reply(async () => ({ ok: true, settings: { units: 'metric', windUnits: 'nautical' } }));
    const cleaned = await route.set({ units: 'metric' });
    assert.equal(cleaned.windUnits, 'default', 'replied settings are revalidated, not trusted');
    assert.equal(cleaned.theme, Schema.DEFAULTS.theme);

    const store = createSettingsStore({ area: null, localArea: null, onChanged: null, sendMessage: async (message: unknown) => {
        requests.push(structuredClone(message));
        return { ok: true, settings: {} };
    } });
    await store.set({ units: 'metric' }, { onlyIfUnset: true });
    assert.deepEqual(requests.at(-1), { type: SETTINGS_PATCH, patch: { units: 'metric' }, onlyIfUnset: true });
});

test('transport loss, invalid replies and rejected writes reject with the current messages', async () => {
    const { route, reply } = wire();
    const cases: [string, () => Promise<unknown>, RegExp][] = [
        ['no receiving end', async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); }, /Receiving end does not exist/],
        ['empty reply', async () => undefined, /The setting could not be saved\.$/],
        ['ok without settings', async () => ({ ok: true }), /The setting could not be saved\.$/],
        ['unrelated reply', async () => 'SETTINGS_PATCH', /The setting could not be saved\.$/],
        ['sender refused', async () => ({ ok: false, error: { code: 'forbidden', message: 'This page cannot change settings.' } } satisfies SettingsPatchReply),
            /This page cannot change settings\.$/],
        ['worker failure', async () => ({ phase: 'error', error: { code: 'storage', message: 'Storage quota exceeded.' } } satisfies SettingsPatchReply),
            /Storage quota exceeded\.$/],
        ['error without message', async () => ({ ok: false, error: { code: 'forbidden' } }), /The setting could not be saved\.$/],
    ];
    for (const [name, next, message] of cases) {
        reply(next);
        await assert.rejects(route.set({ units: 'metric' }), message, name);
    }
});

test('a failed write leaves storage unchanged for the controller to roll back', async () => {
    const { area, route } = wire({ units: 'imperial', temperatureUnits: 'metric' });
    area.set = async () => { throw new Error('fixture storage failure'); };
    await assert.rejects(route.set(unitSettingsPatch({ temperatureUnits: 'default' })), /fixture storage failure/);
    assert.equal((area.data[STORAGE_KEY] as Data).temperatureUnits, 'metric');
});

// Compile-time contract: each line below must fail `npm run typecheck`.
// The function is never called; it exists only for the checker.
export function rejectedUsage(route: SettingsPatchRoute, save: UnitSettingsOptions['save'], settings: UnitSettings) {
    // @ts-expect-error -- not a settings key
    void route.set({ unknownSetting: true });
    // @ts-expect-error -- wrong value type for a known key
    void route.set({ showWeather: 'yes' });
    // @ts-expect-error -- the panel may not write unrelated settings
    void save({ theme: 'dark' });
    // @ts-expect-error -- not a unit system
    void save({ units: 'kelvin' });
    // @ts-expect-error -- 'auto' is only the default system's value
    const override: UnitSettingsPatch = { windUnits: 'auto' };
    // @ts-expect-error -- the patch builder accepts only panel keys
    unitSettingsPatch({ theme: 'dark' });
    // @ts-expect-error -- the projection is read-only
    settings.units = 'metric';
    // @ts-expect-error -- the request envelope names its route
    const request: SettingsPatchRequest = { type: 'SETTINGS_SET', patch: {} };
    // @ts-expect-error -- onlyIfUnset is sent only as true
    const conditional: SettingsPatchRequest = { type: SETTINGS_PATCH, patch: {}, onlyIfUnset: false };
    // @ts-expect-error -- a success reply carries settings
    const success: SettingsPatchReply = { ok: true };
    return [override, request, conditional, success];
}
