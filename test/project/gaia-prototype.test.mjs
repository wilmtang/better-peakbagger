// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import {
    ascentIdentity,
    MAX_PROTOTYPE_BYTES,
    readSourceGpx,
    storedTrackLink,
} from '../../scripts/prototypes/gaia/source.mjs';

const ascent = 'https://www.peakbagger.com/climber/ascent.aspx?aid=42';
const download = '/climber/GPXFile.aspx?aid=42&sep=1';
const gpx = '<?xml version="1.0"?><gpx version="1.1"><trk><name>Test route</name><trkseg><trkpt lat="37.1" lon="-119.2"/><trkpt lat="37.2" lon="-119.3"/></trkseg></trk></gpx>';

test('Gaia prototype accepts only exact saved-ascent identities', () => {
    assert.equal(ascentIdentity(ascent).id, '42');
    for (const url of [
        ascent.replace('https:', 'http:'),
        ascent.replace('www.peakbagger.com', 'www.peakbagger.com.evil.example'),
        ascent.replace('ascent.aspx', 'ascentedit.aspx'),
        ascent + '&aid=43',
        ascent.replace('aid=42', 'aid=0'),
        ascent.replace('www.', 'user:password@www.'),
        'https://www.gaiagps.com/map/',
    ]) assert.equal(ascentIdentity(url), null, url);
});

test('GPX source rejects mismatched identities, external URLs and ambiguous downloads', () => {
    for (const html of [
        '<a href="/climber/GPXFile.aspx?aid=43">Download this GPS track</a>',
        '<a href="https://evil.example/climber/GPXFile.aspx?aid=42">GPX</a>',
        '<a href="/climber/GPXFile.aspx?aid=42&aid=43">GPX</a>',
        `<a href="${download}">GPX</a><a href="/climber/GPXFile.aspx?aid=42&sep=0">GPX</a>`,
    ]) {
        const dom = new JSDOM(html);
        try { assert.throws(() => storedTrackLink(dom.window.document, ascentIdentity(ascent))); }
        finally { dom.window.close(); }
    }
});

test('GPX handoff preserves the original saved export and deduplicates identical links', async () => {
    const dom = new JSDOM(`<a href="${download}">GPX</a><a href="${download}">GPX again</a>`);
    try {
        let reads = 0;
        const result = await readSourceGpx({
            doc: dom.window.document,
            pageUrl: ascent,
            fetchResource: async (url, options) => {
                reads++;
                assert.equal(url, new URL(download, ascent).href);
                assert.equal(options.kind, 'gpx');
                return { kind: 'ok', url, text: gpx };
            },
        });
        assert.deepEqual(result, { ok: true, sourceUrl: ascent, gpx, filename: 'peakbagger-42.gpx' });
        assert.equal(reads, 1);
    } finally { dom.window.close(); }
});

test('GPX read fails closed on server errors, HTML, malformed XML, DTDs, size and redirects', async () => {
    const dom = new JSDOM(`<a href="${download}">GPX</a>`);
    try {
        const response = text => ({ kind: 'ok', url: new URL(download, ascent).href, text });
        for (const value of [
            { kind: 'wrong-content', error: { code: 'cloudflare', resource: 'gpx' } },
            response('<html><body>Log in</body></html>'),
            response('<gpx><trkpt lat="1" lon="2"></gpx>'),
            response('<!DOCTYPE gpx><gpx><trkpt lat="1" lon="2"/></gpx>'),
            response('<gpx/>'),
            response(gpx + ' '.repeat(MAX_PROTOTYPE_BYTES)),
            { ...response(gpx), url: 'https://evil.example/track.gpx' },
        ]) {
            const result = await readSourceGpx({
                doc: dom.window.document, pageUrl: ascent, fetchResource: async () => value,
            });
            assert.equal(result.ok, false);
            assert.equal(result.gpx, undefined);
        }
    } finally { dom.window.close(); }
});

test('prototype remains outside the shipping build and requests Gaia access optionally', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../scripts/prototypes/gaia/manifest.json', import.meta.url)));
    const shipping = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url)));
    assert.deepEqual(manifest.optional_host_permissions, ['https://www.gaiagps.com/*']);
    assert.ok(manifest.host_permissions.every(origin => origin.includes('peakbagger.com/')));
    assert.ok(!JSON.stringify(shipping).includes('gaiagps'));
    const { ENTRIES } = await import('../../scripts/build-config.mjs');
    assert.ok(!JSON.stringify(ENTRIES).includes('prototypes/gaia'));
});
