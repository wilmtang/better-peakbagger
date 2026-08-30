// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountainTime as MountainTime } from '../../src/time/mountain-time.js';
import { sunState as SunState } from '../../src/sun/sun-state.js';

const resultFor = ({ mapBearing = 0 } = {}) => Object.freeze({
    azimuthDeg: 1,
    directionLabel: 'N',
    elevationDeg: 20,
    isAboveHorizon: true,
    screenAzimuthDeg: ((1 - mapBearing) % 360 + 360) % 360,
    moonAzimuthDeg: 271,
    moonDirectionLabel: 'W',
    moonElevationDeg: 12,
    moonIsAboveHorizon: true,
    moonScreenAzimuthDeg: ((271 - mapBearing) % 360 + 360) % 360,
    sunriseMs: 1,
    sunsetMs: 2,
    daylightState: 'ordinary',
    moonIlluminationFraction: 0.72,
    moonPhase: 0.34,
    moonPhaseIndex: 3,
    moonPhaseLabel: 'Waxing Gibbous',
});

test('Peak state defaults in mountain time and date/time changes do not change its subject', () => {
    const state = SunState.create({ calculate: resultFor });
    const zone = MountainTime.resolve(39.7392, -104.9903);
    state.setPeakSubject({
        lat: 39.7392, lon: -104.9903, zone, nowMs: Date.parse('2026-07-10T06:30:00Z'),
    });
    assert.deepEqual(state.get().subject, { lat: 39.7392, lon: -104.9903 });
    assert.equal(state.get().date, '2026-07-10');
    assert.equal(state.get().minute, 30);
    assert.equal(state.get().availability, 'ready');

    const subject = state.get().subject;
    state.setPeakDate('2026-07-11');
    state.setPreviewMinute(13 * 60 + 15);
    assert.equal(state.get().subject, subject);
    assert.deepEqual([state.get().date, state.get().minute], ['2026-07-11', 13 * 60 + 15]);
});

test('timed, untimed, and partial route points follow strict point provenance', () => {
    const calls = [];
    const state = SunState.create({ calculate: input => { calls.push(input); return resultFor(input); } });
    const zone = MountainTime.resolve(48.7, -121.8);
    const recordedMs = Date.parse('2026-07-10T12:34:00Z');

    state.selectRoutePoint({
        lat: 48.7, lon: -121.8, ms: recordedMs, timeState: 'valid', routeIdentity: 'timed',
    }, '2026-07-09', zone);
    assert.deepEqual([state.get().dateSource, state.get().timeSource], [
        'GPX point', 'Recorded at selected GPX point',
    ]);
    assert.equal(state.get().instant.ms, recordedMs);

    state.setPreviewMinute(9 * 60);
    state.selectRoutePoint({
        lat: 48.71, lon: -121.81, ms: recordedMs + 60_000, timeState: 'missing', routeIdentity: 'untimed',
    }, '2026-07-09', zone);
    assert.equal(state.get().minute, 9 * 60, 'an untimed point retains the current preview clock');
    assert.deepEqual([state.get().date, state.get().dateSource, state.get().timeSource], [
        '2026-07-09', 'Peakbagger ascent date', 'Preview time',
    ]);

    state.selectRoutePoint({
        lat: 48.72, lon: -121.82, ms: recordedMs + 120_000, timeState: 'invalid', routeIdentity: 'invalid',
    }, '2026', zone);
    assert.equal(state.get().unavailable, 'No track or ascent date is available.');
    assert.equal(state.get().result, null);
    assert.equal(state.get().availability, 'prompt');
    assert.equal(calls.at(-1).lat, 48.71, 'an unavailable point must not run a stale calculation');
});

test('valid Peak failures are recoverable while invalid subjects remain terminal', () => {
    const zone = MountainTime.resolve(39.7392, -104.9903);
    const failing = SunState.create({ calculate: () => null });
    failing.setPeakSubject({
        lat: 39.7392, lon: -104.9903, zone, nowMs: Date.parse('2026-07-10T18:30:00Z'),
    });
    assert.equal(failing.get().availability, 'recoverable');
    assert.equal(failing.get().instant.ms, Date.parse('2026-07-10T18:30:00Z'));
    assert.match(failing.get().unavailable, /date and time/);

    const invalid = SunState.create({ calculate: resultFor });
    invalid.setPeakSubject({ lat: Number.NaN, lon: -104.9903, zone });
    assert.equal(invalid.get().availability, 'terminal');
    assert.equal(invalid.get().subject, null);
});

test('the first untimed selection starts at noon and manual preview never changes route identity', () => {
    const state = SunState.create({ calculate: resultFor });
    const zone = MountainTime.resolve(48.7, -121.8);
    state.selectRoutePoint({
        lat: 48.7, lon: -121.8, timeState: 'missing', routeIdentity: 17,
    }, '2026-07-10', zone);
    assert.equal(state.get().minute, 12 * 60);
    const identity = state.get().routeIdentity;
    const subject = state.get().subject;
    state.setPreviewMinute(17 * 60 + 45);
    assert.equal(state.get().routeIdentity, identity);
    assert.equal(state.get().subject, subject);
    assert.equal(state.get().minute, 17 * 60 + 45);
});

test('bearing changes only map-relative output and reset clears stale subject state', () => {
    let calculations = 0;
    const state = SunState.create({ calculate: input => { calculations++; return resultFor(input); } });
    const zone = MountainTime.resolve(0, 0);
    state.setPeakSubject({ lat: 0, lon: 0, zone, nowMs: Date.parse('2026-01-01T12:00:00Z') });
    const absolute = state.get().result.azimuthDeg;
    const moonAbsolute = state.get().result.moonAzimuthDeg;
    const moonPhase = state.get().result.moonPhaseLabel;
    state.setMapBearing(359);
    assert.equal(calculations, 1, 'bearing animation must not call the astronomy package');
    assert.equal(state.get().result.azimuthDeg, absolute);
    assert.equal(state.get().result.moonAzimuthDeg, moonAbsolute);
    assert.equal(state.get().result.moonPhaseLabel, moonPhase);
    assert.equal(state.get().result.screenAzimuthDeg, 2);
    assert.equal(state.get().result.moonScreenAzimuthDeg, 272);
    state.resetSubject();
    assert.deepEqual([state.get().subject, state.get().date, state.get().result, state.get().mapBearing], [
        null, null, null, 0,
    ]);
});

test('minute changes reuse daily events while calculating each requested position', () => {
    let positions = 0;
    let events = 0;
    const state = SunState.create({
        calculateInstant: ({ mapBearing = 0 }) => {
            positions++;
            return resultFor({ mapBearing });
        },
        calculateEvents: () => {
            events++;
            return {
                solarNoonMs: 1,
                solarNoonAzimuthDeg: 180,
                sunriseMs: 2,
                sunriseAzimuthDeg: 60,
                sunriseDate: '2026-07-10',
                sunriseDayRelation: 'same-day',
                sunsetMs: 3,
                sunsetAzimuthDeg: 300,
                sunsetDate: '2026-07-10',
                sunsetDayRelation: 'same-day',
                daylightState: 'ordinary',
            };
        },
    });
    const zone = MountainTime.resolve(39.7392, -104.9903);
    state.setPeakSubject({
        lat: 39.7392, lon: -104.9903, zone, nowMs: Date.parse('2026-07-10T18:30:00Z'),
    });
    for (let minute = 0; minute < 1440; minute++) state.setPreviewMinute(minute);
    assert.equal(positions, 1441);
    assert.equal(events, 1, 'one subject/date/zone owns one daily-event calculation');

    state.setPeakDate('2026-07-11');
    assert.equal(events, 2, 'date changes invalidate daily events');
    state.selectRoutePoint({
        lat: 39.75, lon: -104.99, timeState: 'missing', routeIdentity: 1,
    }, '2026-07-11', zone);
    assert.equal(events, 3, 'subject changes invalidate daily events');
});

test('minute changes reselect a cached Moon interval without recalculating daily events', () => {
    let events = 0;
    const zone = MountainTime.resolve(39.7392, -104.9903);
    const date = '2026-08-26';
    const first = {
        riseMs: MountainTime.civilToInstant(zone, '2026-08-25', 18 * 60 + 38).ms,
        riseAzimuthDeg: 90,
        riseDate: '2026-08-25',
        riseDayRelation: 'previous-day',
        midpointMs: MountainTime.civilToInstant(zone, date, 23).ms,
        midpointAzimuthDeg: 180,
        setMs: MountainTime.civilToInstant(zone, date, 4 * 60 + 40).ms,
        setAzimuthDeg: 270,
        setDate: date,
        setDayRelation: 'same-day',
    };
    const second = {
        riseMs: MountainTime.civilToInstant(zone, date, 19 * 60 + 5).ms,
        riseAzimuthDeg: 90,
        riseDate: date,
        riseDayRelation: 'same-day',
        midpointMs: MountainTime.civilToInstant(zone, '2026-08-27', 24).ms,
        midpointAzimuthDeg: 180,
        setMs: MountainTime.civilToInstant(zone, '2026-08-27', 5 * 60 + 45).ms,
        setAzimuthDeg: 270,
        setDate: '2026-08-27',
        setDayRelation: 'next-day',
    };
    const state = SunState.create({
        calculateInstant: resultFor,
        calculateEvents: () => {
            events++;
            return {
                daylightState: 'unavailable',
                moonVisibilityIntervals: Object.freeze([first, second]),
                moonVisibilityState: 'ordinary',
            };
        },
    });
    state.setPeakSubject({
        lat: 39.7392, lon: -104.9903, zone,
        nowMs: MountainTime.civilToInstant(zone, date, 2 * 60).ms,
    });
    assert.deepEqual([
        state.get().result.moonVisibilityIntervalIndex,
        state.get().result.moonVisibilitySelection,
    ], [0, 'active']);
    state.setPreviewMinute(12 * 60);
    assert.deepEqual([
        state.get().result.moonVisibilityIntervalIndex,
        state.get().result.moonVisibilitySelection,
    ], [1, 'upcoming']);
    state.setPreviewMinute(21 * 60);
    assert.deepEqual([
        state.get().result.moonVisibilityIntervalIndex,
        state.get().result.moonVisibilitySelection,
    ], [1, 'active']);
    assert.equal(events, 1);
});
