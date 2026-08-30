// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountainTime as MountainTime } from '../../src/time/mountain-time.js';
import { sunPosition as SunPosition } from '../../src/sun/sun-position.js';

test('SunCalc 2 reference Sun and Moon vector stays north-based and degree-valued', () => {
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
    assert.ok(Number.isFinite(result.sunriseAzimuthDeg));
    assert.ok(Number.isFinite(result.solarNoonAzimuthDeg));
    assert.ok(Number.isFinite(result.sunsetAzimuthDeg));
    assert.equal(result.sunriseDayRelation, 'same-day');
    assert.equal(result.sunsetDayRelation, 'same-day');
    assert.ok(Math.abs(result.moonIlluminationFraction - 0.4911928) < 0.000001);
    assert.ok(Math.abs(result.moonPhase - 0.7528036) < 0.000001);
    assert.equal(result.moonPhaseIndex, 6);
    assert.equal(result.moonPhaseLabel, 'Last Quarter');
    assert.ok(Math.abs(result.moonAzimuthDeg - 124.6408) < 0.001);
    assert.ok(Math.abs(result.moonElevationDeg - 0.4567) < 0.001);
    assert.equal(result.moonDirectionLabel, 'SE');
    assert.equal(result.moonIsAboveHorizon, true);
    assert.equal(result.moonVisibilityState, 'ordinary');
    assert.ok(Math.abs(result.moonriseMs - Date.parse('2013-03-04T23:53:32.854Z')) < 1000);
    assert.ok(Math.abs(result.moonsetMs - Date.parse('2013-03-05T08:37:04.315Z')) < 1000);
    assert.ok(Number.isFinite(result.moonriseAzimuthDeg));
    assert.ok(Number.isFinite(result.moonVisibleMidpointAzimuthDeg));
    assert.ok(Number.isFinite(result.moonsetAzimuthDeg));
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
    assert.ok(Math.abs(result.moonScreenAzimuthDeg - 90.95069) < 0.001);
    assert.equal(result.isAboveHorizon, true);
});

test('Moon phases use the nearest eighth and reject values outside the package contract', () => {
    assert.deepEqual([
        0, 0.124, 0.25, 0.374, 0.5, 0.624, 0.75, 0.874, 1,
    ].map(SunPosition.moonPhaseLabel), [
        'New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
        'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent', 'New Moon',
    ]);
    assert.deepEqual([
        Number.NaN, -0.01, 1.01,
    ].map(SunPosition.moonPhaseLabel), [null, null, null]);
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

test('daily events follow the requested local solar noon across zones and adjacent-day crossings', () => {
    const vectors = [
        ['Aoraki', -43.595, 170.141, '2026-01-01', 6 * 60 + 1, 21 * 60 + 23, 'same-day'],
        ['Denali', 63.0695, -151.0074, '2026-06-21', 3 * 60 + 55, 16, 'next-day'],
        ['Kiritimati', 1.8721, -157.4278, '2026-01-02', 6 * 60 + 32, 18 * 60 + 34, 'same-day'],
        ['Chatham', -43.95, -176.55, '2026-01-02', 5 * 60 + 52, 21 * 60 + 16, 'same-day'],
        ['Denver', 39.7392, -104.9903, '2026-07-10', 5 * 60 + 41, 20 * 60 + 29, 'same-day'],
    ];
    for (const [name, lat, lon, date, sunriseMinute, sunsetMinute, sunsetRelation] of vectors) {
        const zone = MountainTime.resolve(lat, lon);
        const instant = MountainTime.civilToInstant(zone, date, 12 * 60);
        const result = SunPosition.calculate({ lat, lon, ms: instant.ms, date, zone });
        assert.equal(MountainTime.localDate(zone, result.solarNoonMs), date, `${name} solar noon`);
        assert.equal(MountainTime.localMinute(zone, result.sunriseMs), sunriseMinute, `${name} sunrise`);
        assert.equal(MountainTime.localMinute(zone, result.sunsetMs), sunsetMinute, `${name} sunset`);
        assert.equal(result.sunriseDayRelation, 'same-day', `${name} sunrise relation`);
        assert.equal(result.sunsetDayRelation, sunsetRelation, `${name} sunset relation`);
        assert.equal(result.sunriseDate, date, `${name} sunrise date`);
        assert.equal(result.sunsetDate, sunsetRelation === 'next-day'
            ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
            : date, `${name} sunset date`);
    }
});

test('Moon visibility returns every rise-to-set interval that overlaps the mountain-local day', () => {
    const vectors = [
        ['Kyiv', 50.5, 30.5, '2013-03-05', 113, 637, 'same-day'],
        ['Denver', 39.7392, -104.9903, '2026-07-10', 93, 1023, 'same-day'],
        ['Denali', 63.0695, -151.0074, '2026-06-21', 863, 98, 'next-day'],
    ];
    for (const [name, lat, lon, date, riseMinute, setMinute, setRelation] of vectors) {
        const zone = MountainTime.resolve(lat, lon);
        const instant = MountainTime.civilToInstant(zone, date, 12 * 60);
        const result = SunPosition.calculate({ lat, lon, ms: instant.ms, date, zone });
        assert.equal(result.moonVisibilityState, 'ordinary', `${name} visibility state`);
        assert.ok(result.moonVisibilityIntervals.length >= 1, `${name} overlapping intervals`);
        assert.equal(MountainTime.localMinute(zone, result.moonriseMs), riseMinute,
            `${name} moonrise`);
        assert.equal(MountainTime.localMinute(zone, result.moonsetMs), setMinute,
            `${name} moonset`);
        assert.equal(result.moonriseDayRelation, 'same-day', `${name} moonrise relation`);
        assert.equal(result.moonsetDayRelation, setRelation, `${name} moonset relation`);
    }
});

test('a two-interval Denver date selects the active or upcoming Moon band without a midday gap', () => {
    const lat = 39.7392;
    const lon = -104.9903;
    const date = '2026-08-26';
    const zone = MountainTime.resolve(lat, lon);
    const calculateAt = minute => {
        const instant = MountainTime.civilToInstant(zone, date, minute);
        return SunPosition.calculate({ lat, lon, date, zone, ms: instant.ms });
    };
    const early = calculateAt(2 * 60);
    const gap = calculateAt(12 * 60);
    const late = calculateAt(21 * 60);

    for (const result of [early, gap, late]) {
        assert.equal(result.moonVisibilityState, 'ordinary');
        assert.equal(result.moonVisibilityIntervals.length, 2);
    }
    assert.deepEqual([
        early.moonVisibilityIntervalIndex, early.moonVisibilitySelection,
        early.moonriseDayRelation, early.moonsetDayRelation,
    ], [0, 'active', 'previous-day', 'same-day']);
    assert.deepEqual([
        gap.moonVisibilityIntervalIndex, gap.moonVisibilitySelection,
        gap.moonriseDayRelation, gap.moonsetDayRelation,
    ], [1, 'upcoming', 'same-day', 'next-day']);
    assert.deepEqual([
        late.moonVisibilityIntervalIndex, late.moonVisibilitySelection,
        late.moonriseDayRelation, late.moonsetDayRelation,
    ], [1, 'active', 'same-day', 'next-day']);
    assert.equal(MountainTime.localMinute(zone, early.moonsetMs), 4 * 60 + 40);
    assert.equal(MountainTime.localMinute(zone, gap.moonriseMs), 19 * 60 + 5);
});

test('Moon visibility distinguishes polar always-up and always-down dates', () => {
    const lat = 78.2232;
    const lon = 15.6469;
    const zone = MountainTime.resolve(lat, lon);
    const stateFor = date => {
        const instant = MountainTime.civilToInstant(zone, date, 12 * 60);
        return SunPosition.calculate({ lat, lon, date, zone, ms: instant.ms });
    };
    assert.deepEqual([
        stateFor('2026-01-01').moonVisibilityState,
        stateFor('2026-01-15').moonVisibilityState,
    ], ['always-up', 'always-down']);
});

test('Moon interval overlap survives the international date line', () => {
    for (const [name, lat, lon] of [
        ['Kiritimati', 1.8721, -157.4278],
        ['Chatham', -43.95, -176.55],
    ]) {
        const date = '2026-01-02';
        const zone = MountainTime.resolve(lat, lon);
        const instant = MountainTime.civilToInstant(zone, date, 12 * 60);
        const result = SunPosition.calculate({ lat, lon, date, zone, ms: instant.ms });
        assert.equal(result.moonVisibilityState, 'ordinary', name);
        assert.equal(result.moonVisibilityIntervals.length, 2, name);
        assert.equal(result.moonriseDate, date, name);
        assert.equal(result.moonsetDayRelation, 'next-day', name);
    }
});

test('solar calculation rejects malformed primary inputs but preserves position without trustworthy events', () => {
    const zone = MountainTime.resolve(0, 0);
    assert.equal(SunPosition.calculate({ lat: 91, lon: 0, ms: 0, date: '1970-01-01', zone }), null);
    assert.equal(SunPosition.calculate({ lat: 0, lon: 0, ms: Number.NaN, date: '1970-01-01', zone }), null);
    assert.equal(SunPosition.calculate({
        lat: 0, lon: 0, ms: 0, date: '1970-01-01', zone,
        sunCalc: { getPosition: () => ({ azimuth: Number.NaN, altitude: 1 }), getTimes: () => ({}) },
    }), null);
    const malformedEvents = SunPosition.calculate({
        lat: 0, lon: 0, ms: 0, date: '1970-01-01', zone,
        sunCalc: {
            getPosition: () => ({ azimuth: 90, altitude: -1 }),
            getTimes: () => ({ solarNoon: new Date(Number.NaN) }),
        },
    });
    assert.equal(malformedEvents.azimuthDeg, 90);
    assert.equal(malformedEvents.daylightState, 'unavailable');
    assert.equal(malformedEvents.sunriseMs, null);
    assert.equal(malformedEvents.sunriseAzimuthDeg, null);
    assert.equal(malformedEvents.sunsetMs, null);
    assert.equal(malformedEvents.sunsetAzimuthDeg, null);
    assert.equal(malformedEvents.moonAzimuthDeg, null);
    assert.equal(malformedEvents.moonPhaseLabel, null);
    assert.equal(malformedEvents.moonVisibilityState, 'unavailable');

    const malformedMoon = SunPosition.calculate({
        lat: 0, lon: 0, ms: 0, date: '1970-01-01', zone,
        sunCalc: {
            getPosition: () => ({ azimuth: 90, altitude: -1 }),
            getTimes: () => ({
                solarNoon: new Date('1970-01-01T12:00:00Z'),
                sunrise: new Date('1970-01-01T06:00:00Z'),
                sunset: new Date('1970-01-01T18:00:00Z'),
            }),
            getMoonPosition: () => ({ azimuth: 225, altitude: -5 }),
            getMoonIllumination: () => ({ fraction: Number.NaN, phase: 0.5 }),
        },
    });
    assert.equal(malformedMoon.azimuthDeg, 90);
    assert.equal(malformedMoon.moonAzimuthDeg, 225);
    assert.equal(malformedMoon.moonElevationDeg, -5);
    assert.equal(malformedMoon.moonIsAboveHorizon, false);
    assert.equal(malformedMoon.moonPhaseLabel, null,
        'malformed illumination must not erase a finite Moon position');

    const malformedMoonPosition = SunPosition.calculate({
        lat: 0, lon: 0, ms: 0, date: '1970-01-01', zone,
        sunCalc: {
            getPosition: () => ({ azimuth: 90, altitude: -1 }),
            getTimes: () => ({
                solarNoon: new Date('1970-01-01T12:00:00Z'),
                sunrise: new Date('1970-01-01T06:00:00Z'),
                sunset: new Date('1970-01-01T18:00:00Z'),
            }),
            getMoonPosition: () => ({ azimuth: Number.NaN, altitude: 12 }),
            getMoonIllumination: () => ({ fraction: 1, phase: 0.5 }),
        },
    });
    assert.equal(malformedMoonPosition.azimuthDeg, 90);
    assert.equal(malformedMoonPosition.moonAzimuthDeg, null);
    assert.equal(malformedMoonPosition.moonPhaseLabel, 'Full Moon',
        'malformed Moon position must not erase finite illumination metadata');
});

test('event search is bounded and rejects cycles whose solar noon belongs to another date', () => {
    const zone = MountainTime.resolve(0, 0);
    let calls = 0;
    const result = SunPosition.calculate({
        lat: 0, lon: 0, ms: 0, date: '1970-01-01', zone,
        sunCalc: {
            getPosition: () => ({ azimuth: 90, altitude: -1 }),
            getTimes: () => {
                calls++;
                return {
                    solarNoon: new Date('1970-01-10T12:00:00Z'),
                    sunrise: new Date('1970-01-10T06:00:00Z'),
                    sunset: new Date('1970-01-10T18:00:00Z'),
                };
            },
        },
    });
    assert.equal(calls, 5);
    assert.equal(result.daylightState, 'unavailable');
    assert.equal(result.azimuthDeg, 90);
});

test('Moon event search is bounded and its failure does not erase valid Sun events', () => {
    const zone = MountainTime.resolve(0, 0);
    let calls = 0;
    const result = SunPosition.calculate({
        lat: 0, lon: 0, ms: 0, date: '1970-01-01', zone,
        sunCalc: {
            getPosition: () => ({ azimuth: 90, altitude: -1 }),
            getTimes: () => ({
                solarNoon: new Date('1970-01-01T12:00:00Z'),
                sunrise: new Date('1970-01-01T06:00:00Z'),
                sunset: new Date('1970-01-01T18:00:00Z'),
            }),
            getMoonPosition: () => ({ azimuth: 225, altitude: -5 }),
            getMoonTimes: () => {
                calls++;
                if (calls === 3) throw new Error('malformed Moon event source');
                return {};
            },
        },
    });
    assert.equal(calls, 3);
    assert.equal(result.daylightState, 'ordinary');
    assert.equal(result.moonVisibilityState, 'unavailable');
    assert.equal(result.sunriseMs, Date.parse('1970-01-01T06:00:00Z'));
});
