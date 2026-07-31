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
    imageLoader = null,
} = {}) => {
    const dom = new JSDOM(html, {
        url: `chrome-extension://test/photos/photos.html${returnToReport ? '?returnToken=return-test' : ''}`,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const win = dom.window;
    const doc = win.document;
    win.indexedDB = indexedDB;
    win.IDBKeyRange = IDBKeyRange;
    win.structuredClone = globalThis.structuredClone;
    let ids = 0;
    win.crypto.randomUUID = () => `mark-${++ids}`;
    // jsdom exposes no SubtleCrypto; the page hashes the picked file with it.
    Object.defineProperty(win.crypto, 'subtle', { value: globalThis.crypto.subtle, configurable: true });
    // Decoding and thumbnailing are the browser's, not the editor's, so the
    // harness answers for them with the fixture's dimensions.
    win.createImageBitmap = async () => ({ ...IMAGE, close() {} });
    win.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    win.HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
        callback(new win.Blob(['thumbnail'], { type: 'image/jpeg' }));
    };
    win.Image = class TestImage {
        set src(_value) {
            if (imageLoader) imageLoader(this);
            else win.queueMicrotask(() => this.onload?.());
        }
    };
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
    await evalBundle(win, 'photos/photos.js');
    // The page paints its empty library last, so this is the boot finishing —
    // in particular the IndexedDB handle the first autosave needs.
    await waitFor(dom, () => doc.getElementById('library-empty').hidden === false
        || doc.getElementById('library-list').children.length > 0);

    if (!pickPhoto) return { dom, win, chrome, doc, errors };

    // Pick a photo the way the page's file input does.
    const input = doc.getElementById('photo-file');
    Object.defineProperty(input, 'files', {
        value: [new win.File(['pixels'], 'north-face.jpg', { type: 'image/jpeg' })],
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

const readPhotoStore = (win, storeName) => new Promise((resolve, reject) => {
    const opened = win.indexedDB.open('betterPeakbaggerPhotos', 2);
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

    const handles = [...doc.querySelectorAll('[data-vertex]')];
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
