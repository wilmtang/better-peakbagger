// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings.get() intentionally hides storage failures behind defaults. Keep
// every call owned here so a new privacy or preservation gate cannot silently
// adopt that fail-soft behavior.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeSources } from '../helpers/runtime-sources.mts';
import { settingsReadCounts } from '../helpers/source-policies.mts';

const FAIL_SOFT = Object.freeze({
    'photos/photos.ts': [{ count: 1, kind: 'display', reason: 'render the passive export-size warning and inherited report image width; no transport is gated by this value' }],
    'options/options.js': [{ count: 1, kind: 'display', reason: 'populate passive options controls' }],
    'options/favorites-page.js': [{ count: 1, kind: 'display', reason: 'populate the passive favorite-climbers list page' }],
    'popup/popup.ts': [{ count: 1, kind: 'display', reason: 'resolve passive popup units' }],
    'src/ascent/ascent-gaia.js': [{ count: 1, kind: 'display', reason: 'render provider buttons without reading any track data' }],
    'src/background/github-routes.js': [
        { count: 3, kind: 'display', reason: 'render connection, ascent-backup and photo-recovery status' },
        { count: 2, kind: 'safe-gate', reason: 'return connection status and gate default-off ascent snapshots' },
    ],
    'src/background/terrain-prefetch.js': [{ count: 1, kind: 'safe-gate', reason: 'default-off terrain gate' }],
    'src/favorites/climber-favorite.js': [{ count: 2, kind: 'display', reason: 'render favorite-source state' }],
    'src/maps/big-map-bridge.js': [{ count: 1, kind: 'display', reason: 'publish validated map settings' }],
    'src/maps/peak-link-order.js': [{ count: 1, kind: 'display', reason: 'restore passive planning-link order without fetching provider data' }],
    'src/maps/peak-map-bridge.js': [{ count: 1, kind: 'display', reason: 'publish validated map settings' }],
    'src/profile/profile-units.js': [{ count: 1, kind: 'display', reason: 'convert native profile readings without fetching data; defaults preserve native units' }],
    'src/reports/report-editor.ts': [{ count: 2, kind: 'display', reason: 'render editor and backup availability' }],
    'src/settings/bridge.js': [{ count: 1, kind: 'display', reason: 'publish validated analyzer settings' }],
    'src/terrain/terrain-map.ts': [{ count: 1, kind: 'safe-gate', reason: 'default-off terrain gate' }],
});

const AUTHORITATIVE = Object.freeze({
    'options/inbox.js': [{ count: 1, kind: 'privacy', reason: 'hide the inbox until the master switch is read authoritatively' }],
    'popup/popup.ts': [{ count: 1, kind: 'privacy', reason: 'hide the inbox entry until the master switch is read authoritatively' }],
    'options/garmin.js': [{ count: 1, kind: 'preservation', reason: 'populate import range controls without replacing unreadable settings with defaults' }],
    'src/garmin/garmin-badge.ts': [{ count: 1, kind: 'privacy', reason: 'keep the last accurate badge instead of drawing the queue from default settings' }],
    'options/inbox-toolbar-setting.ts': [{ count: 1, kind: 'preservation', reason: 'populate the toolbar count control without replacing unreadable settings with defaults' }],
    'src/garmin/garmin-imports.ts': [{ count: 7, kind: 'privacy', reason: 'read schedule, discovery scope and retention preferences authoritatively' }],
    'src/ascent/ascent-weather.js': [{ count: 1, kind: 'privacy', reason: 'respect the weather opt-out before summit and archive requests' }],
    'src/weather/peak-weather.js': [{ count: 1, kind: 'privacy', reason: 'respect the weather opt-out before forecast requests' }],
    'src/weather/summit-cloud.js': [{ count: 1, kind: 'privacy', reason: 'respect summit-cloud visibility and the saved model before profile requests' }],
    'src/maps/map-layer-bridge.js': [{ count: 1, kind: 'privacy', reason: 'respect the SNOTEL opt-out before viewport catalog requests' }],
    'src/snow/peak-snow.js': [{ count: 1, kind: 'privacy', reason: 'respect the SNOTEL opt-out before public snow catalog and observation requests' }],
    'src/favorites/favorite-source.js': [{ count: 1, kind: 'preservation', reason: 'resolve the selected source without substituting defaults after a failed settings read' }],
    'src/favorites/climber-hover-card.ts': [{ count: 1, kind: 'preservation', reason: 'enable favorite actions only after resolving the selected source authoritatively' }],
    'src/ascent/ascent-filter.ts': [{ count: 1, kind: 'preservation', reason: 'migrate legacy order only after an authoritative settings read' }],
    'src/ascent/ascent-delete.js': [{ count: 1, kind: 'preservation', reason: 'do not delete an ascent while cleanup settings are unreadable' }],
    'src/ascent/ascent-upload.js': [{ count: 2, kind: 'privacy', reason: 'gate local-file parsing and allowlisted fields' }],
    'src/background/background.js': [
        { count: 1, kind: 'privacy', reason: 'gate provider and local-upload capture in the worker' },
        { count: 1, kind: 'preservation', reason: 'reconcile favorites after a confirmed Buddy change using the current source and removal preference' },
    ],
    'src/background/github-routes.js': [
        { count: 3, kind: 'preservation', reason: 'keep GitHub writes and coordinated deletion fail closed on unreadable settings' },
        { count: 4, kind: 'privacy', reason: 'default-on settings, favorites and photo transfer and connection scheduling require authoritative preferences' },
    ],
    'src/background/settings-file-routes.js': [
        { count: 2, kind: 'preservation', reason: 'export and import complete authoritative settings with API keys' },
    ],
    'src/background/instagram-frames.js': [{ count: 2, kind: 'privacy', reason: 'automatic post grants require current device consent at both issue and claim' }],
    'src/reports/instagram-ui.js': [{ count: 1, kind: 'privacy', reason: 'automatic post presentation starts only after current device consent is available' }],
    'src/reports/instagram-frame.js': [{ count: 1, kind: 'preservation', reason: 'resolve the stored display theme without overwriting a newer subscription update' }],
    'src/terrain/terrain-frame.js': [{ count: 1, kind: 'privacy', reason: 'gate provider-backed renderer startup inside the frame' }],
    'src/theme/theme.js': [{ count: 1, kind: 'preservation', reason: 'reconcile the synchronous theme mirror' }],
    'src/theme/panel-theme.js': [{ count: 1, kind: 'preservation', reason: 'preserve the panel mirror on failed reconciliation' }],
    'src/ui/peak-card-layout.js': [{ count: 1, kind: 'preservation', reason: 'restore the saved card layout without treating a failed read as a new preference' }],
});

const occurrences = async (method: 'get' | 'requireCurrent') => settingsReadCounts(await runtimeSources(), method);

interface Owner {count: number; kind: string; reason: string}
const expectedCounts = (policy: Record<string, Owner[]>) => Object.fromEntries(Object.entries(policy)
    .map(([file, owners]) => [file, owners.reduce((sum, owner) => sum + owner.count, 0)]));

test('every fail-soft settings read has an explicit display or safe-gate owner', async () => {
    assert.deepEqual(await occurrences('get'), expectedCounts(FAIL_SOFT));
});

test('privacy and preservation gates use authoritative settings reads', async () => {
    assert.deepEqual(await occurrences('requireCurrent'), expectedCounts(AUTHORITATIVE));
});
