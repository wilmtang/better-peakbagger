// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnowDepthMetadata, readSnowDepthLegend, readSnowDepthTime } from '../../src/maps/snow-depth.js';
import { mapOverlayCoverage, overlayTileUrl } from '../../src/maps/map-overlay-providers.ts';
import { snowDepthCatalogue, snowDepthLegend } from '../helpers/snow-depth-fixture.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('snow requests the transparent depth raster in map coordinates, with conservative wrapped coverage', () => {
    const url = new URL(overlayTileUrl('snow', { z: 9, x: 82, y: 180 }));
    assert.equal(url.hostname, 'mapservices.weather.noaa.gov');
    assert.equal(url.searchParams.get('layers'), 'show:3', 'SWE is a different raster');
    for (const [key, value] of Object.entries({ transparent: 'true', format: 'png32', bboxSR: '3857', imageSR: '3857', size: '256,256' })) assert.equal(url.searchParams.get(key), value);
    for (const [lon, lat, expected] of [[-121.76, 46.85, true], [-115.57, 51.18, true], [-151, 63, false], [-155, 20, false], [7, 46, false]]) {
        const bounds = [lon - .01, lat - .01, lon + .01, lat + .01];
        assert.equal(mapOverlayCoverage(bounds).snow, expected);
        assert.equal(mapOverlayCoverage(bounds.map((v, i) => i % 2 ? v : v + 360)).snow, expected);
    }
});
test('analysis time uses the unique valid time and never substitutes ingestion or download time', () => {
    const time = Date.UTC(2026, 9, 30), catalogue = snowDepthCatalogue(time);
    assert.equal(readSnowDepthTime(catalogue, time), time);
    for (const bad of [{ features: [] }, { features: [catalogue.features[0], catalogue.features[0]] }, { features: [{ attributes: { idp_ingestdate: time } }] },
        { ...catalogue, exceededTransferLimit: true }, snowDepthCatalogue(time + 300001), snowDepthCatalogue('2026-10-30')]) assert.equal(readSnowDepthTime(bad, time), 0);
});
test('legend accepts bounded PNG depth swatches only, excluding SWE and executable or remote image content', () => {
    for (const bad of [null, {}, { layers: {} }, { layers: [null] }]) assert.deepEqual(readSnowDepthLegend(bad), []);
    const value = snowDepthLegend();
    assert.deepEqual(readSnowDepthLegend(value).slice(0, 3).map(entry => entry.label), ['0–0.39 in', '0.39–2.0 in', '2.0–3.9 in']);
    for (const patch of [{ label: '<img>' }, { imageData: 'https://example.com/image.png' }, { contentType: 'image/svg+xml' }, { imageData: 'A'.repeat(4097) }]) {
        const bad = snowDepthLegend(); Object.assign(bad.layers[0].legend[0], patch); assert.deepEqual(readSnowDepthLegend(bad), []);
    }
    const oversized = snowDepthLegend();
    const bytes = Buffer.from(oversized.layers[0].legend[0].imageData, 'base64'); bytes.writeUInt32BE(10000, 16);
    oversized.layers[0].legend[0].imageData = bytes.toString('base64'); assert.deepEqual(readSnowDepthLegend(oversized), []);
});
test('metadata is opt-in, credential-free, bounded and reused across ordinary updates', async () => {
    let now = Date.UTC(2026, 9, 30); const calls = [], statuses = [];
    const owner = createSnowDepthMetadata({ now: () => now, onStatus: value => statuses.push(value), fetchImpl: async (url, options) => {
        calls.push({ url, options }); return json(url.includes('/query?') ? snowDepthCatalogue(now) : snowDepthLegend());
    } });
    try {
        owner.update(false); await tick(); assert.equal(calls.length, 0);
        owner.update(true); await tick(); assert.equal(calls.length, 2); assert.equal(statuses.at(-1).analysisTime, now);
        for (const { url, options } of calls) {
            assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
            assert.equal(options.cache, 'no-cache'); assert.ok(!url.includes('geometry='));
        }
        owner.update(true); owner.update(false); owner.update(true); await tick(); assert.equal(calls.length, 2);
        now += 300001; owner.update(true); await tick(); assert.equal(calls.length, 4);
    } finally { owner.dispose(); }
});
test('off aborts held metadata and a stale completion cannot publish over a newer activation', async () => {
    const held = [], statuses = [], time = Date.UTC(2026, 9, 30);
    const owner = createSnowDepthMetadata({ now: () => time, onStatus: status => statuses.push(status), fetchImpl: (url, options) => new Promise(resolve => held.push({ url, options, resolve })) });
    try {
        owner.update(true); await tick(); owner.update(false); assert.equal(held[0].options.signal.aborted, true);
        owner.update(true); await tick(); assert.equal(held.length, 2);
        held[0].resolve(json(snowDepthCatalogue(time - 86400000))); await tick();
        assert.equal(held.length, 2, 'cancelled catalogue cannot request a legend');
        assert.equal(statuses.at(-1).metadataPending, true);
        held[1].resolve(json(snowDepthCatalogue(time))); await tick(); held[2].resolve(json(snowDepthLegend())); await tick();
        assert.equal(statuses.at(-1).analysisTime, time); assert.equal(statuses.at(-1).metadataPending, false);
    } finally { owner.dispose(); }
});
test('metadata rate limits are not replayed, and failure retains labelled last-known analysis details', async () => {
    let now = Date.now(), fail = false, calls = 0; const statuses = [];
    const owner = createSnowDepthMetadata({ now: () => now, onStatus: status => statuses.push(status), fetchImpl: async url => {
        calls++; return fail ? new Response('', { status: 429, headers: { 'retry-after': '600' } }) : json(url.includes('/query?') ? snowDepthCatalogue(now) : snowDepthLegend());
    } });
    try {
        owner.update(true); await tick(); const original = statuses.at(-1).analysisTime;
        fail = true; owner.retry(); await tick(); assert.equal(calls, 3); assert.equal(statuses.at(-1).metadataError, true); assert.equal(statuses.at(-1).analysisTime, original);
        owner.retry(); owner.update(false); owner.update(true); await tick(); assert.equal(calls, 3);
        now += 601000; fail = false; owner.retry(); await tick(); assert.equal(calls, 5); assert.equal(statuses.at(-1).metadataError, false);
    } finally { owner.dispose(); }
});
test('a metadata body deadline and response limit end pending without claiming a fresh analysis', async () => {
    for (const fetchImpl of [async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
        async () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } })]) {
        let completed; const completion = new Promise(resolve => { completed = resolve; });
        const statuses = [], owner = createSnowDepthMetadata({ timeoutMs: 10, onStatus: status => { statuses.push(status); if (status.metadataError) completed(); }, fetchImpl });
        try {
            owner.update(true);
            await completion;
            assert.equal(statuses.at(-1).metadataPending, false); assert.equal(statuses.at(-1).metadataError, true); assert.equal(statuses.at(-1).analysisTime, 0);
        } finally { owner.dispose(); }
    }
});
