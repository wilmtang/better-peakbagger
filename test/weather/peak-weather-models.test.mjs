import test from 'node:test';
import assert from 'node:assert/strict';
import { mountainTime } from '../../src/time/mountain-time.js';
import { weatherPeakWindow, summarizeWeatherWeek } from '../../src/weather/weather-week.js';
import { PEAK_BEST_MATCH, PEAK_WEATHER_MODELS, eligiblePeakWeatherModels, resolvePeakWeatherModels } from '../../src/weather/peak-weather-models.js';
import { ARCHIVE_BEST_MATCH } from '../../src/weather/weather-models.js';
import { weatherRequestUrl, peakWeatherRequestUrl, validatePeakWeatherResponse, createPeakWeatherClient } from '../../src/weather/open-meteo-client.js';
import { weatherFixture, weatherModelFixture } from '../helpers/weather-fixture.mjs';

const summit = { latitude: 46.85, longitude: -121.76, elevation: 4391, nation: 'united states' };
const window = weatherPeakWindow(mountainTime.resolve(summit.latitude, summit.longitude), Date.parse('2026-10-11T12:00:00Z'));
const model = id => PEAK_WEATHER_MODELS.find(item => item.id === id);
const fixture = ids => weatherModelFixture(weatherFixture({ ...summit, startDate: window.startDate,
    hours: (Date.parse(window.endDate) - Date.parse(window.startDate)) / 3600_000 + 24 }), ids);

test('peak model selection requires eligible models and GFS covers the full forecast', () => {
    const choices = resolvePeakWeatherModels(summit, window, { past: 'gfs_global', forecast: 'gfs_global' });
    assert.equal(choices.forecast.forecastDays, 16);
    assert.equal(choices.past, choices.forecast);
    const early = weatherPeakWindow(window.zone, Date.parse('2018-01-05T12:00:00Z'));
    assert.ok(!eligiblePeakWeatherModels(summit, early, 'past').includes(model('gfs_hrrr')));
    assert.ok(eligiblePeakWeatherModels(summit, early, 'forecast').includes(model('gfs_hrrr')));
    assert.ok(!eligiblePeakWeatherModels(summit, window, 'past').some(item => item.id.includes('era5')));
    for (const forecast of ['icon_d2', 'not_a_model']) {
        assert.throws(() => resolvePeakWeatherModels(summit, window, { past: 'gfs_global', forecast }), /does not cover/);
    }
});

test('peak Best Match is first in both periods and retains forecast rather than archive contracts', () => {
    for (const period of ['past', 'forecast']) assert.equal(eligiblePeakWeatherModels(summit, window, period)[0], PEAK_BEST_MATCH);
    const choices = resolvePeakWeatherModels(summit, window, { past: 'best_match', forecast: 'best_match' });
    assert.equal(choices.forecast, PEAK_BEST_MATCH); assert.equal(choices.past, PEAK_BEST_MATCH);
    assert.notEqual(PEAK_BEST_MATCH, ARCHIVE_BEST_MATCH);
    assert.equal(PEAK_BEST_MATCH.forecastDays, 16); assert.equal(PEAK_BEST_MATCH.resolution, 'Automatic');
    assert.equal(PEAK_BEST_MATCH.since, null); assert.equal(PEAK_BEST_MATCH.gustTiming, 'preceding-hour');
    const url = new URL(peakWeatherRequestUrl(summit, window, [PEAK_BEST_MATCH]));
    assert.equal(url.host, 'api.open-meteo.com'); assert.equal(url.searchParams.get('models'), 'best_match');
    assert.equal(url.searchParams.get('start_date'), window.startDate);
    assert.throws(() => peakWeatherRequestUrl(summit, window, [ARCHIVE_BEST_MATCH]), { code: 'invalid' });
    assert.throws(() => weatherRequestUrl(summit, window, PEAK_BEST_MATCH), { code: 'invalid' });
});

test('Best Match decodes plain and model-suffixed responses without borrowing named readings', () => {
    for (const ids of [['best_match'], ['best_match', 'gfs_global']]) {
        const models = ids.map(model), body = fixture(ids);
        const temperature = ids.length === 1 ? 'temperature_2m' : 'temperature_2m_best_match';
        body.hourly[temperature].fill(5);
        if (ids.length > 1) body.hourly.temperature_2m_gfs_global.fill(10);
        const result = validatePeakWeatherResponse(body, summit, window, models);
        assert.equal(result.models.best_match.samples[0].temperature, 5);
        assert.equal(result.models.best_match.gustTiming, 'preceding-hour');
        if (ids.length > 1) assert.equal(result.models.gfs_global.samples[0].temperature, 10);
        delete body.hourly[temperature];
        assert.throws(() => validatePeakWeatherResponse(body, summit, window, models), { code: 'invalid-response' });
    }
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

test('Fuji negative ARPEGE precipitation is floored at zero and retains complete weather coverage', async () => {
    const fuji = { latitude: 35.360638, longitude: 138.727347, elevation: 3776 };
    const range = weatherPeakWindow(mountainTime.resolve(fuji.latitude, fuji.longitude), Date.parse('2026-10-12T04:00:00Z'));
    for (const ids of [['meteofrance_arpege_world'], ['gfs_global', 'meteofrance_arpege_world']]) {
        const body = weatherModelFixture(weatherFixture({ ...fuji, startDate: range.startDate, hours: 792 }), ids);
        const key = ids.length === 1 ? 'precipitation' : 'precipitation_meteofrance_arpege_world';
        assert.equal(new Date(body.hourly.time[45] * 1000).toISOString(), '2026-09-26T21:00:00.000Z');
        body.hourly[key][45] = -0.1;
        const client = createPeakWeatherClient({ fetchFn: async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) });
        const result = await client.request(fuji, range, ids.map(model));
        const arpege = result.models.meteofrance_arpege_world;
        assert.equal(arpege.samples[45].precipitation, 0);
        assert.equal(arpege.samples[45].temperature, body.hourly[ids.length === 1 ? 'temperature_2m' : 'temperature_2m_meteofrance_arpege_world'][45]);
        const past = summarizeWeatherWeek(arpege, range.past), forecast = summarizeWeatherWeek(arpege, range.forecast);
        assert.equal(past.filter(day => day.useful).length, 16);
        assert.equal(forecast.filter(day => day.useful).length, 16);
        const affected = past.find(day => day.window.date === '2026-09-27');
        assert.equal(affected.precipitation.complete, true);
        assert.equal(affected.partial, false);
        assert.ok(affected.precipitation.total >= 0);
        assert.equal(affected.precipitationHours.filter(hour => hour.value === null).length, 0);
        if (result.models.gfs_global) assert.equal(result.models.gfs_global.samples[45].precipitation, body.hourly.precipitation_gfs_global[45]);
        assert.equal(body.hourly[key][45], -0.1);
    }
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

test('peak-only fields are bounded, unit-checked and retain missing values', () => {
    const models = [model('gfs_global')];
    const url = new URL(peakWeatherRequestUrl(summit, window, models));
    assert.match(url.searchParams.get('hourly'), /apparent_temperature,wind_direction_10m,is_day/);
    const body = fixture(['gfs_global']); body.hourly.apparent_temperature[0] = null;
    assert.equal(validatePeakWeatherResponse(body, summit, window, models).models.gfs_global.samples[0].apparent, null);
    for (const [field, value] of [['apparent_temperature', 101], ['wind_direction_10m', -1], ['wind_direction_10m', 361], ['is_day', .5]]) {
        const invalid = fixture(['gfs_global']); invalid.hourly[field][0] = value;
        assert.throws(() => validatePeakWeatherResponse(invalid, summit, window, models), { code: 'invalid-response' });
    }
    body.hourly_units.wind_direction_10m = 'rad';
    assert.throws(() => validatePeakWeatherResponse(body, summit, window, models), { code: 'invalid-response' });
});
