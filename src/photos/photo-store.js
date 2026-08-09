// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — IndexedDB ownership for local photo records and blobs.

import { photoProject as Project } from './photo-project.js';
import { photoLibrary as Library } from './photo-library.js';

const DATABASE_NAME = 'betterPeakbaggerPhotos';
const DATABASE_VERSION = 2;
const STORES = Object.freeze({
    photos: 'photos',
    projects: 'projects',
    originals: 'originals',
    thumbnails: 'thumbnails',
    operations: 'operations',
    secrets: 'secrets',
    tombstones: 'tombstones',
});
const STORE_NAMES = Object.freeze(Object.values(STORES));
const MAX_THUMBNAIL_BATCH = 100;
const MAX_MAINTENANCE_BATCH = 50;

class PhotoStoreConflictError extends Error {
    constructor(localId, message = 'The photo changed in another tab. Reload it and try again.') {
        super(message);
        this.name = 'PhotoStoreConflictError';
        this.code = 'photo-conflict';
        this.localId = localId;
    }
}

const requestResult = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
});

const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
});

const openDatabase = ({
    indexedDB = globalThis.indexedDB,
    name = DATABASE_NAME,
} = {}) => {
    if (!indexedDB?.open) return Promise.reject(new Error('IndexedDB is unavailable.'));
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            for (const storeName of STORE_NAMES) {
                if (!database.objectStoreNames.contains(storeName)) {
                    const store = database.createObjectStore(storeName, {
                        keyPath: storeName === STORES.operations ? 'operationId' : 'localId',
                    });
                    if (storeName === STORES.operations) {
                        store.createIndex('byLocalId', 'localId', { unique: false });
                    }
                }
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open the photo library.'));
        request.onblocked = () => reject(new Error('Photo library upgrade is blocked by another tab.'));
    });
};

const cleanBlobRecord = (value, localId) => value instanceof Blob
    ? { localId, blob: value }
    : null;

// The local original stays authoritative until ImgBB confirms a URL, so a
// draft write covers every pre-upload state — exactly the states for which
// `cleanPhoto` keeps `export` null. `outcome-unknown` belongs here: the editor
// has to be able to re-save an ambiguous upload before retrying it.
const EDITABLE_STATES = new Set(['draft', 'uploading', 'outcome-unknown']);

const cleanDeleteUrl = value => {
    if (typeof value !== 'string' || value.length > Library.URL_LIMIT) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    } catch { return null; }
};

const tombstoneRevision = value => Number.isSafeInteger(value?.revision) && value.revision >= 0
    ? value.revision
    : 0;

const nextRevision = (photo, tombstone) => Math.max(
    photo?.revision ?? 0,
    tombstoneRevision(tombstone),
) + 1;

const abortAndRethrow = async (transaction, error) => {
    try { transaction.abort(); } catch {}
    await transactionDone(transaction).catch(() => {});
    throw error;
};

const createPhotoStore = async options => {
    const database = await openDatabase(options);

    // One record, its project, and its local pixels, written together. The
    // editor goes through putDraft, which additionally refuses a published
    // record; importing a downloaded bundle cannot, because the bundle may
    // carry a record ImgBB has already published and refusing it would strand
    // the round trip that Download project promised.
    const putBundle = async ({ photo, project, original, thumbnail }, { editableOnly = false } = {}) => {
        const cleanPhoto = Library.cleanPhoto(photo);
        const cleanProject = Project.cleanProject(project);
        const cleanOriginal = cleanBlobRecord(original, cleanPhoto?.localId);
        const cleanThumbnail = cleanBlobRecord(thumbnail, cleanPhoto?.localId);
        if (!cleanPhoto || !cleanProject || cleanPhoto.localId !== cleanProject.localId
            || cleanProject.image.sourceSha256 !== cleanPhoto.source.sha256
            || !Project.matchingImageDimensions(cleanProject.image, cleanPhoto.source)
            || !cleanOriginal || !cleanThumbnail
            || (editableOnly && !EDITABLE_STATES.has(cleanPhoto.remote.state))) {
            throw new TypeError('photo store requires a matching clean photo, project, and blobs');
        }
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
            STORES.tombstones,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        let storedPhoto;
        try {
            const [currentValue, tombstone] = await Promise.all([
                requestResult(photos.get(cleanPhoto.localId)),
                requestResult(tombstones.get(cleanPhoto.localId)),
            ]);
            const current = Library.cleanPhoto(currentValue);
            if ((current && current.revision !== cleanPhoto.revision)
                || (!current && (cleanPhoto.revision !== 0 || tombstone))) {
                throw new PhotoStoreConflictError(cleanPhoto.localId);
            }
            if (current?.deletedAt && !cleanPhoto.deletedAt) {
                throw new PhotoStoreConflictError(cleanPhoto.localId,
                    'This photo was deleted in another tab. Restore it before editing.');
            }
            storedPhoto = Library.cleanPhoto({
                ...cleanPhoto,
                revision: nextRevision(current, tombstone),
            });
            photos.put(storedPhoto);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        transaction.objectStore(STORES.projects).put(cleanProject);
        transaction.objectStore(STORES.originals).put(cleanOriginal);
        transaction.objectStore(STORES.thumbnails).put(cleanThumbnail);
        if (storedPhoto.deletedAt) {
            tombstones.put({
                localId: storedPhoto.localId,
                deletedAt: storedPhoto.deletedAt,
                revision: storedPhoto.revision,
            });
        } else {
            tombstones.delete(storedPhoto.localId);
        }
        await transactionDone(transaction);
        return storedPhoto;
    };

    const putDraft = bundle => putBundle(bundle, { editableOnly: true });

    const getBundle = async localId => {
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
            STORES.secrets,
        ], 'readonly');
        const stores = {
            photo: STORES.photos,
            project: STORES.projects,
            original: STORES.originals,
            thumbnail: STORES.thumbnails,
            secret: STORES.secrets,
        };
        const entries = await Promise.all(Object.entries(stores).map(async ([key, storeName]) => [
            key,
            await requestResult(transaction.objectStore(storeName).get(localId)),
        ]));
        await transactionDone(transaction);
        const values = Object.fromEntries(entries);
        return {
            photo: values.photo ? Library.cleanPhoto(values.photo) : null,
            project: values.project ? Project.cleanProject(values.project) : null,
            original: values.original?.blob instanceof Blob ? values.original.blob : null,
            thumbnail: values.thumbnail?.blob instanceof Blob ? values.thumbnail.blob : null,
            deleteUrl: cleanDeleteUrl(values.secret?.deleteUrl),
        };
    };

    const listPhotos = async ({ includeDeleted = false } = {}) => {
        const transaction = database.transaction(STORES.photos, 'readonly');
        const values = await requestResult(transaction.objectStore(STORES.photos).getAll());
        await transactionDone(transaction);
        return values.map(Library.cleanPhoto).filter(Boolean)
            .filter(photo => includeDeleted || !photo.deletedAt)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    };

    const getThumbnails = async localIds => {
        const ids = Array.isArray(localIds)
            ? [...new Set(localIds.filter(value => typeof value === 'string'))]
            : [];
        if (ids.length > MAX_THUMBNAIL_BATCH) {
            throw new TypeError('photo store thumbnail batch is too large');
        }
        if (!ids.length) return new Map();
        const transaction = database.transaction(STORES.thumbnails, 'readonly');
        const store = transaction.objectStore(STORES.thumbnails);
        const values = await Promise.all(ids.map(async localId => [
            localId,
            await requestResult(store.get(localId)),
        ]));
        await transactionDone(transaction);
        return new Map(values.map(([localId, value]) => [
            localId,
            value?.blob instanceof Blob ? value.blob : null,
        ]));
    };

    const listBackupBundles = async () => {
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.tombstones,
        ], 'readonly');
        const [photos, projects, tombstones] = await Promise.all([
            requestResult(transaction.objectStore(STORES.photos).getAll()),
            requestResult(transaction.objectStore(STORES.projects).getAll()),
            requestResult(transaction.objectStore(STORES.tombstones).getAll()),
        ]);
        await transactionDone(transaction);
        const projectsById = new Map(projects.map(value => [value.localId, Project.cleanProject(value)]));
        return {
            bundles: photos.map(Library.cleanPhoto).filter(Boolean).map(photo => ({
                photo,
                project: projectsById.get(photo.localId) || null,
            })),
            tombstones: tombstones.map(value => ({
                localId: value.localId,
                deletedAt: value.deletedAt,
            })),
            revisions: Object.fromEntries([
                ...photos.map(value => [value.localId, Library.cleanPhoto(value)?.revision ?? 0]),
                ...tombstones.map(value => [value.localId, tombstoneRevision(value)]),
            ]),
        };
    };

    const putPhoto = async photo => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned) throw new TypeError('photo store requires a clean photo');
        const transaction = database.transaction([STORES.photos, STORES.tombstones], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        let storedPhoto;
        try {
            const [currentValue, tombstone] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(tombstones.get(cleaned.localId)),
            ]);
            const current = Library.cleanPhoto(currentValue);
            if ((current && current.revision !== cleaned.revision)
                || (!current && (cleaned.revision !== 0 || tombstone))) {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            if (current?.deletedAt && !cleaned.deletedAt) {
                throw new PhotoStoreConflictError(cleaned.localId,
                    'This photo was deleted in another tab. Restore it before changing it.');
            }
            storedPhoto = Library.cleanPhoto({
                ...cleaned,
                revision: nextRevision(current, tombstone),
            });
            photos.put(storedPhoto);
            if (storedPhoto.deletedAt) {
                tombstones.put({
                    localId: storedPhoto.localId,
                    deletedAt: storedPhoto.deletedAt,
                    revision: storedPhoto.revision,
                });
            } else {
                tombstones.delete(storedPhoto.localId);
            }
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return storedPhoto;
    };

    const restorePhoto = async photo => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned || cleaned.deletedAt) {
            throw new TypeError('photo store requires a clean restored photo');
        }
        const transaction = database.transaction([STORES.photos, STORES.tombstones], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        let storedPhoto;
        try {
            const [currentValue, tombstone] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(tombstones.get(cleaned.localId)),
            ]);
            const current = Library.cleanPhoto(currentValue);
            if (!current?.deletedAt || current.revision !== cleaned.revision || !tombstone) {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            storedPhoto = Library.cleanPhoto({
                ...cleaned,
                revision: nextRevision(current, tombstone),
            });
            photos.put(storedPhoto);
            tombstones.delete(cleaned.localId);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return storedPhoto;
    };

    const beginUploadOperation = async ({ photo, operation }) => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned || cleaned.remote.state !== 'uploading'
            || !operation || typeof operation !== 'object' || Array.isArray(operation)
            || operation.localId !== cleaned.localId
            || typeof operation.operationId !== 'string'
            || operation.state !== 'request-started') {
            throw new TypeError('photo store requires a clean upload and recovery operation');
        }
        const transaction = database.transaction([
            STORES.photos,
            STORES.tombstones,
            STORES.operations,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        const operations = transaction.objectStore(STORES.operations);
        let storedPhoto;
        let storedOperation;
        try {
            const [currentValue, previousOperationIds] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(operations.index('byLocalId').getAllKeys(cleaned.localId)),
            ]);
            const current = Library.cleanPhoto(currentValue);
            if (!current || current.deletedAt || current.revision !== cleaned.revision
                || !['draft', 'outcome-unknown'].includes(current.remote.state)) {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            storedPhoto = Library.cleanPhoto({ ...cleaned, revision: current.revision + 1 });
            storedOperation = structuredClone({
                ...operation,
                photoRevision: storedPhoto.revision,
            });
            photos.put(storedPhoto);
            tombstones.delete(cleaned.localId);
            previousOperationIds.forEach(operationId => operations.delete(operationId));
            operations.put(storedOperation);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return { photo: storedPhoto, operation: storedOperation };
    };

    const commitUploadOperation = async ({ photo, operationId }) => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned || !['uploaded', 'unreachable'].includes(cleaned.remote.state)
            || typeof operationId !== 'string') {
            throw new TypeError('photo store requires a clean uploaded photo and recovery operation');
        }
        const transaction = database.transaction([
            STORES.photos,
            STORES.secrets,
            STORES.operations,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const operations = transaction.objectStore(STORES.operations);
        let storedPhoto;
        let storedOperation;
        try {
            const [currentValue, operation] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(operations.get(operationId)),
            ]);
            const current = Library.cleanPhoto(currentValue);
            const secret = cleanDeleteUrl(operation?.deleteUrl);
            if (!current || current.deletedAt || current.revision !== cleaned.revision
                || !operation || operation.localId !== cleaned.localId
                || operation.state !== 'response-received' || !secret) {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            storedPhoto = Library.cleanPhoto({ ...cleaned, revision: current.revision + 1 });
            storedOperation = structuredClone({ ...operation, state: 'catalog-committed' });
            photos.put(storedPhoto);
            transaction.objectStore(STORES.secrets).put({
                localId: cleaned.localId,
                deleteUrl: secret,
            });
            operations.put(storedOperation);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return { photo: storedPhoto, operation: storedOperation };
    };

    const resetUploadOperation = async ({ photo, operationId }) => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned || cleaned.remote.state !== 'draft' || typeof operationId !== 'string') {
            throw new TypeError('photo store requires a retryable photo and recovery operation');
        }
        const transaction = database.transaction([STORES.photos, STORES.operations], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const operations = transaction.objectStore(STORES.operations);
        let storedPhoto;
        try {
            const [currentValue, operation] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(operations.get(operationId)),
            ]);
            const current = Library.cleanPhoto(currentValue);
            if (!current || current.deletedAt || current.remote.state !== 'uploading'
                || current.revision !== cleaned.revision
                || !operation || operation.localId !== cleaned.localId
                || operation.state !== 'request-started') {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            storedPhoto = Library.cleanPhoto({ ...cleaned, revision: current.revision + 1 });
            photos.put(storedPhoto);
            operations.delete(operationId);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return storedPhoto;
    };

    // Backup status has one independent owner. Updating only that field keeps
    // a report reference, deletion, or editor change that won a different
    // revision from being replaced by a whole stale catalog record.
    const updatePhotoBackup = async ({ localId, expectedRevision, backup }) => {
        if (typeof localId !== 'string' || !Number.isSafeInteger(expectedRevision)
            || expectedRevision < 0) {
            throw new TypeError('photo backup update requires an observed revision');
        }
        const transaction = database.transaction(STORES.photos, 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        let storedPhoto;
        try {
            const current = Library.cleanPhoto(await requestResult(photos.get(localId)));
            if (!current || current.revision !== expectedRevision) {
                throw new PhotoStoreConflictError(localId);
            }
            storedPhoto = Library.cleanPhoto({
                ...current,
                revision: current.revision + 1,
                backup,
            });
            if (!storedPhoto) throw new TypeError('photo backup update is invalid');
            photos.put(storedPhoto);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return storedPhoto;
    };

    const putOperation = async operation => {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)
            || typeof operation.localId !== 'string' || typeof operation.operationId !== 'string') {
            throw new TypeError('photo store requires an operation with ids');
        }
        const transaction = database.transaction(STORES.operations, 'readwrite');
        transaction.objectStore(STORES.operations).put(structuredClone(operation));
        await transactionDone(transaction);
    };

    const getOperations = async () => {
        const transaction = database.transaction(STORES.operations, 'readonly');
        const operations = await requestResult(transaction.objectStore(STORES.operations).getAll());
        await transactionDone(transaction);
        return operations;
    };

    const deleteOperation = async operationId => {
        const transaction = database.transaction(STORES.operations, 'readwrite');
        transaction.objectStore(STORES.operations).delete(operationId);
        await transactionDone(transaction);
    };

    // Version 3.4.0 wrote `uploading` before it wrote the journal, but never
    // contacted ImgBB until the journal succeeded. Such a record with no
    // operation is therefore a definite pre-request interruption and can be
    // returned to a retryable draft without claiming an unknown outcome.
    const recoverOrphanedUploads = async now => {
        const transaction = database.transaction([STORES.photos, STORES.operations], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const operations = transaction.objectStore(STORES.operations);
        let recovered = [];
        try {
            const [photoValues, operationValues] = await Promise.all([
                requestResult(photos.getAll()),
                requestResult(operations.getAll()),
            ]);
            const operatedIds = new Set(operationValues.map(value => value.localId));
            recovered = photoValues.map(Library.cleanPhoto).filter(Boolean)
                .filter(photo => photo.remote.state === 'uploading'
                    && !operatedIds.has(photo.localId));
            recovered.forEach(photo => {
                const reset = Library.resetUpload(photo, now);
                photos.put(Library.cleanPhoto({ ...reset, revision: photo.revision + 1 }));
            });
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return { recovered: recovered.length, localIds: recovered.map(photo => photo.localId) };
    };

    const removeLocalAssets = async (localId, now) => {
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        let cleaned;
        try {
            const photo = Library.cleanPhoto(await requestResult(photos.get(localId)));
            cleaned = Library.updateAssets(photo, {
                originalRetained: false,
                projectRetained: false,
                thumbnailRetained: false,
            }, now);
            if (!cleaned) throw new TypeError('photo store could not resolve the local photo');
            cleaned = Library.cleanPhoto({ ...cleaned, revision: photo.revision + 1 });
            photos.put(cleaned);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        transaction.objectStore(STORES.projects).delete(localId);
        transaction.objectStore(STORES.originals).delete(localId);
        transaction.objectStore(STORES.thumbnails).delete(localId);
        await transactionDone(transaction);
        return cleaned;
    };

    const pruneDeletedAssets = async ({ before, now, limit = 20 } = {}) => {
        const beforeTime = Date.parse(before);
        const updatedAt = typeof now === 'string' && Number.isFinite(Date.parse(now))
            ? new Date(now).toISOString()
            : null;
        if (!Number.isFinite(beforeTime) || !updatedAt
            || !Number.isInteger(limit) || limit < 1 || limit > MAX_MAINTENANCE_BATCH) {
            throw new TypeError('photo store requires a bounded maintenance request');
        }
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const values = await requestResult(photos.getAll());
        const eligible = values.map(Library.cleanPhoto).filter(Boolean)
            .filter(photo => photo.deletedAt && Date.parse(photo.deletedAt) <= beforeTime)
            .filter(photo => photo.assets.originalRetained
                || photo.assets.projectRetained
                || photo.assets.thumbnailRetained);
        const pruning = eligible.slice(0, limit);
        for (const photo of pruning) {
            const updated = Library.updateAssets(photo, {
                originalRetained: false,
                projectRetained: false,
                thumbnailRetained: false,
            }, updatedAt);
            photos.put(Library.cleanPhoto({ ...updated, revision: photo.revision + 1 }));
            transaction.objectStore(STORES.projects).delete(photo.localId);
            transaction.objectStore(STORES.originals).delete(photo.localId);
            transaction.objectStore(STORES.thumbnails).delete(photo.localId);
        }
        await transactionDone(transaction);
        return { pruned: pruning.length, remaining: Math.max(0, eligible.length - pruning.length) };
    };

    const purge = async localId => {
        const transaction = database.transaction(STORE_NAMES, 'readwrite');
        for (const storeName of STORE_NAMES) {
            if (storeName !== STORES.operations) transaction.objectStore(storeName).delete(localId);
        }
        const cursorRequest = transaction.objectStore(STORES.operations)
            .index('byLocalId').openKeyCursor(localId);
        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            transaction.objectStore(STORES.operations).delete(cursor.primaryKey);
            cursor.continue();
        };
        await transactionDone(transaction);
    };

    const applyRestore = async ({ records = [], tombstones = [], expectedRevisions = {} } = {}) => {
        if (!expectedRevisions || typeof expectedRevisions !== 'object'
            || Array.isArray(expectedRevisions)) {
            throw new TypeError('photo restore requires observed revisions');
        }
        const restored = records.map(value => {
            const photo = Library.cleanPhoto(value?.photo);
            const project = value?.project == null ? null : Project.cleanProject(value.project);
            if (!photo || (value?.project != null && (!project
                || project.localId !== photo.localId
                || project.image.sourceSha256 !== photo.source.sha256
                || !Project.matchingImageDimensions(project.image, photo.source)))) {
                throw new TypeError('photo restore contains an invalid record');
            }
            return { photo, project };
        });
        const deleted = tombstones.map(value => {
            const localId = typeof value?.localId === 'string' ? value.localId : '';
            const deletedAt = typeof value?.deletedAt === 'string'
                && Number.isFinite(Date.parse(value.deletedAt))
                ? new Date(value.deletedAt).toISOString()
                : null;
            if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(localId) || !deletedAt) {
                throw new TypeError('photo restore contains an invalid tombstone');
            }
            return { localId, deletedAt };
        });
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
            STORES.secrets,
            STORES.tombstones,
        ], 'readwrite');
        const stores = Object.fromEntries([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
            STORES.secrets,
            STORES.tombstones,
        ].map(name => [name, transaction.objectStore(name)]));

        const restoredLookups = restored.map(value => Promise.all([
            requestResult(stores[STORES.photos].get(value.photo.localId)),
            requestResult(stores[STORES.projects].get(value.photo.localId)),
            requestResult(stores[STORES.originals].get(value.photo.localId)),
            requestResult(stores[STORES.thumbnails].get(value.photo.localId)),
            requestResult(stores[STORES.tombstones].get(value.photo.localId)),
        ]));
        const tombstoneLookups = deleted.map(tombstone => Promise.all([
            requestResult(stores[STORES.photos].get(tombstone.localId)),
            requestResult(stores[STORES.tombstones].get(tombstone.localId)),
        ]));
        let restoredValues;
        let tombstoneValues;
        try {
            [restoredValues, tombstoneValues] = await Promise.all([
                Promise.all(restoredLookups),
                Promise.all(tombstoneLookups),
            ]);
            const assertObservedRevision = (localId, current, tombstone) => {
                const observed = Object.hasOwn(expectedRevisions, localId)
                    ? expectedRevisions[localId]
                    : null;
                const currentRevision = Math.max(
                    current?.revision ?? 0,
                    tombstoneRevision(tombstone),
                );
                if ((currentRevision > 0 && observed !== currentRevision)
                    || (currentRevision === 0 && observed != null && observed !== 0)) {
                    throw new PhotoStoreConflictError(localId);
                }
            };
            restoredValues.forEach((values, index) => {
                assertObservedRevision(
                    restored[index].photo.localId,
                    Library.cleanPhoto(values[0]),
                    values[4],
                );
            });
            tombstoneValues.forEach((values, index) => {
                assertObservedRevision(
                    deleted[index].localId,
                    Library.cleanPhoto(values[0]),
                    values[1],
                );
            });
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }

        restored.forEach((value, index) => {
            const [existingPhoto, existingProject, original, thumbnail, tombstone] = restoredValues[index];
            const existing = Library.cleanPhoto(existingPhoto);
            const cleanExistingProject = Project.cleanProject(existingProject);
            const sameSource = existing?.source.sha256 === value.photo.source.sha256
                && Project.matchingImageDimensions(existing.source, value.photo.source);
            const sameProject = sameSource
                && cleanExistingProject?.image.sourceSha256 === value.photo.source.sha256
                && Project.matchingImageDimensions(cleanExistingProject.image, value.photo.source);
            const sameRemote = existing?.remote.providerId
                && existing.remote.providerId === value.photo.remote.providerId;
            const photo = Library.cleanPhoto({
                ...value.photo,
                revision: nextRevision(existing, tombstone),
                assets: {
                    originalRetained: !!original?.blob && sameSource,
                    projectRetained: !!value.project || !!sameProject,
                    thumbnailRetained: !!thumbnail?.blob && sameSource,
                },
                deletedAt: null,
            });
            stores[STORES.photos].put(photo);
            if (value.project) stores[STORES.projects].put(value.project);
            else if (!sameProject) stores[STORES.projects].delete(photo.localId);
            if (!sameSource) {
                stores[STORES.originals].delete(photo.localId);
                stores[STORES.thumbnails].delete(photo.localId);
            }
            if (!sameRemote) stores[STORES.secrets].delete(photo.localId);
            stores[STORES.tombstones].delete(photo.localId);
        });

        deleted.forEach((tombstone, index) => {
            const [existingValue, existingTombstone] = tombstoneValues[index];
            const existing = Library.cleanPhoto(existingValue);
            const revision = nextRevision(existing, existingTombstone);
            if (existing && (!existing.deletedAt || existing.deletedAt < tombstone.deletedAt)) {
                stores[STORES.photos].put(Library.cleanPhoto({
                    ...Library.markDeleted(existing, tombstone.deletedAt),
                    revision,
                }));
            }
            if (!existingTombstone || existingTombstone.deletedAt < tombstone.deletedAt) {
                stores[STORES.tombstones].put({ ...tombstone, revision });
            }
        });
        await transactionDone(transaction);
    };

    return {
        getBundle,
        listPhotos,
        getThumbnails,
        listBackupBundles,
        putDraft,
        putBundle,
        putPhoto,
        restorePhoto,
        beginUploadOperation,
        commitUploadOperation,
        resetUploadOperation,
        updatePhotoBackup,
        putOperation,
        getOperations,
        deleteOperation,
        recoverOrphanedUploads,
        removeLocalAssets,
        pruneDeletedAssets,
        purge,
        applyRestore,
        close: () => database.close(),
    };
};

export const photoStore = {
    DATABASE_NAME,
    DATABASE_VERSION,
    STORES,
    PhotoStoreConflictError,
    openDatabase,
    createPhotoStore,
};
