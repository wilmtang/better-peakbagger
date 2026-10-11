import test from 'node:test';
import assert from 'node:assert/strict';
import { mountainTime } from '../../src/time/mountain-time.js';
import { weatherPeakWindow } from '../../src/weather/weather-week.js';
import { PEAK_WEATHER_MODELS, bestMatchPeakWeatherModel, eligiblePeakWeatherModels, resolvePeakWeatherModels } from '../../src/weather/peak-weather-models.js';
import { peakWeatherRequestUrl, validatePeakWeatherResponse, createPeakWeatherClient } from '../../src/weather/open-meteo-client.js';
import { weatherFixture, weatherModelFixture } from '../helpers/weather-fixture.mjs';

const summit = { latitude: 46.85, longitude: -121.76, elevation: 4391, nation: 'united states' };
const window = weatherPeakWindow(mountainTime.resolve(summit.latitude, summit.longitude), Date.parse('2026-10-11T12:00:00Z'));
const model = id => PEAK_WEATHER_MODELS.find(item => item.id === id);
const fixture = ids => weatherModelFixture(weatherFixture({ ...summit, startDate: window.startDate,
    hours: (Date.parse(window.endDate) - Date.parse(window.startDate)) / 3600_000 + 24 }), ids);

test('peak Best Match respects country, projected coverage, archive dates and the longest forecast horizon', () => {
    for (const [subject, expected] of [
        [summit, 'gfs_hrrr'],
        [{ ...summit, latitude: 49.25, longitude: -123.1, nation: 'canada' }, 'gem_hrdps_continental'],
        [{ ...summit, latitude: 63, longitude: -150 }, 'ecmwf_ifs'],
        [{ ...summit, latitude: 19.8, longitude: -155.5 }, 'ecmwf_ifs'],
        [{ ...summit, nation: null }, 'ecmwf_ifs'],
        [{ ...summit, latitude: 45.9, longitude: 6.9, nation: 'france' }, 'ecmwf_ifs'],
    ]) {
        assert.equal(bestMatchPeakWeatherModel(subject, window, 'past').id, expected);
        assert.equal(bestMatchPeakWeatherModel(subject, window, 'forecast').id, 'gfs_global');
    }
    const early = weatherPeakWindow(window.zone, Date.parse('2018-01-05T12:00:00Z'));
    assert.equal(bestMatchPeakWeatherModel(summit, early, 'past').id, 'ecmwf_ifs');
    assert.ok(!eligiblePeakWeatherModels(summit, early, 'past').includes(model('gfs_hrrr')));
    assert.ok(eligiblePeakWeatherModels(summit, early, 'forecast').includes(model('gfs_hrrr')));
    assert.ok(!eligiblePeakWeatherModels(summit, window, 'past').some(item => item.id.includes('era5')));
    assert.throws(() => resolvePeakWeatherModels(summit, window, { past: 'best_match', forecast: 'icon_d2' }), /does not cover/);
});

test('one bounded named-model request splits suffix columns without confusing history and forecast', () => {
    const models = [model('gfs_hrrr'), model('gfs_global')], body = fixture(models.map(item => item.id));
    body.hourly.temperature_2m_gfs_hrrr.fill(-10); body.hourly.temperature_2m_gfs_global.fill(20);
    const url = new URL(peakWeatherRequestUrl(summit, window, models));
    assert.equal(url.searchParams.get('models'), 'gfs_hrrr,gfs_global');
    assert.equal(url.searchParams.get('start_date'), window.startDate);
    const result = validatePeakWeatherResponse(body, summit, window, models);
    assert.equal(result.sharedGrid, true);
    assert.ok(result.models.gfs_hrrr.samples.every(row => row.temperature === -10));
    assert.ok(result.models.gfs_global.samples.every(row => row.temperature === 20));
    const single = validatePeakWeatherResponse(fixture(['gfs_global']), summit, window, [model('gfs_global')]);
    assert.equal(single.sharedGrid, false); assert.ok(single.models.gfs_global.samples.length);
    for (const invalid of [[], [models[0], models[0]], [...models, model('icon_global')], [{ ...models[0] }]]) {
        assert.throws(() => peakWeatherRequestUrl(summit, window, invalid), { code: 'invalid' });
    }
    assert.throws(() => validatePeakWeatherResponse(fixture(['gfs_global']), summit, window, models), { code: 'invalid-response' });
    body.hourly_units.temperature_2m_gfs_global = '°F';
    assert.throws(() => validatePeakWeatherResponse(body, summit, window, models), { code: 'invalid-response' });
});

test('named-model cache keys separate selections while sharing the rate-limit cooldown', async () => {
    let calls = 0, limited = false;
    const client = createPeakWeatherClient({ now: () => 1000, fetchFn: url => {
        calls++;
        return limited ? new Response('', { status: 429, headers: { 'retry-after': '120' } })
            : new Response(JSON.stringify(fixture(new URL(url).searchParams.get('models').split(','))), { headers: { 'content-type': 'application/json' } });
    } });
    await client.request(summit, window, [model('gfs_global')]);
    await client.request(summit, window, [model('gfs_hrrr'), model('gfs_global')]);
    await client.request(summit, window, [model('gfs_global')]); assert.equal(calls, 2);
    limited = true;
    await assert.rejects(client.request(summit, window, [model('icon_global')]), { code: 'rate-limit' });
    client.clear();
    await assert.rejects(client.request(summit, window, [model('ecmwf_ifs')]), { code: 'rate-limit' });
    assert.equal(calls, 3);
});
