import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { PEAK_WEATHER_MODELS } from '../../src/weather/peak-weather-models.js';
import { weatherFixture, weatherModelFixture } from '../helpers/weather-fixture.mjs';
import { readPeakWeatherSubject } from '../../src/weather/peak-weather-subject.js';
import { peakUnitHeadings, withPeakElevation } from '../helpers/peak-unit-fixture.mjs';

const [peak, bundle] = await Promise.all([
    readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/peak-weather.js', import.meta.url), 'utf8'),
]);
const waitFor = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Peak weather did not settle'); await new Promise(resolve => setTimeout(resolve, 0)); }
};
const reply = url => {
    const query = new URL(url).searchParams;
    const hours = (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24;
    return new Response(JSON.stringify(weatherFixture({ startDate: query.get('start_date'), hours,
        latitude: Number(query.get('latitude')), longitude: Number(query.get('longitude')),
        elevation: query.has('elevation') ? Number(query.get('elevation')) : 1200 })), { headers: { 'content-type': 'application/json' } });
};
function setup({ html = peak, fetchFn = reply, lazy = false, now = '2024-11-05T12:00:00Z', storedSettings = {}, readSettings, localModels = {}, readModels, saveModels, metadataFn } = {}) {
    const jsdom = new JSDOM(html, { url: 'https://www.peakbagger.com/peak.aspx?pid=2296', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = jsdom.window, requests = [], metadataRequests = [], listeners = [], observers = [], resizeObservers = [];
    let clock = Date.parse(now);
    win.Date.now = () => clock;
    win.scrollBy = () => {};
    win.AbortController = AbortController; win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder;
    win.chrome = { storage: { local: { get: readModels || (async () => localModels), set: saveModels || (async values => Object.assign(localModels, values)) }, sync: { get: readSettings || (async () => ({ bpbSettings: { units: 'imperial', ...storedSettings } })) }, onChanged: {
        addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1),
    } } };
    if (lazy) win.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
        observe() {} disconnect() { this.disconnected = true; }
    };
    let chartWidth = 620;
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ width: chartWidth, height: 184, left: 0, top: 0 });
    win.SVGElement.prototype.getBoundingClientRect = () => ({ width: chartWidth, height: 184, left: 0, top: 0 });
    win.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.disconnected = false; resizeObservers.push(this); }
        observe() {} disconnect() { this.disconnected = true; }
    };
    win.fetch = async (url, init) => {
        if (new URL(url).pathname.startsWith('/data/')) {
            metadataRequests.push({ url, init });
            return metadataFn ? metadataFn(url, init) : new Response(JSON.stringify({ last_run_initialisation_time: Math.floor(clock / 1000) - 3600,
                last_run_availability_time: Math.floor(clock / 1000) - 600, update_interval_seconds: 21600 }), { headers: { 'content-type': 'application/json' } });
        }
        requests.push({ url, init });
        const response = await fetchFn(url, init);
        if (!response.ok) return response;
        const body = weatherModelFixture(await response.json(), new URL(url).searchParams.get('models').split(','), Object.fromEntries(PEAK_WEATHER_MODELS.map(model => [model.id,
            Date.parse(new Date(clock).toISOString().slice(0, 10)) / 1000 + model.forecastDays * 86400])));
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    };
    win.eval(bundle);
    return { win, doc: win.document, requests, metadataRequests, listeners, observers, resizeObservers,
        setNow: next => { clock = Date.parse(next); },
        resize: width => { chartWidth = width; resizeObservers.filter(observer => !observer.disconnected).forEach(observer => observer.callback()); },
        close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
}
const settled = async (env, { past = true } = {}) => {
    await waitFor(() => env.doc.querySelectorAll('.bpb-week-day').length === 16 && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
    if (past) env.doc.querySelector('[data-period="past"]').click();
};
const chooseModel = (env, id) => {
    const select = env.doc.querySelector('#bpb-peak-weather-model');
    select.value = id; select.dispatchEvent(new env.win.Event('change'));
};
const openLocationMenu = (env, latitude = 46.8, longitude = -121.7, extra = {}) => {
    const frame = env.doc.getElementById('Gmap');
    frame.getBoundingClientRect = () => ({ left: 10, top: 10, right: 650, bottom: 435, width: 640, height: 425 });
    env.win.dispatchEvent(new env.win.MessageEvent('message', { source: env.win, origin: env.win.location.origin,
        data: { __bpbPeakWeather: true, type: 'context', map: 'native', latitude, longitude, x: 100, y: 100, ...extra } }));
};
const selectLocation = (env, latitude, longitude) => {
    openLocationMenu(env, latitude, longitude); env.doc.querySelector('#bpb-peak-weather-menu button').click();
};

test('map weather discovery stays visible across locations and is absent on mapless peaks', async () => {
    const env = setup();
    try {
        await settled(env, { past: false });
        const hint = env.doc.querySelector('.bpb-week-map-hint');
        assert.equal(hint.hidden, false);
        assert.equal(hint.textContent, 'Right-click the map for weather at any point.');
        assert.equal(env.requests.length, 1, 'showing the hint only loads the normal summit weather');
        selectLocation(env, 46.8, -121.7);
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === '46.8000, -121.7000');
        assert.equal(hint.hidden, false, 'users can discover how to choose another point');
        assert.equal(env.requests.length, 2, 'only explicit location selection requests more weather');
    } finally { env.close(); }
    const noMap = setup({ html: peak.replace(/<iframe id="Gmap"[\s\S]*?<\/iframe>/, '') });
    try {
        await settled(noMap, { past: false });
        assert.equal(noMap.doc.querySelector('.bpb-week-map-hint').hidden, true);
        assert.equal(noMap.requests.length, 1, 'mapless peaks still load summit weather');
    } finally { noMap.close(); }
});

test('map weather menu fetches only on activation, uses terrain elevation and resets from page memory', async () => {
    const env = setup();
    try {
        await settled(env, { past: false });
        const initialLabel = env.doc.querySelector('.bpb-week-sub').textContent;
        openLocationMenu(env);
        const menu = env.doc.querySelector('#bpb-peak-weather-menu');
        assert.equal(menu.hidden, false); assert.equal(env.doc.activeElement, menu.querySelector('button'));
        assert.equal(menu.querySelector('button').textContent, 'Forecast and archive for this location');
        assert.equal(env.requests.length, 1);
        menu.querySelector('button').click();
        await waitFor(() => env.requests.length === 2 && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
        const query = new URL(env.requests[1].url).searchParams;
        assert.equal(query.get('latitude'), '46.8'); assert.equal(query.get('longitude'), '-121.7'); assert.equal(query.has('elevation'), false);
        assert.equal(menu.hidden, true); assert.equal(env.doc.querySelector('.bpb-week-location-reset').disabled, false);
        assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, '46.8000, -121.7000');
        env.doc.querySelector('[data-period="past"]').click();
        assert.equal(env.requests.length, 2); assert.match(env.doc.querySelector('.bpb-week-models').textContent, /Selected location timezone/);
        env.doc.querySelector('.bpb-week-location-reset').click();
        assert.equal(env.requests.length, 2); assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, 'At the summit');
        assert.equal(env.doc.querySelector('.bpb-week-location-reset').disabled, true);
        env.doc.querySelector('[data-period="forecast"]').click(); assert.equal(env.doc.querySelector('.bpb-week-sub').textContent, initialLabel);
    } finally { env.close(); }
});

test('location transactions preserve truthful old labels, cancel races and retain summit weather on failure', async () => {
    const held = []; let hold = false, fail = false;
    const env = setup({ fetchFn: (url, init) => fail ? new Response('', { status: 503 }) : hold
        ? new Promise(resolve => held.push({ url, init, resolve })) : reply(url) });
    try {
        await settled(env, { past: false }); hold = true;
        selectLocation(env, 46.8, -121.7); await waitFor(() => held.length === 1);
        assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, 'At the summit');
        assert.match(env.doc.querySelector('.bpb-week-status').textContent, /Loading 46.8000, -121.7000/);
        const originalDays = env.doc.querySelector('.bpb-week-days').textContent;
        selectLocation(env, 46.7, -121.6); await waitFor(() => held.length === 2);
        assert.equal(held[0].init.signal.aborted, true);
        held[0].resolve(reply(held[0].url));
        assert.equal(env.doc.querySelector('.bpb-week-days').textContent, originalDays);
        env.doc.querySelector('.bpb-week-location-reset').click();
        assert.equal(held[1].init.signal.aborted, true);
        held[1].resolve(reply(held[1].url));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, 'At the summit');
        hold = false; fail = true; selectLocation(env, 46.6, -121.5);
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('Could not load'));
        assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, 'At the summit');
        assert.equal(env.doc.querySelector('.bpb-week-days').textContent, originalDays);
        assert.match(env.doc.querySelector('.bpb-week-status').textContent, /46.6000, -121.5000/);
    } finally { env.close(); }
});

test('selected location resolves its own civil days and resets unavailable regional models without storing coordinates', async () => {
    const writes = [], env = setup({ saveModels: async value => writes.push(value) });
    try {
        await settled(env, { past: false }); chooseModel(env, 'gfs_hrrr');
        await waitFor(() => env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
        selectLocation(env, 35.68, 139.76);
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === '35.6800, 139.7600');
        assert.match(env.doc.querySelector('.bpb-week-models').textContent, /Selected location timezone: Asia\/Tokyo/);
        assert.equal(env.doc.querySelector('.bpb-week-day').dataset.date, '2024-11-05');
        assert.equal(env.doc.querySelector('#bpb-peak-weather-model').value, 'gfs_global');
        assert.deepEqual(writes.map(value => ({ ...value })), [{ bpbPeakWeatherModelForecast: 'gfs_hrrr' }]);
    } finally { env.close(); }
});

test('menu dismisses on Escape, outside frame clicks and suspension; invalid or disabled map points do nothing', async () => {
    const env = setup();
    try {
        await settled(env, { past: false }); const menu = env.doc.querySelector('#bpb-peak-weather-menu');
        for (const extra of [{ latitude: 91 }, { longitude: '1' }, { x: -1 }, { y: Infinity }, { map: 'unknown' }]) {
            openLocationMenu(env, 46.8, -121.7, extra); assert.equal(menu.hidden, true);
        }
        openLocationMenu(env); env.doc.activeElement.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(menu.hidden, true); assert.equal(env.doc.activeElement, env.doc.getElementById('Gmap'));
        openLocationMenu(env); const frameWin = env.doc.getElementById('Gmap').contentWindow;
        frameWin.document.dispatchEvent(new frameWin.Event('pointerdown', { bubbles: true })); assert.equal(menu.hidden, true);
        openLocationMenu(env); env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true })); assert.equal(menu.hidden, true);
        openLocationMenu(env); assert.equal(menu.hidden, true);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        openLocationMenu(env); assert.equal(menu.hidden, true); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('known rate limits keep the map menu dismissible and prevent location requests during cooldown', async () => {
    let limited = false;
    const env = setup({ fetchFn: url => limited ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : reply(url) });
    try {
        await settled(env, { past: false }); limited = true; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').dataset.kind === 'rate-limit');
        const count = env.requests.length;
        openLocationMenu(env);
        const menu = env.doc.querySelector('#bpb-peak-weather-menu');
        assert.equal(menu.hidden, false); assert.equal(menu.querySelector('button').disabled, true);
        menu.querySelector('button').click(); assert.equal(env.requests.length, count);
        menu.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(menu.hidden, true);
    } finally { env.close(); }
});

test('Tab and Shift+Tab dismiss the menu back to the map; blur and outside focus do not trap keyboard navigation', async () => {
    const env = setup();
    try {
        await settled(env, { past: false }); const menu = env.doc.querySelector('#bpb-peak-weather-menu');
        for (const shiftKey of [false, true]) {
            openLocationMenu(env);
            const key = new env.win.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
            env.doc.activeElement.dispatchEvent(key);
            assert.equal(key.defaultPrevented, true); assert.equal(menu.hidden, true);
            assert.equal(env.doc.activeElement, env.doc.getElementById('Gmap'));
        }
        const normalTab = new env.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        env.doc.activeElement.dispatchEvent(normalTab); assert.equal(normalTab.defaultPrevented, false);
        openLocationMenu(env); env.win.dispatchEvent(new env.win.Event('blur')); assert.equal(menu.hidden, true);
        openLocationMenu(env); env.doc.querySelector('.bpb-week-refresh').focus();
        assert.equal(menu.hidden, true); assert.equal(env.doc.activeElement, env.doc.querySelector('.bpb-week-refresh'));
    } finally { env.close(); }
});

test('an open menu becomes usable when the known cooldown expires without reopening it', async () => {
    let limited = false;
    const env = setup({ fetchFn: url => limited ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : reply(url) });
    try {
        await settled(env, { past: false }); limited = true; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').dataset.kind === 'rate-limit');
        openLocationMenu(env); const menu = env.doc.querySelector('#bpb-peak-weather-menu'), action = menu.querySelector('button');
        assert.equal(action.disabled, true); assert.equal(env.doc.activeElement, menu);
        env.setNow('2024-11-05T12:03:00Z');
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'imperial' } } }, 'sync'));
        assert.equal(action.disabled, false); assert.equal(action.title, ''); assert.equal(env.doc.activeElement, action);
        limited = false; action.click();
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === '46.8000, -121.7000');
    } finally { env.close(); }
});

test('failed location selection can retry the same map point and names the actual retry target', async () => {
    let fail = false;
    const env = setup({ fetchFn: url => fail ? new Response('', { status: 503 }) : reply(url) });
    try {
        await settled(env, { past: false }); fail = true; selectLocation(env, 46.8, -121.7);
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('Could not load'));
        assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, 'At the summit');
        assert.equal(env.doc.querySelector('.bpb-week-refresh').textContent, 'Retry');
        assert.equal(env.doc.querySelector('.bpb-week-refresh').getAttribute('aria-label'), 'Retry weather for 46.8000, -121.7000');
        fail = false; selectLocation(env, 46.8, -121.7);
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === '46.8000, -121.7000');
        assert.equal(env.requests.length, 3); assert.equal(env.doc.querySelector('.bpb-week-refresh').textContent, 'Refresh');
    } finally { env.close(); }
});

test('failed reset remains retryable when a point supersedes the first summit request', async () => {
    const held = []; let fail = false, hold = true;
    const env = setup({ fetchFn: (url, init) => fail ? new Response('', { status: 503 }) : hold
        ? new Promise(resolve => held.push({ url, init, resolve })) : reply(url) });
    try {
        await waitFor(() => held.length === 1); selectLocation(env, 46.8, -121.7);
        await waitFor(() => held.length === 2); held[1].resolve(reply(held[1].url));
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === '46.8000, -121.7000'
            && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
        assert.equal(held[0].init.signal.aborted, true);
        fail = true; env.doc.querySelector('.bpb-week-location-reset').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('Could not load summit'));
        assert.equal(env.doc.querySelector('.bpb-week-location-reset').disabled, false);
        assert.equal(env.doc.querySelector('.bpb-week-refresh').getAttribute('aria-label'), 'Retry summit weather');
        fail = hold = false; env.doc.querySelector('.bpb-week-location-reset').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === 'At the summit'
            && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
        assert.equal(env.doc.querySelector('.bpb-week-location-reset').disabled, true); assert.equal(env.requests.length, 4);
    } finally { env.close(); }
});

test('a point selected before any readings load uses its own identity, elevation and civil day immediately', async () => {
    const held = [], env = setup({ now: '2024-11-05T02:00:00Z', fetchFn: (url, init) => new Promise(resolve => held.push({ url, init, resolve })) });
    try {
        await waitFor(() => held.length === 1); selectLocation(env, 35.68, 139.76);
        await waitFor(() => held.length === 2);
        assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, '35.6800, 139.7600');
        assert.match(env.doc.querySelector('#bpb-peak-weather-heading').textContent, /Location weather/);
        assert.match(env.doc.querySelector('.bpb-week-sub').textContent, /^Terrain elevation · Today \+ 15 days$/);
        assert.equal(env.doc.querySelector('.bpb-week-location-name').getAttribute('aria-live'), 'polite');
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 0);
        env.doc.querySelector('.bpb-week-location-reset').click(); await waitFor(() => held.length === 3);
        assert.equal(held[1].init.signal.aborted, true);
        assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, 'At the summit');
        held[2].resolve(reply(held[2].url)); await settled(env, { past: false });
        held[1].resolve(reply(held[1].url));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(env.doc.querySelector('.bpb-week-location-name').textContent, 'At the summit');
    } finally { env.close(); }
});

test('reset restores both summit model choices without persisting a regional fallback', async () => {
    const writes = [], env = setup({ localModels: { bpbPeakWeatherModelForecast: 'gfs_hrrr', bpbPeakWeatherModelPast: 'icon_global' },
        saveModels: async value => writes.push({ ...value }) });
    try {
        await waitFor(() => env.doc.querySelectorAll('.bpb-week-day').length === 2 && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
        selectLocation(env, 35.68, 139.76);
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === '35.6800, 139.7600');
        assert.equal(env.doc.querySelector('#bpb-peak-weather-model').value, 'gfs_global');
        const count = env.requests.length; env.doc.querySelector('.bpb-week-location-reset').click();
        assert.equal(env.doc.querySelector('#bpb-peak-weather-model').value, 'gfs_hrrr');
        assert.doesNotMatch(env.doc.querySelector('.bpb-week-status').textContent, /Showing|Updating/);
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 2);
        env.doc.querySelector('[data-period="past"]').click(); assert.equal(env.doc.querySelector('#bpb-peak-weather-model').value, 'icon_global');
        assert.equal(env.requests.length, count); assert.deepEqual(writes, []);
    } finally { env.close(); }
});

test('reset and BFCache preserve a known cooldown and its explanation', async () => {
    let limited = false;
    const env = setup({ fetchFn: url => limited ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : reply(url) });
    try {
        await settled(env, { past: false }); selectLocation(env, 46.8, -121.7);
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === '46.8000, -121.7000');
        limited = true; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').dataset.kind === 'rate-limit');
        env.doc.querySelector('.bpb-week-location-reset').click();
        assert.equal(env.doc.querySelector('.bpb-week-status').dataset.kind, 'rate-limit');
        assert.match(env.doc.querySelector('.bpb-week-status').textContent, /Showing summit weather/);
        const count = env.requests.length;
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(env.requests.length, count); assert.equal(env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy'), 'false');
        assert.equal(env.doc.querySelector('.bpb-week-status').dataset.kind, 'rate-limit');
        assert.equal(env.doc.querySelector('.bpb-week-refresh').disabled, true);
    } finally { env.close(); }
});

test('Conditions is the initial hourly tab and rendering never writes a local preference', async () => {
    const writes = [], env = setup({ saveModels: async values => { writes.push(values); } });
    try {
        await settled(env, { past: false });
        env.doc.querySelector('.bpb-week-day > summary').click();
        const day = env.doc.querySelector('.bpb-week-day[open]');
        assert.equal(day.querySelector('[aria-selected="true"]').dataset.metric, 'code');
        assert.equal(day.querySelector('[data-metric="code"]').tabIndex, 0);
        assert.equal(day.querySelector('.bpb-week-conditions').hidden, false);
        assert.equal(day.querySelector('.bpb-week-chart').hidden, true);
        assert.ok(day.querySelector('.bpb-weather-hourly-table'));
        env.doc.querySelector('.bpb-week-day:nth-child(2) > summary').click();
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'code');
        assert.deepEqual(writes, []);
    } finally { env.close(); }
});

test('every hourly data tab survives navigation; keyboard choices persist without render writes', async () => {
    for (const metric of ['temperature', 'precipitation', 'cloud', 'wind', 'gust', 'code']) {
        const localModels = { bpbPeakWeatherHourlyMetric: 'wind' }, writes = [];
        const env = setup({ localModels, saveModels: async values => { writes.push({ ...values }); Object.assign(localModels, values); } });
        try {
            await settled(env, { past: false });
            env.doc.querySelector('.bpb-week-day > summary').click();
            assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'wind');
            assert.deepEqual(writes, []);
            env.doc.querySelector(`[data-metric="${metric}"]`).click();
            assert.equal(localModels.bpbPeakWeatherHourlyMetric, metric);
            assert.deepEqual(writes, [{ bpbPeakWeatherHourlyMetric: metric }]);
            env.doc.querySelector('.bpb-week-day:nth-child(2) > summary').click();
            env.doc.querySelector('[data-period="past"]').click();
            env.doc.querySelector('.bpb-week-day > summary').click();
            env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
            assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, metric);
            assert.equal(writes.length, 1);
            assert.equal(env.requests.length, 1);
        } finally { env.close(); }
        const next = setup({ localModels });
        try {
            await settled(next, { past: false });
            next.doc.querySelector('.bpb-week-day > summary').click();
            const active = next.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]');
            assert.equal(active.dataset.metric, metric);
            active.focus(); active.dispatchEvent(new next.win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
            assert.equal(localModels.bpbPeakWeatherHourlyMetric, 'gust');
            next.doc.activeElement.dispatchEvent(new next.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
            assert.equal(localModels.bpbPeakWeatherHourlyMetric, 'code');
            assert.equal(next.requests.length, 1);
        } finally { next.close(); }
    }
});

test('cloud graph and conditions share one request, preserve gaps and use a fixed percentage axis', async () => {
    for (const units of ['imperial', 'metric']) {
        const env = setup({ storedSettings: { units } });
        try {
            await settled(env, { past: false });
            const query = new URL(env.requests[0].url).searchParams;
            assert.ok(query.get('hourly').split(',').includes('cloud_cover'));
            env.doc.querySelector('.bpb-week-day > summary').click();
            const day = env.doc.querySelector('.bpb-week-day[open]');
            const values = [...day.querySelectorAll('[data-weather-row="cloud"] td')].map(cell => cell.textContent);
            assert.equal(values.length, 24);
            for (const value of ['0%', '25%', '50%', '100%', '—']) assert.ok(values.includes(value), value);
            day.querySelector('[data-metric="cloud"]').click();
            const chart = day.querySelector('.bpb-week-chart');
            assert.equal(chart.dataset.weatherMetric, 'cloud');
            assert.deepEqual([...chart.querySelectorAll('.bpb-week-axis')].slice(0, 3).map(node => node.textContent), ['0%', '50%', '100%']);
            assert.ok(chart.querySelector('.bpb-week-line').getAttribute('d').split('M').length > 2, 'missing cloud hours break the line');
            assert.equal(chart.querySelectorAll('.bpb-week-point').length, values.filter(value => value !== '—').length);
            chart.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
            assert.ok(day.querySelector('.bpb-week-cursor'));
            assert.match(day.querySelector('.bpb-week-readout').textContent, /%|Unavailable/);
            assert.equal(env.requests.length, 1);
        } finally { env.close(); }
    }
});

test('clouds with no readings show an unavailable state while core weather remains complete', async () => {
    const env = setup({ fetchFn: async url => {
        const body = await (await reply(url)).json(); delete body.hourly.cloud_cover;
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(env);
        assert.equal(env.doc.querySelectorAll('.bpb-week-partial').length, 0);
        env.doc.querySelector('.bpb-week-day > summary').click();
        env.doc.querySelector('[data-metric="cloud"]').click();
        const chart = env.doc.querySelector('.bpb-week-chart');
        assert.equal(chart.querySelector('.bpb-week-chart-empty').hidden, false);
        assert.match(chart.textContent, /Cloud cover is unavailable/);
        assert.equal(chart.querySelectorAll('.bpb-week-line').length, 0);
        assert.equal(chart.tabIndex, -1);
        env.doc.querySelector('[data-metric="temperature"]').click();
        assert.ok(chart.querySelector('.bpb-week-line'));
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('invalid saved hourly tabs and failed local reads fall back to usable Conditions', async () => {
    for (const value of [undefined, null, '', 'conditions', 'unknown', {}, ['wind']]) {
        const localModels = { bpbPeakWeatherHourlyMetric: value }, writes = [];
        const env = setup({ localModels, saveModels: async values => { writes.push(values); } });
        try {
            await settled(env, { past: false }); env.doc.querySelector('.bpb-week-day > summary').click();
            assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'code');
            assert.deepEqual(writes, []);
        } finally { env.close(); }
    }
    for (const synchronous of [false, true]) {
        const fail = () => { throw new Error('unavailable'); };
        const env = setup({ readModels: synchronous ? fail : async () => fail(), saveModels: synchronous ? fail : async () => fail() });
        try {
            await settled(env, { past: false }); env.doc.querySelector('.bpb-week-day > summary').click();
            assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'code');
            env.doc.querySelector('[data-metric="temperature"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'temperature');
            assert.ok(env.doc.querySelector('.bpb-week-day[open] .bpb-week-line'));
        } finally { env.close(); }
    }
});

test('a delayed local read restores the hourly tab before the weather card is usable', async () => {
    let release;
    const env = setup({ readModels: () => new Promise(resolve => { release = resolve; }) });
    try {
        await waitFor(() => release);
        assert.equal(env.doc.querySelector('#bpb-peak-weather').hidden, true);
        assert.equal(env.requests.length, 0);
        release({ bpbPeakWeatherHourlyMetric: 'gust' });
        await settled(env, { past: false }); env.doc.querySelector('.bpb-week-day > summary').click();
        assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'gust');
    } finally { env.close(); }
});

test('an older page redraw cannot overwrite the last explicit choice from another page', async () => {
    const localModels = {};
    const first = setup({ localModels }), second = setup({ localModels });
    try {
        await settled(first, { past: false }); await settled(second, { past: false });
        first.doc.querySelector('.bpb-week-day > summary').click();
        first.doc.querySelector('[data-metric="wind"]').click();
        second.doc.querySelector('.bpb-week-day > summary').click();
        assert.equal(localModels.bpbPeakWeatherHourlyMetric, 'wind');
        second.doc.querySelector('[data-metric="gust"]').click();
        first.doc.querySelector('.bpb-week-day:nth-child(2) > summary').click();
        first.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        assert.equal(first.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'wind');
        assert.equal(localModels.bpbPeakWeatherHourlyMetric, 'gust');
    } finally { first.close(); second.close(); }
});

test('a negative historical ARPEGE sample becomes zero without marking the day partial or leaving an hourly gap', async () => {
    const env = setup({ now: '2026-10-12T04:00:00Z', storedSettings: { units: 'metric' },
        localModels: { bpbPeakWeatherModelPast: 'meteofrance_arpege_world' }, fetchFn: url => {
            const query = new URL(url).searchParams;
            const body = weatherModelFixture(weatherFixture({ startDate: query.get('start_date'),
                hours: (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24 }), query.get('models').split(','));
            body.hourly.precipitation_meteofrance_arpege_world[45] = -0.1;
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        } });
    try {
        await settled(env, { past: false });
        assert.match(env.doc.querySelector('.bpb-week-models').textContent, /GFS/);
        env.doc.querySelector('[data-period="past"]').click();
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
        assert.match(env.doc.querySelector('.bpb-week-models').textContent, /ARPEGE World/);
        assert.equal(env.doc.querySelector('.bpb-week-status').textContent, '');
        assert.equal(env.doc.querySelectorAll('.bpb-week-partial').length, 0);
        const affected = env.doc.querySelector('[data-date="2026-09-26"]');
        assert.doesNotMatch(affected.querySelector('.bpb-week-metrics').textContent, /partial/);
        affected.open = true;
        await waitFor(() => affected.querySelector('[role="tabpanel"]'));
        affected.querySelector('[data-metric="precipitation"]').click();
        assert.equal(affected.querySelectorAll('.bpb-week-point').length, 24);
        assert.doesNotMatch(affected.textContent, /-0\.1/);
        assert.equal(env.requests.length, 1, 'both periods and the hourly graph reuse the combined response');
    } finally { env.close(); }
});

for (const [heading, system] of peakUnitHeadings) {
    test(`automatic weather units follow the primary native elevation: ${heading}`, async () => {
        const env = setup({ html: withPeakElevation(peak, heading), storedSettings: { units: 'auto' } });
        try {
            await settled(env, { past: false });
            assert.match(env.doc.querySelector('.bpb-week-temp').textContent, system === 'metric' ? /°C/ : /°F/);
            assert.match(env.doc.querySelector('.bpb-week-metrics').textContent, system === 'metric' ? /mm.*km\/h/ : /in.*mph/);
            assert.match(env.doc.querySelector('.bpb-week-sub').textContent, system === 'metric' ? /4391 m/ : /14406 ft/);
            const count = env.requests.length;
            env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'auto', temperatureUnits: 'imperial', elevationUnits: 'metric' } } }, 'sync'));
            assert.match(env.doc.querySelector('.bpb-week-temp').textContent, /°F/);
            assert.match(env.doc.querySelector('.bpb-week-sub').textContent, /4391 m/);
            assert.equal(env.requests.length, count, 'unit changes reuse canonical data');
        } finally { env.close(); }
    });
}

test('mixed weather units update live without changing the default or refetching canonical data', async () => {
    const storedSettings = { units: 'imperial', temperatureUnits: 'metric', precipitationUnits: 'metric', elevationUnits: 'metric' };
    const env = setup({ storedSettings });
    try {
        await settled(env, { past: false });
        assert.match(env.doc.querySelector('.bpb-week-temp').textContent, /°C/);
        assert.match(env.doc.querySelector('.bpb-week-metrics').textContent, /mm.*mph/);
        assert.match(env.doc.querySelector('.bpb-week-sub').textContent, /\d+ m\b/);
        const day = env.doc.querySelector('.bpb-week-day'); day.open = true;
        await waitFor(() => day.querySelector('[role="tabpanel"]'));
        day.querySelector('[data-metric="precipitation"]').click();
        assert.match(day.querySelector('.bpb-week-chart svg').getAttribute('aria-label'), /mm/);
        const requests = env.requests.length;
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { ...storedSettings, temperatureUnits: 'imperial', elevationUnits: 'imperial', windUnits: 'metric' } } }, 'sync'));
        assert.match(env.doc.querySelector('.bpb-week-temp').textContent, /°F/);
        assert.match(env.doc.querySelector('.bpb-week-metrics').textContent, /mm.*km\/h/);
        assert.match(env.doc.querySelector('.bpb-week-sub').textContent, /\d+ ft\b/);
        assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'precipitation');
        assert.equal(env.requests.length, requests);
        const query = new URL(env.requests[0].url).searchParams;
        assert.equal(query.get('temperature_unit'), 'celsius');
        assert.equal(query.get('precipitation_unit'), 'mm');
        assert.equal(query.get('wind_speed_unit'), 'kmh');
    } finally { env.close(); }
});

test('named GFS is the default with independent locally remembered period choices', async () => {
    const env = setup({ fetchFn: url => {
        const query = new URL(url).searchParams;
        const body = weatherModelFixture(weatherFixture({ startDate: query.get('start_date'),
            hours: (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24 }), query.get('models').split(','));
        for (const [key, values] of Object.entries(body.hourly)) if (key.startsWith('temperature_2m')) values.fill(20);
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(env, { past: false });
        assert.equal(env.requests.length, 1); assert.equal(new URL(env.requests[0].url).searchParams.get('models'), 'gfs_global');
        assert.equal(env.doc.querySelector('select').value, 'gfs_global');
        assert.match(env.doc.querySelector('select').selectedOptions[0].textContent, /GFS.*16 days/);
        assert.match(env.doc.querySelector('.bpb-week-temp').textContent, /68°F/);
        env.doc.querySelector('[data-period="past"]').click();
        assert.match(env.doc.querySelector('.bpb-week-models').textContent, /GFS/);
        assert.match(env.doc.querySelector('.bpb-week-temp').textContent, /68°F/);
        chooseModel(env, 'icon_global');
        await waitFor(() => env.doc.querySelector('.bpb-week-models').textContent.includes('ICON Global'));
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
        assert.match(env.doc.querySelector('.bpb-week-models').textContent, /ICON Global, 11 km/);
        env.doc.querySelector('[data-period="forecast"]').click();
        assert.equal(env.doc.querySelector('select').value, 'gfs_global');
        assert.match(env.doc.querySelector('.bpb-week-models').textContent, /GFS/);
        env.doc.querySelector('[data-period="past"]').click(); assert.equal(env.doc.querySelector('select').value, 'icon_global');
        assert.equal(env.requests.length, 2);
        chooseModel(env, 'gfs_global');
        await waitFor(() => env.doc.querySelector('.bpb-week-models').textContent.includes('GFS'));
        assert.equal(env.requests.length, 2, 'reverting reuses the exact cached model selection');
    } finally { env.close(); }
});

test('local choices load before the request, survive navigation and reject unavailable regional or unknown IDs', async () => {
    const localModels = { bpbPeakWeatherModelPast: 'ecmwf_ifs', bpbPeakWeatherModelForecast: 'icon_global' };
    let release;
    const env = setup({ localModels, readModels: () => new Promise(resolve => { release = () => resolve(localModels); }) });
    try {
        await waitFor(() => release);
        await new Promise(resolve => setTimeout(resolve, 0)); // Sync settings finish before the local read.
        assert.equal(env.requests.length, 0);
        release();
        await waitFor(() => env.doc.querySelector('.bpb-week-models').textContent.includes('ICON Global'));
        assert.equal(new URL(env.requests[0].url).searchParams.get('models'), 'ecmwf_ifs,icon_global');
        assert.equal(env.doc.querySelector('select').options[0].value, 'best_match');
        chooseModel(env, 'gfs_global');
        await waitFor(() => env.doc.querySelector('.bpb-week-models').textContent.includes('GFS'));
        assert.deepEqual(localModels, { bpbPeakWeatherModelPast: 'ecmwf_ifs', bpbPeakWeatherModelForecast: 'gfs_global' });
    } finally { env.close(); }
    const next = setup({ localModels });
    try { await settled(next); assert.equal(next.doc.querySelector('select').value, 'ecmwf_ifs'); }
    finally { next.close(); }
    const invalid = setup({ localModels: { bpbPeakWeatherModelPast: 'icon_d2', bpbPeakWeatherModelForecast: 'not_a_model' } });
    try { await settled(invalid); assert.equal(new URL(invalid.requests[0].url).searchParams.get('models'), 'gfs_global'); }
    finally { invalid.close(); }
});

test('local storage failures retain a usable model picker and forecast', async () => {
    const env = setup({ readModels: async () => { throw new Error('unavailable'); }, saveModels: async () => { throw new Error('unavailable'); } });
    try {
        await settled(env, { past: false }); chooseModel(env, 'ecmwf_ifs');
        await waitFor(() => env.doc.querySelector('.bpb-week-models').textContent.includes('ECMWF IFS'));
        assert.equal(env.doc.querySelector('select').value, 'ecmwf_ifs');
    } finally { env.close(); }
});

test('explicit short-range forecast labels its horizon and preserves sixteen days of history', async () => {
    const env = setup();
    try {
        await settled(env, { past: false });
        assert.match(env.doc.querySelector('option[value="gfs_hrrr"]').textContent, /up to 2 days/);
        chooseModel(env, 'gfs_hrrr');
        await waitFor(() => env.doc.querySelector('[data-period="forecast"]').textContent === '2-day forecast');
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 2);
        assert.match(env.doc.querySelector('.bpb-week-sub').textContent, /Today \+ 1 day$/);
        assert.match(env.doc.querySelector('select').selectedOptions[0].textContent, /HRRR · 3 km · up to 2 days/);
        assert.equal(new URL(env.requests.at(-1).url).searchParams.get('models'), 'gfs_global,gfs_hrrr');
        env.doc.querySelector('[data-period="past"]').click();
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16); assert.equal(env.doc.querySelector('select').value, 'gfs_global');
        env.doc.querySelector('[data-period="forecast"]').click(); assert.equal(env.doc.querySelector('select').value, 'gfs_hrrr');
        chooseModel(env, 'gfs_global');
        await waitFor(() => env.doc.querySelectorAll('.bpb-week-day').length === 16);
        assert.equal(env.requests.length, 2);
    } finally { env.close(); }
});

test('model changes cancel stale results; explicit failures keep the visible model without fallback', async () => {
    let slow, unavailable = false;
    const env = setup({ fetchFn: url => {
        const ids = new URL(url).searchParams.get('models');
        if (ids.includes('icon_global')) return new Promise(resolve => { slow = () => resolve(reply(url)); });
        if (unavailable && ids.includes('ecmwf_ifs')) return new Response('', { status: 400 });
        return reply(url);
    } });
    try {
        await settled(env, { past: false });
        assert.doesNotMatch(env.doc.querySelector('.bpb-week-status').textContent, /Showing|Updating/);
        assert.equal(env.doc.querySelector('select').getAttribute('aria-describedby'), 'bpb-peak-weather-status');
        chooseModel(env, 'icon_global');
        await waitFor(() => slow); const stale = env.requests.at(-1);
        assert.match(env.doc.querySelector('.bpb-week-status').textContent, /^Updating… Showing GFS · 13 km\.$/);
        unavailable = true; chooseModel(env, 'ecmwf_ifs');
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('selection is unavailable'));
        assert.equal(stale.init.signal.aborted, true); assert.equal(env.requests.length, 3);
        assert.equal(env.doc.querySelector('select').value, 'ecmwf_ifs');
        assert.match(env.doc.querySelector('.bpb-week-status').textContent, /Showing GFS · 13 km/);
        assert.equal(env.doc.querySelector('select').getAttribute('aria-describedby'), 'bpb-peak-weather-status');
        slow(); await new Promise(resolve => setTimeout(resolve, 0));
        assert.match(env.doc.querySelector('.bpb-week-status').textContent, /Showing GFS · 13 km/);
        unavailable = false; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-models').textContent.includes('ECMWF IFS'));
        assert.doesNotMatch(env.doc.querySelector('.bpb-week-status').textContent, /Showing|Updating/);
        assert.equal(env.requests.length, 4); assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 15);
    } finally { env.close(); }
});

test('model loading reuses one live feedback row and preserves expanded weather until replacement', async () => {
    let finish;
    const env = setup({ fetchFn: url => new URL(url).searchParams.get('models').includes('best_match')
        ? new Promise(resolve => { finish = () => resolve(reply(url)); }) : reply(url) });
    try {
        await settled(env, { past: false });
        const day = env.doc.querySelector('.bpb-week-day');
        day.querySelector('summary').click();
        day.querySelector('[data-metric="temperature"]').click();
        const chart = day.querySelector('.bpb-week-chart');
        const days = [...env.doc.querySelectorAll('.bpb-week-day')];
        const status = env.doc.querySelector('.bpb-week-status');
        const reserved = [...status.querySelectorAll('[data-sizing-text]')].map(node => node.dataset.sizingText);
        assert.ok(reserved.includes('Updating… Showing GFS · 13 km.'));
        chooseModel(env, 'best_match');
        await waitFor(() => finish);
        assert.equal(env.doc.querySelector('.bpb-week-status'), status, 'retain the same live region');
        assert.match(status.textContent, /^Updating… Showing GFS · 13 km\.$/);
        assert.equal(status.getAttribute('role'), 'status');
        assert.equal(env.doc.querySelector('select').getAttribute('aria-describedby'), status.id);
        assert.deepEqual([...env.doc.querySelectorAll('.bpb-week-day')], days);
        assert.equal(day.querySelector('.bpb-week-chart'), chart);
        assert.equal(day.open, true);
        assert.equal(day.querySelector('[aria-selected="true"]').dataset.metric, 'temperature');
        finish();
        await waitFor(() => env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
        assert.match(env.doc.querySelector('.bpb-week-models').textContent, /^Best Match\./);
        assert.doesNotMatch(status.textContent, /Updating|Showing GFS/);
        assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'temperature');
    } finally { finish?.(); env.close(); }
});

test('summary activation expands only the requested day without collapsing context or scrolling the page', async () => {
    const env = setup();
    try {
        await settled(env, { past: false });
        const days = [...env.doc.querySelectorAll('.bpb-week-day')], first = days[0].querySelector('summary'), second = days[1].querySelector('summary');
        first.click();
        assert.equal(days[0].open, true); assert.ok(days[0].querySelector('.bpb-weather-hourly-table'));
        assert.equal(days[0].querySelector('[aria-selected="true"]').dataset.metric, 'code');
        const scrolls = []; env.win.scrollBy = value => scrolls.push(value.top);
        second.getBoundingClientRect = () => ({ top: days[0].open ? 500 : 200 });
        second.click();
        assert.equal(days[0].open, true); assert.equal(days[1].open, true);
        assert.equal(env.doc.querySelectorAll('.bpb-week-day[open]').length, 2);
        assert.ok(days[1].querySelector('.bpb-weather-hourly-table')); assert.equal(env.doc.activeElement, second);
        assert.deepEqual(scrolls, []);
        await waitFor(() => env.resizeObservers.filter(observer => !observer.disconnected).length === 2);
        assert.ok(days[1].querySelector('.bpb-weather-hourly-table'), 'queued close toggle cannot dispose the new hourly panel');
        second.click(); assert.equal(days[1].open, false); assert.equal(days[1].querySelector('[role="tabpanel"]'), null);
        assert.equal(days[0].open, true); assert.ok(days[0].querySelector('.bpb-weather-hourly-table'));
        assert.equal(env.resizeObservers.filter(observer => !observer.disconnected).length, 1);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('each expanded day preserves its own tab, pinned reading and scroll through refresh and period changes', async () => {
    const env = setup();
    try {
        await settled(env, { past: false });
        const days = [...env.doc.querySelectorAll('.bpb-week-day')], dates = days.slice(0, 2).map(day => day.dataset.date);
        days[0].querySelector('summary').click();
        days[0].querySelector('[data-metric="temperature"]').click();
        const chart = days[0].querySelector('.bpb-week-chart');
        chart.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        const reading = days[0].querySelector('.bpb-week-readout').textContent;
        days[1].querySelector('summary').click();
        days[1].querySelector('[data-metric="code"]').click();
        const grid = days[1].querySelector('.bpb-week-conditions'); grid.scrollLeft = 240; grid.focus();
        const verify = () => {
            const [first, second] = dates.map(date => env.doc.querySelector(`[data-date="${date}"]`));
            assert.equal(first.open, true); assert.equal(second.open, true);
            assert.equal(first.querySelector('[aria-selected="true"]').dataset.metric, 'temperature');
            assert.equal(first.querySelector('.bpb-week-readout').textContent, reading);
            assert.ok(first.querySelector('.bpb-week-cursor'));
            assert.equal(second.querySelector('[aria-selected="true"]').dataset.metric, 'code');
            assert.equal(second.querySelector('.bpb-week-conditions').scrollLeft, 240);
        };
        env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false');
        verify(); assert.ok(env.doc.activeElement.matches('.bpb-week-conditions'));
        env.doc.querySelector('[data-period="past"]').click();
        env.doc.querySelector('.bpb-week-day > summary').click();
        env.doc.querySelector('[data-period="forecast"]').click(); verify();
        const before = env.requests.length;
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        assert.equal(env.doc.querySelectorAll('.bpb-week-day[open]').length, 2);
        assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'temperature');
        assert.equal(env.doc.querySelectorAll('.bpb-week-day[open]')[1].querySelector('[aria-selected="true"]').dataset.metric, 'code');
        assert.equal(env.requests.length, before);
    } finally { env.close(); }
});

test('multiple open days release every chart on close, opt-out and page lifecycle transitions', async () => {
    const env = setup();
    const count = () => env.resizeObservers.filter(observer => !observer.disconnected).length;
    try {
        await settled(env, { past: false });
        const days = [...env.doc.querySelectorAll('.bpb-week-day')];
        for (const [index, metric] of ['temperature', 'gust', 'code'].entries()) {
            days[index].querySelector('summary').click(); days[index].querySelector(`[data-metric="${metric}"]`).click();
        }
        assert.equal(count(), 3);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(count(), 0);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        await settled(env, { past: false });
        assert.equal(count(), 3);
        assert.deepEqual([...env.doc.querySelectorAll('.bpb-week-day[open] [aria-selected="true"]')].map(tab => tab.dataset.metric), ['temperature', 'gust', 'code']);
        env.doc.querySelector('.bpb-week-day > summary').click(); assert.equal(count(), 2);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        assert.equal(count(), 0);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: true } } }, 'sync'));
        await settled(env, { past: false }); assert.equal(count(), 2);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide')); assert.equal(count(), 0);
    } finally { env.close(); }
});

test('unrelated settings keep nodes and pinned readings; units and refresh restore focus and selected instant', async () => {
    const env = setup();
    const update = values => env.listeners.forEach(fn => fn({ bpbSettings: { newValue: values } }, 'sync'));
    try {
        await settled(env, { past: false });
        env.doc.querySelector('.bpb-week-day > summary').click();
        env.doc.querySelector('[data-metric="temperature"]').click();
        let frame = env.doc.querySelector('.bpb-week-chart'); frame.focus();
        frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        const readout = env.doc.querySelector('.bpb-week-readout'), pinned = readout.textContent;
        update({ units: 'imperial', fillTripInfo: false });
        assert.equal(env.doc.querySelector('.bpb-week-chart'), frame); assert.equal(env.doc.activeElement, frame);
        assert.equal(readout.textContent, pinned);
        update({ units: 'metric', fillTripInfo: false });
        frame = env.doc.querySelector('.bpb-week-chart');
        assert.equal(env.doc.activeElement, frame); assert.match(env.doc.querySelector('.bpb-week-readout').textContent, /12:00 AM PST.*°C/);
        assert.ok(env.doc.querySelector('.bpb-week-cursor'));
        env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.requests.length === 2 && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
        assert.equal(env.doc.activeElement, env.doc.querySelector('.bpb-week-chart'));
        assert.match(env.doc.querySelector('.bpb-week-readout').textContent, /12:00 AM PST.*°C/);
        const wind = env.doc.querySelector('[data-metric="wind"]'); wind.click(); wind.focus();
        update({ units: 'imperial' });
        assert.equal(env.doc.activeElement, env.doc.querySelector('[data-metric="wind"]'));
        update({ showWeather: false });
        assert.equal(env.doc.querySelector('#bpb-peak-weather').hidden, true);
    } finally { env.close(); }
});

test('refresh crossing the date window clears expired selection and gives focus a usable fallback', async () => {
    const env = setup();
    try {
        await settled(env, { past: false }); env.doc.querySelector('.bpb-week-day > summary').click();
        env.doc.querySelector('[data-metric="temperature"]').click();
        const frame = env.doc.querySelector('.bpb-week-chart'); frame.focus();
        frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        env.setNow('2024-12-05T12:00:00Z'); env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.requests.length === 2 && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
        assert.equal(env.doc.querySelector('.bpb-week-cursor'), null);
        assert.equal(env.doc.querySelector('.bpb-week-day[open]'), null);
        assert.equal(env.doc.activeElement, env.doc.querySelector('[data-period="forecast"]'));
    } finally { env.close(); }
});

test('weather opt-out hides the whole table row, skips requests and updates live across BFCache', async () => {
    const env = setup({ storedSettings: { showWeather: false } });
    const update = showWeather => env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather } } }, 'sync'));
    try {
        await new Promise(resolve => setTimeout(resolve, 0));
        const card = env.doc.getElementById('bpb-peak-weather'), row = card.closest('tr');
        assert.equal(card.hidden, true); assert.equal(row.hidden, true); assert.equal(env.requests.length, 0);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        assert.equal(env.requests.length, 0);
        update(true); await settled(env);
        assert.equal(card.hidden, false); assert.equal(row.hidden, false);
        const count = env.requests.length;
        update(false); assert.equal(card.hidden, true); assert.equal(row.hidden, true);
        card.querySelector('.bpb-week-refresh').click();
        env.win.dispatchEvent(new env.win.Event('visibilitychange'));
        assert.equal(env.requests.length, count);
        update(true); await settled(env);
        assert.equal(env.doc.querySelectorAll('#bpb-peak-weather').length, 1);
    } finally { env.close(); }
});

test('disabling weather aborts an in-flight forecast and ignores a late result', async () => {
    let finish;
    const env = setup({ fetchFn: url => new Promise(resolve => { finish = () => resolve(reply(url)); }) });
    try {
        await waitFor(() => env.requests.length === 1);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        assert.equal(env.requests[0].init.signal.aborted, true);
        finish(); await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(env.doc.getElementById('bpb-peak-weather').hidden, true);
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 0);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('a late startup read cannot override a weather opt-out and a failed read starts no request', async () => {
    let finish;
    const env = setup({ readSettings: () => new Promise(resolve => { finish = resolve; }) });
    try {
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        finish({ bpbSettings: { showWeather: true } });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(env.doc.getElementById('bpb-peak-weather').hidden, true); assert.equal(env.requests.length, 0);
    } finally { env.close(); }
    const failed = setup({ readSettings: async () => { throw new Error('Sync unavailable'); } });
    try {
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(failed.doc.getElementById('bpb-peak-weather').hidden, true); assert.equal(failed.requests.length, 0);
    } finally { failed.close(); }
});

test('peak identity and unique native coordinates fail closed without remote geocoding', () => {
    const doc = new JSDOM(peak).window.document;
    assert.equal(readPeakWeatherSubject(doc, 'https://www.peakbagger.com/Peak.aspx?pid=2296').elevation, 4391);
    for (const url of ['https://evil.test/Peak.aspx?pid=2296', 'https://www.peakbagger.com/Peak.aspx?pid=2296&pid=2829', 'https://www.peakbagger.com/Peak.aspx?pid=0']) assert.equal(readPeakWeatherSubject(doc, url), null);
    doc.querySelector('h1').after(doc.querySelector('h1').cloneNode(true));
    assert.equal(readPeakWeatherSubject(doc, 'https://www.peakbagger.com/Peak.aspx?pid=2296'), null);
    doc.querySelectorAll('h1')[1].remove();
    const coordinate = [...doc.querySelectorAll('tr')].find(row => row.cells[0]?.textContent.trim() === 'Latitude/Longitude (WGS84)');
    coordinate.after(coordinate.cloneNode(true));
    assert.equal(readPeakWeatherSubject(doc, 'https://www.peakbagger.com/Peak.aspx?pid=2296'), null);
});

test('weather stays beside the map when native peak details follow it', async () => {
    const fixture = new JSDOM(peak);
    const mapRow = fixture.window.document.getElementById('Gmap').closest('tr');
    mapRow.parentElement.prepend(mapRow);
    const nativeDetails = mapRow.nextElementSibling.textContent;
    const env = setup({ html: fixture.serialize() });
    fixture.window.close();
    try {
        await settled(env);
        const map = env.doc.getElementById('Gmap').closest('tr');
        const weather = env.doc.getElementById('bpb-peak-weather-row');
        assert.equal(map.nextElementSibling, weather);
        assert.equal(weather.nextElementSibling.textContent, nativeDetails);
    } finally { env.close(); }
});

test('card stays in the right native table below map and includes sixteen completed local days', async () => {
    const env = setup();
    try {
        await settled(env);
        const card = env.doc.getElementById('bpb-peak-weather'), map = env.doc.getElementById('Gmap');
        assert.equal(card.closest('table'), map.closest('table'));
        assert.equal(card.closest('table').getAttribute('align'), 'right');
        assert.equal(map.closest('tr').nextElementSibling, card.closest('tr'));
        assert.ok(map.compareDocumentPosition(card) & env.win.Node.DOCUMENT_POSITION_FOLLOWING);
        assert.deepEqual([...env.doc.querySelectorAll('.bpb-week-day')].map(day => day.dataset.date), ['2024-11-04', '2024-11-03', '2024-11-02', '2024-11-01', '2024-10-31', '2024-10-30', '2024-10-29', '2024-10-28', '2024-10-27', '2024-10-26', '2024-10-25', '2024-10-24', '2024-10-23', '2024-10-22', '2024-10-21', '2024-10-20']);
        assert.match(card.querySelector('.bpb-week-range').textContent, /Oct 20.*Nov 4, 2024/);
        assert.match(card.querySelector('.bpb-week-sub').textContent, /14406 ft.*16 completed days.*Today excluded/);
        assert.equal(card.querySelector('[data-period="past"]').textContent, 'Past 16 days');
        assert.equal(env.requests.length, 1); assert.equal(new URL(env.requests[0].url).host, 'api.open-meteo.com');
        assert.equal(env.requests[0].init.credentials, 'omit'); assert.equal(env.requests[0].init.referrerPolicy, 'no-referrer');
        assert.equal(card.querySelector('.bpb-week-attribution').textContent, 'Powered by Open-Meteo');
        assert.equal(card.querySelector('.bpb-week-attribution a').href, 'https://open-meteo.com/');
        env.win.eval(bundle); assert.equal(env.doc.querySelectorAll('#bpb-peak-weather').length, 1);
    } finally { env.close(); }
});

test('independent hourly disclosures retain local DST folds and change units without fetching', async () => {
    const env = setup();
    try {
        await settled(env);
        const fold = env.doc.querySelector('[data-date="2024-11-03"]'); fold.open = true;
        await waitFor(() => fold.querySelector('[role="tabpanel"]'));
        fold.querySelector('[data-metric="temperature"]').click();
        assert.equal(fold.querySelectorAll('.bpb-week-point').length, 25);
        assert.match(fold.textContent, /01:00 AM PDT/); assert.match(fold.textContent, /01:00 AM PST/);
        const conditions = fold.querySelector('[data-metric="code"]'); conditions.click();
        assert.equal(fold.querySelectorAll('.bpb-weather-conditions-hour').length, 25);
        assert.ok([...fold.querySelectorAll('[data-weather-row="code"] [role="img"]')].some(icon => icon.getAttribute('aria-label') === 'Light snow'));
        assert.equal(env.requests.length, 1);
        const previous = env.doc.querySelector('[data-date="2024-11-02"]'); previous.open = true;
        await waitFor(() => previous.querySelectorAll('.bpb-weather-conditions-hour').length === 24);
        assert.equal(fold.open, true);
        assert.equal(previous.querySelector('[aria-selected="true"]').dataset.metric, 'code');
        previous.querySelector('[data-metric="temperature"]').click();
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        const next = env.doc.querySelector('[data-date="2024-11-02"]');
        assert.equal(next.open, true); assert.match(next.textContent, /°C/); assert.match(next.textContent, /km\/h/);
        assert.match(next.querySelector('.bpb-week-chart svg').getAttribute('aria-label'), /°C/);
        assert.equal(env.doc.querySelector('[data-date="2024-11-03"]').open, true);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('hourly tabs, keyboard sampling, hover and pinned readings reuse data and resize inside the card', async () => {
    const env = setup();
    try {
        await settled(env);
        const day = env.doc.querySelector('.bpb-week-day'); day.open = true;
        await waitFor(() => day.querySelector('[role="tabpanel"]'));
        day.querySelector('[data-metric="temperature"]').click();
        const temperature = day.querySelector('[data-metric="temperature"]'), rain = day.querySelector('[data-metric="precipitation"]');
        const tabs = [...day.querySelectorAll('[role="tab"]')];
        assert.deepEqual(tabs.map(tab => tab.textContent), ['Conditions', 'Temperature', 'Rain/snow', 'Clouds', 'Wind', 'Gusts']);
        assert.deepEqual(tabs.map(tab => tab.dataset.label), tabs.map(tab => tab.textContent));
        assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-label')), tabs.map(tab => tab.textContent));
        assert.equal(temperature.getAttribute('aria-selected'), 'true'); assert.equal(temperature.tabIndex, 0); assert.equal(rain.tabIndex, -1);
        temperature.focus(); temperature.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        assert.equal(env.doc.activeElement, tabs[0]); assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
        assert.equal(day.querySelector('.bpb-week-conditions').hidden, false);
        tabs[0].dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        assert.equal(env.doc.activeElement, tabs.at(-1)); assert.equal(tabs.at(-1).dataset.metric, 'gust');
        tabs.at(-1).dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        tabs[0].dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        assert.equal(env.doc.activeElement, temperature);
        temperature.focus(); temperature.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        assert.equal(env.doc.activeElement, rain); assert.equal(rain.getAttribute('aria-selected'), 'true');
        assert.equal(day.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), rain.id);
        assert.equal(day.querySelector('.bpb-week-point title').textContent.includes('in'), true);
        const frame = day.querySelector('.bpb-week-chart'), readout = day.querySelector('.bpb-week-readout');
        frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        assert.match(readout.textContent, /next midnight.*in/);
        assert.equal(day.querySelectorAll('.bpb-week-cursor').length, 1);
        frame.dispatchEvent(new env.win.MouseEvent('pointermove', { clientX: 250 }));
        assert.doesNotMatch(readout.textContent, /next midnight/);
        frame.dispatchEvent(new env.win.MouseEvent('pointerleave'));
        assert.match(readout.textContent, /next midnight/);
        frame.dispatchEvent(new env.win.MouseEvent('click', { clientX: 250 }));
        const pinned = readout.textContent;
        frame.dispatchEvent(new env.win.MouseEvent('pointermove', { clientX: 500 }));
        assert.notEqual(readout.textContent, pinned);
        frame.dispatchEvent(new env.win.MouseEvent('pointerleave')); assert.equal(readout.textContent, pinned);
        frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.match(readout.textContent, /Low.*High/); assert.equal(day.querySelectorAll('.bpb-week-cursor').length, 0);
        env.resize(300); assert.equal(day.querySelector('.bpb-week-chart svg').getAttribute('viewBox'), '0 0 300 184');
        assert.equal(env.requests.length, 1);
        day.open = false; await waitFor(() => env.resizeObservers.every(observer => observer.disconnected));
        env.resize(700); assert.equal(day.querySelector('.bpb-week-hourly').childElementCount, 0);
    } finally { env.close(); }
});

test('missing hours break numeric lines and remain unavailable in conditions; missing rain never plots zero', async () => {
    const env = setup({ fetchFn: async url => {
        const body = await reply(url).json();
        body.hourly.precipitation.fill(null);
        const absent = body.hourly.time.indexOf(Date.parse('2024-11-04T16:00:00Z') / 1000);
        for (const values of Object.values(body.hourly)) values.splice(absent, 1);
        const missingTemperature = body.hourly.time.indexOf(Date.parse('2024-11-04T18:00:00Z') / 1000);
        body.hourly.temperature_2m[missingTemperature] = null;
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(env);
        const day = env.doc.querySelector('.bpb-week-day'); day.open = true;
        await waitFor(() => day.querySelector('[role="tabpanel"]'));
        day.querySelector('[data-metric="temperature"]').click();
        assert.equal(day.querySelectorAll('.bpb-week-point').length, 22);
        assert.equal((day.querySelector('.bpb-week-line').getAttribute('d').match(/M/g) || []).length, 3);
        const frame = day.querySelector('.bpb-week-chart');
        frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        for (let i = 0; i < 8; i++) frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        assert.match(day.querySelector('.bpb-week-readout').textContent, /08:00 AM PST.*Unavailable/);
        day.querySelector('[data-metric="code"]').click();
        assert.equal(day.querySelectorAll('.bpb-weather-conditions-hour').length, 24);
        assert.equal(day.querySelectorAll('[data-weather-row="code"] [role="img"]')[8].getAttribute('aria-label'), 'Unavailable');
        day.querySelector('[data-metric="precipitation"]').click();
        assert.equal(day.querySelector('.bpb-week-chart-empty').hidden, false);
        assert.equal(day.querySelector('.bpb-week-chart svg').hasAttribute('hidden'), true);
        assert.equal(day.querySelectorAll('.bpb-week-line').length, 0);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('horizontal Conditions exposes all measurements, interval values and retained scroll on a unit change', async () => {
    const env = setup();
    try {
        await settled(env); env.doc.querySelector('.bpb-week-day > summary').click();
        env.doc.querySelector('[data-metric="code"]').click();
        const grid = env.doc.querySelector('.bpb-week-conditions');
        assert.deepEqual([...grid.querySelectorAll('.bpb-weather-hourly-table > tbody > tr > th')].map(node => node.textContent),
            ['Conditions', 'Cloud cover', 'Temperature', 'Feels like', 'Rain/snow', 'Wind', 'Gusts', 'Wind from']);
        assert.equal(grid.querySelectorAll('.bpb-weather-conditions-hour').length, 24);
        assert.match(grid.querySelector('[data-weather-row="apparent"]').textContent, /18°F/);
        assert.match(grid.querySelector('[data-weather-row="direction"]').textContent, /SW/);
        const rain = [...grid.querySelectorAll('[data-weather-row="precipitation"] td')];
        assert.match(rain[0].title, /12:00 AM PST.*01:00 AM PST/);
        assert.match(rain.at(-1).title, /11:00 PM PST.*12:00 AM PST/);
        grid.scrollLeft = 340; grid.focus();
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        const next = env.doc.querySelector('.bpb-week-conditions');
        assert.equal(next.scrollLeft, 340); assert.equal(env.doc.activeElement, next);
        assert.match(next.querySelector('[data-weather-row="apparent"]').textContent, /−8°C/);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('expanded graph observers suspend, restore the chosen tab and disconnect on disposal', async () => {
    const env = setup();
    try {
        await settled(env);
        const day = env.doc.querySelector('.bpb-week-day'); day.open = true;
        await waitFor(() => day.querySelector('[role="tabpanel"]'));
        day.querySelector('[data-metric="gust"]').click();
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(env.resizeObservers.every(observer => observer.disconnected), true);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        await settled(env);
        assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'gust');
        assert.equal(env.resizeObservers.filter(observer => !observer.disconnected).length, 1);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide'));
        assert.equal(env.resizeObservers.every(observer => observer.disconnected), true);
        assert.equal(env.listeners.length, 0);
    } finally { env.close(); }
});

test('a dry day plots a flat rain line with distinct axis labels in both unit systems', async () => {
    const env = setup({ fetchFn: async url => {
        const body = await reply(url).json(); body.hourly.precipitation.fill(0);
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(env);
        const day = env.doc.querySelector('.bpb-week-day'); day.open = true;
        await waitFor(() => day.querySelector('[role="tabpanel"]'));
        day.querySelector('[data-metric="precipitation"]').click();
        const assertDry = () => {
            const graph = env.doc.querySelector('.bpb-week-day[open]');
            assert.equal(graph.querySelector('.bpb-week-chart-empty').hidden, true);
            assert.equal(new Set([...graph.querySelectorAll('.bpb-week-point')].map(node => node.getAttribute('cy'))).size, 1);
            assert.equal(new Set([...graph.querySelectorAll('.bpb-week-axis')].slice(0, 3).map(node => node.textContent)).size, 3);
        };
        assertDry();
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        assertDry(); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('missing map retains right-column card; lazy loading never starts before visibility', async () => {
    const env = setup({ html: peak.replace(/<iframe id="Gmap"[\s\S]*?<\/iframe>/, ''), lazy: true });
    try {
        assert.ok(env.doc.getElementById('bpb-peak-weather')); assert.equal(env.requests.length, 0);
        assert.equal(env.doc.getElementById('bpb-peak-weather').closest('table').getAttribute('align'), 'right');
        await waitFor(() => env.observers.length === 1);
        env.observers[0].callback([{ isIntersecting: true }]);
        await settled(env); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('missing map with multiple right tables fails closed, and empty weather leaves no false day controls', async () => {
    const noMap = new JSDOM(peak.replace(/<iframe id="Gmap"[\s\S]*?<\/iframe>/, '')).window.document;
    const table = noMap.querySelector('table.gray[align="right"]'); table.after(table.cloneNode(true));
    assert.equal(readPeakWeatherSubject(noMap, 'https://www.peakbagger.com/Peak.aspx?pid=2296'), null);
    const env = setup({ fetchFn: url => {
        const query = new URL(url).searchParams, hours = (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24;
        const body = weatherFixture({ startDate: query.get('start_date'), hours });
        Object.entries(body.hourly).forEach(([key, values]) => { if (key !== 'time') values.fill(null); });
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('unavailable for this summit'));
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 0);
        assert.equal(env.doc.querySelector('.bpb-week-help').hidden, true);
        assert.equal(env.doc.querySelector('.bpb-week-source').hidden, true);
        assert.equal(env.doc.querySelector('.bpb-week-refresh').disabled, false);
    } finally { env.close(); }
});

test('partial data survives a refused refresh while a headerless limit blocks another request', async () => {
    let limited = false;
    const env = setup({ fetchFn: url => {
        if (limited) return new Response('', { status: 429 });
        const query = new URL(url).searchParams, hours = (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24;
        const body = weatherFixture({ startDate: query.get('start_date'), hours }); body.hourly.precipitation.fill(null);
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(env);
        assert.equal(env.doc.querySelectorAll('.bpb-week-partial').length, 16);
        assert.ok([...env.doc.querySelectorAll('.bpb-week-metrics')].every(node => node.textContent.includes('Rain/snow —')));
        const range = env.doc.querySelector('.bpb-week-range').textContent;
        limited = true; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('Open-Meteo request limit reached'));
        assert.equal(env.doc.querySelector('.bpb-week-range').textContent, range);
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
        assert.equal(env.doc.querySelector('.bpb-week-status').dataset.kind, 'rate-limit');
        assert.equal(env.doc.querySelector('.bpb-week-refresh').disabled, true);
        assert.equal(env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy'), 'false');
        const requests = env.requests.length;
        env.doc.querySelector('.bpb-week-refresh').click();
        assert.equal(env.requests.length, requests, 'local cooldown blocks an immediate repeated refresh');
    } finally { env.close(); }
});

test('BFCache cancels stale requests and resolves a new completed date range on restore', async () => {
    let release;
    const env = setup({ fetchFn: url => new Promise(resolve => { release = () => resolve(reply(url)); }) });
    try {
        await waitFor(() => env.requests.length === 1);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(env.requests[0].init.signal.aborted, true);
        release();
        await waitFor(() => env.doc.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false');
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 0);
        env.win.Date.now = () => Date.parse('2024-11-06T12:00:00Z');
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        await waitFor(() => env.requests.length === 2); release(); await settled(env);
        assert.equal(env.doc.querySelector('.bpb-week-day').dataset.date, '2024-11-05');
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide'));
        assert.equal(env.listeners.length, 0);
    } finally { env.close(); }
});

test('forecast and history both show sixteen days and share one response, retaining a truncated final forecast day', async () => {
    const env = setup();
    try {
        await settled(env, { past: false });
        const dates = () => [...env.doc.querySelectorAll('.bpb-week-day')].map(day => day.dataset.date);
        assert.equal(dates().length, 16); assert.equal(dates()[0], '2024-11-05'); assert.equal(dates().at(-1), '2024-11-20');
        assert.ok(dates().every((date, index) => !index || date > dates()[index - 1]));
        assert.equal(env.doc.querySelector('[data-period="forecast"]').textContent, '16-day forecast');
        assert.equal(new URL(env.requests[0].url).searchParams.get('end_date'), '2024-11-20');
        assert.equal(new URL(env.requests[0].url).searchParams.get('start_date'), '2024-10-20');
        assert.match(env.doc.querySelector('.bpb-week-day:last-child .bpb-week-partial').textContent, /Incomplete hours/);
        assert.match(env.doc.querySelector('.bpb-week-day:last-child .bpb-week-metrics').textContent, /\(partial\)/);
        assert.equal(env.doc.querySelector('.bpb-week-date strong').textContent, 'Today');
        assert.match(env.doc.querySelector('.bpb-week-sub').textContent, /Today \+ 15 days/);
        assert.equal(env.doc.querySelector('[data-period="forecast"]').getAttribute('aria-selected'), 'true');
        const first = env.doc.querySelector('.bpb-week-day'); first.open = true;
        await waitFor(() => first.querySelector('[role="tabpanel"]'));
        first.querySelector('[data-metric="temperature"]').click();
        assert.deepEqual([...first.querySelectorAll('[role="tab"]')].map(tab => tab.textContent), ['Conditions', 'Temperature', 'Rain/snow', 'Clouds', 'Wind', 'Gusts']);
        assert.equal(first.querySelectorAll('.bpb-week-point').length, 24);
        assert.ok([...first.querySelectorAll('.bpb-week-point')].some(point => Number(point.dataset.time) > env.win.Date.now()));
        first.querySelector('[data-metric="precipitation"]').click();
        assert.equal(first.querySelectorAll('.bpb-week-point').length, 24);
        const past = env.doc.querySelector('[data-period="past"]');
        env.doc.querySelector('[data-period="forecast"]').focus();
        env.doc.activeElement.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        assert.equal(env.doc.activeElement, past); assert.equal(past.getAttribute('aria-selected'), 'true');
        assert.equal(env.doc.querySelector('#bpb-peak-weather-period').getAttribute('aria-labelledby'), past.id);
        assert.equal(dates().length, 16); assert.equal(dates()[0], '2024-11-04'); assert.equal(dates().at(-1), '2024-10-20');
        assert.match(env.doc.querySelector('.bpb-week-sub').textContent, /16 completed days.*Today excluded/);
        const oldest = env.doc.querySelector('.bpb-week-day:last-child'); oldest.open = true;
        await waitFor(() => oldest.querySelectorAll('.bpb-week-point').length === 24);
        assert.equal(oldest.querySelector('.bpb-week-partial'), null);
        env.doc.querySelector('[data-period="forecast"]').click();
        assert.equal(env.doc.querySelector('.bpb-week-day[open]').dataset.date, '2024-11-05');
        assert.equal(env.doc.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric, 'precipitation');
        assert.equal(env.resizeObservers.filter(observer => !observer.disconnected).length, 1);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('source details distinguish the clicked location from the returned weather grid', async () => {
    const env = setup({ fetchFn: async url => {
        const body = await (await reply(url)).json();
        body.latitude = 46.5074; body.longitude = -121.4852;
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(env, { past: false });
        selectLocation(env, 46.4947, -121.4636);
        await waitFor(() => env.doc.querySelector('.bpb-week-location-name').textContent === '46.4947, -121.4636');
        const request = new URL(env.requests.at(-1).url);
        assert.equal(request.searchParams.get('latitude'), '46.4947');
        assert.equal(request.searchParams.get('longitude'), '-121.4636');
        const source = env.doc.querySelector('.bpb-week-source-location').textContent;
        assert.match(source, /Selected location: 46\.4947, -121\.4636/);
        assert.match(source, /Weather grid point: 46\.5074, -121\.4852/);
        assert.match(source, /calculated on a grid.*differ from your location/);
        env.doc.querySelector('.bpb-week-location-reset').click();
        assert.match(env.doc.querySelector('.bpb-week-source-location').textContent, /^Summit: 46\.8517, -121\.7604/);
    } finally { env.close(); }
});

test('accuracy warning and accessible source disclosure identify the requested named model', async () => {
    const env = setup();
    try {
        await settled(env, { past: false });
        const accuracy = env.doc.querySelector('.bpb-week-accuracy'), source = env.doc.querySelector('.bpb-week-source');
        assert.equal(accuracy.hidden, false); assert.match(accuracy.textContent, /may be inaccurate.*farther ahead.*mountain summits/);
        assert.equal(source.hidden, false); assert.equal(source.open, false);
        assert.equal(source.querySelector('summary').textContent, 'Source details');
        source.open = true;
        const model = source.querySelector('.bpb-week-models').textContent;
        assert.match(model, /^GFS, 13 km\. Hourly forecast estimates\./);
        assert.match(model, /Summit timezone: America\/Los_Angeles/);
        assert.match(source.querySelector('.bpb-week-source-location').textContent, /Summit: [\d.-]+, [\d.-]+\. Weather grid point: [\d.-]+, [\d.-]+/);
        assert.match(model, /Temperature adjusted to 4391 m\. Loaded/);
        assert.doesNotMatch(source.textContent, /Model grids may differ/);
        env.doc.querySelector('[data-period="past"]').click();
        assert.equal(accuracy.hidden, true); assert.equal(source.open, true);
        assert.match(source.textContent, /Model estimates, not station observations/);
        assert.match(env.doc.querySelector('footer').textContent, /Estimates may be inaccurate/);
        env.doc.querySelector('[data-period="forecast"]').click();
        assert.equal(accuracy.hidden, false); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('model update times and cadence load only on disclosure, cover both GFS products and reuse metadata without weather requests', async () => {
    const stamp = Date.parse('2024-11-05T12:00:00Z') / 1000;
    const env = setup({ metadataFn: url => new Response(JSON.stringify({ last_run_initialisation_time: stamp - 3600,
        last_run_availability_time: stamp - 600, temporal_resolution_seconds: 3600,
        update_interval_seconds: url.includes('/ncep_gfs025/') ? 43200 : 21600 }), { headers: { 'content-type': 'application/json' } }) });
    try {
        await settled(env, { past: false }); assert.equal(env.metadataRequests.length, 0);
        const source = env.doc.querySelector('.bpb-week-source'); source.open = true;
        await waitFor(() => env.doc.querySelectorAll('[data-update-model]').length > 1 && !env.doc.querySelector('.bpb-week-updates').textContent.includes('Loading'));
        assert.equal(env.doc.querySelectorAll('[data-update-model]').length, 2);
        assert.equal(env.doc.querySelectorAll('[data-update-model="gfs_global"]').length, 2);
        assert.deepEqual(env.metadataRequests.map(({ url }) => new URL(url).pathname).sort(),
            ['/data/ncep_gfs013/static/meta.json', '/data/ncep_gfs025/static/meta.json']);
        assert.match(env.doc.querySelector('.bpb-week-updates').textContent, /GFS · 13 km.*GFS · 25 km/);
        assert.match(env.doc.querySelector('.bpb-week-updates').textContent, /Nov 5.*PST/);
        assert.deepEqual([...env.doc.querySelectorAll('.bpb-week-updates-table thead th')].map(cell => cell.textContent), ['Model', 'Last update', 'Next expected', 'Update interval']);
        const nextCells = env.doc.querySelectorAll('[data-update-model] td:nth-child(3)');
        assert.match(nextCells[0].textContent, /Nov 5 09:50 AM PST/);
        assert.match(nextCells[1].textContent, /Nov 5 03:50 PM PST/);
        assert.deepEqual([...env.doc.querySelectorAll('[data-update-model] td:last-child')].map(cell => cell.textContent), ['Every 6 h', 'Every 12 h']);
        assert.match(env.doc.querySelector('.bpb-week-updates-note').textContent, /Next updates are estimates.*Provider-wide/);
        const count = env.metadataRequests.length;
        source.open = false; await new Promise(resolve => setTimeout(resolve, 0)); source.open = true;
        await waitFor(() => !env.doc.querySelector('.bpb-week-updates').textContent.includes('Loading'));
        assert.equal(env.metadataRequests.length, count); assert.equal(env.requests.length, 1);
        assert.ok(env.metadataRequests.every(({ url, init }) => !new URL(url).search && init.credentials === 'omit' && init.referrerPolicy === 'no-referrer'));
        env.setNow('2024-11-05T22:00:00Z');
        source.open = false; await new Promise(resolve => setTimeout(resolve, 0)); source.open = true;
        await waitFor(() => env.metadataRequests.length === count + 2 && !env.doc.querySelector('.bpb-week-updates').textContent.includes('Loading'));
        const refreshedNext = env.doc.querySelectorAll('[data-update-model] td:nth-child(3)');
        assert.match(refreshedNext[0].textContent, /\(delayed\)/);
        assert.doesNotMatch(refreshedNext[1].textContent, /\(delayed\)/);
        assert.deepEqual([...env.doc.querySelectorAll('[data-update-model] td:last-child')].map(cell => cell.textContent), ['Every 6 h', 'Every 12 h']);
        assert.equal(env.metadataRequests.length, count + 2); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('update clocks follow only the active period model and reuse cached products', async () => {
    const env = setup({ localModels: { bpbPeakWeatherModelPast: 'icon_global', bpbPeakWeatherModelForecast: 'gfs_global' } });
    const rows = () => [...env.doc.querySelectorAll('[data-update-model]')].map(row => row.dataset.updateModel);
    const ready = id => rows().length && rows().every(model => model === id) && !env.doc.querySelector('.bpb-week-updates').textContent.includes('Loading');
    try {
        await settled(env, { past: false });
        assert.equal(env.metadataRequests.length, 0);
        env.doc.querySelector('.bpb-week-source').open = true;
        await waitFor(() => ready('gfs_global'));
        assert.deepEqual(rows(), ['gfs_global', 'gfs_global']);
        assert.equal(env.metadataRequests.length, 2);
        env.doc.querySelector('[data-period="past"]').click();
        await waitFor(() => ready('icon_global'));
        assert.deepEqual(rows(), ['icon_global']);
        assert.equal(env.metadataRequests.length, 3);
        assert.equal(new URL(env.metadataRequests[2].url).pathname, '/data/dwd_icon/static/meta.json');
        chooseModel(env, 'ecmwf_ifs');
        await waitFor(() => ready('ecmwf_ifs'));
        assert.equal(env.metadataRequests.length, 4);
        assert.equal(new URL(env.metadataRequests[3].url).pathname, '/data/ecmwf_ifs/static/meta.json');
        env.doc.querySelector('[data-period="forecast"]').click();
        await waitFor(() => ready('gfs_global'));
        assert.equal(env.metadataRequests.length, 4, 'returning to GFS reuses its cached products');
        env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false' && ready('gfs_global'));
        assert.equal(env.metadataRequests.length, 6, 'explicit refresh reloads only the active model products');
        assert.ok(env.metadataRequests.slice(4).every(({ url }) => /\/data\/ncep_gfs0(13|25)\//.test(url)));
    } finally { env.close(); }
});

test('model changes cancel old update requests and failed changes keep clocks with retained weather', async () => {
    let failWeather = false, metadataCalls = 0;
    const env = setup({ fetchFn: url => failWeather ? new Response('', { status: 503 }) : reply(url),
        metadataFn: (_, init) => ++metadataCalls <= 2 ? new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
        }) : Promise.resolve(new Response(JSON.stringify({ last_run_initialisation_time: 1730797200,
            last_run_availability_time: 1730807400, update_interval_seconds: 21600 }), { headers: { 'content-type': 'application/json' } })) });
    try {
        await settled(env, { past: false });
        env.doc.querySelector('.bpb-week-source').open = true;
        await waitFor(() => env.metadataRequests.length === 2);
        failWeather = true; chooseModel(env, 'ecmwf_ifs');
        assert.ok(env.metadataRequests.every(({ init }) => init.signal.aborted), 'selection immediately cancels the old metadata');
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('Showing GFS · 13 km.'));
        await waitFor(() => !env.doc.querySelector('.bpb-week-updates').textContent.includes('Loading'));
        assert.equal(env.doc.querySelector('select').value, 'ecmwf_ifs');
        assert.deepEqual([...env.doc.querySelectorAll('[data-update-model]')].map(row => row.dataset.updateModel), ['gfs_global', 'gfs_global']);
        assert.equal(env.metadataRequests.length, 4);
        assert.ok(env.metadataRequests.every(({ url }) => /\/data\/ncep_gfs0(13|25)\//.test(url)));
    } finally { env.close(); }
});

test('Best Match and unmapped selected models show one row without metadata requests', async () => {
    for (const [id, text] of [['best_match', 'Varies by model'], ['bom_access_global', 'Unavailable']]) {
        const env = setup({ localModels: { bpbPeakWeatherModelPast: id, bpbPeakWeatherModelForecast: id } });
        try {
            await waitFor(() => env.doc.querySelectorAll('.bpb-week-day').length > 0
                && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
            assert.equal(env.doc.querySelector('select').value, id);
            env.doc.querySelector('.bpb-week-source').open = true;
            await waitFor(() => env.doc.querySelector(`[data-update-model="${id}"]`));
            assert.equal(env.doc.querySelectorAll('[data-update-model]').length, 1);
            assert.deepEqual([...env.doc.querySelectorAll('[data-update-model] td')].map(cell => cell.textContent), [text, text, text]);
            assert.equal(env.metadataRequests.length, 0);
        } finally { env.close(); }
    }
});

test('selected-model update requests stay bounded, cancel on opt-out and do not replace usable weather on failure', async () => {
    let held = [], active = 0, maximum = 0;
    const env = setup({ metadataFn: (_, init) => new Promise(resolve => {
        active++; maximum = Math.max(maximum, active);
        const finish = () => { active--; resolve(new Response('', { status: 503 })); };
        held.push(finish); init.signal.addEventListener('abort', finish, { once: true });
    }) });
    try {
        await settled(env); const days = env.doc.querySelectorAll('.bpb-week-day').length;
        env.doc.querySelector('.bpb-week-source').open = true;
        await waitFor(() => env.metadataRequests.length === 2);
        assert.equal(maximum, 2);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        assert.ok(env.metadataRequests.every(({ init }) => init.signal.aborted));
        held = []; await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(env.metadataRequests.length, 2); assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, days);
    } finally { env.close(); }
    const failed = setup({ metadataFn: async () => new Response('', { status: 503 }) });
    try {
        await settled(failed); failed.doc.querySelector('.bpb-week-source').open = true;
        await waitFor(() => failed.metadataRequests.length === 2 && !failed.doc.querySelector('.bpb-week-updates').textContent.includes('Loading'));
        assert.match(failed.doc.querySelector('.bpb-week-updates').textContent, /Unavailable/);
        assert.equal(failed.doc.querySelectorAll('.bpb-week-day').length, 16); assert.equal(failed.requests.length, 1);
    } finally { failed.close(); }
});

test('a failed weather refresh cannot leave cancelled model metadata loading forever', async () => {
    let failWeather = false, metadataCalls = 0;
    const env = setup({ fetchFn: url => failWeather ? new Response('', { status: 503 }) : reply(url),
        metadataFn: () => ++metadataCalls <= 2 ? new Promise(() => {}) : Promise.resolve(new Response('', { status: 503 })) });
    try {
        await settled(env); env.doc.querySelector('.bpb-week-source').open = true;
        await waitFor(() => env.metadataRequests.length === 2);
        failWeather = true; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('Showing GFS · 13 km.'));
        await waitFor(() => !env.doc.querySelector('.bpb-week-updates').textContent.includes('Loading'));
        assert.ok(env.metadataRequests.slice(0, 2).every(({ init }) => init.signal.aborted));
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
    } finally { env.close(); }
});

test('forecast weather uses expected language and missing forecast hours cannot fabricate future conditions', async () => {
    const snowy = setup({ fetchFn: async url => {
        const body = await reply(url).json(); body.hourly.weather_code.fill(71);
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(snowy, { past: false });
        assert.equal(snowy.doc.querySelector('.bpb-week-condition').textContent, 'Snow expected');
        snowy.doc.querySelector('[data-period="past"]').click();
        assert.equal(snowy.doc.querySelector('.bpb-week-condition').textContent, 'Snow occurred');
    } finally { snowy.close(); }
    const absent = setup({ fetchFn: async url => {
        const body = await reply(url).json();
        for (let index = 0; index < body.hourly.time.length; index++) {
            if (body.hourly.time[index] * 1000 >= Date.parse('2024-11-05T08:00:00Z')) {
                for (const [key, values] of Object.entries(body.hourly)) if (key !== 'time') values[index] = null;
            }
        }
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await waitFor(() => absent.doc.querySelector('.bpb-week-status').textContent.includes('Forecast is unavailable'));
        assert.equal(absent.doc.querySelectorAll('.bpb-week-day').length, 0);
        absent.doc.querySelector('[data-period="past"]').click();
        assert.equal(absent.doc.querySelectorAll('.bpb-week-day').length, 16);
        assert.equal(absent.requests.length, 1);
    } finally { absent.close(); }
});

test('switching periods preserves the previous response and a known rate-limit warning', async () => {
    let limited = false;
    const env = setup({ fetchFn: url => limited ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : reply(url) });
    try {
        await settled(env, { past: false });
        limited = true; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').dataset.kind === 'rate-limit');
        const warning = env.doc.querySelector('.bpb-week-status').textContent;
        env.doc.querySelector('[data-period="past"]').click();
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
        assert.equal(env.doc.querySelector('.bpb-week-status').textContent, warning);
        assert.equal(env.doc.querySelector('.bpb-week-refresh').disabled, true);
        env.doc.querySelector('[data-period="forecast"]').click();
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
        assert.equal(env.doc.querySelector('.bpb-week-status').dataset.kind, 'rate-limit');
        assert.equal(env.requests.length, 2);
    } finally { env.close(); }
});

test('returning to a visible card refreshes an expired forecast without looping after a limit', async () => {
    let limited = false;
    const env = setup({ fetchFn: url => limited ? new Response('', { status: 429 }) : reply(url) });
    try {
        await settled(env, { past: false });
        env.setNow('2024-11-05T12:04:59Z');
        env.doc.dispatchEvent(new env.win.Event('visibilitychange'));
        assert.equal(env.requests.length, 1);
        env.setNow('2024-11-05T12:05:00Z');
        env.doc.dispatchEvent(new env.win.Event('visibilitychange'));
        await waitFor(() => env.requests.length === 2);
        await settled(env, { past: false });
        limited = true; env.setNow('2024-11-05T12:10:00Z');
        env.doc.dispatchEvent(new env.win.Event('visibilitychange'));
        await waitFor(() => env.doc.querySelector('.bpb-week-status').dataset.kind === 'rate-limit');
        env.setNow('2024-11-05T12:20:00Z');
        env.doc.dispatchEvent(new env.win.Event('visibilitychange'));
        assert.equal(env.requests.length, 3);
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
    } finally { env.close(); }
});

test('weather summaries name low/high and max wind; shared icons retain night and unavailable semantics', async () => {
    const env = setup({ fetchFn: async url => {
        const body = await reply(url).json();
        body.hourly.weather_code.fill(0);
        body.hourly.weather_code[body.hourly.time.indexOf(Date.parse('2024-11-04T10:00:00Z') / 1000)] = null;
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(env);
        const day = env.doc.querySelector('.bpb-week-day');
        const temperatures = day.querySelector('.bpb-week-temp');
        assert.match(temperatures.textContent, /^Low .*°F High .*°F$/);
        assert.equal(temperatures.textContent.includes('·'), false, 'temperature columns use spacing without a separator');
        assert.match(temperatures.querySelector('.bpb-week-low').textContent, /^Low .*°F$/);
        assert.match(temperatures.querySelector('.bpb-week-high').textContent, /^High .*°F$/);
        assert.match(day.querySelector('.bpb-week-metrics').textContent, /Max wind/);
        assert.equal(day.querySelector('.bpb-week-icon').getAttribute('aria-hidden'), 'true');
        day.open = true;
        await waitFor(() => day.querySelector('[role="tabpanel"]'));
        day.querySelector('[data-metric="code"]').click();
        const icons = [...day.querySelectorAll('[data-weather-row="code"] [role="img"]')];
        assert.equal(icons[0].dataset.condition, 'moon');
        assert.equal(icons[0].getAttribute('aria-label'), 'Clear');
        assert.equal(icons[2].dataset.condition, 'unknown');
        assert.equal(icons[2].getAttribute('aria-label'), 'Unavailable');
        assert.ok(icons.some(icon => icon.dataset.condition === 'sun'));
        assert.equal(env.requests.length, 1, 'illustrations do not request remote assets');
    } finally { env.close(); }
});

test('peak Best Match choices persist independently, share requests and disclose automatic provenance', async () => {
    const localModels = { bpbPeakWeatherModelPast: 'best_match', bpbPeakWeatherModelForecast: 'gfs_global' };
    const env = setup({ localModels });
    try {
        await settled(env, { past: false });
        assert.equal(env.doc.querySelector('select').options[0].value, 'best_match');
        assert.equal(new URL(env.requests[0].url).searchParams.get('models'), 'best_match,gfs_global');
        env.doc.querySelector('[data-period="past"]').click();
        assert.equal(env.doc.querySelector('select').value, 'best_match');
        assert.match(env.doc.querySelector('.bpb-week-models').textContent, /Best Match\. Open-Meteo automatic blend; source models vary/);
        assert.match(env.doc.querySelector('.bpb-week-source-location').textContent, /Model grids may differ/);
        assert.equal(env.requests.length, 1);
        env.doc.querySelector('.bpb-week-source').open = true;
        await waitFor(() => env.doc.querySelector('[data-update-model="best_match"]'));
        assert.equal(env.doc.querySelector('[data-update-model="best_match"] td').textContent, 'Varies by model');
        env.doc.querySelector('[data-period="forecast"]').click();
        assert.equal(env.doc.querySelector('select').value, 'gfs_global');
        chooseModel(env, 'best_match');
        await waitFor(() => env.doc.querySelector('.bpb-week-models').textContent.includes('Best Match'));
        assert.equal(new URL(env.requests[1].url).searchParams.get('models'), 'best_match');
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
        assert.equal(localModels.bpbPeakWeatherModelForecast, 'best_match');
        assert.equal(localModels.bpbPeakWeatherModelPast, 'best_match');
        const day = env.doc.querySelector('.bpb-week-day'); day.open = true;
        await waitFor(() => day.querySelector('[role="tabpanel"]'));
        assert.equal(env.requests.length, 2);
    } finally { env.close(); }
    const next = setup({ localModels });
    try {
        await settled(next, { past: false });
        assert.equal(next.doc.querySelector('select').value, 'best_match');
        assert.equal(new URL(next.requests[0].url).searchParams.get('models'), 'best_match');
    } finally { next.close(); }
});
