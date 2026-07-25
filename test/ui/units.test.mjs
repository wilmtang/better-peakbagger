// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { units as Units } from '../../src/ui/units.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('unit constants are exact', () => {
    assert.equal(Units.FEET_PER_METER, 3.28084);
    assert.equal(Units.METERS_PER_MILE, 1609.344);
    assert.equal(Units.feetFromMeters(100).toFixed(3), '328.084');
    assert.equal(Units.milesFromMeters(1609.344), 1);
});

test('an explicit preference wins over whatever the page shows', () => {
    const metricPage = () => Units.METRIC;
    const imperialPage = () => Units.IMPERIAL;
    assert.equal(Units.resolveUnits({ units: 'metric' }, imperialPage), 'metric');
    assert.equal(Units.resolveUnits({ units: 'imperial' }, metricPage), 'imperial');
});

test('auto defers to the surface’s own page probe', () => {
    assert.equal(Units.resolveUnits({ units: 'auto' }, () => Units.METRIC), 'metric');
    assert.equal(Units.resolveUnits({ units: 'auto' }, () => Units.IMPERIAL), 'imperial');
});

test('auto falls back to imperial when no probe can answer', () => {
    // The popup has no page to sniff, and a probe may also be inconclusive.
    assert.equal(Units.resolveUnits({ units: 'auto' }), 'imperial');
    assert.equal(Units.resolveUnits({ units: 'auto' }, () => null), 'imperial');
    assert.equal(Units.resolveUnits({ units: 'auto' }, () => 'nonsense'), 'imperial');
    assert.equal(Units.resolveUnits(null), 'imperial');
    assert.equal(Units.resolveUnits({}), 'imperial');
});

test('display strings match what each surface used to produce on its own', () => {
    assert.equal(Units.formatDistance(1609.344, 'imperial'), '1.0 mi');
    assert.equal(Units.formatDistance(1000, 'metric'), '1.0 km');
    assert.equal(Units.formatElevation(100, 'metric'), '100 m');
    assert.equal(Units.formatElevation(100, 'imperial'), '328 ft');
    assert.equal(Units.formatApproach(30, 'metric'), '30 m');
    assert.equal(Units.formatApproach(30, 'imperial'), '98 ft');
});

test('the conversion constants are declared in exactly one module', async () => {
    // They were redeclared in four. Running on different pages is why a
    // divergence could ship unnoticed, so the guard is structural, not a
    // comparison of two implementations that cannot currently disagree.
    const walk = async directory => {
        const entries = await readdir(directory, { withFileTypes: true });
        const files = await Promise.all(entries.map(async entry => {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) return walk(full);
            return entry.name.endsWith('.js') ? [full] : [];
        }));
        return files.flat();
    };

    const sources = await walk(path.join(root, 'src'));
    const pageSources = ['popup/popup.js', 'options/options.js', 'options/drafts.js',
        'options/favorites.js', 'options/github.js', 'options/settings-backup.js']
        .map(relative => path.join(root, relative));

    const offenders = [];
    for (const file of [...sources, ...pageSources]) {
        if (file.endsWith(path.join('src', 'ui', 'units.js'))) continue;
        const text = await readFile(file, 'utf8');
        if (/3\.28084|1609\.344/.test(text)) offenders.push(path.relative(root, file));
    }
    assert.deepEqual(offenders, [],
        'these modules hardcode a conversion constant instead of importing src/ui/units.js');
});

test('no surface reimplements the auto-units preference logic', async () => {
    // Two unrelated heuristics used to resolve `auto`. Page *detection* still
    // belongs to the surface that owns the page; the preference logic around it
    // does not.
    for (const relative of ['src/ascent/ascent-upload.js', 'src/gpx/gpx-analyzer.js']) {
        const text = await readFile(path.join(root, relative), 'utf8');
        assert.match(text, /Units\.resolveUnits\(/,
            `${relative} must resolve units through the shared module`);
        assert.doesNotMatch(
            text,
            /units === 'metric' \|\| [\w.]*units === 'imperial'/,
            `${relative} must not re-derive the explicit-preference branch`
        );
    }
});
