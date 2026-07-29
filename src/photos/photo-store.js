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

const createPhotoStore = async options => {
    const database = await openDatabase(options);

    const read = async (storeName, localId) => {
        const transaction = database.transaction(storeName, 'readonly');
        const result = await requestResult(transaction.objectStore(storeName).get(localId));
        await transactionDone(transaction);
        return result ?? null;
    };

    const putDraft = async ({ photo, project, original, thumbnail }) => {
        const cleanPhoto = Library.cleanPhoto(photo);
        const cleanProject = Project.cleanProject(project);
        const cleanOriginal = cleanBlobRecord(original, cleanPhoto?.localId);
        const cleanThumbnail = cleanBlobRecord(thumbnail, cleanPhoto?.localId);
        if (!cleanPhoto || !cleanProject || cleanPhoto.localId !== cleanProject.localId
            || !cleanOriginal || !cleanThumbnail || !EDITABLE_STATES.has(cleanPhoto.remote.state)) {
            throw new TypeError('photo store requires a matching clean draft, project, and blobs');
        }
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
        ], 'readwrite');
        transaction.objectStore(STORES.photos).put(cleanPhoto);
        transaction.objectStore(STORES.projects).put(cleanProject);
        transaction.objectStore(STORES.originals).put(cleanOriginal);
        transaction.objectStore(STORES.thumbnails).put(cleanThumbnail);
        await transactionDone(transaction);
        return cleanPhoto;
    };

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
            tombstones,
        };
    };

    const putPhoto = async photo => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned) throw new TypeError('photo store requires a clean photo');
        const transaction = database.transaction([STORES.photos, STORES.tombstones], 'readwrite');
        transaction.objectStore(STORES.photos).put(cleaned);
        if (cleaned.deletedAt) {
            transaction.objectStore(STORES.tombstones).put({
                localId: cleaned.localId,
                deletedAt: cleaned.deletedAt,
            });
        } else {
            transaction.objectStore(STORES.tombstones).delete(cleaned.localId);
        }
        await transactionDone(transaction);
        return cleaned;
    };

    const commitUpload = async ({ photo, deleteUrl }) => {
        const cleaned = Library.cleanPhoto(photo);
        const secret = cleanDeleteUrl(deleteUrl);
        if (!cleaned || !['uploaded', 'unreachable'].includes(cleaned.remote.state) || !secret) {
            throw new TypeError('photo store requires a clean uploaded photo and deletion URL');
        }
        const transaction = database.transaction([STORES.photos, STORES.secrets], 'readwrite');
        transaction.objectStore(STORES.photos).put(cleaned);
        transaction.objectStore(STORES.secrets).put({ localId: cleaned.localId, deleteUrl: secret });
        await transactionDone(transaction);
        return cleaned;
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

    const removeLocalAssets = async (localId, now) => {
        const photo = await read(STORES.photos, localId);
        const cleaned = Library.updateAssets(photo, {
            originalRetained: false,
            projectRetained: false,
            thumbnailRetained: false,
        }, now);
        if (!cleaned) throw new TypeError('photo store could not resolve the local photo');
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
        ], 'readwrite');
        transaction.objectStore(STORES.photos).put(cleaned);
        transaction.objectStore(STORES.projects).delete(localId);
        transaction.objectStore(STORES.originals).delete(localId);
        transaction.objectStore(STORES.thumbnails).delete(localId);
        await transactionDone(transaction);
        return cleaned;
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

    const applyRestore = async ({ records = [], tombstones = [] } = {}) => {
        const restored = records.map(value => {
            const photo = Library.cleanPhoto(value?.photo);
            const project = value?.project == null ? null : Project.cleanProject(value.project);
            if (!photo || (value?.project != null && (!project || project.localId !== photo.localId))) {
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
        ]));
        const tombstoneLookups = deleted.map(tombstone =>
            requestResult(stores[STORES.photos].get(tombstone.localId)));
        const restoredValues = await Promise.all(restoredLookups);
        const tombstoneValues = await Promise.all(tombstoneLookups);

        restored.forEach((value, index) => {
            const [existingPhoto, existingProject, original, thumbnail] = restoredValues[index];
            const existing = Library.cleanPhoto(existingPhoto);
            const sameSource = existing?.source.sha256 === value.photo.source.sha256;
            const sameRemote = existing?.remote.providerId
                && existing.remote.providerId === value.photo.remote.providerId;
            const photo = Library.cleanPhoto({
                ...value.photo,
                assets: {
                    originalRetained: !!original?.blob && sameSource,
                    projectRetained: !!value.project || (!!existingProject && sameSource),
                    thumbnailRetained: !!thumbnail?.blob && sameSource,
                },
                deletedAt: null,
            });
            stores[STORES.photos].put(photo);
            if (value.project) stores[STORES.projects].put(value.project);
            else if (!sameSource) stores[STORES.projects].delete(photo.localId);
            if (!sameSource) {
                stores[STORES.originals].delete(photo.localId);
                stores[STORES.thumbnails].delete(photo.localId);
            }
            if (!sameRemote) stores[STORES.secrets].delete(photo.localId);
            stores[STORES.tombstones].delete(photo.localId);
        });

        deleted.forEach((tombstone, index) => {
            const existing = Library.cleanPhoto(tombstoneValues[index]);
            if (existing && (!existing.deletedAt || existing.deletedAt < tombstone.deletedAt)) {
                stores[STORES.photos].put(Library.markDeleted(existing, tombstone.deletedAt));
            }
            stores[STORES.tombstones].put(tombstone);
        });
        await transactionDone(transaction);
    };

    return {
        getBundle,
        listPhotos,
        listBackupBundles,
        putDraft,
        putPhoto,
        commitUpload,
        putOperation,
        getOperations,
        deleteOperation,
        removeLocalAssets,
        purge,
        applyRestore,
        close: () => database.close(),
    };
};

export const photoStore = {
    DATABASE_NAME,
    DATABASE_VERSION,
    STORES,
    openDatabase,
    createPhotoStore,
};
