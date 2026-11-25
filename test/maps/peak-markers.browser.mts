/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import { peakMarkers } from '../../src/maps/peak-markers.ts';

const nativeFetch = globalThis.fetch.bind(globalThis);

type StubFetch = (url: string, options?: RequestInit) => Promise<unknown>;
const withFetch = (stub: StubFetch) => {
    (globalThis as unknown as { fetch: StubFetch }).fetch = stub;
    return () => { globalThis.fetch = nativeFetch; };
};

const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('peak markers cancel rejected HTTP bodies instead of leaving the connection open', async () => {
    let cancelled = 0;
    const restore = withFetch(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }));
    try {
        const client = peakMarkers.createClient('https://www.peakbagger.com/map/MasterMap.aspx?t=P&d=2296')!;
        assert.deepEqual(await client.request({ miny: 46, maxy: 47, minx: -122, maxx: -121 }), []);
        assert.equal(cancelled, 1);
    } finally { restore(); }
});

// The masked shape of a real archived PLLBB.aspx response: ids may be
// negative (provisional peaks), c is the climbed flag, r the prominence.
const SAMPLE_XML = '<?xml version=\'1.0\' encoding=\'UTF-8\'?><ts>'
    + '<t i="-114297" n="Peak 5000 (Prov)" a="43.893161" o="-103.410337" c="2" r="0"/>'
    + '<t i="38375" n="Peak 6057" a="43.878655" o="-103.498292" c="0" r="137"/>'
    + '<t i="58603" n="Iron Mountain" a="43.858591" o="-103.433511" c="1" r="246"/>'
    + '</ts>';

test('contextFrom reads the peak-feed parameters from a same-origin MasterMap URL', () => {
    const context = peakMarkers.contextFrom(
        'https://www.peakbagger.com/map/MasterMap.aspx?cy=46.85&cx=-121.76&z=14&t=P&d=2296&c=900001&hj=300');
    assert.deepEqual(plain(context), {
        endpoint: 'https://www.peakbagger.com/Async/PLLBB.aspx',
        mapType: 'P',
        pid: 2296,
        cid: 900001,
        hj: 300,
    });
});

test('contextFrom sends pid only for the map types the native map sends it for', () => {
    const ascent = peakMarkers.contextFrom('https://www.peakbagger.com/map/MasterMap.aspx?t=A&d=123&c=5')!;
    assert.equal(ascent.mapType, 'A');
    assert.equal(ascent.pid, null, 'ascent maps do not pass a subject peak id');
    assert.equal(ascent.cid, 5);
    assert.equal(ascent.hj, 0, 'a missing hj falls back to 0 like the native gup() parse');
});

test('contextFrom fails closed on group maps, foreign origins, and unrecognizable URLs', () => {
    const cases: [unknown, string][] = [
        ['https://www.peakbagger.com/map/MasterMap.aspx?t=G&d=1', 'group maps never show other peaks'],
        ['https://www.peakbagger.com/map/MasterMap.aspx?d=1', 'a missing map type'],
        ['https://evil.example.com/map/MasterMap.aspx?t=P&d=1', 'a cross-origin frame'],
        ['https://www.peakbagger.com/map/OtherMap.aspx?t=P&d=1', 'a non-MasterMap page'],
        ['not a url \x00', 'an unparsable src'],
        ['', 'an empty src'],
        [null, 'a missing src'],
    ];
    for (const [src, why] of cases) {
        assert.equal(peakMarkers.contextFrom(src), null, `must fail closed for ${why}`);
    }
});

test('requestUrl builds the native query and rejects broken bounds', () => {
    const context = peakMarkers.contextFrom(
        'https://www.peakbagger.com/map/MasterMap.aspx?t=P&d=2296&c=900001');
    const url = peakMarkers.requestUrl(context, { miny: 46.8, maxy: 46.9, minx: -121.9, maxx: -121.7 });
    assert.equal(url,
        'https://www.peakbagger.com/Async/PLLBB.aspx?miny=46.8&maxy=46.9&minx=-121.9&maxx=-121.7&t=P&pid=2296&cid=900001');

    const noIds = peakMarkers.contextFrom('https://www.peakbagger.com/map/MasterMap.aspx?t=A');
    assert.equal(peakMarkers.requestUrl(noIds, { miny: 1, maxy: 2, minx: 3, maxx: 4 }),
        'https://www.peakbagger.com/Async/PLLBB.aspx?miny=1&maxy=2&minx=3&maxx=4&t=A');

    assert.equal(peakMarkers.requestUrl(context, { miny: 46.9, maxy: 46.8, minx: -121.9, maxx: -121.7 }),
        null, 'inverted latitudes must be rejected');
    assert.equal(peakMarkers.requestUrl(context, { miny: NaN, maxy: 46.9, minx: -121.9, maxx: -121.7 }),
        null, 'non-finite bounds must be rejected');
    assert.equal(peakMarkers.requestUrl(context, { miny: 10, maxy: 40, minx: -120, maxx: -60 }),
        null, 'a continent-sized box means broken bounds math upstream');
});

test('parsePeaks validates every row of the archived response shape', () => {
    const peaks = peakMarkers.parsePeaks(SAMPLE_XML, 0);
    assert.deepEqual(plain(peaks), [
        { id: -114297, name: 'Peak 5000 (Prov)', lat: 43.893161, lon: -103.410337, state: 'unknown' },
        { id: 38375, name: 'Peak 6057', lat: 43.878655, lon: -103.498292, state: 'unclimbed' },
        { id: 58603, name: 'Iron Mountain', lat: 43.858591, lon: -103.433511, state: 'climbed' },
    ]);
});

test('parsePeaks applies the hj prominence cutoff exactly like the native filter', () => {
    const names = (hj: number) => plain(peakMarkers.parsePeaks(SAMPLE_XML, hj).map(peak => peak.name));
    assert.deepEqual(names(0), ['Peak 5000 (Prov)', 'Peak 6057', 'Iron Mountain']);
    assert.deepEqual(names(137), ['Peak 6057', 'Iron Mountain']);
    assert.deepEqual(names(200), ['Iron Mountain']);
    assert.deepEqual(names(9999), []);

    const noProminence = '<ts><t i="1" n="No Prom" a="1" o="2" c="1"/></ts>';
    assert.deepEqual(plain(peakMarkers.parsePeaks(noProminence, 0)), [],
        'a missing prominence never passes, matching parseInt(NaN) >= 0 being false');
});

test('parsePeaks drops malformed rows and unparsable documents without throwing', () => {
    const malformed = '<ts>'
        + '<t i="1" n="Good Peak" a="47.1" o="-121.2" c="1" r="10"/>'
        + '<t i="zero" n="Bad Id" a="47.1" o="-121.2" c="1" r="10"/>'
        + '<t i="3" n="" a="47.1" o="-121.2" c="1" r="10"/>'
        + '<t i="4" n="Bad Lat" a="99" o="-121.2" c="1" r="10"/>'
        + '<t i="5" n="Bad Lon" a="47.1" o="-999" c="1" r="10"/>'
        + '<t i="6" n="Ctrl&#9;Name" a="47.1" o="-121.2" c="1" r="10"/>'
        + '</ts>';
    assert.deepEqual(plain(peakMarkers.parsePeaks(malformed, 0).map(peak => peak.id)), [1]);
    assert.deepEqual(plain(peakMarkers.parsePeaks('<ts><broken', 0)), []);
    assert.deepEqual(plain(peakMarkers.parsePeaks('', 0)), []);
    assert.deepEqual(plain(peakMarkers.parsePeaks(null, 0)), []);
});

test('parsePeaks caps oversized feeds keeping the most prominent peaks', () => {
    const rows = Array.from({ length: peakMarkers.MAX_PEAKS + 50 }, (_unused, index) =>
        `<t i="${index + 1}" n="Peak ${index + 1}" a="47.${String(index).padStart(3, '0')}" o="-121.5" c="0" r="${index}"/>`);
    const peaks = peakMarkers.parsePeaks(`<ts>${rows.join('')}</ts>`, 0);
    assert.equal(peaks.length, peakMarkers.MAX_PEAKS);
    const kept = new Set(peaks.map(peak => peak.id));
    assert.ok(kept.has(peakMarkers.MAX_PEAKS + 50), 'the most prominent peak survives the cap');
    assert.ok(!kept.has(1), 'the least prominent peak is dropped first');
});

test('parsePeaks rejects excessive XML structure before DOMParser', () => {
    const original = globalThis.DOMParser;
    let parsed = false;
    (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
        parseFromString() { parsed = true; throw new Error('must not parse'); }
    };
    try {
        const rows = '<t i="1" n="Peak" a="1" o="2" c="0" r="1"/>'.repeat(
            peakMarkers.MAX_SOURCE_PEAKS + 1);
        assert.deepEqual(peakMarkers.parsePeaks(`<ts>${rows}</ts>`, 0), []);
        assert.equal(parsed, false);
        assert.deepEqual(peakMarkers.parsePeaks('<!DOCTYPE ts [<!ENTITY x "x">]><ts/>', 0), []);
        assert.equal(parsed, false);
    } finally {
        globalThis.DOMParser = original;
    }
});

test('createClient fetches same-origin with the native query and parses the reply', async () => {
    const requests: { url: string; options?: RequestInit }[] = [];
    const restore = withFetch(async (url, options) => {
        requests.push({ url, options });
        return { ok: true, text: async () => SAMPLE_XML };
    });
    try {
        const client = peakMarkers.createClient(
            'https://www.peakbagger.com/map/MasterMap.aspx?t=P&d=2296&c=900001&hj=100');
        assert.ok(client);
        const peaks = (await client.request({ miny: 43.8, maxy: 43.95, minx: -103.6, maxx: -103.3 }))!;
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url,
            'https://www.peakbagger.com/Async/PLLBB.aspx?miny=43.8&maxy=43.95&minx=-103.6&maxx=-103.3&t=P&pid=2296&cid=900001');
        assert.equal(requests[0].options!.credentials, 'same-origin');
        assert.deepEqual(plain(peaks.map(peak => peak.name)), ['Peak 6057', 'Iron Mountain'],
            'the hj=100 cutoff from the map URL applies to the parsed feed');
    } finally { restore(); }
});

test('createClient rejects an oversized marker response before reading or parsing it', async () => {
    let read = false;
    const restore = withFetch(async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => name === 'content-length'
            ? String(peakMarkers.RESPONSE_MAX_BYTES + 1)
            : null },
        body: { cancel: async () => {} },
        text: async () => { read = true; return SAMPLE_XML; },
    }));
    try {
        const client = peakMarkers.createClient(
            'https://www.peakbagger.com/map/MasterMap.aspx?t=A')!;
        assert.deepEqual(plain(await client.request({ miny: 1, maxy: 2, minx: 3, maxx: 4 })), []);
        assert.equal(read, false);
    } finally { restore(); }
});

test('createClient returns null for surfaces whose native map shows no peaks', () => {
    assert.equal(peakMarkers.createClient(
        'https://www.peakbagger.com/map/MasterMap.aspx?t=G&d=1'), null);
    assert.equal(peakMarkers.createClient(null), null);
});

test('a terrain responder caches unavailable map context until its frame resets', async () => {
    let iframeSrc = 'https://www.peakbagger.com/map/MasterMap.aspx?t=G&d=1';
    let sourceReads = 0;
    const posts: { type: string; detail?: Record<string, unknown> }[] = [];
    const responder = peakMarkers.createTerrainResponder({
        getIframeSrc: () => { sourceReads++; return iframeSrc; },
        post: (type, detail) => posts.push({ type, detail }),
    });
    const bounds = { miny: 1, maxy: 2, minx: 3, maxx: 4 };

    assert.equal(responder.answer({ requestId: 'invalid', bounds }), null);
    assert.equal(responder.answer({ requestId: 1, bounds }), null);
    iframeSrc = 'https://www.peakbagger.com/map/MasterMap.aspx?t=A&c=7';
    assert.equal(responder.answer({ requestId: 2, bounds }), null);
    assert.equal(sourceReads, 1, 'one unusable frame context is resolved once per generation');
    assert.deepEqual(plain(posts), [
        { type: 'peaks', detail: { requestId: 1, peaks: [], unavailable: true } },
        { type: 'peaks', detail: { requestId: 2, peaks: [], unavailable: true } },
    ]);

    const restore = withFetch(async () => ({ ok: true, text: async () => SAMPLE_XML }));
    try {
        responder.reset();
        await responder.answer({ requestId: 3, bounds });
        assert.equal(sourceReads, 2, 'reset resolves the replacement frame context');
        assert.equal(posts.at(-1)!.detail!.requestId, 3);
        assert.equal((posts.at(-1)!.detail!.peaks as unknown[]).length, 3);
        assert.notEqual(posts.at(-1)!.detail!.unavailable, true);
    } finally { restore(); }
});

test('a terrain responder suppresses a valid reply from a replaced frame', async () => {
    let release!: () => void;
    const restore = withFetch(() => new Promise(resolve => {
        release = () => resolve({ ok: true, text: async () => SAMPLE_XML });
    }));
    try {
        const posts: { type: string; detail?: Record<string, unknown> }[] = [];
        const responder = peakMarkers.createTerrainResponder({
            getIframeSrc: () => 'https://www.peakbagger.com/map/MasterMap.aspx?t=A',
            post: (type, detail) => posts.push({ type, detail }),
        });

        const request = responder.answer({
            requestId: 1,
            bounds: { miny: 1, maxy: 2, minx: 3, maxx: 4 },
        })!;
        responder.reset();
        release();
        assert.equal((await request)!.length, 3, 'the old fetch itself still resolves normally');
        await Promise.resolve();
        assert.deepEqual(posts, [], 'its bridge reply is stale after the map frame resets');
    } finally { restore(); }
});

test('a terrain responder requires both surface callbacks', () => {
    assert.throws(() => peakMarkers.createTerrainResponder({
        getIframeSrc: () => null,
    } as never), /frame source and post function/);
    assert.throws(() => peakMarkers.createTerrainResponder({
        post: () => {},
    } as never), /frame source and post function/);
});

test('a superseded request stays silent and only the newest request answers', async () => {
    let releaseFirst: (() => void) | undefined;
    let call = 0;
    const restore = withFetch((_url, options) => new Promise((resolve, reject) => {
        call++;
        if (call === 1) {
            releaseFirst = () => resolve({ ok: true, text: async () => SAMPLE_XML });
            options!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        } else {
            resolve({ ok: true, text: async () => SAMPLE_XML });
        }
    }));
    try {
        const client = peakMarkers.createClient(
            'https://www.peakbagger.com/map/MasterMap.aspx?t=A')!;
        const first = client.request({ miny: 1, maxy: 2, minx: 3, maxx: 4 });
        const second = client.request({ miny: 1.1, maxy: 2.1, minx: 3.1, maxx: 4.1 });
        if (releaseFirst) releaseFirst();
        assert.equal(await first, null, 'the aborted request must not deliver an answer');
        assert.equal((await second)!.length, 3, 'the newest request delivers the peaks');
    } finally { restore(); }
});

test('a failed fetch clears the markers instead of throwing', async () => {
    const restore = withFetch(async () => { throw new TypeError('network down'); });
    try {
        const client = peakMarkers.createClient(
            'https://www.peakbagger.com/map/MasterMap.aspx?t=A')!;
        assert.deepEqual(plain(await client.request({ miny: 1, maxy: 2, minx: 3, maxx: 4 })), []);

        withFetch(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
        assert.deepEqual(plain(await client.request({ miny: 1, maxy: 2, minx: 3, maxx: 4 })), []);
    } finally { restore(); }
});

test('a nearby-peak limit is reported without an empty replacement or repeated camera fetches', async () => {
    const posted: ({ type: string } & Record<string, unknown>)[] = [];
    let calls = 0;
    const restore = withFetch(async () => { calls++; return new Response('unreadable', { status: 429, headers: { 'retry-after': '60' } }); });
    const responder = peakMarkers.createTerrainResponder({
        getIframeSrc: () => 'https://www.peakbagger.com/map/MasterMap.aspx?t=P&d=1',
        post: (type, data) => posted.push({ type, ...data }),
    });
    try {
        const bounds = { miny: 46.8, maxy: 46.9, minx: -121.9, maxx: -121.7 };
        await responder.answer({ requestId: 1, bounds });
        await responder.answer({ requestId: 2, bounds });
        assert.equal(calls, 1); assert.equal(posted.length, 2);
        assert.equal(posted[0].rateLimited, true); assert.equal('peaks' in posted[0], false);
        assert.ok((posted[0].retryAt as number) > Date.now());
    } finally { restore(); }
});
