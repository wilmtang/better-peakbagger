// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drives the real photo page (photos.html + the built photos.js bundle) in
// jsdom against fake-indexeddb, so the editor's gestures — placing a mark,
// dragging a slider, holding an arrow key, moving a route vertex — are
// exercised the way a user performs them rather than asserted from source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { evalBundle, makeChromeStub, waitFor } from '../helpers/load-page.mjs';
import { photoArchive as Archive } from '../../src/photos/photo-archive.js';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';
import { photoProject as Project } from '../../src/photos/photo-project.js';
import { photoRenderer as Renderer } from '../../src/photos/photo-renderer.js';
import { photoStore as Store } from '../../src/photos/photo-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = await readFile(path.join(root, 'photos', 'photos.html'), 'utf8');

// The photo the harness picks is 1600 × 1200 shown in an 800 × 600 box, so a
// CSS pixel is two image pixels and the arithmetic in the assertions is exact.
const IMAGE = { width: 1600, height: 1200 };
const VIEW = { width: 800, height: 600 };

// Every gesture below renders synchronously; only opening IndexedDB and
// decoding the picked file are asynchronous, and each is gated on the DOM state
// it produces rather than on a sleep. `settle` exists solely to let the
// already-resolved autosave/render microtasks drain before an assertion reads
// the DOM, and never carries the weight of an await that has real work behind it.
const settle = win => new Promise(resolve => win.setTimeout(resolve, 0));

const loadEditor = async ({
    returnToReport = false,
    imgbbStatus = { ok: true, configured: false, permissionGranted: false },
    runtimeHandler = async () => ({ ok: true }),
    fetchImpl = null,
    indexedDB = new IDBFactory(),
    pickPhoto = true,
    pickedFileSize = null,
    imageLoader = null,
    fileName = 'north-face.jpg',
    fileType = 'image/jpeg',
    onStoreReady = null,
    startMode = null,
    fixedNow = null,
    confirmImpl = null,
    clipboard = undefined,
    storageEstimate = undefined,
    subtle = globalThis.crypto.subtle,
} = {}) => {
    const params = new URLSearchParams();
    if (returnToReport) params.set('returnToken', 'return-test');
    if (startMode) params.set('mode', startMode);
    const dom = new JSDOM(html, {
        url: `chrome-extension://test/photos/photos.html${params.size ? `?${params}` : ''}`,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const win = dom.window;
    const doc = win.document;
    if (fixedNow) {
        const NativeDate = win.Date;
        const fixedTime = NativeDate.parse(fixedNow);
        class FixedDate extends NativeDate {
            constructor(...args) {
                super(...(args.length ? args : [fixedTime]));
            }

            static now() {
                return fixedTime;
            }
        }
        win.Date = FixedDate;
    }
    if (confirmImpl) win.confirm = confirmImpl;
    if (clipboard !== undefined) {
        Object.defineProperty(win.navigator, 'clipboard', {
            value: clipboard,
            configurable: true,
        });
    }
    win.indexedDB = indexedDB;
    win.IDBKeyRange = IDBKeyRange;
    win.structuredClone = globalThis.structuredClone;
    if (storageEstimate !== undefined) {
        Object.defineProperty(win.navigator, 'storage', {
            value: storageEstimate === null ? {} : { estimate: storageEstimate },
            configurable: true,
        });
    }
    let ids = 0;
    win.crypto.randomUUID = () => `mark-${++ids}`;
    // jsdom exposes no SubtleCrypto; the page hashes the picked file with it.
    Object.defineProperty(win.crypto, 'subtle', { value: subtle, configurable: true });
    // Decoding and thumbnailing are the browser's, not the editor's, so the
    // harness answers for them with the fixture's dimensions.
    const decodedBitmaps = [];
    win.createImageBitmap = async () => {
        const bitmap = {
            ...IMAGE,
            closed: false,
            close() { this.closed = true; },
        };
        decodedBitmaps.push(bitmap);
        return bitmap;
    };
    win.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    const encodeCalls = [];
    win.HTMLCanvasElement.prototype.toBlob = function toBlob(
        callback,
        mime = 'image/png',
        quality,
    ) {
        const fullResolution = this.width === IMAGE.width && this.height === IMAGE.height;
        const bytes = mime === 'image/png'
            ? 6 * 1024 * 1024
            : Math.round(2 * 1024 * 1024 * (quality ?? 0.92));
        const blob = new win.Blob([fullResolution ? 'encoded-photo' : 'thumbnail'], { type: mime });
        if (fullResolution) {
            Object.defineProperty(blob, 'size', { value: bytes });
            encodeCalls.push({ mime, quality, bytes });
        }
        callback(blob);
    };
    class OverlayImage {
        set src(value) {
            this.currentSrc = value;
            if (imageLoader) imageLoader(this);
            else win.setTimeout(() => this.onload?.(), 0);
        }
    }
    Object.defineProperty(win, 'Image', { value: OverlayImage, configurable: true });
    win.URL.createObjectURL = () => 'blob:test';
    win.URL.revokeObjectURL = () => {};
    if (fetchImpl) win.fetch = fetchImpl;
    const chrome = makeChromeStub({ bpbSettings: { reportImageWidth: 640 } });
    chrome.runtime.sendMessage = async message => {
        if (message?.type === 'PHOTO_IMGBB_STATUS') return imgbbStatus;
        if (message?.type === 'PHOTO_IMGBB_LEASE_KEY') return { ok: true, key: 'test-imgbb-key' };
        return runtimeHandler(message);
    };
    chrome.permissions = {
        contains: async () => imgbbStatus.permissionGranted,
        request: async () => imgbbStatus.permissionGranted,
    };
    chrome.tabs = { create: () => {} };
    win.chrome = chrome;
    const errors = [];
    win.addEventListener('error', event => errors.push(String(event.error?.stack || event.message)));
    win.addEventListener('unhandledrejection', event => {
        errors.push(String(event.reason?.stack || event.reason));
    });
    await evalBundle(win, 'photos/photos.js');
    // The page paints its empty library last, so this is the boot finishing —
    // in particular the IndexedDB handle the first autosave needs.
    await waitFor(dom, () => doc.getElementById('library-empty').hidden === false
        || doc.getElementById('library-list').children.length > 0);
    if (onStoreReady) await onStoreReady({ indexedDB, win });

    if (!pickPhoto) return { dom, win, chrome, doc, errors, decodedBitmaps };

    // Pick a photo the way the page's file input does.
    const input = doc.getElementById('photo-file');
    const pickedFile = new win.File(['pixels'], fileName, { type: fileType });
    if (pickedFileSize != null) {
        Object.defineProperty(pickedFile, 'size', { value: pickedFileSize });
    }
    Object.defineProperty(input, 'files', {
        value: [pickedFile],
        configurable: true,
    });
    input.dispatchEvent(new win.Event('change'));
    await waitFor(dom, () => doc.getElementById('editor-workspace').hidden === false);

    const overlay = doc.getElementById('photo-overlay');
    overlay.getBoundingClientRect = () => ({
        x: 0, y: 0, left: 0, top: 0, right: VIEW.width, bottom: VIEW.height, ...VIEW,
    });
    const click = node => node.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const pointer = (type, x, y, node = overlay) => node.dispatchEvent(
        new win.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    // The secondary button, both halves of it: the press the editor must ignore
    // and the context menu the browser raises from it.
    const rightClick = (x, y) => {
        overlay.dispatchEvent(new win.MouseEvent('pointerdown', {
            bubbles: true, button: 2, clientX: x, clientY: y,
        }));
        const menu = new win.MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y,
        });
        overlay.dispatchEvent(menu);
        return menu.defaultPrevented;
    };
    const key = (type, init) => doc.dispatchEvent(new win.KeyboardEvent(type, { bubbles: true, ...init }));
    const emit = (node, type) => node.dispatchEvent(new win.Event(type, { bubbles: true }));
    return {
        dom,
        win,
        chrome,
        doc,
        errors,
        encodeCalls,
        decodedBitmaps,
        overlay,
        click,
        pointer,
        rightClick,
        key,
        emit,
        settle: () => settle(win),
        status: () => doc.getElementById('editor-status').textContent,
        drawing: () => doc.getElementById('finish-route').hidden === false,
        // One handle per point, drawn only for the selected route under Select.
        vertexCount: () => overlay.querySelectorAll('.vertex-handle').length,
        tool: name => click(doc.querySelector(`[data-tool="${name}"]`)),
        armedTool: () => [...doc.querySelectorAll('[data-tool]')]
            .find(button => button.getAttribute('aria-pressed') === 'true')?.dataset.tool,
        undoDepth: async () => {
            const undo = doc.getElementById('undo');
            let steps = 0;
            while (!undo.disabled && steps < 500) {
                click(undo);
                steps += 1;
            }
            await settle(win);
            return steps;
        },
        markCount: () => Number(doc.getElementById('export-summary').textContent.match(/^(\d+)/)[1]),
        routePath: () => overlay.querySelector('path[d]')?.getAttribute('d'),
    };
};

test('a confirmed backup with pending local reconciliation is never announced as failed', async () => {
    let pending = false;
    let releaseStatus;
    const statusBarrier = new Promise(resolve => { releaseStatus = resolve; });
    const page = await loadEditor({
        pickPhoto: false,
        runtimeHandler: async message => {
            if (message.type === 'GITHUB_PHOTOS_STATUS') {
                if (pending) await statusBarrier;
                return {
                    ok: true,
                    connected: true,
                    repo: { owner: 'me', name: 'backup', fullName: 'me/backup' },
                    state: pending ? {
                        syncedAt: '2026-07-27T18:10:00.000Z',
                        reconciliationPending: true,
                    } : null,
                };
            }
            if (message.type === 'GITHUB_PHOTOS_BACKUP') {
                pending = true;
                return {
                    ok: true,
                    current: false,
                    reconciliationPending: true,
                    warning: {
                        code: 'photo-backup-reconciliation',
                        message: 'The GitHub backup is safe, but newer local photo changes still need another backup.',
                    },
                };
            }
            return { ok: true };
        },
    });
    await waitFor(page.dom, () => page.doc.getElementById('backup-library').disabled === false);

    page.doc.getElementById('backup-library').click();
    await waitFor(page.dom, () => pending);

    assert.equal(page.doc.getElementById('photo-backup-status').textContent,
        'Backing up photo metadata…');
    assert.doesNotMatch(page.doc.getElementById('toast-message').textContent,
        /GitHub backup is safe|backed up/i);

    releaseStatus();
    await waitFor(page.dom, () => /Backup reached me\/backup/.test(
        page.doc.getElementById('photo-backup-status').textContent));
    await waitFor(page.dom, () => /GitHub backup is safe/.test(
        page.doc.getElementById('toast-message').textContent));

    assert.match(page.doc.getElementById('photo-backup-status').textContent,
        /Backup reached me\/backup/);
    assert.match(page.doc.getElementById('photo-backup-status').textContent,
        /local changes still need backup/);
    assert.doesNotMatch(page.doc.getElementById('toast-message').textContent, /failed/i);
    assert.deepEqual(page.errors, []);
});

test('backup completion does not claim success when authoritative status cannot refresh', async () => {
    let statusCalls = 0;
    const page = await loadEditor({
        pickPhoto: false,
        runtimeHandler: async message => {
            if (message.type === 'GITHUB_PHOTOS_STATUS') {
                statusCalls += 1;
                return statusCalls === 1 ? {
                    ok: true,
                    connected: true,
                    repo: { owner: 'me', name: 'backup', fullName: 'me/backup' },
                    state: null,
                } : null;
            }
            if (message.type === 'GITHUB_PHOTOS_BACKUP') return { ok: true };
            return { ok: true };
        },
    });
    await waitFor(page.dom, () => page.doc.getElementById('backup-library').disabled === false);

    page.doc.getElementById('backup-library').click();
    await waitFor(page.dom, () => page.doc.getElementById('photo-backup-status').textContent
        === 'GitHub recovery is unavailable.');
    await waitFor(page.dom, () => /status could not be refreshed/i.test(
        page.doc.getElementById('toast-message').textContent));

    assert.doesNotMatch(page.doc.getElementById('toast-message').textContent, /backed up/i);
    assert.deepEqual(page.errors, []);
});

test('photo backup capacity failures preserve the worker action and byte details', async () => {
    const message = 'Photo-library metadata uses 8.4 MiB, above the 8 MiB GitHub recovery limit. '
        + 'Move unneeded drafts to Recently Deleted; after their editing-data window ends, try again.';
    const page = await loadEditor({
        pickPhoto: false,
        runtimeHandler: async request => request.type === 'GITHUB_PHOTOS_STATUS'
            ? {
                ok: true,
                connected: true,
                repo: { owner: 'me', name: 'backup', fullName: 'me/backup' },
                state: null,
            }
            : request.type === 'GITHUB_PHOTOS_BACKUP'
                ? {
                    ok: false,
                    error: {
                        code: 'photo-backup-too-large',
                        message,
                        actualBytes: 8_800_000,
                        maxBytes: 8_388_608,
                    },
                }
                : { ok: true },
    });
    await waitFor(page.dom, () => page.doc.getElementById('backup-library').disabled === false);

    page.doc.getElementById('backup-library').click();
    await waitFor(page.dom, () => page.doc.getElementById('photo-backup-status').textContent === message);

    assert.deepEqual(page.errors, []);
});

const readPhotoStore = (win, storeName) => new Promise((resolve, reject) => {
    const opened = win.indexedDB.open('betterPeakbaggerPhotos', Store.DATABASE_VERSION);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
        const database = opened.result;
        const transaction = database.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        transaction.oncomplete = () => {
            database.close();
            resolve(request.result);
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    };
});

const deletePhotoStoreRecord = (indexedDB, storeName, key) => new Promise((resolve, reject) => {
    const opened = indexedDB.open('betterPeakbaggerPhotos', Store.DATABASE_VERSION);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
        const database = opened.result;
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).delete(key);
        transaction.oncomplete = () => {
            database.close();
            resolve();
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    };
});

const seedUploadedLibraryPhoto = async (indexedDB, {
    localId = 'copy-url-photo',
    url = 'https://i.ibb.co/a/topo.jpg',
    withoutThumbnail = false,
} = {}) => {
    const store = await Store.createPhotoStore({ indexedDB });
    const sourceSha256 = 'a'.repeat(64);
    const input = {
        photo: Library.createDraft({
            localId,
            title: 'Copy URL topo',
            source: {
                fileName: 'copy-url.jpg',
                mime: 'image/jpeg',
                bytes: 6,
                width: 1600,
                height: 1200,
                sha256: sourceSha256,
            },
            now: '2026-08-01T12:00:00.000Z',
        }),
        project: Project.createProject({
            localId,
            width: 1600,
            height: 1200,
            sourceSha256,
            updatedAt: '2026-08-01T12:00:00.000Z',
        }),
        original: new Blob(['source'], { type: 'image/jpeg' }),
        thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
    };
    input.photo = await store.putDraft(input);
    const photo = await store.putPhoto(Library.completeUpload(input.photo, {
        mime: 'image/jpeg', bytes: 8, width: 1600, height: 1200, sha256: 'b'.repeat(64),
    }, {
        providerId: localId,
        url,
        displayUrl: url,
        viewerUrl: `https://ibb.co/${localId}`,
        thumbnailUrl: `https://i.ibb.co/a/${localId}-thumb.jpg`,
        mediumUrl: null,
        uploadedAt: '2026-08-02T12:00:00.000Z',
        expiresAt: null,
    }, '2026-08-02T12:00:00.000Z'));
    store.close();
    if (withoutThumbnail) await deletePhotoStoreRecord(indexedDB, 'thumbnails', localId);
    return photo;
};

const seedDeletedLibraryPhotos = async (indexedDB, count, {
    deletedAt = '2026-06-01T12:00:00.000Z',
} = {}) => {
    const store = await Store.createPhotoStore({ indexedDB });
    for (let index = 0; index < count; index += 1) {
        const localId = `expired-photo-${String(index).padStart(3, '0')}`;
        const sourceSha256 = String(index % 10).repeat(64);
        const input = {
            photo: Library.createDraft({
                localId,
                title: `Expired topo ${index + 1}`,
                source: {
                    fileName: `${localId}.jpg`, mime: 'image/jpeg', bytes: 6,
                    width: IMAGE.width, height: IMAGE.height, sha256: sourceSha256,
                },
                now: deletedAt,
            }),
            project: Project.createProject({
                localId,
                width: IMAGE.width,
                height: IMAGE.height,
                sourceSha256,
                updatedAt: deletedAt,
            }),
            original: new Blob(['source'], { type: 'image/jpeg' }),
            thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
        };
        input.photo = await store.putDraft(input);
        await store.putPhoto(Library.markDeleted(input.photo, deletedAt));
    }
    store.close();
};

test('one photo-page lifetime drains more than two expired maintenance batches', async t => {
    const indexedDB = new IDBFactory();
    await seedDeletedLibraryPhotos(indexedDB, 45);
    const page = await loadEditor({
        indexedDB,
        pickPhoto: false,
        fixedNow: '2026-08-14T12:00:00.000Z',
    });
    t.after(() => page.dom.window.close());

    const photos = await waitForPhotoStore(page.win, 'photos', records => records.length === 45
        && records.every(photo => !photo.assets.originalRetained
            && !photo.assets.projectRetained && !photo.assets.thumbnailRetained));
    assert.equal(photos.length, 45);
    assert.equal((await readPhotoStore(page.win, 'originals')).length, 0);
    assert.equal((await readPhotoStore(page.win, 'projects')).length, 0);
    assert.equal((await readPhotoStore(page.win, 'thumbnails')).length, 0);
    assert.deepEqual(page.errors, []);
});

test('photo maintenance pauses while hidden and retries one failed batch after visibility returns', async t => {
    const indexedDB = new IDBFactory();
    await seedDeletedLibraryPhotos(indexedDB, 1);
    let quotaFailure;
    const warnings = [];
    const page = await loadEditor({
        indexedDB,
        pickPhoto: false,
        fixedNow: '2026-08-14T12:00:00.000Z',
        onStoreReady: ({ win }) => {
            win.console.warn = (...args) => warnings.push(args);
            quotaFailure = failNextDraftTransactionWithQuota(indexedDB);
            Object.defineProperty(win.document, 'visibilityState', {
                value: 'hidden', configurable: true,
            });
            win.document.dispatchEvent(new win.Event('visibilitychange'));
        },
    });
    t.after(() => {
        quotaFailure.restore();
        page.dom.window.close();
    });

    await new Promise(resolve => page.win.setTimeout(resolve, 1100));
    assert.equal(quotaFailure.triggered(), false, 'hidden maintenance owns no live timer');
    assert.equal((await readPhotoStore(page.win, 'photos'))[0].assets.originalRetained, true);

    Object.defineProperty(page.doc, 'visibilityState', { value: 'visible', configurable: true });
    page.doc.dispatchEvent(new page.win.Event('visibilitychange'));
    await waitForPhotoStore(page.win, 'photos', records => records.length === 1
        && !records[0].assets.originalRetained);
    assert.equal(quotaFailure.triggered(), true);
    assert.equal(warnings.length, 1, 'the first transient failure remains diagnosable without retry spam');
    assert.deepEqual(page.errors, []);
});

const waitForPhotoStore = async (win, storeName, predicate, ms = 5000) => {
    const start = Date.now();
    while (true) {
        const records = await readPhotoStore(win, storeName);
        if (predicate(records)) return records;
        if (Date.now() - start > ms) {
            throw new Error(`photo store wait timed out; store=${storeName} count=${records.length}`);
        }
        await new Promise(resolve => win.setTimeout(resolve, 5));
    }
};

// Hold the completion callback of one real fake-indexeddb draft transaction.
// The records themselves commit normally; only the page's awaited completion
// is delayed, which reproduces the browser race where a large blob write
// finishes after the user has already made another editor mutation.
const deferNextDraftCompletion = indexedDB => {
    const raw = indexedDB._databases.get('betterPeakbaggerPhotos');
    const database = raw?.connections.find(connection => !connection._closed);
    assert.ok(database, 'the photo page must have an open IndexedDB connection');
    const transaction = database.transaction.bind(database);
    let armed = true;
    let release;
    let started;
    const released = new Promise(resolve => { release = resolve; });
    const transactionStarted = new Promise(resolve => { started = resolve; });

    database.transaction = (storeNames, mode, options) => {
        const next = transaction(storeNames, mode, options);
        const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
        if (!armed || mode !== 'readwrite'
            || !['photos', 'projects', 'originals', 'thumbnails'].every(name => names.includes(name))) {
            return next;
        }
        armed = false;
        let completion = null;
        Object.defineProperty(next, 'oncomplete', {
            configurable: true,
            get: () => completion,
            set: handler => {
                completion = event => { void released.then(() => handler.call(next, event)); };
            },
        });
        started();
        return next;
    };

    return {
        started: transactionStarted,
        release,
        restore: () => { database.transaction = transaction; },
    };
};

const failNextDraftTransactionWithQuota = indexedDB => {
    const raw = indexedDB._databases.get('betterPeakbaggerPhotos');
    const database = raw?.connections.find(connection => !connection._closed);
    assert.ok(database, 'the photo page must have an open IndexedDB connection');
    const transaction = database.transaction.bind(database);
    let armed = true;
    database.transaction = (storeNames, mode, options) => {
        const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
        if (armed && mode === 'readwrite'
            && ['photos', 'projects', 'originals', 'thumbnails'].every(name => names.includes(name))) {
            armed = false;
            throw new DOMException('The storage quota was exceeded.', 'QuotaExceededError');
        }
        return transaction(storeNames, mode, options);
    };
    return {
        triggered: () => !armed,
        restore: () => { database.transaction = transaction; },
    };
};

test('Edit as new version has one owner across rapid same-card and cross-card actions', async t => {
    const indexedDB = new IDBFactory();
    await seedUploadedLibraryPhoto(indexedDB, { localId: 'first-version' });
    await seedUploadedLibraryPhoto(indexedDB, { localId: 'second-version' });
    let deferred;
    const page = await loadEditor({
        indexedDB,
        pickPhoto: false,
        startMode: 'library',
        onStoreReady: () => { deferred = deferNextDraftCompletion(indexedDB); },
    });
    Object.defineProperty(page.win, 'Blob', { value: Blob, configurable: true });
    t.after(() => {
        deferred.restore();
        deferred.release();
        page.dom.window.close();
    });
    const edits = [...page.doc.querySelectorAll('.photo-card button')]
        .filter(button => button.textContent === 'Edit as new version');
    assert.equal(edits.length, 2);

    edits[0].click();
    edits[0].dispatchEvent(new page.win.Event('click', { bubbles: true }));
    edits[1].dispatchEvent(new page.win.Event('click', { bubbles: true }));
    assert.equal(edits[0].disabled, true);
    assert.equal(edits[0].getAttribute('aria-busy'), 'true');
    await deferred.started;
    deferred.restore();
    deferred.release();

    const photos = await waitForPhotoStore(page.win, 'photos', records => records.length === 3);
    const children = photos.filter(photo => photo.lineage.parentLocalId);
    assert.equal(children.length, 1, 'one action owner creates at most one child draft');
    await waitFor(page.dom, () => page.doc.getElementById('editor-workspace').hidden === false);
    assert.deepEqual(page.errors, []);
});

test('Edit as new version closes its fallback bitmap after successful ownership transfer', async t => {
    const indexedDB = new IDBFactory();
    await seedUploadedLibraryPhoto(indexedDB, {
        localId: 'missing-thumbnail-success',
        withoutThumbnail: true,
    });
    const page = await loadEditor({ indexedDB, pickPhoto: false, startMode: 'library' });
    Object.defineProperty(page.win, 'Blob', { value: Blob, configurable: true });
    t.after(() => page.dom.window.close());
    const edit = [...page.doc.querySelectorAll('.photo-card button')]
        .find(button => button.textContent === 'Edit as new version');

    edit.click();
    await waitForPhotoStore(page.win, 'photos', records => records.length === 2).catch(error => {
        error.message += `; toast=${JSON.stringify(page.doc.getElementById('toast-message').textContent)}`
            + ` decoded=${page.decodedBitmaps.length} errors=${JSON.stringify(page.errors)}`;
        throw error;
    });
    await waitFor(page.dom, () => page.doc.getElementById('editor-workspace').hidden === false);
    assert.equal(page.decodedBitmaps.length, 2,
        'thumbnail fallback and editor load each decode their own bitmap');
    assert.equal(page.decodedBitmaps[0].closed, true, 'temporary thumbnail pixels are released');
    assert.equal(page.decodedBitmaps[1].closed, false, 'the editor owns its live source bitmap');
    assert.deepEqual(page.errors, []);
});

test('Edit as new version releases decoded pixels and its owner when thumbnailing or storage fails', async t => {
    await t.test('thumbnail failure', async () => {
        const indexedDB = new IDBFactory();
        await seedUploadedLibraryPhoto(indexedDB, {
            localId: 'thumbnail-failure',
            withoutThumbnail: true,
        });
        const page = await loadEditor({ indexedDB, pickPhoto: false, startMode: 'library' });
        Object.defineProperty(page.win, 'Blob', { value: Blob, configurable: true });
        page.win.HTMLCanvasElement.prototype.toBlob = callback => callback(null);
        const edit = [...page.doc.querySelectorAll('.photo-card button')]
            .find(button => button.textContent === 'Edit as new version');

        edit.click();
        await waitFor(page.dom, () => /could not be saved/i.test(
            page.doc.getElementById('toast-message').textContent));
        assert.equal(page.decodedBitmaps.length, 1);
        assert.equal(page.decodedBitmaps[0].closed, true);
        assert.equal((await readPhotoStore(page.win, 'photos')).length, 1);
        assert.equal(edit.disabled, false);
        assert.equal(edit.getAttribute('aria-busy'), 'false');
        assert.deepEqual(page.errors, []);
        page.dom.window.close();
    });

    await t.test('draft transaction failure', async () => {
        const indexedDB = new IDBFactory();
        await seedUploadedLibraryPhoto(indexedDB, {
            localId: 'storage-failure',
            withoutThumbnail: true,
        });
        let quotaFailure;
        const page = await loadEditor({
            indexedDB,
            pickPhoto: false,
            startMode: 'library',
            onStoreReady: () => { quotaFailure = failNextDraftTransactionWithQuota(indexedDB); },
        });
        Object.defineProperty(page.win, 'Blob', { value: Blob, configurable: true });
        const edit = [...page.doc.querySelectorAll('.photo-card button')]
            .find(button => button.textContent === 'Edit as new version');

        edit.click();
        await waitFor(page.dom, () => /could not be saved/i.test(
            page.doc.getElementById('toast-message').textContent));
        assert.equal(quotaFailure.triggered(), true);
        assert.equal(page.decodedBitmaps.length, 1);
        assert.equal(page.decodedBitmaps[0].closed, true);
        assert.equal((await readPhotoStore(page.win, 'photos')).length, 1);
        assert.equal(edit.disabled, false);
        assert.deepEqual(page.errors, []);
        quotaFailure.restore();
        page.dom.window.close();
    });
});

test('a committed new version stays recoverable when its editor load fails', async t => {
    const indexedDB = new IDBFactory();
    await seedUploadedLibraryPhoto(indexedDB, {
        localId: 'editor-load-failure',
        withoutThumbnail: true,
    });
    const page = await loadEditor({ indexedDB, pickPhoto: false, startMode: 'library' });
    Object.defineProperty(page.win, 'Blob', { value: Blob, configurable: true });
    t.after(() => page.dom.window.close());
    const decode = page.win.createImageBitmap;
    let decodeAttempts = 0;
    page.win.createImageBitmap = (...args) => {
        decodeAttempts += 1;
        if (decodeAttempts > 1) return Promise.reject(new Error('injected editor decode failure'));
        return decode(...args);
    };
    const edit = [...page.doc.querySelectorAll('.photo-card button')]
        .find(button => button.textContent === 'Edit as new version');

    edit.click();
    await waitFor(page.dom, () => /new version was saved.*reopen it from the library/i.test(
        page.doc.getElementById('toast-message').textContent));
    const photos = await readPhotoStore(page.win, 'photos');
    assert.equal(photos.length, 2);
    assert.equal(photos.filter(photo => photo.lineage.parentLocalId === 'editor-load-failure').length, 1);
    assert.equal(page.decodedBitmaps.length, 1);
    assert.equal(page.decodedBitmaps[0].closed, true);
    assert.equal(page.doc.getElementById('library-view').hidden, false);
    assert.equal(page.doc.querySelectorAll('.photo-card').length, 2);
    assert.deepEqual(page.errors, []);
});

const imgbbSuccess = {
    data: {
        id: 'provider-1',
        url_viewer: 'https://ibb.co/provider-1',
        url: 'https://i.ibb.co/a/topo.jpg',
        display_url: 'https://i.ibb.co/a/topo.jpg',
        width: '1600',
        height: '1200',
        size: 123456,
        time: 1785213600,
        expiration: 0,
        thumb: { url: 'https://i.ibb.co/a/topo-thumb.jpg' },
        medium: null,
        delete_url: 'https://ibb.co/delete/delete-capability',
    },
    success: true,
    status: 200,
};

const transferEvent = (win, type, property, transfer) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, property, { value: transfer });
    return event;
};

const photoTransfer = file => ({
    types: ['Files'],
    items: [{
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
    }],
    files: [file],
    dropEffect: 'none',
});

const selectPhotoFile = (page, {
    size = null,
    name = 'north-face.jpg',
    type = 'image/jpeg',
} = {}) => {
    const input = page.doc.getElementById('photo-file');
    const file = new page.win.File(['pixels'], name, { type });
    if (size != null) Object.defineProperty(file, 'size', { value: size });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new page.win.Event('change'));
    return file;
};

test('dragging a photo highlights the empty editor and imports through the normal file path', async () => {
    const page = await loadEditor({ pickPhoto: false });
    const { doc, win } = page;
    const target = doc.getElementById('editor-empty');
    const file = new win.File(['pixels'], 'dragged-north-face.jpg', { type: 'image/jpeg' });
    const transfer = photoTransfer(file);

    const enter = transferEvent(win, 'dragenter', 'dataTransfer', transfer);
    target.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(target.classList.contains('is-photo-drag-over'), true);

    const over = transferEvent(win, 'dragover', 'dataTransfer', transfer);
    target.dispatchEvent(over);
    assert.equal(over.defaultPrevented, true);
    assert.equal(transfer.dropEffect, 'copy');

    const drop = transferEvent(win, 'drop', 'dataTransfer', transfer);
    target.dispatchEvent(drop);
    assert.equal(drop.defaultPrevented, true);
    assert.equal(target.classList.contains('is-photo-drag-over'), false);
    await waitFor(page.dom, () => doc.getElementById('editor-workspace').hidden === false);
    assert.equal(doc.getElementById('photo-title').value, 'dragged-north-face');
    assert.deepEqual(page.errors, []);
});

test('pasting imports an image only while the editor is empty and leaves text paste alone', async () => {
    const page = await loadEditor({ pickPhoto: false });
    const { doc, win } = page;

    const textPaste = transferEvent(win, 'paste', 'clipboardData', {
        types: ['text/plain'],
        items: [],
        files: [],
    });
    doc.dispatchEvent(textPaste);
    assert.equal(textPaste.defaultPrevented, false);
    assert.equal(doc.getElementById('editor-workspace').hidden, true);

    const file = new win.File(['pixels'], 'pasted-mountain.png', { type: 'image/png' });
    const imagePaste = transferEvent(win, 'paste', 'clipboardData', photoTransfer(file));
    doc.dispatchEvent(imagePaste);
    assert.equal(imagePaste.defaultPrevented, true);
    await waitFor(page.dom, () => doc.getElementById('editor-workspace').hidden === false);
    assert.equal(doc.getElementById('photo-title').value, 'pasted-mountain');

    const replacement = new win.File(['different'], 'replacement.jpg', { type: 'image/jpeg' });
    const laterPaste = transferEvent(win, 'paste', 'clipboardData', photoTransfer(replacement));
    doc.dispatchEvent(laterPaste);
    assert.equal(laterPaste.defaultPrevented, false,
        'an incidental paste must not replace the open project');
    assert.equal(doc.getElementById('photo-title').value, 'pasted-mountain');
    assert.deepEqual(page.errors, []);
});

test('a late autosave completion cannot replace a newer editor revision', async t => {
    const indexedDB = new IDBFactory();
    let deferred;
    const page = await loadEditor({
        indexedDB,
        onStoreReady: () => { deferred = deferNextDraftCompletion(indexedDB); },
    });
    t.after(() => {
        deferred.restore();
        deferred.release();
    });

    await deferred.started;
    deferred.restore();
    page.tool('bolt');
    page.pointer('pointerdown', 100, 100);
    assert.equal(page.markCount(), 1);
    assert.equal(page.doc.getElementById('save-status').textContent, 'Unsaved changes');

    // The first write contains the empty project. Its completion must not put
    // that snapshot back into the live editor before the second save begins.
    deferred.release();
    await waitFor(page.dom, () => page.doc.getElementById('save-status').textContent
        === 'Saved on this device').catch(error => {
        throw new Error(`${error.message}; status=${page.doc.getElementById('save-status').textContent}; `
            + `pageErrors=${page.errors.map(value => value?.message || value).join(' | ')}`);
    });
    const projects = await waitForPhotoStore(page.win, 'projects', records =>
        records[0]?.objects.length === 1);
    assert.equal(projects[0].objects.length, 1);
    assert.equal(page.markCount(), 1);
    assert.deepEqual(page.errors, []);
});

test('pagehide flushes an edit before its autosave debounce expires', async t => {
    const page = await loadEditor();
    const { doc, win } = page;
    await waitFor(page.dom, () => doc.getElementById('save-status').textContent
        === 'Saved on this device');

    const setTimeout = win.setTimeout.bind(win);
    const clearTimeout = win.clearTimeout.bind(win);
    const heldTimer = 987654;
    let heldAutosave = false;
    win.setTimeout = (callback, delay, ...args) => {
        if (delay === 500 && !heldAutosave) {
            heldAutosave = true;
            return heldTimer;
        }
        return setTimeout(callback, delay, ...args);
    };
    win.clearTimeout = timer => {
        if (timer !== heldTimer) clearTimeout(timer);
    };
    t.after(() => {
        win.setTimeout = setTimeout;
        win.clearTimeout = clearTimeout;
    });

    page.tool('bolt');
    page.pointer('pointerdown', 100, 100);
    assert.equal(heldAutosave, true, 'the normal 500 ms autosave is held by the test');
    assert.equal(doc.getElementById('save-status').textContent, 'Unsaved changes');
    win.dispatchEvent(new win.PageTransitionEvent('pagehide'));

    const projects = await waitForPhotoStore(win, 'projects', records =>
        records[0]?.objects.length === 1);
    assert.equal(projects[0].objects.length, 1,
        'pagehide, not the held debounce callback, persists the annotation');
    assert.equal(doc.getElementById('save-status').textContent, 'Saved on this device');
    assert.deepEqual(page.errors, []);
});

test('a report size resizes only the stage preview and is remembered across both views', async () => {
    const page = await loadEditor({ returnToReport: true });
    const { chrome, doc, win } = page;
    const controls = [...doc.querySelectorAll('[data-report-width-control]')];
    const selects = [...doc.querySelectorAll('[data-report-width]')];
    const stage = doc.getElementById('photo-stage');

    assert.ok(controls.every(control => control.hidden === false));
    assert.deepEqual(selects.map(select => select.value), ['640', '640']);
    assert.equal(stage.style.width, '100%');
    assert.equal(stage.style.maxWidth, '640px');
    assert.match(doc.getElementById('export-summary').textContent, /1600 × 1200/,
        'the project and future raster export retain their source dimensions');

    selects[0].value = '320';
    selects[0].dispatchEvent(new win.Event('change', { bubbles: true }));
    await waitFor(page.dom, () => chrome._store.bpbSettings.reportImageWidth === 320);
    assert.deepEqual(selects.map(select => select.value), ['320', '320']);
    assert.equal(stage.style.width, '100%');
    assert.equal(stage.style.maxWidth, '320px');
    assert.match(doc.getElementById('export-summary').textContent, /1600 × 1200/);

    selects[1].value = 'original';
    selects[1].dispatchEvent(new win.Event('change', { bubbles: true }));
    await waitFor(page.dom, () => chrome._store.bpbSettings.reportImageWidth === null);
    assert.deepEqual(selects.map(select => select.value), ['original', 'original']);
    assert.equal(stage.style.width, '100%');
    assert.equal(stage.style.maxWidth, '1600px',
        'Original stays natural-size but remains contained by the editor viewport');
    assert.match(doc.getElementById('export-summary').textContent, /1600 × 1200/);
    assert.deepEqual(page.errors, []);
});

test('PNG can stay lossless or switch to a quality-controlled JPEG with real size estimates', async () => {
    const page = await loadEditor({ fileName: 'north-face.png', fileType: 'image/png' });
    const { chrome, doc, encodeCalls } = page;
    const format = doc.getElementById('upload-format');
    const original = doc.getElementById('upload-format-original');
    const qualityControl = doc.getElementById('jpeg-quality-control');
    const quality = doc.getElementById('jpeg-quality');
    const estimate = doc.getElementById('upload-estimate');
    const note = doc.getElementById('upload-estimate-note');

    assert.equal(format.value, 'original');
    assert.equal(original.disabled, false);
    assert.match(original.textContent, /original format.+PNG/i);
    assert.equal(qualityControl.hidden, true);
    await waitFor(page.dom, () => /6\.0 MB PNG/.test(estimate.textContent));
    assert.match(note.textContent, /1600 × 1200.+full resolution/i);
    assert.doesNotMatch(note.textContent, /GitHub/i,
        'an ascent-backup warning is noise while that feature is off');

    await chrome.storage.sync.set({
        bpbSettings: { ...chrome._store.bpbSettings, enableGithubBackup: true },
    });
    await waitFor(page.dom, () => /GitHub may not show.+backed-up reports/i.test(note.textContent));
    assert.equal(estimate.parentElement.classList.contains('is-warning'), true);

    format.value = 'jpeg';
    page.emit(format, 'change');
    assert.equal(qualityControl.hidden, false);
    await waitFor(page.dom, () => /1\.8 MB JPEG/.test(estimate.textContent));
    assert.match(note.textContent, /1600 × 1200.+full resolution/i);

    quality.value = '70';
    page.emit(quality, 'input');
    page.emit(quality, 'change');
    assert.equal(doc.getElementById('jpeg-quality-value').textContent, '70%');
    await waitFor(page.dom, () => /1\.4 MB JPEG/.test(estimate.textContent));
    assert.deepEqual(encodeCalls.at(-1), {
        mime: 'image/jpeg',
        quality: 0.7,
        bytes: Math.round(2 * 1024 * 1024 * 0.7),
    });

    format.value = 'png';
    page.emit(format, 'change');
    assert.equal(qualityControl.hidden, true);
    await waitFor(page.dom, () => /6\.0 MB PNG/.test(estimate.textContent));
    assert.deepEqual(page.errors, []);
});

test('unsupported source formats expose JPEG fallback instead of a false original promise', async () => {
    const page = await loadEditor({ fileName: 'north-face.webp', fileType: 'image/webp' });
    const { doc } = page;
    const format = doc.getElementById('upload-format');
    const original = doc.getElementById('upload-format-original');

    assert.equal(format.value, 'jpeg');
    assert.equal(original.disabled, true);
    assert.match(original.textContent, /unavailable/i);
    assert.equal(doc.getElementById('jpeg-quality-control').hidden, false);
    await waitFor(page.dom, () => /JPEG/.test(doc.getElementById('upload-estimate').textContent));
    assert.deepEqual(page.errors, []);
});

test('a device-saved ImgBB key is managed in Settings instead of a photo-page removal card', async () => {
    const page = await loadEditor({
        imgbbStatus: { ok: true, configured: true, permissionGranted: true },
    });
    assert.equal(page.doc.getElementById('credential-card').hidden, true);
    assert.equal(page.doc.getElementById('remove-key').hidden, true);
    assert.deepEqual(page.errors, []);
});

test('a tab-only ImgBB key keeps its one local escape hatch', async () => {
    const page = await loadEditor({
        imgbbStatus: { ok: true, configured: false, permissionGranted: true },
    });
    const { doc } = page;
    doc.getElementById('imgbb-key').value = 'tab-only-key';
    doc.getElementById('remember-key').checked = false;
    page.click(doc.getElementById('save-key'));
    await page.settle();

    assert.equal(doc.getElementById('credential-card').hidden, false);
    assert.equal(doc.getElementById('credential-form').hidden, true);
    assert.equal(doc.getElementById('remove-key').hidden, false);
    assert.equal(doc.getElementById('remove-key').textContent.trim(), 'Forget for this tab');

    page.click(doc.getElementById('remove-key'));
    await page.settle();
    assert.equal(doc.getElementById('credential-form').hidden, false);
    assert.equal(doc.getElementById('remove-key').hidden, true);
    assert.deepEqual(page.errors, []);
});

test('accepts an encoded source at the exact 128 MiB ceiling with storage headroom', async () => {
    const sourceLimit = 128 * 1024 * 1024;
    const page = await loadEditor({
        pickedFileSize: sourceLimit,
        storageEstimate: async () => ({
            usage: 4 * 1024 * 1024,
            quota: 4 * 1024 * 1024 + sourceLimit + 8 * 1024 * 1024,
        }),
    });
    await waitFor(page.dom, () => page.doc.getElementById('save-status').textContent
        === 'Saved on this device');
    const [catalog] = await readPhotoStore(page.win, 'photos');
    assert.equal(catalog.source.bytes, sourceLimit);
    assert.equal(page.decodedBitmaps.length, 1);
    assert.equal(page.decodedBitmaps[0].closed, false);
    assert.deepEqual(page.errors, []);
});

test('rejects limit-plus-one encoded bytes before decoding or hashing a small image', async () => {
    let hashCalls = 0;
    const page = await loadEditor({
        pickPhoto: false,
        subtle: {
            digest: async (...args) => {
                hashCalls += 1;
                return globalThis.crypto.subtle.digest(...args);
            },
        },
    });
    selectPhotoFile(page, { size: 128 * 1024 * 1024 + 1 });
    await waitFor(page.dom, () => /up to 128 MiB/i.test(
        page.doc.getElementById('toast-message').textContent));
    assert.equal(page.doc.getElementById('editor-workspace').hidden, true);
    assert.equal(page.decodedBitmaps.length, 0);
    assert.equal(hashCalls, 0);
    assert.equal(page.doc.getElementById('toast-action').textContent, 'Choose smaller photo');
    assert.deepEqual(await readPhotoStore(page.win, 'photos'), []);
    assert.deepEqual(page.errors, []);
});

test('rejects a source before decode when the available quota estimate lacks headroom', async () => {
    const sourceBytes = 48 * 1024 * 1024;
    const required = sourceBytes + 8 * 1024 * 1024;
    const page = await loadEditor({
        pickPhoto: false,
        storageEstimate: async () => ({ usage: 10, quota: 10 + required - 1 }),
    });
    selectPhotoFile(page, { size: sourceBytes });
    await waitFor(page.dom, () => /free browser storage/i.test(
        page.doc.getElementById('toast-message').textContent));
    assert.equal(page.decodedBitmaps.length, 0);
    assert.equal(page.doc.getElementById('editor-workspace').hidden, true);
    assert.deepEqual(await readPhotoStore(page.win, 'photos'), []);
    assert.deepEqual(page.errors, []);
});

test('continues when the browser cannot provide a storage estimate', async () => {
    let estimateCalls = 0;
    const page = await loadEditor({
        storageEstimate: async () => {
            estimateCalls += 1;
            throw new Error('estimate unavailable');
        },
    });
    await waitFor(page.dom, () => page.doc.getElementById('save-status').textContent
        === 'Saved on this device');
    assert.ok(estimateCalls >= 2, 'library display and source preflight both tolerate the failure');
    assert.equal(page.decodedBitmaps.length, 1);
    assert.equal((await readPhotoStore(page.win, 'photos')).length, 1);
    assert.deepEqual(page.errors, []);
});

test('a hashing failure closes prepared pixels and leaves the editor ready for another file', async () => {
    let hashCalls = 0;
    const page = await loadEditor({
        pickPhoto: false,
        subtle: {
            digest: async () => {
                hashCalls += 1;
                throw new Error('hash unavailable');
            },
        },
    });
    selectPhotoFile(page);
    await waitFor(page.dom, () => /could not verify this photo/i.test(
        page.doc.getElementById('toast-message').textContent));
    assert.equal(hashCalls, 1);
    assert.equal(page.decodedBitmaps.length, 1);
    assert.equal(page.decodedBitmaps[0].closed, true);
    assert.equal(page.doc.getElementById('editor-workspace').hidden, true);
    assert.deepEqual(await readPhotoStore(page.win, 'photos'), []);

    Object.defineProperty(page.win.crypto, 'subtle', {
        value: globalThis.crypto.subtle,
        configurable: true,
    });
    selectPhotoFile(page, { name: 'retry.jpg' });
    await waitFor(page.dom, () => page.doc.getElementById('save-status').textContent
        === 'Saved on this device');
    assert.equal(page.doc.getElementById('photo-title').value, 'retry');
    assert.equal((await readPhotoStore(page.win, 'photos')).length, 1);
    assert.deepEqual(page.errors, []);
});

test('a persistence quota failure writes no partial bundle and can retry', async t => {
    const indexedDB = new IDBFactory();
    let quotaFailure;
    const page = await loadEditor({
        indexedDB,
        pickPhoto: false,
        onStoreReady: () => { quotaFailure = failNextDraftTransactionWithQuota(indexedDB); },
    });
    t.after(() => quotaFailure.restore());
    selectPhotoFile(page);
    await waitFor(page.dom, () => /storage is full/i.test(
        page.doc.getElementById('save-status').textContent));
    assert.equal(quotaFailure.triggered(), true);
    for (const storeName of ['photos', 'projects', 'originals', 'thumbnails']) {
        assert.deepEqual(await readPhotoStore(page.win, storeName), [], storeName);
    }
    assert.match(page.doc.getElementById('toast-message').textContent,
        /editable copy could not be saved.*original file was not changed/i);

    page.doc.getElementById('photo-title').value = 'Retried after quota';
    page.doc.getElementById('photo-title').dispatchEvent(new page.win.Event('input', { bubbles: true }));
    await waitFor(page.dom, () => page.doc.getElementById('save-status').textContent
        === 'Saved on this device');
    assert.equal((await readPhotoStore(page.win, 'photos'))[0].title, 'Retried after quota');
    assert.equal((await readPhotoStore(page.win, 'projects')).length, 1);
    assert.equal((await readPhotoStore(page.win, 'originals')).length, 1);
    assert.equal((await readPhotoStore(page.win, 'thumbnails')).length, 1);
    assert.deepEqual(page.errors, []);
});

test('a large source below the encoded ceiling can flatten to an accepted upload', async () => {
    let uploaded = false;
    const page = await loadEditor({
        pickedFileSize: 32 * 1024 * 1024 + 1,
        imgbbStatus: { ok: true, configured: true, permissionGranted: true },
        fetchImpl: async (_url, options) => {
            uploaded = true;
            const image = options.body.get('image');
            assert.ok(image.size < 32 * 1024 * 1024,
                'the provider receives the flattened export, not the larger source');
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(imgbbSuccess),
            };
        },
    });
    const { doc } = page;
    await waitFor(page.dom, () => doc.getElementById('save-status').textContent === 'Saved on this device');
    page.click(doc.getElementById('upload-insert'));
    await waitFor(page.dom, () => uploaded
        && doc.getElementById('photo-viewport').getAttribute('aria-busy') === 'false'
        && /Uploaded to ImgBB/i.test(page.status()));

    const [catalog] = await readPhotoStore(page.win, 'photos');
    assert.equal(catalog.source.bytes, 32 * 1024 * 1024 + 1);
    assert.ok(catalog.export.bytes < catalog.source.bytes);
    assert.equal(catalog.remote.state, 'uploaded');
    assert.deepEqual(page.errors, []);
});

test('project import rejects valid matching hashes when decoded dimensions disagree', async () => {
    const original = new Blob(['pixels'], { type: 'image/jpeg' });
    const sourceSha256 = await Renderer.sha256(original);
    const project = Project.createProject({
        localId: 'mismatched-dimensions',
        width: IMAGE.height,
        height: IMAGE.width,
        sourceSha256,
        updatedAt: '2026-07-30T18:00:00.000Z',
    });
    const photo = Library.createDraft({
        localId: project.localId,
        title: 'Mismatched dimensions',
        source: {
            fileName: 'mismatch.jpg',
            mime: 'image/jpeg',
            bytes: original.size,
            width: project.image.width,
            height: project.image.height,
            sha256: sourceSha256,
        },
        now: project.updatedAt,
    });
    const archive = await Archive.createProjectArchive({ project, photo, original });
    const page = await loadEditor({ pickPhoto: false });
    const input = page.doc.getElementById('import-project');
    const file = new page.win.File(
        [await archive.arrayBuffer()],
        'mismatch.bpb-photo',
        { type: 'application/zip' },
    );
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new page.win.Event('change'));
    await waitFor(page.dom, () => /dimensions do not match its image/i.test(
        page.doc.getElementById('toast-message').textContent,
    ));

    assert.deepEqual(await readPhotoStore(page.win, 'photos'), []);
    assert.equal(page.doc.getElementById('photo-viewport').getAttribute('aria-busy'), 'false');
    assert.deepEqual(page.errors, []);
});

test('imported annotations enter the same semantic keyboard selection list', async () => {
    const original = new Blob(['pixels'], { type: 'image/jpeg' });
    const sourceSha256 = await Renderer.sha256(original);
    let project = Project.createProject({
        localId: 'accessible-import',
        width: IMAGE.width,
        height: IMAGE.height,
        sourceSha256,
        updatedAt: '2026-08-08T12:00:00.000Z',
    });
    project = Project.addObject(project, {
        id: 'imported-anchor',
        type: 'anchor',
        geometry: { x: 500, y: 400, rotation: 0 },
        style: { color: '#e53935', scale: 1, opacity: 1 },
    });
    project = Project.addObject(project, {
        id: 'imported-route',
        type: 'route',
        geometry: { points: [[200, 800], [600, 500], [1000, 300]], controls: [] },
        style: {
            color: '#1e88e5', width: 12, stroke: 'solid', end: 'none', opacity: 1, smooth: false,
        },
    });
    const photo = Library.createDraft({
        localId: project.localId,
        title: 'Accessible import',
        source: {
            fileName: 'import.jpg',
            mime: 'image/jpeg',
            bytes: original.size,
            ...IMAGE,
            sha256: sourceSha256,
        },
        now: project.updatedAt,
    });
    const indexedDB = new IDBFactory();
    const page = await loadEditor({
        indexedDB,
        pickPhoto: false,
        onStoreReady: async ({ win }) => {
            await new Promise((resolve, reject) => {
                const opened = win.indexedDB.open(
                    'betterPeakbaggerPhotos', Store.DATABASE_VERSION);
                opened.onerror = () => reject(opened.error);
                opened.onsuccess = () => {
                    const database = opened.result;
                    const transaction = database.transaction(
                        ['photos', 'projects', 'originals', 'thumbnails'],
                        'readwrite',
                    );
                    transaction.objectStore('photos').put(photo);
                    transaction.objectStore('projects').put(project);
                    transaction.objectStore('originals').put({
                        localId: project.localId,
                        blob: new Blob(['pixels'], { type: 'image/jpeg' }),
                    });
                    transaction.objectStore('thumbnails').put({
                        localId: project.localId,
                        blob: new Blob(['thumbnail'], { type: 'image/jpeg' }),
                    });
                    transaction.oncomplete = () => {
                        database.close();
                        resolve();
                    };
                    transaction.onerror = () => reject(transaction.error);
                };
            });
        },
    });
    // fake-indexeddb clones the seeded records in Node's Blob realm. Bind the
    // page to that same constructor for this pre-existing/imported-bundle path;
    // ordinary file-picking tests keep jsdom's native File/Blob realm.
    Object.defineProperty(page.win, 'Blob', { value: Blob, configurable: true });
    page.doc.getElementById('show-library').click();
    await waitFor(page.dom, () => [...page.doc.querySelectorAll('.photo-card button')]
        .some(button => button.textContent === 'Edit as new version'));
    const editImported = [...page.doc.querySelectorAll('.photo-card button')]
        .find(button => button.textContent === 'Edit as new version');
    editImported.focus();
    editImported.click();
    await waitFor(page.dom, () => page.doc.getElementById('editor-workspace').hidden === false)
        .catch(error => {
            error.message += `; toast=${JSON.stringify(page.doc.getElementById('toast-message').textContent)}`
                + ` errors=${JSON.stringify(page.errors)}`;
            throw error;
        });

    const buttons = [...page.doc.querySelectorAll('#annotation-list [data-object-id]')];
    assert.deepEqual(buttons.map(button => button.textContent), ['Anchor', 'Route, 3 points']);
    buttons[1].focus();
    buttons[1].click();
    assert.equal(page.doc.activeElement.dataset.objectId, 'imported-route');
    assert.equal(page.doc.activeElement.getAttribute('aria-pressed'), 'true');
    assert.equal(page.doc.querySelectorAll('#route-point-list button').length, 3);
    assert.deepEqual(page.errors, []);
});

test('remote thumbnail presentation failures never rewrite catalog health or backup state', async () => {
    const indexedDB = new IDBFactory();
    const store = await Store.createPhotoStore({ indexedDB });
    const now = '2026-07-30T12:00:00.000Z';
    const sourceSha256 = 'a'.repeat(64);
    const exported = {
        mime: 'image/jpeg', bytes: 8, width: 1600, height: 1200, sha256: 'b'.repeat(64),
    };
    const draft = Library.createDraft({
        localId: 'remote-thumbnail',
        title: 'Remote-only topo',
        source: {
            fileName: 'remote.jpg', mime: 'image/jpeg', bytes: 6,
            width: 1600, height: 1200, sha256: sourceSha256,
        },
        now,
    });
    const project = Project.createProject({
        localId: draft.localId,
        width: 1600,
        height: 1200,
        sourceSha256,
        updatedAt: now,
    });
    const published = Library.completeUpload(draft, exported, {
        providerId: 'provider-1',
        url: 'https://i.ibb.co/a/topo.jpg',
        displayUrl: 'https://i.ibb.co/a/topo.jpg',
        viewerUrl: 'https://ibb.co/provider-1',
        thumbnailUrl: 'https://i.ibb.co/a/topo-thumb.jpg',
        mediumUrl: null,
        uploadedAt: now,
        expiresAt: null,
    }, now);
    await store.putBundle({
        photo: published,
        project,
        original: new Blob(['source'], { type: 'image/jpeg' }),
        thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
    });
    await store.removeLocalAssets(draft.localId, now);
    store.close();

    const page = await loadEditor({ indexedDB, pickPhoto: false });
    const before = await readPhotoStore(page.win, 'photos');
    let previous = null;
    for (const simulatedFailure of ['offline', 'CSP refusal', 'timeout', 'transient 5xx']) {
        await waitFor(page.dom, () => {
            const candidate = page.doc.querySelector('.photo-card img[src^="https://i.ibb.co/"]');
            return candidate && candidate !== previous ? candidate : false;
        });
        const image = page.doc.querySelector('.photo-card img[src^="https://i.ibb.co/"]');
        previous = image;
        image.dispatchEvent(new page.win.Event('error'));
        assert.equal(image.isConnected, false, simulatedFailure);
        assert.match(page.doc.querySelector('.photo-card .photo-placeholder').textContent,
            /Preview unavailable/);
        assert.deepEqual(await readPhotoStore(page.win, 'photos'), before,
            `${simulatedFailure} must not mutate durable catalog truth`);
        page.doc.getElementById('show-library').click();
    }
    assert.deepEqual(page.errors, []);
});

test('Recently Deleted discloses the asset deadline and restores exact-expiry records only', async t => {
    const indexedDB = new IDBFactory();
    const fixedNow = '2026-08-09T12:00:00.000Z';
    const exactExpiryDeletion = new Date(
        Date.parse(fixedNow) - Library.DELETED_EDITING_RECOVERY_MS,
    ).toISOString();
    const beforeExpiryDeletion = new Date(Date.parse(exactExpiryDeletion) + 60_000).toISOString();
    const afterExpiryDeletion = new Date(Date.parse(exactExpiryDeletion) - 60_000).toISOString();

    const page = await loadEditor({
        indexedDB,
        pickPhoto: false,
        startMode: 'library',
        fixedNow,
        onStoreReady: async () => {
            const seedStore = await Store.createPhotoStore({ indexedDB });
            const seed = async ({
                localId,
                title,
                deletedAt,
                remoteState = 'draft',
                referenced = false,
                backedUp = false,
                prune = false,
            }) => {
                const sourceSha256 = 'a'.repeat(64);
                const input = {
                    photo: Library.createDraft({
                        localId,
                        title,
                        source: {
                            fileName: `${localId}.jpg`,
                            mime: 'image/jpeg',
                            bytes: 6,
                            width: 1600,
                            height: 1200,
                            sha256: sourceSha256,
                        },
                        now: '2026-07-01T12:00:00.000Z',
                    }),
                    project: Project.createProject({
                        localId,
                        width: 1600,
                        height: 1200,
                        sourceSha256,
                        updatedAt: '2026-07-01T12:00:00.000Z',
                    }),
                    original: new Blob(['source'], { type: 'image/jpeg' }),
                    thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
                };
                let photo = await seedStore.putDraft(input);
                if (remoteState !== 'draft') {
                    photo = Library.completeUpload(photo, {
                        mime: 'image/jpeg',
                        bytes: 8,
                        width: 1600,
                        height: 1200,
                        sha256: 'b'.repeat(64),
                    }, {
                        providerId: localId,
                        url: `https://i.ibb.co/a/${localId}.jpg`,
                        displayUrl: `https://i.ibb.co/a/${localId}.jpg`,
                        viewerUrl: `https://ibb.co/${localId}`,
                        thumbnailUrl: `https://i.ibb.co/a/${localId}-thumb.jpg`,
                        mediumUrl: null,
                        uploadedAt: '2026-07-02T12:00:00.000Z',
                        expiresAt: null,
                    }, '2026-07-02T12:00:00.000Z');
                    if (remoteState === 'unreachable') {
                        photo = Library.markUnreachable(photo, true, '2026-07-03T12:00:00.000Z');
                    }
                    photo = await seedStore.putPhoto(photo);
                }
                if (referenced) {
                    photo = await seedStore.putPhoto(Library.addReference(photo, {
                        kind: 'ascent', cid: 1, aid: 2, pid: 3,
                        insertedAt: '2026-07-04T12:00:00.000Z',
                    }, '2026-07-04T12:00:00.000Z'));
                }
                if (backedUp) {
                    photo = await seedStore.putPhoto(Library.cleanPhoto({
                        ...photo,
                        backup: {
                            state: 'current',
                            signature: 'c'.repeat(64),
                            backedUpAt: '2026-07-05T12:00:00.000Z',
                            commitUrl: 'https://github.com/example/photos/commit/abc',
                        },
                    }));
                }
                photo = await seedStore.putPhoto(Library.markDeleted(photo, deletedAt));
                if (prune) await seedStore.removeLocalAssets(photo.localId, fixedNow);
            };

            await seed({
                localId: 'local-pre-expiry',
                title: 'Local editing data',
                deletedAt: beforeExpiryDeletion,
            });
            await seed({
                localId: 'uploaded-reference',
                title: 'Uploaded and referenced',
                deletedAt: beforeExpiryDeletion,
                remoteState: 'uploaded',
                referenced: true,
                backedUp: true,
            });
            await seed({
                localId: 'unreachable-photo',
                title: 'Unreachable upload',
                deletedAt: beforeExpiryDeletion,
                remoteState: 'unreachable',
            });
            await seed({
                localId: 'exact-expiry',
                title: 'Exact expiry',
                deletedAt: exactExpiryDeletion,
            });
            await seed({
                localId: 'post-prune',
                title: 'Post-prune record',
                deletedAt: afterExpiryDeletion,
                prune: true,
            });
        },
    });
    t.after(() => page.dom.window.close());

    const filter = page.doc.getElementById('library-filter');
    filter.value = 'recently-deleted';
    filter.dispatchEvent(new page.win.Event('change', { bubbles: true }));
    await waitFor(page.dom, () => page.doc.querySelectorAll('.photo-card').length === 5);
    const card = title => [...page.doc.querySelectorAll('.photo-card')]
        .find(candidate => candidate.querySelector('h3')?.textContent === title);

    assert.match(card('Local editing data').textContent, /Editing data is available/);
    assert.match(card('Local editing data').textContent, /Local: original, project, thumbnail retained/);
    assert.match(card('Uploaded and referenced').textContent,
        /Remote: ImgBB image retained · used in 1 report · backup pending/);
    assert.match(card('Unreachable upload').textContent, /ImgBB image marked unreachable/);
    assert.match(card('Post-prune record').textContent,
        /Editing data is no longer retained.*Local: record only/s);
    assert.equal(card('Local editing data').querySelector('button').textContent,
        'Restore with editing data');

    const exactCard = card('Exact expiry');
    assert.match(exactCard.textContent, /Editing recovery has expired/);
    const exactRestore = exactCard.querySelector('button');
    assert.equal(exactRestore.textContent, 'Restore record only');
    exactRestore.click();
    await waitFor(page.dom, () => !card('Exact expiry'));
    assert.match(page.doc.getElementById('toast-message').textContent,
        /record restored.*Editing data is no longer available/i);

    const [restored] = (await readPhotoStore(page.win, 'photos'))
        .filter(photo => photo.localId === 'exact-expiry');
    assert.equal(restored.deletedAt, null);
    assert.deepEqual(restored.assets, {
        originalRetained: false,
        projectRetained: false,
        thumbnailRetained: false,
    });
    assert.deepEqual(page.errors, []);
});

test('removing a photo states the 30-day editing-data window before and after confirmation', async t => {
    let confirmation = '';
    const page = await loadEditor({
        confirmImpl: message => {
            confirmation = message;
            return true;
        },
    });
    t.after(() => page.dom.window.close());
    await waitFor(page.dom, () => page.doc.getElementById('save-status').textContent
        === 'Saved on this device');
    page.click(page.doc.getElementById('show-library'));
    await waitFor(page.dom, () => [...page.doc.querySelectorAll('.photo-card button')]
        .some(button => button.textContent === 'Remove…'));
    page.click([...page.doc.querySelectorAll('.photo-card button')]
        .find(button => button.textContent === 'Remove…'));
    await waitFor(page.dom, () => /Moved to Recently Deleted/.test(
        page.doc.getElementById('toast-message').textContent));

    assert.match(confirmation, /restorable with editing data for 30 days/i);
    assert.match(confirmation, /ImgBB image and report URLs will not change/i);
    assert.match(page.doc.getElementById('toast-message').textContent,
        /Restorable with editing data for 30 days/i);
    assert.deepEqual(page.errors, []);
});

test('library URL copy falls back to the complete selected value for every clipboard failure', async t => {
    const longUrl = `https://i.ibb.co/a/topo.jpg?token=${'x'.repeat(3500)}`;
    const cases = [
        ['missing API', undefined],
        ['synchronous throw', { writeText: () => { throw new Error('blocked'); } }],
        ['rejected promise', { writeText: async () => { throw new Error('denied'); } }],
    ];
    for (const [name, clipboard] of cases) {
        await t.test(name, async () => {
            const indexedDB = new IDBFactory();
            await seedUploadedLibraryPhoto(indexedDB, { url: longUrl });
            const page = await loadEditor({
                indexedDB,
                pickPhoto: false,
                startMode: 'library',
                clipboard,
            });
            const copy = [...page.doc.querySelectorAll('.photo-card button')]
                .find(button => button.textContent === 'Copy URL');
            copy.click();
            await waitFor(page.dom, () => page.doc.getElementById('toast-copy-value').hidden === false);

            const fallback = page.doc.getElementById('toast-copy-value');
            assert.equal(fallback.value, longUrl);
            assert.equal(page.doc.activeElement, fallback);
            assert.equal(fallback.selectionStart, 0);
            assert.equal(fallback.selectionEnd, longUrl.length);
            assert.match(page.doc.getElementById('toast-copy-status').textContent,
                /complete URL is selected/i);
            assert.equal(copy.disabled, false);
            assert.deepEqual(page.errors, []);
            page.dom.window.close();
        });
    }
});

test('library URL copy recovers after lost focus and a repeated click', async () => {
    const indexedDB = new IDBFactory();
    const copied = [];
    await seedUploadedLibraryPhoto(indexedDB);
    const page = await loadEditor({
        indexedDB,
        pickPhoto: false,
        startMode: 'library',
        clipboard: {
            writeText: async value => {
                copied.push(value);
                if (copied.length <= 2) throw new Error('clipboard denied');
            },
        },
    });
    const copy = [...page.doc.querySelectorAll('.photo-card button')]
        .find(button => button.textContent === 'Copy URL');
    copy.click();
    await waitFor(page.dom, () => page.doc.getElementById('toast-copy-value').hidden === false);
    page.doc.getElementById('library-search').focus();
    assert.notEqual(page.doc.activeElement, page.doc.getElementById('toast-copy-value'));

    copy.click();
    const fallback = page.doc.getElementById('toast-copy-value');
    await waitFor(page.dom, () => copied.length === 2 && page.doc.activeElement === fallback);
    assert.equal(page.doc.activeElement, fallback,
        'a repeated failure must restore focus to the complete value');
    assert.equal(fallback.selectionStart, 0);
    assert.equal(fallback.selectionEnd, fallback.value.length);

    copy.click();
    await waitFor(page.dom, () => /Image URL copied/.test(
        page.doc.getElementById('toast-message').textContent));
    assert.equal(copied.length, 3);
    assert.equal(copied[0], 'https://i.ibb.co/a/topo.jpg');
    assert.equal(page.doc.getElementById('toast-copy-value').hidden, true);
    assert.equal(page.doc.getElementById('toast-copy-value').value, '');
    assert.equal(copy.disabled, false);
    assert.deepEqual(page.errors, []);
});

test('a failed report insertion keeps the real page catalog at its committed ImgBB success', async () => {
    const messages = [];
    const indexedDB = new IDBFactory();
    const page = await loadEditor({
        returnToReport: true,
        imgbbStatus: { ok: true, configured: true, permissionGranted: true },
        indexedDB,
        runtimeHandler: async message => {
            messages.push(structuredClone(message));
            if (message?.type === 'PHOTO_INSERT_COMMIT') {
                return {
                    ok: false,
                    error: { message: 'The waiting report tab is no longer available.' },
                };
            }
            return { ok: true };
        },
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(imgbbSuccess),
        }),
    });
    const { doc } = page;
    await waitFor(page.dom, () => doc.getElementById('save-status').textContent === 'Saved on this device');
    page.click(doc.getElementById('upload-insert'));
    await waitFor(page.dom, () => doc.getElementById('photo-viewport').getAttribute('aria-busy') === 'false'
        && /uploaded and saved in the library/i.test(page.status())).catch(error => {
        error.message += `; status=${JSON.stringify(page.status())}`
            + ` toast=${JSON.stringify(doc.getElementById('toast-message').textContent)}`
            + ` errors=${JSON.stringify(page.errors)}`;
        throw error;
    });

    const [catalog, secrets, operations] = await Promise.all([
        readPhotoStore(page.win, 'photos'),
        readPhotoStore(page.win, 'secrets'),
        readPhotoStore(page.win, 'operations'),
    ]);
    assert.equal(messages.filter(message => message.type === 'PHOTO_INSERT_COMMIT').length, 1);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].remote.state, 'uploaded');
    assert.equal(catalog[0].remote.url, 'https://i.ibb.co/a/topo.jpg');
    assert.ok(catalog[0].export?.sha256);
    assert.equal(catalog[0].references.length, 0);
    assert.deepEqual(secrets, [{
        localId: catalog[0].localId,
        deleteUrl: 'https://ibb.co/delete/delete-capability',
    }]);
    assert.equal(operations.length, 1, 'the committed journal stays available for insertion recovery');
    assert.equal(operations[0].state, 'catalog-committed');
    assert.match(doc.getElementById('toast-message').textContent, /waiting report tab/i);
    assert.doesNotMatch(doc.getElementById('toast-message').textContent, /outcome unknown|cataloging failed/i);
    const recoveryUrl = doc.getElementById('toast-copy-value');
    assert.equal(recoveryUrl.hidden, false);
    assert.equal(recoveryUrl.value, catalog[0].remote.url);
    doc.getElementById('toast-action').click();
    await waitFor(page.dom, () => /complete URL is selected/i.test(
        doc.getElementById('toast-copy-status').textContent));
    assert.equal(doc.activeElement, recoveryUrl);
    assert.equal(recoveryUrl.selectionStart, 0);
    assert.equal(recoveryUrl.selectionEnd, catalog[0].remote.url.length);

    let finishCopy;
    let recoveryCopyCalls = 0;
    const pendingCopy = new Promise(resolve => { finishCopy = resolve; });
    Object.defineProperty(page.win.navigator, 'clipboard', {
        value: {
            writeText: () => {
                recoveryCopyCalls += 1;
                return pendingCopy;
            },
        },
        configurable: true,
    });
    const recoveryAction = doc.getElementById('toast-action');
    recoveryAction.click();
    await waitFor(page.dom, () => recoveryCopyCalls === 1);
    doc.getElementById('imgbb-key').value = '';
    doc.getElementById('save-key').click();
    await waitFor(page.dom, () => /Enter a valid ImgBB API key/.test(
        doc.getElementById('toast-message').textContent));
    finishCopy();
    await page.settle();
    assert.match(doc.getElementById('toast-message').textContent, /Enter a valid ImgBB API key/);
    assert.doesNotMatch(doc.getElementById('toast-message').textContent, /copied/i);
    assert.equal(recoveryUrl.hidden, true);
    assert.equal(recoveryUrl.value, '');
    recoveryAction.click();
    assert.equal(recoveryCopyCalls, 1,
        'a replaced recovery surface must not retain a callable URL action');
    assert.deepEqual(page.errors, []);

    page.win.dispatchEvent(new page.win.Event('beforeunload'));
    page.dom.window.close();
    const recoveryMessages = [];
    const recoveredPage = await loadEditor({
        returnToReport: true,
        pickPhoto: false,
        indexedDB,
        imgbbStatus: { ok: true, configured: true, permissionGranted: true },
        runtimeHandler: async message => {
            recoveryMessages.push(structuredClone(message));
            if (message?.type === 'PHOTO_INSERT_COMMIT') {
                return { ok: true, identity: { cid: 10, aid: 20, pid: 30 } };
            }
            return { ok: true };
        },
    });
    const [recoveredCatalog, recoveredOperations] = await Promise.all([
        readPhotoStore(recoveredPage.win, 'photos'),
        readPhotoStore(recoveredPage.win, 'operations'),
    ]);
    assert.equal(recoveryMessages.filter(message => message.type === 'PHOTO_INSERT_COMMIT').length, 1);
    assert.equal(recoveredCatalog[0].remote.state, 'uploaded');
    assert.equal(recoveredCatalog[0].references.length, 1);
    assert.equal(recoveredOperations.length, 0, 'recovery removes the journal without another upload');
    assert.deepEqual(recoveredPage.errors, []);
});

test('an accepted but uncataloged upload keeps its last-resort URL visible and selectable', async () => {
    const indexedDB = new IDBFactory();
    let concurrentEditApplied = false;
    const page = await loadEditor({
        indexedDB,
        imgbbStatus: { ok: true, configured: true, permissionGranted: true },
        clipboard: { writeText: async () => { throw new Error('clipboard denied'); } },
        fetchImpl: async () => {
            const otherTab = await Store.createPhotoStore({ indexedDB });
            const [current] = await otherTab.listPhotos({ includeDeleted: true });
            await otherTab.putPhoto(Library.cleanPhoto({
                ...current,
                title: 'Concurrent title',
                updatedAt: '2026-08-09T12:00:00.000Z',
            }));
            otherTab.close();
            concurrentEditApplied = true;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(imgbbSuccess),
            };
        },
    });
    await waitFor(page.dom, () => page.doc.getElementById('save-status').textContent
        === 'Saved on this device');
    page.click(page.doc.getElementById('upload-insert'));
    await waitFor(page.dom, () => concurrentEditApplied
        && page.doc.getElementById('photo-viewport').getAttribute('aria-busy') === 'false'
        && /could not finish cataloging/i.test(page.doc.getElementById('toast-message').textContent));

    const fallback = page.doc.getElementById('toast-copy-value');
    assert.equal(fallback.hidden, false);
    assert.equal(fallback.value, 'https://i.ibb.co/a/topo.jpg');
    page.click(page.doc.getElementById('toast-action'));
    await waitFor(page.dom, () => /complete URL is selected/i.test(
        page.doc.getElementById('toast-copy-status').textContent));
    assert.equal(page.doc.activeElement, fallback);
    assert.equal(fallback.selectionStart, 0);
    assert.equal(fallback.selectionEnd, fallback.value.length);
    assert.equal(page.doc.getElementById('toast').hidden, false,
        'last-resort upload recovery must remain until another surface replaces it');
    assert.deepEqual(page.errors, []);
});

test('export and upload hold one immutable snapshot behind every editor mutation path', async () => {
    let releaseExport;
    const exportGate = new Promise(resolve => { releaseExport = resolve; });
    let exportStarted = false;
    let resolveUpload;
    let uploadStarted = false;
    const uploadGate = new Promise(resolve => { resolveUpload = resolve; });
    const insertionMessages = [];
    const page = await loadEditor({
        returnToReport: true,
        imgbbStatus: { ok: true, configured: true, permissionGranted: true },
        imageLoader: image => {
            exportStarted = true;
            void exportGate.then(() => image.onload?.());
        },
        fetchImpl: async () => {
            uploadStarted = true;
            await uploadGate;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(imgbbSuccess),
            };
        },
        runtimeHandler: async message => {
            if (message?.type === 'PHOTO_INSERT_COMMIT') {
                insertionMessages.push(structuredClone(message));
                return { ok: true, identity: { cid: 10, aid: 20, pid: 30 } };
            }
            return { ok: true };
        },
    });
    const { doc, win } = page;
    const title = doc.getElementById('photo-title');
    const alt = doc.getElementById('photo-alt');
    title.value = 'Snapshot title';
    alt.value = 'Snapshot description';
    page.emit(title, 'input');
    page.emit(alt, 'input');
    page.tool('bolt');
    page.pointer('pointerdown', 100, 100);
    await waitForPhotoStore(win, 'photos', records =>
        records[0]?.title === 'Snapshot title' && records[0]?.alt === 'Snapshot description');
    await waitForPhotoStore(win, 'projects', records => records[0]?.objects.length === 1);

    page.click(doc.getElementById('upload-insert'));
    await waitFor(page.dom, () => exportStarted && doc.getElementById('photo-viewport')
        .getAttribute('aria-busy') === 'true');

    const mutationControls = [
        title,
        alt,
        doc.getElementById('undo'),
        doc.getElementById('redo'),
        doc.getElementById('finish-route'),
        doc.getElementById('object-color'),
        doc.getElementById('object-opacity'),
        doc.getElementById('route-width'),
        doc.getElementById('route-stroke'),
        doc.getElementById('route-arrow'),
        doc.getElementById('route-smooth'),
        doc.getElementById('object-scale'),
        doc.getElementById('object-rotation'),
        doc.getElementById('pitch-number'),
        doc.getElementById('object-text'),
        doc.getElementById('text-align'),
        doc.getElementById('label-background'),
        doc.getElementById('send-back'),
        doc.getElementById('bring-front'),
        doc.getElementById('duplicate-object'),
        doc.getElementById('delete-object'),
        doc.getElementById('clear-annotations'),
        doc.getElementById('upload-format'),
        doc.getElementById('jpeg-quality'),
        ...doc.querySelectorAll('[data-tool]'),
    ];
    assert.ok(mutationControls.every(control => control.disabled),
        'every visible editor mutation is disabled before export begins');
    assert.equal(doc.getElementById('photo-overlay').getAttribute('aria-disabled'), 'true');
    assert.equal(doc.getElementById('photo-file').disabled, true);
    assert.equal(doc.getElementById('import-project').disabled, true);
    assert.ok([...doc.querySelectorAll('[data-report-width]')].every(control => control.disabled));

    // Dispatch directly as well as clicking disabled controls: the mutation
    // helpers themselves must reject programmatic and already-queued events.
    title.value = 'Late title';
    alt.value = 'Late description';
    page.emit(title, 'input');
    page.emit(alt, 'input');
    page.emit(doc.getElementById('object-opacity'), 'input');
    doc.getElementById('upload-format').value = 'png';
    page.emit(doc.getElementById('upload-format'), 'change');
    doc.getElementById('jpeg-quality').value = '70';
    page.emit(doc.getElementById('jpeg-quality'), 'input');
    page.emit(doc.getElementById('jpeg-quality'), 'change');
    page.click(doc.getElementById('duplicate-object'));
    page.click(doc.getElementById('delete-object'));
    page.click(doc.getElementById('clear-annotations'));
    page.tool('anchor');
    page.pointer('pointerdown', 200, 200);
    page.key('keydown', { key: 'Delete' });
    page.key('keydown', { key: 'z', metaKey: true });
    page.key('keydown', { key: 'ArrowRight' });
    page.key('keydown', { key: 'a' });
    const input = doc.getElementById('photo-file');
    Object.defineProperty(input, 'files', {
        value: [new win.File(['replacement'], 'replacement.jpg', { type: 'image/jpeg' })],
        configurable: true,
    });
    input.dispatchEvent(new win.Event('change'));

    releaseExport();
    await waitFor(page.dom, () => uploadStarted);
    title.value = 'Later still';
    page.emit(title, 'input');
    page.click(doc.getElementById('undo'));
    page.pointer('pointerdown', 300, 300);
    resolveUpload();
    await waitFor(page.dom, () => /Uploaded and inserted/.test(page.status())
        && doc.getElementById('photo-viewport').getAttribute('aria-busy') === 'false');

    const [catalog, projects] = await Promise.all([
        readPhotoStore(win, 'photos'),
        readPhotoStore(win, 'projects'),
    ]);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].remote.state, 'uploaded');
    assert.equal(catalog[0].title, 'Snapshot title');
    assert.equal(catalog[0].alt, 'Snapshot description');
    assert.equal(projects[0].objects.length, 1);
    assert.equal(projects[0].export.mime, 'image/jpeg',
        'a programmatic format change cannot replace the frozen upload settings');
    assert.equal(title.value, 'Snapshot title');
    assert.equal(alt.value, 'Snapshot description');
    assert.equal(insertionMessages.length, 1);
    assert.equal(insertionMessages[0].alt, 'Snapshot description');
    assert.ok(mutationControls.every(control => control.disabled),
        'the committed snapshot remains read-only until Edit as new version');
    assert.equal(doc.getElementById('photo-file').disabled, false,
        'choosing a different source remains available after commit');
    assert.equal(doc.getElementById('import-project').disabled, false);
    assert.deepEqual(page.errors, []);
});

test('a definite provider refusal unlocks the draft for correction and retry', async () => {
    const page = await loadEditor({
        imgbbStatus: { ok: true, configured: true, permissionGranted: true },
        fetchImpl: async () => ({
            ok: false,
            status: 400,
            text: async () => JSON.stringify({
                error: { message: 'Unsupported or unrecognized file format', code: 415 },
            }),
        }),
    });
    const { doc } = page;
    await waitFor(page.dom, () => doc.getElementById('save-status').textContent === 'Saved on this device');
    page.tool('bolt');
    page.pointer('pointerdown', 100, 100);
    page.click(doc.getElementById('upload-insert'));
    await waitFor(page.dom, () => /JPEG or PNG/.test(page.status())
        && doc.getElementById('photo-viewport').getAttribute('aria-busy') === 'false');

    assert.equal(doc.getElementById('photo-title').disabled, false);
    assert.ok([...doc.querySelectorAll('[data-tool]')].every(control => control.disabled === false));
    assert.equal(doc.getElementById('undo').disabled, false);
    assert.equal(doc.getElementById('upload-insert').disabled, false);
    assert.equal(doc.getElementById('photo-overlay').getAttribute('aria-disabled'), 'false');
    assert.deepEqual(page.errors, []);
});

// One drag of a slider used to push one history entry per intermediate value:
// Undo stepped back a single tick, and Route width (1–100) alone pushed the
// full 100-entry limit, evicting every real edit behind it.
test('a slider drag is one undo step, and it does not evict the edits behind it', async () => {
    const page = await loadEditor();
    const { doc } = page;

    page.tool('bolt');
    page.pointer('pointerdown', 100, 100);
    await page.settle();
    assert.equal(page.markCount(), 1);

    const opacity = doc.getElementById('object-opacity');
    assert.equal(doc.getElementById('inspector').hidden, false, 'placing a mark selects it');
    for (let value = 100; value >= 20; value -= 5) {
        opacity.value = String(value);
        page.emit(opacity, 'input');
    }
    page.emit(opacity, 'change');
    await page.settle();
    assert.equal(doc.getElementById('object-opacity-value').textContent, '20%');

    page.click(doc.getElementById('undo'));
    await page.settle();
    assert.equal(doc.getElementById('object-opacity-value').textContent, '100%',
        'one Undo returns to the value before the drag, not one tick back');
    assert.equal(page.markCount(), 1, 'the mark itself survives undoing its restyle');

    // A second drag of the same slider on the same mark is its own step.
    for (let value = 100; value >= 50; value -= 5) {
        opacity.value = String(value);
        page.emit(opacity, 'input');
    }
    page.emit(opacity, 'change');
    await page.settle();
    page.click(doc.getElementById('undo'));
    await page.settle();
    assert.equal(doc.getElementById('object-opacity-value').textContent, '100%');

    assert.deepEqual(page.errors, []);
});

// The style controls used to wait for a mark to exist, so the first symbol was
// always placed at the previous style and then corrected. Arming a tool shows
// the style its next mark will take instead.
test('arming a placement tool shows its style before anything is placed', async () => {
    const page = await loadEditor();
    const { doc } = page;
    const inspector = doc.getElementById('inspector');
    const heading = () => doc.getElementById('inspector-heading').textContent;

    assert.equal(inspector.hidden, true, 'Select with nothing selected has nothing to show');

    page.tool('bolt');
    await page.settle();
    assert.equal(inspector.hidden, false);
    assert.equal(heading(), 'Bolt style');
    assert.equal(doc.getElementById('object-actions').hidden, true,
        'there is no mark yet to reorder, duplicate, or delete');
    assert.equal(doc.querySelector('.point-only').hidden, true,
        'rotation describes a placed mark, not the tool');
    assert.equal(doc.querySelector('.scale-only').hidden, false);
    assert.equal(doc.querySelector('.route-only').hidden, true);
    assert.equal(doc.getElementById('object-scale-value').textContent, '32 px',
        'marker size is reported in source-image pixels');

    const scale = doc.getElementById('object-scale');
    scale.value = '2';
    page.emit(scale, 'input');
    assert.equal(doc.getElementById('object-scale-value').textContent, '65 px');

    page.tool('route');
    await page.settle();
    assert.equal(heading(), 'Route style');
    assert.equal(doc.querySelector('.route-only').hidden, false);
    assert.equal(doc.querySelector('.scale-only').hidden, true);
    assert.equal(doc.getElementById('route-width-value').textContent, '12 px');

    const width = doc.getElementById('route-width');
    width.value = '24';
    page.emit(width, 'input');
    assert.equal(doc.getElementById('route-width-value').textContent, '24 px');

    page.tool('text');
    await page.settle();
    assert.equal(doc.getElementById('object-scale-value').textContent, '84 px',
        'text reports the renderer font size for its preserved 2× scale default');

    page.tool('select');
    await page.settle();
    assert.equal(inspector.hidden, true, 'Select has only a selection to describe');
    assert.equal(page.markCount(), 0, 'none of this drew anything');
    assert.deepEqual(page.errors, []);
});

// Presetting is the point: the value chosen before the click has to be the
// value the mark lands with, and choosing it must not cost an Undo step.
test('a style chosen before the first click is the style the mark is placed at', async () => {
    const page = await loadEditor();
    const { doc } = page;

    page.tool('bolt');
    await page.settle();
    const opacity = doc.getElementById('object-opacity');
    opacity.value = '40';
    page.emit(opacity, 'input');
    page.emit(opacity, 'change');
    const color = doc.getElementById('object-color');
    color.value = '#1e88e5';
    page.emit(color, 'change');
    await page.settle();
    assert.equal(page.markCount(), 0, 'presetting a tool draws nothing');

    page.pointer('pointerdown', 120, 140);
    await page.settle();
    assert.equal(page.markCount(), 1);
    assert.equal(doc.getElementById('inspector-heading').textContent, 'Selection');
    assert.equal(doc.getElementById('object-opacity-value').textContent, '40%');
    assert.equal(doc.getElementById('object-color').value, '#1e88e5');

    // Placing the bolt is the only thing that happened to the photo.
    assert.equal(await page.undoDepth(), 1);
    assert.equal(page.markCount(), 0);
    assert.deepEqual(page.errors, []);
});

// Arming a placement tool is a statement about the next mark, not the last one.
// Select is the exception: pressing V after placing a symbol is how the user
// goes on to adjust that symbol.
test('arming a placement tool releases the selected mark, and Select keeps it', async () => {
    const page = await loadEditor();
    const { doc } = page;
    const heading = () => doc.getElementById('inspector-heading').textContent;

    page.tool('bolt');
    page.pointer('pointerdown', 100, 100);
    await page.settle();
    assert.equal(heading(), 'Selection', 'placing a mark selects it');

    page.tool('anchor');
    await page.settle();
    assert.equal(heading(), 'Anchor style');
    assert.equal(doc.getElementById('object-actions').hidden, true);

    page.pointer('pointerdown', 200, 200);
    page.tool('select');
    await page.settle();
    assert.equal(heading(), 'Selection');
    assert.equal(doc.getElementById('object-actions').hidden, false);
    assert.equal(page.markCount(), 2);
    assert.deepEqual(page.errors, []);
});

test('a full-range Route width drag leaves the marks behind it recoverable', async () => {
    const page = await loadEditor();
    const { doc } = page;

    page.tool('bolt');
    page.pointer('pointerdown', 100, 100);
    page.tool('route');
    page.pointer('pointerdown', 200, 200);
    page.pointer('pointerdown', 300, 300);
    page.pointer('pointerdown', 400, 250);
    page.click(doc.getElementById('finish-route'));
    page.tool('select');
    await page.settle();
    assert.equal(page.markCount(), 2);

    const width = doc.getElementById('route-width');
    assert.equal(doc.querySelector('.route-only').hidden, false, 'the route is the selected mark');
    for (let value = 1; value <= 100; value += 1) {
        width.value = String(value);
        page.emit(width, 'input');
    }
    page.emit(width, 'change');
    await page.settle();

    // Bolt, route, width drag — three things the user did, three Undo steps,
    // and the history limit is nowhere near reached.
    assert.equal(await page.undoDepth(), 3);
    assert.equal(page.markCount(), 0, 'undoing everything must clear the photo');
    assert.deepEqual(page.errors, []);
});

test('a held arrow key is one nudge, and releasing it starts the next', async () => {
    const page = await loadEditor();

    page.tool('bolt');
    page.pointer('pointerdown', 100, 100);
    page.tool('select');
    await page.settle();

    for (let repeat = 0; repeat < 30; repeat += 1) page.key('keydown', { key: 'ArrowRight' });
    page.key('keyup', { key: 'ArrowRight' });
    for (let repeat = 0; repeat < 30; repeat += 1) page.key('keydown', { key: 'ArrowDown' });
    page.key('keyup', { key: 'ArrowDown' });
    await page.settle();

    // Placing the bolt, the rightward run, the downward run.
    assert.equal(await page.undoDepth(), 3);
    assert.equal(page.markCount(), 0);
    assert.deepEqual(page.errors, []);
});

test('keyboard controls add, select, reorder, duplicate, nudge, delete, and undo marks', async () => {
    const page = await loadEditor();
    const { doc, win } = page;
    const activate = node => {
        node.focus();
        node.click();
    };
    const press = (node, key, init = {}) => node.dispatchEvent(new win.KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true, ...init,
    }));
    const annotationButtons = () => [...doc.querySelectorAll('#annotation-list [data-object-id]')];

    activate(doc.querySelector('[data-tool="bolt"]'));
    activate(doc.getElementById('add-at-center'));
    assert.equal(page.markCount(), 1);
    assert.equal(annotationButtons()[0].textContent, 'Bolt');
    assert.equal(annotationButtons()[0].getAttribute('aria-pressed'), 'true');

    activate(doc.querySelector('[data-tool="anchor"]'));
    activate(doc.getElementById('add-at-center'));
    assert.deepEqual(annotationButtons().map(button => button.textContent), ['Bolt', 'Anchor']);

    activate(annotationButtons()[0]);
    assert.equal(page.armedTool(), 'select');
    assert.equal(annotationButtons()[0].getAttribute('aria-pressed'), 'true');
    press(annotationButtons()[0], 'ArrowRight', { shiftKey: true });
    annotationButtons()[0].dispatchEvent(new win.KeyboardEvent('keyup', {
        key: 'ArrowRight', bubbles: true,
    }));
    assert.equal(doc.activeElement.dataset.objectId, annotationButtons()[0].dataset.objectId,
        'an immutable rerender restores annotation-list focus');

    activate(doc.getElementById('bring-front'));
    assert.deepEqual(annotationButtons().map(button => button.textContent), ['Anchor', 'Bolt']);
    activate(doc.getElementById('duplicate-object'));
    assert.equal(page.markCount(), 3);
    assert.equal(annotationButtons().at(-1).getAttribute('aria-pressed'), 'true');

    activate(annotationButtons().at(-1));
    const removedId = doc.activeElement.dataset.objectId;
    press(doc.activeElement, 'Delete');
    assert.equal(page.markCount(), 2);
    assert.notEqual(doc.activeElement.dataset.objectId, removedId,
        'deleting from the list moves focus to a surviving annotation');
    const focusAfterDelete = doc.activeElement.dataset.objectId;
    press(doc.activeElement, 'z', { ctrlKey: true });
    assert.equal(page.markCount(), 3);
    assert.equal(doc.activeElement.dataset.objectId, focusAfterDelete,
        'Undo keeps focus on the same surviving annotation after rerender');
    assert.deepEqual(page.errors, []);
});

test('keyboard controls add a centered route and edit one focusable vertex', async () => {
    const page = await loadEditor();
    const { doc, win } = page;
    const activate = node => {
        node.focus();
        node.click();
    };
    const press = (node, key, init = {}) => node.dispatchEvent(new win.KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true, ...init,
    }));

    activate(doc.querySelector('[data-tool="route"]'));
    activate(doc.getElementById('add-at-center'));
    assert.equal(page.markCount(), 1);
    assert.equal(doc.querySelector('#annotation-list button').textContent, 'Route, 2 points');

    activate(doc.querySelector('#annotation-list button'));
    const points = [...doc.querySelectorAll('#route-point-list [data-vertex]')];
    assert.equal(points.length, 2);
    activate(points[1]);
    const before = page.routePath();
    press(doc.activeElement, 'ArrowDown');
    doc.activeElement.dispatchEvent(new win.KeyboardEvent('keyup', {
        key: 'ArrowDown', bubbles: true,
    }));
    assert.notEqual(page.routePath(), before);
    assert.equal(doc.activeElement.dataset.vertex, '1');
    assert.equal(doc.activeElement.getAttribute('aria-pressed'), 'true');

    press(doc.activeElement, 'z', { ctrlKey: true });
    assert.equal(page.routePath(), before);
    assert.equal(doc.activeElement.dataset.vertex, '1',
        'Undo preserves focus on the route point it rerenders');
    assert.deepEqual(page.errors, []);
});

// Reaching for a browser command used to arm a topo tool behind the dialog, so
// the user's next click on the photo dropped a mark they never asked for.
test('browser shortcuts do not arm a topo tool', async () => {
    const page = await loadEditor();

    page.tool('select');
    for (const [modifier, letter] of [
        ['metaKey', 'p'],   // Print
        ['ctrlKey', 'a'],   // Select all
        ['metaKey', 's'],   // Save page
        ['ctrlKey', 'l'],   // Address bar
        ['altKey', 't'],
    ]) {
        page.key('keydown', { key: letter, [modifier]: true });
        assert.equal(page.armedTool(), 'select', `${modifier}+${letter} must not arm a tool`);
    }

    // The bare keys still work, and Shift stays this page's own nudge modifier.
    page.key('keydown', { key: 'p' });
    assert.equal(page.armedTool(), 'piton');
    page.key('keydown', { key: 'v', shiftKey: true });
    assert.equal(page.armedTool(), 'select');
    assert.deepEqual(page.errors, []);
});

// Dragging a vertex used to translate only that vertex's own handles, leaving
// its neighbours' tangents aimed at where the point had been: a smooth route
// kinked away from the point the user was dragging.
test('moving a smooth route vertex re-derives the curve around it', async () => {
    const page = await loadEditor();
    const { doc } = page;

    page.tool('route');
    page.pointer('pointerdown', 50, 350);
    page.pointer('pointerdown', 250, 200);
    page.pointer('pointerdown', 450, 50);
    page.click(doc.getElementById('finish-route'));
    page.tool('select');
    const smooth = doc.getElementById('route-smooth');
    smooth.checked = true;
    page.emit(smooth, 'change');
    await page.settle();
    assert.equal(page.routePath(),
        'M 100 700 C 166.667 650 366.667 500 500 400 C 633.333 300 833.333 150 900 100');

    const handles = [...page.overlay.querySelectorAll('.vertex-handle')];
    assert.equal(handles.length, 3, 'a selected route offers one handle per vertex');
    const middle = handles.find(node => node.dataset.vertex === '1');
    page.pointer('pointerdown', 125, 100, middle);
    page.pointer('pointermove', 125, 250);
    page.pointer('pointerup', 125, 250);
    await page.settle();

    // The middle point lands at y = 700, level with the first. Both tangents
    // that touch it follow; a stale neighbour would still read 166.667 650.
    assert.equal(page.routePath(),
        'M 100 700 C 166.667 700 366.667 800 500 700 C 633.333 600 833.333 200 900 100');
    assert.deepEqual(page.errors, []);
});

// Every advertised way out of a route has to work, because the one the user
// reaches for is the one they believe. The double-click is the load-bearing
// case: Chrome withholds the `click` that pairs into `dblclick` whenever the
// press repaints the node the release lands on, which is every press here, so
// a route drawn in the real editor could not be ended by the gesture its own
// status line named. The gesture is read from the presses instead.
test('a double-click, a right-click, and Enter each end a route', async () => {
    const page = await loadEditor();

    // Double-click: the second press of the pair lands on the point the first
    // one placed, and ends the route rather than stacking a duplicate on it.
    page.tool('route');
    page.pointer('pointerdown', 50, 350);
    page.pointer('pointerdown', 250, 200);
    page.pointer('pointerdown', 450, 50);
    page.pointer('pointerdown', 452, 52);
    await page.settle();
    assert.equal(page.drawing(), false, 'the double-click ended the route');
    assert.match(page.status(), /^Route added\./);
    assert.equal(page.markCount(), 1);
    page.tool('select');
    await page.settle();
    assert.equal(page.vertexCount(), 3, 'the finishing press placed no fourth point');

    // Right-click: the press itself places nothing, and the page's own menu is
    // suppressed only because a route was in progress.
    page.tool('route');
    page.pointer('pointerdown', 60, 360);
    page.pointer('pointerdown', 260, 210);
    await page.settle();
    assert.equal(page.drawing(), true);
    assert.equal(page.rightClick(300, 150), true, 'the context menu is suppressed mid-route');
    await page.settle();
    assert.equal(page.drawing(), false, 'the right-click ended the route');
    assert.match(page.status(), /^Route added\./);
    assert.equal(page.markCount(), 2);
    page.tool('select');
    await page.settle();
    assert.equal(page.vertexCount(), 2, 'the secondary button placed no point');

    // With no route in progress the menu is the user's again.
    assert.equal(page.rightClick(300, 150), false);

    // Enter.
    page.tool('route');
    page.pointer('pointerdown', 70, 370);
    page.pointer('pointerdown', 270, 220);
    page.pointer('pointerdown', 470, 70);
    await page.settle();
    page.key('keydown', { key: 'Enter' });
    await page.settle();
    assert.equal(page.drawing(), false, 'Enter ended the route');
    assert.match(page.status(), /^Route added\./);
    assert.equal(page.markCount(), 3);

    assert.deepEqual(page.errors, []);
});

// The finishing press is the *double*-click, not any second click: a route
// traced with slow, deliberate clicks along a tight line must keep drawing.
test('two unhurried presses on one spot keep the route going', async () => {
    const page = await loadEditor();

    page.tool('route');
    page.pointer('pointerdown', 50, 350);
    page.pointer('pointerdown', 250, 200);
    await page.settle();
    // Far enough apart in space to be two points, close enough in time to be
    // one gesture — the distance alone has to keep them separate.
    page.pointer('pointerdown', 270, 210);
    await page.settle();
    assert.equal(page.drawing(), true, 'a press 22px away is a new point, not a finish');

    // ...and the same spot, once the double-click interval has passed.
    await new Promise(resolve => page.win.setTimeout(resolve, 450));
    page.pointer('pointerdown', 270, 210);
    await page.settle();
    assert.equal(page.drawing(), true, 'a press half a second later is a new point');

    page.click(page.doc.getElementById('finish-route'));
    page.tool('select');
    await page.settle();
    assert.equal(page.vertexCount(), 4);
    assert.deepEqual(page.errors, []);
});

// Dragging one vertex must move that vertex and leave its neighbours where the
// user put them. Nothing covered this, and the callback that rebuilds the point
// list named its parameter over the pointer position — so its untouched branch
// read `point` and could be "keep this vertex" or "collapse every vertex onto
// the cursor" depending on which `point` was in scope.
test('dragging one route vertex moves only that vertex', async () => {
    const page = await loadEditor();
    const { doc } = page;

    page.tool('route');
    page.pointer('pointerdown', 100, 100);
    page.pointer('pointerdown', 200, 100);
    page.pointer('pointerdown', 300, 100);
    page.click(doc.getElementById('finish-route'));
    page.tool('select');
    await page.settle();
    assert.equal(page.vertexCount(), 3, 'the drawn route exposes one handle per point');

    const before = page.routePath();
    assert.ok(before, 'the route is drawn');

    // Grab the middle vertex by its own handle — jsdom does no hit testing, so
    // the press has to land on the element the editor routes drags from — and
    // pull it down.
    const handles = [...page.overlay.querySelectorAll('.vertex-handle')];
    assert.equal(handles.length, 3);
    page.pointer('pointerdown', 200, 100, handles[1]);
    page.pointer('pointermove', 200, 260);
    page.pointer('pointerup', 200, 260);
    await page.settle();

    const after = page.routePath();
    assert.notEqual(after, before, 'the dragged vertex moved');
    const moved = [...after.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);
    // First and last vertices keep their x; only the middle one gained height.
    assert.ok(moved.length >= 6, `expected at least three coordinate pairs, got ${after}`);
    assert.equal(page.vertexCount(), 3, 'no vertex was added or lost');

    const ys = [];
    for (let index = 1; index < moved.length; index += 2) ys.push(moved[index]);
    const distinctYs = new Set(ys.map(value => Math.round(value)));
    assert.ok(distinctYs.size > 1,
        `every vertex ended at the same height, so the drag moved all of them: ${after}`);

    assert.deepEqual(page.errors, []);
});
