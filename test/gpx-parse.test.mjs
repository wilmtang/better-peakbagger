// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the shared pure GPX parser. Provider-specific behavior
// (ownership, export endpoints, metadata) stays in provider-page.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { gpxParse } from '../src/gpx-parse.js';

// The parser's only platform dependency is DOMParser; give it jsdom's.
globalThis.DOMParser = new JSDOM('').window.DOMParser;

const { parseGpxData, cleanName, noGpsError } = gpxParse;

test('multi-track GPX flattens to segments in document order with analysis fields only', () => {
    const gpx = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"
      xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
      <trk><name>Day 1</name>
        <trkseg><trkpt lat="47" lon="-121"><ele>100</ele><time>2026-07-01T15:00:00Z</time>
          <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>175</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
        </trkpt></trkseg>
        <trkseg><trkpt lat="47.1" lon="-121.1"/></trkseg>
      </trk>
      <trk><name>Day 2</name><trkseg><trkpt lat="48" lon="-122"><ele>200</ele></trkpt></trkseg></trk>
    </gpx>`;
    const parsed = parseGpxData(gpx);
    assert.equal(parsed.segments.length, 3);
    assert.deepEqual(Object.keys(parsed.segments[0][0]).sort(), ['ele', 'invalidTime', 'lat', 'lon', 'time']);
    assert.equal(parsed.segments[0][0].time, Date.UTC(2026, 6, 1, 15));
    assert.deepEqual(parsed.segments[1][0], { lat: 47.1, lon: -121.1, ele: null, time: null, invalidTime: false });
    assert.equal(parsed.segments[2][0].ele, 200);
    assert.doesNotMatch(JSON.stringify(parsed), /175|hr/);
});

test('missing and malformed coordinates, elevations, and times become null (with invalidTime flagged)', () => {
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="" lon=" "><ele></ele></trkpt>
      <trkpt lat="47" lon="-121"><time>not-a-time</time></trkpt>
      <trkpt lat="oops" lon="-121"><ele>abc</ele></trkpt>
    </trkseg></trk></gpx>`;
    const [segment] = parseGpxData(gpx).segments;
    assert.deepEqual(segment[0], { lat: null, lon: null, ele: null, time: null, invalidTime: false });
    assert.deepEqual(segment[1], { lat: 47, lon: -121, ele: null, time: null, invalidTime: true });
    assert.equal(Number.isNaN(segment[2].lat), true, 'non-numeric text stays a sanitizer problem, not a parser crash');
    assert.equal(Number.isNaN(segment[2].ele), true);
});

test('waypoints and the track name are extracted only when the options request them', () => {
    const gpx = `<gpx><wpt lat="47.1" lon="-121.2"><ele>999</ele><name>  Camp&#x20;&amp;  Water </name><desc>secret</desc></wpt>
      <trk><name> Grand   Traverse </name><trkseg><trkpt lat="47" lon="-121"/></trkseg></trk></gpx>`;
    const defaults = parseGpxData(gpx);
    assert.deepEqual([...defaults.waypoints], []);
    assert.equal(defaults.trackName, '');

    const retained = parseGpxData(gpx, { retainWaypoints: true, includeTripName: true });
    assert.deepEqual(retained.waypoints, [{ lat: 47.1, lon: -121.2, name: 'Camp & Water' }]);
    assert.equal(retained.trackName, 'Grand Traverse');
    assert.doesNotMatch(JSON.stringify(retained), /999|secret/);
});

test('malformed XML throws a parse error, not a no-GPS state', () => {
    assert.throws(() => parseGpxData('<gpx><trk><trkseg></gpx'), /invalid GPX XML/);
});

test('trackless and waypoint-only files throw the coded no-GPS error', () => {
    for (const gpx of [
        '<gpx></gpx>',
        '<gpx><wpt lat="1" lon="2"/></gpx>',
        '<gpx><trk><trkseg></trkseg></trk></gpx>'
    ]) {
        assert.throws(() => parseGpxData(gpx), error => error.code === 'no-gps-data');
    }
    assert.equal(noGpsError().code, 'no-gps-data');
});

test('a large synthetic track parses completely', () => {
    const points = Array.from({ length: 20000 }, (_, index) =>
        `<trkpt lat="${(47 + index * 1e-5).toFixed(5)}" lon="-121"><ele>${index % 500}</ele></trkpt>`).join('');
    const parsed = parseGpxData(`<gpx><trk><trkseg>${points}</trkseg></trk></gpx>`);
    assert.equal(parsed.segments[0].length, 20000);
    assert.equal(parsed.segments[0][19999].lat, 47.19999);
});

test('names decode entities and normalize to 200 characters of single-spaced text', () => {
    assert.equal(cleanName('  a \n\t b  '), 'a b');
    assert.equal(cleanName('x'.repeat(300)).length, 200);
    assert.equal(cleanName(42), '');
    const parsed = parseGpxData(
        '<gpx><trk><name>&lt;Tag&gt; &amp; &quot;quote&quot;</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>',
        { includeTripName: true }
    );
    assert.equal(parsed.trackName, '<Tag> & "quote"');
});
