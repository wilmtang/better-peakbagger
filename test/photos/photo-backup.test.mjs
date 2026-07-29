// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { photoBackup as Backup } from '../../src/photos/photo-backup.js';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';
import { photoProject as Project } from '../../src/photos/photo-project.js';

const TIME = '2026-07-27T18:00:00.000Z';
const LATER = '2026-07-27T18:10:00.000Z';
const HASH = 'a'.repeat(64);

const bundle = ({ localId = 'photo-1', title = 'North face topo', now = TIME } = {}) => {
    const photo = Library.createDraft({
        localId,
        title,
        alt: 'North face route',
        source: {
            fileName: 'north.jpg',
            mime: 'image/jpeg',
            bytes: 1234,
            width: 1600,
            height: 1200,
            sha256: HASH,
        },
        now,
    });
    return {
        photo,
        project: Project.createProject({
            localId,
            width: 1600,
            height: 1200,
            sourceSha256: HASH,
            updatedAt: now,
        }),
        original: new Blob(['private pixels']),
        deleteUrl: 'https://ibb.co/delete/private',
        operation: { state: 'request-started' },
        apiKey: 'private-key',
    };
};

const payload = values => Backup.buildPayload({
    bundles: values,
    exportedAt: TIME,
    extensionVersion: '3.2.0',
});

test('serializes deterministic metadata and annotation projects without local secrets or pixels', async () => {
    const first = bundle({ localId: 'photo-b' });
    const second = bundle({ localId: 'photo-a' });
    const document = payload([first, second]);
    const text = Backup.serialize(document);
    const parsed = Backup.parse(text);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.payload.photos.map(value => value.localId), ['photo-a', 'photo-b']);
    assert.equal(parsed.payload.photos[0].project.localId, 'photo-a');
    assert.equal(text.includes('private-key'), false);
    assert.equal(text.includes('private pixels'), false);
    assert.equal(text.includes('/delete/private'), false);
    assert.equal(text.includes('request-started'), false);
    assert.match(await Backup.signature(document), /^[0-9a-f]{64}$/);
    assert.equal(await Backup.signature(document), await Backup.signature(parsed.payload));
});

test('deleted records become bounded tombstones and cannot also appear as live photos', () => {
    const active = bundle({ localId: 'photo-active' });
    const deleted = bundle({ localId: 'photo-deleted' });
    deleted.photo = Library.markDeleted(deleted.photo, LATER);
    const document = payload([deleted, active]);

    assert.deepEqual(document.photos.map(value => value.localId), ['photo-active']);
    assert.deepEqual(document.tombstones, [{ localId: 'photo-deleted', deletedAt: LATER }]);
});

test('rejects malformed, oversized, and unsupported future recovery documents', () => {
    assert.deepEqual(Backup.parse('{'), { ok: false, reason: 'not-json' });
    assert.deepEqual(Backup.parse(JSON.stringify({
        kind: Backup.KIND,
        schemaVersion: Backup.SCHEMA_VERSION + 1,
        photos: [],
        tombstones: [],
    })), { ok: false, reason: 'newer-version' });
    assert.deepEqual(Backup.parse('x'.repeat(Backup.MAX_BYTES + 1)),
        { ok: false, reason: 'too-large' });
});

test('merge preserves remote-only records and accepts local changes only from the known remote base', async () => {
    const changed = payload([
        bundle({ localId: 'photo-common', title: 'Revised topo', now: LATER }),
        bundle({ localId: 'photo-local' }),
    ]);
    const remote = payload([
        bundle({ localId: 'photo-common' }),
        bundle({ localId: 'photo-remote' }),
    ]);
    const baseSignature = await Backup.signature(remote);
    const merged = await Backup.mergePayloads(changed, remote, {
        exportedAt: LATER,
        baseSignature,
    });

    assert.equal(merged.ok, true);
    assert.deepEqual(merged.payload.photos.map(value => [value.localId, value.title]), [
        ['photo-common', 'Revised topo'],
        ['photo-local', 'North face topo'],
        ['photo-remote', 'North face topo'],
    ]);
});

test('merge stops on divergent same-id edits and lets a newer tombstone prevent resurrection', async () => {
    const local = payload([bundle({ title: 'Local edit', now: LATER })]);
    const remote = payload([bundle({ title: 'Remote edit', now: TIME })]);
    const conflict = await Backup.mergePayloads(local, remote);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'conflict');
    assert.deepEqual(conflict.conflicts.map(value => value.localId), ['photo-1']);

    const tombstoned = Backup.buildPayload({
        bundles: [],
        tombstones: [{ localId: 'photo-1', deletedAt: '2026-07-27T18:20:00.000Z' }],
        exportedAt: LATER,
    });
    const deletion = await Backup.mergePayloads(local, tombstoned);
    assert.equal(deletion.ok, true);
    assert.deepEqual(deletion.payload.photos, []);
    assert.equal(deletion.payload.tombstones[0].localId, 'photo-1');
});

test('restore can explicitly keep local versions while reporting every skipped conflict', async () => {
    const local = payload([bundle({ title: 'Keep this local edit', now: LATER })]);
    const remote = payload([bundle({ title: 'Conflicting remote edit', now: TIME })]);
    const merged = await Backup.mergePayloads(local, remote, {
        conflictPolicy: 'keep-local',
    });
    assert.equal(merged.ok, true);
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.counts.conflict, 1);
    assert.equal(merged.payload.photos[0].title, 'Keep this local edit');
});

test('restore reconstructs a catalog record without claiming pixels or deletion capability', async () => {
    const document = payload([bundle()]);
    const signature = await Backup.signature(document);
    const restored = Backup.restoreRecord(document.photos[0], {
        signature,
        restoredAt: LATER,
    });

    assert.equal(restored.photo.backup.state, 'restored');
    assert.equal(restored.photo.backup.signature, signature);
    assert.deepEqual(restored.photo.assets, {
        originalRetained: false,
        projectRetained: true,
        thumbnailRetained: false,
    });
    assert.equal(restored.project.localId, restored.photo.localId);
});
