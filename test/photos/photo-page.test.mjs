// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mjs';
import { photoProject as Project } from '../../src/photos/photo-project.js';

const html = await fs.readFile(new URL('../../photos/photos.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../../photos/photos.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../../photos/photos.css', import.meta.url), 'utf8');
const panelStyles = await fs.readFile(new URL('../../src/theme/panel.css', import.meta.url), 'utf8');
const dom = new JSDOM(html);
const doc = dom.window.document;
// The settings page is a separate document, so its section ids can only be
// checked against the photo page's deep links by parsing both.
const optionsHtml = await fs.readFile(new URL('../../options/options.html', import.meta.url), 'utf8');
const optionsDoc = new JSDOM(optionsHtml).window.document;
const guideHtml = await fs.readFile(new URL('../../photos/guide.html', import.meta.url), 'utf8');
const maintainedPhotoDocs = Object.fromEntries(await Promise.all([
    ['README.md', '../../README.md'],
    ['PRIVACY.md', '../../PRIVACY.md'],
    ['docs/architecture.md', '../../docs/architecture.md'],
    ['docs/photo-topo-editor.md', '../../docs/photo-topo-editor.md'],
].map(async ([name, relative]) => [
    name,
    await fs.readFile(new URL(relative, import.meta.url), 'utf8'),
])));

test('the packaged photo page exposes the editor, library, and credential boundaries', () => {
    const entry = ENTRIES.find(candidate => candidate.out === 'photos/photos.js');
    assert.deepEqual(entry?.sources, [
        'settings/settings-schema.js',
        'settings/settings.js',
        'photos/photo-project.js',
        'photos/photo-renderer.js',
        'photos/photo-library.js',
        'photos/photo-store.js',
        'photos/photo-archive.js',
        'photos/imgbb-client.js',
        'photos/photo-report-size.js',
        'photos/photo-upload-transaction.js',
        'photos-main.js',
    ]);
    assert.ok(COPY_FILES.some(([from, to]) =>
        from === 'photos/photos.html' && to === 'photos/photos.html'));
    assert.ok(COPY_FILES.some(([from, to]) =>
        from === 'photos/photos.css' && to === 'photos/photos.css'));
    assert.equal(doc.querySelector('script[src="photos.js"]')?.hasAttribute('defer'), true);
    assert.deepEqual([...doc.querySelectorAll('script')].map(node => node.getAttribute('src')),
        ['photos-head.js', 'photos.js'],
        'the extension page must not use inline scripts, and must resolve its theme first');
    // The head bundle runs before the stylesheet so the stored Light/Dark
    // preference is on the root element before anything can paint.
    const head = doc.querySelector('script[src="photos-head.js"]');
    assert.equal(head.hasAttribute('defer'), false);
    assert.equal(head.compareDocumentPosition(doc.querySelector('link[rel="stylesheet"]'))
        & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.deepEqual(ENTRIES.find(candidate => candidate.out === 'photos/photos-head.js')?.sources,
        ['settings/settings-schema.js', 'settings/settings.js', 'theme/panel-theme.js'],
        'the photo page must reuse the shared panel theme bootstrap');
});

// The photo editor and Settings each used to own a :root palette, and they
// drifted into two different-looking products — cool grey and blue against warm
// grey and green. The panel design language now has one home, loaded first by
// every extension page; a page stylesheet that re-declares a token has started
// a third.
test('every extension panel paints from the one shared design language', async () => {
    assert.ok(COPY_FILES.some(([from, to]) =>
        from === 'src/theme/panel.css' && to === 'css/panel.css'));
    for (const page of [doc, new JSDOM(await fs.readFile(
        new URL('../../photos/guide.html', import.meta.url), 'utf8')).window.document, optionsDoc]) {
        assert.deepEqual(
            [...page.querySelectorAll('link[rel="stylesheet"]')].map(node => node.getAttribute('href'))[0],
            '../css/panel.css',
            'the shared stylesheet loads before the page stylesheet that overrides it');
    }
    assert.doesNotMatch(styles, /:root\[data-bpb-theme/);
    assert.doesNotMatch(styles, /^\s*--(bg|card|border|text|sub|accent|link|danger|shadow):/m);

    // Both mapping blocks pick from one palette, so an explicit preference and
    // the OS scheme cannot drift apart.
    assert.match(panelStyles, /:root\[data-bpb-theme="dark"\]\s*\{[^}]*--bg:\s*var\(--dark-bg\)/);
    assert.match(panelStyles, /:root\[data-bpb-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
    assert.match(panelStyles,
        /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-bpb-theme="light"\]\)/);
    assert.match(panelStyles,
        /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
        'author layout rules must not override the native hidden state');
});

test('the API key is a password field and upload remains one explicit primary action', () => {
    const key = doc.getElementById('imgbb-key');
    assert.equal(key.type, 'password');
    assert.equal(key.autocomplete, 'off');
    assert.match(doc.getElementById('credential-note').textContent,
        /never exposed to\s+Peakbagger, another website, GitHub, browser sync, or status UI/i);
    assert.match(doc.getElementById('credential-note').textContent,
        /packaged photo page for the direct ImgBB upload/i);
    assert.equal(doc.getElementById('remove-key').textContent.trim(), 'Forget for this tab');
    assert.equal(doc.getElementById('upload-insert').textContent.trim(), 'Upload and insert');
    assert.equal(doc.querySelectorAll('#upload-insert').length, 1);
});

test('report sizing is contextual, synchronized, and explicit about full-resolution upload', () => {
    const controls = [...doc.querySelectorAll('[data-report-width-control]')];
    const selects = [...doc.querySelectorAll('[data-report-width]')];
    assert.equal(controls.length, 2, 'Editor and Library each expose the same insertion choice');
    assert.equal(selects.length, 2);
    assert.ok(controls.every(control => control.hidden),
        'the choice stays out of Photo Topos unless a report is waiting');
    assert.ok(controls.every(control => /upload stays full resolution/i.test(control.textContent)));
    assert.match(source, /ReportSize\.displayWidth\(inserting\.export\.width, reportImageWidth\)/);
    assert.match(source, /ReportSize\.displayWidth\(item\.export\.width, reportImageWidth\)/);
    assert.match(source, /\{ displayWidth \}/);
});

test('all planned topo tools and accessible editor controls are present', () => {
    assert.deepEqual(
        [...doc.querySelectorAll('[data-tool]')].map(button => button.dataset.tool),
        ['select', 'route', 'bolt', 'anchor', 'piton', 'rappel', 'belay', 'pitch', 'text'],
    );
    for (const id of [
        'photo-file',
        'photo-title',
        'photo-alt',
        'photo-viewport',
        'photo-overlay',
        'finish-route',
        'object-color',
        'object-opacity',
        'object-rotation',
        'route-width',
        'route-width-value',
        'route-stroke',
        'route-arrow',
        'route-smooth',
        'object-scale',
        'object-scale-value',
        'pitch-number',
        'object-text',
        'text-align',
        'label-background',
        'library-search',
        'library-filter',
        'import-project',
        'photo-backup-status',
        'backup-library',
    ]) assert.ok(doc.getElementById(id), id);
    assert.equal(doc.getElementById('photo-viewport').tabIndex, 0);
    assert.ok(doc.getElementById('editor-status').hasAttribute('aria-live'));
});

test('history actions use recognizable mirrored icons with accessible names', () => {
    const undo = doc.getElementById('undo');
    const redo = doc.getElementById('redo');
    assert.equal(undo.getAttribute('aria-label'), 'Undo');
    assert.equal(redo.getAttribute('aria-label'), 'Redo');
    assert.equal(undo.textContent.trim(), '');
    assert.equal(redo.textContent.trim(), '');
    assert.equal(undo.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
    assert.equal(redo.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
    assert.notEqual(
        undo.querySelector('path')?.getAttribute('d'),
        redo.querySelector('path')?.getAttribute('d'),
        'undo and redo should point in opposite directions',
    );
});

test('every climbing symbol is painted from the renderer and reachable by keyboard', () => {
    // A hand-drawn glyph on the button is a symbol that can disagree with the
    // one the export paints, so the marker tools declare a slot the page fills
    // from photo-renderer instead of carrying their own artwork.
    const symbolTools = [...doc.querySelectorAll('[data-tool]')]
        .filter(button => button.querySelector('[data-symbol]'))
        .map(button => button.dataset.tool);
    assert.deepEqual(symbolTools, [...Project.MARKER_TYPES]);
    for (const button of doc.querySelectorAll('[data-tool] [data-symbol]')) {
        assert.equal(button.dataset.symbol, button.closest('[data-tool]').dataset.tool);
        assert.equal(button.childElementCount, 0, 'the slot must be filled at runtime');
    }
    // The rail's own hints are what the page reads to build its shortcut map,
    // so a key printed on a button is always a key that arms it.
    const keys = [...doc.querySelectorAll('[data-tool]')].map(button => ({
        tool: button.dataset.tool,
        key: button.querySelector('kbd')?.textContent.trim().toLowerCase(),
        title: button.getAttribute('title'),
    }));
    assert.ok(keys.every(entry => entry.key?.length === 1), 'every tool needs a shortcut hint');
    assert.equal(new Set(keys.map(entry => entry.key)).size, keys.length, 'shortcuts must be unique');
    assert.ok(keys.every(entry => entry.title), 'every tool needs a plain-language title');
});

test('placing a symbol leaves its tool armed and the route shows its first point', () => {
    // Reverting to Select after one symbol made a pitch of protection a
    // click-a-tool-per-mark chore; Esc is the documented way back out.
    assert.doesNotMatch(source, /setTool\('select'\);\s*\n\s*if \(type === 'text'\)/);
    assert.match(source, /activeTool !== 'select'\) setTool\('select'\)/);
    assert.match(source, /renderRoutePreview/);
    // An armed placement tool must not have its click taken by the vertex
    // handles of the route the user just drew, which is exactly where the
    // belays and bolts go.
    assert.match(source, /activeTool === 'select' && selected\?\.type === 'route'/);
    assert.match(source, /activeTool === 'select' \? event\.target\.closest\?\.\('\[data-vertex\]'\) : null/);
    // The curve is an intent on the style, not handles the editor has to
    // rebuild, so adding a point cannot silently drop it.
    assert.match(source, /const style = object \? object\.style : styleDefaults/);
    assert.match(source, /ui\.routeSmooth\.checked = style\.smooth/);
    assert.doesNotMatch(source, /routeHasCurves/);
});

test('a downloaded project can come back in, and a duplicate cannot claim one asset twice', () => {
    const input = doc.getElementById('import-project');
    assert.equal(input.type, 'file');
    assert.match(input.accept, /\.bpb-photo/);
    // Reuniting a bundle with its own id is the point — that is how a restored
    // GitHub record finds its pixels — but two records must never end up
    // claiming one published ImgBB asset.
    assert.match(source, /readProjectArchive/);
    assert.match(source, /existing \? crypto\.randomUUID\(\) : imported\.localId/);
    assert.match(source, /sha256 !== project\.image\.sourceSha256/);
    assert.match(source, /Project\.matchingImageDimensions\(project\.image, imported\.source\)/);
    assert.match(source, /Project\.matchingImageDimensions\(project\.image, bitmap\)/);
    assert.match(source, /Archive\.projectArchiveSize/);
    assert.match(source, /archiveBytes > Archive\.MAX_ARCHIVE_BYTES/);
});

test('the photo chooser states decode bounds separately from provider and project limits', () => {
    assert.match(doc.querySelector('#editor-empty .fine-print').textContent,
        /64 MP and 16,384 px per side/);
    assert.match(doc.querySelector('#editor-empty .fine-print').textContent,
        /ImgBB decides upload size/);
    assert.doesNotMatch(doc.querySelector('#editor-empty .fine-print').textContent, /32 MB/);
    assert.match(source, /above the 40 MiB project limit/);
});

test('maintained photo documentation separates decode, upload, and project-archive bounds', () => {
    for (const [name, contents] of Object.entries(maintainedPhotoDocs)) {
        assert.match(contents, /64 megapixels/i, `${name} must state the decoded-pixel budget`);
        assert.match(contents, /16,384 pixels/i, `${name} must state the per-axis budget`);
        assert.match(contents, /40 MiB/i, `${name} must state the project-bundle budget`);
        assert.match(contents, /ImgBB.{0,40}(?:applies|decides)/i,
            `${name} must leave the upload-size decision with ImgBB`);
        assert.doesNotMatch(contents,
            /images follow ImgBB's 32 MiB|refuses source or export blobs over 32 MiB|through exactly 32 MiB/i,
            `${name} must not restore the obsolete local upload limit`);
    }
});

test('every public photo surface states the exact saved-key disclosure boundary', () => {
    const surfaces = {
        ...maintainedPhotoDocs,
        'photos/photos.html': html,
        'photos/guide.html': guideHtml,
        'options/options.html': optionsHtml,
    };
    for (const [name, contents] of Object.entries(surfaces)) {
        const normalized = contents.replace(/\s+/g, ' ');
        assert.match(normalized, /saved key remains in device-local extension storage/i,
            `${name} must say where the saved key remains`);
        assert.match(normalized,
            /never exposed to Peakbagger, another website, GitHub, browser sync, or status UI/i,
            `${name} must name every excluded consumer`);
        assert.match(normalized, /exact packaged photo page/i,
            `${name} must name the only extension-page recipient`);
        assert.match(normalized, /direct (?:ImgBB )?upload(?: to ImgBB)?/i,
            `${name} must explain why that photo page receives the key`);
        assert.doesNotMatch(normalized, /no page can read it back|neither page can read a saved key back/i,
            `${name} must not restore the false disclosure`);
    }
});

test('page orchestration avoids page-owned storage sync and raw HTML assignment', () => {
    assert.doesNotMatch(source, /storage\.sync/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
    assert.doesNotMatch(source, /from ['"]jszip['"]/);
    assert.match(source, /PHOTO_IMGBB_LEASE_KEY/);
    assert.match(source, /PHOTO_INSERT_COMMIT/);
    assert.match(source, /Settings\.set\(\{ reportImageWidth: choice\.width \}\)/);
    assert.match(source, /outcome-unknown/);
    assert.match(source, /GITHUB_PHOTOS_BACKUP/);
    // Settings owns the same device-local key, so this page cannot keep
    // reporting the state it read when the tab first loaded.
    assert.match(source, /window\.addEventListener\('focus'[\s\S]{0,240}refreshCredential\(\)/);
});

test('GitHub recovery copy states the metadata-only boundary beside its actions', () => {
    const card = doc.querySelector('.backup-card');
    assert.match(card.textContent, /photo-library\.json/);
    assert.match(card.textContent, /Original images, API keys, and remote deletion links stay on this device/);
    assert.equal(card.querySelector('#photo-backup-settings').getAttribute('href'),
        '../options/options.html#github-photos-backup');
    // The library keeps the one action worth having while looking at photos.
    // Restore replaces local records and the automatic toggle is a stored
    // preference, so both belong with every other backup, in Settings.
    assert.ok(card.querySelector('#backup-library'));
    assert.equal(doc.getElementById('restore-library'), null);
    assert.equal(doc.getElementById('auto-backup-library'), null);
    assert.ok(optionsDoc.getElementById('photos-restore'));
    assert.ok(optionsDoc.getElementById('photos-auto-backup'));
    // Restoring is preview-first in an in-page panel, not a confirm() the
    // browser can suppress after the first one.
    assert.equal(optionsDoc.getElementById('photos-restore-confirmation').hidden, true);
    assert.match(optionsDoc.getElementById('github-photos-backup').textContent,
        /does not store the images themselves, your ImgBB API key, or the links that delete/);
});

test('settings deep links land on section ids the settings page actually defines', () => {
    // A fragment that names nothing scrolls nowhere: the browser silently
    // leaves the reader at the top of Settings instead of the control the
    // link promised. Resolve every link so renaming a section breaks a test
    // rather than the navigation.
    const targets = [...doc.querySelectorAll('a[href]')]
        .map(link => link.getAttribute('href'))
        .filter(href => !/^[a-z][a-z0-9+.-]*:/i.test(href))
        .map(href => ({ href, id: /^(?:\.{1,2}\/)*options\/options\.html#(.+)$/.exec(href)?.[1] }))
        .filter(target => target.id);
    assert.ok(targets.length, 'the photo page should deep-link into the settings page');
    for (const { href, id } of targets) {
        assert.ok(optionsDoc.getElementById(id),
            `${href} points at a section id options.html does not define`);
    }
});
