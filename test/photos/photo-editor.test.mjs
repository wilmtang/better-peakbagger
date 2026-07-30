// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drives the real photo page (photos.html + the built photos.js bundle) in
// jsdom against fake-indexeddb, so the editor's gestures — placing a mark,
// dragging a slider, holding an arrow key — are exercised the way a user
// performs them rather than asserted from source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { evalBundle, waitFor } from '../helpers/load-page.mjs';

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

const loadEditor = async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://test/photos/photos.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const win = dom.window;
    const doc = win.document;
    win.indexedDB = new IDBFactory();
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
    win.URL.createObjectURL = () => 'blob:test';
    win.URL.revokeObjectURL = () => {};
    win.chrome = {
        runtime: {
            id: 'test-extension',
            sendMessage: async message => (message?.type === 'PHOTO_IMGBB_STATUS'
                ? { ok: true, configured: false, permissionGranted: false }
                : { ok: true }),
            onMessage: { addListener: () => {}, removeListener: () => {} },
        },
        permissions: { contains: async () => false, request: async () => false },
        tabs: { create: () => {} },
    };
    const errors = [];
    win.addEventListener('error', event => errors.push(String(event.error?.stack || event.message)));
    await evalBundle(win, 'photos/photos.js');
    // The page paints its empty library last, so this is the boot finishing —
    // in particular the IndexedDB handle the first autosave needs.
    await waitFor(dom, () => doc.getElementById('library-empty').hidden === false);

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
    const key = (type, init) => doc.dispatchEvent(new win.KeyboardEvent(type, { bubbles: true, ...init }));
    const emit = (node, type) => node.dispatchEvent(new win.Event(type, { bubbles: true }));
    return {
        win,
        doc,
        errors,
        overlay,
        click,
        pointer,
        key,
        emit,
        settle: () => settle(win),
        tool: name => click(doc.querySelector(`[data-tool="${name}"]`)),
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
    };
};

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
