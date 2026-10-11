import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { weatherFixture } from '../helpers/weather-fixture.mjs';
import { GPX_TIME_CURSOR } from '../../src/gpx/gpx-time-cursor.js';

const [ascent, peak, bundle, layoutBundle] = await Promise.all([
    readFile(new URL('../fixtures/pages/climber-ascent.html', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/ascent-weather.js', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/ascent-layout.js', import.meta.url), 'utf8'),
]);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
async function waitFor(predicate) {
    const until = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > until) throw new Error('Weather UI did not settle'); await pause(); }
}
const setup = ({ html = ascent.replaceAll('Sunday, July 12, 2026', 'Friday, July 12, 2024'), fetchWeather, fetchPeak, withLayout = true, storedSettings = {}, readSettings } = {}) => {
    const jsdom = new JSDOM(html, { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = jsdom.window, requests = [], listeners = [];
    win.AbortController = AbortController; win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder;
    win.chrome = { storage: { sync: { get: readSettings || (async () => ({ bpbSettings: { units: 'imperial', ...storedSettings } })) }, onChanged: { addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1) } } };
    win.fetch = async (url, init) => {
        requests.push({ url, init });
        if (new URL(url).host === 'www.peakbagger.com' && fetchPeak) return fetchPeak(url, init);
        if (new URL(url).host === 'www.peakbagger.com') return new Response(peak, { headers: { 'content-type': 'text/html' } });
        if (fetchWeather) return fetchWeather(url, init);
        return new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } });
    };
    if (withLayout) win.eval(layoutBundle);
    win.eval(bundle);
    return { win, doc: win.document, requests, listeners, close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
};

const sendCursor = (env, state, detail = {}) => env.win.dispatchEvent(new env.win.MessageEvent('message', {
    source: env.win, origin: env.win.location.origin,
    data: { type: GPX_TIME_CURSOR, hovering: false, hoverTime: null, selected: false, selectionTime: null, ...state }, ...detail,
}));
const openChart = async env => {
    await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using Best Match'));
    env.doc.querySelector('.bpb-weather-chart').getBoundingClientRect = () => ({ width: 500 });
    env.doc.querySelector('.bpb-weather-disclosure').click();
};

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
        const svg = env.doc.querySelector('svg'), line = svg.querySelector('.bpb-weather-cursor');
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

test('hourly Conditions shows each sample and GPX highlights the corresponding hour without scrolling on hover', async () => {
    const env = setup();
    try {
        await openChart(env);
        const before = env.requests.length, selectionTime = Date.parse('2024-07-12T17:32:00Z');
        sendCursor(env, { selected: true, selectionTime });
        await waitFor(() => env.doc.querySelector('.bpb-weather-cursor')?.dataset.time === String(selectionTime));
        env.doc.querySelector('[data-metric="conditions"]').click();
        const list = env.doc.querySelector('.bpb-weather-conditions'), rows = [...list.children];
        assert.equal(rows.length, 24);
        assert.equal(env.doc.querySelector('svg').hasAttribute('hidden'), true);
        assert.match(rows[0].textContent, /12:00 AMPDT.*Overcast/);
        assert.match(rows[8].textContent, /8:00 AMPDT.*Light snow/);
        assert.equal(rows[10].getAttribute('aria-current'), 'time');
        assert.equal(rows[10].dataset.mode, 'selected');
        list.scrollTop = 100;
        sendCursor(env, { hovering: true, hoverTime: selectionTime + 3600_000, selected: true, selectionTime });
        await waitFor(() => rows[11].dataset.mode === 'hover');
        assert.equal(rows[10].hasAttribute('aria-current'), false);
        assert.equal(list.scrollTop, 100, 'GPX hover never scrolls the hourly list');
        sendCursor(env, { selected: true, selectionTime });
        await waitFor(() => rows[10].dataset.mode === 'selected');
        assert.equal(env.requests.length, before);
        env.doc.querySelector('[data-metric="temperature"]').click();
        assert.equal(list.hidden, true);
        assert.equal(env.doc.querySelector('svg').hasAttribute('hidden'), false);
        assert.equal(env.doc.querySelector('.bpb-weather-cursor').dataset.time, String(selectionTime));
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
        const rows = [...env.doc.querySelector('.bpb-weather-conditions').children];
        assert.equal(rows.length, 25);
        assert.match(rows[1].textContent, /1:00 AMPDT/);
        assert.match(rows[2].textContent, /1:00 AMPST.*Unavailable/);
        assert.match(rows[3].textContent, /2:00 AMPST.*Unavailable/);
        assert.notEqual(rows[1].dataset.weatherTime, rows[2].dataset.weatherTime);
        const thirdTime = rows[3].dataset.weatherTime;
        sendCursor(env, { selected: true, selectionTime: Number(thirdTime) + 20 * 60_000 });
        await waitFor(() => rows[3].getAttribute('aria-current') === 'time');
        assert.match(rows[3].textContent, /Unavailable/);
    } finally { env.close(); }
});

test('models with no condition field keep Conditions available with a clear empty state', async () => {
    const env = setup({ fetchWeather: url => Promise.resolve(new Response(JSON.stringify(weatherFixture({ fields: new URL(url).searchParams.get('hourly').split(',') })), { headers: { 'content-type': 'application/json' } })) });
    try {
        await openChart(env);
        const model = env.doc.querySelector('.bpb-weather-model select');
        model.value = 'ecmwf_ifs_analysis_long_window'; model.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using IFS Assimilation'));
        env.doc.querySelector('[data-metric="conditions"]').click();
        assert.equal(env.doc.querySelector('.bpb-weather-conditions').hidden, true);
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
        const tabs = [...env.doc.querySelectorAll('[role="tab"]')];
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
        assert.match(env.doc.querySelector('.bpb-weather-status').textContent, /Showing Best Match while loading/);
        select.value = 'ecmwf_ifs'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using ECMWF IFS'));
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
        const before = env.requests.length;
        const select = env.doc.querySelector('select'); select.value = 'ecmwf_ifs'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('Open-Meteo request limit reached'));
        assert.equal(env.requests.length, before + 1);
        assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Using Best Match/);
        assert.equal(env.doc.querySelector('.bpb-weather-retry').hidden, false);
        assert.equal(env.doc.querySelector('.bpb-weather-retry').disabled, true);
        assert.equal(env.doc.querySelector('.bpb-weather-status').dataset.kind, 'rate-limit');
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
