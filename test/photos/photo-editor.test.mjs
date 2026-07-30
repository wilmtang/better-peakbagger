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
        win,
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
