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
    sunriseMs: 1,
    sunsetMs: 2,
    daylightState: 'ordinary',
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
    assert.equal(calls.at(-1).lat, 48.71, 'an unavailable point must not run a stale calculation');
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
    state.setMapBearing(359);
    assert.equal(calculations, 1, 'bearing animation must not call the astronomy package');
    assert.equal(state.get().result.azimuthDeg, absolute);
    assert.equal(state.get().result.screenAzimuthDeg, 2);
    state.resetSubject();
    assert.deepEqual([state.get().subject, state.get().date, state.get().result, state.get().mapBearing], [
        null, null, null, 0,
    ]);
});
