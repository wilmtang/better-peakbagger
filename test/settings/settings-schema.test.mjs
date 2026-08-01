// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The settings schema is the one definition of the extension's defaults and
// bounds. It has to be, because four surfaces validate settings independently:
// src/settings/settings.js on the way into storage, and the page-world GPX analyzer,
// the page-world BigMap, and the terrain frame on the way back out (each
// receives settings over postMessage, which crosses a trust boundary).
//
// These tests pin the validation semantics and scan for the route, viewport,
// and theme literals that previously drifted. A new shared setting needs its
// own structural guard when it is introduced; a regex cannot prove the absence
// of every possible literal copy throughout arbitrary source code.

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

test('report image width is bounded, defaults to 640 px, and preserves Original', () => {
    assert.equal(Schema.DEFAULTS.reportImageWidth, 640);
    assert.equal(Schema.clean({}).reportImageWidth, 640);
    assert.equal(Schema.clean({ reportImageWidth: 10 }).reportImageWidth,
        Schema.BOUNDS.reportImageWidth.min);
    assert.equal(Schema.clean({ reportImageWidth: 5000 }).reportImageWidth,
        Schema.BOUNDS.reportImageWidth.max);
    assert.equal(Schema.clean({ reportImageWidth: '480' }).reportImageWidth, 480);
    assert.equal(Schema.clean({ reportImageWidth: 'wide' }).reportImageWidth, 640);
    assert.equal(Schema.clean({ reportImageWidth: null }).reportImageWidth, null);
    for (const value of [null, 64, 320, 640, 1600]) {
        const stored = Schema.clean({ reportImageWidth: value }).reportImageWidth;
        assert.equal(Schema.reportImageWidth(stored), stored);
    }
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

test('enum and beta consumers resolve through the shared schema', () => {
    assert.equal(Schema.chartDefaultSeries('time'), 'time');
    assert.equal(Schema.chartDefaultSeries('future-series'), Schema.DEFAULTS.chartDefaultSeries);
    assert.equal(Schema.favoritesSource('custom'), 'custom');
    assert.equal(Schema.favoritesSource('shared'), Schema.DEFAULTS.favoritesSource);
    assert.equal(Schema.reportEditorMode('markdown'), 'markdown');
    assert.equal(Schema.reportEditorMode('source'), Schema.DEFAULTS.reportEditorMode);

    assert.deepEqual(Schema.betaDefinitionFromSettings({
        betaTr: false,
        betaTrMinWords: '25',
        betaGps: true,
        betaLink: false,
    }), { tr: false, trMinWords: 25, gps: true, link: false });
    assert.deepEqual(Schema.betaDefinitionFromSettings({
        betaTr: false,
        betaGps: false,
        betaLink: false,
        betaTrMinWords: 'invalid',
    }), {
        tr: Schema.DEFAULTS.betaTr,
        trMinWords: Schema.DEFAULTS.betaTrMinWords,
        gps: Schema.DEFAULTS.betaGps,
        link: Schema.DEFAULTS.betaLink,
    });
});

test('removing a Buddy from custom favorites is opt-in', () => {
    assert.equal(Schema.DEFAULTS.removeFavoriteWhenBuddyRemoved, false);
    assert.equal(Schema.clean({}).removeFavoriteWhenBuddyRemoved, false);
    assert.equal(Schema.clean({ removeFavoriteWhenBuddyRemoved: true }).removeFavoriteWhenBuddyRemoved, true);
    assert.equal(Schema.clean({ removeFavoriteWhenBuddyRemoved: 'yes' }).removeFavoriteWhenBuddyRemoved, false);
});

test('automatic settings backup is opt-in and independent of ascent backup', () => {
    assert.equal(Schema.DEFAULTS.autoSettingsBackup, false);
    assert.equal(Schema.clean({}).autoSettingsBackup, false);
    assert.equal(Schema.clean({
        enableGithubBackup: false,
        autoSettingsBackup: true
    }).autoSettingsBackup, true);
    assert.equal(Schema.clean({ autoSettingsBackup: 'yes' }).autoSettingsBackup, false);
});

test('automatic favorites backup is opt-in and independent of ascent backup', () => {
    assert.equal(Schema.DEFAULTS.autoFavoritesBackup, false);
    assert.equal(Schema.clean({}).autoFavoritesBackup, false);
    assert.equal(Schema.clean({
        enableGithubBackup: false,
        autoFavoritesBackup: true
    }).autoFavoritesBackup, true);
    assert.equal(Schema.clean({ autoFavoritesBackup: 'yes' }).autoFavoritesBackup, false);
});

test('automatic photo-library metadata backup is opt-in and independent of ascent backup', () => {
    assert.equal(Schema.DEFAULTS.autoPhotoLibraryBackup, false);
    assert.equal(Schema.clean({}).autoPhotoLibraryBackup, false);
    assert.equal(Schema.clean({
        enableGithubBackup: false,
        autoPhotoLibraryBackup: true
    }).autoPhotoLibraryBackup, true);
    assert.equal(Schema.clean({ autoPhotoLibraryBackup: 'yes' }).autoPhotoLibraryBackup, false);
});

test('removing GitHub ascent files on Peakbagger deletion is a subordinate opt-in', () => {
    assert.equal(Schema.DEFAULTS.removeGithubBackupOnDelete, false);
    assert.equal(Schema.clean({
        enableGithubBackup: true,
        removeGithubBackupOnDelete: true
    }).removeGithubBackupOnDelete, true);
    assert.equal(Schema.clean({
        enableGithubBackup: false,
        removeGithubBackupOnDelete: true
    }).removeGithubBackupOnDelete, false);
    assert.equal(Schema.clean({
        enableGithubBackup: true,
        removeGithubBackupOnDelete: 'yes'
    }).removeGithubBackupOnDelete, false);
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
        assert.equal(Schema.reportImageWidth(stored.reportImageWidth), stored.reportImageWidth,
            `report image width diverged for ${JSON.stringify(raw)}`);
    }
});

test('known route, viewport, and theme defaults and bounds stay schema-owned', async () => {
    // This is the concrete regression this scan prevents: these route,
    // viewport, and theme values once lived in multiple files and drifted.
    const sourceRoot = path.join(root, 'src');
    const sources = (await walkFiles(sourceRoot, file => file.endsWith('.js')))
        .filter(file => path.basename(file) !== 'settings-schema.js');
    assert.ok(sources.length >= 15, 'expected the src module set to be present');

    const banned = [
        { pattern: /#d9483b/i, what: 'the default route color' },
        { pattern: /casingWidth:\s*9\b/, what: 'the default casing width' },
        { pattern: /\b(?:1,\s*12|3,\s*20|240,\s*720)\b/, what: 'a route/viewport bound pair' },
        { pattern: /\blet\s+pref\s*=\s*['"]system['"]/, what: 'the default theme preference' },
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
