// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixtureDom } from '../helpers/fixture-dom.mts';
import { parsePeakId, readPeakDecimalCoordinate, readPeakElevationText } from '../../src/peakbagger/peak-page-fields.ts';
import { readPeakUnitSystem } from '../../src/peakbagger/peak-units.ts';
import { readPeakNations } from '../../src/avalanche/avalanche-location.ts';
import { readPeakWeatherSubject } from '../../src/weather/peak-weather-subject.ts';
import { readWeatherSubject, readWeatherSummit } from '../../src/ascent/ascent-weather-subject.ts';

const PROVISIONAL_URL = 'https://www.peakbagger.com/peak.aspx?pid=-34225';
const fixture = async (name: string): Promise<Document> =>
    fixtureDom(await readFile(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8'), { url: PROVISIONAL_URL }).window.document;
const cell = (html: string): Element => fixtureDom(`<table><tr><td>${html}</td></tr></table>`).window.document.querySelector('td');
const coordinateCell = (doc: Document) => [...doc.querySelectorAll('tr')]
    .find(row => row.cells[0]?.textContent?.trim() === 'Latitude/Longitude (WGS84)')!.cells[1];

test('peak ids admit main and provisional pids, never zero or malformed values', () => {
    assert.equal(parsePeakId('2296'), 2296);
    assert.equal(parsePeakId('-34225'), -34225);
    for (const value of [null, '', '0', '-0', '+5', '05', '-05', '1.5', '1e3', ' 5', '9007199254740993']) {
        assert.equal(parsePeakId(value), null, String(value));
    }
});

test('decimal coordinates come only from the labelled line, in either native order', () => {
    const main = readPeakDecimalCoordinate(cell("46.851731, -121.760395 (Dec Deg)<br>46° 51' 6'' N, 121° 45' 37'' W (DMS)<br>594502 E, 5189434 N, Zone 10 (UTM)"));
    assert.deepEqual(main, { latitude: 46.851731, longitude: -121.760395, latitudeText: '46.851731', longitudeText: '-121.760395' });
    const provisional = readPeakDecimalCoordinate(cell("47° 32' 56'' N, 120° 45' 5'' W<br/>47.548914, -120.751269 (Dec Deg)"));
    assert.deepEqual(provisional, { latitude: 47.548914, longitude: -120.751269, latitudeText: '47.548914', longitudeText: '-120.751269' });
    for (const html of [
        "47° 32' 56'' N, 120° 45' 5'' W 47.548914, -120.751269 (Dec Deg)", // no line break: DMS would lead
        '47.5, -120.7 (Dec Deg)<br>47.6, -120.8 (Dec Deg)',
        '47.5, -120.7', '91, 10 (Dec Deg)', '45, 181 (Dec Deg)', 'about 47.5, -120.7 (Dec Deg)',
    ]) assert.equal(readPeakDecimalCoordinate(cell(html)), null, html);
    assert.equal(readPeakDecimalCoordinate(null), null);
});

test('elevation text accepts the labelled heading or the bare provisional pair after the title', () => {
    const read = (html: string) => readPeakElevationText(fixtureDom(html).window.document);
    assert.equal(read('<h1>Mount Rainier</h1><h2>Elevation: 14,406.2 feet, 4391.0 meters</h2>'), '14,406.2 feet, 4391.0 meters');
    assert.equal(read('<h1>Icicle Buttress, Washington</h1><h2>2375 feet, 723.9 meters</h2>'), '2375 feet, 723.9 meters');
    assert.equal(read('<h1>Peak</h1><h2>723.9 m, 2,375 ft</h2>'), '723.9 m, 2,375 ft');
    for (const html of [
        '<h1>Peak</h1><p>x</p><h2>2375 feet, 723.9 meters</h2>', // not the title's own heading
        '<h1>Peak</h1><h1>Other</h1><h2>2375 feet, 723.9 meters</h2>',
        '<h1>Peak</h1><h2>Description: 2375 feet, 723.9 meters</h2>',
        '<h1>Peak</h1><h2>2375 feet</h2>', '<h1>Peak</h1><h2>2375 miles, 3822 km</h2>',
        '<h1>Peak</h1><h2>Elevation: 1 m</h2><h2>Elevation: 3 ft</h2>',
    ]) assert.equal(read(html), null, html);
});

test('the provisional fixture yields summit identity, coordinates, elevation, units and country', async () => {
    const doc = await fixture('peak-provisional');
    const subject = readPeakWeatherSubject(doc, PROVISIONAL_URL)!;
    assert.ok(subject, 'provisional peaks are weather subjects');
    assert.equal(subject.name, 'Icicle Buttress, Washington');
    assert.deepEqual([subject.latitude, subject.longitude, subject.elevation], [47.548914, -120.751269, 724]);
    assert.ok(subject.table.contains(doc.getElementById('Gmap')), 'the card row follows the native map table');
    assert.equal(readPeakUnitSystem(doc), 'imperial');
    assert.deepEqual(readPeakNations(coordinateCell(doc).closest('table')!), ['united states']);
    for (const url of ['https://www.peakbagger.com/peak.aspx?pid=-0', 'https://www.peakbagger.com/peak.aspx?pid=-34225&pid=-34225']) {
        assert.equal(readPeakWeatherSubject(doc, url), null, url);
    }
    assert.throws(() => readWeatherSummit(doc, { peak: { id: 34225, name: subject.name } }, PROVISIONAL_URL),
        /did not match/, 'the sign is part of the peak identity');
});

test('country rows still require one unambiguous native value', async () => {
    const doc = await fixture('peak-provisional');
    const table = coordinateCell(doc).closest('table')!;
    const country = [...table.rows].find(row => row.cells[0]?.textContent === 'Country')!;
    country.after(country.cloneNode(true));
    assert.deepEqual(readPeakNations(table), []);
    country.cells[0].textContent = 'Nation';
    assert.deepEqual(readPeakNations(table), [], 'a Nation row alongside Country is ambiguous');
});

test('a saved ascent of a provisional peak identifies and reads its negative-pid summit', async () => {
    const doc = fixtureDom(`<h1>Ascent of <a href="/peak.aspx?pid=-34225">Icicle Buttress</a></h1>
        <table><tr><td>Date:</td><td>2024-04-12</td></tr><tr><td>Peak:</td><td><a href="/peak.aspx?pid=-34225">Icicle Buttress</a></td></tr></table>`).window.document;
    const subject = readWeatherSubject(doc, 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321');
    assert.ok('peak' in subject, JSON.stringify(subject));
    assert.equal(subject.peak.id, -34225);
    assert.equal(subject.date, '2024-04-12');
    // The archive then fetches the summit page; its h1 adds ", Washington" to
    // the ascent's link text, and the signed pid must match.
    assert.deepEqual(readWeatherSummit(await fixture('peak-provisional'), subject, PROVISIONAL_URL),
        { latitude: 47.548914, longitude: -120.751269, elevation: 724 });
});
