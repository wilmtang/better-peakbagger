// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings.get() intentionally hides storage failures behind defaults. Keep
// every call owned here so a new privacy or preservation gate cannot silently
// adopt that fail-soft behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const FAIL_SOFT = Object.freeze({
    'options/options.js': [{ count: 1, kind: 'display', reason: 'populate passive options controls' }],
    'options/favorites-page.js': [{ count: 1, kind: 'display', reason: 'populate the passive favorite-climbers list page' }],
    'popup/popup.js': [{ count: 1, kind: 'display', reason: 'resolve passive popup units' }],
    'src/ascent/ascent-filter.js': [{ count: 1, kind: 'display', reason: 'render filter preferences' }],
    'src/background/github-routes.js': [
        { count: 9, kind: 'safe-gate', reason: 'status and default-off GitHub and photo-recovery gates' },
        { count: 1, kind: 'display', reason: 'render the default-off photo-recovery status' },
    ],
    'src/background/terrain-prefetch.js': [{ count: 1, kind: 'safe-gate', reason: 'default-off terrain gate' }],
    'src/favorites/climber-favorite.js': [{ count: 2, kind: 'display', reason: 'render favorite-source state' }],
    'src/maps/big-map-bridge.js': [{ count: 1, kind: 'display', reason: 'publish validated map settings' }],
    'src/maps/peak-map-bridge.js': [{ count: 1, kind: 'display', reason: 'publish validated map settings' }],
    'src/reports/report-editor.js': [{ count: 2, kind: 'display', reason: 'render editor and backup availability' }],
    'src/settings/bridge.js': [{ count: 1, kind: 'display', reason: 'publish validated analyzer settings' }],
    'src/terrain/terrain-map.js': [{ count: 1, kind: 'safe-gate', reason: 'default-off terrain gate' }],
    'src/theme/panel-theme.js': [{ count: 1, kind: 'display', reason: 'paint passive panel theme' }],
});

const AUTHORITATIVE = Object.freeze({
    'src/ascent/ascent-delete.js': [{ count: 1, kind: 'preservation', reason: 'do not delete an ascent while cleanup settings are unreadable' }],
    'src/ascent/ascent-upload.js': [{ count: 1, kind: 'privacy', reason: 'gate local-file parsing and allowlisted fields' }],
    'src/background/background.js': [{ count: 1, kind: 'privacy', reason: 'gate provider and local-upload capture in the worker' }],
    'src/background/github-routes.js': [
        { count: 3, kind: 'preservation', reason: 'keep GitHub writes and coordinated deletion fail closed on unreadable settings' },
    ],
    'src/background/settings-file-routes.js': [
        { count: 2, kind: 'preservation', reason: 'export and import complete authoritative settings with API keys' },
    ],
    'src/terrain/terrain-frame.js': [{ count: 1, kind: 'privacy', reason: 'gate provider-backed renderer startup inside the frame' }],
    'src/theme/theme.js': [{ count: 1, kind: 'preservation', reason: 'reconcile the synchronous theme mirror' }],
});

const sourceFiles = async directory => {
    const files = [];
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await sourceFiles(relative));
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
    }
    return files;
};

const occurrences = async method => {
    const found = {};
    const expression = new RegExp(`\\b(?:Settings|S|settings|photoBackupSettings)\\.${method}\\(`, 'g');
    for (const file of await Promise.all(['src', 'options', 'popup'].map(sourceFiles)).then(groups => groups.flat())) {
        const source = await readFile(path.join(root, file), 'utf8');
        const count = (source.match(expression) || []).length;
        if (count) found[file] = count;
    }
    return found;
};

const expectedCounts = policy => Object.fromEntries(Object.entries(policy)
    .map(([file, owners]) => [file, owners.reduce((sum, owner) => sum + owner.count, 0)]));

test('every fail-soft settings read has an explicit display or safe-gate owner', async () => {
    assert.deepEqual(await occurrences('get'), expectedCounts(FAIL_SOFT));
});

test('privacy and preservation gates use authoritative settings reads', async () => {
    assert.deepEqual(await occurrences('requireCurrent'), expectedCounts(AUTHORITATIVE));
});
