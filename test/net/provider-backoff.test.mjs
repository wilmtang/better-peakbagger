// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherClient } from '../../src/weather/open-meteo-client.js';
import { WEATHER_MODELS } from '../../src/weather/weather-models.js';
import { createPeakModelUpdateClient } from '../../src/weather/peak-weather-updates.js';
import { createSnotelClient } from '../../src/snow/snotel-client.js';
import { terrainStyle } from '../../src/terrain/terrain-style.js';
import { terrainCache } from '../../src/terrain/terrain-cache.js';

const create = (name, fetchFn, now) => {
    if (name === 'weather') {
        const client = createWeatherClient({ fetchFn, now });
        return { request: index => client.request({ latitude: 47, longitude: -121, elevation: null },
            { startDate: '2026-10-01', endDate: '2026-10-01' }, WEATHER_MODELS[index]) };
    }
    if (name === 'metadata') {
        const client = createPeakModelUpdateClient({ fetchFn, now });
        return { request: index => client.request(['ncep_gfs013', 'ecmwf_ifs', 'dwd_icon', 'ncep_gfs025'][index]) };
    }
    if (name === 'snow') {
        const client = createSnotelClient({ fetchFn, now });
        return { request: index => client.observations({ id: `${679 + index}:WA:SNTL` }) };
    }
    if (name === 'style') {
        const client = terrainStyle.createVectorStyleLoader({ fetch: fetchFn, styleUrl: 'https://tiles.openfreemap.org/styles/liberty' });
        return { request: () => client.load() };
    }
    const client = terrainCache.create({ limitMb: 0, fetchFn, now });
    return { request: index => client.load({ url: `bpb-dem://2/${index}/0.webp` }), close: () => client.close() };
};
const refusal = async (client, index) => {
    try { return await client.request(index); }
    catch (error) { assert.equal(error.code, 'rate-limit'); return error; }
};

for (const name of ['weather', 'metadata', 'snow', 'style', 'dem']) {
    test(`${name} shares a bounded cooldown across requests and resumes at expiry`, async t => {
        let time = Date.now();
        t.mock.method(Date, 'now', () => time);
        for (const header of [null, 'invalid', '60']) await t.test(`Retry-After: ${header}`, async () => {
            let calls = 0;
            const client = create(name, async () => {
                calls++;
                return new Response('', { status: 429, headers: header === null ? {} : { 'retry-after': header } });
            }, () => time);
            try {
                const first = await refusal(client, 0);
                const deadline = time + (header === '60' ? 60000 : 300000);
                if (name !== 'metadata') assert.equal(first.retryAt, deadline);
                await refusal(client, 1);
                assert.equal(calls, 1, 'a different model, domain, station or tile cannot bypass the cooldown');
                time = deadline;
                await refusal(client, 2);
                assert.equal(calls, 2, 'the service becomes available to request at the deadline');
            } finally { await client.close?.(); }
        });
    });
}

for (const name of ['weather', 'metadata', 'snow', 'dem']) {
    test(`${name} retains the longer refusal when concurrent responses finish out of order`, async t => {
        let time = Date.now();
        const held = []; let calls = 0;
        const client = create(name, () => {
            if (++calls > 2) return Promise.resolve(new Response('', { status: 429 }));
            return new Promise(resolve => held.push(resolve));
        }, () => time);
        t.after(() => client.close?.());
        const first = refusal(client, 0), second = refusal(client, 1);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(held.length, 2, 'both provider requests started before any refusal');
        held[0](new Response('', { status: 429, headers: { 'retry-after': '600' } }));
        const original = await first;
        held[1](new Response('', { status: 429, headers: { 'retry-after': '1' } }));
        await second;
        time += 2000;
        const result = await refusal(client, 2);
        assert.equal(calls, 2, 'a shorter response must not open a new provider request');
        if (name !== 'metadata') {
            assert.equal(result.retryAt, time - 2000 + 600000);
            assert.equal(result.message, original.message, 'the explanation must retain the same longer deadline');
        }
    });
}
