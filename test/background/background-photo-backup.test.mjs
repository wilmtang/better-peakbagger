// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createGithubRoutes } from '../../src/background/github-routes.js';
import { photoBackup as Backup } from '../../src/photos/photo-backup.js';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';
import { photoProject as Project } from '../../src/photos/photo-project.js';
import { photoStore as Store } from '../../src/photos/photo-store.js';

const TIME = '2026-07-27T18:00:00.000Z';
const LATER = '2026-07-27T18:10:00.000Z';
const HASH = 'a'.repeat(64);
const photoSender = {
    url: 'chrome-extension://test-extension/photos/photos.html?mode=library',
    tab: { id: 91 },
};
const optionsSender = {
    url: 'chrome-extension://test-extension/options/options.html#github-photos-backup',
    tab: { id: 92 },
};

const makeStorageArea = () => {
    const values = {};
    return {
        values,
        async get(key) {
            if (key == null) return structuredClone(values);
            if (Array.isArray(key)) {
                return Object.fromEntries(key.map(name => [name, structuredClone(values[name])]));
            }
            return { [key]: structuredClone(values[key]) };
        },
        async set(patch) { Object.assign(values, structuredClone(patch)); },
        async remove(key) { delete values[key]; },
    };
};

const bundle = (localId = 'photo-1', title = 'North face topo', now = TIME) => {
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
    const project = Project.createProject({
        localId,
        width: 1600,
        height: 1200,
        sourceSha256: HASH,
        updatedAt: now,
    });
    return { photo, project };
};

const harness = async ({ remoteText = null, seed = null } = {}) => {
    const local = makeStorageArea();
    const session = makeStorageArea();
    const indexedDB = new IDBFactory();
    const databaseName = `photo-backup-${crypto.randomUUID()}`;
    const createPhotoStore = () => Store.createPhotoStore({ indexedDB, name: databaseName });
    if (seed) {
        const store = await createPhotoStore();
        await store.putDraft({
            ...seed,
            original: new Blob(['private pixels'], { type: 'image/jpeg' }),
            thumbnail: new Blob(['private thumbnail'], { type: 'image/jpeg' }),
        });
        store.close();
    }
    const commits = [];
    const client = {
        async readRootFile(path) {
            assert.equal(path, Backup.BACKUP_PATH);
            return remoteText;
        },
        async updateRootFile(path, update, message) {
            assert.equal(path, Backup.BACKUP_PATH);
            remoteText = await update(remoteText);
            commits.push({ path, message, content: remoteText });
            return {
                sha: `commit-${commits.length}`,
                commitUrl: `https://github.com/me/backup/commit/${commits.length}`,
                path,
                unchanged: false,
            };
        },
        async putRootFiles() {
            throw new Error('coalesced writes are outside this photo-route test');
        },
    };
    const ext = {
        runtime: {
            getURL: path => `chrome-extension://test-extension/${path}`,
            getManifest: () => ({ version: '3.2.0' }),
        },
        storage: { local },
        alarms: { create() {} },
    };
    let queue = Promise.resolve();
    const readMap = async key => (await session.get(key))[key] || {};
    const mutateMap = (key, mutate) => {
        const result = queue.then(async () => {
            const value = await readMap(key);
            const answer = await mutate(value);
            await session.set({ [key]: value });
            return answer;
        });
        queue = result.catch(() => {});
        return result;
    };
    const routes = createGithubRoutes({
        ext,
        snapshotKey: 'snapshots',
        storage: () => session,
        now: () => Date.parse(LATER),
        peakbaggerLogin: async () => null,
        isPeakbaggerSender: () => false,
        isClimbListSender: () => false,
        isFresh: () => false,
        readMap,
        mutateMap,
        createPhotoStore,
        resolveGithubAccess: async () => ({
            client,
            repo: { owner: 'me', name: 'backup', branch: 'main' },
        }),
    });
    return {
        routes,
        local,
        commits,
        createPhotoStore,
        get remoteText() { return remoteText; },
    };
};

test('manual backup reads IndexedDB itself and writes only the metadata recovery document', async () => {
    const h = await harness({ seed: bundle() });
    const response = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    assert.equal(response.ok, true);
    assert.equal(h.commits.length, 1);
    const parsed = Backup.parse(h.remoteText);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.payload.photos.map(value => value.localId), ['photo-1']);
    assert.equal(h.remoteText.includes('private pixels'), false);
    const store = await h.createPhotoStore();
    assert.equal((await store.getBundle('photo-1')).photo.backup.state, 'current');
    store.close();

    const forbidden = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, {
        url: 'chrome-extension://test-extension/popup/popup.html',
    });
    assert.equal(forbidden.error.code, 'forbidden');
});

test('Settings drives the same recovery routes, and only the library announces a change', async () => {
    // Settings is where every other GitHub backup lives, so it has to reach
    // these routes; a page that neither shows nor writes the catalog must not.
    const h = await harness({ seed: bundle() });
    // STATUS reads the auth store this harness does not stand up, so reaching
    // its failure is itself proof the sender gate let it through.
    await assert.rejects(h.routes.handlers.GITHUB_PHOTOS_STATUS({}, optionsSender),
        /authorization storage is unavailable/);
    for (const type of ['GITHUB_PHOTOS_BACKUP', 'GITHUB_PHOTOS_RESTORE_PREVIEW']) {
        const response = await h.routes.handlers[type]({}, optionsSender);
        assert.notEqual(response.error?.code, 'forbidden', type);
    }
    const restored = await h.routes.handlers.GITHUB_PHOTOS_RESTORE({ signature: 'x' }, optionsSender);
    assert.equal(restored.error.code, 'invalid-restore', 'reached the route, not the gate');

    // Announcing a catalog change stays with the page that writes the catalog.
    assert.equal(
        (await h.routes.handlers.GITHUB_PHOTOS_CHANGED({}, optionsSender)).error.code,
        'forbidden',
    );
    assert.equal((await h.routes.handlers.GITHUB_PHOTOS_CHANGED({}, photoSender)).ok, true);

    for (const sender of [
        { url: 'https://www.peakbagger.com/climber/ascentedit.aspx', tab: { id: 4 } },
        { url: 'chrome-extension://other-extension/options/options.html' },
        { url: 'chrome-extension://test-extension/options/evil.html' },
        {},
    ]) {
        assert.equal(
            (await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, sender)).error.code,
            'forbidden',
            JSON.stringify(sender),
        );
    }
});

test('a divergent same-id remote edit stops backup without replacing the repository file', async () => {
    const localBundle = bundle('photo-1', 'Local title', LATER);
    const remotePayload = Backup.buildPayload({
        bundles: [bundle('photo-1', 'Remote title', TIME)],
        exportedAt: TIME,
    });
    const originalRemote = Backup.serialize(remotePayload);
    const h = await harness({ seed: localBundle, remoteText: originalRemote });
    const response = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'photo-backup-conflict');
    assert.equal(response.error.conflictCount, 1);
    assert.equal(h.remoteText, originalRemote);
    assert.equal(h.commits.length, 0);
});

test('restore previews counts then atomically imports metadata without original pixels', async () => {
    const remote = Backup.buildPayload({
        bundles: [bundle('remote-photo')],
        tombstones: [{ localId: 'deleted-elsewhere', deletedAt: LATER }],
        exportedAt: TIME,
    });
    const h = await harness({ remoteText: Backup.serialize(remote) });
    const preview = await h.routes.handlers.GITHUB_PHOTOS_RESTORE_PREVIEW({}, photoSender);
    assert.equal(preview.ok, true);
    assert.equal(preview.remotePhotos, 1);
    assert.equal(preview.remoteTombstones, 1);
    assert.deepEqual(preview.conflicts, []);

    const restored = await h.routes.handlers.GITHUB_PHOTOS_RESTORE({
        signature: preview.signature,
        keepLocalConflicts: false,
    }, photoSender);
    assert.equal(restored.ok, true);
    const store = await h.createPhotoStore();
    const imported = await store.getBundle('remote-photo');
    assert.equal(imported.photo.backup.state, 'restored');
    assert.equal(imported.original, null);
    assert.equal(imported.thumbnail, null);
    assert.equal(imported.deleteUrl, null);
    assert.equal(imported.project.localId, 'remote-photo');
    assert.deepEqual((await store.listBackupBundles()).tombstones,
        [{ localId: 'deleted-elsewhere', deletedAt: LATER }]);
    store.close();
});
