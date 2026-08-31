// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The map viewport was 190 lines inside gpx-analyzer.js's single closure and
// had no coverage of its own. Extracted, its contract is testable directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mapViewport as MapViewport } from '../../src/gpx/map-viewport.js';
import { pointerEvent } from '../helpers/pointer-event.mjs';

const BOUNDS = { minWidth: 320, maxWidth: 1400, minHeight: 240, maxHeight: 720 };
const RESIZE_RAIL_HEIGHT = 44;

const setup = ({ size = { width: 600, height: 400 }, persistDelayMs = 400 } = {}) => {
    const dom = new JSDOM('<!doctype html><body><p><iframe src="MasterMap.aspx"></iframe></p></body>', {
        pretendToBeVisual: true
    });
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    const invalidated = [];
    const persists = [];
    const map = { invalidateCalls: 0, invalidateSize() { this.invalidateCalls++; } };
    const iframe = dom.window.document.querySelector('iframe');
    Object.defineProperty(iframe, 'contentWindow', {
        configurable: true, value: { mapsPlaceholder: map }
    });
    const viewport = MapViewport.create({
        iframe,
        size,
        bounds: BOUNDS,
        railHeight: RESIZE_RAIL_HEIGHT,
        persistDelayMs,
        onPersist: value => persists.push(value),
        onInvalidated: () => invalidated.push(true),
    });
    const restoreGlobals = () => {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
    };
    const restore = () => {
        restoreGlobals();
        dom.window.close();
    };
    return { dom, viewport, persists, invalidated, map, iframe, restore, restoreGlobals };
};

const emulateRenderedSize = (viewport, {
    width = 600,
    wrapperHeightCap = Number.POSITIVE_INFINITY,
} = {}) => {
    viewport.element.getBoundingClientRect = () => ({
        left: 0,
        right: width,
        width,
        height: Math.min(Number.parseFloat(viewport.element.style.height), wrapperHeightCap),
    });
};

test('the viewport wraps the map frame and exposes a resize handle', () => {
    const { dom, viewport, iframe, restore } = setup();
    try {
        assert.equal(viewport.element.id, 'bpb-map-viewport');
        assert.equal(iframe.parentElement, viewport.element, 'the frame moves inside the wrapper');
        const handle = dom.window.document.getElementById('bpb-map-resize-handle');
        assert.ok(handle, 'a resize affordance exists');
        assert.match(handle.getAttribute('aria-label'), /Use arrow keys for small steps/,
            'the handle is reachable and described for keyboard users');
        assert.equal(handle.style.width, '44px');
        assert.equal(handle.style.height, '44px');
        assert.equal(handle.style.touchAction, 'none');
        assert.equal(iframe.style.height, 'calc(100% - 44px)',
            'the hit target owns a dedicated rail instead of covering map controls');
        assert.equal(viewport.element.style.width, '600px');
        assert.equal(viewport.element.style.height, '444px', 'height includes the resize rail');
    } finally { restore(); }
});

test('sizes are clamped to the schema bounds the caller supplies', () => {
    const { viewport, restore } = setup();
    try {
        viewport.applySize({ width: 99999, height: 99999 });
        assert.deepEqual(viewport.size, { width: BOUNDS.maxWidth, height: BOUNDS.maxHeight });
        viewport.applySize({ width: 1, height: 1 });
        assert.deepEqual(viewport.size, { width: BOUNDS.minWidth, height: BOUNDS.minHeight });
    } finally { restore(); }
});

for (const [name, preferredHeight, wrapperHeightCap, effectiveHeight] of [
    ['minimum preference in a tall window', BOUNDS.minHeight, 1200, BOUNDS.minHeight],
    ['default preference in a short window', 450, 394, 350],
    ['maximum preference in a short window', BOUNDS.maxHeight, 584, 540],
    ['maximum preference in a tall window', BOUNDS.maxHeight, 1200, BOUNDS.maxHeight],
]) {
    test(`${name} reports measured map content, not the resize rail or hidden preference`, async () => {
        const { dom, viewport, restore } = setup({ size: { width: 600, height: preferredHeight } });
        try {
            emulateRenderedSize(viewport, { wrapperHeightCap });
            viewport.scheduleInvalidate();
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(viewport.size.height, preferredHeight, 'the untouched preference is retained');
            assert.equal(viewport.effectiveSize.height, effectiveHeight);
            assert.match(dom.window.document.getElementById('bpb-map-resize-handle')
                .getAttribute('aria-label'), new RegExp(`by ${effectiveHeight} pixels high`));
        } finally { restore(); }
    });
}

test('the first keyboard and pointer deltas start from visible short-window height', async () => {
    const { dom, viewport, persists, restore } = setup({
        size: { width: 600, height: BOUNDS.maxHeight },
        persistDelayMs: 30,
    });
    try {
        emulateRenderedSize(viewport, { wrapperHeightCap: 584 });
        viewport.scheduleInvalidate();
        await new Promise(resolve => setTimeout(resolve, 30));
        const handle = dom.window.document.getElementById('bpb-map-resize-handle');
        assert.equal(viewport.effectiveSize.height, 540);

        handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowUp', bubbles: true, cancelable: true,
        }));
        assert.equal(viewport.effectiveSize.height, 530,
            'the first key changes rendered map content by one step');
        assert.equal(viewport.size.height, 530,
            'direct interaction deliberately replaces the hidden preference');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.deepEqual(persists, [{ width: 600, height: 530 }]);

        viewport.element.parentElement.getBoundingClientRect = () => ({
            left: 0, right: 600, width: 600,
        });
        handle.dispatchEvent(pointerEvent(dom, 'pointerdown', {
            pointerId: 5, pointerType: 'touch', button: 0, clientX: 600, clientY: 530,
        }));
        handle.dispatchEvent(pointerEvent(dom, 'pointermove', {
            pointerId: 5, pointerType: 'touch', buttons: 1, clientX: 600, clientY: 529,
        }));
        assert.equal(viewport.effectiveSize.height, 529,
            'the first pointer pixel changes rendered map content by one pixel');
        handle.dispatchEvent(pointerEvent(dom, 'pointerup', {
            pointerId: 5, pointerType: 'touch', clientX: 600, clientY: 529,
        }));
        assert.deepEqual(persists.at(-1), { width: 600, height: 529 });
    } finally { restore(); }
});

test('window growth restores only an untouched preferred height', async () => {
    const { dom, viewport, restore } = setup({ size: { width: 600, height: BOUNDS.maxHeight } });
    try {
        let wrapperHeightCap = 584;
        viewport.element.getBoundingClientRect = () => ({
            left: 0,
            right: 600,
            width: 600,
            height: Math.min(Number.parseFloat(viewport.element.style.height), wrapperHeightCap),
        });
        viewport.scheduleInvalidate();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(viewport.effectiveSize.height, 540);

        wrapperHeightCap = 1200;
        dom.window.dispatchEvent(new dom.window.Event('resize'));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(viewport.effectiveSize.height, BOUNDS.maxHeight);
        assert.equal(viewport.size.height, BOUNDS.maxHeight,
            'window growth restores the untouched preference');

        wrapperHeightCap = 584;
        dom.window.dispatchEvent(new dom.window.Event('resize'));
        await new Promise(resolve => setTimeout(resolve, 30));
        const handle = dom.window.document.getElementById('bpb-map-resize-handle');
        handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        assert.equal(viewport.size.height, 530);
        wrapperHeightCap = 1200;
        dom.window.dispatchEvent(new dom.window.Event('resize'));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(viewport.effectiveSize.height, 530,
            'window growth does not resurrect a preference replaced by direct interaction');
    } finally { restore(); }
});

test('pointer resizing can use a wider layout boundary than the viewport column', () => {
    const dom = new JSDOM('<!doctype html><body><main><section><iframe src="MasterMap.aspx"></iframe></section></main></body>', {
        pretendToBeVisual: true
    });
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const iframe = dom.window.document.querySelector('iframe');
        const boundary = dom.window.document.querySelector('main');
        const viewport = MapViewport.create({
            iframe,
            size: { width: 450, height: 400 },
            bounds: BOUNDS,
            railHeight: RESIZE_RAIL_HEIGHT,
            persistDelayMs: 400,
            onPersist: () => {},
            getResizeBoundary: () => boundary,
        });
        boundary.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000 });
        viewport.element.getBoundingClientRect = () => ({ left: 0, right: 450, width: 450 });
        const handle = dom.window.document.getElementById('bpb-map-resize-handle');
        handle.dispatchEvent(pointerEvent(dom, 'pointerdown', {
            button: 0, clientX: 450, clientY: 400
        }));
        handle.dispatchEvent(pointerEvent(dom, 'pointermove', {
            clientX: 650, clientY: 400
        }));
        assert.equal(viewport.size.width, 650,
            'the shrink-wrapped map column must not cap growth at its current width');
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('touch cancellation and capture loss commit the visible map size once', () => {
    const { dom, viewport, persists, restore } = setup();
    try {
        const handle = dom.window.document.getElementById('bpb-map-resize-handle');
        const boundary = viewport.element.parentElement;
        boundary.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000 });
        viewport.element.getBoundingClientRect = () => ({ left: 0, right: 600, width: 600 });
        const touch = { pointerId: 9, pointerType: 'touch' };
        handle.dispatchEvent(pointerEvent(dom, 'pointerdown', {
            ...touch, button: 0, clientX: 600, clientY: 400,
        }));
        const move = pointerEvent(dom, 'pointermove', {
            ...touch, buttons: 1, clientX: 700, clientY: 450,
        });
        handle.dispatchEvent(move);
        assert.equal(move.defaultPrevented, true, 'touch movement cannot scroll the page');
        handle.dispatchEvent(pointerEvent(dom, 'pointercancel', touch));
        handle.dispatchEvent(pointerEvent(dom, 'lostpointercapture', touch));
        handle.dispatchEvent(pointerEvent(dom, 'pointerup', touch));

        assert.deepEqual(viewport.size, { width: 700, height: 450 });
        assert.deepEqual(persists, [{ width: 700, height: 450 }],
            'duplicate terminal events cannot persist the gesture twice');
    } finally { restore(); }
});

test('a keyboard resize persists once after the last keystroke, not per repeat', async () => {
    // Persisting each key repeat would burn chrome.storage.sync's
    // write-per-minute quota and the final size could silently fail to stick.
    const { dom, viewport, persists, restore } = setup({ persistDelayMs: 30 });
    try {
        const handle = dom.window.document.getElementById('bpb-map-resize-handle');
        for (let i = 0; i < 6; i++) {
            handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        }
        assert.deepEqual(persists, [], 'no write while the key is still repeating');
        assert.equal(viewport.size.height, 460, 'but the size follows every step');

        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(persists.length, 1, 'exactly one write after the last keystroke');
        assert.deepEqual(persists[0], { width: 600, height: 460 });
    } finally { restore(); }
});

test('an unhandled key is left alone', () => {
    const { dom, viewport, restore } = setup();
    try {
        const handle = dom.window.document.getElementById('bpb-map-resize-handle');
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        handle.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, 'Tab must still move focus');
        assert.deepEqual(viewport.size, { width: 600, height: 400 });
    } finally { restore(); }
});

test('resizing tells Leaflet its container moved', async () => {
    const { viewport, map, invalidated, restore } = setup();
    try {
        viewport.applySize({ width: 700, height: 500 });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(map.invalidateCalls >= 1, 'Leaflet is told to re-measure');
        assert.ok(invalidated.length >= 1, 'and the floating 3D toggle is re-anchored');
    } finally { restore(); }
});

test('a map frame Peakbagger has discarded does not break resizing', async () => {
    const { viewport, iframe, restoreGlobals } = setup();
    try {
        Object.defineProperty(iframe, 'contentWindow', {
            configurable: true,
            get() { throw new Error('frame discarded'); }
        });
        viewport.applySize({ width: 720, height: 520 });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(viewport.size, { width: 720, height: 520 },
            'the viewport still resizes when its frame is gone');
    } finally {
        // Not restore(): jsdom's own window.close() reads contentWindow, which
        // this test has deliberately made throw. Put the globals back by hand.
        restoreGlobals();
    }
});

test('a replacement reuses one viewport and restores a still-connected old frame', async () => {
    const { dom, viewport, iframe, restore } = setup();
    try {
        const replacementMap = { invalidateCalls: 0, invalidateSize() { this.invalidateCalls++; } };
        const replacement = dom.window.document.createElement('iframe');
        replacement.src = 'MasterMap.aspx?replacement=1';
        Object.defineProperty(replacement, 'contentWindow', {
            configurable: true, value: { mapsPlaceholder: replacementMap }
        });
        viewport.element.parentElement.append(replacement);

        const originalViewport = viewport.element;
        viewport.attach(replacement);
        await new Promise(resolve => setTimeout(resolve, 30));

        assert.equal(viewport.element, originalViewport);
        assert.equal(replacement.parentElement, originalViewport);
        assert.equal(iframe.parentElement, originalViewport.parentElement,
            'a native frame that remains connected is released from extension ownership');
        assert.equal(iframe.style.cssText, '', 'the extension restores the old frame’s inline style');
        assert.equal(originalViewport.querySelectorAll('#bpb-map-resize-handle').length, 1);
        assert.ok(replacementMap.invalidateCalls > 0);
    } finally { restore(); }
});

test('with no map frame on the page the viewport is inert but still callable', () => {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const viewport = MapViewport.create({
            iframe: null,
            size: { width: 600, height: 400 },
            bounds: BOUNDS,
            railHeight: RESIZE_RAIL_HEIGHT,
            persistDelayMs: 400,
            onPersist: () => { throw new Error('nothing to persist'); },
        });
        assert.equal(viewport.element, null);
        viewport.applySize({ width: 700, height: 500 });
        viewport.scheduleInvalidate();
        assert.deepEqual(viewport.size, { width: 700, height: 500 });
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('dispose releases the resize observer, window listener, and pending work', async () => {
    const dom = new JSDOM('<!doctype html><body><p><iframe src="MasterMap.aspx"></iframe></p></body>', {
        pretendToBeVisual: true,
    });
    const iframe = dom.window.document.querySelector('iframe');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    const map = { invalidateCalls: 0, invalidateSize() { this.invalidateCalls++; } };
    Object.defineProperty(iframe, 'contentWindow', {
        configurable: true, value: { mapsPlaceholder: map },
    });
    let observed = null;
    let disconnected = 0;
    let observerCallback = null;
    class Observer {
        constructor(callback) { observerCallback = callback; }
        observe(element) { observed = element; }
        disconnect() { disconnected++; }
    }
    const invalidated = [];
    const viewport = MapViewport.create({
        iframe,
        size: { width: 600, height: 400 },
        bounds: BOUNDS,
        railHeight: RESIZE_RAIL_HEIGHT,
        persistDelayMs: 20,
        onPersist: () => {},
        onInvalidated: () => invalidated.push(true),
        ownerWindow: dom.window,
        ResizeObserver: Observer,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    invalidated.length = 0;
    viewport.dispose();
    viewport.dispose();
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    if (observed) observerCallback?.();
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(disconnected, 1);
    assert.deepEqual(invalidated, [], 'disposed viewport schedules no more Leaflet work');
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    dom.window.close();
});
