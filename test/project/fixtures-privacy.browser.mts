/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fixture privacy checks that need a real parser: the structure of the
// decoded XML fixtures and the reviewed synthetic rows of the table fixtures.
// fixtures-privacy.test.mts keeps the checkout-wide text scans.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FORBIDDEN_XML_ELEMENTS, XML_FIXTURES } from '../helpers/fixture-privacy-xml.mts';

const MASKED_CLIMBER_ID = '900001';

// The fixture's text as fixtures-privacy.test.mts decodes it: base64 of gzip
// of UTF-8 for an encoded GPX, otherwise UTF-8.
const decodedXml = async (relative: string) => {
    const bytes = await readFile(new URL(`../fixtures/${relative}`, import.meta.url)) as Uint8Array;
    if (!relative.endsWith('.gz.b64')) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const binary = atob(new TextDecoder().decode(bytes).replaceAll(/\s/g, ''));
    const gzip = Uint8Array.from(binary, character => character.charCodeAt(0));
    const stream = new Blob([gzip]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new TextDecoder('utf-8', { fatal: true }).decode(await new Response(stream).arrayBuffer());
};

test('encoded XML fixtures decode to sanitized, well-formed XML', async () => {
    assert.ok(XML_FIXTURES.some(relative => relative.endsWith('.gpx.gz.b64')),
        'expected the encoded GPX fixture to be decoded and inspected');
    for (const relative of XML_FIXTURES) {
        const document = new DOMParser().parseFromString(await decodedXml(relative), 'application/xml');
        assert.equal(document.querySelector('parsererror'), null,
            `${relative} must decode to valid XML`);
        if (/\.gpx(\.gz\.b64)?$/.test(relative)) {
            assert.equal(document.documentElement.localName, 'gpx',
                `${relative} must decode to GPX`);
        }
        assert.equal(document.documentElement.hasAttribute('creator'), false,
            `${relative} retains creator metadata`);
        for (const tag of FORBIDDEN_XML_ELEMENTS) {
            assert.equal(document.getElementsByTagNameNS('*', tag).length, 0,
                `${relative} retains forbidden <${tag}> data`);
        }
    }
});

test('the Buddy List fixture contains only the reviewed synthetic row data', async () => {
    const html = await readFile(new URL('../fixtures/pages/report-buddy-list.html', import.meta.url), 'utf8');
    const document = new DOMParser().parseFromString(html, 'text/html');
    const rows = [...document.querySelectorAll<HTMLTableRowElement>('#RGridView tr')].slice(1);
    assert.equal(rows.length, 6);

    const values = (column: number) => rows.map(row => row.cells[column].textContent!.trim());
    assert.deepEqual(values(0), [
        'Alpine, Casey', 'Example, Rowan', 'Fixture, Sol',
        'Mock, Quinn', 'Sample, Juniper', 'Synthetic, Arden'
    ]);
    assert.deepEqual(values(2), [
        '2021-03-14', '2024-11-02', '2019-07-28',
        '2023-01-09', '2020-05-21', '2025-08-30'
    ]);
    assert.deepEqual(values(3), [
        'Granite Point', 'Juniper Dome', 'Echo Ridge',
        'Fiction Peak', 'Northwind Hill', 'Placeholder Butte'
    ]);
    assert.deepEqual(values(5), [
        'Test Range-North', 'Example Basin-West', 'Sample County-East',
        'Mock Range-South', 'Fixture District-Central', 'Synthetic Province-North'
    ]);

    for (const row of rows) {
        assert.match(row.cells[0].querySelector<HTMLAnchorElement>('a')!.href, /[?&]cid=710\d{3}$/);
        assert.match(row.cells[1].querySelector<HTMLAnchorElement>('a')!.href, /[?&]cid=710\d{3}&sort=AscentDateD$/);
        assert.match(row.cells[2].querySelector<HTMLAnchorElement>('a')!.href, /[?&]aid=810\d{3}$/);
        assert.match(row.cells[3].querySelector<HTMLAnchorElement>('a')!.href, /[?&]pid=610\d{3}$/);
    }
});

test('the Peak List fixture contains only the reviewed synthetic row data', async () => {
    const html = await readFile(new URL('../fixtures/pages/list-peak-list.html', import.meta.url), 'utf8');
    const document = new DOMParser().parseFromString(html, 'text/html');
    const table = document.querySelector<HTMLTableElement>('table.gray');
    assert.ok(table);
    const rows = [...table.rows].filter(row => row.cells.length === 8 && row.cells[0].tagName === 'TD');
    assert.equal(rows.length, 5);

    const values = (column: number) => rows.map(row => row.cells[column].textContent!.trim());
    assert.deepEqual(values(1), [
        'Juniper Dome', 'Alpine Point', 'Placeholder Butte', 'Echo Ridge', 'Fiction Peak'
    ]);
    assert.deepEqual(values(3), [
        'Example Basin', 'Test Range', 'Mock Highlands', 'Sample Mountains', 'Synthetic Range'
    ]);
    assert.deepEqual(values(5), [
        'North County', 'West County', 'Central District', 'East County', 'South County'
    ]);
    assert.deepEqual(values(7), [
        '2018', '2019-06-09', '2021-09', '2023-01-09', '2025-08-30'
    ]);

    const expectedPeakIds = ['610104', '610101', '610105', '610102', '610103'];
    for (const [index, row] of rows.entries()) {
        assert.match(row.cells[1].querySelector<HTMLAnchorElement>('a')!.href, new RegExp(`[?&]pid=${expectedPeakIds[index]}$`));
        assert.match(row.cells[7].querySelector<HTMLAnchorElement>('a')!.href, /[?&]aid=81010\d$/);
    }
    const climberIds = [...html.matchAll(/[?&]cid=(\d+)/g)].map(match => match[1]);
    assert.ok(climberIds.length > 0);
    assert.ok(climberIds.every(cid => cid === MASKED_CLIMBER_ID));
});
