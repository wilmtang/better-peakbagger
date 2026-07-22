// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { settingsTransfer as Transfer } from '../../src/settings/settings-transfer.js';

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
    assert.deepEqual(Object.keys(payload.settings), Object.keys(Schema.DEFAULTS));

    const parsed = Transfer.parse(Transfer.serialize(payload));
    assert.deepEqual(parsed, { ok: true, settings: payload.settings });
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
    assert.equal(parsed.settings.mapViewportHeight, Schema.BOUNDS.viewportHeight.max);
    assert.equal('futureSetting' in parsed.settings, false);
    assert.deepEqual(Object.keys(parsed.settings), Object.keys(Schema.DEFAULTS));
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
