// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production-scale parser coverage is intentionally separate from npm test:
// jsdom's DOMParser makes this case expensive, while ordinary parser behavior
// and the no-upload-cap boundary stay in the fast default suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { gpxParse } from '../../../src/gpx/gpx-parse.js';
import { MAX_GPX_TRACK_POINTS } from '../../../src/capture/capture-resource-limits.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

test('a 20,000-point provider track parses completely', () => {
    const points = Array.from({ length: MAX_GPX_TRACK_POINTS }, (_, index) =>
        `<trkpt lat="${(47 + index * 1e-5).toFixed(5)}" lon="-121"><ele>${index % 500}</ele></trkpt>`).join('');
    const parsed = gpxParse.parseGpxData(`<gpx><trk><trkseg>${points}</trkseg></trk></gpx>`);
    assert.equal(parsed.segments[0].length, MAX_GPX_TRACK_POINTS);
    assert.equal(parsed.segments[0][MAX_GPX_TRACK_POINTS - 1].lat, 47.19999);
});

test('a provider track one point above the contract is rejected', () => {
    const points = Array.from({ length: MAX_GPX_TRACK_POINTS + 1 }, (_, index) =>
        `<trkpt lat="${(47 + index * 1e-5).toFixed(5)}" lon="-121"/>`).join('');
    assert.throws(
        () => gpxParse.parseGpxData(`<gpx><trk><trkseg>${points}</trkseg></trk></gpx>`),
        error => error.code === 'gpx-too-large',
    );
});
