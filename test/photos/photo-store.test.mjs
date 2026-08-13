// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { photoProject as Project } from '../../src/photos/photo-project.js';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';
import { photoStore as Store } from '../../src/photos/photo-store.js';
import { photoBackup as Backup } from '../../src/photos/photo-backup.js';

const TIME = '2026-07-27T18:00:00.000Z';
const LATER = '2026-07-27T18:10:00.000Z';
const HASH = 'a'.repeat(64);
const EXPORT_HASH = 'b'.repeat(64);
const uploadOperation = (localId, operationId = 'operation-1') => ({
    localId,
    operationId,
    state: 'request-started',
    export: { mime: 'image/jpeg', bytes: 9, width: 1600, height: 1200, sha256: EXPORT_HASH },
    updatedAt: LATER,
});

const fixture = (localId = 'photo-1') => {
    const photo = Library.createDraft({
        localId,
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

test('upgrading a pre-generation catalog starts dirty instead of inventing confirmation', async () => {
    const indexedDB = new IDBFactory();
    const name = 'photo-store-generation-migration';
    const legacy = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 2);
        request.onupgradeneeded = () => {
            for (const storeName of Object.values(Store.STORES).filter(value => value !== 'metadata')) {
                const store = request.result.createObjectStore(storeName, {
                    keyPath: storeName === 'operations' ? 'operationId' : 'localId',
                });
                if (storeName === 'operations') {
                    store.createIndex('byLocalId', 'localId', { unique: false });
                }
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const write = legacy.transaction('photos', 'readwrite');
    write.objectStore('photos').put(fixture().photo);
    await new Promise((resolve, reject) => {
        write.oncomplete = resolve;
        write.onerror = () => reject(write.error);
        write.onabort = () => reject(write.error);
    });
    legacy.close();

    const store = await Store.createPhotoStore({ indexedDB, name });
    const state = await store.getCatalogState();
    assert.equal(state.generation, 1);
    assert.equal(state.confirmedGeneration, 0);
    store.close();
});

test('persists and retrieves a matching photo, project, original, and thumbnail atomically', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-bundle',
    });
    const input = fixture();
    const stored = await store.putDraft(input);
    const bundle = await store.getBundle('photo-1');
    assert.deepEqual(bundle.photo, stored);
    assert.equal(bundle.photo.revision, 1);
    assert.deepEqual(bundle.project, input.project);
    assert.equal(await bundle.original.text(), 'original');
    assert.equal(await bundle.thumbnail.text(), 'thumbnail');
    assert.equal(bundle.deleteUrl, null);
    store.close();
});

test('reads one bounded thumbnail page without loading full bundles', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-thumbnail-page',
    });
    await store.putDraft(fixture('photo-1'));
    await store.putDraft(fixture('photo-2'));

    const thumbnails = await store.getThumbnails(['photo-1', 'missing', 'photo-2', 'photo-1']);
    assert.deepEqual([...thumbnails.keys()], ['photo-1', 'missing', 'photo-2']);
    assert.equal(await thumbnails.get('photo-1').text(), 'thumbnail');
    assert.equal(thumbnails.get('missing'), null);
    await assert.rejects(
        store.getThumbnails(Array.from({ length: 101 }, (_, index) => `photo-${index}`)),
        /batch is too large/,
    );
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
    }), /matching clean photo/);
    assert.equal((await store.listPhotos()).length, 0);
    store.close();
});

test('rejects project and photo dimensions that disagree even when their source hash matches', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-dimension-reject',
    });
    const input = fixture();
    await assert.rejects(store.putDraft({
        ...input,
        project: Project.createProject({
            localId: input.photo.localId,
            width: input.photo.source.height,
            height: input.photo.source.width,
            sourceSha256: input.photo.source.sha256,
            updatedAt: TIME,
        }),
    }), /matching clean photo/);
    assert.equal((await store.listPhotos()).length, 0);
    store.close();
});

// An ambiguous upload leaves the photo in `outcome-unknown` with the local
// original still authoritative, and `beginUpload` accepts that state as a retry
// input. A draft-only write gate closed the loop: every autosave and the retry
// itself failed, so the editor dead-ended on the one failure it was designed to
// recover from.
test('re-saves a pre-upload photo through every retryable state, never a published one', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-retry',
    });
    const input = fixture();
    const exported = { mime: 'image/jpeg', bytes: 9, width: 1600, height: 1200, sha256: EXPORT_HASH };
    input.photo = await store.putDraft(input);

    const uploading = Library.beginUpload(input.photo, exported, LATER);
    const storedUploading = await store.putDraft({ ...input, photo: uploading });
    assert.equal((await store.getBundle('photo-1')).photo.remote.state, 'uploading');

    const unknown = Library.markOutcomeUnknown(storedUploading, LATER);
    const edited = Library.cleanPhoto({ ...unknown, title: 'Retitled after an unknown outcome' });
    const storedEdited = await store.putDraft({ ...input, photo: edited });
    const bundle = await store.getBundle('photo-1');
    assert.equal(bundle.photo.remote.state, 'outcome-unknown');
    assert.equal(bundle.photo.title, 'Retitled after an unknown outcome');
    assert.deepEqual(bundle.photo.assets, {
        originalRetained: true,
        projectRetained: true,
        thumbnailRetained: true,
    }, 'a retryable re-save must not look like a lost editable copy');
    assert.equal(await bundle.original.text(), 'original');
    assert.deepEqual(bundle.project, input.project);

    const published = Library.completeUpload(storedEdited, exported, {
        providerId: 'abc',
        url: 'https://i.ibb.co/a/topo.jpg',
        displayUrl: 'https://i.ibb.co/a/topo.jpg',
        viewerUrl: 'https://ibb.co/abc',
        thumbnailUrl: 'https://i.ibb.co/a/thumb.jpg',
        mediumUrl: null,
        uploadedAt: LATER,
        expiresAt: null,
    }, LATER);
    await assert.rejects(store.putDraft({ ...input, photo: published }), /matching clean photo/);
    assert.equal((await store.getBundle('photo-1')).photo.remote.state, 'outcome-unknown');
    store.close();
});

test('commits public upload metadata and local-only deletion capability together', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-upload',
    });
    const input = fixture();
    input.photo = await store.putDraft(input);
    const exported = {
        mime: 'image/jpeg', bytes: 9, width: 1600, height: 1200, sha256: EXPORT_HASH,
    };
    let operation;
    ({ photo: input.photo, operation } = await store.beginUploadOperation({
        photo: Library.beginUpload(input.photo, exported, LATER),
        operation: uploadOperation(input.photo.localId),
    }));
    operation = {
        ...operation,
        state: 'response-received',
        deleteUrl: 'https://ibb.co/delete/secret',
    };
    await store.putOperation(operation);
    const uploaded = Library.completeUpload(input.photo, exported, {
        providerId: 'abc',
        url: 'https://i.ibb.co/a/topo.jpg',
        displayUrl: 'https://i.ibb.co/a/topo.jpg',
        viewerUrl: 'https://ibb.co/abc',
        thumbnailUrl: 'https://i.ibb.co/a/thumb.jpg',
        mediumUrl: null,
        uploadedAt: LATER,
        expiresAt: null,
    }, LATER);
    const committed = await store.commitUploadOperation({
        photo: uploaded,
        operationId: operation.operationId,
    });

    const bundle = await store.getBundle('photo-1');
    assert.equal(bundle.photo.remote.state, 'uploaded');
    assert.equal(bundle.deleteUrl, 'https://ibb.co/delete/secret');
    assert.equal('deleteUrl' in bundle.photo, false);
    assert.equal(committed.operation.state, 'catalog-committed');
    assert.equal((await store.getOperations())[0].state, 'catalog-committed');
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

test('prunes only one bounded batch of expired deleted assets', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-prune-batch',
    });
    for (const localId of ['photo-1', 'photo-2', 'photo-3']) {
        const input = fixture(localId);
        input.photo = await store.putDraft(input);
        await store.putPhoto(Library.markDeleted(input.photo, TIME));
    }

    assert.deepEqual(await store.pruneDeletedAssets({
        before: LATER,
        now: LATER,
        limit: 2,
    }), { pruned: 2, remaining: 1 });
    const bundles = await Promise.all(['photo-1', 'photo-2', 'photo-3']
        .map(localId => store.getBundle(localId)));
    assert.equal(bundles.filter(bundle => bundle.original == null).length, 2);
    assert.equal(bundles.filter(bundle => bundle.original != null).length, 1);
    assert.equal(bundles.filter(bundle => bundle.photo.assets.projectRetained).length, 1);
    store.close();
});

test('restores an expired catalog record without stale local editing assets', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-record-only-restore',
    });
    const input = fixture();
    input.photo = await store.putDraft(input);
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
    const referenced = Library.addReference(uploaded, {
        kind: 'ascent', cid: 1, aid: 2, pid: 3, insertedAt: LATER,
    }, LATER);
    const withBackup = Library.cleanPhoto({
        ...referenced,
        backup: {
            state: 'current',
            signature: 'c'.repeat(64),
            backedUpAt: LATER,
            commitUrl: 'https://github.com/example/photos/commit/abc',
        },
    });
    const current = await store.putPhoto(withBackup);
    const deleted = await store.putPhoto(Library.markDeleted(current, LATER));
    const restored = await store.restorePhoto(Library.restoreDeleted(deleted, LATER), {
        retainAssets: false,
    });

    assert.deepEqual(restored.assets, {
        originalRetained: false,
        projectRetained: false,
        thumbnailRetained: false,
    });
    assert.equal(restored.remote.url, uploaded.remote.url);
    assert.deepEqual(restored.references, referenced.references);
    assert.deepEqual(restored.backup,
        { state: 'pending', signature: null, backedUpAt: null, commitUrl: null });
    const bundle = await store.getBundle(restored.localId);
    assert.equal(bundle.original, null);
    assert.equal(bundle.project, null);
    assert.equal(bundle.thumbnail, null);
    assert.deepEqual((await store.listBackupBundles()).tombstones, []);
    store.close();
});

test('maintenance leaves editing assets on a photo restored before its deleted deadline', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-restored-before-maintenance',
    });
    const input = fixture();
    input.photo = await store.putDraft(input);
    const deleted = await store.putPhoto(Library.markDeleted(input.photo, TIME));
    const restored = await store.restorePhoto(Library.restoreDeleted(deleted, LATER));

    assert.deepEqual(await store.pruneDeletedAssets({
        before: LATER,
        now: LATER,
    }), { pruned: 0, remaining: 0 });
    const bundle = await store.getBundle(restored.localId);
    assert.equal(await bundle.original.text(), 'original');
    assert.ok(bundle.project);
    assert.equal(await bundle.thumbnail.text(), 'thumbnail');
    assert.equal(bundle.photo.deletedAt, null);
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

test('upload state and its recovery journal begin in one atomic transaction', async () => {
    const indexedDB = new IDBFactory();
    const name = 'photo-store-upload-start';
    const store = await Store.createPhotoStore({ indexedDB, name });
    const input = fixture();
    input.photo = await store.putDraft(input);
    const uploading = Library.beginUpload(input.photo, uploadOperation(input.photo.localId).export, LATER);
    const operation = uploadOperation(input.photo.localId);

    const database = indexedDB._databases.get(name).connections.find(connection => !connection._closed);
    const transaction = database.transaction.bind(database);
    database.transaction = (storeNames, mode, options) => {
        const next = transaction(storeNames, mode, options);
        const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
        if (mode !== 'readwrite' || !names.includes('operations') || !names.includes('photos')) return next;
        database.transaction = transaction;
        const objectStore = next.objectStore.bind(next);
        next.objectStore = storeName => {
            const target = objectStore(storeName);
            if (storeName === 'operations') {
                target.put = () => { throw new Error('forced journal write failure'); };
            }
            return target;
        };
        return next;
    };

    await assert.rejects(
        store.beginUploadOperation({ photo: uploading, operation }),
        /forced journal write failure/,
    );
    assert.equal((await store.getBundle(input.photo.localId)).photo.remote.state, 'draft');
    assert.deepEqual(await store.getOperations(), []);

    const begun = await store.beginUploadOperation({ photo: uploading, operation });
    assert.equal(begun.photo.remote.state, 'uploading');
    assert.equal(begun.operation.photoRevision, begun.photo.revision);
    assert.deepEqual(await store.getOperations(), [begun.operation]);
    const reset = await store.resetUploadOperation({
        photo: Library.resetUpload(begun.photo, LATER),
        operationId: begun.operation.operationId,
    });
    assert.equal(reset.remote.state, 'draft');
    assert.deepEqual(await store.getOperations(), []);
    store.close();
});

test('legacy uploading records without a journal return to a retryable draft once', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-legacy-upload',
    });
    const input = fixture();
    input.photo = await store.putDraft(input);
    const uploading = await store.putPhoto(Library.beginUpload(
        input.photo,
        uploadOperation(input.photo.localId).export,
        LATER,
    ));
    assert.equal(uploading.remote.state, 'uploading');

    assert.deepEqual(await store.recoverOrphanedUploads(LATER), {
        recovered: 1,
        localIds: [input.photo.localId],
    });
    const recovered = (await store.getBundle(input.photo.localId)).photo;
    assert.equal(recovered.remote.state, 'draft');
    assert.equal(recovered.revision, uploading.revision + 1);
    assert.deepEqual(await store.recoverOrphanedUploads(LATER), {
        recovered: 0,
        localIds: [],
    });
    store.close();
});

test('lists metadata backup bundles and persists deletion tombstones separately', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-backup-bundles',
    });
    const input = fixture();
    input.photo = await store.putDraft(input);
    await store.putPhoto(Library.markDeleted(input.photo, LATER));
    const snapshot = await store.listBackupBundles();
    assert.equal(snapshot.bundles.length, 1);
    assert.equal(snapshot.bundles[0].project.localId, 'photo-1');
    assert.deepEqual(snapshot.tombstones, [{ localId: 'photo-1', deletedAt: LATER }]);
    const payload = Backup.buildPayload({ ...snapshot, exportedAt: LATER });
    assert.deepEqual(payload.photos, []);
    assert.deepEqual(payload.tombstones, [{ localId: 'photo-1', deletedAt: LATER }]);
    store.close();
});

test('applies a restored project atomically without inventing original pixels', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-restore',
    });
    const input = fixture();
    const payload = Backup.buildPayload({ bundles: [input], exportedAt: TIME });
    const signature = await Backup.signature(payload);
    const record = Backup.restoreRecord(payload.photos[0], {
        signature,
        restoredAt: LATER,
    });
    await store.applyRestore({
        records: [record],
        tombstones: [{ localId: 'remote-deleted', deletedAt: LATER }],
    });

    const restored = await store.getBundle('photo-1');
    assert.equal(restored.photo.backup.state, 'pending');
    assert.equal(restored.project.localId, 'photo-1');
    assert.equal(restored.original, null);
    assert.equal(restored.thumbnail, null);
    assert.equal(restored.deleteUrl, null);
    const snapshot = await store.listBackupBundles();
    assert.deepEqual(snapshot.tombstones, [{ localId: 'remote-deleted', deletedAt: LATER }]);
    store.close();
});

test('catalog generation is atomic with recovery data and ignores editing-asset cleanup', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-catalog-generation',
    });
    const input = fixture();
    input.photo = await store.putDraft(input);
    assert.deepEqual(await store.getCatalogState(), {
        key: Store.CATALOG_STATE_KEY,
        generation: 1,
        confirmedGeneration: 0,
        signature: null,
        commitUrl: null,
        backedUpAt: null,
        revisions: {},
    });

    const stamp = {
        state: 'current',
        signature: 'c'.repeat(64),
        backedUpAt: LATER,
        commitUrl: 'https://github.com/example/photos/commit/abc',
    };
    input.photo = await store.updatePhotoBackup({
        localId: input.photo.localId,
        expectedRevision: input.photo.revision,
        backup: stamp,
    });
    await store.confirmCatalogBackup({
        generation: 1,
        signature: stamp.signature,
        revisions: { [input.photo.localId]: input.photo.revision },
        commitUrl: stamp.commitUrl,
        backedUpAt: LATER,
    });
    const beforeCleanup = input.photo.updatedAt;
    const cleaned = await store.removeLocalAssets(input.photo.localId, LATER);
    assert.equal(cleaned.updatedAt, beforeCleanup);
    assert.equal((await store.getCatalogState()).generation, 1);
    assert.equal((await store.getBundle(input.photo.localId)).photo.backup.state, 'current');

    const referenced = Library.addReference(cleaned, {
        kind: 'ascent', cid: 1, aid: 2, pid: 3, insertedAt: LATER,
    }, LATER);
    await store.putPhoto(referenced);
    const dirty = await store.getCatalogState();
    assert.equal(dirty.generation, 2);
    assert.equal(dirty.confirmedGeneration, 1);
    assert.equal((await store.getBundle(input.photo.localId)).photo.backup.state, 'pending');
    store.close();
});

test('metadata restore rejects matching ids and hashes with conflicting dimensions', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-restore-dimension-reject',
    });
    const input = fixture();
    await assert.rejects(store.applyRestore({
        records: [{
            photo: input.photo,
            project: Project.createProject({
                localId: input.photo.localId,
                width: input.photo.source.height,
                height: input.photo.source.width,
                sourceSha256: input.photo.source.sha256,
                updatedAt: TIME,
            }),
        }],
    }), /invalid record/);
    assert.deepEqual(await store.listPhotos(), []);
    store.close();
});

test('restoring matching metadata preserves local editable assets', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-restore-preserve',
    });
    const input = fixture();
    input.photo = await store.putDraft(input);
    const payload = Backup.buildPayload({ bundles: [input], exportedAt: TIME });
    const record = Backup.restoreRecord(payload.photos[0], {
        signature: await Backup.signature(payload),
        restoredAt: LATER,
    });
    await store.applyRestore({
        records: [record],
        expectedRevisions: (await store.listBackupBundles()).revisions,
    });
    const restored = await store.getBundle('photo-1');
    assert.equal(await restored.original.text(), 'original');
    assert.equal(await restored.thumbnail.text(), 'thumbnail');
    assert.deepEqual(restored.photo.assets, {
        originalRetained: true,
        projectRetained: true,
        thumbnailRetained: true,
    });
    store.close();
});

test('an imported bundle can carry a record ImgBB already published', async () => {
    const store = await Store.createPhotoStore({
        indexedDB: new IDBFactory(),
        name: 'photo-store-import',
    });
    const input = fixture();
    const exported = {
        mime: 'image/jpeg', bytes: 20, width: 1600, height: 1200, sha256: EXPORT_HASH,
    };
    const published = Library.completeUpload(input.photo, exported, {
        providerId: 'abc',
        url: 'https://i.ibb.co/a/topo.jpg',
        displayUrl: 'https://i.ibb.co/a/topo.jpg',
        viewerUrl: 'https://ibb.co/abc',
        thumbnailUrl: 'https://i.ibb.co/a/thumb.jpg',
        mediumUrl: null,
        uploadedAt: LATER,
        expiresAt: null,
    }, LATER);

    // Download project offers a published record, so refusing it on the way
    // back in would strand the round trip that action promises.
    const storedPublished = await store.putBundle({ ...input, photo: published });
    const bundle = await store.getBundle('photo-1');
    assert.equal(bundle.photo.remote.url, 'https://i.ibb.co/a/topo.jpg');
    assert.equal(await bundle.original.text(), 'original');
    assert.deepEqual(bundle.project, input.project);
    // The deletion capability is never in a bundle, so importing one cannot
    // hand back a delete URL it does not have.
    assert.equal(bundle.deleteUrl, null);

    // The identities still have to agree: a project for different pixels is
    // exactly the mismatch an edited archive would carry.
    await assert.rejects(store.putBundle({
        ...input,
        photo: published,
        project: Project.createProject({
            localId: 'photo-1', width: 1600, height: 1200, sourceSha256: EXPORT_HASH,
        }),
    }), /matching clean photo/);

    // Importing a record that was deleted elsewhere must not leave the
    // tombstone that would delete it again on the next backup merge.
    const removed = await store.putPhoto(Library.markDeleted(storedPublished, LATER));
    assert.equal((await store.listBackupBundles()).tombstones.length, 1);
    await store.restorePhoto(Library.restoreDeleted(removed, LATER));
    assert.deepEqual((await store.listBackupBundles()).tombstones, []);
    store.close();
});

test('a stale autosave cannot resurrect a photo deleted in another tab', async () => {
    const indexedDB = new IDBFactory();
    const first = await Store.createPhotoStore({ indexedDB, name: 'photo-store-delete-race' });
    const second = await Store.createPhotoStore({ indexedDB, name: 'photo-store-delete-race' });
    const input = fixture();
    input.photo = await first.putDraft(input);
    const stale = await second.getBundle(input.photo.localId);

    const deleted = await first.putPhoto(Library.markDeleted(input.photo, LATER));
    await assert.rejects(
        second.putDraft({
            ...stale,
            photo: Library.cleanPhoto({ ...stale.photo, title: 'Stale edit', updatedAt: LATER }),
        }),
        error => error instanceof Store.PhotoStoreConflictError,
    );
    assert.equal((await first.getBundle(input.photo.localId)).photo.deletedAt, LATER);

    const restored = await first.restorePhoto(Library.restoreDeleted(deleted, LATER));
    assert.equal(restored.revision, deleted.revision + 1);
    assert.equal(restored.deletedAt, null);
    first.close();
    second.close();
});

test('a backup stamp conflict preserves a newer report reference and succeeds after reload', async () => {
    const indexedDB = new IDBFactory();
    const first = await Store.createPhotoStore({ indexedDB, name: 'photo-store-metadata-race' });
    const second = await Store.createPhotoStore({ indexedDB, name: 'photo-store-metadata-race' });
    const input = fixture();
    input.photo = await first.putDraft(input);
    const stale = (await second.getBundle(input.photo.localId)).photo;

    const referenced = await first.putPhoto(Library.addReference(input.photo, {
        kind: 'ascent', cid: 1, aid: 2, pid: 3, insertedAt: LATER,
    }, LATER));
    const backup = { state: 'pending', signature: null, backedUpAt: null, commitUrl: null };
    await assert.rejects(
        second.updatePhotoBackup({
            localId: stale.localId,
            expectedRevision: stale.revision,
            backup,
        }),
        error => error instanceof Store.PhotoStoreConflictError,
    );
    assert.equal((await first.getBundle(input.photo.localId)).photo.references.length, 1);

    const reloaded = (await second.getBundle(input.photo.localId)).photo;
    const stamped = await second.updatePhotoBackup({
        localId: reloaded.localId,
        expectedRevision: reloaded.revision,
        backup,
    });
    assert.equal(stamped.references.length, 1);
    assert.equal(stamped.revision, referenced.revision + 1);
    first.close();
    second.close();
});

test('upload commit rejects stale metadata and preserves the edit for an explicit retry', async () => {
    const indexedDB = new IDBFactory();
    const first = await Store.createPhotoStore({ indexedDB, name: 'photo-store-upload-race' });
    const second = await Store.createPhotoStore({ indexedDB, name: 'photo-store-upload-race' });
    const input = fixture();
    input.photo = await first.putDraft(input);
    const stale = (await second.getBundle(input.photo.localId)).photo;
    const edited = await first.putPhoto(Library.cleanPhoto({
        ...input.photo,
        title: 'Newer title',
        updatedAt: LATER,
    }));
    const exported = {
        mime: 'image/jpeg', bytes: 9, width: 1600, height: 1200, sha256: EXPORT_HASH,
    };
    const remote = {
        providerId: 'abc',
        url: 'https://i.ibb.co/a/topo.jpg',
        displayUrl: 'https://i.ibb.co/a/topo.jpg',
        viewerUrl: 'https://ibb.co/abc',
        thumbnailUrl: 'https://i.ibb.co/a/thumb.jpg',
        mediumUrl: null,
        uploadedAt: LATER,
        expiresAt: null,
    };
    const staleUploading = Library.beginUpload(stale, exported, LATER);
    await assert.rejects(
        second.beginUploadOperation({
            photo: staleUploading,
            operation: uploadOperation(stale.localId, 'operation-stale'),
        }),
        error => error instanceof Store.PhotoStoreConflictError,
    );
    assert.equal((await first.getBundle(input.photo.localId)).photo.title, 'Newer title');

    const begun = await second.beginUploadOperation({
        photo: Library.beginUpload(edited, exported, LATER),
        operation: uploadOperation(edited.localId, 'operation-retry'),
    });
    const uploading = begun.photo;
    const operation = {
        ...begun.operation,
        state: 'response-received',
        remote,
        deleteUrl: 'https://ibb.co/delete/secret',
    };
    await second.putOperation(operation);
    const { photo: committed } = await second.commitUploadOperation({
        photo: Library.completeUpload(uploading, exported, remote, LATER),
        operationId: operation.operationId,
    });
    assert.equal(committed.title, 'Newer title');
    assert.equal(committed.remote.state, 'uploaded');
    first.close();
    second.close();
});

test('metadata restore rejects a local edit made after its revision snapshot', async () => {
    const indexedDB = new IDBFactory();
    const first = await Store.createPhotoStore({ indexedDB, name: 'photo-store-restore-race' });
    const second = await Store.createPhotoStore({ indexedDB, name: 'photo-store-restore-race' });
    const input = fixture();
    input.photo = await first.putDraft(input);
    const snapshot = await first.listBackupBundles();
    const payload = Backup.buildPayload({ bundles: snapshot.bundles, exportedAt: TIME });
    const record = Backup.restoreRecord(payload.photos[0], {
        signature: await Backup.signature(payload),
        restoredAt: LATER,
    });
    await second.putPhoto(Library.cleanPhoto({
        ...input.photo,
        title: 'Edited while restore was pending',
        updatedAt: LATER,
    }));

    await assert.rejects(
        first.applyRestore({ records: [record], expectedRevisions: snapshot.revisions }),
        error => error instanceof Store.PhotoStoreConflictError,
    );
    assert.equal((await first.getBundle(input.photo.localId)).photo.title,
        'Edited while restore was pending');
    first.close();
    second.close();
});
