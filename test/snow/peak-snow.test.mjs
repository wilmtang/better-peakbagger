// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { snotelStations, snotelFixture } from '../helpers/snotel-fixture.mjs';
import { peakUnitHeadings, withPeakElevation } from '../helpers/peak-unit-fixture.mjs';

const [html, bundle] = await Promise.all([
    readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8'),
    readFile(new URL('../../dist/content/peak-snow.js', import.meta.url), 'utf8'),
]);
const NOW = Date.parse('2026-10-17T20:00:00Z');
const waitFor = async predicate => {
    const deadline = Date.now() + 2500;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Snow card did not settle');
        await new Promise(resolve => setTimeout(resolve, 0));
    }
};
const reply = url => {
    const query = new URL(url).searchParams;
    return new Response(JSON.stringify(new URL(url).pathname.endsWith('/stations') ? snotelStations()
        : snotelFixture(query.get('stationTriplets'), query.get('duration'), NOW)));
};
function setup({ source = html, url = 'https://www.peakbagger.com/peak.aspx?pid=2296', saved = {}, fetchFn = reply, lazy = false, readSettings } = {}) {
    const env = new JSDOM(source, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const win = env.window, doc = win.document, listeners = [], requests = [], observers = [], local = {};
    win.Date.now = () => NOW; win.AbortController = AbortController; win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder;
    win.chrome = { storage: { sync: { get: readSettings || (async () => ({ bpbSettings: saved })) }, local: {
        get: async () => local, set: async values => Object.assign(local, values),
    }, onChanged: { addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1) } } };
    if (lazy) win.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {} disconnect() {}
    };
    win.fetch = (url, init) => { requests.push({ url, init }); return fetchFn(url, init); };
    win.eval(bundle);
    return { win, doc, requests, local, observers, listeners,
        settings: patch => Promise.all(listeners.map(fn => fn({ bpbSettings: { newValue: { ...saved, ...patch } } }, 'sync'))),
        close: () => { win.dispatchEvent(new win.PageTransitionEvent('pagehide')); win.close(); } };
}
const settled = env => waitFor(() => env.doc.querySelector('#bpb-peak-snow')?.getAttribute('aria-busy') === 'false'
    && env.doc.querySelector('.bpb-snow-status')?.textContent.includes('Hourly readings'));
const choose = (env, id) => { const select = env.doc.querySelector('#bpb-peak-snow-station'); select.value = id; select.dispatchEvent(new env.win.Event('change')); };
const mapMessage = (env, detail) => env.win.dispatchEvent(new env.win.MessageEvent('message', {
    source: env.win, origin: env.win.location.origin, data: { __bpbPeakSnow: true, dir: 'toCS', ...detail },
}));

test('SNOTEL can be disabled without weather and enabled without weather; legacy opt-outs stay off', async () => {
    for (const saved of [{ showWeather: true, showSnotel: false }, { showWeather: false }]) {
        const env = setup({ saved });
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.equal(env.doc.getElementById('bpb-peak-snow').hidden, true);
            mapMessage(env, { type: 'get', requestId: 1 });
            assert.equal(env.requests.length, 0);
        } finally { env.close(); }
    }
    const enabled = setup({ saved: { showWeather: false, showSnotel: true } });
    try { await settled(enabled); assert.equal(enabled.doc.getElementById('bpb-peak-snow').hidden, false); }
    finally { enabled.close(); }
});

test('disabling SNOTEL aborts catalog work for both card and map and ignores late replies', async () => {
    const held = [];
    const env = setup({ fetchFn: (url, init) => new Promise(resolve => held.push({ url, init, resolve })) });
    try {
        await waitFor(() => held.length === 1);
        mapMessage(env, { type: 'get', requestId: 1 });
        await env.settings({ showSnotel: false, showWeather: true });
        assert.ok(held.every(request => request.init.signal.aborted));
        held.forEach(request => request.resolve(reply(request.url)));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(env.doc.getElementById('bpb-peak-snow').hidden, true);
        assert.equal(env.requests.length, 1, 'card and map share the cancelled catalog request');
    } finally { env.close(); }
});

test('map conditions can reveal the lazy card and select a station beyond the default nearest three', async () => {
    const catalog = [...snotelStations(),
        { ...snotelStations()[0], stationTriplet: '998:WA:SNTL', name: 'Near station', latitude: 46.80, longitude: -121.70 },
        { ...snotelStations()[0], stationTriplet: '999:WA:SNTL', name: 'Farther station', latitude: 46.85, longitude: -121.25 }];
    let limited = false, failed = false;
    const env = setup({ lazy: true, fetchFn: url => new URL(url).pathname.endsWith('/stations')
        ? new Response(JSON.stringify(catalog)) : limited ? new Response('', { status: 429 }) : failed ? new Response('', { status: 503 }) : reply(url) });
    try {
        await waitFor(() => env.observers.length === 1);
        const messages = []; env.win.postMessage = data => messages.push(data);
        const card = env.doc.getElementById('bpb-peak-snow'), select = env.doc.getElementById('bpb-peak-snow-station');
        let reveals = 0; card.scrollIntoView = () => reveals++;
        mapMessage(env, { type: 'get', requestId: 1 });
        await waitFor(() => messages.some(data => data.type === 'stations'));
        assert.equal(env.requests.length, 1, 'map metadata does not load observations');
        mapMessage(env, { type: 'select', stationId: '999:WA:SNTL', offset: 14, latitude: 0 });
        await settled(env);
        assert.equal(select.value, '999:WA:SNTL'); assert.equal(select.options.length, 4);
        assert.match(select.selectedOptions[0].textContent, /Farther station/);
        assert.equal(env.doc.activeElement, select); assert.equal(reveals, 1);
        assert.match(env.doc.querySelector('#bpb-peak-snow footer a').href, /999%3AWA%3ASNTL/);
        assert.ok([...env.doc.querySelectorAll('.bpb-snow-time')].every(node => node.textContent.includes('UTC−08')));
        assert.equal(env.requests.length, 3);
        // The old queued intersection callback cannot replace the map choice.
        env.observers[0].callback([{ isIntersecting: true }]);
        await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(select.value, '999:WA:SNTL');
        mapMessage(env, { type: 'select', stationId: '123:CO:SNTL' }); assert.equal(env.requests.length, 3);
        failed = true; mapMessage(env, { type: 'select', stationId: '679:WA:SNTL' });
        await waitFor(() => env.doc.querySelector('.bpb-snow-status').textContent.includes('Could not load'));
        assert.equal(select.value, '999:WA:SNTL', 'a retained fourth-nearest station must remain named after another selection fails');
        failed = false; mapMessage(env, { type: 'select', stationId: '999:WA:SNTL' }); await settled(env);
        limited = true; env.doc.querySelector('.bpb-snow-refresh').click();
        await waitFor(() => env.doc.querySelector('.bpb-snow-status').textContent.includes('request limit'));
        const requests = env.requests.length;
        mapMessage(env, { type: 'select', stationId: '679:WA:SNTL' });
        assert.equal(select.value, '999:WA:SNTL'); assert.equal(env.requests.length, requests, 'map selection respects NRCS cooldown');
        await env.settings({ showSnotel: false }); mapMessage(env, { type: 'select', stationId: '679:WA:SNTL' });
        assert.equal(env.requests.length, requests);
    } finally { env.close(); }
});

test('peak card uses native summit metadata without GPX and mounts once after the weather/map row', async () => {
    const env = setup();
    try {
        await settled(env);
        const row = env.doc.querySelector('#bpb-peak-snow-row');
        assert.equal(row.previousElementSibling.querySelector('#Gmap')?.id, 'Gmap');
        assert.equal(env.requests.length, 3); assert.equal(env.doc.querySelectorAll('.bpb-snow-metric').length, 2);
        assert.match(env.doc.querySelector('#bpb-peak-snow-station').selectedOptions[0].textContent, /Paradise.*away.*5150 ft/);
        assert.match(env.doc.querySelector('.bpb-snow-metric strong').textContent, /36.0 in/);
        const times = [...env.doc.querySelectorAll('.bpb-snow-time')].map(node => node.textContent);
        assert.notEqual(times[0], times[1]); assert.ok(times.every(time => time.includes('UTC−08')));
        assert.equal(env.doc.querySelectorAll('#bpb-peak-snow tbody tr').length, 8);
        assert.match(env.doc.querySelector('#bpb-peak-snow footer a').href, /679%3AWA%3ASNTL/);
        assert.equal(env.doc.querySelector('#bpb-peak-snow-station').form, null,
            'native station selection must remain outside the host POST form');
        env.win.eval(bundle); assert.equal(env.doc.querySelectorAll('#bpb-peak-snow').length, 1);
    } finally { env.close(); }
});

for (const [heading, system] of peakUnitHeadings) {
    test(`automatic snow units follow the primary native elevation: ${heading}`, async () => {
        const env = setup({ source: withPeakElevation(html, heading), saved: { units: 'auto' } });
        try {
            await settled(env);
            const station = () => env.doc.querySelector('#bpb-peak-snow-station').selectedOptions[0].textContent;
            const depth = () => env.doc.querySelector('.bpb-snow-metric strong').textContent;
            assert.match(station(), system === 'metric' ? /km away.*1570 m/ : /mi away.*5150 ft/);
            assert.match(depth(), system === 'metric' ? /91\.4 cm/ : /36\.0 in/);
            const count = env.requests.length;
            await env.settings({ units: 'auto', precipitationUnits: 'imperial', elevationUnits: 'metric' });
            assert.match(station(), /1570 m/); assert.match(depth(), /36\.0 in/);
            assert.equal(env.requests.length, count, 'unit changes reuse canonical data');
        } finally { env.close(); }
    });
}

test('snow title has a decorative SNOTEL icon and Refresh belongs beside the station selector', async () => {
    const env = setup();
    try {
        await settled(env);
        const card = env.doc.getElementById('bpb-peak-snow'), select = card.querySelector('select');
        const refresh = card.querySelector('.bpb-snow-refresh');
        assert.equal(select.parentElement.contains(refresh), true, 'the selector and Refresh form one compact control row');
        assert.equal(card.querySelector('header').contains(refresh), false, 'the disclosure header has no nested Refresh action');
        const icon = card.querySelector('h2 svg');
        assert.equal(icon.getAttribute('aria-hidden'), 'true'); assert.equal(icon.getAttribute('focusable'), 'false');
        assert.equal(card.querySelector('h2').textContent, 'Nearby snow');
        assert.equal(select.form, null, 'the inline control retains its independent native form behavior');
    } finally { env.close(); }
});

test('snow-depth trend labels observation dates and each plotted reading', async () => {
    const env = setup();
    try {
        await settled(env);
        const dates = [...env.doc.querySelectorAll('.bpb-snow-details tbody th')].map(node => node.textContent);
        assert.deepEqual([...env.doc.querySelectorAll('.bpb-snow-dates span')].map(node => node.textContent),
            [dates[0], dates[4], dates[7]], 'the horizontal axis shows daily observation dates');
        const dot = env.doc.querySelector('.bpb-snow-graph circle');
        assert.match(dot.querySelector('title').textContent, new RegExp(`${dates[0]}.*in`));
        await env.settings({ units: 'metric' });
        assert.match(env.doc.querySelector('.bpb-snow-graph circle title').textContent, /cm/);
    } finally { env.close(); }
});

test('snow-depth chart supports keyboard readings without requests and clears selection on station changes', async () => {
    const env = setup();
    try {
        await settled(env);
        const chart = env.doc.querySelector('.bpb-snow-graph');
        const reading = () => env.doc.querySelector('.bpb-snow-range > span').textContent;
        const key = name => chart.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
        const requests = env.requests.length;
        assert.equal(chart.tabIndex, 0, 'daily snow-depth readings must be reachable with the keyboard');
        chart.focus(); key('Home');
        assert.match(reading(), /Oct 10.*Snow depth.*32\.0 in/);
        assert.equal(env.doc.querySelectorAll('.bpb-snow-cursor').length, 1);
        key('ArrowRight'); assert.match(reading(), /Oct 11.*33\.0 in/);
        key('End'); assert.match(reading(), /Oct 17.*39\.0 in/);
        await env.settings({ units: 'metric' }); assert.match(reading(), /Oct 17.*99\.1 cm/);
        assert.equal(env.requests.length, requests);
        key('Escape'); assert.match(reading(), /Hover, tap or use ← →/);
        assert.equal(env.doc.querySelectorAll('.bpb-snow-cursor').length, 0);
        key('Home'); choose(env, '375:WA:SNTL'); await settled(env);
        assert.match(reading(), /Hover, tap or use ← →/);
        assert.equal(env.doc.querySelectorAll('.bpb-snow-cursor').length, 0, 'a different station cannot inherit the old selection');
    } finally { env.close(); }
});

test('snow chart hover previews restore the pinned date through refresh and lifecycle suspension', async () => {
    let hold = false; const held = [];
    const env = setup({ fetchFn: url => hold ? new Promise(resolve => held.push({ url, resolve })) : reply(url) });
    try {
        await settled(env);
        const chart = env.doc.querySelector('.bpb-snow-graph'), graph = chart.querySelector('svg');
        const reading = () => env.doc.querySelector('.bpb-snow-range > span').textContent;
        graph.getBoundingClientRect = () => ({ left: 0, width: 320, height: 80 });
        const pointer = (type, index) => chart.dispatchEvent(new env.win.MouseEvent(type, { clientX: 8 + index * 304 / 7, bubbles: true }));
        pointer('click', 2); assert.match(reading(), /Oct 12.*34\.0 in/);
        pointer('pointermove', 7); assert.match(reading(), /Oct 17.*39\.0 in/);
        pointer('pointerleave', 7); assert.match(reading(), /Oct 12.*34\.0 in/);
        hold = true; env.doc.querySelector('.bpb-snow-refresh').click(); await waitFor(() => held.length === 1);
        assert.match(reading(), /Oct 12.*34\.0 in/);
        assert.equal(chart.tabIndex, 0, 'previous readings stay interactive during refresh');
        hold = false; held.splice(0).forEach(item => item.resolve(reply(item.url))); await settled(env);
        assert.match(reading(), /Oct 12.*34\.0 in/);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(chart.tabIndex, -1); pointer('click', 7);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true }));
        await settled(env); assert.match(reading(), /Oct 12.*34\.0 in/);
    } finally { env.close(); }
});

test('snow chart exposes unavailable days without bridging gaps or hiding zero depth', async () => {
    const env = setup({ fetchFn: url => {
        const query = new URL(url).searchParams;
        if (new URL(url).pathname.endsWith('/stations')) return reply(url);
        const body = snotelFixture(query.get('stationTriplets'), query.get('duration'), NOW);
        if (query.get('duration') === 'DAILY') {
            body[0].data[0].values[0].value = 0;
            body[0].data[0].values[1].value = null;
        }
        return new Response(JSON.stringify(body));
    } });
    try {
        await settled(env);
        const chart = env.doc.querySelector('.bpb-snow-graph');
        const key = name => chart.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: name, bubbles: true }));
        const path = chart.querySelector('path:not(.bpb-snow-baseline)').getAttribute('d');
        assert.equal(path.split('M').length, 3, 'missing readings break the trend');
        key('Home'); assert.match(env.doc.querySelector('.bpb-snow-range > span').textContent, /0\.0 in/);
        assert.ok(chart.querySelector('.bpb-snow-selected'));
        key('ArrowRight'); assert.match(env.doc.querySelector('.bpb-snow-range > span').textContent, /Oct 11.*unavailable/);
        assert.ok(chart.querySelector('.bpb-snow-cursor'));
        assert.equal(chart.querySelector('.bpb-snow-selected'), null, 'a missing reading has no invented dot');
    } finally { env.close(); }
});

test('SWE is explicitly named and keeps its own measurement, timestamp and daily history', async () => {
    const env = setup();
    try {
        await settled(env);
        const metrics = env.doc.querySelectorAll('.bpb-snow-metric');
        assert.equal(metrics[1].querySelector('.bpb-snow-label').textContent, 'Water equivalent (SWE)');
        assert.equal(metrics[1].querySelector('strong').textContent, '12.30 in');
        assert.notEqual(metrics[1].querySelector('.bpb-snow-time').textContent, metrics[0].querySelector('.bpb-snow-time').textContent);
        const table = env.doc.querySelector('.bpb-snow-details table');
        const dailySwe = () => Array.from(table.tBodies[0].rows).at(-1).cells[2].querySelector('span').textContent;
        assert.equal(table.querySelector('thead th:last-child').textContent, 'SWE');
        assert.equal(dailySwe(), '12.70 in');
        assert.match(env.doc.querySelector('.bpb-snow-details').textContent, /Snow water equivalent \(SWE\) is the water held in the snowpack/);
        const requests = env.requests.length;
        await env.settings({ units: 'metric' });
        assert.equal(metrics[1].querySelector('strong').textContent, '312.4 mm');
        assert.equal(dailySwe(), '322.6 mm');
        assert.equal(env.requests.length, requests, 'SWE unit changes use the original observation');
    } finally { env.close(); }
});

test('weather setting must resolve and card must approach viewport before any request', async () => {
    const env = setup({ lazy: true });
    try {
        await waitFor(() => env.observers.length === 1);
        assert.equal(env.requests.length, 0);
        env.observers[0].callback([{ isIntersecting: true }]); await settled(env);
        await env.settings({ showSnotel: false }); assert.equal(env.doc.querySelector('#bpb-peak-snow-row').hidden, true);
        await env.settings({ showSnotel: true }); await waitFor(() => env.observers.length === 2);
        env.observers[1].callback([{ isIntersecting: true }]); await settled(env);
        assert.equal(env.requests.length, 3, 'reenabling reuses cached observations');
    } finally { env.close(); }
    const disabled = setup({ saved: { showSnotel: false } });
    try { await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(disabled.requests.length, 0); assert.equal(disabled.doc.querySelector('#bpb-peak-snow').hidden, true); }
    finally { disabled.close(); }
    const unreadable = setup({ readSettings: async () => { throw new Error('unavailable'); } });
    try { await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(unreadable.requests.length, 0); }
    finally { unreadable.close(); }
});

test('unsupported countries, eastern locations and ambiguous pages do not mount or request', () => {
    for (const options of [{ source: html.replace('>United States<', '>Canada<') },
        { source: html.replace('46.851731, -121.760395 (Dec Deg)', '46.851731, -71.760395 (Dec Deg)') },
        { url: 'https://www.peakbagger.com/peak.aspx?pid=2296&pid=3' },
        { source: html.replace('Latitude/Longitude (WGS84)', 'Unknown location') }]) {
        const env = setup(options);
        try { assert.equal(env.doc.querySelector('#bpb-peak-snow'), null); assert.equal(env.requests.length, 0); }
        finally { env.close(); }
    }
});

test('a queued visibility callback from a disabled generation cannot start work after reenable', async () => {
    const env = setup({ lazy: true });
    try {
        await waitFor(() => env.observers.length === 1);
        await env.settings({ showSnotel: false }); await env.settings({ showSnotel: true });
        await waitFor(() => env.observers.length === 2);
        env.observers[0].callback([{ isIntersecting: true }]);
        await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(env.requests.length, 0);
        env.observers[1].callback([{ isIntersecting: true }]); await settled(env); assert.equal(env.requests.length, 3);
    } finally { env.close(); }
});

test('station switching uses truthful placeholders, preserves native selection and rejects stale responses', async () => {
    let hold = false; const held = [];
    const env = setup({ fetchFn: (url, init) => hold ? new Promise(resolve => held.push({ url, init, resolve })) : reply(url) });
    try {
        await settled(env); const select = env.doc.querySelector('#bpb-peak-snow-station');
        hold = true; choose(env, '375:WA:SNTL'); await waitFor(() => held.length === 1);
        assert.equal(select.value, '375:WA:SNTL'); assert.match(env.doc.querySelector('.bpb-snow-status').textContent, /Loading selected station/);
        assert.equal(env.doc.querySelector('.bpb-snow-metric strong').textContent, '—');
        assert.match(env.doc.querySelector('#bpb-peak-snow footer a').href, /375/);
        choose(env, '679:WA:SNTL'); await settled(env);
        assert.equal(held[0].init.signal.aborted, true);
        held[0].resolve(reply(held[0].url)); await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(select.value, '679:WA:SNTL');
        hold = false; choose(env, '375:WA:SNTL');
        await waitFor(() => select.value === '375:WA:SNTL' && env.doc.querySelector('#bpb-peak-snow').getAttribute('aria-busy') === 'false');
        assert.match(env.doc.querySelector('#bpb-peak-snow footer a').href, /375%3AWA%3ASNTL/);
        choose(env, '679:WA:SNTL'); await settled(env);
        assert.equal(env.requests.length, 6, 'returning to the first station requires no fetch');
    } finally { env.close(); }
});

for (const failure of ['service', 'timeout']) {
    test(`Refresh targets the displayed station after a ${failure} failure switching stations`, async () => {
        let fail = false;
        const env = setup({ fetchFn: url => {
            if (fail && new URL(url).searchParams.get('stationTriplets') === '375:WA:SNTL') {
                if (failure === 'timeout') throw Object.assign(new Error('Timed out'), { name: 'TimeoutError' });
                return new Response('', { status: 503 });
            }
            return reply(url);
        } });
        try {
            await settled(env); fail = true; choose(env, '375:WA:SNTL');
            await waitFor(() => env.doc.querySelector('.bpb-snow-status').textContent.includes('Previous readings shown')
                && env.doc.querySelector('#bpb-peak-snow').getAttribute('aria-busy') === 'false');
            const select = env.doc.querySelector('#bpb-peak-snow-station');
            assert.equal(select.value, '679:WA:SNTL');
            const before = env.requests.length, displayed = select.value;
            env.doc.querySelector('.bpb-snow-refresh').click();
            assert.equal(new URL(env.requests[before].url).searchParams.get('stationTriplets'), displayed,
                'Refresh must reload the station shown in the picker, not a hidden failed intent');
            await settled(env);
        } finally { env.close(); }
    });
}

test('a restored map station outside the nearest three remains selectable and refreshable', async () => {
    const catalog = [...snotelStations(),
        { ...snotelStations()[0], stationTriplet: '998:WA:SNTL', name: 'Near station', latitude: 46.80, longitude: -121.70 },
        { ...snotelStations()[0], stationTriplet: '999:WA:SNTL', name: 'Farther station', latitude: 46.85, longitude: -121.25 }];
    let failed = false;
    const env = setup({ fetchFn: url => new URL(url).pathname.endsWith('/stations')
        ? new Response(JSON.stringify(catalog)) : failed ? new Response('', { status: 503 }) : reply(url) });
    try {
        await settled(env); const messages = []; env.win.postMessage = data => messages.push(data);
        env.doc.getElementById('bpb-peak-snow').scrollIntoView = () => {};
        mapMessage(env, { type: 'get', requestId: 1 });
        await waitFor(() => messages.some(data => data.type === 'stations'));
        mapMessage(env, { type: 'select', stationId: '999:WA:SNTL' }); await settled(env);
        failed = true; mapMessage(env, { type: 'select', stationId: '679:WA:SNTL' });
        await waitFor(() => env.doc.querySelector('.bpb-snow-status').textContent.includes('Could not load'));
        const select = env.doc.querySelector('#bpb-peak-snow-station');
        assert.equal(select.value, '999:WA:SNTL');
        failed = false; choose(env, '999:WA:SNTL');
        assert.match(env.doc.querySelector('.bpb-snow-status').textContent, /Refreshing/,
            'every offered option must have a working selection handler');
        await settled(env);
        const before = env.requests.length; env.doc.querySelector('.bpb-snow-refresh').click();
        assert.equal(new URL(env.requests[before].url).searchParams.get('stationTriplets'), '999:WA:SNTL');
        await settled(env); assert.equal(select.value, '999:WA:SNTL');
    } finally { env.close(); }
});

test('Refresh stays focused and cannot duplicate work while pending; failure retains measurements', async () => {
    let hold = false, held, fail = false;
    const env = setup({ fetchFn: url => fail ? new Response('', { status: 503 }) : hold ? new Promise(resolve => { held = { url, resolve }; }) : reply(url) });
    try {
        await settled(env); const button = env.doc.querySelector('.bpb-snow-refresh');
        const before = env.doc.querySelector('.bpb-snow-metrics').textContent;
        hold = true; button.focus(); button.click(); button.click();
        await waitFor(() => held); assert.equal(env.requests.length, 4); assert.equal(env.doc.activeElement, button);
        assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-disabled'), 'true');
        await env.settings({ showSnotel: false }); assert.equal(env.requests[3].init.signal.aborted, true);
        held.resolve(reply(held.url)); hold = false; fail = true;
        await env.settings({ showSnotel: true }); await settled(env);
        button.click(); await waitFor(() => env.doc.querySelector('.bpb-snow-status').textContent.includes('Could not load'));
        assert.equal(env.doc.querySelector('.bpb-snow-metrics').textContent, before);
        assert.equal(env.doc.activeElement, button); assert.equal(button.getAttribute('aria-disabled'), 'false');
    } finally { env.close(); }
});

for (const stage of ['catalog', 'hourly', 'daily', 'refresh']) {
    test(`${stage} timeout is explicit and leaves Refresh available for an immediate retry`, async () => {
        let timedOut = stage !== 'refresh';
        const env = setup({ fetchFn: url => {
            const request = new URL(url);
            const target = stage === 'catalog' ? request.pathname.endsWith('/stations')
                : request.searchParams.get('duration') === (stage === 'daily' ? 'DAILY' : 'HOURLY');
            if (timedOut && target) throw Object.assign(new Error('Request exceeded its deadline.'), { name: 'TimeoutError' });
            return reply(url);
        } });
        try {
            const button = env.doc.querySelector('.bpb-snow-refresh');
            if (stage === 'refresh') { await settled(env); timedOut = true; button.focus(); button.click(); }
            await waitFor(() => env.requests.length > 0 && env.doc.querySelector('#bpb-peak-snow').getAttribute('aria-busy') === 'false');
            const status = env.doc.querySelector('.bpb-snow-status').textContent;
            assert.match(status, /request timed out/i);
            assert.match(status, /Refresh/);
            if (stage === 'refresh') {
                assert.match(status, /Previous readings shown/);
                assert.equal(env.doc.querySelector('.bpb-snow-metric strong').textContent, '36.0 in');
                assert.equal(env.doc.activeElement, button);
            }
            assert.equal(button.disabled, false);
            assert.equal(button.getAttribute('aria-disabled'), 'false');
            timedOut = false; button.click(); await settled(env);
        } finally { env.close(); }
    });
}

test('missing sensors and null readings remain unavailable, while zero remains visible', async () => {
    const env = setup({ fetchFn: url => {
        if (new URL(url).pathname.endsWith('/stations')) return reply(url);
        const query = new URL(url).searchParams, body = snotelFixture(query.get('stationTriplets'), query.get('duration'), NOW);
        body[0].data[0].values.forEach(reading => { reading.value = null; });
        body[0].data[1].values.forEach(reading => { reading.value = 0; });
        return new Response(JSON.stringify(body));
    } });
    try {
        await settled(env);
        const values = [...env.doc.querySelectorAll('.bpb-snow-metric strong')].map(node => node.textContent);
        assert.deepEqual(values, ['—', '0.00 in']);
        assert.equal(env.doc.querySelector('.bpb-snow-graph p').hidden, false);
        assert.equal(env.doc.querySelectorAll('.bpb-snow-graph circle').length, 0);
        assert.equal(env.doc.querySelector('.bpb-snow-graph').tabIndex, -1);
        await env.settings({ units: 'metric' });
        assert.equal(env.doc.querySelectorAll('.bpb-snow-metric strong')[1].textContent, '0.0 mm');
        assert.equal(env.requests.length, 3, 'unit changes use the loaded data');
    } finally { env.close(); }
});

test('no nearby station and service errors remain distinct; rate-limit cooldown blocks all duplicate activation', async () => {
    let completeCatalog;
    const empty = setup({ fetchFn: () => new Promise(resolve => {
        completeCatalog = () => resolve(new Response(JSON.stringify(snotelStations().map(station => ({ ...station, latitude: 40, longitude: -111 })))));
    }) });
    try {
        await waitFor(() => completeCatalog && !empty.doc.getElementById('bpb-peak-snow').hidden);
        const refresh = empty.doc.querySelector('.bpb-snow-refresh'); refresh.focus();
        assert.equal(empty.doc.activeElement, refresh); completeCatalog();
        await waitFor(() => empty.doc.querySelector('.bpb-snow-status').textContent.includes('No SNOTEL'));
        assert.equal(empty.requests.length, 1); assert.equal(empty.doc.querySelector('.bpb-snow-refresh').getAttribute('aria-disabled'), 'true');
        assert.equal(empty.doc.querySelector('.bpb-snow-observations').hidden, true);
        assert.equal(empty.doc.querySelector('.bpb-snow-details').hidden, true);
        assert.equal(refresh.closest('[hidden]'), null, 'empty coverage keeps the focused control visible');
        assert.equal(empty.doc.activeElement, refresh);
    } finally { empty.close(); }
    const unavailable = setup({ fetchFn: async () => new Response('[]') });
    try {
        await waitFor(() => unavailable.requests.length > 0 && unavailable.doc.querySelector('#bpb-peak-snow').getAttribute('aria-busy') === 'false');
        assert.match(unavailable.doc.querySelector('.bpb-snow-status').textContent, /Could not load/);
        assert.doesNotMatch(unavailable.doc.querySelector('.bpb-snow-status').textContent, /No SNOTEL/);
        assert.equal(unavailable.doc.querySelector('.bpb-snow-refresh').closest('[hidden]'), null, 'catalog failures keep retry available');
    } finally { unavailable.close(); }
    const failed = setup({ fetchFn: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) });
    try {
        await waitFor(() => failed.doc.querySelector('.bpb-snow-status').textContent.includes('NRCS request limit'));
        failed.doc.querySelector('.bpb-snow-refresh').click(); assert.equal(failed.requests.length, 1);
        assert.doesNotMatch(failed.doc.querySelector('.bpb-snow-status').textContent, /No SNOTEL/);
    } finally { failed.close(); }
});

test('bfcache suspension cancels work, resume reuses data and disposal removes subscriptions', async () => {
    const env = setup();
    try {
        await settled(env);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true })); await settled(env);
        assert.equal(env.requests.length, 3); assert.equal(env.listeners.length, 2);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide'));
        assert.equal(env.listeners.length, 0);
    } finally { env.close(); }
});

test('rate-limited station control keeps focus and cannot relabel retained observations or issue requests', async () => {
    let limited = false;
    const env = setup({ fetchFn: url => limited ? new Response('', { status: 429 }) : reply(url) });
    try {
        await settled(env); const select = env.doc.querySelector('#bpb-peak-snow-station'); select.focus();
        limited = true; choose(env, '375:WA:SNTL');
        await waitFor(() => env.doc.querySelector('.bpb-snow-status').textContent.includes('NRCS request limit'));
        const count = env.requests.length;
        assert.equal(select.value, '679:WA:SNTL'); assert.equal(select.getAttribute('aria-disabled'), 'true');
        assert.equal(select.disabled, false); assert.equal(env.doc.activeElement, select);
        choose(env, '375:WA:SNTL'); assert.equal(select.value, '679:WA:SNTL'); assert.equal(env.requests.length, count);
        for (const key of ['ArrowDown', 'Enter', 'b']) {
            const event = new env.win.KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
            select.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
        }
        const tab = new env.win.KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
        select.dispatchEvent(tab); assert.equal(tab.defaultPrevented, false, 'cooldown does not trap keyboard focus');
    } finally { env.close(); }
});

test('unit updates reuse daily snow rows and preserve their date and quality context', async () => {
    const env = setup({ saved: { showSnotel: true, units: 'imperial' } });
    try {
        await settled(env);
        const rows = [...env.doc.querySelectorAll('.bpb-snow-details tbody tr')];
        const dates = rows.map(row => row.querySelector('th').textContent);
        const values = rows.map(row => row.querySelector('td span').textContent);
        await env.settings({ units: 'metric' });
        assert.ok(env.doc.querySelector('.bpb-snow-details tbody tr') === rows[0], 'a unit change must not rebuild the daily table');
        assert.deepEqual(rows.map(row => row.querySelector('th').textContent), dates);
        assert.ok(rows.every(row => row.querySelectorAll('td small').length === 2));
        assert.notDeepEqual(rows.map(row => row.querySelector('td span').textContent), values);
    } finally { env.close(); }
});
