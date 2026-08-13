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

const makeStorageArea = ({ values = {}, setHook = null } = {}) => {
    return {
        values,
        async get(key) {
            if (key == null) return structuredClone(values);
            if (Array.isArray(key)) {
                return Object.fromEntries(key.map(name => [name, structuredClone(values[name])]));
            }
            return { [key]: structuredClone(values[key]) };
        },
        async set(patch) {
            if (setHook) await setHook(structuredClone(patch), values);
            Object.assign(values, structuredClone(patch));
        },
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

// onSettingsChanged fires the gate check without awaiting it (a storage
// subscriber must not block). Drain the microtask/storage turns it needs.
const waitForAlarms = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const waitFor = async (predicate, ms = 2000) => {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > ms) throw new Error('waitFor timed out');
        await new Promise(resolve => setTimeout(resolve, 0));
    }
};
const deferred = () => {
    let resolve;
    const promise = new Promise(next => { resolve = next; });
    return { promise, resolve };
};

const harness = async ({
    remoteText = null,
    remoteState = null,
    seed = null,
    seeds = null,
    localValues = null,
    localSetHook = null,
    indexedDB: sharedIndexedDB = null,
    databaseName: sharedDatabaseName = null,
    commits: sharedCommits = null,
    beforeRemoteUpdate = null,
    decoratePhotoStore = null,
    autoEnabled = true,
} = {}) => {
    const local = makeStorageArea({ values: localValues || {}, setHook: localSetHook });
    const session = makeStorageArea();
    const indexedDB = sharedIndexedDB || new IDBFactory();
    const databaseName = sharedDatabaseName || `photo-backup-${crypto.randomUUID()}`;
    const rawPhotoStore = () => Store.createPhotoStore({ indexedDB, name: databaseName });
    const createPhotoStore = async () => {
        const store = await rawPhotoStore();
        return decoratePhotoStore ? decoratePhotoStore(store) : store;
    };
    for (const value of seeds || (seed ? [seed] : [])) {
        const store = await rawPhotoStore();
        await store.putDraft({
            ...value,
            original: new Blob(['private pixels'], { type: 'image/jpeg' }),
            thumbnail: new Blob(['private thumbnail'], { type: 'image/jpeg' }),
        });
        store.close();
    }
    const remote = remoteState || { text: remoteText };
    const commits = sharedCommits || [];
    let accessCalls = 0;
    let updateCalls = 0;
    let photoSettingsReads = 0;
    const client = {
        async readRootFile(path) {
            assert.equal(path, Backup.BACKUP_PATH);
            return remote.text;
        },
        async updateRootFile(path, update, message) {
            updateCalls += 1;
            assert.equal(path, Backup.BACKUP_PATH);
            if (beforeRemoteUpdate) await beforeRemoteUpdate({ calls: commits.length });
            const previous = remote.text;
            const next = await update(previous);
            if (next === previous) {
                return {
                    sha: commits.at(-1)?.sha || null,
                    commitUrl: commits.at(-1)?.commitUrl || null,
                    path,
                    unchanged: true,
                };
            }
            remote.text = next;
            const commit = {
                sha: `commit-${commits.length + 1}`,
                commitUrl: `https://github.com/me/backup/commit/${commits.length + 1}`,
                path,
                message,
                content: remote.text,
            };
            commits.push(commit);
            return {
                sha: commit.sha,
                commitUrl: commit.commitUrl,
                path,
                unchanged: false,
            };
        },
        async putRootFiles() {
            throw new Error('coalesced writes are outside this photo-route test');
        },
    };
    const alarmed = [];
    const alarms = new Map();
    const ext = {
        runtime: {
            getURL: path => `chrome-extension://test-extension/${path}`,
            getManifest: () => ({ version: '3.2.0' }),
        },
        storage: { local },
        alarms: {
            create(name, options = {}) {
                alarmed.push(name);
                alarms.set(name, { name, ...options });
            },
            async get(name) { return alarms.get(name); },
            async clear(name) { return alarms.delete(name); },
        },
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
        resolveGithubAccess: async () => {
            accessCalls += 1;
            return {
                client,
                repo: { owner: 'me', name: 'backup', branch: 'main' },
            };
        },
        photoBackupSettings: {
            get: async () => {
                photoSettingsReads += 1;
                return { autoPhotoLibraryBackup: autoEnabled };
            },
        },
    });
    return {
        routes,
        local,
        commits,
        alarmed,
        alarms,
        createPhotoStore,
        indexedDB,
        databaseName,
        remoteState: remote,
        accessCalls: () => accessCalls,
        updateCalls: () => updateCalls,
        photoSettingsReads: () => photoSettingsReads,
        get remoteText() { return remote.text; },
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

test('an oversized local catalog fails before GitHub and blocks automatic repeats by generation', async () => {
    const bundles = [];
    const revisions = {};
    for (let index = 0; index < 8000; index += 1) {
        const value = bundle(`capacity-photo-${index}`);
        bundles.push(value);
        revisions[value.photo.localId] = 0;
    }
    let generation = 1;
    const catalog = () => ({
        key: Store.CATALOG_STATE_KEY,
        generation,
        confirmedGeneration: 0,
        signature: null,
        commitUrl: null,
        backedUpAt: null,
        revisions: {},
    });
    const h = await harness({
        decoratePhotoStore: store => ({
            ...store,
            getCatalogState: async () => catalog(),
            listBackupBundles: async () => ({
                bundles,
                tombstones: [],
                revisions,
                catalog: catalog(),
            }),
        }),
    });

    const response = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'photo-backup-too-large');
    assert.ok(response.error.actualBytes > response.error.maxBytes);
    assert.match(response.error.message, /Recently Deleted/);
    assert.equal(h.updateCalls(), 0, 'local capacity is checked before a GitHub update starts');
    assert.equal(h.local.values.bpbPhotoLibraryBackupState.capacityBlockedGeneration, 1);

    const accesses = h.accessCalls();
    await h.routes.onAlarm('bpb-photo-library-backup');
    assert.equal(h.accessCalls(), accesses, 'the same hopeless generation is not rebuilt remotely');

    generation = 2;
    await h.routes.onAlarm('bpb-photo-library-backup');
    assert.equal(h.accessCalls(), accesses + 1);
    assert.equal(h.local.values.bpbPhotoLibraryBackupState.capacityBlockedGeneration, 2);
    assert.equal(h.updateCalls(), 0);
});

test('a remote merge that exceeds capacity stops before the repository mutation', async () => {
    const makeBundles = (prefix, count) => Array.from({ length: count }, (_, index) =>
        bundle(`${prefix}-${index}`));
    const localBundles = makeBundles('local-capacity', 4000);
    const remotePayload = Backup.buildPayload({
        bundles: makeBundles('remote-capacity', 4000),
        exportedAt: TIME,
    });
    const originalRemote = Backup.serialize(remotePayload);
    const revisions = Object.fromEntries(localBundles.map(value => [value.photo.localId, 0]));
    const catalog = {
        key: Store.CATALOG_STATE_KEY,
        generation: 1,
        confirmedGeneration: 0,
        signature: null,
        commitUrl: null,
        backedUpAt: null,
        revisions: {},
    };
    const h = await harness({
        remoteText: originalRemote,
        decoratePhotoStore: store => ({
            ...store,
            listBackupBundles: async () => ({
                bundles: localBundles,
                tombstones: [],
                revisions,
                catalog,
            }),
        }),
    });

    const response = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'photo-backup-too-large');
    assert.equal(h.updateCalls(), 1, 'the remote document must be read before its merge can be sized');
    assert.equal(h.commits.length, 0);
    assert.equal(h.remoteText, originalRemote);
});

test('overlapping manual backups serialize snapshot through local reconciliation', async () => {
    const started = deferred();
    const release = deferred();
    let updates = 0;
    const h = await harness({
        seed: bundle(),
        beforeRemoteUpdate: async () => {
            updates += 1;
            if (updates === 1) {
                started.resolve();
                await release.promise;
            }
        },
    });
    const first = h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    await started.promise;
    const second = h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, optionsSender);
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.unchanged, true);
    assert.equal(h.commits.length, 1);
    const state = h.local.values.bpbPhotoLibraryBackupState;
    assert.equal(state.reconciliationPending, false);
    const store = await h.createPhotoStore();
    const saved = (await store.getBundle('photo-1')).photo;
    assert.equal(saved.backup.state, 'current');
    assert.equal(saved.backup.signature, state.signature);
    store.close();
});

test('manual and automatic backups share the complete transaction queue', async () => {
    const started = deferred();
    const release = deferred();
    let updates = 0;
    const h = await harness({
        seed: bundle(),
        beforeRemoteUpdate: async () => {
            updates += 1;
            if (updates === 1) {
                started.resolve();
                await release.promise;
            }
        },
    });
    const manual = h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    await started.promise;
    h.routes.onAlarm('bpb-photo-library-backup');
    release.resolve();
    assert.equal((await manual).ok, true);
    await waitFor(() => h.accessCalls() >= 2);

    assert.equal(h.commits.length, 1);
    assert.equal(h.local.values.bpbPhotoLibraryBackupState.reconciliationPending, false);
    assert.deepEqual(h.alarmed, []);
});

test('overlapping automatic alarm deliveries produce one remote commit', async () => {
    const started = deferred();
    const release = deferred();
    let updates = 0;
    const h = await harness({
        seed: bundle(),
        beforeRemoteUpdate: async () => {
            updates += 1;
            if (updates === 1) {
                started.resolve();
                await release.promise;
            }
        },
    });
    h.routes.onAlarm('bpb-photo-library-backup');
    await started.promise;
    h.routes.onAlarm('bpb-photo-library-backup');
    release.resolve();
    await waitFor(() => h.accessCalls() >= 2
        && h.local.values.bpbPhotoLibraryBackupState?.reconciliationPending === false);

    assert.equal(h.commits.length, 1);
    assert.deepEqual(h.alarmed, []);
});

test('an unchanged manual backup is coalesced without another remote write', async () => {
    const h = await harness({ seed: bundle() });
    const first = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    const second = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
    assert.equal(h.commits.length, 1);
    assert.equal(second.signature, first.signature);
});

test('a photo edit during the remote commit remains pending instead of failing the catalog', async () => {
    const started = deferred();
    const release = deferred();
    const h = await harness({
        seed: bundle(),
        beforeRemoteUpdate: async () => {
            started.resolve();
            await release.promise;
        },
    });
    const backingUp = h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    await started.promise;
    const store = await h.createPhotoStore();
    const current = (await store.getBundle('photo-1')).photo;
    await store.putPhoto(Library.cleanPhoto({
        ...current,
        title: 'Edited while GitHub committed',
        updatedAt: LATER,
        backup: { ...current.backup, state: 'pending' },
    }));
    store.close();
    release.resolve();
    const result = await backingUp;

    assert.equal(result.ok, true);
    assert.equal(result.reconciliationPending, true);
    assert.equal(h.commits.length, 1);
    assert.equal(h.local.values.bpbPhotoLibraryBackupState.reconciliationPending, true);
    const after = await h.createPhotoStore();
    const edited = (await after.getBundle('photo-1')).photo;
    assert.equal(edited.title, 'Edited while GitHub committed');
    assert.equal(edited.backup.state, 'pending');
    after.close();

    const retried = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    assert.equal(retried.ok, true);
    assert.equal(retried.current, true);
    assert.equal(h.commits.length, 2);
    assert.equal(Backup.parse(h.remoteText).payload.photos[0].title,
        'Edited while GitHub committed');
});

test('delete and restore during commit preserve the newer local record for retry', async () => {
    const started = deferred();
    const release = deferred();
    const h = await harness({
        seed: bundle(),
        beforeRemoteUpdate: async () => {
            started.resolve();
            await release.promise;
        },
    });
    const backingUp = h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    await started.promise;
    const store = await h.createPhotoStore();
    const current = (await store.getBundle('photo-1')).photo;
    const pending = Library.cleanPhoto({
        ...current,
        backup: { ...current.backup, state: 'pending' },
    });
    const deleted = await store.putPhoto(Library.markDeleted(pending, LATER));
    await store.restorePhoto(Library.restoreDeleted(deleted, '2026-07-27T18:11:00.000Z'));
    store.close();
    release.resolve();
    const result = await backingUp;

    assert.equal(result.ok, true);
    assert.equal(result.reconciliationPending, true);
    const after = await h.createPhotoStore();
    const restored = (await after.getBundle('photo-1')).photo;
    assert.equal(restored.deletedAt, null);
    assert.notEqual(restored.backup.state, 'failed');
    after.close();

    assert.equal((await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender)).current, true);
    assert.equal(h.local.values.bpbPhotoLibraryBackupState.reconciliationPending, false);
});

test('a worker restart repairs state after a confirmed commit without another commit', async () => {
    let failStateWrites = true;
    const localValues = {};
    const first = await harness({
        seed: bundle(),
        localValues,
        localSetHook: patch => {
            if (failStateWrites && patch.bpbPhotoLibraryBackupState) {
                throw new Error('photo backup state write failed');
            }
        },
    });
    const committed = await first.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    assert.equal(committed.ok, true);
    assert.equal(committed.reconciliationPending, true);
    assert.equal(first.commits.length, 1);
    assert.equal(localValues.bpbPhotoLibraryBackupState, undefined);

    failStateWrites = false;
    const restarted = await harness({
        indexedDB: first.indexedDB,
        databaseName: first.databaseName,
        localValues,
        remoteState: first.remoteState,
        commits: first.commits,
    });
    const repaired = await restarted.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);

    assert.equal(repaired.ok, true);
    assert.equal(repaired.current, true);
    assert.equal(restarted.commits.length, 1, 'the already-confirmed remote content is not recommitted');
    assert.equal(localValues.bpbPhotoLibraryBackupState.reconciliationPending, false);
});

test('partial catalog stamping is journaled and an automatic retry repairs only the remainder', async () => {
    let failSecondStamp = true;
    const h = await harness({
        seeds: [bundle('photo-1'), bundle('photo-2', 'South face topo')],
        decoratePhotoStore: store => ({
            ...store,
            updatePhotoBackups: async args => {
                if (failSecondStamp && args.localIds.includes('photo-2')) {
                    await store.updatePhotoBackups({ ...args, localIds: ['photo-1'] });
                    throw new Error('second catalog stamp failed');
                }
                return store.updatePhotoBackups(args);
            },
        }),
    });
    const first = await h.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender);
    assert.equal(first.ok, true);
    assert.equal(first.reconciliationPending, true);
    assert.equal(h.commits.length, 1);
    assert.equal(h.local.values.bpbPhotoLibraryBackupState.reconciliationPending, true);
    let store = await h.createPhotoStore();
    assert.equal((await store.getBundle('photo-1')).photo.backup.state, 'current');
    assert.equal((await store.getBundle('photo-2')).photo.backup.state, 'off');
    store.close();

    failSecondStamp = false;
    h.routes.onAlarm('bpb-photo-library-backup');
    await waitFor(() => h.local.values.bpbPhotoLibraryBackupState?.reconciliationPending === false);
    assert.equal(h.commits.length, 1);
    store = await h.createPhotoStore();
    assert.equal((await store.getBundle('photo-2')).photo.backup.state, 'current');
    store.close();
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
    assert.equal(h.alarms.get('bpb-photo-library-backup').periodInMinutes, 30);

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
    const store = await h.createPhotoStore();
    assert.equal((await store.getBundle('photo-1')).photo.backup.state, 'failed',
        'only a backup that never reached GitHub is marked failed');
    store.close();
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

// The settings and favorites auto-backups compare a cheap signature inside
// fire(), so nudging them on every settings write costs nothing. The photo
// library has no such summary: deciding whether it changed means reading every
// record out of IndexedDB and hashing the payload. Scheduling it from every
// settings write made toggling dark mode scan the whole library.
test('only switching the photo backup toggle on re-arms the library scan', async () => {
    const h = await harness({ seed: bundle() });
    const settings = enabled => ({ autoPhotoLibraryBackup: enabled });

    h.routes.onSettingsChanged(settings(true));
    await waitForAlarms();
    assert.deepEqual(h.alarmed, ['bpb-photo-library-backup'], 'turning it on starts the first backup');

    // An unrelated settings write (theme, units, any other preference) leaves
    // the gate where it was and must not re-arm anything.
    for (let i = 0; i < 5; i++) h.routes.onSettingsChanged(settings(true));
    await waitForAlarms();
    assert.deepEqual(h.alarmed, ['bpb-photo-library-backup'], 'a level, not an edge, schedules nothing');

    // Off and on again is a fresh edge: the library may have drifted while the
    // gate was down, and GITHUB_PHOTOS_CHANGED is suppressed in that state.
    h.routes.onSettingsChanged(settings(false));
    await waitForAlarms();
    h.routes.onSettingsChanged(settings(true));
    await waitForAlarms();
    assert.deepEqual(h.alarmed, ['bpb-photo-library-backup', 'bpb-photo-library-backup']);
    assert.equal(h.alarms.get('bpb-photo-library-backup').periodInMinutes, 30);
});

test('the recurring watchdog backs up a durable mutation after its page notification is lost', async () => {
    const first = await harness({ seed: bundle() });
    assert.equal((await first.routes.handlers.GITHUB_PHOTOS_BACKUP({}, photoSender)).ok, true);
    assert.equal(first.commits.length, 1);

    const store = await first.createPhotoStore();
    const current = (await store.getBundle('photo-1')).photo;
    await store.putPhoto(Library.addReference(current, {
        kind: 'ascent', cid: 1, aid: 2, pid: 3, insertedAt: LATER,
    }, LATER));
    store.close();

    const restarted = await harness({
        indexedDB: first.indexedDB,
        databaseName: first.databaseName,
        localValues: first.local.values,
        remoteState: first.remoteState,
        commits: first.commits,
    });
    await restarted.routes.startPhotoBackupWatchdog();
    assert.equal(restarted.alarms.get('bpb-photo-library-backup').periodInMinutes, 30);

    restarted.routes.onAlarm('bpb-photo-library-backup');
    await waitFor(() => restarted.commits.length === 2
        && restarted.local.values.bpbPhotoLibraryBackupState?.reconciliationPending === false);

    const confirmed = await restarted.createPhotoStore();
    const catalog = await confirmed.getCatalogState();
    assert.equal(catalog.generation, catalog.confirmedGeneration);
    assert.equal((await confirmed.getBundle('photo-1')).photo.backup.state, 'current');
    confirmed.close();
});

test('watchdog startup arms recurrence without consuming a settings read', async () => {
    const h = await harness({ autoEnabled: false });
    await h.routes.startPhotoBackupWatchdog();
    assert.equal(h.photoSettingsReads(), 0);
    assert.deepEqual(h.alarms.get('bpb-photo-library-backup'), {
        name: 'bpb-photo-library-backup',
        delayInMinutes: 30,
        periodInMinutes: 30,
    });
});
