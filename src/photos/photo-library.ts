// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure uploaded-photo catalog model and state transitions.

import { cleanPhotoUrl as cleanHttpsUrl, PHOTO_URL_LIMIT as URL_LIMIT } from './photo-url.ts';

const SCHEMA_VERSION = 1 as const;
const TITLE_LIMIT = 200;
const ALT_LIMIT = 500;
const FILE_NAME_LIMIT = 255;
const REFERENCE_LIMIT = 100;
const DELETED_EDITING_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;

export type PhotoRemoteState = 'draft' | 'uploading' | 'outcome-unknown' | 'uploaded' | 'unreachable';
export type PhotoBackupState = 'off' | 'pending' | 'current' | 'failed' | 'restored';
export type PhotoReferenceKind = 'ascent-draft' | 'ascent' | 'unknown';
export type PhotoSearchFilter = 'all' | 'drafts' | 'uploaded' | 'not-inserted' | 'backup-pending' | 'needs-attention';

export interface PhotoImageMetadata {
    mime: string;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
}

export interface PhotoSourceMetadata extends PhotoImageMetadata {
    fileName: string;
}

export interface PhotoRemotePending {
    provider: 'imgbb';
    state: 'draft' | 'uploading' | 'outcome-unknown';
}

export interface PhotoRemoteHosted {
    provider: 'imgbb';
    state: 'uploaded' | 'unreachable';
    providerId: string;
    url: string;
    displayUrl: string;
    viewerUrl: string;
    thumbnailUrl: string;
    mediumUrl: string | null;
    uploadedAt: string;
    expiresAt: string | null;
}

export type PhotoRemote = PhotoRemotePending | PhotoRemoteHosted;

export interface PhotoReference {
    kind: PhotoReferenceKind;
    cid: number | null;
    aid: number | null;
    pid: number | null;
    insertedAt: string;
}

export interface PhotoBackupInfo {
    state: PhotoBackupState;
    signature: string | null;
    backedUpAt: string | null;
    commitUrl: string | null;
}

export interface PhotoAssetsInfo {
    originalRetained: boolean;
    projectRetained: boolean;
    thumbnailRetained: boolean;
}

export interface PhotoRecord {
    schemaVersion: 1;
    localId: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    title: string;
    alt: string;
    caption?: string;
    source: PhotoSourceMetadata;
    export: PhotoImageMetadata | null;
    remote: PhotoRemote;
    lineage: { parentLocalId: string | null };
    references: PhotoReference[];
    backup: PhotoBackupInfo;
    assets: PhotoAssetsInfo;
    deletedAt: string | null;
}

export interface CreatePhotoDraftOptions {
    localId?: unknown;
    title?: unknown;
    alt?: unknown;
    caption?: unknown;
    source?: unknown;
    parentLocalId?: unknown;
    now?: string;
}

export interface PhotoDeletedRecovery {
    deletedAt: string;
    expiresAt: string;
    editingDataRetained: boolean;
    editingDataRecoverable: boolean;
}

const REMOTE_STATES = new Set<PhotoRemoteState>(['draft', 'uploading', 'outcome-unknown', 'uploaded', 'unreachable']);
const BACKUP_STATES = new Set<PhotoBackupState>(['off', 'pending', 'current', 'failed', 'restored']);
const REFERENCE_KINDS = new Set<PhotoReferenceKind>(['ascent-draft', 'ascent', 'unknown']);
const HASH = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const ownObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const trim = (value: unknown, limit: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const cleanId = (value: unknown): string | null => typeof value === 'string' && SAFE_ID.test(value) ? value : null;
const cleanTime = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const cleanNullableTime = (value: unknown): string | null => value == null ? null : cleanTime(value);
const cleanPositiveInteger = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const cleanRevision = (value: unknown): number | null => value == null
    ? 0
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const cleanHash = (value: unknown): string | null => typeof value === 'string' && HASH.test(value.toLowerCase())
    ? value.toLowerCase()
    : null;
const cleanNullableUrl = (value: unknown): string | null => value == null || value === '' ? null : cleanHttpsUrl(value);

const inSet = <T extends string>(set: ReadonlySet<T>, value: unknown): T | null =>
    typeof value === 'string' && set.has(value as T) ? (value as T) : null;

function cleanImageMetadata(value: unknown, options: { fileName: true }): PhotoSourceMetadata | null;
function cleanImageMetadata(value: unknown, options?: { fileName?: false }): PhotoImageMetadata | null;
function cleanImageMetadata(
    value: unknown,
    { fileName = false }: { fileName?: boolean } = {},
): PhotoImageMetadata | PhotoSourceMetadata | null {
    if (!ownObject(value)) return null;
    const mime = typeof value.mime === 'string' && /^image\/[a-z0-9.+-]{1,80}$/i.test(value.mime)
        ? value.mime.toLowerCase()
        : null;
    const bytes = cleanPositiveInteger(value.bytes);
    const width = cleanPositiveInteger(value.width);
    const height = cleanPositiveInteger(value.height);
    const sha256 = cleanHash(value.sha256);
    if (!mime || bytes == null || width == null || height == null || !sha256) return null;
    if (fileName) {
        const name = trim(value.fileName, FILE_NAME_LIMIT);
        if (!name) return null;
        return {
            fileName: name,
            mime,
            bytes,
            width,
            height,
            sha256,
        };
    }
    return {
        mime,
        bytes,
        width,
        height,
        sha256,
    };
}

const cleanRemote = (value: unknown): PhotoRemote | null => {
    if (!ownObject(value) || value.provider !== 'imgbb') return null;
    const state = inSet(REMOTE_STATES, value.state);
    if (!state) return null;
    if (state === 'draft' || state === 'uploading' || state === 'outcome-unknown') {
        return { provider: 'imgbb', state };
    }
    const providerId = trim(value.providerId, 200);
    const url = cleanHttpsUrl(value.url);
    const displayUrl = cleanHttpsUrl(value.displayUrl);
    const viewerUrl = cleanHttpsUrl(value.viewerUrl);
    const thumbnailUrl = cleanHttpsUrl(value.thumbnailUrl);
    const mediumUrl = cleanNullableUrl(value.mediumUrl);
    const uploadedAt = cleanTime(value.uploadedAt);
    const expiresAt = cleanNullableTime(value.expiresAt);
    if (!providerId || !url || !displayUrl || !viewerUrl || !thumbnailUrl || !uploadedAt
        || (value.mediumUrl != null && !mediumUrl)
        || (value.expiresAt != null && !expiresAt)) return null;
    return {
        provider: 'imgbb',
        state,
        providerId,
        url,
        displayUrl,
        viewerUrl,
        thumbnailUrl,
        mediumUrl,
        uploadedAt,
        expiresAt,
    };
};

const cleanReference = (value: unknown): PhotoReference | null => {
    if (!ownObject(value)) return null;
    const kind = inSet(REFERENCE_KINDS, value.kind);
    if (!kind) return null;
    const insertedAt = cleanTime(value.insertedAt);
    const cid = value.cid == null ? null : cleanPositiveInteger(value.cid);
    const aid = value.aid == null ? null : cleanPositiveInteger(value.aid);
    const pid = value.pid == null || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) ? null : value.pid;
    if (!insertedAt || (value.cid != null && cid == null)
        || (value.aid != null && aid == null)
        || (value.pid != null && pid == null)) return null;
    return { kind, cid, aid, pid, insertedAt };
};

const cleanReferences = (value: unknown): PhotoReference[] | null => {
    if (!Array.isArray(value) || value.length > REFERENCE_LIMIT) return null;
    const references: PhotoReference[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
        const reference = cleanReference(candidate);
        if (!reference) return null;
        const key = JSON.stringify(reference);
        if (seen.has(key)) continue;
        seen.add(key);
        references.push(reference);
    }
    return references;
};

const cleanBackup = (value: unknown): PhotoBackupInfo | null => {
    if (!ownObject(value)) return null;
    const state = inSet(BACKUP_STATES, value.state);
    if (!state) return null;
    const signature = value.signature == null ? null : cleanHash(value.signature);
    const backedUpAt = cleanNullableTime(value.backedUpAt);
    const commitUrl = cleanNullableUrl(value.commitUrl);
    if ((value.signature != null && !signature)
        || (value.backedUpAt != null && !backedUpAt)
        || (value.commitUrl != null && !commitUrl)) return null;
    return { state, signature, backedUpAt, commitUrl };
};

const cleanAssets = (value: unknown): PhotoAssetsInfo | null => ownObject(value)
    && typeof value.originalRetained === 'boolean'
    && typeof value.projectRetained === 'boolean'
    && typeof value.thumbnailRetained === 'boolean'
    ? {
        originalRetained: value.originalRetained,
        projectRetained: value.projectRetained,
        thumbnailRetained: value.thumbnailRetained,
    }
    : null;

const cleanPhoto = (value: unknown): PhotoRecord | null => {
    if (!ownObject(value) || value.schemaVersion !== SCHEMA_VERSION) return null;
    const localId = cleanId(value.localId);
    const revision = cleanRevision(value.revision);
    const createdAt = cleanTime(value.createdAt);
    const updatedAt = cleanTime(value.updatedAt);
    const title = trim(value.title, TITLE_LIMIT);
    const alt = trim(value.alt, ALT_LIMIT);
    const caption = trim(value.caption, ALT_LIMIT);
    const source = cleanImageMetadata(value.source, { fileName: true });
    const exported = value.export == null ? null : cleanImageMetadata(value.export);
    const remote = cleanRemote(value.remote);
    const lineage = ownObject(value.lineage) ? value.lineage : null;
    const parentLocalId = lineage?.parentLocalId == null
        ? null
        : cleanId(lineage.parentLocalId);
    const references = cleanReferences(value.references);
    const backup = cleanBackup(value.backup);
    const assets = cleanAssets(value.assets);
    const deletedAt = cleanNullableTime(value.deletedAt);
    // `alt` is optional: an empty description is the HTML convention for a
    // decorative image, and forcing one blocked local autosave rather than
    // improving what people wrote. It is still trimmed and bounded above.
    if (!localId || revision == null || !createdAt || !updatedAt || !title
        || !source || !remote || !references || !backup || !assets
        || (value.export != null && !exported)
        || (lineage?.parentLocalId != null && !parentLocalId)
        || (value.deletedAt != null && !deletedAt)) return null;
    if (['uploaded', 'unreachable'].includes(remote.state) !== !!exported) return null;
    return {
        schemaVersion: SCHEMA_VERSION,
        localId,
        revision,
        createdAt,
        updatedAt,
        title,
        alt,
        ...(caption ? { caption } : {}),
        source,
        export: exported,
        remote,
        lineage: { parentLocalId },
        references,
        backup,
        assets,
        deletedAt,
    };
};

const createDraft = ({
    localId,
    title,
    alt = '',
    caption = '',
    source,
    parentLocalId = null,
    now = new Date().toISOString(),
}: CreatePhotoDraftOptions = {}): PhotoRecord | null => cleanPhoto({
    schemaVersion: SCHEMA_VERSION,
    localId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    title,
    alt,
    caption,
    source,
    export: null,
    remote: { provider: 'imgbb', state: 'draft' },
    lineage: { parentLocalId },
    references: [],
    backup: { state: 'off', signature: null, backedUpAt: null, commitUrl: null },
    assets: { originalRetained: true, projectRetained: true, thumbnailRetained: true },
    deletedAt: null,
});

const pendingBackup = (photo: PhotoRecord): PhotoBackupInfo => ({
    ...photo.backup,
    state: photo.backup.state === 'off' ? 'off' : 'pending',
    signature: photo.backup.state === 'off' ? photo.backup.signature : null,
    backedUpAt: photo.backup.state === 'off' ? photo.backup.backedUpAt : null,
    commitUrl: photo.backup.state === 'off' ? photo.backup.commitUrl : null,
});

// The pending export is validated here but deliberately not carried on the
// record: until ImgBB confirms a URL the catalog stays in its non-uploaded
// shape, and the export metadata belongs in the operation journal, which is
// what `completeUpload` and crash recovery read it back from.
const beginUpload = (value: unknown, exported: unknown, now = new Date().toISOString()): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    if (!photo || !cleanImageMetadata(exported)
        || !['draft', 'outcome-unknown'].includes(photo.remote.state)) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        export: null,
        remote: { provider: 'imgbb', state: 'uploading' },
        backup: pendingBackup(photo),
    });
};

const markOutcomeUnknown = (value: unknown, now = new Date().toISOString()): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    if (!photo || photo.remote.state !== 'uploading') return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        remote: { provider: 'imgbb', state: 'outcome-unknown' },
        backup: pendingBackup(photo),
    });
};

const resetUpload = (value: unknown, now = new Date().toISOString()): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    if (!photo || !['uploading', 'outcome-unknown'].includes(photo.remote.state)) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        remote: { provider: 'imgbb', state: 'draft' },
        backup: pendingBackup(photo),
    });
};

const completeUpload = (
    value: unknown,
    exported: unknown,
    remote: unknown,
    now = new Date().toISOString(),
): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    const exportMetadata = cleanImageMetadata(exported);
    const remoteMetadata = ownObject(remote)
        ? cleanRemote({ ...remote, provider: 'imgbb', state: 'uploaded' })
        : null;
    if (!photo || !exportMetadata || !remoteMetadata
        || !['uploading', 'outcome-unknown', 'draft'].includes(photo.remote.state)) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        export: exportMetadata,
        remote: remoteMetadata,
        backup: pendingBackup(photo),
    });
};

const markUnreachable = (
    value: unknown,
    unreachable = true,
    now = new Date().toISOString(),
): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    if (!photo || (photo.remote.state !== 'uploaded' && photo.remote.state !== 'unreachable')) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        remote: { ...photo.remote, state: unreachable ? 'unreachable' : 'uploaded' },
        backup: pendingBackup(photo),
    });
};

const addReference = (
    value: unknown,
    reference: unknown,
    now = new Date().toISOString(),
): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    const cleanedReference = cleanReference(reference);
    if (!photo || !cleanedReference) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        references: [...photo.references, cleanedReference].slice(-REFERENCE_LIMIT),
        backup: pendingBackup(photo),
    });
};

const markDeleted = (value: unknown, deletedAt = new Date().toISOString()): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    return photo ? cleanPhoto({
        ...photo,
        updatedAt: deletedAt,
        deletedAt,
        backup: pendingBackup(photo),
    }) : null;
};

const restoreDeleted = (value: unknown, now = new Date().toISOString()): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    return photo ? cleanPhoto({
        ...photo,
        updatedAt: now,
        deletedAt: null,
        backup: pendingBackup(photo),
    }) : null;
};

const deletedRecovery = (value: unknown, now: number | Date = Date.now()): PhotoDeletedRecovery | null => {
    const photo = cleanPhoto(value);
    const currentTime = now instanceof Date ? now.getTime() : Number(now);
    const deletedTime = photo?.deletedAt ? Date.parse(photo.deletedAt) : NaN;
    if (!photo?.deletedAt || !Number.isFinite(currentTime) || !Number.isFinite(deletedTime)) return null;
    const expiresAt = new Date(deletedTime + DELETED_EDITING_RECOVERY_MS).toISOString();
    const editingDataRetained = photo.assets.originalRetained && photo.assets.projectRetained;
    return {
        deletedAt: photo.deletedAt,
        expiresAt,
        editingDataRetained,
        editingDataRecoverable: editingDataRetained && currentTime < Date.parse(expiresAt),
    };
};

const updateAssets = (value: unknown, assets: Partial<PhotoAssetsInfo>): PhotoRecord | null => {
    const photo = cleanPhoto(value);
    return photo ? cleanPhoto({ ...photo, assets: { ...photo.assets, ...assets } }) : null;
};

const searchableText = (photo: PhotoRecord): string => [
    photo.title,
    photo.alt,
    photo.caption || '',
    photo.source.fileName,
    ...photo.references.flatMap(reference => [reference.aid, reference.pid, reference.cid]),
].join(' ').toLocaleLowerCase();

// Creation order identifies the current version. Inserting an older public
// link into another report updates its timestamp, but must not make it current.
const latestPhotos = (values: unknown): PhotoRecord[] => {
    const latest = new Map<string, PhotoRecord>();
    for (const value of Array.isArray(values) ? values : []) {
        const photo = cleanPhoto(value);
        if (!photo) continue;
        const previous = latest.get(photo.source.sha256);
        const order = previous ? (photo.createdAt.localeCompare(previous.createdAt)
            || photo.updatedAt.localeCompare(previous.updatedAt)
            || photo.localId.localeCompare(previous.localId)) : 0;
        if (!previous || order > 0) latest.set(photo.source.sha256, photo);
    }
    return [...latest.values()].filter(photo => !photo.deletedAt);
};

const search = (values: unknown, query: unknown = '', filter = 'all'): PhotoRecord[] => {
    const needle = trim(query, 200).toLocaleLowerCase();
    return (Array.isArray(values) ? values : [])
        .map(cleanPhoto)
        .filter((photo): photo is PhotoRecord => photo !== null)
        .filter(photo => !photo.deletedAt)
        .filter(photo => !needle || searchableText(photo).includes(needle))
        .filter(photo => {
            if (filter === 'drafts') return photo.remote.state === 'draft';
            if (filter === 'uploaded') return ['uploaded', 'unreachable'].includes(photo.remote.state);
            if (filter === 'not-inserted') return photo.remote.state === 'uploaded'
                && photo.references.length === 0;
            if (filter === 'backup-pending') return photo.backup.state === 'pending';
            if (filter === 'needs-attention') return photo.remote.state === 'outcome-unknown'
                || photo.remote.state === 'unreachable'
                || photo.backup.state === 'failed';
            return filter === 'all';
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.localId.localeCompare(b.localId));
};

export const photoLibrary = {
    SCHEMA_VERSION,
    TITLE_LIMIT,
    ALT_LIMIT,
    URL_LIMIT,
    DELETED_EDITING_RECOVERY_MS,
    cleanPhoto,
    createDraft,
    beginUpload,
    markOutcomeUnknown,
    resetUpload,
    completeUpload,
    markUnreachable,
    addReference,
    markDeleted,
    restoreDeleted,
    deletedRecovery,
    updateAssets,
    latestPhotos,
    search,
};
