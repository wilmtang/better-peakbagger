// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error jsdom ships no declarations in this repository.
import { JSDOM } from 'jsdom';
import { installMapLayers } from '../../src/maps/map-layers.ts';

type OwnerWindow = NonNullable<Parameters<typeof installMapLayers>[0]>;
function setup() {
    const dom = new JSDOM('<main id="layout"><div id="map"></div></main>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1', pretendToBeVisual: true,
    });
    const win = dom.window as OwnerWindow, observers = new Set<LayoutObserver>();
    class LayoutObserver implements ResizeObserver {
        targets = new Set<Element>();
        readonly callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.add(this); }
        observe(target: Element) { this.targets.add(target); }
        unobserve(target: Element) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); observers.delete(this); }
    }
    Object.defineProperty(win, 'ResizeObserver', { value: LayoutObserver, configurable: true });
    const container = win.document.getElementById('map')!, layout = win.document.getElementById('layout')!;
    let documentTop = 40, requests = 0;
    container.getBoundingClientRect = () => new win.DOMRect(20, documentTop - win.scrollY, 500, 200);
    const events = new Map<string, Set<(event?: unknown) => void>>();
    const map = {
        getContainer: () => container,
        getBounds: () => ({ getWest: () => -122, getEast: () => -121, getSouth: () => 46, getNorth: () => 47 }),
        getCenter: () => ({ lat: 46.85, lng: -121.75 }), getZoom: () => 14,
        getSize: () => ({ x: 500, y: 200 }), eachLayer() {}, removeLayer() {},
        on(type: string, listener: (event?: unknown) => void) { if (!events.has(type)) events.set(type, new Set()); events.get(type)!.add(listener); },
        off(type: string, listener: (event?: unknown) => void) { events.get(type)?.delete(listener); },
    };
    Object.defineProperty(win, 'L', { value: { GridLayer: { extend: () => class {} }, marker: () => ({}) }, configurable: true });
    win.fetch = async () => { requests++; throw new Error('Layout must not fetch provider data'); };
    win.postMessage = () => {};
    const owner = installMapLayers(win, { fixedMap: map })!;
    win.dispatchEvent(new win.MessageEvent('message', { source: win, origin: win.location.origin,
        data: { __bpbMapLayers: true, dir: 'toPage', type: 'preferences', snotel: false } }));
    return { win, owner, control: win.document.querySelector<HTMLElement>('.bpb-map-layers')!,
        requests: () => requests,
        moveMap(top: number) {
            documentTop = top;
            // Preceding content expanded. The map keeps exactly the same size,
            // so only its layout ancestor produces a ResizeObserver entry.
            for (const observer of observers) if (observer.targets.has(layout)) observer.callback([], observer);
        },
        close() { owner.dispose(); assert.equal(observers.size, 0); win.close(); },
    };
}

test('native overlay controls follow same-size map movement after preceding content expands', () => {
    const env = setup();
    try {
        assert.equal(env.control.hidden, false);
        assert.equal(env.control.style.top, '50px');
        env.moveMap(240);
        assert.equal(env.control.style.top, '250px', 'the Overlays button must follow the map instead of covering preceding content');
        assert.equal(env.requests(), 0);
    } finally { env.close(); }
});

test('native overlay controls disappear when layout moves the same-size map below the viewport', () => {
    const env = setup();
    try {
        assert.equal(env.control.hidden, false);
        env.moveMap(1200);
        assert.equal(env.control.hidden, true, 'an offscreen map must not leave its Overlays button on another card');
        assert.equal(env.requests(), 0);
    } finally { env.close(); }
});
