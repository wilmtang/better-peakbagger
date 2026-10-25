import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudAtElevation, predictModelCloud, predictSummitCloud } from '../../src/weather/summit-cloud-core.js';
import { SUMMIT_CLOUD_MODELS, summitCloudModel, resolveSummitCloudModels } from '../../src/weather/summit-cloud-models.js';
import { summitCloudRequest, readSummitCloudResponse, createSummitCloudClient } from '../../src/weather/summit-cloud-client.js';
import { cloudSubject as subject, cloudTime as time, cloudDataset, cloudResponse } from '../helpers/summit-cloud-fixture.mjs';

const model = summitCloudModel('gfs_global'), day = { start: time, end: time + 24 * 3600000 };
const predict = data => predictModelCloud(data, subject, time, time);
const setProfile = (point, values) => point.samples.forEach(sample => sample.levels.forEach(level => Object.assign(level, values)));
test('profile capabilities and explicit automatic comparison stay separate from surface feeds', () => {
    assert.equal(SUMMIT_CLOUD_MODELS.length, 12);
    assert.equal(summitCloudModel('ecmwf_ifs'), undefined);
    assert.deepEqual(resolveSummitCloudModels(subject, 'auto', 0).map(x => x.id), ['gfs_hrrr', 'gem_hrdps_continental']);
    assert.deepEqual(resolveSummitCloudModels(subject, 'auto', 3).map(x => x.id), ['gfs_global', 'ecmwf_ifs025']);
    assert.throws(() => resolveSummitCloudModels({ latitude: 60, longitude: 10 }, 'gfs_hrrr'));
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
    const at = cloudAtElevation(sample, 2500); assert.ok(at.direction < 1 || at.direction > 359);
    const data = cloudDataset();
    data.points[0].samples[0].levels.push({ height: 3350, cloud: 100, humidity: 100, temperature: 0, wind: 5, direction: 270 });
    assert.notEqual(predict(data).key, 'clear');
});
test('freshness, unavailable comparison and model disagreement downgrade the prediction', () => {
    const stale = cloudDataset(); stale.metadata.lastUpdate -= 24 * 3600000; assert.equal(predict(stale).key, 'uncertain');
    const cma = cloudDataset({ model: summitCloudModel('cma_grapes_global') }); cma.metadata = null; assert.equal(predict(cma).key, 'uncertain');
    assert.equal(predictSummitCloud([cloudDataset(), cloudDataset({ cloud: 95, humidity: 95 })], subject, time, time).key, 'uncertain');
    assert.equal(predictSummitCloud([cloudDataset()], subject, time, time, 2).key, 'uncertain');
    assert.equal(predictSummitCloud([], subject, time, time, 2).key, 'unavailable');
});
test('bounded multi-point requests preserve 23/25 hour UTC identities and missing units', () => {
    for (const hours of [23, 25]) {
        const request = summitCloudRequest(subject, { start: time, end: time + hours * 3600000 }, model);
        const url = new URL(request.url); assert.equal(url.searchParams.get('models'), 'gfs_global');
        assert.equal(url.searchParams.get('latitude').split(',').length, 5); assert.equal(url.searchParams.get('elevation'), 'nan,nan,nan,nan,nan');
        const body = cloudResponse(request); const result = readSummitCloudResponse(body, request);
        assert.equal(result.points[0].samples.length, hours);
        body[0].hourly_units.cloud_cover_850hPa = 'wrong';
        assert.equal(readSummitCloudResponse(body, request).points[0].samples[0].levels.find(l => l.pressure === 850).cloud, null);
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
            calls++; assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
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
    const pending = client.request(subject, day, model, { signal: controller.signal }); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    let count = 0;
    const limited = createSummitCloudClient({ now: () => time, fetchFn: async () => { count++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); } });
    await assert.rejects(limited.request(subject, day, model), { code: 'rate-limit' });
    await assert.rejects(limited.request(subject, day, model), { code: 'rate-limit' }); assert.equal(count, 1);
});
