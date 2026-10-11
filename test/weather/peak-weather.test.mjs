import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { weatherFixture } from '../helpers/weather-fixture.mjs';
import { readPeakWeatherSubject } from '../../src/weather/peak-weather-subject.js';

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
    return new Response(JSON.stringify(weatherFixture({ startDate: query.get('start_date'), hours })), { headers: { 'content-type': 'application/json' } });
};
function setup({ html = peak, fetchFn = reply, lazy = false, now = '2024-11-05T12:00:00Z' } = {}) {
    const jsdom = new JSDOM(html, { url: 'https://www.peakbagger.com/peak.aspx?pid=2296', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = jsdom.window, requests = [], listeners = [], observers = [];
    win.Date.now = () => Date.parse(now);
    win.AbortController = AbortController; win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder;
    win.chrome = { storage: { sync: { get: async () => ({ bpbSettings: { units: 'imperial' } }) }, onChanged: {
        addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1),
    } } };
    if (lazy) win.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
        observe() {} disconnect() { this.disconnected = true; }
    };
    win.fetch = (url, init) => { requests.push({ url, init }); return fetchFn(url, init); };
    win.eval(bundle);
    return { win, doc: win.document, requests, listeners, observers, close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
}
const settled = env => waitFor(() => env.doc.querySelectorAll('.bpb-week-day').length === 7 && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');

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

test('card stays in the right native table below map and includes only seven completed local days', async () => {
    const env = setup();
    try {
        await settled(env);
        const card = env.doc.getElementById('bpb-peak-weather'), map = env.doc.getElementById('Gmap');
        assert.equal(card.closest('table'), map.closest('table'));
        assert.equal(card.closest('table').getAttribute('align'), 'right');
        assert.ok(map.compareDocumentPosition(card) & env.win.Node.DOCUMENT_POSITION_FOLLOWING);
        assert.deepEqual([...env.doc.querySelectorAll('.bpb-week-day')].map(day => day.dataset.date), ['2024-11-04', '2024-11-03', '2024-11-02', '2024-11-01', '2024-10-31', '2024-10-30', '2024-10-29']);
        assert.match(card.querySelector('.bpb-week-range').textContent, /Oct 29.*Nov 4, 2024/);
        assert.match(card.querySelector('.bpb-week-sub').textContent, /14406 ft.*Today excluded/);
        assert.equal(env.requests.length, 1); assert.equal(new URL(env.requests[0].url).host, 'api.open-meteo.com');
        assert.equal(env.requests[0].init.credentials, 'omit'); assert.equal(env.requests[0].init.referrerPolicy, 'no-referrer');
        assert.match(card.textContent, /Community support by Open-Meteo/);
        env.win.eval(bundle); assert.equal(env.doc.querySelectorAll('#bpb-peak-weather').length, 1);
    } finally { env.close(); }
});

test('hourly disclosure retains local DST folds, closes other days and changes units without fetching', async () => {
    const env = setup();
    try {
        await settled(env);
        const fold = env.doc.querySelector('[data-date="2024-11-03"]'); fold.open = true;
        await waitFor(() => fold.querySelectorAll('.bpb-week-hours > tbody > tr').length === 25);
        assert.match(fold.textContent, /01:00 AM PDT/); assert.match(fold.textContent, /01:00 AM PST/);
        assert.match(fold.textContent, /Light snow/);
        assert.equal(env.requests.length, 1);
        const previous = env.doc.querySelector('[data-date="2024-11-02"]'); previous.open = true;
        await waitFor(() => !fold.open && previous.querySelectorAll('.bpb-week-hours > tbody > tr').length === 24);
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        const next = env.doc.querySelector('[data-date="2024-11-02"]');
        assert.equal(next.open, true); assert.match(next.textContent, /°C/); assert.match(next.textContent, /km\/h/);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('missing map retains right-column card; lazy loading never starts before visibility', async () => {
    const env = setup({ html: peak.replace(/<iframe id="Gmap"[\s\S]*?<\/iframe>/, ''), lazy: true });
    try {
        assert.ok(env.doc.getElementById('bpb-peak-weather')); assert.equal(env.requests.length, 0);
        assert.equal(env.doc.getElementById('bpb-peak-weather').closest('table').getAttribute('align'), 'right');
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

test('partial data stays labelled and a failed refresh preserves the previous dated result', async () => {
    let limited = false;
    const env = setup({ fetchFn: url => {
        if (limited) return new Response('', { status: 429 });
        const query = new URL(url).searchParams, hours = (Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 3600_000 + 24;
        const body = weatherFixture({ startDate: query.get('start_date'), hours }); body.hourly.precipitation.fill(null);
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
    try {
        await settled(env);
        assert.equal(env.doc.querySelectorAll('.bpb-week-partial').length, 7);
        assert.ok([...env.doc.querySelectorAll('.bpb-week-metrics')].every(node => node.textContent.includes('Rain/snow —')));
        const range = env.doc.querySelector('.bpb-week-range').textContent;
        limited = true; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('temporarily limited'));
        assert.equal(env.doc.querySelector('.bpb-week-range').textContent, range);
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 7);
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
