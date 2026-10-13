// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { resolveAvalancheLinks } from '../../src/avalanche/avalanche-links.js';
import { parsePeakNations, readPeakNations } from '../../src/avalanche/avalanche-location.js';

const bundle = await readFile(new URL('../../dist/content/peak-links.js', import.meta.url), 'utf8');
const resolve = (text, latitude = 46.85, longitude = -121.76) =>
    resolveAvalancheLinks({ nations: parsePeakNations(text), latitude, longitude });
const nationRow = value => `<tr><td>Nation</td><td>${value}</td></tr>`;
const render = ({ rows = nationRow('Canada'), extra = '' } = {}) => {
    const dom = new JSDOM(`<table id="peak">
        <tr><td>Latitude/Longitude (WGS84)</td><td>49.850562, -123.004672 (Dec Deg)</td></tr>
        ${rows}<tr><td colspan="2"><b>Links</b><br><br><a id="native" href="https://example.com/">Native link</a></td></tr>
        </table>${extra}`, { url: 'https://www.peakbagger.com/Peak.aspx?pid=875', runScripts: 'outside-only' });
    // Any new automatic provider traffic, extension transaction, or location
    // lookup fails the shipped-bundle test immediately.
    const unexpected = () => { throw new Error('Planning links must resolve locally'); };
    dom.window.fetch = unexpected;
    dom.window.XMLHttpRequest = unexpected;
    dom.window.chrome = { runtime: { sendMessage: unexpected }, storage: { sync: { get: unexpected } } };
    Object.defineProperty(dom.window.navigator, 'geolocation', { value: { getCurrentPosition: unexpected } });
    dom.window.eval(bundle);
    return dom;
};

test('the reviewed worldwide registry routes every configured country without asserting zone coverage', () => {
    const cases = [
        ['United States', 'https://avalanche.org/', 'aggregator'],
        ['Canada', 'https://avalanche.ca/map', 'professional'],
        ...['Andorra', 'Austria', 'Czech Republic', 'Finland', 'France', 'Germany', 'Italy',
            'Poland', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Ukraine']
            .map(country => [country, 'https://eaws-bulletin-map.legner.me/', 'aggregator']),
        ['Romania', 'https://www.avalanches.org/about/', 'aggregator'],
        ['Switzerland', 'https://whiterisk.ch/en/conditions', 'government'],
        ['Norway', 'https://www.varsom.no/en/avalanches/avalanche-warnings/', 'government'],
        ['Iceland', 'https://gottvedur.is/snjoflod/en/', 'government'],
        ['United Kingdom', 'https://www.sais.gov.uk/', 'professional'],
        ['New Zealand', 'https://www.avalanche.net.nz/', 'professional'],
        ['Japan', 'https://data.nadare.jp/avalanche_informations/', 'professional'],
        ['India', 'https://drdo.gov.in/drdo/en/documents/avalanche-warning-bulletin', 'government'],
        ['Australia', 'https://mountainsafetycollective.org/backcountry-conditions-reports', 'professional'],
    ];
    for (const [country, destination, kind] of cases) {
        const result = resolve(country, 47, 11);
        assert.equal(result.unconfigured, false, country);
        assert.equal(result.links.length, 1, country);
        const link = result.links[0], url = new URL(link.href);
        assert.equal(url.origin + url.pathname, destination, country);
        assert.equal(link.kind, kind);
        assert.equal(url.protocol, 'https:');
        assert.equal(url.username + url.password, '');
        assert.match(link.detail, /^Find /);
        assert.doesNotMatch(link.detail, /Regional forecast for this peak/);
        assert.equal(url.searchParams.has('date'), false);
    }
    assert.match(resolve('United Kingdom').links[0].label, /SAIS \(Scotland\)/);
    assert.match(resolve('United Kingdom').links[0].detail, /Scotland/);
    assert.match(resolve('Australia').links[0].label, /^Backcountry conditions —/);
    assert.match(resolve('Australia').links[0].detail, /Victoria and New South Wales/);
    assert.equal(new URL(resolve('Japan').links[0].href).searchParams.get('locale'), 'ja');
});

test('aliases use exact country identities and border destinations deduplicate by provider', () => {
    for (const alias of ['USA', 'US', 'U.S.', 'U.S.A.', 'United States of America']) {
        assert.equal(resolve(alias).links[0].id, 'us');
    }
    for (const [alias, id] of [['Czechia', 'eaws'], ['Slovak Republic', 'eaws'],
        ['UK', 'gb'], ['U.K.', 'gb'], ['Great Britain', 'gb'], ['Scotland', 'gb'],
        ['Svalbard', 'no'], ['Svalbard and Jan Mayen', 'no']]) {
        assert.equal(resolve(alias).links[0].id, id);
    }
    assert.deepEqual(resolve('Canada / United States; USA').links.map(link => link.id), ['ca', 'us']);
    assert.deepEqual(resolve('France, Italy\nSwitzerland').links.map(link => link.id), ['eaws', 'ch']);
    assert.equal(resolve('France; Italy').unconfigured, false);
    for (const text of ['Chile', 'Mexico', '', 'United States of Atlantis',
        'Canada United States', 'Canada (maybe)', 'Canada,', 'Canada;;France', 'x'.repeat(801)]) {
        const result = resolve(text);
        assert.deepEqual(result.links, [], text);
        assert.equal(result.unconfigured, true);
    }
    assert.equal(resolve('Canada / Chile').unconfigured, true);
    assert.equal(resolve('Canada / Chile').links[0].id, 'ca');
});

test('India offers the DGRE directory without requiring current bulletins or asserting peak coverage', () => {
    const result = resolve(' India ', 30.92, 79.59);
    assert.equal(result.unconfigured, false);
    assert.equal(result.links.length, 1);
    assert.deepEqual(result.links[0], {
        id: 'in', kind: 'government', label: 'Avalanche forecasts — DGRE (India)',
        detail: 'Find avalanche warning bulletins for Indian Himalayan districts.',
        href: 'https://drdo.gov.in/drdo/en/documents/avalanche-warning-bulletin?page=0',
    });
    assert.equal(resolve('India / Nepal').unconfigured, true);
    assert.deepEqual(resolve('India / Nepal').links.map(link => link.id), ['in']);
    const dom = render({ rows: nationRow('India') });
    try {
        const panel = dom.window.document.querySelector('#bpb-peak-links');
        const anchor = [...panel.querySelectorAll('a')].find(link => /DGRE/.test(link.textContent));
        assert.equal(anchor.href, result.links[0].href);
        assert.equal(anchor.nextElementSibling.textContent, result.links[0].detail);
        assert.equal(anchor.rel, 'noopener noreferrer');
        assert.equal(anchor.target, '_blank');
        assert.doesNotMatch(panel.textContent, /No forecast source configured/);
        assert.equal(panel.querySelectorAll('a').length, 3);
    } finally {
        dom.window.close();
    }
});

test('Canada receives only navigation coordinates and EAWS receives bounded, unwrapped navigation boxes', () => {
    const canada = new URL(resolve('Canada', 49.850562, -123.004672).links[0].href);
    assert.deepEqual([...canada.searchParams], [['lat', '49.850562'], ['lng', '-123.004672']]);
    const europe = new URL(resolve('Austria', 47, 11).links[0].href);
    assert.deepEqual([...europe.searchParams], [['bbox', '10.700000,46.700000,11.300000,47.300000']]);
    for (const [lat, lon] of [[90, 0], [-90, 0], [0, 179.9], [0, -179.9], [0, 180], [0, -180]]) {
        assert.equal(resolve('Austria', lat, lon).links[0].href, 'https://www.avalanches.org/');
    }
    for (const latitude of [-84.9, 84.9]) {
        const bbox = new URL(resolve('Austria', latitude, 0).links[0].href).searchParams.get('bbox').split(',').map(Number);
        assert.ok(bbox[1] >= -85 && bbox[3] <= 85 && bbox[1] < bbox[3]);
    }
    for (const [lat, lon] of [[NaN, 0], [Infinity, 0], [91, 0], [0, -181], ['47', 11], [47, null]]) {
        assert.deepEqual(resolve('Canada', lat, lon), { links: [], unconfigured: true });
    }
});

test('the native Nation row must be unique and belong directly to the peak details table', () => {
    for (const rows of ['', nationRow('Canada') + nationRow('Canada'),
        nationRow('Canada') + nationRow('United States'),
        '<tr><td>Nation</td></tr>', '<tr><td>Nation</td><td>Canada</td><td>United States</td></tr>',
        nationRow('<table>' + nationRow('Canada') + '</table>'),
        '<tr><td colspan="2"><table>' + nationRow('Canada') + '</table></td></tr>']) {
        const dom = render({ rows, extra: '<table>' + nationRow('United States') + '</table>' });
        const panel = dom.window.document.querySelector('#bpb-peak-links');
        assert.match(panel.textContent, /No forecast source configured for this location/);
        assert.equal(panel.querySelectorAll('a').length, 2);
        assert.deepEqual(readPeakNations(dom.window.document.querySelector('#peak')), []);
        dom.window.close();
    }
    const dom = render({ rows: nationRow('<a>Canada</a><br><a>United States</a>')
        + '<tr><td colspan="2"><table>' + nationRow('France') + '</table></td></tr>' });
    assert.deepEqual(readPeakNations(dom.window.document.querySelector('#peak')), ['canada', 'united states']);
    assert.equal(dom.window.document.querySelectorAll('#bpb-peak-links a').length, 5);
    dom.window.close();
});

test('shipped links preserve native links and AirNow, remain local, safe and idempotent', () => {
    for (const country of ['Canada', 'USA', 'Canada<br>United States', 'France<br>Italy',
        'France<br>Switzerland', 'India', 'Australia', 'Canada / Chile']) {
        const dom = render({ rows: nationRow(country) });
        const doc = dom.window.document, panel = doc.querySelector('#bpb-peak-links');
        const native = doc.querySelector('#native').outerHTML;
        for (const anchor of panel.querySelectorAll('a')) {
            assert.equal(new URL(anchor.href).protocol, 'https:');
            assert.equal(anchor.target, '_blank');
            assert.equal(anchor.rel, 'noopener noreferrer');
            assert.doesNotMatch(anchor.href, /pid=|cid=|aid=|gpx|date=/i);
        }
        assert.equal(panel.querySelectorAll('iframe, img, script, link').length, 0);
        const before = panel.outerHTML;
        dom.window.eval(bundle);
        assert.equal(doc.querySelectorAll('#bpb-peak-links').length, 1);
        assert.equal(panel.outerHTML, before);
        assert.equal(doc.querySelector('#native').outerHTML, native);
        const airNow = [...panel.querySelectorAll('a')].find(anchor => anchor.textContent === 'AirNow fire & smoke');
        assert.equal(Boolean(airNow), /Canada|USA/.test(country));
        dom.window.close();
    }
});
