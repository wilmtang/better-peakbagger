// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — IndexedDB ownership for local photo records and blobs.

import { photoProject as Project } from './photo-project.ts';
import { photoLibrary as Library } from './photo-library.ts';
import { cleanPhotoUrl as cleanDeleteUrl } from './photo-url.ts';

type PhotoRecord = NonNullable<ReturnType<typeof Library.cleanPhoto>>;
type PhotoProjectRecord = NonNullable<ReturnType<typeof Project.cleanProject>>;

export interface PhotoCatalogState {
    key: 'catalog';
    generation: number;
    confirmedGeneration: number;
    signature: string | null;
    commitUrl: string | null;
    backedUpAt: string | null;
    revisions: Record<string, number>;
}

export interface OpenPhotoDatabaseOptions {
    indexedDB?: IDBFactory;
    name?: string;
    onVersionChange?: ((event: IDBVersionChangeEvent) => void) | null;
}

export interface PhotoBundleInput {
    photo: unknown;
    project: unknown;
    original: unknown;
    thumbnail: unknown;
}

export interface PhotoBundleRecord {
    photo: PhotoRecord | null;
    project: PhotoProjectRecord | null;
    original: Blob | null;
    thumbnail: Blob | null;
    deleteUrl: string | null;
}

export interface PhotoReportImageExport {
    mime?: string;
    bytes?: number;
    width?: number;
    height?: number;
    sha256?: string;
}

export interface PutReportImageInput {
    localId: string;
    owner: string;
    dataUrl: string;
    exported: PhotoReportImageExport;
    revision: number;
    replacesLocalPhotoId?: string | null;
}

export interface PhotoReportImageRecord {
    key: string;
    localId: string;
    owner: string;
    dataUrl: string;
    exported: PhotoReportImageExport;
    revision: number;
    content: string;
}

export interface PhotoUploadOperationRecord {
    operationId: string;
    localId: string;
    state: string;
    photoRevision?: number;
    deleteUrl?: string | null;
    returnToken?: string | null;
    export?: object;
    displayWidth?: number | null;
    updatedAt?: string;
    [key: string]: unknown;
}

export interface PhotoBackupBundleEntry {
    photo: PhotoRecord;
    project: PhotoProjectRecord | null;
}

export interface PhotoTombstoneEntry {
    localId: string;
    deletedAt: string;
}

export interface PhotoBackupBundlesResult {
    bundles: PhotoBackupBundleEntry[];
    tombstones: PhotoTombstoneEntry[];
    revisions: Record<string, number>;
    catalog: PhotoCatalogState;
}

export interface ConfirmCatalogBackupInput {
    generation?: number;
    signature?: string;
    revisions?: Record<string, number>;
    commitUrl?: string | null;
    backedUpAt?: string;
}

export interface UpdatePhotoBackupInput {
    localId: string;
    expectedRevision: number;
    backup: unknown;
}

export interface UpdatePhotoBackupsInput {
    localIds?: readonly string[];
    expectedRevisions?: Record<string, number>;
    backup?: unknown;
    batchSize?: number;
}

export interface UpdatePhotoBackupsResult {
    conflicts: string[];
    changed: number;
    transactions: number;
    maxBatchSize: number;
}

export interface RecoverOrphanedUploadsResult {
    recovered: number;
    localIds: string[];
}

export interface PruneDeletedAssetsOptions {
    before?: string;
    now?: string;
    limit?: number;
}

export interface PruneDeletedAssetsResult {
    pruned: number;
    remaining: number;
    nextDeletedAt?: string | null;
}

export interface ApplyRestoreRecordInput {
    photo?: unknown;
    project?: unknown;
}

export interface ApplyRestoreTombstoneInput {
    localId?: unknown;
    deletedAt?: unknown;
}

export interface ApplyRestoreInput {
    records?: readonly ApplyRestoreRecordInput[];
    tombstones?: readonly ApplyRestoreTombstoneInput[];
    expectedRevisions?: Record<string, number>;
}

interface StoredReportPhotoRecord {
    deletedAt?: string | null;
    remote?: { state?: string };
    revision?: number;
    title?: string;
    alt?: string;
    caption?: string | null;
}

interface StoredReportAcceptedRecord {
    owner?: string;
}

const DATABASE_NAME = 'betterPeakbaggerPhotos';
const DATABASE_VERSION = 4;
const STORES = Object.freeze({
    photos: 'photos',
    projects: 'projects',
    originals: 'originals',
    thumbnails: 'thumbnails',
    operations: 'operations',
    secrets: 'secrets',
    tombstones: 'tombstones',
    metadata: 'metadata',
});
const STORE_NAMES = Object.freeze(Object.values(STORES));
const MAX_THUMBNAIL_BATCH = 100;
const MAX_MAINTENANCE_BATCH = 50;
const MAX_BACKUP_RECONCILIATION_BATCH = 50;
const CATALOG_STATE_KEY = 'catalog';
const DELETED_AT_INDEX = 'byDeletedAt';

class PhotoStoreConflictError extends Error {
    readonly code: 'photo-conflict';
    readonly localId: string;

    constructor(localId: string, message = 'The photo changed in another tab. Reload it and try again.') {
        super(message);
        this.name = 'PhotoStoreConflictError';
        this.code = 'photo-conflict';
        this.localId = localId;
    }
}

const recordFields = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? value as Record<string, unknown> : {};

type SafeIdbResult<T> = 0 extends (1 & T)
    ? unknown
    : T extends (infer Item)[]
        ? (0 extends (1 & Item) ? unknown[] : T)
        : T;

const requestResult = <T>(request: IDBRequest<T>): Promise<SafeIdbResult<T>> => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as SafeIdbResult<T>);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
});

const openDatabase = ({
    indexedDB = globalThis.indexedDB,
    name = DATABASE_NAME,
    onVersionChange = null,
}: OpenPhotoDatabaseOptions = {}): Promise<IDBDatabase> => {
    if (!indexedDB?.open) return Promise.reject(new Error('IndexedDB is unavailable.'));
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, DATABASE_VERSION);
        let settled = false;
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
            const database = request.result;
            for (const storeName of STORE_NAMES) {
                if (!database.objectStoreNames.contains(storeName)) {
                    const store = database.createObjectStore(storeName, {
                        keyPath: storeName === STORES.operations
                            ? 'operationId'
                            : storeName === STORES.metadata ? 'key' : 'localId',
                    });
                    if (storeName === STORES.operations) {
                        store.createIndex('byLocalId', 'localId', { unique: false });
                    }
                    if (storeName === STORES.metadata) {
                        store.put({
                            key: CATALOG_STATE_KEY,
                            generation: event.oldVersion > 0 ? 1 : 0,
                            confirmedGeneration: 0,
                            signature: null,
                            commitUrl: null,
                            backedUpAt: null,
                            revisions: {},
                        });
                    }
                }
            }
            const photos = request.transaction?.objectStore(STORES.photos);
            if (photos && !photos.indexNames.contains(DELETED_AT_INDEX)) {
                photos.createIndex(DELETED_AT_INDEX, 'deletedAt', { unique: false });
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            if (settled) {
                database.close();
                return;
            }
            settled = true;
            database.onversionchange = (event: IDBVersionChangeEvent) => {
                database.close();
                try { onVersionChange?.(event); } catch {}
            };
            resolve(database);
        };
        request.onerror = () => fail(request.error || new Error('Could not open the photo library.'));
        request.onblocked = () => fail(new Error('Photo library upgrade is blocked by another tab.'));
    });
};

const cleanBlobRecord = (value: unknown, localId: string | undefined): { localId: string; blob: Blob } | null =>
    value instanceof Blob && localId
        ? { localId, blob: value }
        : null;

// The local original stays authoritative until ImgBB confirms a URL, so a
// draft write covers every pre-upload state — exactly the states for which
// `cleanPhoto` keeps `export` null. `outcome-unknown` belongs here: the editor
// has to be able to re-save an ambiguous upload before retrying it.
const EDITABLE_STATES = new Set(['draft', 'uploading', 'outcome-unknown']);

const tombstoneRevision = (value: unknown): number => {
    const revision = recordFields(value).revision;
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
        ? revision
        : 0;
};

const nextRevision = (photo: { revision: number } | null | undefined, tombstone: unknown): number => Math.max(
    photo?.revision ?? 0,
    tombstoneRevision(tombstone),
) + 1;

const cleanCatalogState = (value: unknown): PhotoCatalogState => {
    const raw = recordFields(value);
    const generation = typeof raw.generation === 'number' && Number.isSafeInteger(raw.generation) && raw.generation >= 0
        ? raw.generation
        : 0;
    const confirmedGeneration = typeof raw.confirmedGeneration === 'number'
        && Number.isSafeInteger(raw.confirmedGeneration)
        && raw.confirmedGeneration >= 0
        && raw.confirmedGeneration <= generation
        ? raw.confirmedGeneration
        : 0;
    return {
        key: CATALOG_STATE_KEY,
        generation,
        confirmedGeneration,
        signature: typeof raw.signature === 'string' ? raw.signature : null,
        commitUrl: cleanDeleteUrl(raw.commitUrl),
        backedUpAt: typeof raw.backedUpAt === 'string'
            && Number.isFinite(Date.parse(raw.backedUpAt))
            ? new Date(raw.backedUpAt).toISOString()
            : null,
        revisions: raw.revisions && typeof raw.revisions === 'object'
            && !Array.isArray(raw.revisions)
            ? structuredClone(raw.revisions) as Record<string, number>
            : {},
    };
};

const advanceCatalog = (metadata: IDBObjectStore, state: PhotoCatalogState): PhotoCatalogState => {
    const next: PhotoCatalogState = { ...state, generation: state.generation + 1 };
    metadata.put(next);
    return next;
};

const recoveryPhotoIdentity = (value: unknown): string | null => {
    const photo = Library.cleanPhoto(value);
    if (!photo) return null;
    if (photo.deletedAt) {
        return JSON.stringify({ kind: 'tombstone', localId: photo.localId, deletedAt: photo.deletedAt });
    }
    return JSON.stringify({
        kind: 'photo',
        schemaVersion: photo.schemaVersion,
        localId: photo.localId,
        createdAt: photo.createdAt,
        updatedAt: photo.updatedAt,
        title: photo.title,
        alt: photo.alt,
        ...(photo.caption ? { caption: photo.caption } : {}),
        source: photo.source,
        export: photo.export,
        remote: photo.remote,
        lineage: photo.lineage,
        references: photo.references,
    });
};

const recoveryBundleIdentity = (photo: unknown, project: unknown): string => {
    const cleaned = Library.cleanPhoto(photo);
    return JSON.stringify({
        photo: recoveryPhotoIdentity(photo),
        project: cleaned?.deletedAt ? null : Project.cleanProject(project),
    });
};

const presentPhoto = (value: unknown, catalog: PhotoCatalogState): PhotoRecord | null => {
    const photo = Library.cleanPhoto(value);
    if (!photo || catalog.generation === catalog.confirmedGeneration
        || !['current', 'restored'].includes(photo.backup.state)) return photo;
    return Library.cleanPhoto({
        ...photo,
        backup: { state: 'pending', signature: null, backedUpAt: null, commitUrl: null },
    });
};

const abortAndRethrow = async (transaction: IDBTransaction, error: unknown): Promise<never> => {
    try { transaction.abort(); } catch {}
    await transactionDone(transaction).catch(() => {});
    throw error;
};

const createPhotoStore = async (options?: OpenPhotoDatabaseOptions) => {
    const database = await openDatabase(options);

    // One record, its project, and its local pixels, written together. The
    // editor goes through putDraft, which additionally refuses a published
    // record; importing a downloaded bundle cannot, because the bundle may
    // carry a record ImgBB has already published and refusing it would strand
    // the round trip that Download project promised.
    const putBundle = async (
        { photo, project, original, thumbnail }: PhotoBundleInput,
        { editableOnly = false }: { editableOnly?: boolean } = {},
    ): Promise<PhotoRecord> => {
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
            STORES.metadata,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        const projects = transaction.objectStore(STORES.projects);
        const metadata = transaction.objectStore(STORES.metadata);
        let storedPhoto: PhotoRecord;
        try {
            const [currentValue, currentProject, tombstone, catalogValue] = await Promise.all([
                requestResult(photos.get(cleanPhoto.localId)),
                requestResult(projects.get(cleanPhoto.localId)),
                requestResult(tombstones.get(cleanPhoto.localId)),
                requestResult(metadata.get(CATALOG_STATE_KEY)),
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
            if (editableOnly && current && (!EDITABLE_STATES.has(current.remote.state)
                || current.source.sha256 !== cleanPhoto.source.sha256
                || !current.assets.originalRetained || !current.assets.projectRetained)) {
                throw new PhotoStoreConflictError(cleanPhoto.localId,
                    'This photo can no longer be edited in place.');
            }
            const nextStored = Library.cleanPhoto({
                ...cleanPhoto,
                revision: nextRevision(current, tombstone),
            });
            if (!nextStored) throw new TypeError('photo store could not save the photo');
            storedPhoto = nextStored;
            photos.put(storedPhoto);
            if (recoveryBundleIdentity(current, currentProject)
                !== recoveryBundleIdentity(storedPhoto, cleanProject)) {
                advanceCatalog(metadata, cleanCatalogState(catalogValue));
            }
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        projects.put(cleanProject);
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

    const putDraft = (bundle: PhotoBundleInput): Promise<PhotoRecord> => putBundle(bundle, { editableOnly: true });

    // Local report snapshots are private device data, excluded from catalog
    // backup. Tie the flattened pixels to the exact editable photo revision.
    const putReportImage = async ({
        localId,
        owner,
        dataUrl,
        exported,
        revision,
        replacesLocalPhotoId = null,
    }: PutReportImageInput): Promise<void> => {
        const transaction = database.transaction([STORES.photos, STORES.projects, STORES.metadata], 'readwrite');
        try {
            const photo = await requestResult(
                transaction.objectStore(STORES.photos).get(localId)) as StoredReportPhotoRecord | undefined;
            if (!photo || photo.deletedAt || photo.remote?.state !== 'draft' || photo.revision !== revision) {
                throw new PhotoStoreConflictError(localId);
            }
            if (replacesLocalPhotoId) {
                const parent = await requestResult(
                    transaction.objectStore(STORES.photos).get(replacesLocalPhotoId)) as StoredReportPhotoRecord | undefined;
                const accepted = await requestResult(
                    transaction.objectStore(STORES.metadata).get(`report-image:${replacesLocalPhotoId}`)) as StoredReportAcceptedRecord | undefined;
                if (!parent || parent.deletedAt || !accepted || accepted.owner !== owner) {
                    throw new PhotoStoreConflictError(replacesLocalPhotoId);
                }
            }
            const project = await requestResult(
                transaction.objectStore(STORES.projects).get(localId)) as Record<string, unknown> | undefined;
            transaction.objectStore(STORES.metadata).put({
                key: `report-image:${localId}`, localId, owner, dataUrl, exported, revision,
                content: JSON.stringify({
                    project: { ...project, updatedAt: null },
                    title: photo.title,
                    alt: photo.alt,
                    ...(photo.caption ? { caption: photo.caption } : {}),
                }),
            });
        } catch (error) { return abortAndRethrow(transaction, error); }
        await transactionDone(transaction);
    };
    const getReportImage = async (localId: string): Promise<PhotoReportImageRecord | null> => {
        const transaction = database.transaction(STORES.metadata, 'readonly');
        const value = await requestResult(
            transaction.objectStore(STORES.metadata).get(`report-image:${localId}`)) as PhotoReportImageRecord | undefined;
        await transactionDone(transaction);
        return value || null;
    };

    const getBundle = async (localId: string): Promise<PhotoBundleRecord> => {
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
            STORES.secrets,
            STORES.metadata,
        ], 'readonly');
        const [photoValue, projectValue, originalValue, thumbnailValue, secretValue, catalogValue] = await Promise.all([
            requestResult(transaction.objectStore(STORES.photos).get(localId)),
            requestResult(transaction.objectStore(STORES.projects).get(localId)),
            requestResult(transaction.objectStore(STORES.originals).get(localId)),
            requestResult(transaction.objectStore(STORES.thumbnails).get(localId)),
            requestResult(transaction.objectStore(STORES.secrets).get(localId)),
            requestResult(transaction.objectStore(STORES.metadata).get(CATALOG_STATE_KEY)),
        ]);
        await transactionDone(transaction);
        const catalog = cleanCatalogState(catalogValue);
        const originalBlob = recordFields(originalValue).blob;
        const thumbnailBlob = recordFields(thumbnailValue).blob;
        return {
            photo: photoValue ? presentPhoto(photoValue, catalog) : null,
            project: projectValue ? Project.cleanProject(projectValue) : null,
            original: originalBlob instanceof Blob ? originalBlob : null,
            thumbnail: thumbnailBlob instanceof Blob ? thumbnailBlob : null,
            deleteUrl: cleanDeleteUrl(recordFields(secretValue).deleteUrl),
        };
    };

    const listPhotos = async ({ includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<PhotoRecord[]> => {
        const transaction = database.transaction([STORES.photos, STORES.metadata], 'readonly');
        const [values, catalogValue] = await Promise.all([
            requestResult(transaction.objectStore(STORES.photos).getAll()),
            requestResult(transaction.objectStore(STORES.metadata).get(CATALOG_STATE_KEY)),
        ]);
        await transactionDone(transaction);
        const catalog = cleanCatalogState(catalogValue);
        return values.map(value => presentPhoto(value, catalog))
            .filter((photo): photo is PhotoRecord => photo !== null)
            .filter(photo => includeDeleted || !photo.deletedAt)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    };

    // Keep one editable bundle per source image. Historical public URLs and
    // report associations remain catalog records. Pending report snapshots,
    // upload recovery, and Recently Deleted retain their own recovery data.
    const pruneSupersededVersions = async (): Promise<number> => {
        const transaction = database.transaction([
            STORES.photos, STORES.projects, STORES.originals, STORES.thumbnails,
            STORES.operations, STORES.metadata,
        ], 'readwrite');
        let pruned = 0;
        try {
            const photos = transaction.objectStore(STORES.photos);
            const metadata = transaction.objectStore(STORES.metadata);
            const [values, projects, originals, operations, metadataKeys, catalogValue] = await Promise.all([
                requestResult(photos.getAll()),
                requestResult(transaction.objectStore(STORES.projects).getAll()),
                requestResult(transaction.objectStore(STORES.originals).getAllKeys()),
                requestResult(transaction.objectStore(STORES.operations).getAll()),
                requestResult(metadata.getAllKeys()),
                requestResult(metadata.get(CATALOG_STATE_KEY)),
            ]);
            const projectsById = new Map(projects.map(value => [
                recordFields(value).localId,
                Project.cleanProject(value),
            ]));
            const originalIds = new Set(originals);
            const operationIds = new Set((operations as PhotoUploadOperationRecord[]).map(value => value.localId));
            const reportIds = new Set(metadataKeys
                .filter((key): key is string => typeof key === 'string' && key.startsWith('report-image:'))
                .map(key => key.slice('report-image:'.length)));
            const latestByHash = new Map(Library.latestPhotos(values).map(photo => [photo.source.sha256, photo]));
            for (const value of values) {
                const photo = Library.cleanPhoto(value);
                const latest = photo && latestByHash.get(photo.source.sha256);
                const latestProject = latest && projectsById.get(latest.localId);
                if (!photo || photo.deletedAt || !latest || latest.localId === photo.localId
                    || !latest.assets.originalRetained || !latest.assets.projectRetained
                    || !originalIds.has(latest.localId) || !latestProject
                    || latestProject.image.sourceSha256 !== latest.source.sha256
                    || !Project.matchingImageDimensions(latestProject.image, latest.source)
                    || operationIds.has(photo.localId)
                    || !['draft', 'uploaded', 'unreachable'].includes(photo.remote.state)
                    || (photo.remote.state === 'draft' && reportIds.has(photo.localId))
                    || !Object.values(photo.assets).some(Boolean)) continue;
                const updated = Library.cleanPhoto({
                    ...Library.updateAssets(photo, {
                        originalRetained: false, projectRetained: false, thumbnailRetained: false,
                    }),
                    revision: photo.revision + 1,
                });
                if (updated) photos.put(updated);
                for (const name of [STORES.projects, STORES.originals, STORES.thumbnails]) {
                    transaction.objectStore(name).delete(photo.localId);
                }
                pruned += 1;
            }
            if (pruned) advanceCatalog(metadata, cleanCatalogState(catalogValue));
        } catch (error) { return abortAndRethrow(transaction, error); }
        await transactionDone(transaction);
        return pruned;
    };

    const getThumbnails = async (localIds: unknown): Promise<Map<string, Blob | null>> => {
        const ids = Array.isArray(localIds)
            ? [...new Set(localIds.filter((value): value is string => typeof value === 'string'))]
            : [];
        if (ids.length > MAX_THUMBNAIL_BATCH) {
            throw new TypeError('photo store thumbnail batch is too large');
        }
        if (!ids.length) return new Map();
        const transaction = database.transaction(STORES.thumbnails, 'readonly');
        const store = transaction.objectStore(STORES.thumbnails);
        const values = await Promise.all(ids.map(async (localId): Promise<[string, unknown]> => [
            localId,
            await requestResult(store.get(localId)),
        ]));
        await transactionDone(transaction);
        return new Map(values.map(([localId, value]) => {
            const blob = recordFields(value).blob;
            return [localId, blob instanceof Blob ? blob : null];
        }));
    };

    const listBackupBundles = async (): Promise<PhotoBackupBundlesResult> => {
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.tombstones,
            STORES.metadata,
        ], 'readonly');
        const [photos, projects, rawTombstones, catalogValue] = await Promise.all([
            requestResult(transaction.objectStore(STORES.photos).getAll()),
            requestResult(transaction.objectStore(STORES.projects).getAll()),
            requestResult(transaction.objectStore(STORES.tombstones).getAll()),
            requestResult(transaction.objectStore(STORES.metadata).get(CATALOG_STATE_KEY)),
        ]);
        const tombstones = rawTombstones as Array<{ localId: string; deletedAt: string; revision?: number }>;
        await transactionDone(transaction);
        const projectsById = new Map(projects.map(value => [
            recordFields(value).localId,
            Project.cleanProject(value),
        ]));
        return {
            bundles: photos.map(Library.cleanPhoto)
                .filter((photo): photo is PhotoRecord => photo !== null)
                .map(photo => ({
                    photo,
                    project: projectsById.get(photo.localId) || null,
                })),
            tombstones: tombstones.map(value => ({
                localId: value.localId,
                deletedAt: value.deletedAt,
            })),
            revisions: Object.fromEntries([
                ...photos.map(value => [String(recordFields(value).localId), Library.cleanPhoto(value)?.revision ?? 0] as const),
                ...tombstones.map(value => [value.localId, tombstoneRevision(value)] as const),
            ]),
            catalog: cleanCatalogState(catalogValue),
        };
    };

    const getCatalogState = async (): Promise<PhotoCatalogState> => {
        const transaction = database.transaction(STORES.metadata, 'readonly');
        const value = await requestResult(
            transaction.objectStore(STORES.metadata).get(CATALOG_STATE_KEY));
        await transactionDone(transaction);
        return cleanCatalogState(value);
    };

    const confirmCatalogBackup = async ({
        generation,
        signature,
        revisions,
        commitUrl = null,
        backedUpAt,
    }: ConfirmCatalogBackupInput = {}): Promise<PhotoCatalogState> => {
        if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0
            || typeof signature !== 'string'
            || !revisions || typeof revisions !== 'object' || Array.isArray(revisions)
            || typeof backedUpAt !== 'string' || !Number.isFinite(Date.parse(backedUpAt))) {
            throw new TypeError('photo catalog confirmation is invalid');
        }
        const transaction = database.transaction(STORES.metadata, 'readwrite');
        const metadata = transaction.objectStore(STORES.metadata);
        const current = cleanCatalogState(await requestResult(metadata.get(CATALOG_STATE_KEY)));
        if (generation > current.generation) {
            return abortAndRethrow(transaction, new TypeError('photo catalog generation is in the future'));
        }
        const confirmed = cleanCatalogState({
            ...current,
            confirmedGeneration: generation,
            signature,
            revisions,
            commitUrl,
            backedUpAt,
        });
        metadata.put(confirmed);
        await transactionDone(transaction);
        return confirmed;
    };

    const putPhoto = async (photo: unknown): Promise<PhotoRecord> => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned) throw new TypeError('photo store requires a clean photo');
        const transaction = database.transaction([
            STORES.photos,
            STORES.tombstones,
            STORES.metadata,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        const metadata = transaction.objectStore(STORES.metadata);
        let storedPhoto: PhotoRecord;
        try {
            const [currentValue, tombstone, catalogValue] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(tombstones.get(cleaned.localId)),
                requestResult(metadata.get(CATALOG_STATE_KEY)),
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
            const nextStored = Library.cleanPhoto({
                ...cleaned,
                revision: nextRevision(current, tombstone),
            });
            if (!nextStored) throw new TypeError('photo store could not save the photo');
            storedPhoto = nextStored;
            photos.put(storedPhoto);
            if (recoveryPhotoIdentity(current) !== recoveryPhotoIdentity(storedPhoto)) {
                advanceCatalog(metadata, cleanCatalogState(catalogValue));
            }
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

    const restorePhoto = async (
        photo: unknown,
        { retainAssets = true }: { retainAssets?: boolean } = {},
    ): Promise<PhotoRecord> => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned || cleaned.deletedAt || typeof retainAssets !== 'boolean') {
            throw new TypeError('photo store requires a clean restored photo');
        }
        const restoreStores = retainAssets
            ? [STORES.photos, STORES.tombstones, STORES.metadata]
            : [STORES.photos, STORES.tombstones, STORES.projects, STORES.originals,
                STORES.thumbnails, STORES.metadata];
        const transaction = database.transaction(restoreStores, 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        const metadata = transaction.objectStore(STORES.metadata);
        let storedPhoto: PhotoRecord;
        try {
            const [currentValue, tombstone, catalogValue] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(tombstones.get(cleaned.localId)),
                requestResult(metadata.get(CATALOG_STATE_KEY)),
            ]);
            const current = Library.cleanPhoto(currentValue);
            if (!current?.deletedAt || current.revision !== cleaned.revision || !tombstone) {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            const restored = retainAssets ? cleaned : Library.updateAssets(cleaned, {
                originalRetained: false,
                projectRetained: false,
                thumbnailRetained: false,
            });
            const nextStored = restored ? Library.cleanPhoto({
                ...restored,
                revision: nextRevision(current, tombstone),
            }) : null;
            if (!nextStored) throw new TypeError('photo store could not restore the photo');
            storedPhoto = nextStored;
            photos.put(storedPhoto);
            if (recoveryPhotoIdentity(current) !== recoveryPhotoIdentity(storedPhoto)) {
                advanceCatalog(metadata, cleanCatalogState(catalogValue));
            }
            tombstones.delete(cleaned.localId);
            if (!retainAssets) {
                transaction.objectStore(STORES.projects).delete(cleaned.localId);
                transaction.objectStore(STORES.originals).delete(cleaned.localId);
                transaction.objectStore(STORES.thumbnails).delete(cleaned.localId);
            }
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return storedPhoto;
    };

    const beginUploadOperation = async ({
        photo,
        operation,
    }: {
        photo: unknown;
        operation: PhotoUploadOperationRecord;
    }): Promise<{ photo: PhotoRecord; operation: PhotoUploadOperationRecord }> => {
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
            STORES.metadata,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        const operations = transaction.objectStore(STORES.operations);
        const metadata = transaction.objectStore(STORES.metadata);
        let storedPhoto: PhotoRecord;
        let storedOperation: PhotoUploadOperationRecord;
        try {
            const [currentValue, previousOperationIds, catalogValue] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(operations.index('byLocalId').getAllKeys(cleaned.localId)),
                requestResult(metadata.get(CATALOG_STATE_KEY)),
            ]);
            const current = Library.cleanPhoto(currentValue);
            if (!current || current.deletedAt || current.revision !== cleaned.revision
                || !['draft', 'outcome-unknown'].includes(current.remote.state)) {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            if (previousOperationIds.length || current.remote.state === 'outcome-unknown') {
                throw new PhotoStoreConflictError(cleaned.localId,
                    'An earlier upload may have reached ImgBB. Check your ImgBB account before uploading again.');
            }
            const nextStored = Library.cleanPhoto({ ...cleaned, revision: current.revision + 1 });
            if (!nextStored) throw new TypeError('photo store could not store upload photo');
            storedPhoto = nextStored;
            storedOperation = structuredClone({
                ...operation,
                photoRevision: storedPhoto.revision,
            });
            photos.put(storedPhoto);
            if (recoveryPhotoIdentity(current) !== recoveryPhotoIdentity(storedPhoto)) {
                advanceCatalog(metadata, cleanCatalogState(catalogValue));
            }
            tombstones.delete(cleaned.localId);
            previousOperationIds.forEach(operationId => operations.delete(operationId));
            operations.put(storedOperation);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return { photo: storedPhoto, operation: storedOperation };
    };

    const commitUploadOperation = async ({
        photo,
        operationId,
    }: {
        photo: unknown;
        operationId: unknown;
    }): Promise<{ photo: PhotoRecord; operation: PhotoUploadOperationRecord }> => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned || !['uploaded', 'unreachable'].includes(cleaned.remote.state)
            || typeof operationId !== 'string') {
            throw new TypeError('photo store requires a clean uploaded photo and recovery operation');
        }
        const transaction = database.transaction([
            STORES.photos,
            STORES.secrets,
            STORES.operations,
            STORES.metadata,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const operations = transaction.objectStore(STORES.operations);
        const metadata = transaction.objectStore(STORES.metadata);
        let storedPhoto: PhotoRecord;
        let storedOperation: PhotoUploadOperationRecord;
        try {
            const [currentValue, rawOperation, catalogValue] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(operations.get(operationId)),
                requestResult(metadata.get(CATALOG_STATE_KEY)),
            ]);
            const operation = rawOperation as PhotoUploadOperationRecord | undefined;
            const current = Library.cleanPhoto(currentValue);
            const secret = cleanDeleteUrl(operation?.deleteUrl);
            if (!current || current.deletedAt || current.revision !== cleaned.revision
                || !operation || operation.localId !== cleaned.localId
                || operation.state !== 'response-received' || !secret) {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            const nextStored = Library.cleanPhoto({ ...cleaned, revision: current.revision + 1 });
            if (!nextStored) throw new TypeError('photo store could not commit uploaded photo');
            storedPhoto = nextStored;
            storedOperation = structuredClone({ ...operation, state: 'catalog-committed' });
            photos.put(storedPhoto);
            if (recoveryPhotoIdentity(current) !== recoveryPhotoIdentity(storedPhoto)) {
                advanceCatalog(metadata, cleanCatalogState(catalogValue));
            }
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

    const resetUploadOperation = async ({
        photo,
        operationId,
    }: {
        photo: unknown;
        operationId: unknown;
    }): Promise<PhotoRecord> => {
        const cleaned = Library.cleanPhoto(photo);
        if (!cleaned || cleaned.remote.state !== 'draft' || typeof operationId !== 'string') {
            throw new TypeError('photo store requires a retryable photo and recovery operation');
        }
        const transaction = database.transaction([
            STORES.photos,
            STORES.operations,
            STORES.metadata,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const operations = transaction.objectStore(STORES.operations);
        const metadata = transaction.objectStore(STORES.metadata);
        let storedPhoto: PhotoRecord;
        try {
            const [currentValue, rawOperation, catalogValue] = await Promise.all([
                requestResult(photos.get(cleaned.localId)),
                requestResult(operations.get(operationId)),
                requestResult(metadata.get(CATALOG_STATE_KEY)),
            ]);
            const operation = rawOperation as PhotoUploadOperationRecord | undefined;
            const current = Library.cleanPhoto(currentValue);
            if (!current || current.deletedAt || current.remote.state !== 'uploading'
                || current.revision !== cleaned.revision
                || !operation || operation.localId !== cleaned.localId
                || operation.state !== 'request-started') {
                throw new PhotoStoreConflictError(cleaned.localId);
            }
            const nextStored = Library.cleanPhoto({ ...cleaned, revision: current.revision + 1 });
            if (!nextStored) throw new TypeError('photo store could not reset upload photo');
            storedPhoto = nextStored;
            photos.put(storedPhoto);
            if (recoveryPhotoIdentity(current) !== recoveryPhotoIdentity(storedPhoto)) {
                advanceCatalog(metadata, cleanCatalogState(catalogValue));
            }
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
    const updatePhotoBackup = async ({
        localId,
        expectedRevision,
        backup,
    }: UpdatePhotoBackupInput): Promise<PhotoRecord> => {
        if (typeof localId !== 'string' || !Number.isSafeInteger(expectedRevision)
            || expectedRevision < 0) {
            throw new TypeError('photo backup update requires an observed revision');
        }
        const transaction = database.transaction(STORES.photos, 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        let storedPhoto: PhotoRecord;
        try {
            const current = Library.cleanPhoto(await requestResult(photos.get(localId)));
            if (!current || current.revision !== expectedRevision) {
                throw new PhotoStoreConflictError(localId);
            }
            const nextStored = Library.cleanPhoto({
                ...current,
                revision: current.revision + 1,
                backup,
            });
            if (!nextStored) throw new TypeError('photo backup update is invalid');
            storedPhoto = nextStored;
            photos.put(storedPhoto);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return storedPhoto;
    };

    const updatePhotoBackups = async ({
        localIds,
        expectedRevisions,
        backup,
        batchSize = MAX_BACKUP_RECONCILIATION_BATCH,
    }: UpdatePhotoBackupsInput = {}): Promise<UpdatePhotoBackupsResult> => {
        const ids = Array.isArray(localIds)
            ? [...new Set(localIds.filter((value): value is string => typeof value === 'string'))]
            : [];
        if (!expectedRevisions || typeof expectedRevisions !== 'object'
            || Array.isArray(expectedRevisions)
            || !Number.isInteger(batchSize) || batchSize < 1
            || batchSize > MAX_BACKUP_RECONCILIATION_BATCH
            || ids.some(localId => {
                const expected = expectedRevisions[localId];
                return typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0;
            })) {
            throw new TypeError('photo backup batch requires bounded observed revisions');
        }
        const conflicts: string[] = [];
        let changed = 0;
        let transactions = 0;
        let maxBatchSize = 0;
        for (let offset = 0; offset < ids.length; offset += batchSize) {
            const batch = ids.slice(offset, offset + batchSize);
            maxBatchSize = Math.max(maxBatchSize, batch.length);
            const transaction = database.transaction(STORES.photos, 'readwrite');
            const photos = transaction.objectStore(STORES.photos);
            try {
                const currentValues = await Promise.all(batch.map(localId =>
                    requestResult(photos.get(localId))));
                batch.forEach((localId, index) => {
                    const current = Library.cleanPhoto(currentValues[index]);
                    if (!current || current.revision !== expectedRevisions[localId]) {
                        conflicts.push(localId);
                        return;
                    }
                    const stored = Library.cleanPhoto({
                        ...current,
                        revision: current.revision + 1,
                        backup,
                    });
                    if (!stored) throw new TypeError('photo backup update is invalid');
                    photos.put(stored);
                    changed += 1;
                });
            } catch (error) {
                return abortAndRethrow(transaction, error);
            }
            await transactionDone(transaction);
            transactions += 1;
        }
        return { conflicts, changed, transactions, maxBatchSize };
    };

    const putOperation = async (operation: PhotoUploadOperationRecord): Promise<void> => {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)
            || typeof operation.localId !== 'string' || typeof operation.operationId !== 'string') {
            throw new TypeError('photo store requires an operation with ids');
        }
        const transaction = database.transaction(STORES.operations, 'readwrite');
        transaction.objectStore(STORES.operations).put(structuredClone(operation));
        await transactionDone(transaction);
    };

    const getOperations = async (): Promise<PhotoUploadOperationRecord[]> => {
        const transaction = database.transaction(STORES.operations, 'readonly');
        const operations = await requestResult(
            transaction.objectStore(STORES.operations).getAll()) as PhotoUploadOperationRecord[];
        await transactionDone(transaction);
        return operations;
    };

    const deleteOperation = async (operationId: string): Promise<void> => {
        const transaction = database.transaction(STORES.operations, 'readwrite');
        transaction.objectStore(STORES.operations).delete(operationId);
        await transactionDone(transaction);
    };

    // Version 3.4.0 wrote `uploading` before it wrote the journal, but never
    // contacted ImgBB until the journal succeeded. Such a record with no
    // operation is therefore a definite pre-request interruption and can be
    // returned to a retryable draft without claiming an unknown outcome.
    const recoverOrphanedUploads = async (now?: string): Promise<RecoverOrphanedUploadsResult> => {
        const transaction = database.transaction([
            STORES.photos,
            STORES.operations,
            STORES.metadata,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const operations = transaction.objectStore(STORES.operations);
        const metadata = transaction.objectStore(STORES.metadata);
        let recovered: PhotoRecord[] = [];
        try {
            const [photoValues, operationValues, catalogValue] = await Promise.all([
                requestResult(photos.getAll()),
                requestResult(operations.getAll()),
                requestResult(metadata.get(CATALOG_STATE_KEY)),
            ]);
            const operatedIds = new Set((operationValues as PhotoUploadOperationRecord[]).map(value => value.localId));
            recovered = photoValues.map(Library.cleanPhoto)
                .filter((photo): photo is PhotoRecord => photo !== null)
                .filter(photo => photo.remote.state === 'uploading'
                    && !operatedIds.has(photo.localId));
            recovered.forEach(photo => {
                const reset = Library.resetUpload(photo, now);
                const cleaned = Library.cleanPhoto({ ...reset, revision: photo.revision + 1 });
                if (cleaned) photos.put(cleaned);
            });
            if (recovered.length) advanceCatalog(metadata, cleanCatalogState(catalogValue));
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return { recovered: recovered.length, localIds: recovered.map(photo => photo.localId) };
    };

    const removeLocalAssets = async (localId: string, _now?: string): Promise<PhotoRecord> => {
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
            STORES.metadata,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        let cleaned: PhotoRecord;
        try {
            const photo = Library.cleanPhoto(await requestResult(photos.get(localId)));
            const updated = photo && Library.updateAssets(photo, {
                originalRetained: false,
                projectRetained: false,
                thumbnailRetained: false,
            });
            const nextStored = photo && updated
                ? Library.cleanPhoto({ ...updated, revision: photo.revision + 1 })
                : null;
            if (!nextStored) throw new TypeError('photo store could not resolve the local photo');
            cleaned = nextStored;
            photos.put(cleaned);
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        transaction.objectStore(STORES.projects).delete(localId);
        transaction.objectStore(STORES.originals).delete(localId);
        transaction.objectStore(STORES.thumbnails).delete(localId);
        transaction.objectStore(STORES.metadata).delete(`report-image:${localId}`);
        await transactionDone(transaction);
        return cleaned;
    };

    const pruneDeletedAssets = async ({
        before,
        now,
        limit = 20,
    }: PruneDeletedAssetsOptions = {}): Promise<PruneDeletedAssetsResult> => {
        const beforeTime = typeof before === 'string' ? Date.parse(before) : NaN;
        const beforeAt = Number.isFinite(beforeTime) ? new Date(beforeTime).toISOString() : null;
        const updatedAt = typeof now === 'string' && Number.isFinite(Date.parse(now))
            ? new Date(now).toISOString()
            : null;
        if (!beforeAt || !updatedAt
            || !Number.isInteger(limit) || limit < 1 || limit > MAX_MAINTENANCE_BATCH) {
            throw new TypeError('photo store requires a bounded maintenance request');
        }
        const transaction = database.transaction([
            STORES.photos,
            STORES.projects,
            STORES.originals,
            STORES.thumbnails,
            STORES.metadata,
        ], 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const pruning: PhotoRecord[] = [];
        let remaining = 0;
        let nextDeletedAt: string | null = null;
        try {
            await new Promise<void>((resolve, reject) => {
                const request = photos.index(DELETED_AT_INDEX).openCursor();
                request.onerror = () => reject(request.error || new Error('Photo maintenance cursor failed.'));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) {
                        resolve();
                        return;
                    }
                    const photo = Library.cleanPhoto(cursor.value);
                    const retainsAssets = Boolean(photo && (photo.assets.originalRetained
                        || photo.assets.projectRetained || photo.assets.thumbnailRetained));
                    if (String(cursor.key) > beforeAt) {
                        if (photo && retainsAssets) {
                            nextDeletedAt = photo.deletedAt;
                            resolve();
                        } else {
                            cursor.continue();
                        }
                        return;
                    }
                    if (photo && retainsAssets) {
                        if (pruning.length >= limit) {
                            remaining = 1;
                            resolve();
                            return;
                        }
                        pruning.push(photo);
                    }
                    cursor.continue();
                };
            });
            for (const photo of pruning) {
                const updated = Library.updateAssets(photo, {
                    originalRetained: false,
                    projectRetained: false,
                    thumbnailRetained: false,
                });
                const stored = updated ? Library.cleanPhoto({ ...updated, revision: photo.revision + 1 }) : null;
                if (!stored) throw new TypeError('photo maintenance produced an invalid record');
                photos.put(stored);
                transaction.objectStore(STORES.projects).delete(photo.localId);
                transaction.objectStore(STORES.originals).delete(photo.localId);
                transaction.objectStore(STORES.thumbnails).delete(photo.localId);
                transaction.objectStore(STORES.metadata).delete(`report-image:${photo.localId}`);
            }
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }
        await transactionDone(transaction);
        return {
            pruned: pruning.length,
            remaining,
            ...(nextDeletedAt ? { nextDeletedAt } : {}),
        };
    };

    const purge = async (localId: string): Promise<void> => {
        const transaction = database.transaction(STORE_NAMES, 'readwrite');
        const photos = transaction.objectStore(STORES.photos);
        const tombstones = transaction.objectStore(STORES.tombstones);
        const metadata = transaction.objectStore(STORES.metadata);
        const [photo, tombstone, catalogValue] = await Promise.all([
            requestResult(photos.get(localId)),
            requestResult(tombstones.get(localId)),
            requestResult(metadata.get(CATALOG_STATE_KEY)),
        ]);
        for (const storeName of STORE_NAMES) {
            if (storeName !== STORES.operations && storeName !== STORES.metadata) {
                transaction.objectStore(storeName).delete(localId);
            }
        }
        metadata.delete(`report-image:${localId}`);
        if (photo || tombstone) advanceCatalog(metadata, cleanCatalogState(catalogValue));
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

    const applyRestore = async ({
        records = [],
        tombstones = [],
        expectedRevisions = {},
    }: ApplyRestoreInput = {}): Promise<void> => {
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
            STORES.metadata,
        ], 'readwrite');
        const stores = {
            [STORES.photos]: transaction.objectStore(STORES.photos),
            [STORES.projects]: transaction.objectStore(STORES.projects),
            [STORES.originals]: transaction.objectStore(STORES.originals),
            [STORES.thumbnails]: transaction.objectStore(STORES.thumbnails),
            [STORES.secrets]: transaction.objectStore(STORES.secrets),
            [STORES.tombstones]: transaction.objectStore(STORES.tombstones),
            [STORES.metadata]: transaction.objectStore(STORES.metadata),
        };

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
        let restoredValues: Array<[unknown, unknown, unknown, unknown, unknown]>;
        let tombstoneValues: Array<[unknown, unknown]>;
        let catalogValue: unknown;
        try {
            [restoredValues, tombstoneValues, catalogValue] = await Promise.all([
                Promise.all(restoredLookups),
                Promise.all(tombstoneLookups),
                requestResult(stores[STORES.metadata].get(CATALOG_STATE_KEY)),
            ]);
            const assertObservedRevision = (localId: string, current: PhotoRecord | null, tombstone: unknown) => {
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
                const entry = restored[index];
                if (!entry) return;
                assertObservedRevision(
                    entry.photo.localId,
                    Library.cleanPhoto(values[0]),
                    values[4],
                );
            });
            tombstoneValues.forEach((values, index) => {
                const entry = deleted[index];
                if (!entry) return;
                assertObservedRevision(
                    entry.localId,
                    Library.cleanPhoto(values[0]),
                    values[1],
                );
            });
        } catch (error) {
            return abortAndRethrow(transaction, error);
        }

        restored.forEach((value, index) => {
            const tuple = restoredValues[index];
            if (!tuple) return;
            const [existingPhoto, existingProject, original, thumbnail, tombstone] = tuple;
            const existing = Library.cleanPhoto(existingPhoto);
            const cleanExistingProject = Project.cleanProject(existingProject);
            const sameSource = Boolean(existing
                && existing.source.sha256 === value.photo.source.sha256
                && Project.matchingImageDimensions(existing.source, value.photo.source));
            const sameProject = Boolean(sameSource
                && cleanExistingProject
                && cleanExistingProject.image.sourceSha256 === value.photo.source.sha256
                && Project.matchingImageDimensions(cleanExistingProject.image, value.photo.source));
            const sameRemote = Boolean(existing
                && 'providerId' in existing.remote
                && 'providerId' in value.photo.remote
                && existing.remote.providerId
                && existing.remote.providerId === value.photo.remote.providerId);
            const photo = Library.cleanPhoto({
                ...value.photo,
                revision: nextRevision(existing, tombstone),
                assets: {
                    originalRetained: recordFields(original).blob instanceof Blob && sameSource,
                    projectRetained: Boolean(value.project) || sameProject,
                    thumbnailRetained: recordFields(thumbnail).blob instanceof Blob && sameSource,
                },
                deletedAt: null,
            });
            if (!photo) return;
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
            const tuple = tombstoneValues[index];
            if (!tuple) return;
            const [existingValue, existingTombstone] = tuple;
            const existing = Library.cleanPhoto(existingValue);
            const existingTombstoneDeletedAt = recordFields(existingTombstone).deletedAt;
            const revision = nextRevision(existing, existingTombstone);
            if (existing && (!existing.deletedAt || existing.deletedAt < tombstone.deletedAt)) {
                const deletedPhoto = Library.cleanPhoto({
                    ...Library.markDeleted(existing, tombstone.deletedAt),
                    revision,
                });
                if (deletedPhoto) stores[STORES.photos].put(deletedPhoto);
            }
            if (!existingTombstone
                || (typeof existingTombstoneDeletedAt === 'string' && existingTombstoneDeletedAt < tombstone.deletedAt)) {
                stores[STORES.tombstones].put({ ...tombstone, revision });
            }
        });
        if (restored.length || deleted.length) {
            advanceCatalog(stores[STORES.metadata], cleanCatalogState(catalogValue));
        }
        await transactionDone(transaction);
    };

    return {
        getBundle,
        putReportImage,
        getReportImage,
        listPhotos,
        pruneSupersededVersions,
        getThumbnails,
        listBackupBundles,
        getCatalogState,
        confirmCatalogBackup,
        putDraft,
        putBundle,
        putPhoto,
        restorePhoto,
        beginUploadOperation,
        commitUploadOperation,
        resetUploadOperation,
        updatePhotoBackup,
        updatePhotoBackups,
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
    CATALOG_STATE_KEY,
    MAX_BACKUP_RECONCILIATION_BATCH,
    PhotoStoreConflictError,
    openDatabase,
    createPhotoStore,
};
