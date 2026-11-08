import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cloudAtElevation, predictModelCloud, predictSummitCloud, type CloudDataset } from '../../src/weather/summit-cloud-core.ts';
import { SUMMIT_CLOUD_MODELS, summitCloudModel, resolveSummitCloudModels } from '../../src/weather/summit-cloud-models.ts';
import { summitCloudRequest, readSummitCloudResponse, createSummitCloudClient } from '../../src/weather/summit-cloud-client.js';
import { cloudSubject as subject, cloudTime as time, cloudDataset, cloudResponse } from '../helpers/summit-cloud-fixture.mjs';

const model = summitCloudModel('gfs_global'), day = { start: time, end: time + 24 * 3600000 };
type Dataset = ReturnType<typeof cloudDataset>;
type Point = Dataset['points'][number];
const asDataset = (data: Dataset) => data as unknown as CloudDataset;
const predict = (data: Dataset) => predictModelCloud(asDataset(data), subject, time, time);
const setProfile = (point: Point, values: Record<string, unknown>) => point.samples.forEach(sample => sample.levels.forEach(level => Object.assign(level, values)));
test('profile capabilities and explicit automatic comparison stay separate from surface feeds', () => {
    assert.equal(SUMMIT_CLOUD_MODELS.length, 12);
    assert.equal(summitCloudModel('ecmwf_ifs'), undefined);
    assert.deepEqual(resolveSummitCloudModels(subject, 'auto', 0).map(x => x.id), ['gfs_hrrr', 'gem_hrdps_continental']);
    assert.deepEqual(resolveSummitCloudModels(subject, 'auto', 3).map(x => x.id), ['gfs_global', 'ecmwf_ifs025']);
    assert.throws(() => resolveSummitCloudModels({ latitude: 60, longitude: 10 }, 'gfs_hrrr'));
});
test('each model requests only the pressure levels the saved capability probe found complete', async () => {
    const evidence = JSON.parse(await readFile(new URL('../../docs/plans/evidence/summit-cloud-humidity-basis.json', import.meta.url), 'utf8'));
    for (const { id, levels } of SUMMIT_CLOUD_MODELS) {
        assert.deepEqual(levels.filter((level: number) => evidence.models[id].levels.missing.includes(level)), [], id);
        assert.deepEqual([...levels].sort((left, right) => right - left), [...levels], id);
    }
    // 625 hPa is what brackets Longs Peak (4346 m) above HRRR's 3786 m terrain.
    assert.ok(summitCloudModel('gfs_hrrr')!.levels.includes(625));
});
test('clear, inside, surrounding cloud and incoming moist air use actual profiles', () => {
    assert.equal(predict(cloudDataset()).key, 'clear');
    assert.equal(predict(cloudDataset({ cloud: 95, humidity: 98 })).key, 'inside');
    const surrounding = cloudDataset(); surrounding.points.slice(1).forEach(p => setProfile(p, { cloud: 90, humidity: 95 }));
    assert.equal(predict(surrounding).key, 'blocked');
    const incoming = cloudDataset(); setProfile(incoming.points[4], { humidity: 90 });
    assert.equal(predict(incoming).key, 'partial'); assert.equal(predict(incoming).lift, true);
    const patchy = cloudDataset(); setProfile(patchy.points[1], { cloud: 45, humidity: 82 });
    assert.equal(predict(patchy).key, 'partial');
});
test('missing layers, below ground, sparse brackets and missing airflow never become clear', () => {
    for (const key of ['height', 'humidity', 'cloud', 'temperature']) {
        const data = cloudDataset(); setProfile(data.points[0], { [key]: null });
        assert.equal(predict(data).key, 'unavailable', key);
    }
    const data = cloudDataset(); data.points[0].grid.elevation = 3000;
    assert.equal(predict(data).key, 'unavailable');
    assert.equal(cloudAtElevation({ levels: [{ height: 0, humidity: 20, cloud: 0, temperature: 10 }, { height: 4000, humidity: 20, cloud: 0, temperature: 0 }] }, 2870), null);
    const wind = cloudDataset(); setProfile(wind.points[0], { direction: null }); assert.equal(predict(wind).key, 'uncertain');
    const duplicate = cloudDataset(); duplicate.points.forEach(p => { p.grid = duplicate.points[0].grid; });
    assert.equal(predict(duplicate).key, 'uncertain');
});
test('wind interpolation crosses north and thin cloud layers cannot be diluted into clear', () => {
    const sample = { levels: [
        { height: 2000, cloud: 5, humidity: 50, temperature: 5, wind: 10, direction: 350 },
        { height: 3000, cloud: 5, humidity: 50, temperature: 0, wind: 10, direction: 10 },
    ] };
    const at = cloudAtElevation(sample, 2500); assert.ok(at); assert.ok(at.direction !== null && (at.direction < 1 || at.direction > 359));
    const data = cloudDataset();
    data.points[0]!.samples[0]!.levels.push({ pressure: 660, height: 3350, cloud: 100, humidity: 100, temperature: 0, wind: 5, direction: 270 });
    assert.notEqual(predict(data).key, 'clear');
});
test('water-referenced humidity cannot read saturated cold air as dry', () => {
    const iceSaturated = { temperature: -30, humidity: 75, cloud: 15 };
    const water = cloudDataset({ model: summitCloudModel('gem_regional') }); water.points.forEach(p => setProfile(p, iceSaturated));
    assert.equal(predict(water).key, 'inside');
    const reading = predict(water).summit!;
    assert.equal(Math.round(reading.humidity), 75, 'the reported humidity stays reported');
    assert.ok(reading.saturation > 99 && reading.cloud > 90);
    // The same numbers on a model whose humidity reaches 100% in cold air really are dry.
    const saturation = cloudDataset(); saturation.points.forEach(p => setProfile(p, iceSaturated));
    assert.equal(predict(saturation).key, 'clear');
    assert.equal(predict(saturation).summit!.saturation, 75);
    // Above freezing the adjustment changes nothing.
    const warm = cloudDataset({ model: summitCloudModel('gem_regional') }); warm.points.forEach(p => setProfile(p, { temperature: 4, humidity: 75, cloud: 15 }));
    assert.equal(predict(warm).summit!.cloud, 15); assert.equal(predict(warm).summit!.saturation, 75);
    assert.equal(predict(warm).key, 'clear');
});
test('captured HRRR profile near -10 C reads as inside cloud', () => {
    // Mount Rainier, 2026-11-09T13Z, live: 92% humidity interpolates to about 51% derived cloud.
    const rainier = { ...subject, elevation: 4392 };
    const data = cloudDataset({ model: summitCloudModel('gfs_hrrr') }); data.points[0]!.grid.elevation = 3467;
    data.points[0]!.samples[0]!.levels = [
        { pressure: 700, height: 3027, humidity: 78, cloud: 13, temperature: -6.1, wind: 13.28, direction: 217 },
        { pressure: 600, height: 4223, humidity: 94, cloud: 54, temperature: -10.5, wind: 22.07, direction: 226 },
        { pressure: 500, height: 5607, humidity: 84, cloud: 28, temperature: -18.2, wind: 24.04, direction: 235 },
    ];
    assert.equal(predictModelCloud(asDataset(data), rainier, time, time).key, 'inside');
});
test('cold-air adjustment does not compound on the cached profile across repaints', () => {
    const data = cloudDataset({ model: summitCloudModel('icon_global') }); data.points.forEach(p => setProfile(p, { temperature: -30, humidity: 60, cloud: 0 }));
    const before = JSON.stringify(data.points);
    const first = predict(data), second = predict(data);
    assert.equal(JSON.stringify(data.points), before);
    assert.deepEqual(first.summit, second.summit); assert.equal(first.key, second.key);
    assert.ok(first.summit!.saturation < 85, '60% over water at -30 C is not saturated');
});
test('neighbors, the moist-air check and nearby layers read the adjusted values too', () => {
    const surrounding = cloudDataset({ model: summitCloudModel('gem_regional') });
    surrounding.points.forEach(p => setProfile(p, { temperature: -30, humidity: 50, cloud: 0 }));
    surrounding.points.slice(1).forEach(p => setProfile(p, { humidity: 75, cloud: 15 }));
    assert.equal(predict(surrounding).key, 'blocked');
    const incoming = cloudDataset({ model: summitCloudModel('gem_regional') });
    incoming.points.forEach(p => setProfile(p, { temperature: -30, humidity: 50, cloud: 0 }));
    setProfile(incoming.points[4]!, { humidity: 66 });
    assert.equal(predict(incoming).lift, true);
    const layer = cloudDataset({ model: summitCloudModel('gem_regional') });
    layer.points.forEach(p => setProfile(p, { temperature: -30, humidity: 50, cloud: 0 }));
    layer.points[0]!.samples[0]!.levels.push({ pressure: 660, height: 3350, cloud: 15, humidity: 75, temperature: -30, wind: 6, direction: 270 });
    assert.notEqual(predict(layer).key, 'clear');
});
test('terrain near summit height is no lift, while unresolved lower air stays uncertain', () => {
    const noRise = cloudDataset(); noRise.points[4]!.grid.elevation = 2700;
    assert.equal(predict(noRise).key, 'clear');
    assert.equal(predict(noRise).lift, false);
    const moist = cloudDataset(); moist.points[4]!.grid.elevation = 2200;
    moist.points[4]!.samples[0]!.levels.find(level => level.height === 2600)!.humidity = 90;
    assert.equal(predict(moist).lift, true); assert.equal(predict(moist).key, 'partial');
    const unresolved = cloudDataset(); unresolved.points[4]!.samples[0]!.levels = [
        { pressure: 925, height: 1000, cloud: 5, humidity: 55, temperature: 8, wind: 6, direction: 270 },
        { pressure: 600, height: 4000, cloud: 5, humidity: 55, temperature: -8, wind: 6, direction: 270 },
    ];
    assert.equal(predict(unresolved).key, 'uncertain');
    const elbert = { ...subject, elevation: 4401 };
    const plateau = cloudDataset({ model: summitCloudModel('gfs_hrrr') });
    const heights = new Map([[700, 3100], [675, 3420], [650, 3761], [625, 4080], [600, 4402], [500, 5800]]);
    plateau.points.forEach(point => { point.grid.elevation = 3817; point.samples[0]!.levels = point.samples[0]!.levels.filter(level => heights.has(level.pressure)); point.samples[0]!.levels.forEach(level => { level.height = heights.get(level.pressure)!; }); });
    assert.equal(predictModelCloud(asDataset(plateau), elbert, time, time).key, 'clear');
});
test('freshness, unavailable comparison and model disagreement downgrade the prediction', () => {
    const stale = cloudDataset(); stale.metadata.lastUpdate -= 24 * 3600000; assert.equal(predict(stale).key, 'uncertain');
    const cma = cloudDataset({ model: summitCloudModel('cma_grapes_global') }); Object.assign(cma, { metadata: null }); assert.equal(predict(cma).key, 'uncertain');
    assert.equal(predictSummitCloud([asDataset(cloudDataset()), asDataset(cloudDataset({ cloud: 95, humidity: 95 }))], subject, time, time).key, 'uncertain');
    assert.equal(predictSummitCloud([asDataset(cloudDataset())], subject, time, time, 2).key, 'uncertain');
    assert.equal(predictSummitCloud([], subject, time, time, 2).key, 'unavailable');
});
test('bounded multi-point requests preserve 23/25 hour UTC identities and missing units', () => {
    for (const hours of [23, 25]) {
        const request = summitCloudRequest(subject, { start: time, end: time + hours * 3600000 }, model);
        const url = new URL(request.url); assert.equal(url.searchParams.get('models'), 'gfs_global');
        assert.equal(url.searchParams.get('latitude')!.split(',').length, 5); assert.equal(url.searchParams.get('elevation'), 'nan,nan,nan,nan,nan');
        const body = cloudResponse(request); const result = readSummitCloudResponse(body, request);
        assert.equal(result.points[0].samples.length, hours);
        body[0].hourly_units.cloud_cover_850hPa = 'wrong';
        assert.equal(readSummitCloudResponse(body, request).points[0].samples[0].levels.find((l: { pressure: number }) => l.pressure === 850).cloud, null);
        body[0].hourly.time[1] = body[0].hourly.time[0]; assert.throws(() => readSummitCloudResponse(body, request));
    }
    assert.throws(() => summitCloudRequest(null, day, model));
    assert.throws(() => summitCloudRequest({ ...subject, elevation: null }, day, model));
    assert.throws(() => summitCloudRequest(subject, { start: time, end: time + 27 * 3600000 }, model));
});
test('client bounds transport, caches successful data, and preserves profiles if metadata fails', async () => {
    let calls = 0;
    const client = createSummitCloudClient({ now: () => time, updateClient: { clear() {}, request: async () => { throw new Error('offline'); } },
        fetchFn: async (url, options) => {
            calls++; assert.equal(options!.credentials, 'omit'); assert.equal(options!.referrerPolicy, 'no-referrer'); assert.equal(options!.redirect, 'error');
            assert.equal(url, summitCloudRequest(subject, day, model).url);
            return new Response(JSON.stringify(cloudResponse(summitCloudRequest(subject, day, model))), { headers: { 'content-type': 'application/json' } });
        } });
    const first = await client.request(subject, day, model); assert.equal(first.metadata, null);
    assert.equal(await client.request(subject, day, model), first); assert.equal(calls, 1);
    await client.request(subject, day, model, { refresh: true }); assert.equal(calls, 2);
});
test('abort settles even for nonconforming transports and 429 prevents repeated requests', async () => {
    const controller = new AbortController();
    const client = createSummitCloudClient({ fetchFn: () => new Promise(() => {}) });
    const pending = client.request(subject, day, model!, { signal: controller.signal } as { refresh?: boolean }); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    let count = 0;
    const limited = createSummitCloudClient({ now: () => time, fetchFn: async () => { count++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); } });
    await assert.rejects(limited.request(subject, day, model), { code: 'rate-limit' });
    await assert.rejects(limited.request(subject, day, model), { code: 'rate-limit' }); assert.equal(count, 1);
});
