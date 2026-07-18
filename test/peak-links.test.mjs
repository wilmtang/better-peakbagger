// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadPage, PAGE_FIXTURES, DIST } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The built bundle (IIFE) stands in for the injected content script.
const source = await readFile(path.join(DIST, 'content', 'peak-links.js'), 'utf8');

const loadPeak = fixture => loadPage(fixture, {
    url: 'https://www.peakbagger.com/Peak.aspx?pid=1',
    bundles: ['content/peak-links.js'],
    fixtures: PAGE_FIXTURES
});

const linkByText = (document, text) => Array.from(document.querySelectorAll('#bpb-peak-links a'))
    .find(anchor => anchor.textContent === text);

test('Peak.aspx gains location-specific Windy and Copernicus links', async () => {
    const cases = [
        {
            fixture: 'peak-rainier.html',
            lat: '46.851731',
            lon: '-121.760395',
            // United States: also gains the NOAA snow depth and AirNow links.
            expectedLinks: 4
        },
        {
            fixture: 'peak-garibaldi.html',
            lat: '49.850562',
            lon: '-123.004672',
            // Canada: AirNow covers it, but NOHRSC snow does not.
            expectedLinks: 3
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

        const windy = linkByText(document, 'Windy summit forecast');
        assert.equal(windy.href, `https://www.windy.com/${lat}/${lon}`);

        const copernicus = linkByText(document, 'Copernicus satellite imagery');
        assert.equal(
            copernicus.href,
            `https://browser.dataspace.copernicus.eu/?zoom=13&lat=${lat}&lng=${lon}&themeId=DEFAULT-THEME`
        );

        const fireSmoke = linkByText(document, 'AirNow fire & smoke');
        assert.equal(fireSmoke.href, `https://fire.airnow.gov/#9/${lat}/${lon}`);

        for (const anchor of [windy, copernicus, fireSmoke]) {
            assert.equal(anchor.target, '_blank');
            assert.equal(anchor.rel, 'noopener noreferrer');
        }

        const linksHeading = Array.from(panel.closest('td').querySelectorAll('b'))
            .find(element => element.textContent.trim() === 'Links');
        assert.ok(linksHeading.compareDocumentPosition(panel) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    }
});

test('United States peaks gain a NOAA snow depth link with a summit-centered box', async () => {
    const dom = await loadPeak('peak-rainier.html');
    const { document } = dom.window;

    const snow = linkByText(document, 'NOAA snow depth');
    assert.ok(snow, 'Rainier should receive the NOAA snow depth link');
    assert.equal(
        snow.href,
        'https://www.nohrsc.noaa.gov/interactive/html/map.html?var=ssm_depth'
        + '&bgvar=dem&shdvar=shading'
        + '&min_x=-122.2304&min_y=46.5877&max_x=-121.2904&max_y=47.1157'
    );

    // Canada is outside NOHRSC coverage: no snow link.
    const canada = await loadPeak('peak-garibaldi.html');
    assert.equal(linkByText(canada.window.document, 'NOAA snow depth'), undefined);
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

test('country-specific links follow each service coverage area', () => {
    const hasLink = (document, text) => Boolean(linkByText(document, text));

    const usa = renderNationPeak('United States');
    assert.ok(hasLink(usa, 'NOAA snow depth'), 'US peaks show snow depth');
    assert.ok(hasLink(usa, 'AirNow fire & smoke'), 'US peaks show fire & smoke');

    for (const nation of ['Canada', 'Mexico']) {
        const document = renderNationPeak(nation);
        assert.ok(!hasLink(document, 'NOAA snow depth'), `${nation} hides snow depth`);
        assert.ok(hasLink(document, 'AirNow fire & smoke'), `${nation} shows fire & smoke`);
    }

    // Outside North America, and when the Nation row is missing, both hide.
    for (const document of [renderNationPeak('France'), renderNationPeak(null)]) {
        assert.ok(!hasLink(document, 'NOAA snow depth'));
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
        `46° 51' 6'' N, 121° 45' 37'' W (DMS)`,
        'unknown (Dec Deg)',
        '91.0, -121.0 (Dec Deg)',
        '46.0, -181.0 (Dec Deg)'
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
