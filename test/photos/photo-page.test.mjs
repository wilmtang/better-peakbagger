// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { COPY_FILES, ENTRIES } from '../../scripts/build-config.mjs';

const html = await fs.readFile(new URL('../../photos/photos.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../../photos/photos.js', import.meta.url), 'utf8');
const dom = new JSDOM(html);
const doc = dom.window.document;

test('the packaged photo page exposes the editor, library, and credential boundaries', () => {
    const entry = ENTRIES.find(candidate => candidate.out === 'photos/photos.js');
    assert.deepEqual(entry?.sources, [
        'photos/photo-project.js',
        'photos/photo-renderer.js',
        'photos/photo-library.js',
        'photos/photo-store.js',
        'photos/imgbb-client.js',
        'photos-main.js',
    ]);
    assert.ok(COPY_FILES.some(([from, to]) =>
        from === 'photos/photos.html' && to === 'photos/photos.html'));
    assert.ok(COPY_FILES.some(([from, to]) =>
        from === 'photos/photos.css' && to === 'photos/photos.css'));
    assert.equal(doc.querySelector('script[src="photos.js"]')?.hasAttribute('defer'), true);
    assert.equal(doc.querySelectorAll('script').length, 1, 'the extension page must not use inline scripts');
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
    assert.match(source, /PHOTO_IMGBB_LEASE_KEY/);
    assert.match(source, /PHOTO_INSERT_COMMIT/);
    assert.match(source, /outcome-unknown/);
    assert.match(source, /GITHUB_PHOTOS_BACKUP/);
    assert.match(source, /GITHUB_PHOTOS_RESTORE_PREVIEW/);
    assert.match(source, /autoPhotoLibraryBackup/);
});

test('GitHub recovery copy states the metadata-only boundary beside its actions', () => {
    const card = doc.querySelector('.backup-card');
    assert.match(card.textContent, /photo-library\.json/);
    assert.match(card.textContent, /Original images, API keys, and remote deletion links stay on this device/);
    assert.equal(card.querySelector('#photo-backup-settings').getAttribute('href'),
        '../options/options.html#backup');
});
