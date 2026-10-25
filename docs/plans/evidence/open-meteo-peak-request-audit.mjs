// Audit probe only: no live network, runtime changes, or browser launches.
// Run npm run build first, then node docs/plans/evidence/open-meteo-peak-request-audit.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { settingsSchema } from '../../../src/settings/settings-schema.js';
import { weatherFixture, weatherModelFixture } from '../../../test/helpers/weather-fixture.mjs';
import { cloudResponseForUrl } from '../../../test/helpers/summit-cloud-fixture.mjs';
import { airQualityFixture } from '../../../test/helpers/air-quality-fixture.mjs';

if (process.argv.length !== 2) throw new Error('This audit probe takes no arguments.');
const roots = ['src/weather/peak-weather.js', 'src/weather/summit-cloud.js', 'src/maps/peak-cards.js'];
const builds = await Promise.all(roots.map(entry => build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', metafile: true })));
const bundlePaths = ['dist/content/peak-weather.js', 'dist/content/summit-cloud.js', 'dist/content/peak-cards.js'];
const bundles = await Promise.all(bundlePaths.map(file => readFile(file, 'utf8')));
const bundleSha256 = Object.fromEntries(bundlePaths.map((file, index) => [file, createHash('sha256').update(bundles[index]).digest('hex')]));
const inputs = [...new Set(builds.flatMap(result => Object.keys(result.metafile.inputs)))].sort();
const sourceHash = createHash('sha256');
for (const input of inputs) sourceHash.update(input).update('\0').update(await readFile(input)).update('\0');
const html = await readFile('test/fixtures/pages/peak-rainier.html', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = async condition => {
    const end = Date.now() + 5000;
    while (!condition()) { if (Date.now() > end) throw new Error('Audit condition did not settle'); await tick(); }
};
const results = [];
function setup(preferences = {}, { limitedCloud = false } = {}) {
    const dom = new JSDOM(html, { url: 'https://www.peakbagger.com/peak.aspx?pid=2296', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window, doc = win.document, calls = [], observers = [], listeners = new Set();
    let clock = Date.parse('2026-10-24T18:00:00Z'), stored = settingsSchema.clean(preferences);
    const NativeDate = win.Date;
    win.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
    Object.assign(win, { AbortController, TextDecoder, TextEncoder, scrollBy() {} });
    win.chrome = { storage: { sync: { get: async () => ({ bpbSettings: stored }) }, local: { get: async () => ({}) }, onChanged: {
        addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    } }, runtime: { sendMessage: async message => {
        const oldValue = stored; stored = settingsSchema.clean({ ...stored, ...message.patch });
        listeners.forEach(fn => fn({ bpbSettings: { oldValue, newValue: stored } }, 'sync'));
        return { ok: true, settings: stored };
    } } };
    win.IntersectionObserver = class {
        constructor(fn) { this.fn = fn; observers.push(this); }
        observe(target) { this.target = target; this.connected = true; }
        disconnect() { this.connected = false; }
    };
    win.fetch = async (input, init) => {
        const url = new URL(input), q = url.searchParams;
        const kind = url.pathname.startsWith('/data/') ? 'metadata' : url.hostname.startsWith('air-quality-api.') ? 'airQuality'
            : q.get('hourly')?.includes('hPa') ? 'cloud' : 'weather';
        calls.push({ kind, url: url.href, cache: init.cache });
        if (kind === 'cloud' && limitedCloud) return new Response('', { status: 429, headers: { 'retry-after': '60' } });
        let body;
        if (kind === 'metadata') body = { last_run_initialisation_time: clock / 1000 - 3600, last_run_availability_time: clock / 1000 - 600, update_interval_seconds: 21600 };
        else if (kind === 'cloud') body = cloudResponseForUrl(url.href);
        else if (kind === 'airQuality') body = airQualityFixture({ now: clock });
        else body = weatherModelFixture(weatherFixture({ startDate: q.get('start_date'),
            hours: (Date.parse(q.get('end_date')) - Date.parse(q.get('start_date'))) / 3600000 + 24,
            latitude: Number(q.get('latitude')), longitude: Number(q.get('longitude')), elevation: Number(q.get('elevation')) }), q.get('models').split(','));
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    };
    for (const bundle of bundles) win.eval(bundle);
    return { win, doc, calls, observers,
        async ready() { await wait(() => doc.querySelectorAll('.bpb-peak-card-toggle').length === 2); await tick(); },
        async enter(id) {
            for (const observer of [...observers]) if (observer.connected && (!id || observer.target.id === id)) observer.fn([{ isIntersecting: true }]);
            await wait(() => [...doc.querySelectorAll('[aria-busy]')].every(node => node.getAttribute('aria-busy') !== 'true'));
            await tick();
        },
        async change(id, value) { const node = doc.getElementById(id); node.value = value; node.dispatchEvent(new win.Event('change')); await this.settle(); },
        async click(selector) { doc.querySelector(selector).click(); await this.settle(); },
        async settle() { await tick(); await wait(() => [...doc.querySelectorAll('[aria-busy]')].every(node => node.getAttribute('aria-busy') !== 'true')); await tick(); },
        advance(ms) { clock += ms; },
        close() { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); },
    };
}
const summarize = calls => Object.fromEntries(['weather', 'cloud', 'metadata', 'airQuality', 'total'].map(kind => [kind, kind === 'total' ? calls.length : calls.filter(call => call.kind === kind).length]));
function record(name, env, expected, start = 0) {
    const observed = summarize(env.calls.slice(start));
    assert.deepEqual(Object.values(observed), expected, name);
    results.push({ name, ...observed });
}
async function scenario(preferences, name, expected, options) {
    const env = setup(preferences, options);
    try {
        await env.ready(); await env.enter(); record(name, env, expected);
        if (preferences.bpbPeakWeatherModelForecast) assert.equal(new URL(env.calls.find(call => call.kind === 'weather').url).searchParams.get('models'), 'gfs_global,icon_global');
        if (preferences.peakWeatherCollapsed) assert.equal(env.doc.querySelector('#bpb-peak-weather').dataset.bpbCardCollapsed, 'true');
    }
    finally { env.close(); }
}

const env = setup();
let defaultRequests;
try {
    await env.ready(); record('Before either IntersectionObserver fires', env, [0, 0, 0, 0, 0]);
    await env.enter('bpb-peak-weather'); record('Only weather intersects', env, [1, 0, 0, 0, 1]);
    await env.enter('bpb-summit-cloud'); record('Default: both cards intersect', env, [1, 2, 2, 0, 5]);
    defaultRequests = [...env.calls];
    const weatherQuery = new URL(defaultRequests[0].url).searchParams;
    assert.equal(weatherQuery.get('hourly').split(',').length, 10);
    assert.equal((Date.parse(weatherQuery.get('end_date')) - Date.parse(weatherQuery.get('start_date'))) / 86400000 + 1, 32);
    for (const call of defaultRequests.filter(call => call.kind === 'cloud')) {
        const query = new URL(call.url).searchParams;
        assert.equal(query.get('latitude').split(',').length, 5);
        assert.equal(query.get('hourly').split(',').length, 72);
    }
    let start = env.calls.length;
    await env.click('#bpb-peak-weather-past'); await env.click('#bpb-peak-weather-forecast');
    await env.click('[aria-label="Show earlier hours"]'); await env.click('.bpb-cloud-hour');
    env.doc.querySelector('.bpb-cloud-details').open = true; await env.settle();
    record('Period/hour/Why navigation: additional', env, [0, 0, 0, 0, 0], start);
    start = env.calls.length;
    await env.click('.bpb-week-refresh'); record('Weather Refresh with Source details closed: additional', env, [1, 0, 0, 0, 1], start);
    start = env.calls.length;
    await env.click('.bpb-cloud-refresh'); record('Cloud Refresh within cache TTL: additional', env, [0, 2, 0, 0, 2], start);
    start = env.calls.length;
    await env.change('bpb-summit-cloud-date', '2026-10-25'); record('Tomorrow, same models: additional', env, [0, 2, 0, 0, 2], start);
    start = env.calls.length;
    await env.change('bpb-summit-cloud-date', '2026-10-24'); record('Return to cached day: additional', env, [0, 0, 0, 0, 0], start);
    start = env.calls.length;
    env.doc.querySelector('.bpb-week-source').open = true; await env.settle(); await wait(() => env.calls.length >= start + 2);
    record('Open GFS Source details: additional', env, [0, 0, 2, 0, 2], start);
    start = env.calls.length;
    await env.click('.bpb-week-refresh'); record('Weather Refresh with Source details open: additional', env, [1, 0, 2, 0, 3], start);
    start = env.calls.length;
    await env.click('#bpb-peak-weather-aqi'); record('First AQI selection: additional', env, [0, 0, 0, 1, 1], start);
    start = env.calls.length;
    await env.click('#bpb-peak-weather-forecast'); await env.click('#bpb-peak-weather-aqi');
    record('Reselect warm AQI: additional', env, [0, 0, 0, 0, 0], start);
    start = env.calls.length; env.advance(300001);
    await env.click('.bpb-cloud-refresh'); record('Cloud Refresh after cache TTL: additional', env, [0, 2, 2, 0, 4], start);
} finally { env.close(); }
await scenario({ bpbSummitCloudModel: 'gfs_global' }, 'Manual GFS cloud', [1, 1, 1, 0, 3]);
await scenario({ showSummitCloud: false }, 'Cloud disabled', [1, 0, 0, 0, 1]);
await scenario({ showWeather: false, showSummitCloud: true }, 'Weather disabled, cloud explicitly enabled', [0, 2, 2, 0, 4]);
await scenario({ showWeather: false, showSummitCloud: false }, 'Both disabled', [0, 0, 0, 0, 0]);
await scenario({ peakCloudCollapsed: true }, 'Cloud saved collapsed', [1, 0, 0, 0, 1]);
await scenario({ peakWeatherCollapsed: true, peakCloudCollapsed: true }, 'Both saved collapsed', [0, 0, 0, 0, 0]);
await scenario({ bpbPeakWeatherModelForecast: 'icon_global' }, 'Distinct past/forecast surface models', [1, 2, 2, 0, 5]);
await scenario({}, 'Both cloud profile requests return 429', [1, 2, 0, 0, 3], { limitedCloud: true });
await scenario({}, 'Fresh second page instance', [1, 2, 2, 0, 5]);
const duplicate = setup({ bpbSummitCloudModel: 'gfs_global' });
try {
    await duplicate.ready(); await duplicate.enter();
    const start = duplicate.calls.length;
    duplicate.doc.querySelector('.bpb-week-source').open = true; await duplicate.settle();
    await wait(() => duplicate.calls.length >= start + 2);
    record('Manual GFS: opening Source repeats cloud GFS025 metadata', duplicate, [0, 0, 2, 0, 2], start);
    assert.equal(duplicate.calls.filter(call => call.url.endsWith('/data/ncep_gfs025/static/meta.json')).length, 2);
} finally { duplicate.close(); }
assert(results.length > 0);
console.log(JSON.stringify({ auditedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceInputsSha256: sourceHash.digest('hex'), sourceInputs: inputs, bundleSha256, clock: '2026-10-24T18:00:00Z',
    fixture: 'test/fixtures/pages/peak-rainier.html', method: 'Built dist IIFEs in jsdom; stubbed settings, intersection, clock, HTTP responses; no live network or browser',
    assertions: results.length, results, defaultRequests }, null, 2));
