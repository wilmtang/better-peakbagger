// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The saved ascent page reader extracts what the GitHub backup surface needs
// from ascent.aspx. These tests drive it against the masked ascent fixture,
// pinning the ownership gate (fail closed), peak/aid/GPX extraction, the
// best-effort date, and the DOM→Markdown report fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { ascentPage as AscentPage } from '../src/ascent-page.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ascent-page imports report-markup, which reads the global DOMParser; marked is
// unused here (no Markdown parsing) but harmless to provide.
const shell = new JSDOM('');
globalThis.DOMParser = shell.window.DOMParser;
const markedContext = vm.createContext({});
vm.runInContext(await readFile(new URL('../node_modules/marked/lib/marked.umd.js', import.meta.url), 'utf8'), markedContext);
globalThis.marked = markedContext.marked;

const loadDoc = async () => {
    const html = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-ascent.html'), 'utf8');
    return new JSDOM(html).window.document;
};

test('read extracts the ascent identity, peak, GPX link, and date', async () => {
    const doc = await loadDoc();
    const info = AscentPage.read({ doc, search: '?aid=7654321' });
    assert.equal(info.ascentId, 7654321);
    assert.equal(info.isOwner, true);
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

test('the report is converted to Markdown from the page DOM for the fallback path', async () => {
    const doc = await loadDoc();
    const md = AscentPage.reportMarkdown(doc);
    assert.match(md, /\*\*Great climb\*\*/);
    assert.match(md, /\*rope team\*/);
    assert.match(md, /- Ice axe/);
    assert.match(md, /\[peak page\]\(https:\/\/peakbagger\.com\/peak\.aspx\?pid=2296\)/);
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
