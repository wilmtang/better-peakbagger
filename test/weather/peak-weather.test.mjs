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
function setup({ html = peak, fetchFn = reply, lazy = false, now = '2024-11-05T12:00:00Z', storedSettings = {}, readSettings } = {}) {
    const jsdom = new JSDOM(html, { url: 'https://www.peakbagger.com/peak.aspx?pid=2296', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = jsdom.window, requests = [], listeners = [], observers = [], resizeObservers = [];
    let clock = Date.parse(now);
    win.Date.now = () => clock;
    win.AbortController = AbortController; win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder;
    win.chrome = { storage: { sync: { get: readSettings || (async () => ({ bpbSettings: { units: 'imperial', ...storedSettings } })) }, onChanged: {
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
    win.fetch = (url, init) => { requests.push({ url, init }); return fetchFn(url, init); };
    win.eval(bundle);
    return { win, doc: win.document, requests, listeners, observers, resizeObservers,
        setNow: next => { clock = Date.parse(next); },
        resize: width => { chartWidth = width; resizeObservers.filter(observer => !observer.disconnected).forEach(observer => observer.callback()); },
        close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
}
const settled = async (env, { past = true } = {}) => {
    await waitFor(() => env.doc.querySelectorAll('.bpb-week-day').length === 16 && env.doc.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false');
    if (past) env.doc.querySelector('[data-period="past"]').click();
};

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

test('card stays in the right native table below map and includes sixteen completed local days', async () => {
    const env = setup();
    try {
        await settled(env);
        const card = env.doc.getElementById('bpb-peak-weather'), map = env.doc.getElementById('Gmap');
        assert.equal(card.closest('table'), map.closest('table'));
        assert.equal(card.closest('table').getAttribute('align'), 'right');
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

test('hourly disclosure retains local DST folds, closes other days and changes units without fetching', async () => {
    const env = setup();
    try {
        await settled(env);
        const fold = env.doc.querySelector('[data-date="2024-11-03"]'); fold.open = true;
        await waitFor(() => fold.querySelectorAll('.bpb-week-point').length === 25);
        assert.match(fold.textContent, /01:00 AM PDT/); assert.match(fold.textContent, /01:00 AM PST/);
        const conditions = fold.querySelector('[data-metric="code"]'); conditions.click();
        assert.equal(fold.querySelectorAll('.bpb-week-conditions li').length, 25);
        assert.match(fold.textContent, /Light snow/);
        assert.equal(env.requests.length, 1);
        const previous = env.doc.querySelector('[data-date="2024-11-02"]'); previous.open = true;
        await waitFor(() => !fold.open && previous.querySelectorAll('.bpb-week-conditions li').length === 24);
        assert.equal(previous.querySelector('[aria-selected="true"]').dataset.metric, 'code');
        previous.querySelector('[data-metric="temperature"]').click();
        env.listeners.forEach(fn => fn({ bpbSettings: { newValue: { units: 'metric' } } }, 'sync'));
        const next = env.doc.querySelector('[data-date="2024-11-02"]');
        assert.equal(next.open, true); assert.match(next.textContent, /°C/); assert.match(next.textContent, /km\/h/);
        assert.match(next.querySelector('svg').getAttribute('aria-label'), /°C/);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('hourly tabs, keyboard sampling, hover and pinned readings reuse data and resize inside the card', async () => {
    const env = setup();
    try {
        await settled(env);
        const day = env.doc.querySelector('.bpb-week-day'); day.open = true;
        await waitFor(() => day.querySelector('.bpb-week-line'));
        const temperature = day.querySelector('[data-metric="temperature"]'), rain = day.querySelector('[data-metric="precipitation"]');
        const tabs = [...day.querySelectorAll('[role="tab"]')];
        assert.deepEqual(tabs.map(tab => tab.textContent), ['Conditions', 'Temperature', 'Rain/snow', 'Wind', 'Gusts']);
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
        env.resize(300); assert.equal(day.querySelector('svg').getAttribute('viewBox'), '0 0 300 184');
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
        await waitFor(() => day.querySelector('.bpb-week-line'));
        assert.equal(day.querySelectorAll('.bpb-week-point').length, 22);
        assert.equal((day.querySelector('.bpb-week-line').getAttribute('d').match(/M/g) || []).length, 3);
        const frame = day.querySelector('.bpb-week-chart');
        frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        for (let i = 0; i < 8; i++) frame.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        assert.match(day.querySelector('.bpb-week-readout').textContent, /08:00 AM PST.*Unavailable/);
        day.querySelector('[data-metric="code"]').click();
        assert.equal(day.querySelectorAll('.bpb-week-conditions li').length, 24);
        assert.match(day.querySelectorAll('.bpb-week-conditions li')[8].textContent, /Unavailable/);
        day.querySelector('[data-metric="precipitation"]').click();
        assert.equal(day.querySelector('.bpb-week-chart-empty').hidden, false);
        assert.equal(day.querySelector('svg').hasAttribute('hidden'), true);
        assert.equal(day.querySelectorAll('.bpb-week-line').length, 0);
        assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});

test('expanded graph observers suspend, restore the chosen tab and disconnect on disposal', async () => {
    const env = setup();
    try {
        await settled(env);
        const day = env.doc.querySelector('.bpb-week-day'); day.open = true;
        await waitFor(() => day.querySelector('.bpb-week-line'));
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
        await waitFor(() => day.querySelector('.bpb-week-line'));
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
        assert.equal(env.doc.querySelectorAll('.bpb-week-partial').length, 16);
        assert.ok([...env.doc.querySelectorAll('.bpb-week-metrics')].every(node => node.textContent.includes('Rain/snow —')));
        const range = env.doc.querySelector('.bpb-week-range').textContent;
        limited = true; env.doc.querySelector('.bpb-week-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-week-status').textContent.includes('Open-Meteo request limit reached'));
        assert.equal(env.doc.querySelector('.bpb-week-range').textContent, range);
        assert.equal(env.doc.querySelectorAll('.bpb-week-day').length, 16);
        assert.equal(env.doc.querySelector('.bpb-week-status').dataset.kind, 'rate-limit');
        assert.equal(env.doc.querySelector('.bpb-week-refresh').disabled, false);
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
        await waitFor(() => first.querySelector('.bpb-week-line'));
        assert.deepEqual([...first.querySelectorAll('[role="tab"]')].map(tab => tab.textContent), ['Conditions', 'Temperature', 'Rain/snow', 'Wind', 'Gusts']);
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

test('accuracy warning and accessible source disclosure explain possible models without claiming per-hour provenance', async () => {
    const env = setup();
    try {
        await settled(env, { past: false });
        const accuracy = env.doc.querySelector('.bpb-week-accuracy'), source = env.doc.querySelector('.bpb-week-source');
        assert.equal(accuracy.hidden, false); assert.match(accuracy.textContent, /may be inaccurate.*farther ahead.*mountain summits/);
        assert.equal(source.hidden, false); assert.equal(source.open, false);
        assert.equal(source.querySelector('summary').textContent, 'Models & source details');
        source.open = true;
        const model = source.querySelector('.bpb-week-models').textContent;
        for (const name of ['Best Match', 'NOAA HRRR', 'NOAA GFS', 'DWD ICON', 'ECMWF IFS']) assert.ok(model.includes(name));
        assert.match(model, /may use/); assert.match(model, /does not identify the model behind each value/);
        assert.match(source.textContent, /final day may have incomplete hours/);
        env.doc.querySelector('[data-period="past"]').click();
        assert.equal(accuracy.hidden, true); assert.equal(source.open, true);
        assert.match(source.textContent, /not weather-station observations/);
        assert.match(env.doc.querySelector('footer').textContent, /Estimates may be inaccurate/);
        env.doc.querySelector('[data-period="forecast"]').click();
        assert.equal(accuracy.hidden, false); assert.equal(env.requests.length, 1);
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
