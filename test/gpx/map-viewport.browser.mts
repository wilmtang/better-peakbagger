/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The map viewport was 190 lines inside gpx-analyzer.js's single closure and
// had no coverage of its own. Extracted, its contract is testable directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mapViewport as MapViewport } from '../../src/gpx/map-viewport.ts';
import { waitFor } from '../helpers/fixture-page.mts';
import { pointerEvent } from '../helpers/pointer-event.mts';
import { rect } from '../helpers/page-types.mts';

const BOUNDS = { minWidth: 320, maxWidth: 1400, minHeight: 240, maxHeight: 720 };
const RESIZE_RAIL_HEIGHT = 16;
const RESIZE_TARGET_SIZE = 24;

interface PersistedSize { width: number; height: number; }
interface MapStub { invalidateCalls: number; invalidateSize(): void; }

const domHandle = { window: globalThis };
const makePointerEvent = (type: string, init: PointerEventInit = {}) =>
    pointerEvent(domHandle, type, init);
const nextAnimationFrames = () => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const setup = ({
    size = { width: 600, height: 400 },
    railHeight = RESIZE_RAIL_HEIGHT,
    targetSize = RESIZE_TARGET_SIZE,
    persistDelayMs = 400,
} = {}) => {
    const host = document.createElement('div');
    host.innerHTML = '<p><iframe></iframe></p>';
    document.body.append(host);
    const invalidated: boolean[] = [];
    const persists: PersistedSize[] = [];
    const map: MapStub = { invalidateCalls: 0, invalidateSize() { this.invalidateCalls++; } };
    const iframe = host.querySelector('iframe')!;
    Object.defineProperty(iframe, 'contentWindow', {
        configurable: true, value: { mapsPlaceholder: map },
    });
    const viewport = MapViewport.create({
        iframe,
        size,
        bounds: BOUNDS,
        railHeight,
        targetSize,
        persistDelayMs,
        onPersist: value => persists.push(value),
        onInvalidated: () => invalidated.push(true),
        ownerWindow: window,
    });
    const restore = () => {
        viewport.dispose();
        delete (iframe as unknown as { contentWindow?: unknown }).contentWindow;
        host.remove();
    };
    return { host, viewport, persists, invalidated, map, iframe, restore };
};

const emulateRenderedSize = (viewport: ReturnType<typeof MapViewport.create>, {
    width = 600,
    wrapperHeightCap = Number.POSITIVE_INFINITY,
} = {}) => {
    viewport.element!.getBoundingClientRect = () => rect({
        left: 0,
        right: width,
        width,
        height: Math.min(Number.parseFloat(viewport.element!.style.height), wrapperHeightCap),
    });
};

test('the viewport wraps the map frame and exposes a resize handle', () => {
    const { viewport, iframe, restore } = setup();
    try {
        assert.equal(viewport.element!.id, 'bpb-map-viewport');
        assert.equal(iframe.parentElement, viewport.element, 'the frame moves inside the wrapper');
        const handle = document.getElementById('bpb-map-resize-handle')!;
        assert.ok(handle, 'a resize affordance exists');
        assert.match(handle.getAttribute('aria-label')!, /Use arrow keys for small steps/,
            'the handle is reachable and described for keyboard users');
        assert.equal(handle.style.width, '24px');
        assert.equal(handle.style.height, '24px');
        assert.equal(handle.style.zIndex, '4', 'the overlapping target stays above both map renderers');
        assert.equal(handle.style.touchAction, 'none');
        assert.ok(handle.querySelector('.bpb-map-resize-grip'),
            'the visible affordance is separate from the interaction target');
        assert.equal(handle.textContent, '', 'the grip uses quiet lines rather than a filled glyph');
        assert.equal(iframe.style.height, 'calc(100% - 16px)',
            'fine pointers use a compact rail below the map controls');
        assert.equal(viewport.element!.style.width, '600px');
        assert.equal(viewport.element!.style.height, '416px', 'height includes only the compact rail');
        assert.equal(viewport.element!.style.getPropertyValue('--bpb-map-resize-rail-height'), '16px');
    } finally { restore(); }
});

test('a coarse-pointer configuration keeps a full touch target below the map', () => {
    const { viewport, iframe, restore } = setup({ railHeight: 44, targetSize: 44 });
    try {
        const handle = document.getElementById('bpb-map-resize-handle')!;
        assert.equal(handle.style.width, '44px');
        assert.equal(handle.style.height, '44px');
        assert.equal(iframe.style.height, 'calc(100% - 44px)');
        assert.equal(viewport.element!.style.height, '444px');
        assert.equal(viewport.element!.style.getPropertyValue('--bpb-map-resize-rail-height'), '44px');
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
    ['default preference in a short window', 450, 394, 378],
    ['maximum preference in a short window', BOUNDS.maxHeight, 584, 568],
    ['maximum preference in a tall window', BOUNDS.maxHeight, 1200, BOUNDS.maxHeight],
] as const) {
    test(`${name} reports measured map content, not the resize rail or hidden preference`, async () => {
        const { viewport, invalidated, restore } = setup({ size: { width: 600, height: preferredHeight } });
        try {
            emulateRenderedSize(viewport, { wrapperHeightCap });
            const before = invalidated.length;
            viewport.scheduleInvalidate();
            await waitFor(domHandle, () => invalidated.length > before);
            assert.equal(viewport.size.height, preferredHeight, 'the untouched preference is retained');
            assert.equal(viewport.effectiveSize.height, effectiveHeight);
            assert.match(document.getElementById('bpb-map-resize-handle')!
                .getAttribute('aria-label')!, new RegExp(`by ${effectiveHeight} pixels high`));
        } finally { restore(); }
    });
}

test('the first keyboard and pointer deltas start from visible short-window height', async () => {
    const { viewport, persists, invalidated, restore } = setup({
        size: { width: 600, height: BOUNDS.maxHeight },
        persistDelayMs: 30,
    });
    try {
        emulateRenderedSize(viewport, { wrapperHeightCap: 584 });
        const before = invalidated.length;
        viewport.scheduleInvalidate();
        await waitFor(domHandle, () => invalidated.length > before);
        const handle = document.getElementById('bpb-map-resize-handle')!;
        assert.equal(viewport.effectiveSize.height, 568);

        handle.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowUp', bubbles: true, cancelable: true,
        }));
        assert.equal(viewport.effectiveSize.height, 558,
            'the first key changes rendered map content by one step');
        assert.equal(viewport.size.height, 558,
            'direct interaction deliberately replaces the hidden preference');
        await waitFor(domHandle, () => persists.length >= 1);
        assert.deepEqual(persists, [{ width: 600, height: 558 }]);

        viewport.element!.parentElement!.getBoundingClientRect = () => rect({
            left: 0, right: 600, width: 600,
        });
        handle.dispatchEvent(makePointerEvent('pointerdown', {
            pointerId: 5, pointerType: 'touch', button: 0, clientX: 600, clientY: 530,
        }));
        handle.dispatchEvent(makePointerEvent('pointermove', {
            pointerId: 5, pointerType: 'touch', buttons: 1, clientX: 600, clientY: 529,
        }));
        assert.equal(viewport.effectiveSize.height, 557,
            'the first pointer pixel changes rendered map content by one pixel');
        handle.dispatchEvent(makePointerEvent('pointerup', {
            pointerId: 5, pointerType: 'touch', clientX: 600, clientY: 529,
        }));
        assert.deepEqual(persists.at(-1), { width: 600, height: 557 });
    } finally { restore(); }
});

test('window growth restores only an untouched preferred height', async () => {
    const { viewport, invalidated, restore } = setup({ size: { width: 600, height: BOUNDS.maxHeight } });
    try {
        let wrapperHeightCap = 584;
        viewport.element!.getBoundingClientRect = () => rect({
            left: 0,
            right: 600,
            width: 600,
            height: Math.min(Number.parseFloat(viewport.element!.style.height), wrapperHeightCap),
        });
        let before = invalidated.length;
        viewport.scheduleInvalidate();
        await waitFor(domHandle, () => invalidated.length > before);
        assert.equal(viewport.effectiveSize.height, 568);

        wrapperHeightCap = 1200;
        before = invalidated.length;
        window.dispatchEvent(new Event('resize'));
        await waitFor(domHandle, () => invalidated.length > before);
        assert.equal(viewport.effectiveSize.height, BOUNDS.maxHeight);
        assert.equal(viewport.size.height, BOUNDS.maxHeight,
            'window growth restores the untouched preference');

        wrapperHeightCap = 584;
        before = invalidated.length;
        window.dispatchEvent(new Event('resize'));
        await waitFor(domHandle, () => invalidated.length > before);
        const handle = document.getElementById('bpb-map-resize-handle')!;
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        assert.equal(viewport.size.height, 558);
        wrapperHeightCap = 1200;
        before = invalidated.length;
        window.dispatchEvent(new Event('resize'));
        await waitFor(domHandle, () => invalidated.length > before);
        assert.equal(viewport.effectiveSize.height, 558,
            'window growth does not resurrect a preference replaced by direct interaction');
    } finally { restore(); }
});

test('pointer resizing can use a wider layout boundary than the viewport column', () => {
    const host = document.createElement('div');
    host.innerHTML = '<main><section><iframe></iframe></section></main>';
    document.body.append(host);
    let viewport: ReturnType<typeof MapViewport.create> | null = null;
    try {
        const iframe = host.querySelector('iframe')!;
        const boundary = host.querySelector('main')!;
        viewport = MapViewport.create({
            iframe,
            size: { width: 450, height: 400 },
            bounds: BOUNDS,
            railHeight: RESIZE_RAIL_HEIGHT,
            persistDelayMs: 400,
            onPersist: () => {},
            getResizeBoundary: () => boundary,
            ownerWindow: window,
        });
        boundary.getBoundingClientRect = () => rect({ left: 0, right: 1000, width: 1000 });
        viewport.element!.getBoundingClientRect = () => rect({ left: 0, right: 450, width: 450 });
        const handle = document.getElementById('bpb-map-resize-handle')!;
        handle.dispatchEvent(makePointerEvent('pointerdown', {
            button: 0, clientX: 450, clientY: 400,
        }));
        handle.dispatchEvent(makePointerEvent('pointermove', {
            clientX: 650, clientY: 400,
        }));
        assert.equal(viewport.size.width, 650,
            'the shrink-wrapped map column must not cap growth at its current width');
    } finally {
        viewport?.dispose();
        host.remove();
    }
});

test('touch cancellation and capture loss commit the visible map size once', () => {
    const { viewport, persists, restore } = setup();
    try {
        const handle = document.getElementById('bpb-map-resize-handle')!;
        const boundary = viewport.element!.parentElement!;
        boundary.getBoundingClientRect = () => rect({ left: 0, right: 1000, width: 1000 });
        viewport.element!.getBoundingClientRect = () => rect({ left: 0, right: 600, width: 600 });
        const touch = { pointerId: 9, pointerType: 'touch' };
        handle.dispatchEvent(makePointerEvent('pointerdown', {
            ...touch, button: 0, clientX: 600, clientY: 400,
        }));
        const move = makePointerEvent('pointermove', {
            ...touch, buttons: 1, clientX: 700, clientY: 450,
        });
        handle.dispatchEvent(move);
        assert.equal(move.defaultPrevented, true, 'touch movement cannot scroll the page');
        handle.dispatchEvent(makePointerEvent('pointercancel', touch));
        handle.dispatchEvent(makePointerEvent('lostpointercapture', touch));
        handle.dispatchEvent(makePointerEvent('pointerup', touch));

        assert.deepEqual(viewport.size, { width: 700, height: 450 });
        assert.deepEqual(persists, [{ width: 700, height: 450 }],
            'duplicate terminal events cannot persist the gesture twice');
    } finally { restore(); }
});

test('a keyboard resize persists once after the last keystroke, not per repeat', async () => {
    // Persisting each key repeat would burn chrome.storage.sync's
    // write-per-minute quota and the final size could silently fail to stick.
    const { viewport, persists, restore } = setup({ persistDelayMs: 30 });
    try {
        const handle = document.getElementById('bpb-map-resize-handle')!;
        for (let i = 0; i < 6; i++) {
            handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        }
        assert.deepEqual(persists, [], 'no write while the key is still repeating');
        assert.equal(viewport.size.height, 460, 'but the size follows every step');

        await waitFor(domHandle, () => persists.length >= 1);
        assert.equal(persists.length, 1, 'exactly one write after the last keystroke');
        assert.deepEqual(persists[0], { width: 600, height: 460 });
    } finally { restore(); }
});

test('an unhandled key is left alone', () => {
    const { viewport, restore } = setup();
    try {
        const handle = document.getElementById('bpb-map-resize-handle')!;
        const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        handle.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, 'Tab must still move focus');
        assert.deepEqual(viewport.size, { width: 600, height: 400 });
    } finally { restore(); }
});

test('resizing tells Leaflet its container moved', async () => {
    const { viewport, map, invalidated, restore } = setup();
    try {
        viewport.applySize({ width: 700, height: 500 });
        await waitFor(domHandle, () => map.invalidateCalls >= 1 && invalidated.length >= 1);
        assert.ok(map.invalidateCalls >= 1, 'Leaflet is told to re-measure');
        assert.ok(invalidated.length >= 1, 'and the floating 3D toggle is re-anchored');
    } finally { restore(); }
});

test('resizing also invalidates a native map exposed through the map alias', async () => {
    const { viewport, iframe, map, restore } = setup();
    try {
        Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { map } });
        viewport.applySize({ width: 700, height: 500 });
        await waitFor(domHandle, () => map.invalidateCalls >= 1);
        assert.ok(map.invalidateCalls >= 1);
    } finally { restore(); }
});

test('a map frame Peakbagger has discarded does not break resizing', async () => {
    const { viewport, iframe, invalidated, restore } = setup();
    try {
        Object.defineProperty(iframe, 'contentWindow', {
            configurable: true,
            get() { throw new Error('frame discarded'); },
        });
        const before = invalidated.length;
        viewport.applySize({ width: 720, height: 520 });
        await waitFor(domHandle, () => invalidated.length > before);
        assert.deepEqual(viewport.size, { width: 720, height: 520 },
            'the viewport still resizes when its frame is gone');
    } finally { restore(); }
});

test('a replacement reuses one viewport and restores a still-connected old frame', async () => {
    const { viewport, iframe, restore } = setup();
    try {
        const replacementMap: MapStub = { invalidateCalls: 0, invalidateSize() { this.invalidateCalls++; } };
        const replacement = document.createElement('iframe');
        Object.defineProperty(replacement, 'contentWindow', {
            configurable: true, value: { mapsPlaceholder: replacementMap },
        });
        viewport.element!.parentElement!.append(replacement);

        const originalViewport = viewport.element!;
        viewport.attach(replacement);
        await waitFor(domHandle, () => replacementMap.invalidateCalls > 0);

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
    const viewport = MapViewport.create({
        iframe: null,
        size: { width: 600, height: 400 },
        bounds: BOUNDS,
        railHeight: RESIZE_RAIL_HEIGHT,
        persistDelayMs: 400,
        onPersist: () => { throw new Error('nothing to persist'); },
        ownerWindow: window,
    });
    try {
        assert.equal(viewport.element, null);
        viewport.applySize({ width: 700, height: 500 });
        viewport.scheduleInvalidate();
        assert.deepEqual(viewport.size, { width: 700, height: 500 });
    } finally {
        viewport.dispose();
    }
});

test('dispose releases the resize observer, window listener, and pending work', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<p><iframe></iframe></p>';
    document.body.append(host);
    const iframe = host.querySelector('iframe')!;
    let viewport: ReturnType<typeof MapViewport.create> | null = null;
    try {
        const map: MapStub = { invalidateCalls: 0, invalidateSize() { this.invalidateCalls++; } };
        Object.defineProperty(iframe, 'contentWindow', {
            configurable: true, value: { mapsPlaceholder: map },
        });
        let observed: Element | null = null;
        let disconnected = 0;
        let observerCallback: (() => void) | null = null;
        class Observer {
            constructor(callback: () => void) { observerCallback = callback; }
            observe(element: Element) { observed = element; }
            disconnect() { disconnected++; }
            unobserve() {}
        }
        const invalidated: boolean[] = [];
        viewport = MapViewport.create({
            iframe,
            size: { width: 600, height: 400 },
            bounds: BOUNDS,
            railHeight: RESIZE_RAIL_HEIGHT,
            persistDelayMs: 20,
            onPersist: () => {},
            onInvalidated: () => invalidated.push(true),
            ownerWindow: window,
            ResizeObserver: Observer as unknown as typeof ResizeObserver,
        });
        await waitFor(domHandle, () => invalidated.length >= 1);
        invalidated.length = 0;
        viewport.dispose();
        viewport.dispose();
        window.dispatchEvent(new Event('resize'));
        if (observed) (observerCallback as (() => void) | null)?.();
        await nextAnimationFrames();

        assert.equal(disconnected, 1);
        assert.deepEqual(invalidated, [], 'disposed viewport schedules no more Leaflet work');
    } finally {
        viewport?.dispose();
        delete (iframe as unknown as { contentWindow?: unknown }).contentWindow;
        host.remove();
    }
});
