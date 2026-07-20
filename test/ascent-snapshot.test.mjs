// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The save-time snapshot serializer is the one place that knows Peakbagger's
// ascentedit.aspx field names. These tests drive it against the masked
// ascentedit fixture (so the mapped names really exist in the form) plus the
// editor's report, pinning the field mapping, date normalization, gear/type
// extraction from the ASP.NET list controls, peak identity, and the match key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { ascentSnapshot as Snapshot } from '../src/ascent-snapshot.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadForm = async () => {
    const html = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-ascentedit.html'), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const form = doc.getElementById('Form1') || doc.querySelector('form');
    return { dom, doc, form };
};
const setValue = (form, name, value) => { const el = form.elements[name]; if (el) el.value = value; };
const addCompanionRows = form => {
    const table = form.ownerDocument.getElementById('OthersTable');
    const registered = table.insertRow();
    registered.insertCell().innerHTML = '<a href="/climber/Climber.aspx?cid=900101">Jan Doe</a>';
    registered.insertCell().innerHTML = '<input type="button" value="Remove">';
    const other = table.insertRow();
    other.insertCell().textContent = 'Sample Hiking Club';
    other.insertCell().innerHTML = '<input type="button" value="Remove">';
};

test('normalizeDate handles Peakbagger M/D/YYYY, partials, and ISO input', () => {
    assert.equal(Snapshot.normalizeDate('7/12/2026'), '2026-07-12');
    assert.equal(Snapshot.normalizeDate('12/3/2026'), '2026-12-03');
    assert.equal(Snapshot.normalizeDate('7/2026'), '2026-07-00');
    assert.equal(Snapshot.normalizeDate('2026'), '2026-00-00');
    assert.equal(Snapshot.normalizeDate('2026-07-12'), '2026-07-12');
    assert.equal(Snapshot.normalizeDate('  '), '');
});

test('build maps the ascentedit form fields into the backup snapshot', async () => {
    const { form } = await loadForm();
    setValue(form, 'DateText', '7/12/2026');
    setValue(form, 'GainFt', '9000');
    setValue(form, 'LossFt', '9000');
    setValue(form, 'UpMi', '8');
    setValue(form, 'DnMi', '8');
    setValue(form, 'StartFt', '5400');
    setValue(form, 'EndFt', '5400');
    setValue(form, 'PointFt', '14411');
    setValue(form, 'RouteUp', 'Disappointment Cleaver');
    setValue(form, 'RouteDn', 'Emmons Glacier');
    setValue(form, 'URLTB', 'https://example.com/trip');
    setValue(form, 'OthersText', 'unfinished search text');
    setValue(form, 'WeatherText', 'Clouds lifted at noon');
    setValue(form, 'PrecipDD', '1');
    setValue(form, 'TempDD', '4');
    setValue(form, 'WindDD', '2');
    setValue(form, 'VisDD', '1');
    addCompanionRows(form);
    setValue(form, 'UpHr', '7'); setValue(form, 'UpMin', '30');
    // The first gear item, whatever the fixture lists it as.
    const gear0 = form.elements['GearCheckBoxList$0'];
    gear0.checked = true;
    const gear0Label = form.ownerDocument.querySelector('label[for="GearCheckBoxList_0"]').textContent.trim();

    const params = new URLSearchParams('cid=900001&pid=2296');
    const { snapshot, identity, key } = Snapshot.build({
        form, params,
        report: { markdown: '**Great**' },
        extensionVersion: '2.2.0',
    });

    assert.equal(snapshot.ascent.id, null);            // a new ascent has no aid yet
    assert.equal(snapshot.ascent.date, '2026-07-12');
    assert.equal(snapshot.ascent.gainFt, '9000');
    assert.equal(snapshot.ascent.distanceUpMi, '8');
    assert.equal(snapshot.ascent.pointFt, '14411');
    assert.equal(snapshot.ascent.route, 'Disappointment Cleaver');
    assert.equal(snapshot.ascent.routeDown, 'Emmons Glacier');
    assert.equal(snapshot.ascent.externalUrl, 'https://example.com/trip');
    assert.equal(snapshot.ascent.timeUp, '7:30');
    assert.deepEqual(snapshot.ascent.companions, {
        registered: [{ id: 900101, name: 'Jan Doe' }],
        others: 'Sample Hiking Club',
    });
    assert.deepEqual(snapshot.ascent.weather, {
        precip: 'No Precipitation',
        temperature: 'Cold',
        wind: 'Breezy',
        visibility: 'Clear',
        description: 'Clouds lifted at noon',
    });
    // The default-checked ascent type radio yields its human label.
    assert.match(snapshot.ascent.type, /Successful/);
    assert.deepEqual(snapshot.ascent.gear, [gear0Label]);
    // Peak falls back to the URL pid when no peak is selected in the list box.
    assert.equal(snapshot.peak.id, 2296);
    // The resolved Markdown body passes through.
    assert.deepEqual(snapshot.report, { markdown: '**Great**' });
    assert.equal(snapshot.backup.extensionVersion, '2.2.0');

    assert.deepEqual(identity, { climberId: 900001, ascentId: null, peakId: 2296, date: '2026-07-12' });
    assert.equal(key, '900001|2296|2026-07-12');
});

test('a selected peak in the list box wins over the URL pid', async () => {
    const { doc, form } = await loadForm();
    const select = form.elements['PeakListBox'];
    const option = doc.createElement('option');
    option.value = '1234';
    option.textContent = 'Glacier Peak';
    select.appendChild(option);
    select.value = '1234';

    const params = new URLSearchParams('cid=900001&pid=2296');
    const { snapshot } = Snapshot.build({ form, params, report: {} });
    assert.equal(snapshot.peak.id, 1234);
    assert.equal(snapshot.peak.name, 'Glacier Peak');
});

test('an edited ascent carries its aid and an empty report yields an empty body', async () => {
    const { form } = await loadForm();
    setValue(form, 'DateText', '2026-07-12');
    const params = new URLSearchParams('cid=900001&aid=555&pid=2296');
    const { snapshot, identity } = Snapshot.build({ form, params, report: {} });
    assert.equal(snapshot.ascent.id, 555);
    assert.equal(identity.ascentId, 555);
    assert.deepEqual(snapshot.report, { markdown: '' });
});

test('the zero-valued weather placeholders are omitted from snapshots', async () => {
    const { form } = await loadForm();
    const { snapshot } = Snapshot.build({
        form,
        params: new URLSearchParams('cid=900001&aid=555&pid=2296'),
    });
    assert.deepEqual(snapshot.ascent.weather, {
        precip: '', temperature: '', wind: '', visibility: '', description: '',
    });
});
