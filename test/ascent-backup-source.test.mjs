// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pins the shared Peakbagger read boundary used by both individual and profile
// GitHub backups. These tests deliberately exercise the masked owner edit form,
// response-body classification, and the one constructed GPX endpoint.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { ascentBackupSource as Source } from '../src/ascent-backup-source.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

const editHtml = await readFile(new URL('./fixtures/pages/climber-ascentedit.html', import.meta.url), 'utf8');

const editDocument = () => new JSDOM(editHtml).window.document;

test('the shared edit-form reader builds one complete raw snapshot with safe list fallbacks', () => {
    const doc = editDocument();
    const form = doc.getElementById('Form1');
    form.elements.GainFt.value = '4200';
    form.elements.JournalText.value = '[b]Exact persisted report[/b]';

    const result = Source.snapshotFromEditDocument({
        doc,
        editUrl: 'https://www.peakbagger.com/climber/AscentEdit.aspx?aid=7654321',
        ascentId: 7654321,
        peakId: 2296,
        climberId: 900001,
        fallbackDate: '2026-07-12',
        fallbackPeakName: 'Mount Rainier',
        extensionVersion: '3.0.0',
    });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot.ascent.id, 7654321);
    assert.equal(result.snapshot.ascent.date, '2026-07-12');
    assert.equal(result.snapshot.ascent.gainFt, '4200');
    assert.deepEqual(result.snapshot.peak, { id: 2296, name: 'Mount Rainier' });
    assert.match(result.snapshot.report.markdown, /\*\*Exact persisted report\*\*/);
    assert.deepEqual(result.identity, {
        climberId: 900001,
        ascentId: 7654321,
        peakId: 2296,
        date: '',
    });
});

test('the shared edit-form reader rejects incomplete forms and identity mismatches', () => {
    const incomplete = Source.snapshotFromEditDocument({
        doc: new JSDOM('<form id="Form1"></form>').window.document,
        editUrl: 'https://www.peakbagger.com/climber/AscentEdit.aspx?aid=1',
        ascentId: 1,
    });
    assert.deepEqual(incomplete, {
        ok: false,
        code: 'incomplete',
        reason: 'The ascent edit form was incomplete.',
    });

    const doc = editDocument();
    const selected = doc.createElement('option');
    selected.value = '875';
    selected.textContent = 'Mount Garibaldi';
    doc.getElementById('PeakListBox').append(selected);
    selected.selected = true;
    const mismatch = Source.snapshotFromEditDocument({
        doc,
        editUrl: 'https://www.peakbagger.com/climber/AscentEdit.aspx?aid=7654321',
        ascentId: 7654321,
        peakId: 2296,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'identity');
});

test('the shared fetch reader uses the signed-in session and validates response bodies', async () => {
    let request = null;
    const fetchFn = async (url, init) => {
        request = { url, init };
        return {
            status: 200,
            url,
            redirected: false,
            headers: { get: name => (/content-type/i.test(name) ? 'application/gpx+xml' : null) },
            text: async () => '<?xml version="1.0"?><gpx version="1.1"><trk/></gpx>',
        };
    };
    const ok = await Source.fetchPeakbaggerResource('https://www.peakbagger.com/climber/GPXFile.aspx?aid=7&sep=1', {
        kind: 'gpx',
        fetchFn,
    });
    assert.equal(ok.kind, 'ok');
    assert.equal(request.init.credentials, 'include');
    assert.equal(request.init.redirect, 'follow');
    assert.equal(request.init.cache, 'no-store');
    assert.ok(request.init.signal instanceof AbortSignal);

    const wrong = await Source.fetchPeakbaggerResource('https://www.peakbagger.com/climber/GPXFile.aspx?aid=7&sep=1', {
        kind: 'gpx',
        fetchFn: async _url => ({
            status: 200,
            url: 'https://www.peakbagger.com/PBError.aspx',
            redirected: true,
            headers: { get: () => 'text/html' },
            text: async () => '<html><title>Error - Peakbagger.com</title></html>',
        }),
    });
    assert.equal(wrong.kind, 'wrong-content');
    assert.equal(wrong.redirected, true);
    assert.equal('text' in wrong, false, 'rejected response bodies must not escape the source boundary');
});

test('the shared full-profile GPX URL matches Peakbagger current download link', () => {
    const url = new URL(Source.storedGpxUrl({
        origin: 'https://www.peakbagger.com',
        ascentId: 7654321,
    }));
    assert.equal(url.pathname, '/climber/GPXFile.aspx');
    assert.equal(url.searchParams.get('aid'), '7654321');
    assert.equal(url.searchParams.get('sep'), '1');
    assert.equal(Source.storedGpxUrl({ origin: 'https://www.peakbagger.com', ascentId: 0 }), null);
});
