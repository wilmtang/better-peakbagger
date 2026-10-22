import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { weatherFixture } from '../helpers/weather-fixture.mjs';
import { GPX_TIME_CURSOR } from '../../src/gpx/gpx-time-cursor.js';
import { pointerEvent } from '../helpers/pointer-event.mjs';

const [ascent, peak, bundle, layoutBundle, challenge] = await Promise.all([
    readFile(new URL('../fixtures/pages/climber-ascent.html', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/ascent-weather.js', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/ascent-layout.js', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/pages/cloudflare-challenge.html', import.meta.url), 'utf8'),
]);
const moveKey = (env, key) => env.doc.querySelector('.bpb-card-drag-handle').dispatchEvent(new env.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
async function waitFor(predicate) {
    const until = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > until) throw new Error('Weather UI did not settle'); await pause(); }
}
const setup = ({ html = ascent.replaceAll('Sunday, July 12, 2026', 'Friday, July 12, 2024'), fetchWeather, fetchPeak, withLayout = true, storedSettings = {}, readSettings, localPositions = {}, readPositions, savePositions,
    localModels = {}, readModels, saveModels, configureWindow, now } = {}) => {
    const jsdom = new JSDOM(html, { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = jsdom.window, requests = [], listeners = [], positionWrites = [], modelWrites = [];
    if (now !== undefined) win.Date.now = () => now;
    win.AbortController = AbortController; win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder;
    configureWindow?.(win);
    win.chrome = { storage: { local: { get: async key => key === 'bpbAscentWeatherModel'
        ? (readModels ? readModels() : localModels) : (readPositions ? readPositions() : localPositions), set: async values => {
        if ('bpbAscentWeatherModel' in values) {
            modelWrites.push(values);
            if (saveModels) return saveModels(values);
            Object.assign(localModels, values); return;
        }
        positionWrites.push(values);
        if (savePositions) return savePositions(values);
        Object.assign(localPositions, values);
    } }, sync: { get: readSettings || (async () => ({ bpbSettings: { units: 'imperial', ...storedSettings } })) }, onChanged: { addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1) } } };
    win.fetch = async (url, init) => {
        requests.push({ url, init });
        if (new URL(url).host === 'www.peakbagger.com' && fetchPeak) return fetchPeak(url, init);
        if (new URL(url).host === 'www.peakbagger.com') return new Response(peak, { headers: { 'content-type': 'text/html' } });
        if (fetchWeather) return fetchWeather(url, init);
        return new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } });
    };
    if (withLayout) win.eval(layoutBundle);
    win.eval(bundle);
    return { win, doc: win.document, requests, listeners, positionWrites, modelWrites, close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
};

test('archive model choices persist locally and restore before the first request without storing ascent data', async () => {
    const localModels = {}, env = setup({ localModels, fetchWeather: archiveResponse });
    try {
        await openChart(env);
        const select = env.doc.querySelector('.bpb-weather-model select');
        select.value = 'gfs_global'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => localModels.bpbAscentWeatherModel === 'gfs_global');
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using GFS'));
        assert.deepEqual(localModels, { bpbAscentWeatherModel: 'gfs_global' });
        assert.deepEqual(env.modelWrites.map(value => ({ ...value })), [{ bpbAscentWeatherModel: 'gfs_global' }]);
    } finally { env.close(); }
    const restored = setup({ localModels, fetchWeather: archiveResponse });
    try {
        await waitFor(() => restored.requests.some(request => new URL(request.url).hostname !== 'www.peakbagger.com'));
        assert.equal(new URL(restored.requests[1].url).searchParams.get('models'), 'gfs_global');
        assert.equal(restored.doc.querySelector('select').value, 'gfs_global');
        assert.equal(restored.modelWrites.length, 0, 'restoring must not write a default over the saved choice');
    } finally { restored.close(); }
});

test('unsupported archive choices use Best Match for this visit without erasing the preference', async () => {
    for (const choice of ['gfs_global', 'icon_d2']) {
        const localModels = { bpbAscentWeatherModel: choice };
        const env = setup({ localModels, html: ascent.replaceAll('Sunday, July 12, 2026', 'Sunday, July 12, 2020'), fetchWeather: archiveResponse });
        try {
            await openChart(env);
            assert.equal(new URL(env.requests[1].url).searchParams.get('models'), 'best_match');
            assert.equal(localModels.bpbAscentWeatherModel, choice);
            assert.equal(env.modelWrites.length, 0);
        } finally { env.close(); }
        if (choice === 'gfs_global') {
            const supported = setup({ localModels, fetchWeather: archiveResponse });
            try {
                await waitFor(() => supported.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using GFS'));
                assert.equal(new URL(supported.requests[1].url).searchParams.get('models'), 'gfs_global');
                assert.equal(supported.modelWrites.length, 0);
            } finally { supported.close(); }
        }
    }
});

test('delayed archive preference reads make no premature default request or request after opt-out', async () => {
    let finish;
    const env = setup({ readModels: () => new Promise(resolve => { finish = resolve; }), fetchWeather: archiveResponse });
    try {
        await waitFor(() => finish);
        await waitFor(() => env.doc.querySelector('#bpb-ascent-weather').hidden === false);
        assert.equal(env.requests.length, 0);
        finish({ bpbAscentWeatherModel: 'gfs_global' });
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using GFS'));
        assert.equal(new URL(env.requests[1].url).searchParams.get('models'), 'gfs_global');
    } finally { env.close(); }
    const optedOut = setup({ readModels: () => new Promise(resolve => { finish = resolve; }) });
    try {
        await waitFor(() => !optedOut.doc.querySelector('#bpb-ascent-weather').hidden);
        optedOut.listeners.forEach(listener => listener({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        finish({ bpbAscentWeatherModel: 'gfs_global' }); await pause();
        assert.equal(optedOut.requests.length, 0);
    } finally { optedOut.close(); }
});

test('malformed or failed archive preference reads retain usable Best Match without saving a fallback', async () => {
    for (const value of ['unknown-model', { id: 'gfs_global' }, null, 123]) {
        const env = setup({ localModels: { bpbAscentWeatherModel: value }, fetchWeather: archiveResponse });
        try { await openChart(env); assert.equal(env.modelWrites.length, 0); }
        finally { env.close(); }
    }
    const failed = setup({ readModels: async () => { throw new Error('Unavailable'); }, fetchWeather: archiveResponse });
    try { await openChart(failed); assert.equal(new URL(failed.requests[1].url).searchParams.get('models'), 'best_match'); }
    finally { failed.close(); }
});

test('rapid archive choices serialize local writes and only the latest failure can describe the selection', async () => {
    const held = [], localModels = {};
    const env = setup({ localModels, fetchWeather: archiveResponse, saveModels: values => new Promise((resolve, reject) => {
        held.push({ values, resolve: () => { Object.assign(localModels, values); resolve(); }, reject });
    }) });
    try {
        await openChart(env);
        const select = env.doc.querySelector('select');
        select.value = 'gfs_global'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => held.length === 1);
        select.value = 'ecmwf_ifs'; select.dispatchEvent(new env.win.Event('change')); await pause();
        assert.equal(held.length, 1);
        held[0].reject(new Error('Older write failed'));
        await waitFor(() => held.length === 2);
        assert.equal(held[1].values.bpbAscentWeatherModel, 'ecmwf_ifs');
        held[1].resolve();
        await waitFor(() => localModels.bpbAscentWeatherModel === 'ecmwf_ifs');
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using ECMWF IFS'));
        assert.doesNotMatch(env.doc.querySelector('.bpb-weather-model-description').textContent, /could not be saved/);
    } finally { held.forEach(item => item.resolve()); env.close(); }
});

test('a stalled archive preference read times out without a late response changing the active model', async () => {
    let finish;
    const env = setup({ fetchWeather: archiveResponse, readModels: () => new Promise(resolve => { finish = resolve; }),
        configureWindow: win => {
            const setTimer = win.setTimeout.bind(win);
            win.setTimeout = (callback, delay, ...args) => setTimer(callback, delay === 2000 ? 0 : delay, ...args);
        } });
    try {
        await openChart(env);
        assert.equal(new URL(env.requests[1].url).searchParams.get('models'), 'best_match');
        finish({ bpbAscentWeatherModel: 'gfs_global' }); await pause();
        assert.equal(env.doc.querySelector('select').value, 'best_match');
        assert.equal(env.requests.length, 2);
        assert.equal(env.modelWrites.length, 0);
    } finally { env.close(); }
});

test('an archive model save failure keeps the chosen data usable and reports that it was not remembered', async () => {
    const env = setup({ fetchWeather: archiveResponse, saveModels: async () => { throw new Error('Unavailable'); } });
    try {
        await openChart(env);
        const select = env.doc.querySelector('select');
        select.value = 'gfs_global'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Not remembered locally'));
        await waitFor(() => env.doc.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'false');
        assert.equal(select.value, 'gfs_global');
        assert.match(env.doc.querySelector('.bpb-weather-source-text').textContent, /^GFS,/);
        assert.match(env.doc.querySelector('.bpb-weather-model-description span').title, /For this visit only/);
        assert.equal(env.doc.querySelector('.bpb-weather-model-description span').hidden, false);
    } finally { env.close(); }
});

const sendCursor = (env, state, detail = {}) => env.win.dispatchEvent(new env.win.MessageEvent('message', {
    source: env.win, origin: env.win.location.origin,
    data: { type: GPX_TIME_CURSOR, hovering: false, hoverTime: null, selected: false, selectionTime: null, ...state }, ...detail,
}));
const openChart = async env => {
    await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'));
    env.doc.querySelector('.bpb-weather-chart').getBoundingClientRect = () => ({ width: 500 });
    env.doc.querySelector('.bpb-weather-disclosure').click();
    env.doc.querySelector('[data-metric="temperature"]').click();
};

const archiveResponse = url => new Response(JSON.stringify(weatherFixture({
    startDate: new URL(url).searchParams.get('start_date'),
    hours: (Date.parse(new URL(url).searchParams.get('end_date')) - Date.parse(new URL(url).searchParams.get('start_date'))) / 3600_000 + 24,
    fields: new URL(url).searchParams.get('hourly').split(','),
})), { headers: { 'content-type': 'application/json' } });

test('Cloudflare verification documents never mount an archive card or make requests', async () => {
    for (const html of [challenge, challenge.replace('<title>Just a moment...</title>', '<title>Verify your browser</title>')]) {
        const env = setup({ html });
        try {
            await pause();
            assert.equal(env.doc.getElementById('bpb-ascent-weather'), null);
            assert.equal(env.doc.getElementById('bpb-ascent-gpx-details'), null);
            assert.equal(env.requests.length, 0);
        } finally { env.close(); }
    }
});

test('verification prose in a real ascent report does not suppress weather', async () => {
    const report = setup({ html: ascent.replace('Sunday, July 12, 2026', 'Friday, July 12, 2024')
        .replace('<b>Great climb</b>', '<b>Great climb</b><p>Just a moment... Cloudflare verified the browser.</p>') });
    try { await openChart(report); assert.equal(report.doc.getElementById('bpb-ascent-weather').hidden, false); }
    finally { report.close(); }
});

test('negative daily temperatures stay distinct across zero and unit changes without refetching', async () => {
    for (const [low, high, fahrenheit] of [[-35, -29, '−31° / −20°F'], [-2, 3, '28° / 37°F']]) {
        const env = setup({ storedSettings: { units: 'metric' }, fetchWeather: async url => {
            const body = await archiveResponse(url).json();
            body.hourly.temperature_2m = body.hourly.temperature_2m.map((_, index) => index % 2 ? high : low);
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        } });
        try {
            await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'));
            const value = env.doc.querySelector('[data-weather-value="temperature"]');
            assert.equal(value.textContent, `${low}° / ${high}°C`.replaceAll('-', '−'));
            const requests = env.requests.length;
            env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'imperial' } } }, 'sync'));
            assert.equal(value.textContent, fahrenheit);
            assert.equal(env.requests.length, requests);
        } finally { env.close(); }
    }
});

test('archive cards, hourly tables and axes use independent measurement units without refetching', async () => {
    const storedSettings = { units: 'imperial', temperatureUnits: 'metric', precipitationUnits: 'metric', windUnits: 'imperial', elevationUnits: 'metric' };
    const env = setup({ storedSettings });
    try {
        await openChart(env);
        assert.match(env.doc.querySelector('[data-weather-value="temperature"]').textContent, /°C/);
        assert.match(env.doc.querySelector('[data-weather-value="precipitation"]').textContent, /mm/);
        assert.match(env.doc.querySelector('[data-weather-value="wind"]').textContent, /mph/);
        assert.match(env.doc.querySelector('.bpb-weather-location').textContent, /\d+ m\b/);
        assert.match(env.doc.querySelector('.bpb-weather-chart').getAttribute('aria-label'), /Temperature.*°C/);
        assert.match(env.doc.querySelector('[data-weather-row="temperature"] td').textContent, /°C/);
        const requests = env.requests.length;
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { ...storedSettings, windUnits: 'metric' } } }, 'sync'));
        assert.match(env.doc.querySelector('[data-weather-value="wind"]').textContent, /km\/h/);
        env.doc.querySelector('[data-metric="precipitation"]').click();
        assert.match(env.doc.querySelector('.bpb-weather-chart').getAttribute('aria-label'), /precipitation.*mm/);
        assert.equal(env.requests.length, requests);
    } finally { env.close(); }
});

test('archive date buttons browse adjacent days without changing the saved ascent or hourly view', async () => {
    const env = setup({ fetchWeather: archiveResponse });
    try {
        await openChart(env);
        const date = env.doc.querySelector('.bpb-weather-date'), card = env.doc.querySelector('#bpb-ascent-weather');
        const previous = card.querySelector('[aria-label="Previous day"]'), next = card.querySelector('[aria-label="Next day"]');
        const saved = env.doc.querySelector('.bpb-ascent-table-split__summary').textContent;
        assert.equal(card.querySelectorAll('input, [role="combobox"]').length, 0, 'no date picker or editable date');
        assert.match(date.textContent, /July 12, 2024/);
        env.doc.querySelector('.bpb-weather-chart-frame').dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        assert.ok(env.doc.querySelector('.bpb-weather-reading-cursor'));
        previous.click();
        await waitFor(() => card.getAttribute('aria-busy') === 'false' && /July 11, 2024/.test(date.textContent));
        assert.equal(new URL(env.requests.at(-1).url).searchParams.get('start_date'), '2024-07-10');
        assert.equal(env.doc.querySelector('.bpb-weather-reading-cursor'), null, 'a pinned weather reading belongs to its old day');
        assert.equal(env.doc.querySelector('[data-metric="temperature"]').getAttribute('aria-selected'), 'true');
        assert.equal(env.doc.querySelector('.bpb-weather-disclosure').getAttribute('aria-expanded'), 'true');
        assert.match(env.doc.querySelector('.bpb-weather-condition').textContent, /Conditions during this day/);
        sendCursor(env, { selected: true, selectionTime: Date.parse('2024-07-12T19:00:00Z') });
        await waitFor(() => env.doc.querySelector('.bpb-weather-cursor-label').textContent === 'Outside displayed day');
        next.click();
        await waitFor(() => card.getAttribute('aria-busy') === 'false' && /July 12, 2024/.test(date.textContent));
        assert.match(env.doc.querySelector('.bpb-weather-condition').textContent, /Conditions during the ascent day/);
        next.click();
        await waitFor(() => card.getAttribute('aria-busy') === 'false' && /July 13, 2024/.test(date.textContent));
        assert.equal(env.doc.querySelector('.bpb-ascent-table-split__summary').textContent, saved);
        assert.equal(env.requests.filter(request => new URL(request.url).host === 'www.peakbagger.com').length, 1);
        assert.ok(env.requests.slice(1).every(request => new URL(request.url).host === 'archive-api.open-meteo.com'));
    } finally { env.close(); }
});

test('pending and failed archive navigation retain the old date, chart bounds and values; Retry targets the failed day', async () => {
    let finish, available = false;
    const env = setup({ fetchWeather: url => !available && new URL(url).searchParams.get('start_date') === '2024-07-10'
        ? new Promise(resolve => { finish = () => resolve(new Response('', { status: 400 })); }) : archiveResponse(url) });
    try {
        await openChart(env);
        const date = env.doc.querySelector('.bpb-weather-date'), card = env.doc.querySelector('#bpb-ascent-weather');
        const previous = card.querySelector('[aria-label="Previous day"]');
        const before = env.doc.querySelector('[data-weather-value="temperature"]').textContent;
        previous.focus(); previous.click(); await waitFor(() => finish);
        assert.equal(previous.getAttribute('aria-disabled'), 'true');
        assert.equal(card.querySelector('[aria-label="Next day"]').getAttribute('aria-disabled'), 'true');
        assert.equal(env.doc.activeElement, previous);
        const pendingRequests = env.requests.length; previous.click(); await pause(); assert.equal(env.requests.length, pendingRequests);
        assert.match(date.textContent, /July 12, 2024/);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        env.doc.querySelector('.bpb-weather-chart-frame').dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        assert.match(env.doc.querySelector('.bpb-weather-readout').textContent, /12:00 AM PDT/);
        finish();
        await waitFor(() => card.getAttribute('aria-busy') === 'false');
        assert.match(date.textContent, /July 12, 2024/);
        assert.match(env.doc.querySelector('.bpb-weather-status').textContent, /Could not load July 11, 2024\. Showing July 12, 2024/);
        assert.equal(previous.getAttribute('aria-disabled'), 'false');
        assert.equal(env.doc.activeElement, previous);
        assert.equal(env.doc.querySelector('option[value="best_match"]').disabled, false, 'refusal on another date does not disable the displayed day');
        assert.notEqual(env.doc.querySelector('[data-weather-value="temperature"]').textContent, before, 'unit update renders the retained day');
        available = true;
        env.doc.querySelector('.bpb-weather-retry').click();
        await waitFor(() => card.getAttribute('aria-busy') === 'false' && /July 11, 2024/.test(date.textContent));
        assert.equal(new URL(env.requests.at(-1).url).searchParams.get('start_date'), '2024-07-10');
    } finally { env.close(); }
});

test('a superseded archive-day response cannot replace the displayed day after a model change', async () => {
    let finish;
    const env = setup({ fetchWeather: url => new URL(url).searchParams.get('start_date') === '2024-07-10'
        ? new Promise(resolve => { finish = () => resolve(archiveResponse(url)); }) : archiveResponse(url) });
    try {
        await openChart(env);
        env.doc.querySelector('[aria-label="Previous day"]').click(); await waitFor(() => finish);
        const select = env.doc.querySelector('.bpb-weather-model select');
        select.value = 'gfs_global'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using GFS'));
        finish(); await pause();
        assert.match(env.doc.querySelector('.bpb-weather-date').textContent, /July 12, 2024/);
        assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Using GFS/);
        assert.equal(env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy'), 'false');
    } finally { env.close(); }
});

test('archive navigation stops at summit-local today and excludes future hours, even when UTC is already tomorrow', async () => {
    const env = setup({ now: Date.parse('2024-07-13T02:30:00Z'), fetchWeather: archiveResponse });
    try {
        await openChart(env);
        const card = env.doc.querySelector('#bpb-ascent-weather'), next = card.querySelector('[aria-label="Next day"]');
        assert.equal(next.getAttribute('aria-disabled'), 'true', 'Rainier is still on July 12');
        assert.match(env.doc.querySelector('.bpb-weather-status').textContent, /Partial day/);
        env.doc.querySelector('.bpb-weather-chart-frame').dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        assert.match(env.doc.querySelector('.bpb-weather-readout').textContent, /7:00 PM PDT/);
        const before = env.requests.length; next.click(); await pause();
        assert.equal(env.requests.length, before);
        card.querySelector('[aria-label="Previous day"]').click();
        await waitFor(() => card.getAttribute('aria-busy') === 'false' && /July 11, 2024/.test(env.doc.querySelector('.bpb-weather-date').textContent));
        assert.equal(next.getAttribute('aria-disabled'), 'false');
        next.click();
        await waitFor(() => card.getAttribute('aria-busy') === 'false' && /July 12, 2024/.test(env.doc.querySelector('.bpb-weather-date').textContent));
        assert.equal(next.getAttribute('aria-disabled'), 'true');
    } finally { env.close(); }
});

test('archive buttons respect the first archive date and selected model coverage without fallback', async () => {
    for (const [day, model, earliest] of [['January 1, 1940', 'best_match', true], ['March 23, 2021', 'gfs_global', true], ['July 7, 2024', 'era5', false]]) {
        const env = setup({ html: ascent.replaceAll('Sunday, July 12, 2026', day), now: Date.parse('2024-07-13T02:30:00Z'), fetchWeather: archiveResponse });
        try {
            await openChart(env);
            const select = env.doc.querySelector('.bpb-weather-model select');
            select.value = model; select.dispatchEvent(new env.win.Event('change'));
            await waitFor(() => env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false');
            const blocked = env.doc.querySelector(`[aria-label="${earliest ? 'Previous' : 'Next'} day"]`);
            assert.equal(blocked.getAttribute('aria-disabled'), 'true', `${model} archive bound`);
            const before = env.requests.length; blocked.click(); await pause(); assert.equal(env.requests.length, before);
            env.doc.querySelector(`[aria-label="${earliest ? 'Next' : 'Previous'} day"]`).click();
            await waitFor(() => env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false');
            assert.equal(new URL(env.requests.at(-1).url).searchParams.get('models'), model, 'explicit selection stays selected');
            assert.equal(select.value, model);
        } finally { env.close(); }
    }
});

test('archive navigation uses local civil days across DST and retains the displayed day on BFCache restore', async () => {
    const env = setup({ html: ascent.replaceAll('Sunday, July 12, 2026', 'November 4, 2024'), fetchWeather: archiveResponse });
    try {
        await openChart(env);
        env.doc.querySelector('[data-metric="conditions"]').click();
        env.doc.querySelector('[aria-label="Previous day"]').click();
        await waitFor(() => /November 3, 2024/.test(env.doc.querySelector('.bpb-weather-date').textContent)
            && env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false');
        assert.equal(env.doc.querySelectorAll('.bpb-weather-hourly-table thead [data-weather-time]').length, 25);
        assert.match(env.doc.querySelector('.bpb-weather-hourly-table').textContent, /PDT[\s\S]*PST/);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        await waitFor(() => env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false');
        assert.match(env.doc.querySelector('.bpb-weather-date').textContent, /November 3, 2024/);
        env.doc.querySelector('[aria-label="Next day"]').click();
        await waitFor(() => /November 4, 2024/.test(env.doc.querySelector('.bpb-weather-date').textContent)
            && env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false');
        assert.equal(env.doc.querySelectorAll('.bpb-weather-hourly-table thead [data-weather-time]').length, 24);
    } finally { env.close(); }
});

test('archive navigation refreshes date-dependent choices and respects a finite model archive', async () => {
    const env = setup({ html: ascent.replaceAll('Sunday, July 12, 2026', 'June 30, 2021'),
        fetchPeak: () => new Response(peak.replace('46.851731, -121.760395 (Dec Deg)', '46, 7 (Dec Deg)'), { headers: { 'content-type': 'text/html' } }),
        fetchWeather: async url => {
            const body = await archiveResponse(url).json(); body.latitude = 46; body.longitude = 7;
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        } });
    try {
        await openChart(env);
        const select = env.doc.querySelector('.bpb-weather-model select');
        select.value = 'cerra'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using CERRA'));
        assert.equal(env.doc.querySelector('[aria-label="Next day"]').getAttribute('aria-disabled'), 'true');
        select.value = 'best_match'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false');
        env.doc.querySelector('[aria-label="Next day"]').click();
        await waitFor(() => /July 1, 2021/.test(env.doc.querySelector('.bpb-weather-date').textContent));
        assert.equal(select.querySelector('[value="cerra"]'), null);
        env.doc.querySelector('[aria-label="Previous day"]').click();
        await waitFor(() => /June 30, 2021/.test(env.doc.querySelector('.bpb-weather-date').textContent));
        assert.ok(select.querySelector('[value="cerra"]'));
        assert.equal(select.value, 'best_match');
    } finally { env.close(); }
});

test('archive navigation skips a nonexistent summit-local day without requesting it', async () => {
    const env = setup({ html: ascent.replaceAll('Sunday, July 12, 2026', 'December 29, 2011'),
        fetchPeak: () => new Response(peak.replace('46.851731, -121.760395 (Dec Deg)', '-13.83, -171.76 (Dec Deg)'), { headers: { 'content-type': 'text/html' } }),
        fetchWeather: async url => {
            const body = await archiveResponse(url).json(); body.latitude = -13.83; body.longitude = -171.76;
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        } });
    try {
        await openChart(env);
        env.doc.querySelector('[aria-label="Next day"]').click();
        await waitFor(() => /December 31, 2011/.test(env.doc.querySelector('.bpb-weather-date').textContent));
        assert.equal(new URL(env.requests.at(-1).url).searchParams.get('start_date'), '2011-12-30');
        env.doc.querySelector('[aria-label="Previous day"]').click();
        await waitFor(() => /December 29, 2011/.test(env.doc.querySelector('.bpb-weather-date').textContent));
    } finally { env.close(); }
});

test('hourly disclosure names its action and keeps the expanded state and target in sync', async () => {
    const env = setup();
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'));
        const button = env.doc.querySelector('.bpb-weather-disclosure');
        const panel = env.doc.getElementById(button.getAttribute('aria-controls'));
        const label = () => button.firstElementChild.textContent;
        assert.equal(label(), 'Show hourly weather');
        assert.equal(panel.hidden, true);
        assert.equal(button.lastElementChild.getAttribute('aria-hidden'), 'true');
        button.focus(); button.click();
        assert.equal(label(), 'Hide hourly weather');
        assert.equal(button.getAttribute('aria-expanded'), 'true');
        assert.equal(panel.hidden, false);
        assert.equal(env.doc.querySelector('[role="tab"]').dataset.metric, 'conditions');
        assert.equal(env.doc.querySelector('[role="tab"]').getAttribute('aria-selected'), 'true');
        assert.equal(env.doc.querySelector('.bpb-weather-conditions').hidden, false);
        assert.equal(env.doc.activeElement, button);
        button.click();
        assert.equal(label(), 'Show hourly weather');
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        assert.equal(panel.hidden, true);
        assert.equal(env.doc.activeElement, button);
        assert.equal(env.requests.length, 2);
    } finally { env.close(); }
});

test('fractional-zone rain bars and interval tooltips agree with the daily total', async () => {
    const latitude = 27.7, longitude = 85.3;
    const env = setup({ storedSettings: { units: 'metric' },
        fetchPeak: async () => new Response(peak.replace('46.851731', String(latitude)).replace('-121.760395', String(longitude)), { headers: { 'content-type': 'text/html' } }),
        fetchWeather: async url => {
            const body = weatherFixture({ latitude, longitude, startDate: new URL(url).searchParams.get('start_date') });
            body.hourly.precipitation.fill(1);
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        } });
    try {
        await waitFor(() => env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false' && env.doc.querySelector('option[value="ecmwf_ifs"]'));
        const model = env.doc.querySelector('.bpb-weather-model select');
        model.value = 'ecmwf_ifs'; model.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using ECMWF IFS'));
        env.doc.querySelector('.bpb-weather-chart').getBoundingClientRect = () => ({ width: 500 });
        env.doc.querySelector('.bpb-weather-disclosure').click();
        env.doc.querySelector('[data-metric="precipitation"]').click();
        const bars = [...env.doc.querySelectorAll('.bpb-weather-bar')];
        assert.equal(bars.length, 25);
        assert.equal(bars.reduce((sum, row) => sum + Number(row.dataset.value), 0), 24);
        assert.equal(env.doc.querySelector('[data-weather-value="precipitation"]').textContent, '24.0 mm');
        const labels = [...env.doc.querySelectorAll('.bpb-weather-hover title')].map(node => node.textContent);
        assert.match(labels[0], /12:00 AM.*12:45 AM.*0.8 mm.*Estimated boundary interval/);
        assert.match(labels.at(-1), /11:45 PM.*12:00 AM.*next midnight.*0.3 mm.*Estimated boundary interval/);
        env.doc.querySelector('[data-metric="conditions"]').click();
        sendCursor(env, { selected: true, selectionTime: Date.parse('2024-07-11T18:20:00Z') });
        await waitFor(() => env.doc.querySelector('.bpb-weather-conditions [aria-current="time"]'));
        assert.equal(env.doc.querySelector('.bpb-weather-conditions [aria-current="time"]').dataset.weatherTime, String(Date.parse('2024-07-11T18:15:00Z')));
        assert.equal(env.doc.querySelector('[data-weather-row="precipitation"] td').textContent, '0.8 mm');
    } finally { env.close(); }
});

test('numeric hourly readings work by keyboard without GPX, preserve missing slots and keep GPX selection separate', async () => {
    const env = setup({ fetchWeather: async url => {
        const body = weatherFixture({ startDate: new URL(url).searchParams.get('start_date') });
        body.hourly.temperature_2m[32] = null;
        for (const values of Object.values(body.hourly)) values.splice(33, 1);
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await openChart(env);
        const frame = env.doc.querySelector('.bpb-weather-chart-frame'), readout = env.doc.querySelector('.bpb-weather-readout');
        const key = value => frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
        frame.focus(); key('Home'); assert.match(readout.textContent, /12:00 AM PDT/);
        key('ArrowRight'); assert.match(readout.textContent, /1:00 AM PDT.*Unavailable/);
        key('ArrowRight'); assert.match(readout.textContent, /2:00 AM PDT.*Unavailable/);
        assert.equal(readout.getAttribute('aria-live'), 'polite');
        const pinned = readout.textContent, gpxTime = Date.parse('2024-07-12T17:32:00Z');
        sendCursor(env, { selected: true, selectionTime: gpxTime });
        await waitFor(() => env.doc.querySelector('.bpb-weather-cursor').dataset.time === String(gpxTime));
        assert.equal(readout.textContent, pinned);
        key('Escape'); assert.match(readout.textContent, /^Low/); assert.equal(env.doc.querySelector('.bpb-weather-reading-cursor'), null);
        assert.equal(env.doc.querySelector('.bpb-weather-cursor').dataset.time, String(gpxTime));
        assert.equal(key('Tab'), true, 'Tab is not prevented');
        for (const metric of ['wind', 'precipitation']) {
            env.doc.querySelector(`[data-metric="${metric}"]`).click(); frame.focus(); key('End');
            assert.match(readout.textContent, metric === 'precipitation' ? /next midnight.*in/ : /11:00 PM PDT.*mph/);
        }
        const before = env.requests.length; key('Home'); key('ArrowRight');
        assert.equal(env.requests.length, before);
    } finally { env.close(); }
});

test('weather opt-out hides the archive and skips summit lookup until enabled, including BFCache', async () => {
    const env = setup({ storedSettings: { showWeather: false } });
    const update = showWeather => env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather } } }, 'sync'));
    try {
        await pause();
        const card = env.doc.getElementById('bpb-ascent-weather');
        assert.equal(card.hidden, true); assert.equal(env.requests.length, 0);
        assert.equal(env.doc.getElementById('bpb-ascent-gpx-details'), null);
        const download = env.doc.getElementById('gpxlinks'), originalParent = download.parentNode, originalNext = download.nextSibling;
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        assert.equal(env.requests.length, 0);
        update(true); await openChart(env);
        assert.equal(card.hidden, false);
        assert.equal(download.parentNode.id, 'bpb-ascent-gpx-details');
        const count = env.requests.length;
        update(false); assert.equal(card.hidden, true);
        assert.equal(env.doc.getElementById('bpb-ascent-gpx-details'), null);
        assert.equal(download.parentNode, originalParent); assert.equal(download.nextSibling, originalNext);
        card.querySelector('.bpb-weather-retry').click();
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        assert.equal(env.requests.length, count);
        assert.equal(download.parentNode, originalParent);
        update(true); await waitFor(() => card.getAttribute('aria-busy') === 'false');
        assert.equal(card.hidden, false); assert.equal(env.doc.querySelectorAll('#bpb-ascent-weather').length, 1);
        assert.equal(env.doc.querySelectorAll('#bpb-ascent-gpx-details').length, 1);
    } finally { env.close(); }
});

test('disabling the archive aborts its lookup before any weather-provider request', async () => {
    let finish;
    const env = setup({ fetchPeak: () => new Promise(resolve => { finish = resolve; }) });
    try {
        await waitFor(() => env.requests.length === 1);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        assert.equal(env.requests[0].init.signal.aborted, true);
        finish(new Response(peak, { headers: { 'content-type': 'text/html' } })); await pause();
        assert.equal(env.doc.getElementById('bpb-ascent-weather').hidden, true); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('a late startup read cannot override the archive opt-out and failed settings skip all requests', async () => {
    let finish;
    const env = setup({ readSettings: () => new Promise(resolve => { finish = resolve; }) });
    try {
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        finish({ bpbSettings: { showWeather: true } }); await pause();
        assert.equal(env.doc.getElementById('bpb-ascent-weather').hidden, true); assert.equal(env.requests.length, 0);
        assert.equal(env.doc.getElementById('bpb-ascent-gpx-details'), null);
    } finally { env.close(); }
    const failed = setup({ readSettings: async () => { throw new Error('Sync unavailable'); } });
    try {
        await pause();
        assert.equal(failed.doc.getElementById('bpb-ascent-weather').hidden, true); assert.equal(failed.requests.length, 0);
    } finally { failed.close(); }
});

test('weather cursor previews GPX hover and restores selection without rebuilding data or fetching', async () => {
    const env = setup();
    try {
        await openChart(env);
        const svg = env.doc.querySelector('.bpb-weather-chart'), line = svg.querySelector('.bpb-weather-cursor');
        const dataPath = svg.querySelector('path'), label = env.doc.querySelector('.bpb-weather-cursor-label');
        const selectionTime = Date.parse('2024-07-12T17:32:00Z'), hoverTime = Date.parse('2024-07-12T19:15:00Z');
        const before = env.requests.length;
        sendCursor(env, { selected: true, selectionTime });
        await waitFor(() => line.dataset.time === String(selectionTime));
        assert.equal(line.dataset.mode, 'selected');
        assert.equal(Number(line.getAttribute('x1')), 42 + (484 - 42) * (10 * 60 + 32) / (24 * 60));
        assert.match(label.textContent, /Selected · 10:32 AM PDT/);
        sendCursor(env, { hovering: true, hoverTime, selected: true, selectionTime });
        await waitFor(() => line.dataset.time === String(hoverTime));
        assert.equal(line.dataset.mode, 'hover');
        sendCursor(env, { selected: true, selectionTime });
        await waitFor(() => line.dataset.time === String(selectionTime));
        assert.equal(svg.querySelector('path'), dataPath, 'hover only moves the overlay');
        env.doc.querySelector('[data-metric="wind"]').click();
        assert.equal(svg.querySelector('.bpb-weather-cursor'), line);
        assert.equal(line.dataset.time, String(selectionTime));
        assert.match(svg.getAttribute('aria-label'), /Wind.*Selected/);
        assert.equal(env.requests.length, before, 'cursor movement does not request route weather');
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        assert.equal(line.dataset.time, String(selectionTime));
        assert.match(svg.getAttribute('aria-label'), /km\/h/);
        const model = env.doc.querySelector('.bpb-weather-model select');
        model.value = 'gfs_global'; model.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using GFS'));
        assert.equal(svg.querySelector('.bpb-weather-cursor'), line);
        assert.equal(line.dataset.time, String(selectionTime));
        assert.equal(line.dataset.mode, 'selected');
        sendCursor(env, {});
        await waitFor(() => label.textContent === '');
        assert.equal(line.style.display, 'none');
    } finally { env.close(); }
});

test('collapsed hourly graph retains selection and rejects untrusted or invalid times', async () => {
    const env = setup();
    try {
        const selected = Date.parse('2024-07-12T18:00:00Z');
        sendCursor(env, { selected: true, selectionTime: selected });
        await openChart(env);
        const line = env.doc.querySelector('.bpb-weather-cursor'), label = env.doc.querySelector('.bpb-weather-cursor-label');
        await waitFor(() => line.dataset.time === String(selected));
        env.doc.querySelector('.bpb-weather-disclosure').click();
        sendCursor(env, { hovering: true, hoverTime: selected + 3600_000 });
        await waitFor(() => label.textContent.includes('Hover'));
        assert.equal(env.doc.querySelector('.bpb-weather-disclosure').getAttribute('aria-expanded'), 'false');
        env.doc.querySelector('.bpb-weather-disclosure').click();
        assert.equal(line.dataset.time, String(selected + 3600_000));
        for (const detail of [{ source: {} }, { origin: 'https://other.example' }, { data: { type: GPX_TIME_CURSOR, selected: true, selectionTime: selected, coordinates: [] } }]) {
            sendCursor(env, {}, detail);
        }
        await pause(); assert.equal(line.dataset.mode, 'hover');
        sendCursor(env, { hovering: true, hoverTime: null, selected: true, selectionTime: selected });
        await waitFor(() => label.textContent === 'GPX time unavailable');
        assert.equal(line.style.display, 'none', 'missing hover time must not silently use the clicked time');
        for (const time of [Date.parse('2024-07-12T06:59:00Z'), Date.parse('2024-07-13T07:00:00Z')]) {
            sendCursor(env, { selected: true, selectionTime: time });
            await waitFor(() => label.textContent === 'Outside ascent day');
            assert.equal(line.style.display, 'none');
        }
    } finally { env.close(); }
});

test('cursor uses elapsed epochs across a repeated summit-local hour', async () => {
    const env = setup({ html: ascent.replace('Sunday, July 12, 2026', 'November 3, 2024'),
        fetchWeather: url => Promise.resolve(new Response(JSON.stringify(weatherFixture({ startDate: new URL(url).searchParams.get('start_date') })), { headers: { 'content-type': 'application/json' } })) });
    try {
        await openChart(env);
        const line = env.doc.querySelector('.bpb-weather-cursor'), label = env.doc.querySelector('.bpb-weather-cursor-label');
        sendCursor(env, { selected: true, selectionTime: Date.parse('2024-11-03T08:30:00Z') });
        await waitFor(() => label.textContent.includes('PDT'));
        const first = Number(line.getAttribute('x1'));
        sendCursor(env, { selected: true, selectionTime: Date.parse('2024-11-03T09:30:00Z') });
        await waitFor(() => label.textContent.includes('PST'));
        assert.match(label.textContent, /1:30 AM PST/);
        assert.ok(Math.abs(Number(line.getAttribute('x1')) - first - 442 / 25) < 0.0001, 'repeated 01:30 advances by one hour in a 25-hour day');
    } finally { env.close(); }
});

test('BFCache restore clears transient hover, retains selection and requests a fresh cursor snapshot', async () => {
    const env = setup();
    try {
        await openChart(env);
        const requests = []; env.win.postMessage = value => requests.push(value);
        const selected = Date.parse('2024-07-12T18:00:00Z');
        sendCursor(env, { hovering: true, hoverTime: selected + 3600_000, selected: true, selectionTime: selected });
        await waitFor(() => env.doc.querySelector('.bpb-weather-cursor').dataset.mode === 'hover');
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        sendCursor(env, { selected: true, selectionTime: selected + 7200_000 });
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        assert.equal(env.doc.querySelector('.bpb-weather-cursor').dataset.mode, 'selected');
        assert.equal(env.doc.querySelector('.bpb-weather-cursor').dataset.time, String(selected));
        assert.equal(requests.at(-1).type, 'bpb:gpx-time-cursor-request');
    } finally { env.close(); }
});

test('horizontal Conditions shows measurements and GPX highlights the column without scrolling on hover', async () => {
    const env = setup();
    try {
        await openChart(env);
        const before = env.requests.length, selectionTime = Date.parse('2024-07-12T17:32:00Z');
        sendCursor(env, { selected: true, selectionTime });
        await waitFor(() => env.doc.querySelector('.bpb-weather-cursor')?.dataset.time === String(selectionTime));
        env.doc.querySelector('[data-metric="conditions"]').click();
        const list = env.doc.querySelector('.bpb-weather-conditions'), rows = [...list.querySelectorAll('thead th[data-weather-time]')];
        const icons = [...list.querySelectorAll('[data-weather-row="code"] [role="img"]')];
        assert.equal(rows.length, 24);
        assert.deepEqual([...list.querySelectorAll('tbody th')].map(cell => cell.textContent), ['Conditions', 'Temperature', 'Rain/snow', 'Wind', 'Gusts']);
        assert.equal(env.doc.querySelector('.bpb-weather-chart').hasAttribute('hidden'), true);
        assert.match(rows[0].textContent, /12 AMPDT/);
        assert.equal(icons[0].getAttribute('aria-label'), 'Overcast');
        assert.match(rows[8].textContent, /8 AMPDT/);
        assert.equal(icons[8].getAttribute('aria-label'), 'Light snow');
        assert.equal(rows[10].getAttribute('aria-current'), 'time');
        assert.equal(rows[10].dataset.mode, 'selected');
        assert.equal(list.querySelectorAll(`[data-weather-time="${rows[10].dataset.weatherTime}"][data-mode="selected"]`).length, 6);
        list.scrollLeft = 100;
        sendCursor(env, { hovering: true, hoverTime: selectionTime + 3600_000, selected: true, selectionTime });
        await waitFor(() => rows[11].dataset.mode === 'hover');
        assert.equal(rows[10].hasAttribute('aria-current'), false);
        assert.equal(list.scrollLeft, 100, 'GPX hover never scrolls the hourly table');
        sendCursor(env, { selected: true, selectionTime });
        await waitFor(() => rows[10].dataset.mode === 'selected');
        assert.equal(env.requests.length, before);
        env.doc.querySelector('[data-metric="temperature"]').click();
        assert.equal(list.hidden, true);
        assert.equal(env.doc.querySelector('.bpb-weather-chart').hasAttribute('hidden'), false);
        assert.equal(env.doc.querySelector('.bpb-weather-cursor').dataset.time, String(selectionTime));
    } finally { env.close(); }
});

test('horizontal archive values retain their time contract and scroll when units change', async () => {
    const env = setup({ fetchWeather: async () => {
        const body = weatherFixture();
        body.hourly.precipitation.fill(1);
        body.hourly.precipitation[31] = 100; body.hourly.precipitation[55] = 5;
        body.hourly.wind_gusts_10m[31] = 60; body.hourly.wind_gusts_10m[55] = 500;
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'));
        env.doc.querySelector('.bpb-weather-disclosure').click();
        const grid = env.doc.querySelector('.bpb-weather-conditions');
        const rain = [...grid.querySelectorAll('[data-weather-row="precipitation"] td')];
        const gusts = [...grid.querySelectorAll('[data-weather-row="gust"] td')];
        assert.match(rain[0].title, /12:00 AM PDT.*01:00 AM PDT/);
        assert.match(rain.at(-1).textContent, /0\.20 in/);
        assert.match(gusts[0].textContent, /37 mph/);
        assert.match(gusts[0].title, /12:00 AM PDT.*Instantaneous gust estimate/);
        assert.ok(gusts.every(cell => !cell.textContent.includes('311 mph')), 'closing midnight gust is excluded');
        grid.scrollLeft = 340; grid.focus();
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        assert.equal(grid.scrollLeft, 340); assert.equal(env.doc.activeElement, grid);
        assert.equal(grid.querySelector('[data-weather-row="gust"] td').textContent, '60 km/h');
        assert.equal(env.requests.length, 2);
    } finally { env.close(); }
});

test('hourly Conditions preserves missing hours and repeated clocks with distinct offsets', async () => {
    const env = setup({ html: ascent.replace('Sunday, July 12, 2026', 'November 3, 2024'), fetchWeather: url => {
        const body = weatherFixture({ startDate: new URL(url).searchParams.get('start_date') });
        body.hourly.weather_code[33] = null;
        // The hourly record can also omit a whole timestamp, without shifting
        // later hours into the empty position.
        for (const values of Object.values(body.hourly)) values.splice(34, 1);
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    } });
    try {
        await openChart(env);
        env.doc.querySelector('[data-metric="conditions"]').click();
        const rows = [...env.doc.querySelectorAll('.bpb-weather-conditions thead th[data-weather-time]')];
        const icons = [...env.doc.querySelectorAll('[data-weather-row="code"] [role="img"]')];
        assert.equal(rows.length, 25);
        assert.match(rows[1].textContent, /1 AMPDT/);
        assert.match(rows[2].textContent, /1 AMPST/);
        assert.equal(icons[2].getAttribute('aria-label'), 'Unavailable');
        assert.match(rows[3].textContent, /2 AMPST/);
        assert.equal(icons[3].getAttribute('aria-label'), 'Unavailable');
        assert.notEqual(rows[1].dataset.weatherTime, rows[2].dataset.weatherTime);
        const thirdTime = rows[3].dataset.weatherTime;
        sendCursor(env, { selected: true, selectionTime: Number(thirdTime) + 20 * 60_000 });
        await waitFor(() => rows[3].getAttribute('aria-current') === 'time');
        assert.equal(icons[3].getAttribute('aria-label'), 'Unavailable');
    } finally { env.close(); }
});

test('models without condition fields retain their other measurements with a clear explanation', async () => {
    const env = setup({ fetchWeather: url => Promise.resolve(new Response(JSON.stringify(weatherFixture({ fields: new URL(url).searchParams.get('hourly').split(',') })), { headers: { 'content-type': 'application/json' } })) });
    try {
        await openChart(env);
        const model = env.doc.querySelector('.bpb-weather-model select');
        model.value = 'ecmwf_ifs_analysis_long_window'; model.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using IFS Assimilation'));
        env.doc.querySelector('[data-metric="conditions"]').click();
        assert.equal(env.doc.querySelector('.bpb-weather-conditions').hidden, false);
        assert.match(env.doc.querySelector('[data-weather-row="temperature"]').textContent, /°F/);
        assert.match(env.doc.querySelector('[role="tabpanel"]').textContent, /This model does not provide hourly conditions/);
        assert.equal(env.doc.querySelector('[data-metric="conditions"]').getAttribute('aria-selected'), 'true');
    } finally { env.close(); }
});
test('bundled independent card loads on a visitor ascent without GPX or map', async () => {
    const env = setup({ html: ascent.replace('Sunday, July 12, 2026', 'July 12, 2024').replace(/<div id="gpxlinks">[\s\S]*?<\/div>/, '').replace(/<div id="owneractions">[\s\S]*?<\/div>/, '') });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description')?.textContent.includes('Using Best Match'));
        assert.equal(env.requests.length, 2);
        assert.match(env.doc.querySelector('.bpb-weather-condition').textContent, /Snow occurred/);
        assert.equal(env.doc.querySelector('#bpb-ascent-weather').previousElementSibling.id, 'summarydata');
        assert.equal(env.doc.querySelector('#bpb-ascent-weather').parentElement.id, 'bpb-ascent-summary-column');
        assert.equal(env.doc.querySelector('#bpb-ascent-weather-heading').textContent, 'Weather archive');
        assert.equal(env.doc.querySelector('.bpb-weather-attribution').textContent, 'Powered by Open-Meteo');
        assert.equal(env.doc.querySelector('#bpb-ascent-gpx-details'), null);
        assert.equal(env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy'), 'false');
        const transfer = env.requests[1]; assert.equal(transfer.init.credentials, 'omit'); assert.equal(transfer.init.referrerPolicy, 'no-referrer');
        assert.equal(new URL(transfer.url).origin + new URL(transfer.url).pathname, 'https://archive-api.open-meteo.com/v1/archive');
        assert.equal(new URL(transfer.url).searchParams.get('models'), 'best_match');
        assert.equal(env.doc.querySelector('select').value, 'best_match');
        assert.equal(env.doc.querySelector('select').options[0].value, 'best_match');
        assert.match(env.doc.querySelector('.bpb-weather-source-text').textContent, /combines ECMWF IFS, ERA5 and ERA5-Land/);
        assert.equal(new URL(transfer.url).searchParams.has('aid'), false);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        assert.match(env.doc.querySelector('[data-weather-value="temperature"]').textContent, /°C$/);
    } finally { env.close(); }
});

test('invalid or incomplete date makes no summit or weather request, including BFCache restore', async () => {
    for (const date of ['2024', '2024-02-31', '1939-01-01']) {
        const env = setup({ html: ascent.replace('Sunday, July 12, 2026', date) });
        try {
            env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
            env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
            await pause(); assert.equal(env.requests.length, 0);
            assert.match(env.doc.querySelector('.bpb-weather-status').textContent, /date|1940/);
        } finally { env.close(); }
    }
});

test('weather column choice persists locally and keeps GPS controls in the summary column', async () => {
    const localPositions = {}, env = setup({ localPositions });
    try {
        await openChart(env);
        const card = env.doc.getElementById('bpb-ascent-weather'), handle = card.querySelector('.bpb-card-drag-handle');
        const chart = card.querySelector('.bpb-weather-chart'), requests = env.requests.length;
        const selectedTime = Date.parse('2024-07-12T17:32:00Z');
        sendCursor(env, { selected: true, selectionTime: selectedTime });
        await waitFor(() => card.querySelector('.bpb-weather-cursor').dataset.time === String(selectedTime));
        handle.click();
        [...env.doc.querySelector('.bpb-layout-menu:not([hidden])').querySelectorAll('button')].find(button => button.textContent === 'Move below trip report').click();
        await waitFor(() => env.positionWrites.length === 1);
        assert.equal(card.parentElement.id, 'bpb-ascent-report-column');
        assert.equal(card.previousElementSibling.classList.contains('bpb-ascent-table-split__report'), true);
        assert.equal(env.doc.getElementById('bpb-ascent-gpx-details').parentElement.id, 'bpb-ascent-summary-column');
        assert.equal(card.querySelector('.bpb-weather-chart'), chart);
        assert.equal(card.querySelector('.bpb-weather-cursor').dataset.time, String(selectedTime));
        assert.equal(card.querySelector('[data-metric="temperature"]').getAttribute('aria-selected'), 'true');
        assert.equal(env.requests.length, requests);
        assert.deepEqual(localPositions, { bpbAscentWeatherColumn: 'report', bpbAscentWeatherSlot: 'after' });
        const explorer = env.doc.createElement('div'); explorer.id = 'bpb-route-explorer'; env.doc.getElementById('page').append(explorer);
        await pause(); assert.equal(card.parentElement.id, 'bpb-ascent-report-column', 'later GPX DOM cannot undo the chosen column');
        assert.equal(env.doc.querySelectorAll('.bpb-card-drag-handle').length, 1, 'only weather is enabled for dragging');
    } finally { env.close(); }
    const restored = setup({ localPositions });
    try { await waitFor(() => restored.doc.getElementById('bpb-ascent-weather').parentElement.id === 'bpb-ascent-report-column'); }
    finally { restored.close(); }
});

test('late and malformed position reads cannot undo current intent or prevent fallback weather', async () => {
    let finish;
    const env = setup({ readPositions: () => new Promise(resolve => { finish = resolve; }) });
    try {
        await openChart(env);
        moveKey(env, 'ArrowLeft'); await pause();
        finish({ bpbAscentWeatherColumn: 'summary' }); await pause();
        assert.equal(env.doc.getElementById('bpb-ascent-weather').parentElement.id, 'bpb-ascent-report-column');
    } finally { env.close(); }
    for (const saved of ['invalid', { column: 'report' }, null]) {
        const invalid = setup({ localPositions: { bpbAscentWeatherColumn: saved } });
        try { await openChart(invalid); assert.equal(invalid.doc.getElementById('bpb-ascent-weather').parentElement.id, 'bpb-ascent-summary-column'); }
        finally { invalid.close(); }
    }
    const fallback = setup({ withLayout: false, localPositions: { bpbAscentWeatherColumn: 'report' }, readPositions: async () => { throw new Error('Unavailable'); } });
    try {
        await openChart(fallback); assert.equal(fallback.doc.querySelector('.bpb-card-drag-handle').hidden, true);
        fallback.win.eval(layoutBundle); await waitFor(() => !fallback.doc.querySelector('.bpb-card-drag-handle').hidden);
    } finally { fallback.close(); }
});

test('completed moves serialize local writes, retain the last choice and report storage failure', async () => {
    const held = [];
    const env = setup({ savePositions: values => new Promise(resolve => held.push({ values, resolve })) });
    try {
        await openChart(env);
        moveKey(env, 'ArrowLeft'); moveKey(env, 'ArrowRight');
        await waitFor(() => held.length === 1);
        assert.deepEqual({ ...held[0].values }, { bpbAscentWeatherColumn: 'report', bpbAscentWeatherSlot: 'after' });
        held[0].resolve(); await waitFor(() => held.length === 2);
        assert.deepEqual({ ...held[1].values }, { bpbAscentWeatherColumn: 'summary', bpbAscentWeatherSlot: 'after' }); held[1].resolve();
    } finally { env.close(); }
    const failed = setup({ savePositions: async () => { throw new Error('Storage full'); } });
    try {
        await openChart(failed); moveKey(failed, 'ArrowLeft');
        await waitFor(() => failed.doc.querySelector('.bpb-card-drag-status').textContent.includes('could not be saved'));
        assert.equal(failed.doc.querySelector('.bpb-card-drag-status').classList.contains('bpb-card-drag-status-visible'), true);
        assert.equal(failed.doc.getElementById('bpb-ascent-weather').parentElement.id, 'bpb-ascent-report-column');
    } finally { failed.close(); }
});

test('a position read arriving during a pointer gesture cannot reparent the lifted card', async () => {
    let finish;
    const env = setup({ readPositions: () => new Promise(resolve => { finish = resolve; }) });
    try {
        await openChart(env);
        const card = env.doc.getElementById('bpb-ascent-weather');
        card.getBoundingClientRect = () => ({ width: 300 });
        card.querySelector('.bpb-card-drag-handle').dispatchEvent(pointerEvent({ window: env.win }, 'pointerdown', { button: 0, clientX: 400, clientY: 150 }));
        finish({ bpbAscentWeatherColumn: 'report', bpbAscentWeatherSlot: 'after' }); await pause();
        assert.equal(card.parentElement.id, 'bpb-ascent-summary-column');
        env.win.dispatchEvent(pointerEvent({ window: env.win }, 'pointercancel'));
        assert.equal(env.positionWrites.length, 0);
    } finally { env.close(); }
});

test('weather placement survives opt-out and BFCache and ignores position reads after disposal', async () => {
    const env = setup({ localPositions: { bpbAscentWeatherColumn: 'report' } });
    try {
        await openChart(env);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true })); await pause();
        assert.equal(env.doc.getElementById('bpb-ascent-weather').parentElement.id, 'bpb-ascent-report-column');
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        assert.equal(env.doc.getElementById('bpb-ascent-weather').hidden, true);
        assert.equal(env.doc.querySelector('.bpb-card-drag-handle').hidden, true);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: true } } }, 'sync')); await pause();
        assert.equal(env.doc.getElementById('bpb-ascent-weather').parentElement.id, 'bpb-ascent-report-column');
    } finally { env.close(); }
    let finish;
    const disposed = setup({ readPositions: () => new Promise(resolve => { finish = resolve; }) });
    try {
        await pause(); disposed.win.dispatchEvent(new disposed.win.PageTransitionEvent('pagehide'));
        finish({ bpbAscentWeatherColumn: 'report', bpbAscentWeatherSlot: 'after' }); await pause();
        assert.equal(disposed.doc.getElementById('bpb-ascent-weather').parentElement.id, 'bpb-ascent-summary-column');
        assert.equal(disposed.doc.querySelector('.bpb-card-drop-preview'), null);
    } finally { disposed.close(); }
});

test('same card stays in the right column when the route explorer appears later', async () => {
    const env = setup();
    try {
        const card = env.doc.getElementById('bpb-ascent-weather');
        const explorer = env.doc.createElement('div'); explorer.id = 'bpb-route-explorer'; env.doc.getElementById('page').append(explorer);
        await pause();
        assert.equal(card.parentElement.id, 'bpb-ascent-summary-column');
        assert.equal(card.previousElementSibling.id, 'bpb-ascent-gpx-details');
        assert.equal(card.previousElementSibling.previousElementSibling.id, 'summarydata');
        assert.notEqual(explorer.nextElementSibling, card);
        assert.equal(env.doc.querySelectorAll('#bpb-ascent-weather').length, 1);
    } finally { env.close(); }
});

test('a later table split moves the existing weather card into the summary column', async () => {
    const env = setup({ withLayout: false });
    try {
        const card = env.doc.getElementById('bpb-ascent-weather');
        assert.equal(card.parentElement.id, 'page');
        env.win.eval(layoutBundle);
        await waitFor(() => card.parentElement.id === 'bpb-ascent-summary-column');
        assert.equal(card.previousElementSibling.id, 'bpb-ascent-gpx-details');
        assert.equal(env.doc.querySelectorAll('#bpb-ascent-weather').length, 1);
    } finally { env.close(); }
});

test('native GPS note and download controls move together above weather without moving the map', async () => {
    const html = ascent.replace(/<div id="gpxlinks">([\s\S]*?)<\/div>/,
        '<table id="nativegps"><tr><td><iframe src="/map/MasterMap.aspx?t=A"></iframe>'
        + '<p><a href="/map/BigMap.aspx">Click Here for a Full Screen Map</a></p>'
        + '<p id="gpsnote"><font size="1">Note: GPS Tracks may not be accurate, and may not show the best route. Do not follow this route blindly.</font></p>'
        + '<p id="gpxlinks">$1<span id="test-handoff"><button type="button">Send to Gaia</button></span></p></td></tr></table>');
    const env = setup({ html, withLayout: false });
    try {
        await waitFor(() => env.doc.getElementById('bpb-ascent-gpx-details'));
        const card = env.doc.getElementById('bpb-ascent-weather'), details = env.doc.getElementById('bpb-ascent-gpx-details');
        const note = env.doc.getElementById('gpsnote'), download = env.doc.getElementById('gpxlinks');
        const button = env.doc.querySelector('#test-handoff button');
        let clicks = 0; button.addEventListener('click', () => clicks++);
        assert.equal(details.nextElementSibling, card);
        assert.deepEqual([...details.children], [note, download]);
        assert.equal(env.doc.querySelector('iframe').closest('table').id, 'nativegps');
        // Reparent the same blocks again when the independent layout arrives.
        env.win.eval(layoutBundle);
        await waitFor(() => card.parentElement.id === 'bpb-ascent-summary-column');
        assert.equal(details.nextElementSibling, card);
        assert.equal(details.parentElement, card.parentElement);
        assert.equal(env.doc.getElementById('gpsnote'), note);
        assert.equal(env.doc.getElementById('gpxlinks'), download);
        button.click(); assert.equal(clicks, 1);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        await pause();
        assert.equal(env.doc.querySelectorAll('#bpb-ascent-gpx-details').length, 1);
        assert.equal(details.nextElementSibling, card);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: false } } }, 'sync'));
        assert.equal(env.doc.getElementById('bpb-ascent-gpx-details'), null);
        assert.equal(note.closest('table').id, 'nativegps');
        assert.equal(note.nextElementSibling, download);
        button.click(); assert.equal(clicks, 2);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { showWeather: true } } }, 'sync'));
        await waitFor(() => env.doc.getElementById('bpb-ascent-gpx-details'));
        assert.equal(env.doc.getElementById('gpxlinks'), download);
        assert.equal(env.doc.getElementById('gpsnote'), note);
        assert.equal(env.doc.querySelectorAll('#bpb-ascent-gpx-details').length, 1);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide'));
        assert.equal(note.closest('table').id, 'nativegps');
        assert.equal(env.doc.getElementById('bpb-ascent-gpx-details'), null);
    } finally { env.close(); }
});

test('a shared GPS footer paragraph is moved once and ambiguous or report-quoted notes stay native', async () => {
    for (const shared of [true, false]) {
        const html = ascent.replace('<b>Great climb</b>', '<p id="report-quote">Note: GPS Tracks may not be accurate. Report quotation.</p><b>Great climb</b>')
            .replace(/<div id="gpxlinks">([\s\S]*?)<\/div>/, shared
                ? '<p id="gpxlinks"><small>Note: GPS Tracks may not be accurate. Native GPS note.</small><br>$1</p>'
                : '<p id="note-one">Note: GPS Tracks may not be accurate. First.</p><p id="note-two">Note: GPS Tracks may not be accurate. Second.</p><p id="gpxlinks">$1</p>');
        const env = setup({ html, withLayout: !shared });
        try {
            await waitFor(() => env.doc.getElementById('bpb-ascent-gpx-details'));
            const details = env.doc.getElementById('bpb-ascent-gpx-details');
            assert.equal(details.children.length, 1);
            assert.equal(details.firstElementChild.id, 'gpxlinks');
            assert.equal(env.doc.getElementById('ascentinfo').contains(env.doc.getElementById('report-quote')), true);
            if (!shared) for (const id of ['note-one', 'note-two']) assert.equal(env.doc.getElementById(id).parentElement.id, 'page');
        } finally { env.close(); }
    }
});

test('hourly tabs have one keyboard stop and arrow navigation preserves the active measurement', async () => {
    const env = setup();
    try {
        await openChart(env);
        env.doc.querySelector('[data-metric="conditions"]').click();
        const tabs = [...env.doc.querySelectorAll('[role="tab"]')];
        assert.equal(tabs[0].textContent, 'Conditions');
        assert.deepEqual(tabs.map(tab => tab.tabIndex), [0, -1, -1, -1]);
        tabs[0].focus(); tabs[0].dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
        assert.equal(env.doc.activeElement, tabs[1]);
        assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-selected')), ['false', 'true', 'false', 'false']);
        assert.deepEqual(tabs.map(tab => tab.tabIndex), [-1, 0, -1, -1]);
        assert.equal(env.doc.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), tabs[1].id);
        tabs[1].dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'End' }));
        assert.equal(env.doc.activeElement, tabs[3]);
        tabs[3].dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
        assert.equal(env.doc.activeElement, tabs[0]);
        tabs[0].dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        assert.equal(env.doc.activeElement, tabs[3]);
    } finally { env.close(); }
});

test('model refresh preserves the weather, expanded chart, feedback and focus until new data arrives', async () => {
    for (const partial of [false, true]) {
        let finish;
        const env = setup({ fetchWeather: async url => {
            const body = await archiveResponse(url).json();
            if (new URL(url).searchParams.get('models') === 'gfs_global') {
                body.hourly.temperature_2m = body.hourly.temperature_2m.map(value => value + 3);
                return new Promise(resolve => { finish = () => resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })); });
            }
            if (partial) body.hourly.precipitation[40] = null;
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        } });
        try {
            await openChart(env);
            const card = env.doc.getElementById('bpb-ascent-weather'), select = card.querySelector('select');
            const result = card.querySelector('.bpb-weather-result'), hourly = card.querySelector('#bpb-ascent-weather-hourly');
            const feedback = card.querySelector('.bpb-weather-status'), retry = card.querySelector('.bpb-weather-retry');
            card.querySelector('.bpb-weather-chart-frame').dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
            const before = { result: result.innerHTML, hourly: hourly.innerHTML, feedback: feedback.textContent, retryHidden: retry.hidden };
            select.focus(); select.value = 'gfs_global'; select.dispatchEvent(new env.win.Event('change'));
            await waitFor(() => finish);
            assert.equal(card.getAttribute('aria-busy'), 'true');
            assert.equal(card.hasAttribute('data-refreshing'), true);
            assert.equal(result.hidden, false);
            assert.equal(result.innerHTML, before.result);
            assert.equal(hourly.hidden, false);
            assert.equal(hourly.innerHTML, before.hourly, 'retain the chart and pinned reading during refresh');
            assert.equal(feedback.textContent, before.feedback, 'loading does not add a feedback block');
            assert.equal(retry.hidden, before.retryHidden, 'preserve the partial-data action footprint');
            assert.equal(retry.disabled, true);
            assert.equal(env.doc.activeElement, select);
            assert.match(card.querySelector('.bpb-weather-model-description').textContent, /Updating… Showing Best Match/);
            finish(); await waitFor(() => card.getAttribute('aria-busy') === 'false');
            assert.equal(card.hasAttribute('data-refreshing'), false);
            assert.match(card.querySelector('.bpb-weather-model-description').textContent, /Using GFS/);
            assert.equal(card.querySelector('.bpb-weather-model-description').firstElementChild.hidden, true);
            assert.notEqual(result.innerHTML, before.result, 'replace the weather after the new response is ready');
            assert.equal(card.querySelector('.bpb-weather-disclosure').getAttribute('aria-expanded'), 'true');
            assert.equal(card.querySelector('[data-metric="temperature"]').getAttribute('aria-selected'), 'true');
            assert.ok(card.querySelector('.bpb-weather-reading-cursor'));
            assert.equal(env.doc.activeElement, select);
        } finally { env.close(); }
    }
});

test('superseded response cannot overwrite explicit model choice', async () => {
    let finishSlow;
    const env = setup({ fetchWeather: url => {
        if (new URL(url).searchParams.get('models') === 'gfs_global') return new Promise(resolve => { finishSlow = resolve; });
        return Promise.resolve(new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } }));
    } });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'));
        const select = env.doc.querySelector('select');
        select.value = 'gfs_global'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => finishSlow);
        assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Updating… Showing Best Match/);
        select.value = 'ecmwf_ifs'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using ECMWF IFS'));
        assert.equal(env.doc.getElementById('bpb-ascent-weather').hasAttribute('data-refreshing'), false);
        finishSlow(new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } }));
        await pause(); assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Using ECMWF IFS/);
    } finally { env.close(); }
});

test('rate limits preserve previous results without cascading, explicit selection never falls back', async () => {
    const env = setup({ fetchWeather: url => new URL(url).searchParams.get('models') === 'best_match'
        ? Promise.resolve(new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } }))
        : Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '120' } })) });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'));
        assert.equal(env.doc.querySelector('.bpb-weather-model-description').firstElementChild.hidden, true);
        const before = env.requests.length;
        const select = env.doc.querySelector('select'); select.value = 'ecmwf_ifs'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('Open-Meteo request limit reached'));
        assert.equal(env.requests.length, before + 1);
        assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Using Best Match/);
        assert.equal(env.doc.querySelector('.bpb-weather-model-description').firstElementChild.hidden, false);
        assert.equal(env.doc.getElementById('bpb-ascent-weather').hasAttribute('data-refreshing'), false);
        assert.equal(env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Updating'), false);
        assert.equal(env.doc.querySelector('.bpb-weather-retry').hidden, false);
        assert.equal(env.doc.querySelector('.bpb-weather-retry').disabled, true);
        assert.equal(env.doc.querySelector('.bpb-weather-status').dataset.kind, 'rate-limit');
        assert.ok([...env.doc.querySelectorAll('.bpb-weather-day-button')].every(button => button.getAttribute('aria-disabled') === 'true'));
        assert.match(env.doc.querySelector('.bpb-weather-status').textContent, /Try again after/);
        select.value = 'gfs_global'; select.dispatchEvent(new env.win.Event('change'));
        await pause(); assert.equal(env.requests.length, before + 1);
    } finally { env.close(); }
});

test('archive Best Match retains partial data without a country-policy fallback', async () => {
    const env = setup({ fetchWeather: url => {
        const model = new URL(url).searchParams.get('models');
        assert.equal(model, 'best_match');
        const body = weatherFixture(); body.hourly.precipitation[40] = null;
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    } });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('Partial data'));
        assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Using Best Match/);
        assert.equal(env.requests.length, 2);
        assert.equal(env.doc.querySelector('option[value="gfs_hrrr"]').disabled, false);
        assert.equal(env.doc.querySelector('[data-weather-value="precipitation"]').nextElementSibling.textContent, 'Partial total');
    } finally { env.close(); }
});

test('explicit Retry fetches a fresh archive Best Match result', async () => {
    let refreshed = false;
    const env = setup({ fetchWeather: url => {
        const model = new URL(url).searchParams.get('models');
        assert.equal(model, 'best_match');
        const body = weatherFixture();
        if (!refreshed) body.hourly.precipitation[40] = null;
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    } });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('Partial data'));
        assert.equal(env.doc.querySelector('.bpb-weather-retry').hidden, false);
        const before = env.requests.length; refreshed = true;
        env.doc.querySelector('.bpb-weather-retry').click();
        await waitFor(() => env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy') === 'false'
            && env.doc.querySelector('.bpb-weather-status').textContent === '');
        assert.equal(env.requests.length, before + 1);
        assert.equal(env.doc.querySelector('option[value="gfs_hrrr"]').disabled, false);
        assert.equal(env.doc.querySelector('.bpb-weather-retry').hidden, true);
        assert.equal(env.doc.querySelector('[data-weather-value="precipitation"]').nextElementSibling.textContent, 'Water equivalent');
    } finally { env.close(); }
});

test('archive Best Match failure makes one request and an explicit Retry re-enables the choice', async () => {
    let available = false;
    const env = setup({ fetchWeather: () => available
        ? new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 400 }) });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('no data'));
        assert.equal(env.requests.length, 2);
        assert.equal(env.doc.querySelector('option[value="best_match"]').disabled, true);
        available = true; env.doc.querySelector('.bpb-weather-retry').click();
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'));
        assert.equal(env.requests.length, 3);
        assert.equal(env.doc.querySelector('option[value="best_match"]').disabled, false);
        assert.equal(env.doc.querySelector('option[value="best_match"]').textContent, 'Best Match (Open-Meteo)');
    } finally { env.close(); }
});

test('summit lookup keeps a Peakbagger limit distinct from Open-Meteo and makes no weather request', async () => {
    const env = setup({ fetchPeak: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('Peakbagger request limit reached'));
        assert.equal(env.requests.length, 1);
        assert.equal(env.doc.querySelector('.bpb-weather-retry').disabled, true);
        assert.equal(env.doc.querySelector('.bpb-weather-status').dataset.kind, 'rate-limit');
        assert.match(env.doc.querySelector('.bpb-weather-status').textContent, /Try again after/);
    } finally { env.close(); }
});


test('weather reorders within its column while preserving GPS ownership and its selected chart', async () => {
    const localPositions = {}, env = setup({ localPositions });
    try {
        await openChart(env);
        const card = env.doc.getElementById('bpb-ascent-weather'), gps = env.doc.getElementById('bpb-ascent-gpx-details');
        const summary = env.doc.querySelector('.bpb-ascent-table-split__summary'), chart = card.querySelector('.bpb-weather-chart');
        const requests = env.requests.length;
        moveKey(env, 'ArrowUp'); await pause();
        assert.equal(summary.nextElementSibling, card, 'weather moves above the native GPS links');
        assert.equal(card.nextElementSibling, gps);
        moveKey(env, 'ArrowUp'); await pause();
        assert.equal(summary.previousElementSibling, card, 'weather moves above the summary in the same column');
        assert.equal(card.querySelector('.bpb-weather-chart'), chart);
        assert.equal(env.doc.activeElement, card.querySelector('.bpb-card-drag-handle'));
        assert.equal(gps.parentElement.id, 'bpb-ascent-summary-column');
        assert.equal(env.requests.length, requests);
        await waitFor(() => localPositions.bpbAscentWeatherSlot === 'before');
        moveKey(env, 'End'); await pause();
        assert.equal(gps.nextElementSibling, card);
        moveKey(env, 'Home'); await waitFor(() => localPositions.bpbAscentWeatherSlot === 'before');
    } finally { env.close(); }
    const restored = setup({ localPositions });
    try {
        await openChart(restored);
        assert.equal(restored.doc.querySelector('.bpb-ascent-table-split__summary').previousElementSibling.id, 'bpb-ascent-weather');
    } finally { restored.close(); }
});
