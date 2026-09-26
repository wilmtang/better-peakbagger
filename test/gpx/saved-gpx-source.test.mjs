// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
    ascentIdentity,
    readSourceGpx,
    storedTrackLink,
    validateGpx,
} from '../../src/gpx/saved-gpx-source.js';
import { MAX_GAIA_GPX_BYTES } from '../../src/gaia/gaia-import.js';
import { MAX_ALLTRAILS_GPX_BYTES } from '../../src/alltrails/alltrails-import.js';
import { MAX_ONX_GPX_BYTES } from '../../src/onx/onx-import.js';

const ascent = 'https://www.peakbagger.com/climber/ascent.aspx?aid=42';
const download = 'https://www.peakbagger.com/climber/GPXFile.aspx?aid=42&sep=1';
const gpx = '<?xml version="1.0"?><gpx version="1.1"><trk><name>Test route</name><trkseg><trkpt lat="37.1" lon="-119.2"/><trkpt lat="37.2" lon="-119.3"/></trkseg></trk></gpx>';
const dom = new JSDOM();
const parseXml = value => new dom.window.DOMParser().parseFromString(value, 'application/xml');

test.after(() => dom.window.close());

test('map handoff source accepts only exact saved-ascent and track identities', () => {
    const identity = ascentIdentity(ascent);
    assert.equal(identity.id, '42');
    assert.equal(storedTrackLink(download, identity), download);
    for (const url of [
        ascent.replace('https:', 'http:'),
        ascent.replace('www.peakbagger.com', 'www.peakbagger.com.evil.example'),
        ascent.replace('ascent.aspx', 'ascentedit.aspx'),
        `${ascent}&aid=43`,
        ascent.replace('aid=42', 'aid=0'),
        ascent.replace('www.', 'user:password@www.'),
        'https://www.gaiagps.com/map/',
    ]) assert.equal(ascentIdentity(url), null, url);
    for (const url of [
        download.replace('aid=42', 'aid=43'),
        download.replace('www.peakbagger.com', 'evil.example'),
        `${download}&aid=43`,
        download.replace('GPXFile.aspx', 'ascent.aspx'),
    ]) assert.equal(storedTrackLink(url, identity), null, url);
});

test('saved GPX handoff preserves the exact Peakbagger export', async () => {
    let reads = 0;
    const result = await readSourceGpx({
        pageUrl: ascent,
        gpxUrl: download,
        parseXml,
        fetchResource: async (url, options) => {
            reads++;
            assert.equal(url, download);
            assert.equal(options.kind, 'gpx');
            return { kind: 'ok', url, text: gpx };
        },
    });
    assert.deepEqual(result, { ok: true, sourceUrl: ascent, gpx, filename: 'peakbagger-42.gpx' });
    assert.equal(reads, 1);
});

test('saved GPX read fails closed on errors, malformed data, DTDs, size and redirects', async () => {
    const response = text => ({ kind: 'ok', url: download, text });
    for (const value of [
        { kind: 'wrong-content', error: { code: 'cloudflare', resource: 'gpx' } },
        response('<html><body>Log in</body></html>'),
        response('<gpx><trkpt lat="1" lon="2"></gpx>'),
        response('<!DOCTYPE gpx><gpx><trkpt lat="1" lon="2"/></gpx>'),
        response('<gpx/>'),
        { ...response(gpx), url: 'https://evil.example/track.gpx' },
    ]) {
        const result = await readSourceGpx({
            pageUrl: ascent,
            gpxUrl: download,
            parseXml,
            fetchResource: async () => value,
        });
        assert.equal(result.ok, false);
        assert.equal(result.gpx, undefined);
    }
    assert.equal(validateGpx(`<gpx><wpt lat="1" lon="2"/></gpx>${' '.repeat(MAX_GAIA_GPX_BYTES)}`, { parseXml }), false);
    assert.equal(validateGpx(`<gpx><wpt lat="1" lon="2"/></gpx>${' '.repeat(MAX_ALLTRAILS_GPX_BYTES)}`, {
        maxBytes: MAX_ALLTRAILS_GPX_BYTES,
        parseXml,
    }), false);
    assert.equal(validateGpx(`<gpx><wpt lat="1" lon="2"/></gpx>${' '.repeat(MAX_ONX_GPX_BYTES)}`, {
        maxBytes: MAX_ONX_GPX_BYTES,
        parseXml,
    }), false);
});
