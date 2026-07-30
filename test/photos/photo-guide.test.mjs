// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mjs';
import { photoProject as Project } from '../../src/photos/photo-project.js';

const html = await fs.readFile(new URL('../../photos/guide.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../../photos/guide.js', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;
const manifest = JSON.parse(await fs.readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
const photosHtml = await fs.readFile(new URL('../../photos/photos.html', import.meta.url), 'utf8');
const photosDoc = new JSDOM(photosHtml).window.document;
const photosSource = await fs.readFile(new URL('../../photos/photos.js', import.meta.url), 'utf8');
const optionsHtml = await fs.readFile(new URL('../../options/options.html', import.meta.url), 'utf8');
const reportEditor = await fs.readFile(
    new URL('../../src/reports/report-editor.js', import.meta.url), 'utf8');

test('the guide ships as a packaged page with no inline script', () => {
    assert.ok(COPY_FILES.some(([from, to]) =>
        from === 'photos/guide.html' && to === 'photos/guide.html'));
    assert.deepEqual(ENTRIES.find(entry => entry.out === 'photos/guide.js')?.sources,
        ['photos/photo-project.js', 'photos/photo-renderer.js', 'ui/section-nav.js', 'photos-guide.js']);
    assert.deepEqual([...doc.querySelectorAll('script')].map(node => node.getAttribute('src')),
        ['photos-head.js', 'guide.js'],
        'no inline script, and the theme resolves before the stylesheet paints');
    assert.equal(doc.querySelector('script[src="photos-head.js"]').hasAttribute('defer'), false);
    assert.equal(doc.querySelector('script[src="guide.js"]').hasAttribute('defer'), true);
    // The trip-report popover links here from a Peakbagger page, and a browser
    // refuses that navigation unless the page is web-accessible from it.
    const entry = manifest.web_accessible_resources
        .find(record => record.resources.includes('photos/guide.html'));
    assert.ok(entry, 'the guide must be reachable from a Peakbagger tab');
    assert.deepEqual(entry.matches, ['https://*.peakbagger.com/*']);
});

// The guide used to swap the tab set for "Back / Open the editor / Settings",
// so the reader could not see which view they were in or return to the one they
// left. Every Photo Topos page now shows the same three views, in order, with
// the current one marked.
test('every photo page shows the same view tabs, marking the current one', () => {
    const tabs = node => [...node.querySelectorAll('.view-tabs .tab-button')]
        .map(control => control.textContent.trim());
    assert.deepEqual(tabs(doc), ['Editor', 'Library', 'Guide']);
    assert.deepEqual(tabs(photosDoc), ['Editor', 'Library', 'Guide']);
    assert.equal(doc.querySelector('.view-tabs [aria-current="page"]')?.textContent.trim(), 'Guide');
    assert.equal(photosDoc.querySelector('.view-tabs [aria-current="page"]')?.textContent.trim(), 'Editor');
    assert.equal(doc.querySelector('.view-tabs').getAttribute('aria-label'),
        photosDoc.querySelector('.view-tabs').getAttribute('aria-label'),
        'one component, one accessible name');
    // The guide's Editor and Library tabs must land on the view they name, and
    // photos.js reads exactly this parameter to open on the library.
    assert.deepEqual([...doc.querySelectorAll('.view-tabs .tab-button')]
        .map(link => link.getAttribute('href')),
    ['photos.html', 'photos.html?mode=library', 'guide.html']);
    assert.match(photosSource, /searchParams\.get\('mode'\) === 'library'/);
    // Nothing may reintroduce a page-specific action into the tab set.
    assert.equal(doc.getElementById('guide-back'), null);
    assert.doesNotMatch(source, /guide-back/);
});

// A wrapped block of links above the prose was a contents list the reader
// scrolled away from and could not use to tell where they were.
test('the contents list is a sidebar that tracks the section being read', () => {
    const items = [...doc.querySelectorAll('.side-nav .nav-item')];
    const sections = [...doc.querySelectorAll('.content section[id]')];
    assert.equal(items.length, sections.length, 'one contents entry per section');
    assert.deepEqual(items.map(link => link.getAttribute('href').slice(1)),
        sections.map(section => section.id),
        'the contents list must follow the guide in document order');
    for (const link of items) {
        const heading = doc.getElementById(link.getAttribute('href').slice(1)).querySelector('h2');
        assert.equal(link.textContent.trim(), heading.textContent.trim(),
            'a contents entry must read as the heading it goes to');
    }
    // The shared scroll-spy is inert unless it finds both of these.
    assert.ok(doc.querySelector('.side-nav'));
    assert.ok(doc.querySelector('.content'));
    assert.match(source, /initSectionNav\(\)/);
    assert.equal(doc.querySelector('.guide-toc'), null, 'the old chip cloud is gone');
});

test('the legend is painted from the renderer, once per symbol', () => {
    assert.match(source, /markerSymbolSvg/);
    const legend = [...doc.querySelectorAll('.guide-legend [data-symbol]')]
        .map(node => node.dataset.symbol);
    assert.deepEqual(legend, [...Project.MARKER_TYPES],
        'every marker tool needs an entry, and the guide must not invent one');
    for (const node of doc.querySelectorAll('[data-symbol]')) {
        assert.equal(node.childElementCount, 0, 'the slot is filled at runtime, not authored');
    }
});

test('every anchor in the guide resolves to a heading it actually has', () => {
    const ids = new Set([...doc.querySelectorAll('[id]')].map(node => node.id));
    const internal = [...doc.querySelectorAll('a[href^="#"]')]
        .map(link => link.getAttribute('href').slice(1));
    assert.ok(internal.length >= 10, 'the contents list should cover the guide');
    for (const target of internal) assert.ok(ids.has(target), `#${target} names nothing`);
    for (const link of doc.querySelectorAll('a[href^="http"]')) {
        assert.equal(link.target, '_blank');
        assert.equal(link.rel, 'noopener noreferrer', link.href);
    }
});

test('the guide answers the questions the surfaces send readers here with', () => {
    const text = doc.body.textContent.replace(/\s+/g, ' ');
    // Getting a key, which is the one piece of setup the feature cannot do.
    assert.match(text, /api\.imgbb\.com/);
    assert.match(text, /Get API key/);
    assert.match(text, /never synced between browsers, never included in a backup/);
    // What a backup holds, and what a restore therefore cannot bring back.
    assert.match(text, /photo-library\.json/);
    assert.match(text, /the images themselves — GitHub holds the record, not the picture/);
    // Deletion: local removal is not remote deletion, and the remote path is
    // deliberately effortful rather than hidden.
    assert.match(text, /does not touch the image on ImgBB/);
    assert.match(text, /It is meant to take deliberate effort/);
    // The direct-URL path, whose two failure modes are silent in a saved report.
    assert.match(text, /Google Photos/);
    assert.match(text, /allow other sites to display it|lets other sites/);
});

test('each surface links to the guide rather than restating it', () => {
    assert.ok(photosDoc.querySelector('.view-tabs a[href="guide.html"]'));
    assert.ok(photosDoc.querySelector('#credential-note a[href="guide.html#key"]'));
    assert.match(optionsHtml, /href="\.\.\/photos\/guide\.html"/);
    assert.match(optionsHtml, /href="\.\.\/photos\/guide\.html#backup"/);
    assert.match(reportEditor, /getURL\?\.\('photos\/guide\.html'\)/);
});
