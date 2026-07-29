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

test('reads back exactly what it wrote, so a downloaded project can return', async () => {
    const project = { schemaVersion: 1, localId: 'photo-1', objects: [] };
    const photo = {
        schemaVersion: 1,
        localId: 'photo-1',
        title: 'North face',
        source: { mime: 'image/jpeg' },
    };
    const original = new Blob([new Uint8Array([137, 80, 78, 71, 0, 255, 12])], { type: 'image/jpeg' });
    const archive = await Archive.createProjectArchive({ project, photo, original });

    const read = await Archive.readProjectArchive(archive);
    assert.deepEqual(read.project, project);
    assert.deepEqual(read.photo, photo);
    assert.equal(read.original.type, 'image/jpeg');
    assert.deepEqual(new Uint8Array(await read.original.arrayBuffer()),
        new Uint8Array(await original.arrayBuffer()));
});

test('the reader refuses a bundle it cannot honestly reopen', async () => {
    // Compressed entries would need a decompressor in the extension bundle,
    // and a re-zipped copy is the common way a user produces one.
    const deflated = await new JSZip()
        .file('project.json', '{}')
        .generateAsync({ type: 'blob', compression: 'DEFLATE' });
    await assert.rejects(Archive.readProjectArchive(deflated), /compressed/);

    await assert.rejects(Archive.readProjectArchive(new Blob(['not a zip at all'])),
        /not a Better Peakbagger project bundle/);
    await assert.rejects(Archive.readProjectArchive(new Blob([])), /empty or larger/);

    // Missing members are named rather than surfacing a parse failure.
    const partial = await Archive.createStoredZip([{ name: 'project.json', data: '{}' }]);
    await assert.rejects(Archive.readProjectArchive(partial), /missing photo\.json/);
    const noImage = await Archive.createStoredZip([
        { name: 'project.json', data: '{}' },
        { name: 'photo.json', data: '{}' },
    ]);
    await assert.rejects(Archive.readProjectArchive(noImage), /missing its original image/);

    // A flipped byte inside the stored payload has to fail its checksum rather
    // than import a corrupt original as if it were the real photo.
    const good = await Archive.createProjectArchive({
        project: { schemaVersion: 1 },
        photo: { schemaVersion: 1 },
        original: new Blob(['pixels'], { type: 'image/png' }),
    });
    const bytes = new Uint8Array(await good.arrayBuffer());
    const payload = [...'pixels'].map(character => character.charCodeAt(0));
    // The stored copy of the payload, not the 'p' that starts project.json in
    // an earlier header: only a byte inside the entry's data affects its CRC.
    const offset = bytes.findIndex((_byte, index) =>
        payload.every((code, step) => bytes[index + step] === code));
    assert.ok(offset > 0);
    bytes[offset] ^= 0xff;
    await assert.rejects(Archive.readProjectArchive(new Blob([bytes])), /checksum/);
});
