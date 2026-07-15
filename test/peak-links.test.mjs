// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadPage, PAGE_FIXTURES } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'src', 'peak-links.js'), 'utf8');

const loadPeak = fixture => loadPage(fixture, {
    url: 'https://www.peakbagger.com/Peak.aspx?pid=1',
    scripts: ['src/peak-links.js'],
    fixtures: PAGE_FIXTURES
});

const linkByText = (document, text) => Array.from(document.querySelectorAll('#bpb-peak-links a'))
    .find(anchor => anchor.textContent === text);

test('Peak.aspx gains location-specific Windy and Copernicus links', async () => {
    const cases = [
        {
            fixture: 'peak-rainier.html',
            lat: '46.851731',
            lon: '-121.760395'
        },
        {
            fixture: 'peak-garibaldi.html',
            lat: '49.850562',
            lon: '-123.004672'
        }
    ];

    for (const { fixture, lat, lon } of cases) {
        const dom = await loadPeak(fixture);
        const { document } = dom.window;
        const panel = document.getElementById('bpb-peak-links');
        assert.ok(panel, `${fixture} should receive the planning-links panel`);
        assert.equal(panel.getAttribute('aria-labelledby'), 'bpb-peak-links-heading');
        assert.equal(
            panel.querySelector('.bpb-peak-links__heading').textContent,
            'Better Peakbagger links'
        );
        assert.equal(panel.querySelectorAll('.bpb-peak-links__item').length, 2);

        const windy = linkByText(document, 'Windy summit forecast');
        assert.equal(windy.href, `https://www.windy.com/${lat}/${lon}`);

        const copernicus = linkByText(document, 'Copernicus satellite imagery');
        assert.equal(
            copernicus.href,
            `https://browser.dataspace.copernicus.eu/?zoom=13&lat=${lat}&lng=${lon}&themeId=DEFAULT-THEME`
        );

        for (const anchor of [windy, copernicus]) {
            assert.equal(anchor.target, '_blank');
            assert.equal(anchor.rel, 'noopener noreferrer');
        }

        const linksHeading = Array.from(panel.closest('td').querySelectorAll('b'))
            .find(element => element.textContent.trim() === 'Links');
        assert.ok(linksHeading.compareDocumentPosition(panel) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
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
