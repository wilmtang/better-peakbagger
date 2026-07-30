// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The vector drape's style fetch, tested without MapLibre. What the frame does
// with a resolved style still needs a real renderer (npm run terrain:verify);
// everything below is the part that decides whether a style ever arrives.

import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainStyle as TerrainStyle } from '../../src/terrain/terrain-style.js';

const STYLE_URL = 'https://tiles.example.test/styles/liberty';
const style = (overrides = {}) => ({ version: 8, sources: {}, layers: [], ...overrides });
const respond = (body, { ok = true, status = 200 } = {}) => ({
    ok, status, json: async () => body,
});

test('a valid style document is fetched without credentials or a referrer', async () => {
    const calls = [];
    const loader = TerrainStyle.createVectorStyleLoader({
        styleUrl: STYLE_URL,
        fetch: async (url, init) => { calls.push({ url, init }); return respond(style()); },
    });

    assert.deepEqual(await loader.load(), style());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, STYLE_URL);
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
});

test('the style is fetched once per frame lifetime', async () => {
    let calls = 0;
    const loader = TerrainStyle.createVectorStyleLoader({
        styleUrl: STYLE_URL,
        fetch: async () => { calls += 1; return respond(style()); },
    });
    await Promise.all([loader.load(), loader.load()]);
    await loader.load();
    assert.equal(calls, 1);
});

test('a stalled style host fails on its deadline instead of leaving a blank drape', async () => {
    // The picker has already switched to the vector entry by the time this
    // resolves, so a host that accepts the connection and never answers used to
    // leave that entry selected with nothing drawn and no notice.
    const aborts = [];
    const loader = TerrainStyle.createVectorStyleLoader({
        styleUrl: STYLE_URL,
        timeoutMs: 10,
        fetch: (_url, init) => {
            init.signal?.addEventListener('abort', () => aborts.push(true));
            return new Promise(() => {});
        },
    });

    await assert.rejects(loader.load(), /deadline/i);
    assert.equal(aborts.length, 1, 'the stalled style socket must be released too');
});

test('a style body that stalls mid-parse also fails on the deadline', async () => {
    const loader = TerrainStyle.createVectorStyleLoader({
        styleUrl: STYLE_URL,
        timeoutMs: 10,
        fetch: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    });
    await assert.rejects(loader.load(), /deadline/i);
});

test('a failed attempt is forgotten so re-selecting the entry retries', async () => {
    let calls = 0;
    const loader = TerrainStyle.createVectorStyleLoader({
        styleUrl: STYLE_URL,
        fetch: async () => (++calls === 1 ? respond(null, { ok: false, status: 503 }) : respond(style())),
    });

    await assert.rejects(loader.load(), /503/);
    // A cached rejection would keep the drape broken for as long as the frame
    // stays open, with no way for the user to get it back.
    assert.deepEqual(await loader.load(), style());
    assert.equal(calls, 2);
});

test('anything that is not a style document is refused before it reaches the map', async () => {
    // An error page, a captive-portal interstitial, or a redirect to something
    // JSON-shaped must never be handed to map.addSource().
    const rejected = [
        null,
        {},
        style({ version: 7 }),
        style({ sources: null }),
        style({ sources: 'roads' }),
        style({ layers: {} }),
        style({ layers: undefined }),
    ];
    for (const body of rejected) {
        const loader = TerrainStyle.createVectorStyleLoader({
            styleUrl: STYLE_URL,
            fetch: async () => respond(body),
        });
        await assert.rejects(loader.load(), /Unexpected vector style shape/,
            `${JSON.stringify(body)} must not be treated as a style`);
    }
    assert.equal(TerrainStyle.isStyleDocument(style()), true);
});

test('a non-ok response names its status for the frame’s notice', async () => {
    for (const status of [403, 404, 500, 502]) {
        const loader = TerrainStyle.createVectorStyleLoader({
            styleUrl: STYLE_URL,
            fetch: async () => respond(null, { ok: false, status }),
        });
        await assert.rejects(loader.load(), new RegExp(String(status)));
    }
});

test('the loader refuses to be built without a style URL', () => {
    assert.throws(() => TerrainStyle.createVectorStyleLoader({}), TypeError);
    assert.throws(() => TerrainStyle.createVectorStyleLoader({ styleUrl: '' }), TypeError);
});
