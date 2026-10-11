import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { weatherFixture } from '../helpers/weather-fixture.mjs';

const [ascent, peak, bundle] = await Promise.all([
    readFile(new URL('../fixtures/pages/climber-ascent.html', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/ascent-weather.js', import.meta.url), 'utf8'),
]);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
async function waitFor(predicate) {
    const until = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > until) throw new Error('Weather UI did not settle'); await pause(); }
}
const setup = ({ html = ascent.replaceAll('Sunday, July 12, 2026', 'Friday, July 12, 2024'), fetchWeather } = {}) => {
    const jsdom = new JSDOM(html, { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = jsdom.window, requests = [], listeners = [];
    win.AbortController = AbortController; win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder;
    win.chrome = { storage: { sync: { get: async () => ({ bpbSettings: { units: 'imperial' } }) }, onChanged: { addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1) } } };
    win.fetch = async (url, init) => {
        requests.push({ url, init });
        if (new URL(url).host === 'www.peakbagger.com') return new Response(peak, { headers: { 'content-type': 'text/html' } });
        if (fetchWeather) return fetchWeather(url, init);
        return new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } });
    };
    win.eval(bundle);
    return { win, doc: win.document, requests, listeners, close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
};
test('bundled independent card loads on a visitor ascent without GPX or map', async () => {
    const env = setup({ html: ascent.replace('Sunday, July 12, 2026', 'July 12, 2024').replace(/<div id="gpxlinks">[\s\S]*?<\/div>/, '').replace(/<div id="owneractions">[\s\S]*?<\/div>/, '') });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description')?.textContent.includes('Using HRRR'));
        assert.equal(env.requests.length, 2);
        assert.match(env.doc.querySelector('.bpb-weather-condition').textContent, /Snow occurred/);
        assert.equal(env.doc.querySelector('#bpb-ascent-weather').previousElementSibling.id, 'summarydata');
        assert.equal(env.doc.querySelector('#bpb-ascent-weather').getAttribute('aria-busy'), 'false');
        const transfer = env.requests[1]; assert.equal(transfer.init.credentials, 'omit'); assert.equal(transfer.init.referrerPolicy, 'no-referrer');
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

test('same card follows the whole late route explorer without duplication', async () => {
    const env = setup();
    try {
        const card = env.doc.getElementById('bpb-ascent-weather');
        const explorer = env.doc.createElement('div'); explorer.id = 'bpb-route-explorer'; env.doc.getElementById('page').append(explorer);
        await waitFor(() => explorer.nextElementSibling === card);
        assert.equal(env.doc.querySelectorAll('#bpb-ascent-weather').length, 1);
    } finally { env.close(); }
});

test('hourly tabs have one keyboard stop and arrow navigation preserves the active measurement', async () => {
    const env = setup();
    try {
        const tabs = [...env.doc.querySelectorAll('[role="tab"]')];
        assert.deepEqual(tabs.map(tab => tab.tabIndex), [0, -1, -1]);
        tabs[0].focus(); tabs[0].dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
        assert.equal(env.doc.activeElement, tabs[1]);
        assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-selected')), ['false', 'true', 'false']);
        assert.deepEqual(tabs.map(tab => tab.tabIndex), [-1, 0, -1]);
        assert.equal(env.doc.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), tabs[1].id);
        tabs[1].dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'End' }));
        assert.equal(env.doc.activeElement, tabs[2]);
    } finally { env.close(); }
});

test('superseded response cannot overwrite explicit model choice', async () => {
    let finishSlow;
    const env = setup({ fetchWeather: url => {
        if (new URL(url).searchParams.get('models') === 'gfs_global') return new Promise(resolve => { finishSlow = resolve; });
        return Promise.resolve(new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } }));
    } });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using HRRR'));
        const select = env.doc.querySelector('select');
        select.value = 'gfs_global'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => finishSlow);
        assert.match(env.doc.querySelector('.bpb-weather-status').textContent, /Showing HRRR while loading/);
        select.value = 'ecmwf_ifs'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using ECMWF IFS'));
        finishSlow(new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } }));
        await pause(); assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Using ECMWF IFS/);
    } finally { env.close(); }
});

test('rate limits preserve previous results without cascading, explicit selection never falls back', async () => {
    const env = setup({ fetchWeather: url => new URL(url).searchParams.get('models') === 'gfs_hrrr'
        ? Promise.resolve(new Response(JSON.stringify(weatherFixture()), { headers: { 'content-type': 'application/json' } }))
        : Promise.resolve(new Response('', { status: 429 })) });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using HRRR'));
        const before = env.requests.length;
        const select = env.doc.querySelector('select'); select.value = 'ecmwf_ifs'; select.dispatchEvent(new env.win.Event('change'));
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('temporarily limited'));
        assert.equal(env.requests.length, before + 1);
        assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Using HRRR/);
        assert.equal(env.doc.querySelector('.bpb-weather-retry').hidden, false);
    } finally { env.close(); }
});

test('auto falls back for missing archives and partial totals are labelled', async () => {
    const env = setup({ fetchWeather: url => {
        const model = new URL(url).searchParams.get('models');
        if (model === 'gfs_hrrr') return Promise.resolve(new Response('', { status: 400 }));
        const body = weatherFixture(); body.hourly.precipitation[40] = null;
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    } });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('Partial data'));
        assert.match(env.doc.querySelector('.bpb-weather-model-description').textContent, /Using ECMWF IFS/);
        assert.equal(env.doc.querySelector('option[value="gfs_hrrr"]').disabled, true);
        assert.equal(env.doc.querySelector('[data-weather-value="precipitation"]').nextElementSibling.textContent, 'Partial total');
    } finally { env.close(); }
});

test('explicit Retry fetches fresh data and reconsiders unavailable automatic candidates', async () => {
    let refreshed = false;
    const env = setup({ fetchWeather: url => {
        const model = new URL(url).searchParams.get('models');
        if (!refreshed && model === 'gfs_hrrr') return Promise.resolve(new Response('', { status: 400 }));
        const body = weatherFixture();
        if (!refreshed) body.hourly.precipitation[40] = null;
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    } });
    try {
        await waitFor(() => env.doc.querySelector('.bpb-weather-status').textContent.includes('Partial data'));
        assert.equal(env.doc.querySelector('.bpb-weather-retry').hidden, false);
        const before = env.requests.length; refreshed = true;
        env.doc.querySelector('.bpb-weather-retry').click();
        await waitFor(() => env.doc.querySelector('.bpb-weather-model-description').textContent.includes('Using HRRR'));
        assert.equal(env.requests.length, before + 1);
        assert.equal(env.doc.querySelector('option[value="gfs_hrrr"]').disabled, false);
        assert.equal(env.doc.querySelector('.bpb-weather-retry').hidden, true);
        assert.equal(env.doc.querySelector('[data-weather-value="precipitation"]').nextElementSibling.textContent, 'Water equivalent');
    } finally { env.close(); }
});
