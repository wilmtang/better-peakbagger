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

test('legacy unit preferences retain their default and all measurement overrides inherit', () => {
    for (const units of ['auto', 'metric', 'imperial']) {
        const clean = Schema.clean({ units });
        assert.equal(clean.units, units);
        for (const key of Object.values(Schema.UNIT_KEYS)) assert.equal(clean[key], 'default');
        assert.deepEqual(Schema.clean(clean), clean);
    }
});

test('every unit override shares validation and invalid values inherit the default', () => {
    for (const key of Object.values(Schema.UNIT_KEYS)) {
        for (const value of ['default', 'metric', 'imperial']) assert.equal(Schema.clean({ [key]: value })[key], value);
        for (const value of [null, 'auto', 'fahrenheit', {}, [], true]) assert.equal(Schema.clean({ [key]: value })[key], 'default');
    }
    assert.deepEqual(Schema.trackUnitsPatch('metric'), { distanceUnits: 'metric', elevationUnits: 'metric' });
    assert.deepEqual(Schema.trackUnitsPatch('default'), { distanceUnits: 'default', elevationUnits: 'default' });
    assert.deepEqual(Schema.trackUnitsPatch({ temperature: 'metric' }), {});
});

test('display preferences default on, retain explicit opt-outs and reject non-booleans', () => {
    for (const key of ['showSunMoon', 'showWeather', 'showSnotel']) {
        assert.equal(Schema.DEFAULTS[key], true);
        assert.equal(Schema.clean({})[key], true);
        assert.equal(Schema.clean({ [key]: false })[key], false);
        assert.equal(Schema.clean(Schema.clean({ [key]: false }))[key], false);
        for (const value of [null, 0, 'false', [], {}]) assert.equal(Schema.clean({ [key]: value })[key], true);
    }
});

test('SNOTEL inherits legacy weather opt-outs until independently selected', () => {
    assert.equal(Schema.clean({ showWeather: false }).showSnotel, false);
    for (const showWeather of [true, false]) for (const showSnotel of [true, false]) {
        const clean = Schema.clean({ showWeather, showSnotel });
        assert.equal(clean.showWeather, showWeather); assert.equal(clean.showSnotel, showSnotel);
        assert.deepEqual(Schema.clean(clean), clean);
    }
    assert.equal(Schema.clean({ showWeather: false, showSnotel: 'true' }).showSnotel, false);
});

test('peak-card layout uses bounded identities and independent boolean disclosures', async () => {
    const clean = Schema.clean({ peakCardOrder: ['snow', 'unknown', 'snow', 'weather'], peakSunCollapsed: true, peakSnowCollapsed: 'true' });
    assert.deepEqual(clean.peakCardOrder, ['snow', 'weather', 'sun']);
    assert.equal(clean.peakSunCollapsed, true); assert.equal(clean.peakSnowCollapsed, false);
    assert.deepEqual(Schema.clean(clean), clean);
    assert.notEqual(Schema.clean({}).peakCardOrder, Schema.DEFAULTS.peakCardOrder);
    for (const key of ['peakSunCollapsed', 'peakWeatherCollapsed', 'peakSnowCollapsed']) {
        assert.equal(Schema.clean({ [key]: true })[key], true);
        for (const value of [null, 0, 'false', [], {}]) assert.equal(Schema.clean({ [key]: value })[key], Schema.DEFAULTS[key]);
    }
    const consumer = await readFile(path.join(root, 'src/ui/peak-card-layout.js'), 'utf8');
    assert.match(consumer, /settings\.DEFAULTS\.peakCardOrder/);
    assert.doesNotMatch(consumer, /\[['"]sun['"],\s*['"]weather['"],\s*['"]snow['"]\]/, 'layout defaults belong only to the schema');
});

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

test('automatic settings backup defaults on, preserves opt-outs, and is independent of ascent and TR backup', () => {
    assert.equal(Schema.DEFAULTS.autoSettingsBackup, true);
    assert.equal(Schema.clean({}).autoSettingsBackup, true);
    assert.equal(Schema.clean({
        enableGithubBackup: false,
        autoSettingsBackup: true
    }).autoSettingsBackup, true);
    assert.equal(Schema.clean({ autoSettingsBackup: 'yes' }).autoSettingsBackup, true);
    assert.equal(Schema.clean({ autoSettingsBackup: false }).autoSettingsBackup, false);
});

test('enabling ascent backup also enables automatic saves, including legacy manual-only settings', () => {
    assert.equal(Schema.clean({ enableGithubBackup: true }).autoGithubBackup, true);
    assert.equal(Schema.clean({ enableGithubBackup: true, autoGithubBackup: false }).autoGithubBackup, true);
    assert.equal(Schema.clean({ enableGithubBackup: false, autoGithubBackup: true }).autoGithubBackup, false);
});

test('automatic favorites backup defaults on, preserves opt-outs, and is independent of ascent and TR backup', () => {
    assert.equal(Schema.DEFAULTS.autoFavoritesBackup, true);
    assert.equal(Schema.clean({}).autoFavoritesBackup, true);
    assert.equal(Schema.clean({
        enableGithubBackup: false,
        autoFavoritesBackup: true
    }).autoFavoritesBackup, true);
    assert.equal(Schema.clean({ autoFavoritesBackup: false }).autoFavoritesBackup, false);
    assert.equal(Schema.clean({ autoFavoritesBackup: 'yes' }).autoFavoritesBackup, true);
});

test('automatic photo-library metadata backup defaults on, preserves opt-outs, and is independent of ascent and TR backup', () => {
    assert.equal(Schema.DEFAULTS.autoPhotoLibraryBackup, true);
    assert.equal(Schema.clean({}).autoPhotoLibraryBackup, true);
    assert.equal(Schema.clean({
        enableGithubBackup: false,
        autoPhotoLibraryBackup: true
    }).autoPhotoLibraryBackup, true);
    assert.equal(Schema.clean({ autoPhotoLibraryBackup: 'yes' }).autoPhotoLibraryBackup, true);
    assert.equal(Schema.clean({ autoPhotoLibraryBackup: false }).autoPhotoLibraryBackup, false);
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
        { pattern: /\b(?:showSunMoon|showWeather|showSnotel)\s*:\s*(?:true|false)\b/, what: 'a section display default' },
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

test('provider and filter lists validate duplicates, unknown IDs, and explicit all-off', () => {
    const clean = Schema.clean({ mapProviderOrder: ['caltopo', 'caltopo', 'unknown'], mapProvidersEnabled: [], betaPeakFilterOrder: ['beta', 'gps', 'bad', 'gps'] });
    assert.deepEqual(clean.mapProviderOrder, ['caltopo', 'gaia', 'onx', 'alltrails']);
    assert.deepEqual(clean.mapProvidersEnabled, []);
    assert.deepEqual(clean.betaPeakFilterOrder, ['beta', 'gps', 'fav', 'tr', 'link']);
    assert.equal(clean.betaPersonalFilterOrder, null);
    assert.deepEqual(Schema.clean(clean), clean);
    assert.deepEqual(Schema.clean({}).mapProvidersEnabled, Schema.MAP_PROVIDERS);
    assert.notEqual(Schema.clean({}).mapProviderOrder, Schema.DEFAULTS.mapProviderOrder);
});

test('planning link order removes unknown and duplicate IDs and fills missing slots', () => {
    const clean = Schema.clean({ peakLinkOrder: ['avalanche', 'unknown', 'windy', 'windy', 'avalanche-2'] });
    assert.deepEqual(clean.peakLinkOrder, ['avalanche', 'windy', 'avalanche-2', 'copernicus', 'airnow',
        'avalanche-3', 'avalanche-4', 'avalanche-5', 'avalanche-6', 'avalanche-7', 'avalanche-8']);
    assert.deepEqual(Schema.clean(clean), clean);
    assert.deepEqual(Schema.clean({ peakLinkOrder: 'windy' }).peakLinkOrder, Schema.PEAK_LINK_ORDER);
    assert.notEqual(Schema.clean({}).peakLinkOrder, Schema.DEFAULTS.peakLinkOrder);
});
