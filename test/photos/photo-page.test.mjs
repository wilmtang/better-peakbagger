// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mjs';

const html = await fs.readFile(new URL('../../photos/photos.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../../photos/photos.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../../photos/photos.css', import.meta.url), 'utf8');
const dom = new JSDOM(html);
const doc = dom.window.document;
// The settings page is a separate document, so its section ids can only be
// checked against the photo page's deep links by parsing both.
const optionsHtml = await fs.readFile(new URL('../../options/options.html', import.meta.url), 'utf8');
const optionsDoc = new JSDOM(optionsHtml).window.document;

test('the packaged photo page exposes the editor, library, and credential boundaries', () => {
    const entry = ENTRIES.find(candidate => candidate.out === 'photos/photos.js');
    assert.deepEqual(entry?.sources, [
        'photos/photo-project.js',
        'photos/photo-renderer.js',
        'photos/photo-library.js',
        'photos/photo-store.js',
        'photos/photo-archive.js',
        'photos/imgbb-client.js',
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
    // Both mapping blocks pick from one palette, so an explicit preference and
    // the OS scheme cannot drift apart.
    assert.match(styles, /:root\[data-bpb-theme="dark"\]\s*\{[^}]*--bg:\s*var\(--dark-bg\)/);
    assert.match(styles, /:root\[data-bpb-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
    assert.match(styles,
        /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-bpb-theme="light"\]\)/);
    assert.match(styles,
        /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
        'author layout rules must not override the native hidden state');
});

test('the API key is a password field and upload remains one explicit primary action', () => {
    const key = doc.getElementById('imgbb-key');
    assert.equal(key.type, 'password');
    assert.equal(key.autocomplete, 'off');
    assert.match(doc.getElementById('credential-note').textContent, /never synced, backed up, or sent/i);
    assert.equal(doc.getElementById('upload-insert').textContent.trim(), 'Upload and insert');
    assert.equal(doc.querySelectorAll('#upload-insert').length, 1);
});

test('all planned topo tools and accessible editor controls are present', () => {
    assert.deepEqual(
        [...doc.querySelectorAll('[data-tool]')].map(button => button.dataset.tool),
        ['select', 'route', 'anchor', 'piton', 'rappel', 'belay', 'pitch', 'text'],
    );
    for (const id of [
        'photo-file',
        'photo-title',
        'photo-alt',
        'photo-viewport',
        'photo-overlay',
        'finish-route',
        'object-color',
        'route-width',
        'route-stroke',
        'route-arrow',
        'route-smooth',
        'object-scale',
        'pitch-number',
        'object-text',
        'text-align',
        'label-background',
        'library-search',
        'library-filter',
        'photo-backup-status',
        'backup-library',
        'restore-library',
        'auto-backup-library',
    ]) assert.ok(doc.getElementById(id), id);
    assert.equal(doc.getElementById('photo-viewport').tabIndex, 0);
    assert.ok(doc.getElementById('editor-status').hasAttribute('aria-live'));
});

test('page orchestration avoids page-owned storage sync and raw HTML assignment', () => {
    assert.doesNotMatch(source, /storage\.sync/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
    assert.doesNotMatch(source, /from ['"]jszip['"]/);
    assert.match(source, /PHOTO_IMGBB_LEASE_KEY/);
    assert.match(source, /PHOTO_INSERT_COMMIT/);
    assert.match(source, /outcome-unknown/);
    assert.match(source, /GITHUB_PHOTOS_BACKUP/);
    assert.match(source, /GITHUB_PHOTOS_RESTORE_PREVIEW/);
    assert.match(source, /autoPhotoLibraryBackup/);
    // Settings owns the same device-local key, so this page cannot keep
    // reporting the state it read when the tab first loaded.
    assert.match(source, /window\.addEventListener\('focus'[\s\S]{0,240}refreshCredential\(\)/);
});

test('GitHub recovery copy states the metadata-only boundary beside its actions', () => {
    const card = doc.querySelector('.backup-card');
    assert.match(card.textContent, /photo-library\.json/);
    assert.match(card.textContent, /Original images, API keys, and remote deletion links stay on this device/);
    assert.equal(card.querySelector('#photo-backup-settings').getAttribute('href'),
        '../options/options.html#github');
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
