// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';
import { photoUploadTransaction as Transaction } from '../../src/photos/photo-upload-transaction.js';

const NOW = '2026-07-30T12:00:00.000Z';
const LATER = '2026-07-30T12:01:00.000Z';
const SOURCE_HASH = 'a'.repeat(64);
const EXPORT_HASH = 'b'.repeat(64);

const uploadedPhoto = () => {
    const draft = Library.createDraft({
        localId: 'photo-1',
        title: 'North face',
        alt: 'Topo line',
        source: {
            fileName: 'north-face.jpg',
            mime: 'image/jpeg',
            bytes: 9,
            width: 1600,
            height: 1200,
            sha256: SOURCE_HASH,
        },
        now: NOW,
    });
    return Library.completeUpload(draft, {
        mime: 'image/jpeg',
        bytes: 8,
        width: 1600,
        height: 1200,
        sha256: EXPORT_HASH,
    }, {
        providerId: 'provider-1',
        url: 'https://i.ibb.co/a/topo.jpg',
        displayUrl: 'https://i.ibb.co/a/topo.jpg',
        viewerUrl: 'https://ibb.co/provider-1',
        thumbnailUrl: 'https://i.ibb.co/a/thumb.jpg',
        mediumUrl: null,
        uploadedAt: NOW,
        expiresAt: null,
    }, NOW);
};

const operation = {
    operationId: 'operation-1',
    localId: 'photo-1',
    state: 'catalog-committed',
    returnToken: 'return-1',
};

const inserted = {
    ok: true,
    identity: { cid: 10, aid: 20, pid: 30 },
};

test('a failed report insertion preserves the committed upload', async () => {
    const photo = uploadedPhoto();
    const writes = [];
    await assert.rejects(Transaction.finishCommittedUpload({
        store: {
            putPhoto: async value => writes.push(value),
            deleteOperation: async () => {},
        },
        operation,
        photo,
        insert: async () => ({ ok: false }),
        now: () => LATER,
    }), error => error.code === 'not-inserted' && /uploaded and saved in the library/.test(error.message));
    assert.equal(photo.remote.state, 'uploaded');
    assert.equal(photo.remote.url, 'https://i.ibb.co/a/topo.jpg');
    assert.equal(photo.export.sha256, EXPORT_HASH);
    assert.deepEqual(writes, []);
});

test('reference persistence failure cannot downgrade a committed upload', async () => {
    const photo = uploadedPhoto();
    let deleted = false;
    await assert.rejects(Transaction.finishCommittedUpload({
        store: {
            putPhoto: async () => { throw new Error('quota'); },
            deleteOperation: async () => { deleted = true; },
        },
        operation,
        photo,
        insert: async () => inserted,
        now: () => LATER,
    }), error => error.code === 'reference-pending' && /uploaded and inserted/.test(error.message));
    assert.equal(photo.remote.state, 'uploaded');
    assert.equal(photo.remote.url, 'https://i.ibb.co/a/topo.jpg');
    assert.equal(deleted, false, 'the journal stays available to repair the reference');
});

test('journal cleanup failure preserves success and recovery does not duplicate its reference', async () => {
    const writes = [];
    const first = await Transaction.finishCommittedUpload({
        store: {
            putPhoto: async value => writes.push(value),
            deleteOperation: async () => { throw new Error('cleanup blocked'); },
        },
        operation,
        photo: uploadedPhoto(),
        insert: async () => inserted,
        now: () => LATER,
    });
    assert.equal(first.photo.remote.state, 'uploaded');
    assert.equal(first.photo.references.length, 1);
    assert.equal(first.cleanupPending, true);

    let deleted = false;
    const recovered = await Transaction.finishCommittedUpload({
        store: {
            putPhoto: async value => writes.push(value),
            deleteOperation: async () => { deleted = true; },
        },
        operation,
        photo: first.photo,
        insert: async () => inserted,
        now: () => '2026-07-30T12:02:00.000Z',
    });
    assert.equal(recovered.photo.references.length, 1);
    assert.equal(writes.length, 1, 'recovery must not append the same report reference twice');
    assert.equal(deleted, true);
});
