// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAvalancheLinks } from '../../src/avalanche/avalanche-links.ts';
import { parsePeakNations } from '../../src/avalanche/avalanche-location.ts';

const resolve = (text: string, latitude: unknown = 46.85, longitude: unknown = -121.76) =>
    resolveAvalancheLinks({ nations: parsePeakNations(text), latitude, longitude });

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
        const bounds = new URL(resolve('Austria', latitude, 0).links[0].href).searchParams.get('bbox');
        assert.ok(bounds);
        const bbox = bounds.split(',').map(Number);
        assert.ok(bbox[1] >= -85 && bbox[3] <= 85 && bbox[1] < bbox[3]);
    }
    for (const [lat, lon] of [[NaN, 0], [Infinity, 0], [91, 0], [0, -181], ['47', 11], [47, null]]) {
        assert.deepEqual(resolve('Canada', lat, lon), { links: [], unconfigured: true });
    }
});
