// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic, metadata-only photo-library recovery documents.

import { photoProject as Project } from './photo-project.js';
import { photoLibrary as Library } from './photo-library.js';

const SCHEMA_VERSION = 1;
const BACKUP_PATH = 'photo-library.json';
const MAX_BYTES = 8 * 1024 * 1024;
const KIND = 'better-peakbagger-photo-library';
const encode = value => new TextEncoder().encode(value);

const cleanTime = value => {
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const cleanVersion = value => String(value ?? '').trim().slice(0, 100);

const publicPhoto = value => {
    const photo = Library.cleanPhoto(value);
    if (!photo || photo.deletedAt) return null;
    return {
        schemaVersion: photo.schemaVersion,
        localId: photo.localId,
        createdAt: photo.createdAt,
        updatedAt: photo.updatedAt,
        title: photo.title,
        alt: photo.alt,
        decorative: photo.decorative,
        source: photo.source,
        export: photo.export,
        remote: photo.remote,
        lineage: photo.lineage,
        references: photo.references,
    };
};

const cleanRecord = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const publicValue = publicPhoto({
        ...value,
        backup: { state: 'restored', signature: null, backedUpAt: null, commitUrl: null },
        assets: {
            originalRetained: false,
            projectRetained: !!value.project,
            thumbnailRetained: false,
        },
        deletedAt: null,
    });
    if (!publicValue) return null;
    const project = value.project == null ? null : Project.cleanProject(value.project);
    if (value.project != null && (!project || project.localId !== publicValue.localId
        || project.image.sourceSha256 !== publicValue.source.sha256)) return null;
    return { ...publicValue, project };
};

const recordFromBundle = value => {
    if (!value || typeof value !== 'object') return null;
    const photo = publicPhoto(value.photo);
    if (!photo) return null;
    const project = value.project == null ? null : Project.cleanProject(value.project);
    if (value.project != null && (!project || project.localId !== photo.localId
        || project.image.sourceSha256 !== photo.source.sha256)) return null;
    return { ...photo, project };
};

const cleanTombstone = value => {
    const localId = typeof value?.localId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.localId)
        ? value.localId
        : null;
    const deletedAt = cleanTime(value?.deletedAt);
    return localId && deletedAt ? { localId, deletedAt } : null;
};

const stableRecords = values => {
    const records = new Map();
    for (const value of Array.isArray(values) ? values : []) {
        const record = recordFromBundle(value) || cleanRecord(value);
        if (!record || records.has(record.localId)) throw new TypeError('photo backup contains an invalid or duplicate photo');
        records.set(record.localId, record);
    }
    return [...records.values()].sort((a, b) => a.localId.localeCompare(b.localId));
};

const stableTombstones = values => {
    const tombstones = new Map();
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

const buildPayload = ({
    bundles = [],
    tombstones = [],
    exportedAt = new Date().toISOString(),
    extensionVersion = '',
} = {}) => {
    const timestamp = cleanTime(exportedAt);
    if (!timestamp) throw new TypeError('photo backup requires an export time');
    const bundleValues = Array.isArray(bundles) ? bundles : [];
    const photos = stableRecords(bundleValues.filter(value => !(value?.photo || value)?.deletedAt));
    const deleted = stableTombstones([
        ...tombstones,
        ...bundleValues
            .map(value => value?.photo || value)
            .filter(value => value?.deletedAt)
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

const serialize = payload => {
    const normalized = buildPayload({
        bundles: payload?.photos,
        tombstones: payload?.tombstones,
        exportedAt: payload?.exportedAt,
        extensionVersion: payload?.extensionVersion,
    });
    const text = `${JSON.stringify(normalized, null, 2)}\n`;
    if (encode(text).byteLength > MAX_BYTES) {
        throw new RangeError('photo-library.json exceeds the 8 MB recovery limit');
    }
    return text;
};

const parse = text => {
    if (typeof text !== 'string') return { ok: false, reason: 'not-text' };
    if (encode(text).byteLength > MAX_BYTES) return { ok: false, reason: 'too-large' };
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return { ok: false, reason: 'not-json' }; }
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== KIND) {
        return { ok: false, reason: 'wrong-kind' };
    }
    if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion > SCHEMA_VERSION) {
        return { ok: false, reason: 'newer-version' };
    }
    if (!Array.isArray(parsed.photos) || !Array.isArray(parsed.tombstones)) {
        return { ok: false, reason: 'invalid-record' };
    }
    try {
        return {
            ok: true,
            payload: buildPayload({
                bundles: parsed.photos,
                tombstones: parsed.tombstones,
                exportedAt: parsed.exportedAt,
                extensionVersion: parsed.extensionVersion,
            }),
        };
    } catch {
        return { ok: false, reason: 'invalid-record' };
    }
};

const contentIdentity = payload => JSON.stringify({
    photos: payload.photos,
    tombstones: payload.tombstones,
});

const signature = async payload => {
    const normalized = buildPayload({
        bundles: payload?.photos,
        tombstones: payload?.tombstones,
        exportedAt: payload?.exportedAt,
        extensionVersion: payload?.extensionVersion,
    });
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        encode(contentIdentity(normalized)),
    );
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const entriesById = payload => {
    const entries = new Map();
    payload.photos.forEach(record => entries.set(record.localId, { kind: 'photo', value: record }));
    payload.tombstones.forEach(tombstone => entries.set(tombstone.localId, {
        kind: 'tombstone',
        value: tombstone,
    }));
    return entries;
};

const entryTime = entry => entry.kind === 'photo'
    ? entry.value.updatedAt
    : entry.value.deletedAt;

const sameEntry = (left, right) => left.kind === right.kind
    && JSON.stringify(left.value) === JSON.stringify(right.value);

const mergePayloads = async (local, remote, {
    exportedAt = new Date().toISOString(),
    extensionVersion = local?.extensionVersion || '',
    baseSignature = null,
    conflictPolicy = 'stop',
} = {}) => {
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
    const remoteIsBase = typeof baseSignature === 'string' && baseSignature === remoteSignature;
    const localEntries = entriesById(left);
    const remoteEntries = entriesById(right);
    const ids = [...new Set([...localEntries.keys(), ...remoteEntries.keys()])].sort();
    const chosen = [];
    const conflicts = [];
    const counts = { add: 0, update: 0, unchanged: 0, tombstoned: 0, conflict: 0 };

    for (const id of ids) {
        const localEntry = localEntries.get(id);
        const remoteEntry = remoteEntries.get(id);
        let entry;
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
        bundles: chosen.filter(entry => entry.kind === 'photo').map(entry => entry.value),
        tombstones: chosen.filter(entry => entry.kind === 'tombstone').map(entry => entry.value),
        exportedAt,
        extensionVersion,
    });
    return {
        ok: true,
        payload,
        counts,
        conflicts,
        remoteSignature,
        signature: await signature(payload),
    };
};

const restoreRecord = (record, { signature: backupSignature = null, restoredAt = null } = {}) => {
    const cleaned = cleanRecord(record);
    if (!cleaned) return null;
    const { project, ...photo } = cleaned;
    return {
        photo: Library.cleanPhoto({
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
        }),
        project,
    };
};

export const photoBackup = {
    KIND,
    SCHEMA_VERSION,
    BACKUP_PATH,
    MAX_BYTES,
    buildPayload,
    serialize,
    parse,
    signature,
    mergePayloads,
    restoreRecord,
};
