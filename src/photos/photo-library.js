// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure uploaded-photo catalog model and state transitions.

const SCHEMA_VERSION = 1;
const TITLE_LIMIT = 200;
const ALT_LIMIT = 500;
const FILE_NAME_LIMIT = 255;
const URL_LIMIT = 4096;
const REFERENCE_LIMIT = 100;
const REMOTE_STATES = new Set(['draft', 'uploading', 'outcome-unknown', 'uploaded', 'unreachable']);
const BACKUP_STATES = new Set(['off', 'pending', 'current', 'failed', 'restored']);
const REFERENCE_KINDS = new Set(['ascent-draft', 'ascent', 'unknown']);
const HASH = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const ownObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const trim = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const cleanId = value => typeof value === 'string' && SAFE_ID.test(value) ? value : null;
const cleanTime = value => {
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const cleanNullableTime = value => value == null ? null : cleanTime(value);
const cleanPositiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const cleanRevision = value => value == null
    ? 0
    : Number.isSafeInteger(value) && value >= 0 ? value : null;
const cleanHash = value => typeof value === 'string' && HASH.test(value.toLowerCase())
    ? value.toLowerCase()
    : null;
const cleanHttpsUrl = value => {
    if (typeof value !== 'string' || value.length > URL_LIMIT) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    } catch { return null; }
};
const cleanNullableUrl = value => value == null || value === '' ? null : cleanHttpsUrl(value);

const cleanImageMetadata = (value, { fileName = false } = {}) => {
    if (!ownObject(value)) return null;
    const mime = typeof value.mime === 'string' && /^image\/[a-z0-9.+-]{1,80}$/i.test(value.mime)
        ? value.mime.toLowerCase()
        : null;
    const bytes = cleanPositiveInteger(value.bytes);
    const width = cleanPositiveInteger(value.width);
    const height = cleanPositiveInteger(value.height);
    const sha256 = cleanHash(value.sha256);
    const name = fileName ? trim(value.fileName, FILE_NAME_LIMIT) : null;
    if (!mime || bytes == null || width == null || height == null || !sha256
        || (fileName && !name)) return null;
    return {
        ...(fileName ? { fileName: name } : {}),
        mime,
        bytes,
        width,
        height,
        sha256,
    };
};

const cleanRemote = value => {
    if (!ownObject(value) || value.provider !== 'imgbb' || !REMOTE_STATES.has(value.state)) return null;
    const base = { provider: 'imgbb', state: value.state };
    if (value.state === 'draft' || value.state === 'uploading' || value.state === 'outcome-unknown') {
        return base;
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
        ...base,
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

const cleanReference = value => {
    if (!ownObject(value) || !REFERENCE_KINDS.has(value.kind)) return null;
    const insertedAt = cleanTime(value.insertedAt);
    const cid = value.cid == null ? null : cleanPositiveInteger(value.cid);
    const aid = value.aid == null ? null : cleanPositiveInteger(value.aid);
    const pid = value.pid == null || !Number.isSafeInteger(value.pid) ? null : value.pid;
    if (!insertedAt || (value.cid != null && cid == null)
        || (value.aid != null && aid == null)
        || (value.pid != null && pid == null)) return null;
    return { kind: value.kind, cid, aid, pid, insertedAt };
};

const cleanReferences = value => {
    if (!Array.isArray(value) || value.length > REFERENCE_LIMIT) return null;
    const references = [];
    const seen = new Set();
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

const cleanBackup = value => {
    if (!ownObject(value) || !BACKUP_STATES.has(value.state)) return null;
    const signature = value.signature == null ? null : cleanHash(value.signature);
    const backedUpAt = cleanNullableTime(value.backedUpAt);
    const commitUrl = cleanNullableUrl(value.commitUrl);
    if ((value.signature != null && !signature)
        || (value.backedUpAt != null && !backedUpAt)
        || (value.commitUrl != null && !commitUrl)) return null;
    return { state: value.state, signature, backedUpAt, commitUrl };
};

const cleanAssets = value => ownObject(value)
    && typeof value.originalRetained === 'boolean'
    && typeof value.projectRetained === 'boolean'
    && typeof value.thumbnailRetained === 'boolean'
    ? {
        originalRetained: value.originalRetained,
        projectRetained: value.projectRetained,
        thumbnailRetained: value.thumbnailRetained,
    }
    : null;

const cleanPhoto = value => {
    if (!ownObject(value) || value.schemaVersion !== SCHEMA_VERSION) return null;
    const localId = cleanId(value.localId);
    const revision = cleanRevision(value.revision);
    const createdAt = cleanTime(value.createdAt);
    const updatedAt = cleanTime(value.updatedAt);
    const title = trim(value.title, TITLE_LIMIT);
    const alt = trim(value.alt, ALT_LIMIT);
    const source = cleanImageMetadata(value.source, { fileName: true });
    const exported = value.export == null ? null : cleanImageMetadata(value.export);
    const remote = cleanRemote(value.remote);
    const parentLocalId = value.lineage?.parentLocalId == null
        ? null
        : cleanId(value.lineage.parentLocalId);
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
        || (value.lineage?.parentLocalId != null && !parentLocalId)
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
    source,
    parentLocalId = null,
    now = new Date().toISOString(),
} = {}) => cleanPhoto({
    schemaVersion: SCHEMA_VERSION,
    localId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    title,
    alt,
    source,
    export: null,
    remote: { provider: 'imgbb', state: 'draft' },
    lineage: { parentLocalId },
    references: [],
    backup: { state: 'off', signature: null, backedUpAt: null, commitUrl: null },
    assets: { originalRetained: true, projectRetained: true, thumbnailRetained: true },
    deletedAt: null,
});

// The pending export is validated here but deliberately not carried on the
// record: until ImgBB confirms a URL the catalog stays in its non-uploaded
// shape, and the export metadata belongs in the operation journal, which is
// what `completeUpload` and crash recovery read it back from.
const beginUpload = (value, exported, now = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    if (!photo || !cleanImageMetadata(exported)
        || !['draft', 'outcome-unknown'].includes(photo.remote.state)) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        export: null,
        remote: { provider: 'imgbb', state: 'uploading' },
        backup: { ...photo.backup, state: photo.backup.state === 'off' ? 'off' : 'pending' },
    });
};

const markOutcomeUnknown = (value, now = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    if (!photo || photo.remote.state !== 'uploading') return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        remote: { provider: 'imgbb', state: 'outcome-unknown' },
    });
};

const resetUpload = (value, now = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    if (!photo || !['uploading', 'outcome-unknown'].includes(photo.remote.state)) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        remote: { provider: 'imgbb', state: 'draft' },
    });
};

const completeUpload = (value, exported, remote, now = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    const exportMetadata = cleanImageMetadata(exported);
    const remoteMetadata = cleanRemote({ ...remote, provider: 'imgbb', state: 'uploaded' });
    if (!photo || !exportMetadata || !remoteMetadata
        || !['uploading', 'outcome-unknown', 'draft'].includes(photo.remote.state)) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        export: exportMetadata,
        remote: remoteMetadata,
        backup: { ...photo.backup, state: photo.backup.state === 'off' ? 'off' : 'pending' },
    });
};

const markUnreachable = (value, unreachable = true, now = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    if (!photo || !['uploaded', 'unreachable'].includes(photo.remote.state)) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        remote: { ...photo.remote, state: unreachable ? 'unreachable' : 'uploaded' },
    });
};

const addReference = (value, reference, now = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    const cleanedReference = cleanReference(reference);
    if (!photo || !cleanedReference) return null;
    return cleanPhoto({
        ...photo,
        updatedAt: now,
        references: [...photo.references, cleanedReference].slice(-REFERENCE_LIMIT),
    });
};

const markDeleted = (value, deletedAt = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    return photo ? cleanPhoto({ ...photo, updatedAt: deletedAt, deletedAt }) : null;
};

const restoreDeleted = (value, now = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    return photo ? cleanPhoto({ ...photo, updatedAt: now, deletedAt: null }) : null;
};

const updateAssets = (value, assets, now = new Date().toISOString()) => {
    const photo = cleanPhoto(value);
    return photo ? cleanPhoto({ ...photo, updatedAt: now, assets: { ...photo.assets, ...assets } }) : null;
};

const searchableText = photo => [
    photo.title,
    photo.alt,
    photo.source.fileName,
    ...photo.references.flatMap(reference => [reference.aid, reference.pid, reference.cid]),
].join(' ').toLocaleLowerCase();

const search = (values, query = '', filter = 'all') => {
    const needle = trim(query, 200).toLocaleLowerCase();
    return (Array.isArray(values) ? values : [])
        .map(cleanPhoto)
        .filter(Boolean)
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
    FILE_NAME_LIMIT,
    URL_LIMIT,
    REFERENCE_LIMIT,
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
    updateAssets,
    search,
};
