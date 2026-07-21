// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { terrainCoordinator as TerrainCoordinator } from '../src/terrain-coordinator.js';

const setup = ({ enabled = true } = {}) => {
    const dom = new JSDOM('<!doctype html><button id="toggle"></button>');
    const toggle = dom.window.document.getElementById('toggle');
    const posted = [];
    const applied = [];
    const failures = [];
    const views = [];
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
        theme: () => 'dark',
        position: value => views.push(['position', value]),
        loadTimeoutMs: 1000,
        cameraTimeoutMs: 1000
    });
    coordinator.update();
    return {
        applied, compass, coordinator, dom, failures, get hidden() { return hidden; },
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
    toggle.click();
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
