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

globalThis.DOMParser = new JSDOM('').window.DOMParser;

test('a 20,000-point provider track parses completely', () => {
    const points = Array.from({ length: 20000 }, (_, index) =>
        `<trkpt lat="${(47 + index * 1e-5).toFixed(5)}" lon="-121"><ele>${index % 500}</ele></trkpt>`).join('');
    const parsed = gpxParse.parseGpxData(`<gpx><trk><trkseg>${points}</trkseg></trk></gpx>`);
    assert.equal(parsed.segments[0].length, 20000);
    assert.equal(parsed.segments[0][19999].lat, 47.19999);
});
