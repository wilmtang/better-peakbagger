// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { photoProject as Project } from '../../src/photos/photo-project.js';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';
import { photoStore as Store } from '../../src/photos/photo-store.js';

const TIME = '2026-07-27T18:00:00.000Z';
const LATER = '2026-07-27T18:10:00.000Z';
const HASH = 'a'.repeat(64);
const EXPORT_HASH = 'b'.repeat(64);

const fixture = () => {
    const photo = Library.createDraft({
        localId: 'photo-1',
        title: 'North face topo',
        alt: 'North face route',
        source: {
            fileName: 'north.jpg',
            mime: 'image/jpeg',
            bytes: 10,
            width: 1600,
            height: 1200,
            sha256: HASH,
        },
        now: TIME,
    });
    const project = Project.createProject({
        localId: photo.localId,
        width: 1600,
        height: 1200,
        sourceSha256: HASH,
        updatedAt: TIME,
    });
    return {
        photo,
        project,
        original: new Blob(['original'], { type: 'image/jpeg' }),
        thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
    };
};

test('persists and retrieves a matching photo, project, original, and thumbnail atomically', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-bundle',
    });
    const input = fixture();
    await store.putDraft(input);
    const bundle = await store.getBundle('photo-1');
    assert.deepEqual(bundle.photo, input.photo);
    assert.deepEqual(bundle.project, input.project);
    assert.equal(await bundle.original.text(), 'original');
    assert.equal(await bundle.thumbnail.text(), 'thumbnail');
    assert.equal(bundle.deleteUrl, null);
    store.close();
});

test('rejects a mismatched draft without partially writing any store', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-reject',
    });
    const input = fixture();
    await assert.rejects(store.putDraft({
        ...input,
        project: { ...input.project, localId: 'other' },
    }), /matching clean draft/);
    assert.equal((await store.listPhotos()).length, 0);
    store.close();
});

test('commits public upload metadata and local-only deletion capability together', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-upload',
    });
    const input = fixture();
    await store.putDraft(input);
    const uploaded = Library.completeUpload(input.photo, {
        mime: 'image/jpeg', bytes: 9, width: 1600, height: 1200, sha256: EXPORT_HASH,
    }, {
        providerId: 'abc',
        url: 'https://i.ibb.co/a/topo.jpg',
        displayUrl: 'https://i.ibb.co/a/topo.jpg',
        viewerUrl: 'https://ibb.co/abc',
        thumbnailUrl: 'https://i.ibb.co/a/thumb.jpg',
        mediumUrl: null,
        uploadedAt: LATER,
        expiresAt: null,
    }, LATER);
    await store.commitUpload({ photo: uploaded, deleteUrl: 'https://ibb.co/delete/secret' });

    const bundle = await store.getBundle('photo-1');
    assert.equal(bundle.photo.remote.state, 'uploaded');
    assert.equal(bundle.deleteUrl, 'https://ibb.co/delete/secret');
    assert.equal('deleteUrl' in bundle.photo, false);
    store.close();
});

test('removes local editable assets while preserving the public catalog record', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-assets',
    });
    await store.putDraft(fixture());
    const photo = await store.removeLocalAssets('photo-1', LATER);
    assert.deepEqual(photo.assets, {
        originalRetained: false,
        projectRetained: false,
        thumbnailRetained: false,
    });
    const bundle = await store.getBundle('photo-1');
    assert.ok(bundle.photo);
    assert.equal(bundle.original, null);
    assert.equal(bundle.project, null);
    assert.equal(bundle.thumbnail, null);
    store.close();
});

test('journals operations and purges all local records explicitly', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-operations',
    });
    await store.putDraft(fixture());
    await store.putOperation({
        localId: 'photo-1',
        operationId: 'operation-1',
        state: 'request-started',
    });
    assert.deepEqual(await store.getOperations(), [{
        localId: 'photo-1',
        operationId: 'operation-1',
        state: 'request-started',
    }]);
    await store.deleteOperation('operation-1');
    assert.deepEqual(await store.getOperations(), []);
    await store.purge('photo-1');
    assert.equal((await store.listPhotos({ includeDeleted: true })).length, 0);
    assert.equal((await store.getBundle('photo-1')).deleteUrl, null);
    store.close();
});
