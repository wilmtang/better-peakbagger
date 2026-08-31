// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    TERRAIN_COORDINATOR_LOAD_TIMEOUT_MS,
    terrainCoordinator as TerrainCoordinator,
} from '../../src/terrain/terrain-coordinator.js';
import { TERRAIN_FRAME_LOAD_TIMEOUT_MS } from '../../src/terrain/terrain-frame-runtime.js';

test('the outer terrain deadline leaves room for the renderer handoff', () => {
    assert.ok(TERRAIN_COORDINATOR_LOAD_TIMEOUT_MS >= TERRAIN_FRAME_LOAD_TIMEOUT_MS + 5000,
        'authorization, iframe startup, and both loaded relays need their own budget');
});

const setup = ({ enabled = true } = {}) => {
    const dom = new JSDOM('<!doctype html><button id="toggle"></button>');
    const toggle = dom.window.document.getElementById('toggle');
    const posted = [];
    const applied = [];
    const failures = [];
    const views = [];
    const acceptedViews = [];
    let featureEnabled = enabled;
    let hidden = false;
    let restored = 0;
    let consentRequests = 0;
    const map = {
        getCenter: () => ({ lat: 48.8, lng: -121.6 }),
        getZoom: () => 13,
        setView: (...args) => applied.push(args)
    };
    const compass = {
        element: dom.window.document.createElement('button'),
        setVisible: value => { compass.visible = value; },
        update: (...args) => views.push(args),
        visible: false
    };
    const coordinator = TerrainCoordinator.create({
        toggle,
        compass,
        isEnabled: () => featureEnabled,
        idleUi: () => ({ disabled: false, title: 'Open 3D', ariaLabel: 'Show 3D terrain' }),
        buildInit: () => ({ routeSegments: [[[48.8, -121.6], [48.81, -121.59]]] }),
        nativeMap: () => map,
        hideNativeMap: () => { hidden = true; },
        restoreNativeMap: () => { hidden = false; restored++; },
        post: (type, detail = {}) => posted.push({ type, ...detail }),
        requestConsent: () => { consentRequests++; },
        clearFailure: () => {},
        showFailure: reason => failures.push(reason),
        onView: bearing => acceptedViews.push(bearing),
        theme: () => 'dark',
        position: value => views.push(['position', value]),
        loadTimeoutMs: 1000,
        cameraTimeoutMs: 1000
    });
    coordinator.update();
    return {
        acceptedViews, applied, compass, coordinator, dom, failures, get hidden() { return hidden; },
        get consentRequests() { return consentRequests; }, map, posted,
        setEnabled: value => { featureEnabled = value; }, toggle, views,
        get restored() { return restored; }
    };
};

test('the shared coordinator owns loading, active, and camera-preserving stop transitions', () => {
    const fixture = setup();
    const { coordinator, toggle, posted, compass, applied } = fixture;
    assert.equal(toggle.textContent, '3D');
    assert.equal(toggle.dataset.theme, 'dark');

    toggle.click();
    assert.equal(coordinator.isOpen(), true);
    assert.equal(toggle.getAttribute('aria-busy'), 'true');
    assert.deepEqual(posted[0], {
        type: 'init',
        routeSegments: [[[48.8, -121.6], [48.81, -121.59]]],
        camera: { center: [48.8, -121.6], zoom: 12 }
    });

    assert.equal(coordinator.handleMessage({
        type: 'loaded', navTop: 87, camera: { center: [48.82, -121.58], zoom: 12.5 }
    }), true);
    assert.equal(coordinator.isActive(), true);
    assert.equal(fixture.hidden, true);
    assert.equal(compass.visible, true);
    assert.equal(toggle.textContent, '2D');

    coordinator.handleMessage({ type: 'view', bearing: 359, pitch: 42 });
    assert.deepEqual(fixture.views.at(-1), [359, 42]);
    assert.equal(fixture.acceptedViews.at(-1), 359);
    toggle.click();
    assert.equal(fixture.acceptedViews.at(-1), null, 'a pending return to 2D resets optional consumers');
    assert.equal(toggle.disabled, true);
    assert.deepEqual(posted.at(-1), { type: 'cameraRequest', requestId: 1 });
    coordinator.handleMessage({
        type: 'camera', requestId: 1, camera: { center: [48.83, -121.57], zoom: 13 }
    });

    assert.equal(coordinator.isIdle(), true);
    assert.equal(fixture.hidden, false);
    assert.deepEqual(applied, [[[48.83, -121.57], 14, { animate: false }]]);
    assert.equal(posted.at(-1).type, 'destroy');
    fixture.dom.window.close();
});

test('optional view consumers receive only normalized active finite bearings', () => {
    const fixture = setup();
    const { coordinator, acceptedViews } = fixture;
    coordinator.handleMessage({ type: 'view', bearing: 30, pitch: 20 });
    assert.deepEqual(acceptedViews, [], 'idle messages are stale and ignored');
    fixture.toggle.click();
    assert.deepEqual(acceptedViews, [null], 'loading remains north-up');
    coordinator.handleMessage({ type: 'view', bearing: 30, pitch: 20 });
    assert.deepEqual(acceptedViews, [null], 'loading messages are not authenticated as active');
    coordinator.handleMessage({ type: 'loaded' });
    coordinator.handleMessage({ type: 'view', bearing: 720 + 45, pitch: 40 });
    assert.equal(acceptedViews.at(-1), 45);
    coordinator.handleMessage({ type: 'view', bearing: Number.NaN, pitch: 40 });
    coordinator.handleMessage({ type: 'view', bearing: 90, pitch: Infinity });
    assert.equal(acceptedViews.at(-1), 45, 'invalid bearing or pitch cannot reach a consumer');
    coordinator.stop();
    const resets = acceptedViews.filter(value => value === null).length;
    coordinator.handleMessage({ type: 'view', bearing: 90, pitch: 40 });
    assert.equal(acceptedViews.filter(value => value === null).length, resets);
    assert.notEqual(acceptedViews.at(-1), 90, 'stop-pending views are ignored');
    coordinator.handleMessage({
        type: 'camera', requestId: 1, camera: { center: [48.8, -121.6], zoom: 12 },
    });
    fixture.dom.window.close();
});

test('loading is cancelable and active renderer errors restore the native map', () => {
    const fixture = setup();
    fixture.toggle.click();
    fixture.toggle.click();
    assert.equal(fixture.coordinator.isIdle(), true, 'a second click cancels loading immediately');
    assert.equal(fixture.posted.at(-1).type, 'destroy');

    fixture.toggle.click();
    fixture.coordinator.handleMessage({ type: 'loaded' });
    fixture.coordinator.handleMessage({ type: 'error', reason: 'renderer' });
    assert.equal(fixture.coordinator.isIdle(), true);
    assert.equal(fixture.hidden, false);
    assert.deepEqual(fixture.failures, ['renderer']);
    assert.equal(fixture.posted.at(-1).type, 'destroy');
    fixture.dom.window.close();
});

test('a native-map identity reset discards the stale terrain camera immediately', () => {
    const fixture = setup();
    fixture.toggle.click();
    fixture.coordinator.handleMessage({
        type: 'loaded',
        camera: { center: [48.9, -121.5], zoom: 13 }
    });

    fixture.coordinator.reset();

    assert.equal(fixture.coordinator.isIdle(), true);
    assert.equal(fixture.hidden, false);
    assert.deepEqual(fixture.applied, [],
        'a camera captured from the discarded map must not be applied to its replacement');
    assert.equal(fixture.posted.at(-1).type, 'destroy');
    assert.equal(fixture.toggle.textContent, '3D');
    fixture.dom.window.close();
});

test('Escape leaves 3D from the page and from the cross-origin frame', () => {
    const fixture = setup();
    const { coordinator, dom, toggle, posted } = fixture;
    const pressEscape = () => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
        dom.window.document.dispatchEvent(event);
        return event;
    };

    // Inert until 3D is open, so it never competes with the page's own Escape.
    const ignored = pressEscape();
    assert.equal(ignored.defaultPrevented, false);
    assert.equal(posted.length, 0);

    toggle.click();
    coordinator.handleMessage({ type: 'loaded', camera: { center: [48.82, -121.58], zoom: 12.5 } });
    assert.equal(toggle.getAttribute('aria-keyshortcuts'), 'Escape',
        'the shortcut is advertised exactly while it works');
    assert.match(toggle.title, /Esc/);

    const handled = pressEscape();
    assert.equal(handled.defaultPrevented, true);
    assert.deepEqual(posted.at(-1), { type: 'cameraRequest', requestId: 1 });
    coordinator.handleMessage({
        type: 'camera', requestId: 1, camera: { center: [48.83, -121.57], zoom: 13 }
    });
    assert.equal(coordinator.isIdle(), true);
    assert.equal(fixture.hidden, false);
    assert.equal(toggle.hasAttribute('aria-keyshortcuts'), false);

    // A key pressed inside the extension frame never reaches this document, so
    // the frame relays it as an exit request instead.
    toggle.click();
    assert.equal(coordinator.handleMessage({ type: 'exit' }), true);
    assert.equal(coordinator.isIdle(), true, 'exit also cancels a still-loading view');
    assert.equal(posted.at(-1).type, 'destroy');
    assert.equal(coordinator.handleMessage({ type: 'exit' }), false,
        'an exit request while 2D is showing is not the coordinator’s to act on');
    fixture.dom.window.close();
});

test('a modified Escape is left to the browser and the page', () => {
    const fixture = setup();
    fixture.toggle.click();
    fixture.coordinator.handleMessage({ type: 'loaded' });
    const event = new fixture.dom.window.KeyboardEvent('keydown', {
        key: 'Escape', shiftKey: true, cancelable: true, bubbles: true
    });
    fixture.dom.window.document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(fixture.coordinator.isActive(), true);
    fixture.dom.window.close();
});

test('the disabled feature delegates only idle activation to the consent owner', () => {
    const fixture = setup({ enabled: false });
    fixture.toggle.click();
    assert.equal(fixture.consentRequests, 1);
    assert.equal(fixture.posted.length, 0);
    assert.equal(fixture.coordinator.isIdle(), true);

    fixture.setEnabled(true);
    assert.equal(fixture.coordinator.start(), true);
    fixture.coordinator.stop();
    fixture.dom.window.close();
});
