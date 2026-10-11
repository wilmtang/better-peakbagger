import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { strictWeatherDate, readWeatherSubject, readWeatherSummit } from '../../src/ascent/ascent-weather-subject.js';

const ascentUrl = 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321';
const fixture = async name => new JSDOM(await readFile(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8')).window.document;

test('only complete calendar dates are admitted', () => {
    assert.equal(strictWeatherDate('Sunday, July 12, 2026'), '2026-07-12');
    assert.equal(strictWeatherDate('Feb 29, 2024'), '2024-02-29');
    for (const value of ['2024', 'July 2024', '2024-00-00', '2024-13-01', '2024-02-31', 'Feb 29, 2023', 'Julyyyyy 12, 2024', '2024-01-01 or 2024-01-02']) assert.equal(strictWeatherDate(value), null, value);
});

test('subject is independent of GPX and ownership, and ignores report peak links', async () => {
    const doc = await fixture('climber-ascent');
    doc.querySelector('#gpxlinks').remove(); doc.querySelector('#owneractions').remove();
    doc.querySelector('#reportcell a').href = '/peak.aspx?pid=999';
    const subject = readWeatherSubject(doc, ascentUrl);
    assert.equal(subject.date, '2026-07-12'); assert.equal(subject.peak.id, 2296);
});

test('missing or conflicting authoritative evidence fails closed', async () => {
    const doc = await fixture('climber-ascent');
    doc.querySelector('h1').insertAdjacentHTML('beforeend', '<a href="/peak.aspx?pid=999">Wrong peak</a>');
    assert.match(readWeatherSubject(doc, ascentUrl).reason, /identified safely/);
    doc.querySelector('h1').remove();
    assert.ok(readWeatherSubject(doc, ascentUrl).reason);
    assert.ok(readWeatherSubject(doc, ascentUrl + '&aid=4').reason);
    doc.querySelector('#ascentinfo tr').remove();
    doc.querySelector('#reportcell').textContent = 'Date: July 12, 2024';
    assert.ok(readWeatherSubject(doc, ascentUrl).reason);
});

test('summit metadata requires matching native name, URL and labelled WGS84 row', async () => {
    const doc = await fixture('peak-rainier');
    const subject = { peak: { id: 2296, name: 'Mount Rainier' } };
    const url = 'https://www.peakbagger.com/peak.aspx?pid=2296';
    const summit = readWeatherSummit(doc, subject, url);
    assert.equal(summit.latitude, 46.851731); assert.equal(summit.longitude, -121.760395);
    assert.equal(summit.nation, 'united states'); assert.equal(summit.elevation, 4391);
    assert.throws(() => readWeatherSummit(doc, subject, url.replace('2296', '999')), /match/);
    doc.querySelector('h1').textContent = 'Different mountain';
    assert.throws(() => readWeatherSummit(doc, subject, url), /match/);
});
