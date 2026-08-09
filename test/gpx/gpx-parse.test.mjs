// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the shared pure GPX parser. Provider-specific behavior
// (ownership, export endpoints, metadata) stays in provider-page.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { gpxParse } from '../../src/gpx/gpx-parse.js';
import {
    MAX_GPX_TRACK_SEGMENTS,
    MAX_GPX_WAYPOINTS,
} from '../../src/capture/capture-resource-limits.js';

// The parser's only platform dependency is DOMParser; give it jsdom's.
const { DOMParser } = new JSDOM('').window;
globalThis.DOMParser = DOMParser;

const { parseGpxData, parseGpxDocument, parseTrackPoint, cleanName, noGpsError } = gpxParse;

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

test('only direct GPX-owned tracks, segments, points, and waypoints are admitted', () => {
    const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="47.9" lon="-121.9"><name>Direct camp</name></wpt>
      <extensions>
        <wpt lat="99" lon="99"><name>Fake camp</name></wpt>
        <trk><trkseg><trkpt lat="98" lon="98"/></trkseg></trk>
      </extensions>
      <trk><name>Owned track</name><trkseg>
        <trkpt lat="47" lon="-121"/>
        <extensions><trkpt lat="97" lon="97"/></extensions>
        <trkseg><trkpt lat="96" lon="96"/></trkseg>
        <trkpt lat="47" lon="-121"/>
      </trkseg></trk>
    </gpx>`;
    const parsed = parseGpxData(gpx, { retainWaypoints: true, includeTripName: true });

    assert.deepEqual(parsed.segments.map(segment => segment.map(({ lat, lon }) => [lat, lon])), [
        [[47, -121], [47, -121]],
    ], 'legitimate repeated direct points stay in source order');
    assert.deepEqual(parsed.waypoints, [{ lat: 47.9, lon: -121.9, name: 'Direct camp' }]);
    assert.equal(parsed.trackName, 'Owned track');
});

test('prefixed GPX namespaces retain direct ownership semantics', () => {
    const parsed = parseGpxData(`<g:gpx xmlns:g="urn:gpx">
      <g:wpt lat="1" lon="2"><g:name>Camp</g:name></g:wpt>
      <g:trk><g:name>Prefixed</g:name><g:trkseg>
        <g:trkpt lat="3" lon="4"/><g:trkpt lat="5" lon="6"/>
      </g:trkseg></g:trk>
    </g:gpx>`, { retainWaypoints: true, includeTripName: true });

    assert.deepEqual(parsed.segments[0].map(({ lat, lon }) => [lat, lon]), [[3, 4], [5, 6]]);
    assert.deepEqual(parsed.waypoints, [{ lat: 1, lon: 2, name: 'Camp' }]);
    assert.equal(parsed.trackName, 'Prefixed');
});

test('text and document entry points return the same direct-owned quality tree', () => {
    const source = `<gpx><trk><trkseg>
      <trkpt lat="47" lon="-121"><ele>100</ele><time>2026-07-10T12:00:00Z</time></trkpt>
      <extensions><trkpt lat="0" lon="0"><ele>9999</ele></trkpt></extensions>
      <trkpt lat="47.1" lon="-121.1"><ele>bad</ele></trkpt>
    </trkseg></trk></gpx>`;
    const document = new DOMParser().parseFromString(source, 'application/xml');
    assert.deepEqual(
        parseGpxDocument(document, { includeQuality: true }),
        parseGpxData(source, { includeQuality: true }),
    );
    const points = parseGpxDocument(document, { includeQuality: true }).segments[0];
    assert.equal(points.length, 2);
    assert.equal(points[0].elevationState, 'valid');
    assert.equal(points[1].elevationState, 'invalid');
});

test('a nested GPX tree under the wrong document root is not route geometry', () => {
    assert.throws(
        () => parseGpxData('<wrapper><gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx></wrapper>'),
        error => error.code === 'invalid-gpx' && /document root/i.test(error.message),
    );
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

test('track-point parsing rejects partial numbers and non-ISO dates consistently', () => {
    const xml = new DOMParser().parseFromString(`<gpx><trk><trkseg>
      <trkpt lat="47north" lon="-121west"><ele>100m</ele><time>July 10, 2026</time></trkpt>
    </trkseg></trk></gpx>`, 'application/xml');
    const parsed = parseTrackPoint(xml.querySelector('trkpt'), { includeQuality: true });

    assert.equal(Number.isNaN(parsed.lat), true);
    assert.equal(Number.isNaN(parsed.lon), true);
    assert.equal(Number.isNaN(parsed.ele), true);
    assert.equal(parsed.time, null);
    assert.equal(parsed.invalidTime, true);
    assert.equal(parsed.elevationState, 'invalid');
    assert.equal(parsed.timeState, 'invalid');
});

test('quality metadata is opt-in and distinguishes absent from malformed samples', () => {
    const source = `<gpx><trk><trkseg>
      <trkpt lat="47" lon="-121"/>
      <trkpt lat="47.1" lon="-121.1"><ele>bad</ele><time>bad</time></trkpt>
      <trkpt lat="47.2" lon="-121.2"><time></time></trkpt>
    </trkseg></trk></gpx>`;
    const xml = new DOMParser().parseFromString(source, 'application/xml');
    const [missing, invalid, empty] = [...xml.querySelectorAll('trkpt')]
        .map(point => parseTrackPoint(point, { includeQuality: true }));

    assert.equal(missing.elevationState, 'missing');
    assert.equal(missing.timeState, 'missing');
    assert.equal(invalid.elevationState, 'invalid');
    assert.equal(invalid.timeState, 'invalid');
    assert.equal(empty.timeState, 'invalid');
    assert.deepEqual(Object.keys(parseGpxData(source).segments[0][0]).sort(),
        ['ele', 'invalidTime', 'lat', 'lon', 'time'],
        'capture/upload payloads must not gain analyzer-only quality fields');
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
    assert.throws(
        () => parseGpxData('<gpx><trk><trkseg></gpx'),
        error => error.code === 'invalid-gpx' && /invalid XML/.test(error.message)
    );
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

test('parsing preserves more than Peakbagger\'s later 3,000-point upload budget', () => {
    const points = Array.from({ length: 3001 }, (_, index) =>
        `<trkpt lat="${(47 + index * 1e-5).toFixed(5)}" lon="-121"><ele>${index % 500}</ele></trkpt>`).join('');
    const parsed = parseGpxData(`<gpx><trk><trkseg>${points}</trkseg></trk></gpx>`);
    assert.equal(parsed.segments[0].length, 3001);
    assert.equal(parsed.segments[0][3000].lat, 47.03);
});

test('GPX structure rejects segment and waypoint limit plus one before retaining it', () => {
    const segments = '<trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk>'
        .repeat(MAX_GPX_TRACK_SEGMENTS + 1);
    assert.throws(
        () => parseGpxData(`<gpx>${segments}</gpx>`),
        error => error.code === 'gpx-too-large' && /20,000 track points/.test(error.message),
    );

    const waypoints = '<wpt lat="1" lon="2"/>'.repeat(MAX_GPX_WAYPOINTS + 1);
    assert.throws(
        () => parseGpxData(`<gpx>${waypoints}<trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`),
        error => error.code === 'gpx-too-large',
        'unrequested waypoints are still bounded before the DOM can become a hidden resource sink',
    );
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
