// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { loadPage, PAGE_FIXTURES } from '../helpers/load-page.mjs';

// The built bundle (IIFE) stands in for the injected content script.
const source = await readFile(new URL('../../dist/content/peak-links.js', import.meta.url), 'utf8');

const loadPeak = fixture => loadPage(fixture, {
    url: 'https://www.peakbagger.com/Peak.aspx?pid=1',
    bundles: ['content/peak-links.js'],
    fixtures: PAGE_FIXTURES
});

const linkByText = (document, text) => Array.from(document.querySelectorAll('#bpb-peak-links a'))
    .find(anchor => anchor.textContent === text);

test('web map additions identify BPB, preserve native links and target the displayed peak', async () => {
    for (const fixture of ['peak-rainier.html', 'peak-garibaldi.html']) {
        const dom = await loadPeak(fixture);
        const doc = dom.window.document, group = doc.getElementById('bpb-peak-map-links');
        const coordinate = [...doc.querySelectorAll('tr')].find(row => row.cells[0]?.textContent.trim() === 'Latitude/Longitude (WGS84)')
            .cells[1].textContent.match(/^([\d.-]+), ([\d.-]+)/);
        const [, lat, lon] = coordinate;
        assert.equal(group.getAttribute('aria-label'), 'Maps added by Better Peakbagger');
        assert.equal(group.closest('tr').cells[0].textContent, 'Web Map Links');
        const nativeLinks = [...group.parentElement.querySelectorAll('a')].filter(link => !group.contains(link));
        assert.ok(nativeLinks.some(link => link.textContent === 'CalTopo'));
        const originalLinks = nativeLinks.map(link => link.outerHTML);
        const [gaia, alltrails, onx] = group.querySelectorAll('a');
        assert.deepEqual([gaia, alltrails, onx].map(link => link.textContent), ['Gaia GPS', 'AllTrails', 'onX Backcountry']);
        assert.equal(new URL(gaia.href).searchParams.get('loc'), `13/${lon}/${lat}`);
        assert.equal(new URL(onx.href).searchParams.get('latlon'), `${lat},${lon},13`);
        const bounds = new URL(alltrails.href).searchParams;
        assert.ok(Number(bounds.get('b_br_lat')) < Number(lat) && Number(bounds.get('b_tl_lat')) > Number(lat));
        assert.ok(Number(bounds.get('b_tl_lng')) < Number(lon) && Number(bounds.get('b_br_lng')) > Number(lon));
        for (const link of group.querySelectorAll('a')) {
            assert.equal(link.target, '_blank');
            assert.equal(link.rel, 'noopener noreferrer');
        }
        dom.window.eval(source);
        assert.equal(doc.querySelectorAll('#bpb-peak-map-links').length, 1);
        assert.deepEqual(nativeLinks.map(link => link.outerHTML), originalLinks);
        dom.window.close();
    }
});

test('web map additions work without general Links, clip geographic bounds and reject ambiguous rows', () => {
    for (const [lat, lon] of [[90, 180], [-90, -180], [0, 0]]) {
        const dom = new JSDOM(`<table><tr><td>Latitude/Longitude (WGS84)</td><td>${lat}, ${lon} (Dec Deg)</td></tr></table>
            <table class="gray" align="right"><tr><td>Web Map Links</td><td><a href="https://caltopo.com/">CalTopo</a></td></tr></table>`,
        { url: 'https://www.peakbagger.com/Peak.aspx?pid=1', runScripts: 'outside-only' });
        dom.window.eval(source);
        const group = dom.window.document.getElementById('bpb-peak-map-links');
        const bounds = new URL([...group.querySelectorAll('a')].find(link => link.textContent === 'AllTrails').href).searchParams;
        for (const key of ['b_tl_lat', 'b_br_lat']) assert.ok(Math.abs(Number(bounds.get(key))) <= 90);
        for (const key of ['b_tl_lng', 'b_br_lng']) assert.ok(Math.abs(Number(bounds.get(key))) <= 180);
        group.remove();
        const table = dom.window.document.querySelector('table[align]');
        table.rows[0].after(table.rows[0].cloneNode(true));
        dom.window.eval(source);
        assert.equal(dom.window.document.getElementById('bpb-peak-map-links'), null);
        dom.window.close();
    }
});

test('Peak.aspx gains location-specific Windy and Copernicus links', async () => {
    const cases = [
        {
            fixture: 'peak-rainier.html',
            lat: '46.851731',
            lon: '-121.760395',
            // United States also gains the AirNow link.
            expectedLinks: 4
        },
        {
            fixture: 'peak-garibaldi.html',
            lat: '49.850562',
            lon: '-123.004672',
            // Canada also gains the AirNow link.
            expectedLinks: 4
        }
    ];

    for (const { fixture, lat, lon, expectedLinks } of cases) {
        const dom = await loadPeak(fixture);
        const { document } = dom.window;
        const panel = document.getElementById('bpb-peak-links');
        assert.ok(panel, `${fixture} should receive the planning-links panel`);
        assert.equal(panel.getAttribute('aria-labelledby'), 'bpb-peak-links-heading');
        assert.equal(
            panel.querySelector('.bpb-peak-links__heading').textContent,
            'Better Peakbagger links'
        );
        assert.equal(panel.querySelectorAll('.bpb-peak-links__item').length, expectedLinks);
        const avalanche = linkByText(document, fixture === 'peak-rainier.html'
            ? 'Avalanche forecasts — Avalanche.org' : 'Avalanche forecasts — Avalanche Canada');
        assert.equal(avalanche.href, fixture === 'peak-rainier.html'
            ? 'https://avalanche.org/' : `https://avalanche.ca/map?lat=${lat}&lng=${lon}`);
        assert.equal(avalanche.nextElementSibling.textContent, 'Find the regional bulletin for this peak.');

        const windy = linkByText(document, 'Windy summit forecast');
        assert.equal(windy.href, `https://www.windy.com/${lat}/${lon}`);

        const copernicus = linkByText(document, 'Copernicus satellite imagery');
        assert.equal(
            copernicus.href,
            `https://browser.dataspace.copernicus.eu/?zoom=13&lat=${lat}&lng=${lon}&themeId=DEFAULT-THEME`
        );
        assert.equal(
            copernicus.parentElement.querySelector('.bpb-peak-links__detail').textContent,
            'Browse images by date and cloud cover, or choose Sentinel-2 in the map’s layer menu.'
        );

        const fireSmoke = linkByText(document, 'AirNow fire & smoke');
        assert.equal(fireSmoke.href, `https://fire.airnow.gov/#9/${lat}/${lon}`);
        assert.equal(linkByText(document, 'NOAA snow depth'), undefined);

        for (const anchor of [avalanche, windy, copernicus, fireSmoke]) {
            assert.equal(anchor.target, '_blank');
            assert.equal(anchor.rel, 'noopener noreferrer');
        }

        const linksHeading = Array.from(panel.closest('td').querySelectorAll('b'))
            .find(element => element.textContent.trim() === 'Links');
        assert.ok(linksHeading.compareDocumentPosition(panel) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
        dom.window.close();
    }
});

const renderNationPeak = nation => {
    const nationRow = nation === null
        ? ''
        : `<tr><td valign="top">Nation</td><td>${nation}</td></tr>`;
    const dom = new JSDOM(
        '<!doctype html><table>'
        + '<tr><td>Latitude/Longitude (WGS84)</td><td>40.0, -105.0 (Dec Deg)</td></tr>'
        + nationRow
        + '<tr><td colspan="2"><b>Links</b><br><br>Native links</td></tr>'
        + '</table>',
        { url: 'https://www.peakbagger.com/Peak.aspx?pid=1', runScripts: 'outside-only' }
    );
    dom.window.eval(source);
    return dom.window.document;
};

test('AirNow links follow the service coverage area', () => {
    const hasLink = (document, text) => Boolean(linkByText(document, text));

    const usa = renderNationPeak('United States');
    assert.ok(hasLink(usa, 'AirNow fire & smoke'), 'US peaks show fire & smoke');

    for (const nation of ['Canada', 'Mexico']) {
        const document = renderNationPeak(nation);
        assert.ok(hasLink(document, 'AirNow fire & smoke'), `${nation} shows fire & smoke`);
    }

    // Outside North America, and when the Nation row is missing, AirNow hides.
    for (const document of [renderNationPeak('France'), renderNationPeak(null)]) {
        assert.ok(!hasLink(document, 'AirNow fire & smoke'));
        // The universal links are always present.
        assert.ok(hasLink(document, 'Windy summit forecast'));
    }
});

const renderMinimalPeak = (coordinateValue, { includeLinks = true } = {}) => {
    const links = includeLinks ? '<tr><td colspan="2"><b>Links</b><br><br>Native links</td></tr>' : '';
    const dom = new JSDOM(`<!doctype html><table><tr><td>Latitude/Longitude (WGS84)</td><td>${coordinateValue}</td></tr>${links}</table>`, {
        url: 'https://www.peakbagger.com/Peak.aspx?pid=1',
        runScripts: 'outside-only'
    });
    dom.window.eval(source);
    return dom;
};

test('coordinate parsing fails closed for ambiguous, malformed, or out-of-range values', () => {
    for (const coordinate of [
        '46° 51\' 6\'\' N, 121° 45\' 37\'\' W (DMS)',
        'unknown (Dec Deg)',
        '91.0, -121.0 (Dec Deg)',
        '46.0, -181.0 (Dec Deg)',
        '46.0, -121.0 (Dec Deg) 47.0, -122.0 (Dec Deg)'
    ]) {
        const dom = renderMinimalPeak(coordinate);
        assert.equal(dom.window.document.getElementById('bpb-peak-links'), null, coordinate);
    }

    const missingLinks = renderMinimalPeak('46.0, -121.0 (Dec Deg)', { includeLinks: false });
    assert.equal(missingLinks.window.document.getElementById('bpb-peak-links'), null);

    const duplicateCoordinates = renderMinimalPeak('46.0, -121.0 (Dec Deg)');
    duplicateCoordinates.window.document.querySelector('table').insertAdjacentHTML(
        'afterbegin',
        '<tr><td>Latitude/Longitude (WGS84)</td><td>47.0, -122.0 (Dec Deg)</td></tr>'
    );
    duplicateCoordinates.window.document.getElementById('bpb-peak-links').remove();
    duplicateCoordinates.window.eval(source);
    assert.equal(duplicateCoordinates.window.document.getElementById('bpb-peak-links'), null);
});

test('integer coordinates keep Windy-required decimal parts and injection is idempotent', () => {
    const dom = renderMinimalPeak('46, -121 (Dec Deg)');
    dom.window.eval(source);

    assert.equal(dom.window.document.querySelectorAll('#bpb-peak-links').length, 1);
    assert.equal(
        linkByText(dom.window.document, 'Windy summit forecast').href,
        'https://www.windy.com/46.0/-121.0'
    );
});
