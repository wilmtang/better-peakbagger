// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic, metadata-only photo-library recovery documents.

import { photoProject as Project, type PhotoProject } from './photo-project.ts';
import {
    photoLibrary as Library,
    type PhotoImageMetadata,
    type PhotoRecord,
    type PhotoRemote,
    type PhotoSourceMetadata,
} from './photo-library.ts';

const SCHEMA_VERSION = 1 as const;
const BACKUP_PATH = 'photo-library.json';
const MAX_BYTES = 8 * 1024 * 1024;
const KIND = 'better-peakbagger-photo-library' as const;
const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

export interface PhotoBackupPublicPhoto {
    schemaVersion: 1;
    localId: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    alt: string;
    caption?: string;
    source: PhotoSourceMetadata;
    export: PhotoImageMetadata | null;
    remote: PhotoRemote;
    lineage: PhotoRecord['lineage'];
    references: PhotoRecord['references'];
}

export interface PhotoBackupRecord extends PhotoBackupPublicPhoto {
    project: PhotoProject | null;
}

export interface PhotoBackupTombstone {
    localId: string;
    deletedAt: string;
}

export interface PhotoBackupPayload {
    kind: typeof KIND;
    schemaVersion: typeof SCHEMA_VERSION;
    exportedAt: string;
    extensionVersion: string;
    photos: PhotoBackupRecord[];
    tombstones: PhotoBackupTombstone[];
}

export interface PhotoBackupPayloadInput {
    photos?: readonly unknown[];
    tombstones?: readonly unknown[];
    exportedAt?: string;
    extensionVersion?: string;
}

export interface BuildPhotoBackupPayloadOptions {
    bundles?: readonly unknown[];
    tombstones?: readonly unknown[];
    exportedAt?: string;
    extensionVersion?: string;
}

export interface CanonicalPhotoBackupDocument {
    payload: PhotoBackupPayload;
    text: string;
    bytes: Uint8Array<ArrayBuffer>;
    byteLength: number;
}

export interface PreparedPhotoBackupDocument extends CanonicalPhotoBackupDocument {
    signature: string;
}

export type PhotoBackupParseResult =
    | { ok: true; payload: PhotoBackupPayload }
    | { ok: false; reason: 'not-text' | 'too-large' | 'not-json' | 'wrong-kind' | 'newer-version' | 'invalid-record' };

export type PhotoBackupConflictPolicy = 'stop' | 'keep-local';

export type PhotoBackupEntry =
    | { kind: 'photo'; value: PhotoBackupRecord }
    | { kind: 'tombstone'; value: PhotoBackupTombstone };

export interface PhotoBackupConflict {
    localId: string;
    local: PhotoBackupEntry;
    remote: PhotoBackupEntry;
}

export interface PhotoBackupMergeCounts {
    add: number;
    update: number;
    unchanged: number;
    tombstoned: number;
    conflict: number;
}

export interface MergePhotoBackupOptions {
    exportedAt?: string;
    extensionVersion?: string;
    baseSignature?: string | null;
    baseSignatureVersion?: number;
    conflictPolicy?: PhotoBackupConflictPolicy;
}

export type PhotoBackupMergeResult =
    | {
        ok: false;
        reason: 'conflict';
        conflicts: PhotoBackupConflict[];
        counts: PhotoBackupMergeCounts;
        remoteSignature: string;
    }
    | {
        ok: true;
        payload: PhotoBackupPayload;
        counts: PhotoBackupMergeCounts;
        conflicts: PhotoBackupConflict[];
        remoteSignature: string;
        signature: string;
        prepared: PreparedPhotoBackupDocument;
    };

export interface RestorePhotoBackupOptions {
    signature?: string | null;
    restoredAt?: string | null;
}

export interface RestoredPhotoBundle {
    photo: PhotoRecord;
    project: PhotoProject | null;
}

class PhotoBackupCapacityError extends RangeError {
    code: 'photo-backup-too-large';
    actualBytes: number;
    maxBytes: number;

    constructor(actualBytes: number, maxBytes = MAX_BYTES) {
        const actualMiB = (actualBytes / (1024 * 1024)).toFixed(1);
        const maxMiB = (maxBytes / (1024 * 1024)).toFixed(0);
        super(`Photo-library metadata uses ${actualMiB} MiB, above the ${maxMiB} MiB GitHub recovery limit. `
            + 'Move unneeded drafts to Recently Deleted; after their editing-data window ends, try again.');
        this.name = 'PhotoBackupCapacityError';
        this.code = 'photo-backup-too-large';
        this.actualBytes = actualBytes;
        this.maxBytes = maxBytes;
    }
}

const cleanTime = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const cleanVersion = (value: unknown): string => String(value ?? '').trim().slice(0, 100);

const publicPhoto = (value: unknown): PhotoBackupPublicPhoto | null => {
    const photo = Library.cleanPhoto(value);
    if (!photo || photo.deletedAt) return null;
    return {
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
    };
};

const cleanRecord = (value: unknown): PhotoBackupRecord | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const publicValue = publicPhoto({
        ...raw,
        backup: { state: 'restored', signature: null, backedUpAt: null, commitUrl: null },
        assets: {
            originalRetained: false,
            projectRetained: !!raw.project,
            thumbnailRetained: false,
        },
        deletedAt: null,
    });
    if (!publicValue) return null;
    const project = raw.project == null ? null : Project.cleanProject(raw.project);
    if (raw.project != null && (!project || project.localId !== publicValue.localId
        || project.image.sourceSha256 !== publicValue.source.sha256)) return null;
    return { ...publicValue, project };
};

const recordFromBundle = (value: unknown): PhotoBackupRecord | null => {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const photo = publicPhoto(raw.photo);
    if (!photo) return null;
    const project = raw.project == null ? null : Project.cleanProject(raw.project);
    if (raw.project != null && (!project || project.localId !== photo.localId
        || project.image.sourceSha256 !== photo.source.sha256)) return null;
    return { ...photo, project };
};

const cleanTombstone = (value: unknown): PhotoBackupTombstone | null => {
    const record = value && typeof value === 'object' ? value as { localId?: unknown; deletedAt?: unknown } : null;
    const localId = typeof record?.localId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(record.localId)
        ? record.localId
        : null;
    const deletedAt = cleanTime(record?.deletedAt);
    return localId && deletedAt ? { localId, deletedAt } : null;
};

const stableRecords = (values: readonly unknown[]): PhotoBackupRecord[] => {
    const records = new Map<string, PhotoBackupRecord>();
    for (const value of Array.isArray(values) ? values : []) {
        const record = recordFromBundle(value) || cleanRecord(value);
        if (!record || records.has(record.localId)) throw new TypeError('photo backup contains an invalid or duplicate photo');
        records.set(record.localId, record);
    }
    return [...records.values()].sort((a, b) => a.localId.localeCompare(b.localId));
};

const stableTombstones = (values: readonly unknown[]): PhotoBackupTombstone[] => {
    const tombstones = new Map<string, PhotoBackupTombstone>();
    for (const value of Array.isArray(values) ? values : []) {
        const tombstone = cleanTombstone(value);
        if (!tombstone) throw new TypeError('photo backup contains an invalid tombstone');
        const previous = tombstones.get(tombstone.localId);
        if (!previous || previous.deletedAt < tombstone.deletedAt) {
            tombstones.set(tombstone.localId, tombstone);
        }
    }
    return [...tombstones.values()].sort((a, b) => a.localId.localeCompare(b.localId));
};

const unwrapBundlePhoto = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object') return null;
    const candidate = (value as { photo?: unknown }).photo || value;
    return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null;
};

const buildPayload = ({
    bundles = [],
    tombstones = [],
    exportedAt = new Date().toISOString(),
    extensionVersion = '',
}: BuildPhotoBackupPayloadOptions = {}): PhotoBackupPayload => {
    const timestamp = cleanTime(exportedAt);
    if (!timestamp) throw new TypeError('photo backup requires an export time');
    const bundleValues = Array.isArray(bundles) ? bundles : [];
    const photos = stableRecords(bundleValues.filter(value => !unwrapBundlePhoto(value)?.deletedAt));
    const deleted = stableTombstones([
        ...tombstones,
        ...bundleValues
            .map(unwrapBundlePhoto)
            .filter((value): value is Record<string, unknown> => !!value?.deletedAt)
            .map(value => ({ localId: value.localId, deletedAt: value.deletedAt })),
    ]);
    const deletedIds = new Set(deleted.map(value => value.localId));
    return {
        kind: KIND,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: timestamp,
        extensionVersion: cleanVersion(extensionVersion),
        photos: photos.filter(value => !deletedIds.has(value.localId)),
        tombstones: deleted,
    };
};

const normalizePayload = (payload: PhotoBackupPayloadInput | null | undefined): PhotoBackupPayload => buildPayload({
    bundles: payload?.photos,
    tombstones: payload?.tombstones,
    exportedAt: payload?.exportedAt,
    extensionVersion: payload?.extensionVersion,
});

const contentTimestamp = (payload: PhotoBackupPayload): string => [
    ...payload.photos.map(value => value.updatedAt),
    ...payload.tombstones.map(value => value.deletedAt),
].sort().at(-1) || '1970-01-01T00:00:00.000Z';

const canonicalDocument = (
    payload: PhotoBackupPayloadInput | null | undefined,
    { maxBytes = MAX_BYTES }: { maxBytes?: number } = {},
): CanonicalPhotoBackupDocument => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
        throw new TypeError('photo backup requires a valid byte limit');
    }
    const built = normalizePayload(payload);
    const normalized: PhotoBackupPayload = {
        ...built,
        exportedAt: contentTimestamp(built),
        // Runtime version is diagnostic metadata, not recovery content. Keep
        // the canonical document stable across an extension upgrade so its
        // exact bytes can also be the content signature.
        extensionVersion: '',
    };
    const text = `${JSON.stringify(normalized, null, 2)}\n`;
    const bytes = encode(text);
    if (bytes.byteLength > maxBytes) throw new PhotoBackupCapacityError(bytes.byteLength, maxBytes);
    return { payload: normalized, text, bytes, byteLength: bytes.byteLength };
};

const serialize = (payload: PhotoBackupPayloadInput | null | undefined): string => canonicalDocument(payload).text;

const parse = (text: unknown): PhotoBackupParseResult => {
    if (typeof text !== 'string') return { ok: false, reason: 'not-text' };
    if (encode(text).byteLength > MAX_BYTES) return { ok: false, reason: 'too-large' };
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { return { ok: false, reason: 'not-json' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'wrong-kind' };
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind !== KIND) {
        return { ok: false, reason: 'wrong-kind' };
    }
    if (typeof record.schemaVersion !== 'number'
        || !Number.isInteger(record.schemaVersion)
        || record.schemaVersion > SCHEMA_VERSION) {
        return { ok: false, reason: 'newer-version' };
    }
    if (!Array.isArray(record.photos) || !Array.isArray(record.tombstones)) {
        return { ok: false, reason: 'invalid-record' };
    }
    try {
        return {
            ok: true,
            payload: buildPayload({
                bundles: record.photos,
                tombstones: record.tombstones,
                exportedAt: record.exportedAt as string | undefined,
                extensionVersion: record.extensionVersion as string | undefined,
            }),
        };
    } catch {
        return { ok: false, reason: 'invalid-record' };
    }
};

const digestHex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const legacySignature = (payload: PhotoBackupPayload): Promise<string> => digestHex(encode(JSON.stringify({
    photos: payload.photos,
    tombstones: payload.tombstones,
})));

const signature = async (payload: PhotoBackupPayloadInput | null | undefined): Promise<string> => {
    const canonical = canonicalDocument(payload);
    return digestHex(canonical.bytes);
};

const prepare = async (
    payload: PhotoBackupPayloadInput | null | undefined,
    options?: { maxBytes?: number },
): Promise<PreparedPhotoBackupDocument> => {
    const canonical = canonicalDocument(payload, options);
    return {
        ...canonical,
        signature: await digestHex(canonical.bytes),
    };
};

const entriesById = (payload: PhotoBackupPayload): Map<string, PhotoBackupEntry> => {
    const entries = new Map<string, PhotoBackupEntry>();
    payload.photos.forEach(record => entries.set(record.localId, { kind: 'photo', value: record }));
    payload.tombstones.forEach(tombstone => entries.set(tombstone.localId, {
        kind: 'tombstone',
        value: tombstone,
    }));
    return entries;
};

const entryTime = (entry: PhotoBackupEntry): string => entry.kind === 'photo'
    ? entry.value.updatedAt
    : entry.value.deletedAt;

const sameEntry = (left: PhotoBackupEntry, right: PhotoBackupEntry): boolean => left.kind === right.kind
    && JSON.stringify(left.value) === JSON.stringify(right.value);

const mergePayloads = async (
    local: PhotoBackupPayloadInput | null | undefined,
    remote: PhotoBackupPayloadInput | null | undefined,
    {
        exportedAt = new Date().toISOString(),
        extensionVersion = local?.extensionVersion || '',
        baseSignature = null,
        baseSignatureVersion = 2,
        conflictPolicy = 'stop',
    }: MergePhotoBackupOptions = {},
): Promise<PhotoBackupMergeResult> => {
    if (!['stop', 'keep-local'].includes(conflictPolicy)) {
        throw new TypeError('photo backup requires an explicit conflict policy');
    }
    const left = buildPayload({
        bundles: local?.photos,
        tombstones: local?.tombstones,
        exportedAt: local?.exportedAt,
        extensionVersion: local?.extensionVersion,
    });
    const right = buildPayload({
        bundles: remote?.photos,
        tombstones: remote?.tombstones,
        exportedAt: remote?.exportedAt,
        extensionVersion: remote?.extensionVersion,
    });
    const remoteSignature = await signature(right);
    const remoteIsBase = typeof baseSignature === 'string'
        && (baseSignature === remoteSignature
            || (baseSignatureVersion < 2 && baseSignature === await legacySignature(right)));
    const localEntries = entriesById(left);
    const remoteEntries = entriesById(right);
    const ids = [...new Set([...localEntries.keys(), ...remoteEntries.keys()])].sort();
    const chosen: PhotoBackupEntry[] = [];
    const conflicts: PhotoBackupConflict[] = [];
    const counts: PhotoBackupMergeCounts = { add: 0, update: 0, unchanged: 0, tombstoned: 0, conflict: 0 };

    for (const id of ids) {
        const localEntry = localEntries.get(id);
        const remoteEntry = remoteEntries.get(id);
        let entry: PhotoBackupEntry | undefined;
        if (!localEntry) {
            entry = remoteEntry;
            counts.add++;
        } else if (!remoteEntry) {
            entry = localEntry;
            counts.add++;
        } else if (sameEntry(localEntry, remoteEntry)) {
            entry = localEntry;
            counts.unchanged++;
        } else if (remoteIsBase) {
            entry = localEntry;
            counts.update++;
        } else if (localEntry.kind === 'tombstone' || remoteEntry.kind === 'tombstone') {
            const tombstone = localEntry.kind === 'tombstone' ? localEntry : remoteEntry;
            const record = localEntry.kind === 'photo' ? localEntry : remoteEntry;
            if (entryTime(tombstone) >= entryTime(record)) {
                entry = tombstone;
                counts.tombstoned++;
            } else if (conflictPolicy === 'keep-local') {
                entry = localEntry;
                conflicts.push({ localId: id, local: localEntry, remote: remoteEntry });
                counts.conflict++;
            } else {
                conflicts.push({ localId: id, local: localEntry, remote: remoteEntry });
                counts.conflict++;
            }
        } else if (conflictPolicy === 'keep-local') {
            entry = localEntry;
            conflicts.push({ localId: id, local: localEntry, remote: remoteEntry });
            counts.conflict++;
        } else {
            conflicts.push({ localId: id, local: localEntry, remote: remoteEntry });
            counts.conflict++;
        }
        if (entry) chosen.push(entry);
    }

    if (conflicts.length && conflictPolicy === 'stop') {
        return { ok: false, reason: 'conflict', conflicts, counts, remoteSignature };
    }
    const payload = buildPayload({
        bundles: chosen.filter((entry): entry is { kind: 'photo'; value: PhotoBackupRecord } => entry.kind === 'photo')
            .map(entry => entry.value),
        tombstones: chosen
            .filter((entry): entry is { kind: 'tombstone'; value: PhotoBackupTombstone } => entry.kind === 'tombstone')
            .map(entry => entry.value),
        exportedAt,
        extensionVersion,
    });
    const prepared = await prepare(payload);
    return {
        ok: true,
        payload: prepared.payload,
        counts,
        conflicts,
        remoteSignature,
        signature: prepared.signature,
        prepared,
    };
};

const restoreRecord = (
    record: unknown,
    { signature: backupSignature = null, restoredAt = null }: RestorePhotoBackupOptions = {},
): RestoredPhotoBundle | null => {
    const cleaned = cleanRecord(record);
    if (!cleaned) return null;
    const { project, ...photo } = cleaned;
    const restoredPhoto = Library.cleanPhoto({
        ...photo,
        backup: {
            state: 'restored',
            signature: backupSignature,
            backedUpAt: restoredAt,
            commitUrl: null,
        },
        assets: {
            originalRetained: false,
            projectRetained: !!project,
            thumbnailRetained: false,
        },
        deletedAt: null,
    });
    return restoredPhoto ? { photo: restoredPhoto, project } : null;
};

export const photoBackup = {
    KIND,
    SCHEMA_VERSION,
    BACKUP_PATH,
    MAX_BYTES,
    PhotoBackupCapacityError,
    buildPayload,
    prepare,
    serialize,
    parse,
    signature,
    mergePayloads,
    restoreRecord,
};
