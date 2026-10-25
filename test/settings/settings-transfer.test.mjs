// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { settingsTransfer as Transfer } from '../../src/settings/settings-transfer.js';
import { readCustomSource } from '../../src/maps/custom-overlay-schema.js';

test('display opt-outs survive settings files and affect backup signatures; older files keep sections visible', () => {
    const payload = Transfer.buildPayload({ showSunMoon: false, showWeather: false });
    const restored = Transfer.parse(Transfer.serialize(payload)).settings;
    assert.equal(restored.showSunMoon, false);
    assert.equal(restored.showWeather, false);
    assert.notEqual(Transfer.signature({}), Transfer.signature({ showSunMoon: false }));
    assert.notEqual(Transfer.signature({}), Transfer.signature({ showWeather: false }));
    delete payload.settings.showSunMoon; delete payload.settings.showWeather;
    const legacy = Transfer.parse(Transfer.serialize(payload)).settings;
    assert.equal(legacy.showSunMoon, true); assert.equal(legacy.showWeather, true);
});

test('SNOTEL transfers independently and legacy backups retain weather opt-outs', () => {
    const payload = Transfer.buildPayload({ showWeather: true, showSnotel: false });
    assert.equal(Transfer.parse(Transfer.serialize(payload)).settings.showSnotel, false);
    assert.notEqual(Transfer.signature({}), Transfer.signature({ showSnotel: false }));
    delete payload.settings.showSnotel;
    payload.settings.showWeather = false;
    assert.equal(Transfer.parse(Transfer.serialize(payload)).settings.showSnotel, false);
    payload.settings.showWeather = true;
    assert.equal(Transfer.parse(Transfer.serialize(payload)).settings.showSnotel, true);
});

test('mixed unit preferences survive settings transfer and legacy files inherit their default', () => {
    const mixed = { units: 'imperial', temperatureUnits: 'metric', precipitationUnits: 'metric', distanceUnits: 'metric', elevationUnits: 'imperial' };
    const payload = Transfer.buildPayload(mixed);
    const parsed = Transfer.parse(Transfer.serialize(payload));
    assert.equal(parsed.ok, true);
    for (const [key, value] of Object.entries(mixed)) assert.equal(parsed.settings[key], value);
    for (const key of Object.values(Schema.UNIT_KEYS)) delete payload.settings[key];
    const legacy = Transfer.parse(Transfer.serialize(payload));
    assert.equal(legacy.settings.units, 'imperial');
    for (const key of Object.values(Schema.UNIT_KEYS)) assert.equal(legacy.settings[key], 'default');
    assert.notEqual(Transfer.signature(mixed), Transfer.signature({ units: 'imperial' }));
});

test('settings transfer payload round-trips known cleaned settings', () => {
    const payload = Transfer.buildPayload({
        theme: 'dark',
        mapRouteWidth: 999,
        unknownSetting: 'discard me'
    }, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T12:00:00.000Z'
    });

    assert.equal(payload.kind, Transfer.KIND);
    assert.equal(payload.schemaVersion, Transfer.SCHEMA_VERSION);
    assert.equal(payload.extensionVersion, '3.0.0');
    assert.equal(payload.settings.theme, 'dark');
    assert.equal(payload.settings.mapRouteWidth, Schema.BOUNDS.routeWidth.max);
    assert.equal('unknownSetting' in payload.settings, false);
    assert.deepEqual(Object.keys(payload.settings), Schema.PORTABLE_KEYS);

    const parsed = Transfer.parse(Transfer.serialize(payload));
    assert.deepEqual(parsed, { ok: true, settings: payload.settings });
    assert.equal('apiKeys' in payload, false,
        'credential-free callers such as GitHub backup must opt in to API keys');
});

test('custom layer definitions and opacity round-trip without live state or local revisions', () => {
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 14, name: 'Topo', kind: 'raster',
        source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png?key=public'], minNativeZoom: 3, maxNativeZoom: 15, scheme: 'tms', tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: 'Topo' }, appearance: { opacity: 60, rules: [] } };
    assert.ok(readCustomSource(source));
    const customLayers = { schemaVersion: 1, sources: [source], preferences: { [source.id]: 35 }, enabled: true, cached: 'never export' };
    const payload = Transfer.buildPayload({}, { customLayers });
    const parsed = Transfer.parse(Transfer.serialize(payload)); assert.equal(parsed.ok, true);
    assert.equal(parsed.customLayers.sources[0].revision, 1); assert.equal(parsed.customLayers.preferences[source.id], 35);
    assert.equal(parsed.customLayers.enabled, undefined); assert.equal(parsed.customLayers.cached, undefined);
    assert.notEqual(Transfer.signature({}), Transfer.signature({}, customLayers));
    const changed = structuredClone(customLayers); changed.preferences[source.id] = 70;
    assert.notEqual(Transfer.signature({}, customLayers), Transfer.signature({}, changed));
    changed.sources[0].revision++; assert.equal(Transfer.signature({}, changed), Transfer.signature({}, { ...changed, sources: [{ ...changed.sources[0], revision: 1 }] }));
    assert.equal(Transfer.signature({}, { schemaVersion: 1, sources: [], preferences: {} }), Transfer.signature({}), 'empty-library upgrade preserves backup identity');
    const legacy = { ...payload, schemaVersion: 5 }; delete legacy.customLayers;
    assert.equal(Object.hasOwn(Transfer.parse(Transfer.serialize(legacy)), 'customLayers'), false, 'legacy imports preserve destination library');
    payload.customLayers.sources[0].source.tiles = ['http://unsafe.example.com/{z}/{x}/{y}'];
    assert.equal(Transfer.parse(Transfer.serialize(payload)).reason, 'invalid-custom-layers');
});

test('manual settings transfer round-trips every supported API key state', () => {
    const configured = Transfer.buildPayload({ theme: 'dark' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'secret-imgbb-key' },
    });
    assert.deepEqual(
        Transfer.parse(Transfer.serialize(configured)).apiKeys,
        { imgbb: 'secret-imgbb-key' }
    );

    const unconfigured = Transfer.buildPayload({}, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: null },
    });
    assert.deepEqual(
        Transfer.parse(Transfer.serialize(unconfigured)).apiKeys,
        { imgbb: null },
        'an explicit empty key lets import clear a key the destination already has'
    );
    assert.deepEqual(Transfer.API_KEY_NAMES, ['imgbb', 'garmin']);
});

test('manual settings transfer includes a cleaned GitHub connection only when requested', () => {
    const withoutConnection = Transfer.buildPayload({ theme: 'dark' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-31T12:00:00.000Z',
    });
    assert.equal('githubConnection' in withoutConnection, false);

    const withConnection = Transfer.buildPayload({ theme: 'dark' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-31T12:00:00.000Z',
        githubConnection: {
            token: 'ghu_private_token',
            repository: {
                owner: 'ada', name: 'peaks', id: 123,
                branch: 'discarded', fullName: 'ada/peaks',
            },
            account: { login: 'discarded' },
        },
    });
    assert.deepEqual(withConnection.githubConnection, {
        token: 'ghu_private_token',
        repository: { owner: 'ada', name: 'peaks', id: 123 },
    });
    assert.deepEqual(Transfer.parse(Transfer.serialize(withConnection)).githubConnection,
        withConnection.githubConnection);
});

test('settings transfer rejects malformed or falsely backported GitHub credentials', () => {
    assert.throws(() => Transfer.buildPayload({}, {
        exportedAt: '2026-07-31T12:00:00.000Z',
        githubConnection: { token: 'short', repository: { owner: 'ada', name: 'peaks' } },
    }), /GitHub connection is invalid/);

    const malformed = {
        kind: Transfer.KIND,
        schemaVersion: Transfer.SCHEMA_VERSION,
        settings: {},
        githubConnection: {
            token: 'ghu_private_token\nsmuggled',
            repository: { owner: 'ada', name: '../peaks' },
        },
    };
    assert.deepEqual(Transfer.parse(JSON.stringify(malformed)), {
        ok: false, reason: 'invalid-github-connection',
    });

    malformed.schemaVersion = 2;
    malformed.githubConnection = {
        token: 'ghu_private_token', repository: { owner: 'ada', name: 'peaks' },
    };
    assert.deepEqual(Transfer.parse(JSON.stringify(malformed)), {
        ok: false, reason: 'invalid-github-connection',
    });
});

test('settings transfer strips unknown input keys and cleans imported values', () => {
    const parsed = Transfer.parse(JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: 1,
        settings: {
            theme: 'ultraviolet',
            mapViewportHeight: 99999,
            futureSetting: true
        }
    }));

    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.theme, Schema.DEFAULTS.theme);
    assert.equal(parsed.settings.mapViewportHeight, undefined);
    assert.equal('futureSetting' in parsed.settings, false);
    assert.deepEqual(Object.keys(parsed.settings), Schema.PORTABLE_KEYS);
});

test('legacy settings files leave API keys untouched and malformed keys reject the whole file', () => {
    const legacy = Transfer.parse(JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: 1,
        settings: { theme: 'light' },
    }));
    assert.equal(legacy.ok, true);
    assert.equal(Object.hasOwn(legacy, 'apiKeys'), false);

    assert.deepEqual(Transfer.parse(JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: Transfer.SCHEMA_VERSION,
        settings: {},
        apiKeys: { imgbb: 'contains spaces' },
    })), { ok: false, reason: 'invalid-api-keys' });
    assert.throws(() => Transfer.buildPayload({}, {
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: {},
    }), /API keys are invalid/);
});

test('settings transfer rejects invalid and unsupported payloads', () => {
    assert.deepEqual(Transfer.parse('{'), { ok: false, reason: 'not-json' });
    assert.deepEqual(Transfer.parse(JSON.stringify({ kind: 'something-else' })),
        { ok: false, reason: 'wrong-kind' });
    assert.deepEqual(Transfer.parse(JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: Transfer.SCHEMA_VERSION + 1,
        settings: {}
    })), { ok: false, reason: 'newer-version' });
    assert.deepEqual(Transfer.parse(JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: Transfer.SCHEMA_VERSION
    })), { ok: false, reason: 'no-settings' });
    assert.deepEqual(Transfer.parse(JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: Transfer.SCHEMA_VERSION,
        settings: []
    })), { ok: false, reason: 'no-settings' });
});

const settingsFileAtBytes = target => {
    const payload = {
        kind: Transfer.KIND,
        schemaVersion: Transfer.SCHEMA_VERSION,
        settings: { theme: 'dark' },
        ignoredPadding: [],
    };
    while (true) {
        const withEmpty = JSON.stringify({
            ...payload,
            ignoredPadding: [...payload.ignoredPadding, ''],
        });
        const remaining = target - new TextEncoder().encode(withEmpty).byteLength;
        if (remaining <= 8192) {
            assert.ok(remaining >= 0);
            payload.ignoredPadding.push('x'.repeat(remaining));
            return JSON.stringify(payload);
        }
        payload.ignoredPadding.push('x'.repeat(8192));
    }
};

test('settings import size is counted as UTF-8 before JSON parsing', () => {
    const exact = settingsFileAtBytes(Transfer.IMPORT_MAX_BYTES);
    assert.equal(new TextEncoder().encode(exact).byteLength, Transfer.IMPORT_MAX_BYTES);
    assert.equal(Transfer.parse(exact).ok, true);
    assert.deepEqual(Transfer.parse(`${exact} `), { ok: false, reason: 'too-large' });

    const multibyte = JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: Transfer.SCHEMA_VERSION,
        settings: {},
        ignored: 'é'.repeat(Math.floor(Transfer.IMPORT_MAX_BYTES / 2)),
    });
    assert.ok(multibyte.length < Transfer.IMPORT_MAX_BYTES,
        'the character count alone would incorrectly admit this file');
    assert.deepEqual(Transfer.parse(multibyte), { ok: false, reason: 'too-large' });
});

test('valid-size settings imports reject excessive parsed structure', () => {
    const payload = {
        kind: Transfer.KIND,
        schemaVersion: Transfer.SCHEMA_VERSION,
        settings: {},
    };
    let cursor = payload;
    for (let depth = 0; depth <= Transfer.IMPORT_STRUCTURE_LIMITS.maxDepth; depth += 1) {
        cursor.ignored = {};
        cursor = cursor.ignored;
    }
    assert.deepEqual(Transfer.parse(JSON.stringify(payload)), {
        ok: false,
        reason: 'too-complex',
    });
});

test('settings signature depends only on cleaned known settings in schema order', () => {
    const first = {
        theme: 'dark',
        units: 'metric',
        unknown: 1
    };
    const second = {
        units: 'metric',
        unknown: 2,
        theme: 'dark'
    };

    assert.equal(Transfer.signature(first), Transfer.signature(second));

    const oldPayload = Transfer.buildPayload(first, {
        extensionVersion: '2.9.0',
        exportedAt: '2026-01-01T00:00:00.000Z'
    });
    const newPayload = Transfer.buildPayload(second, {
        extensionVersion: '3.0.0',
        exportedAt: '2026-07-22T00:00:00.000Z'
    });
    assert.equal(Transfer.signature(oldPayload.settings), Transfer.signature(newPayload.settings));
});

test('provider visibility and both filter orders survive settings transfer', () => {
    const settings = { mapProviderOrder: ['caltopo', 'onx', 'gaia', 'alltrails'], mapProvidersEnabled: [],
        betaPeakFilterOrder: ['beta', 'link', 'tr', 'gps', 'fav'], betaPersonalFilterOrder: ['link', 'beta', 'gps', 'tr'] };
    const result = Transfer.parse(Transfer.serialize(Transfer.buildPayload(settings)));
    assert.equal(result.ok, true);
    for (const [key, value] of Object.entries(settings)) assert.deepEqual(result.settings[key], value);
    const defaults = Transfer.buildPayload({}).settings;
    assert.deepEqual(defaults.betaPeakFilterOrder, Schema.PEAK_FILTER_ORDER);
    assert.deepEqual(defaults.betaPersonalFilterOrder, Schema.PERSONAL_FILTER_ORDER);
});

test('GPX timestamp privacy survives export/import and changes the GitHub settings signature', () => {
    const payload = Transfer.buildPayload({ removeGpxTimestamps: true, includeTimestampsOnce: true });
    assert.equal(Transfer.parse(Transfer.serialize(payload)).settings.removeGpxTimestamps, true);
    assert.equal('includeTimestampsOnce' in payload.settings, false);
    assert.notEqual(Transfer.signature({}), Transfer.signature({ removeGpxTimestamps: true }));
    delete payload.settings.removeGpxTimestamps;
    assert.equal(Transfer.parse(Transfer.serialize(payload)).settings.removeGpxTimestamps, false);
    for (const invalid of ['true', 1, null]) assert.equal(Schema.clean({ removeGpxTimestamps: invalid }).removeGpxTimestamps, false);
});
