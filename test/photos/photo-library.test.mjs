// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';

const TIME = '2026-07-27T18:00:00.000Z';
const LATER = '2026-07-27T18:10:00.000Z';
const HASH = 'a'.repeat(64);
const EXPORT_HASH = 'b'.repeat(64);
const source = {
    fileName: 'north face.jpg',
    mime: 'image/jpeg',
    bytes: 8_000_000,
    width: 4000,
    height: 3000,
    sha256: HASH,
};
const exported = {
    mime: 'image/jpeg',
    bytes: 7_000_000,
    width: 4000,
    height: 3000,
    sha256: EXPORT_HASH,
};
const remote = {
    providerId: 'abc123',
    url: 'https://i.ibb.co/a/topo.jpg',
    displayUrl: 'https://i.ibb.co/a/topo.jpg',
    viewerUrl: 'https://ibb.co/abc123',
    thumbnailUrl: 'https://i.ibb.co/a/topo-thumb.jpg',
    mediumUrl: null,
    uploadedAt: LATER,
    expiresAt: null,
};

const draft = () => Library.createDraft({
    localId: 'photo-1',
    title: 'North face topo',
    alt: 'North face with the Northeast Ridge marked in red',
    source,
    now: TIME,
});

test('creates and idempotently cleans a local draft record', () => {
    const photo = draft();
    assert.equal(photo.remote.state, 'draft');
    assert.equal(photo.export, null);
    assert.equal(photo.assets.originalRetained, true);
    assert.deepEqual(Library.cleanPhoto(photo), photo);
});

test('requires alt text unless the image is explicitly decorative', () => {
    assert.equal(Library.createDraft({
        localId: 'photo-1', title: 'Topo', source, now: TIME,
    }), null);
    const decorative = Library.createDraft({
        localId: 'photo-1', title: 'Decoration', decorative: true,
        alt: 'discard this', source, now: TIME,
    });
    assert.equal(decorative.alt, '');
});

test('moves through upload, ambiguous, completed, and observed-health states', () => {
    const photo = draft();
    const uploading = Library.beginUpload(photo, exported, LATER);
    assert.equal(uploading.remote.state, 'uploading');
    assert.equal(uploading.export, null, 'pending export belongs to the operation journal');

    const unknown = Library.markOutcomeUnknown(uploading, LATER);
    assert.equal(unknown.remote.state, 'outcome-unknown');

    const complete = Library.completeUpload(unknown, exported, remote, LATER);
    assert.equal(complete.remote.state, 'uploaded');
    assert.deepEqual(complete.export, exported);
    assert.equal(complete.remote.url, remote.url);

    const unreachable = Library.markUnreachable(complete, true, LATER);
    assert.equal(unreachable.remote.state, 'unreachable');
    assert.equal(Library.markUnreachable(unreachable, false, LATER).remote.state, 'uploaded');
});

test('adds bounded references and separates local deletion from remote state', () => {
    const complete = Library.completeUpload(draft(), exported, remote, LATER);
    const referenced = Library.addReference(complete, {
        kind: 'ascent-draft',
        cid: 22,
        aid: null,
        pid: 33,
        insertedAt: LATER,
    }, LATER);
    assert.equal(referenced.references.length, 1);
    assert.equal(referenced.remote.state, 'uploaded');

    const deleted = Library.markDeleted(referenced, LATER);
    assert.equal(deleted.deletedAt, LATER);
    assert.equal(deleted.remote.state, 'uploaded');
    assert.equal(Library.restoreDeleted(deleted, LATER).deletedAt, null);
});

test('search and filters use catalog state without inferring provider contents', () => {
    const complete = Library.completeUpload(draft(), exported, remote, LATER);
    const other = Library.createDraft({
        localId: 'photo-2',
        title: 'South face',
        alt: 'South face',
        source: { ...source, fileName: 'south.png' },
        now: TIME,
    });
    assert.deepEqual(Library.search([other, complete], 'north').map(photo => photo.localId), ['photo-1']);
    assert.deepEqual(Library.search([other, complete], '', 'drafts').map(photo => photo.localId), ['photo-2']);
    assert.deepEqual(Library.search([other, complete], '', 'not-inserted')
        .map(photo => photo.localId), ['photo-1']);
});

test('rejects malformed provider URLs and impossible uploaded shapes', () => {
    const complete = Library.completeUpload(draft(), exported, {
        ...remote,
        url: 'http://i.ibb.co/a/topo.jpg',
    }, LATER);
    assert.equal(complete, null);
    assert.equal(Library.cleanPhoto({
        ...draft(),
        remote: { provider: 'imgbb', state: 'uploaded', ...remote },
        export: null,
    }), null);
});
