// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The saved ascent page reader extracts what the GitHub backup surface needs
// from ascent.aspx. These tests drive it against the masked ascent fixture,
// pinning the ownership gate (fail closed), peak/aid/GPX extraction, and the
// best-effort display-page date fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { ascentPage as AscentPage } from '../src/ascent-page.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadDoc = async () => {
    const html = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-ascent.html'), 'utf8');
    return new JSDOM(html).window.document;
};

test('read extracts the ascent identity, peak, GPX link, and date', async () => {
    const doc = await loadDoc();
    const info = AscentPage.read({ doc, search: '?aid=7654321' });
    assert.equal(info.ascentId, 7654321);
    assert.equal(info.isOwner, true);
    assert.match(info.editUrl, /ascentedit\.aspx\?aid=7654321/i);
    assert.deepEqual(info.peak, { id: 2296, name: 'Mount Rainier' });
    assert.equal(info.date, '2026-07-12');
    assert.match(info.gpxUrl, /GPXFile\.aspx\?aid=7654321&sep=1/);
});

test('the GPX link is found by its href even when the link text is reworded', async () => {
    const doc = await loadDoc();
    // A future rewording that no longer prefix-matches "Download this GPS track".
    doc.querySelector('a[href*="GPXFile.aspx"]').textContent = 'Get the track';
    const info = AscentPage.read({ doc, search: '?aid=7654321' });
    assert.match(info.gpxUrl, /GPXFile\.aspx\?aid=7654321&sep=1/);
});

test('ownership fails closed without an edit link for this ascent', async () => {
    const doc = await loadDoc();
    // A visitor viewing someone else's ascent has no edit link.
    doc.querySelector('a[href*="ascentedit.aspx"]').remove();
    assert.equal(AscentPage.ownsAscent(doc, 7654321), false);
    const info = AscentPage.read({ doc, search: '?aid=7654321' });
    assert.equal(info.isOwner, false);
});

test('an edit link for a different ascent does not confer ownership', async () => {
    const doc = await loadDoc();
    doc.querySelector('a[href*="ascentedit.aspx"]').setAttribute('href', '/climber/ascentedit.aspx?aid=999');
    assert.equal(AscentPage.ownsAscent(doc, 7654321), false);
});

test('missing aid yields a null ascent id and no ownership', async () => {
    const doc = await loadDoc();
    const info = AscentPage.read({ doc, search: '' });
    assert.equal(info.ascentId, null);
    assert.equal(info.isOwner, false);
});
