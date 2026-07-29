// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { photoArchive as Archive } from '../../src/photos/photo-archive.js';

test('builds a CSP-safe project archive with the original and JSON sidecars', async () => {
    const project = { schemaVersion: 1, localId: 'photo-1' };
    const photo = { schemaVersion: 1, localId: 'photo-1', title: 'North face' };
    const original = new Blob(['original bytes'], { type: 'image/png' });
    const archive = await Archive.createProjectArchive({
        project,
        photo,
        original,
        modifiedAt: new Date('2026-07-27T18:00:00Z'),
    });

    assert.equal(archive.type, 'application/zip');
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    assert.deepEqual(Object.keys(zip.files).sort(), [
        'original.png',
        'photo.json',
        'project.json',
    ]);
    assert.deepEqual(JSON.parse(await zip.file('project.json').async('text')), project);
    assert.deepEqual(JSON.parse(await zip.file('photo.json').async('text')), photo);
    assert.equal(await zip.file('original.png').async('text'), 'original bytes');
});

test('rejects duplicate or unsafe names instead of emitting an ambiguous archive', async () => {
    await assert.rejects(Archive.createStoredZip([
        { name: 'same.txt', data: 'one' },
        { name: 'same.txt', data: 'two' },
    ]), /unique safe/);
    await assert.rejects(Archive.createStoredZip([
        { name: '../secret.txt', data: 'no' },
    ]), /unique safe/);
});
