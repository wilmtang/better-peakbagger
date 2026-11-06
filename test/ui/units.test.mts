// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { units as Units } from '../../src/ui/units.js';

import { runtimeSources } from '../helpers/runtime-sources.mts';
import { unitConstantFindings } from '../helpers/source-policies.mts';

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

test('measurement overrides win independently and inherit a changed default', () => {
    const mixed = { units: 'imperial', temperatureUnits: 'metric', precipitationUnits: 'metric', elevationUnits: 'metric' };
    assert.equal(Units.resolveUnits(mixed, null, 'distance'), 'imperial');
    assert.equal(Units.resolveUnits(mixed, null, 'elevation'), 'metric');
    assert.equal(Units.resolveUnits(mixed, null, 'temperature'), 'metric');
    assert.equal(Units.resolveUnits(mixed, null, 'precipitation'), 'metric');
    assert.equal(Units.resolveUnits(mixed, null, 'wind'), 'imperial');
    assert.equal(Units.resolveUnits({ ...mixed, units: 'metric' }, null, 'distance'), 'metric');
    assert.equal(Units.resolveUnits({ units: 'auto', temperatureUnits: 'imperial' }, () => 'metric', 'temperature'), 'imperial');
    assert.equal(Units.resolveUnits({ units: 'auto', distanceUnits: 'invalid' }, () => 'metric', 'distance'), 'metric');
});

test('weather formatting converts canonical values with measurement-specific precision', () => {
    assert.equal(Units.formatWeather(9, 'temperature', 'metric'), '9°C');
    assert.equal(Units.formatWeather(9, 'temperature', 'imperial'), '48°F');
    assert.equal(Units.formatWeather(-4, 'temperature', 'metric'), '−4°C');
    assert.equal(Units.formatWeather(4.2, 'precipitation', 'metric'), '4.2 mm');
    assert.equal(Units.formatWeather(4.2, 'precipitation', 'imperial'), '0.17 in');
    assert.equal(Units.formatWeather(16, 'wind', 'metric'), '16 km/h');
    assert.equal(Units.formatWeather(16, 'wind', 'imperial'), '10 mph');
    assert.equal(Units.formatWeather(null, 'temperature', 'metric'), '—');
});

test('cloud percentages never receive an imperial wind conversion', () => {
    for (const system of ['metric', 'imperial']) {
        assert.equal(Units.formatWeather(0, 'cloud', system), '0%');
        assert.equal(Units.formatWeather(62.5, 'cloud', system), '63%');
        assert.equal(Units.formatWeather(100, 'cloud', system), '100%');
        assert.equal(Units.formatWeather(null, 'cloud', system), '—');
    }
});

test('freezing altitude uses its canonical elevation units', () => {
    assert.equal(Units.formatWeather(1000, 'freezing', 'imperial'), '3281 ft');
    assert.equal(Units.formatWeather(1000, 'freezing', 'metric'), '1000 m');
    assert.equal(Units.formatWeather(null, 'freezing', 'metric'), '—');
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
    const sources = await runtimeSources();
    assert.ok(sources.length >= 15, 'expected the authored runtime module set');
    assert.deepEqual(sources.flatMap(unitConstantFindings), []);
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
