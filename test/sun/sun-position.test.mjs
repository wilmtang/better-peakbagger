// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountainTime as MountainTime } from '../../src/time/mountain-time.js';
import { sunPosition as SunPosition } from '../../src/sun/sun-position.js';

test('SunCalc 2 reference position and rise/set vector stays north-based and degree-valued', () => {
    const zone = MountainTime.resolve(50.5, 30.5);
    const result = SunPosition.calculate({
        lat: 50.5,
        lon: 30.5,
        ms: Date.parse('2013-03-05T00:00:00Z'),
        date: '2013-03-05',
        zone,
    });
    assert.ok(Math.abs(result.azimuthDeg - 36.9471) < 0.001);
    assert.ok(Math.abs(result.elevationDeg - -39.4655) < 0.001);
    assert.equal(result.directionLabel, 'NE');
    assert.equal(result.isAboveHorizon, false);
    assert.ok(Math.abs(result.sunriseMs - Date.parse('2013-03-05T04:33:31.186Z')) < 1000);
    assert.ok(Math.abs(result.sunsetMs - Date.parse('2013-03-05T15:46:19.732Z')) < 1000);
});

test('16-point directions cover cardinal quadrants and screen bearing wraps across north', () => {
    assert.deepEqual([0, 90, 180, 270].map(SunPosition.directionLabel), ['N', 'E', 'S', 'W']);
    assert.deepEqual([45, 135, 225, 315].map(SunPosition.directionLabel), ['NE', 'SE', 'SW', 'NW']);
    assert.equal(SunPosition.normalizeDegrees(1 - 359), 2);
    assert.equal(SunPosition.normalizeDegrees(359 - 1), 358);

    const zone = MountainTime.resolve(0, 0);
    const result = SunPosition.calculate({
        lat: 0, lon: 0, ms: Date.parse('2026-06-21T12:00:00Z'),
        date: '2026-06-21', zone, mapBearing: 359,
    });
    assert.ok(Math.abs(result.screenAzimuthDeg - 2.06095) < 0.001);
    assert.equal(result.isAboveHorizon, true);
});

test('polar day and night report absent events without inventing rise or set times', () => {
    const zone = MountainTime.resolve(78.2232, 15.6469);
    const summer = SunPosition.calculate({
        lat: 78.2232, lon: 15.6469, ms: Date.parse('2026-06-21T12:00:00Z'),
        date: '2026-06-21', zone,
    });
    const winter = SunPosition.calculate({
        lat: 78.2232, lon: 15.6469, ms: Date.parse('2026-12-21T12:00:00Z'),
        date: '2026-12-21', zone,
    });
    assert.deepEqual([summer.daylightState, summer.sunriseMs, summer.sunsetMs], ['polar-day', null, null]);
    assert.deepEqual([winter.daylightState, winter.sunriseMs, winter.sunsetMs], ['polar-night', null, null]);
});

test('date-line solar events are constrained to the requested local civil date', () => {
    const zone = MountainTime.resolve(1.8721, -157.4278);
    const instant = MountainTime.civilToInstant(zone, '2026-01-02', 12 * 60);
    const result = SunPosition.calculate({
        lat: 1.8721, lon: -157.4278, ms: instant.ms, date: '2026-01-02', zone,
    });
    assert.equal(MountainTime.localDate(zone, result.sunriseMs), '2026-01-02');
    assert.equal(MountainTime.localDate(zone, result.sunsetMs), '2026-01-02');
});

test('solar calculation rejects malformed coordinates, instants, package output, and adjacent-day events', () => {
    const zone = MountainTime.resolve(0, 0);
    assert.equal(SunPosition.calculate({ lat: 91, lon: 0, ms: 0, date: '1970-01-01', zone }), null);
    assert.equal(SunPosition.calculate({ lat: 0, lon: 0, ms: Number.NaN, date: '1970-01-01', zone }), null);
    assert.equal(SunPosition.calculate({
        lat: 0, lon: 0, ms: 0, date: '1970-01-01', zone,
        sunCalc: { getPosition: () => ({ azimuth: Number.NaN, altitude: 1 }), getTimes: () => ({}) },
    }), null);
    assert.equal(SunPosition.calculate({
        lat: 0, lon: 0, ms: 0, date: '1970-01-01', zone,
        sunCalc: {
            getPosition: () => ({ azimuth: 90, altitude: -1 }),
            getTimes: () => ({
                sunrise: new Date('1970-01-02T06:00:00Z'),
                sunset: new Date('1970-01-02T18:00:00Z'),
            }),
        },
    }), null);
});
