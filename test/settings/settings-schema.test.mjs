// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The settings schema is the one definition of the extension's defaults and
// bounds. It has to be, because four surfaces validate settings independently:
// src/settings/settings.js on the way into storage, and the page-world GPX analyzer,
// the page-world BigMap, and the terrain frame on the way back out (each
// receives settings over postMessage, which crosses a trust boundary).
//
// These tests pin the validation semantics and then guard the arrangement
// itself: no surface may reintroduce its own copy of a default or a bound.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { walkFiles } from '../helpers/walk-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('clean() clamps oversized values but resets a sub-minimum viewport width to the default', () => {
    // Width is asymmetric on purpose: values under the pixel minimum also cover
    // the short-lived pre-release percentage schema, so "100" must not be read
    // as 320 px. Oversized values still clamp.
    assert.equal(Schema.clean({ mapViewportWidth: 100 }).mapViewportWidth, Schema.VIEWPORT.width);
    assert.equal(Schema.clean({ mapViewportWidth: 5000 }).mapViewportWidth, Schema.BOUNDS.viewportWidth.max);
    assert.equal(Schema.clean({ mapViewportWidth: 700 }).mapViewportWidth, 700);

    // Height clamps in both directions.
    assert.equal(Schema.clean({ mapViewportHeight: 10 }).mapViewportHeight, Schema.BOUNDS.viewportHeight.min);
    assert.equal(Schema.clean({ mapViewportHeight: 9000 }).mapViewportHeight, Schema.BOUNDS.viewportHeight.max);
});

test('a casing always stays wider than the route it sits behind', () => {
    // The casing only reads as a casing when it is wider than the line, so the
    // route width raises the floor no matter what the setting says.
    const cleaned = Schema.clean({ mapRouteWidth: 12, mapRouteCasingWidth: 3 });
    assert.equal(cleaned.mapRouteCasingWidth, 14);

    const style = Schema.routeStyle({ width: 12, casingWidth: 3 });
    assert.equal(style.casingWidth, 14);
});

test('favorite climber source defaults to buddies and accepts only known modes', () => {
    assert.equal(Schema.DEFAULTS.favoritesSource, 'buddies');
    assert.equal(Schema.clean({}).favoritesSource, 'buddies');
    assert.equal(Schema.clean({ favoritesSource: 'custom' }).favoritesSource, 'custom');
    assert.equal(Schema.clean({ favoritesSource: 'shared' }).favoritesSource, 'buddies');
    assert.equal(Schema.clean({ favoritesSource: null }).favoritesSource, 'buddies');
});

test('routeStyle() rejects untrusted values back to the shared defaults', () => {
    const style = Schema.routeStyle({
        color: 'javascript:alert(1)',
        width: 'not a number',
        casingColor: null,
        casingWidth: {}
    });
    assert.deepEqual(style, Schema.ROUTE_STYLE);
    assert.deepEqual(Schema.routeStyle(undefined), Schema.ROUTE_STYLE);
});

test('the storage writer and the page-world readers resolve a value identically', () => {
    // The whole point of the shared schema: whatever clean() writes, the
    // page-world resolvers must accept unchanged (validation is idempotent).
    for (const raw of [
        {},
        { mapRouteWidth: 99, mapRouteCasingWidth: 1, mapViewportWidth: 5000, terrainCacheLimitMb: -5 },
        { mapRouteColor: '#ABCDEF', mapRouteCasingWidth: 20, mapViewportHeight: 1 },
        { mapRouteColor: 'bogus', mapViewportWidth: 100, terrainCacheLimitMb: 99999 }
    ]) {
        const stored = Schema.clean(raw);
        assert.deepEqual(Schema.routeStyleFromSettings(stored), {
            color: stored.mapRouteColor,
            width: stored.mapRouteWidth,
            casingColor: stored.mapRouteCasingColor,
            casingWidth: stored.mapRouteCasingWidth
        }, `route style diverged for ${JSON.stringify(raw)}`);
        assert.deepEqual(Schema.viewportSizeFromSettings(stored), {
            width: stored.mapViewportWidth,
            height: stored.mapViewportHeight
        }, `viewport diverged for ${JSON.stringify(raw)}`);
        assert.equal(Schema.terrainCacheLimitMb(stored.terrainCacheLimitMb), stored.terrainCacheLimitMb,
            `cache limit diverged for ${JSON.stringify(raw)}`);
    }
});

test('no surface keeps its own copy of a schema default or bound', async () => {
    // This is the regression this module exists to prevent: the route defaults
    // once lived in four files and the bounds in three, free to drift apart.
    const sourceRoot = path.join(root, 'src');
    const sources = (await walkFiles(sourceRoot, file => file.endsWith('.js')))
        .filter(file => path.basename(file) !== 'settings-schema.js');
    assert.ok(sources.length >= 15, 'expected the src module set to be present');

    const banned = [
        { pattern: /#d9483b/i, what: 'the default route color' },
        { pattern: /casingWidth:\s*9\b/, what: 'the default casing width' },
        { pattern: /\b(?:1,\s*12|3,\s*20|240,\s*720)\b/, what: 'a route/viewport bound pair' }
    ];

    const leaks = [];
    for (const file of sources) {
        const text = await readFile(file, 'utf8');
        for (const { pattern, what } of banned) {
            if (pattern.test(text)) leaks.push(`${path.relative(root, file)} hardcodes ${what}`);
        }
    }
    assert.deepEqual(leaks, [],
        `these belong in src/settings/settings-schema.js:\n${leaks.join('\n')}`);
});
