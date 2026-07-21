// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub, waitFor } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The Peak page loads the isolated settings-bridge bundle and the MAIN-world
// coordinator bundle. Evaluate both, as the browser does.
const bridgeBundle = await readFile(path.join(root, 'dist', 'content', 'peak-map-bridge.js'), 'utf8');
const peakMapBundle = await readFile(path.join(root, 'dist', 'content', 'peak-map.js'), 'utf8');

const peakHtml = ({ mapPid = 2829, mapType = 'P', includeCoordinates = true,
    fullMapOrigin = 'https://www.peakbagger.com' } = {}) => `<!doctype html><body>
  <h1>Mount Shuksan, Washington</h1>
  <table><tbody><tr><td align="center">
    <b>Dynamic Map</b><br>
    <iframe id="Gmap"
      src="https://www.peakbagger.com/map/MasterMap.aspx?cy=48.83115&amp;cx=-121.60214&amp;z=14&amp;t=${mapType}&amp;d=${mapPid}&amp;c=0"
      width="100%" height="425px"></iframe><br>
    <img src="https://www.peakbagger.com/image/MainPeakPinkCircle.gif">&nbsp;Mount Shuksan&nbsp;(Unclimbed!)<br>
    <a href="${fullMapOrigin}/map/BigMap.aspx?${includeCoordinates ? 'cy=48.83115&amp;cx=-121.60214&amp;' : ''}z=14&amp;l=L_CT|L_OT&amp;t=${mapType}&amp;d=${mapPid}&amp;c=0">Click Here for a Full Screen Map</a>
  </td></tr></tbody></table>
</body>`;

const loadPeakMap = ({ enabled = true, mapPid = 2829, mapType = 'P',
    includeCoordinates = true, fullMapOrigin = 'https://www.peakbagger.com' } = {}) => {
    const dom = new JSDOM(peakHtml({ mapPid, mapType, includeCoordinates, fullMapOrigin }), {
        url: 'https://www.peakbagger.com/Peak.aspx?pid=2829',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const messages = [];
    window.chrome = makeChromeStub({ bpbSettings: {
        enable3dMap: enabled,
        theme: 'dark',
        terrainCacheLimitMb: 384
    } });
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const postMessage = message => {
        messages.push(structuredClone(message));
        window.queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', {
            source: window,
            origin: window.location.origin,
            data: message
        })));
    };
    window.postMessage = postMessage;
    window.eval(bridgeBundle);
    window.eval(peakMapBundle);
    return { dom, window, messages };
};

test('Peak pages wrap the Dynamic Map with a 3D toggle and open a validated summit-focused view', async () => {
    const { dom, window, messages } = loadPeakMap();
    const iframe = window.document.getElementById('Gmap');
    const mount = window.document.getElementById('bpb-map-viewport');
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    const setViewCalls = [];
    iframe.contentWindow.mapsPlaceholder = {
        eachLayer() {},
        on() {},
        getCenter() { return { lat: 48.84, lng: -121.59 }; },
        getZoom() { return 15; },
        setView(center, zoom, options) {
            setViewCalls.push({ center: [...center], zoom, options: { ...options } });
        }
    };

    assert.ok(mount);
    assert.equal(mount.className, 'bpb-terrain-mount-peak');
    assert.equal(mount.style.height, '425px', 'the wrapper preserves Peakbagger\'s map height');
    assert.equal(iframe.parentElement, mount, 'the native iframe stays intact inside the terrain mount');
    assert.equal(toggle.textContent, '3D');
    assert.equal(toggle.getAttribute('aria-label'), 'Show 3D terrain');

    await waitFor(dom, () => toggle.dataset.theme === 'dark');
    const settingsReply = messages.find(message => message.__bpbPeakMap === true && message.dir === 'toPage');
    assert.deepEqual(Object.keys(settingsReply).sort(),
        ['__bpbPeakMap', 'dir', 'enable3dMap', 'terrainCacheLimitMb', 'theme'],
        'the Peak-page bridge exposes only the three read-only terrain settings');

    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));
    const init = messages.find(message => message.__bpbTerrain === true && message.type === 'init');
    assert.deepEqual(init.focus, [48.83115, -121.60214]);
    assert.equal(init.focusZoom, 13, 'Leaflet z14 is translated to the equivalent MapLibre z13 view');
    assert.deepEqual(init.camera, { center: [48.84, -121.59], zoom: 14 },
        'the live Dynamic Map camera takes precedence over its original URL focus');
    assert.deepEqual(init.focusPeak, {
        id: 2829,
        name: 'Mount Shuksan',
        lat: 48.83115,
        lon: -121.60214,
        state: 'unclimbed'
    });
    assert.equal(init.theme, 'dark');
    assert.equal(init.cacheLimitMb, 384);
    // The coordinator forwards the drape basemaps enumerated from the native
    // layer select; this fixture models no such select, so the list is empty.
    // terrain-basemap.test.mjs covers enumerate()'s code→drape mapping.
    assert.ok(Array.isArray(init.basemaps));
    assert.equal('routeSegments' in init, false, 'Peak pages do not invent a fake GPX route');

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'loaded', navTop: 88 }
    }));
    assert.equal(iframe.style.visibility, 'hidden');
    assert.equal(iframe.getAttribute('aria-hidden'), 'true');
    assert.equal(toggle.textContent, '2D');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true,
            dir: 'toPage',
            type: 'camera',
            camera: { center: [48.9, -121.7], zoom: 12.5 }
        }
    }));
    toggle.click();
    assert.equal(messages.at(-1).type, 'cameraRequest');
    const cameraRequestId = messages.at(-1).requestId;
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
            __bpbTerrain: true,
            dir: 'toPage',
            type: 'camera',
            requestId: cameraRequestId,
            camera: { center: [48.9, -121.7], zoom: 12.5 }
        }
    }));
    assert.deepEqual(setViewCalls, [{
        center: [48.9, -121.7],
        zoom: 13.5,
        options: { animate: false }
    }], 'the settled terrain camera is applied before the Dynamic Map is revealed');
    assert.equal(iframe.style.visibility, 'visible');
    assert.equal(iframe.hasAttribute('aria-hidden'), false);
    assert.equal(toggle.textContent, '3D');
    assert.ok(messages.some(message => message.__bpbTerrain === true && message.type === 'destroy'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Peak-page 3D loading can be canceled and renderer failures are announced', async () => {
    const { dom, window, messages } = loadPeakMap();
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    await waitFor(dom, () => toggle.dataset.theme === 'dark');

    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute('aria-label'), 'Cancel loading 3D terrain');
    toggle.click();
    assert.equal(messages.at(-1).type, 'destroy');
    assert.equal(toggle.textContent, '3D');

    toggle.click();
    await waitFor(dom, () => messages.filter(message => message.__bpbTerrain === true && message.type === 'init').length === 2);
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'error', reason: 'unavailable' }
    }));
    const failure = window.document.getElementById('bpb-terrain-failure');
    assert.equal(failure.getAttribute('role'), 'status');
    assert.equal(failure.getAttribute('aria-live'), 'polite');
    assert.equal(failure.hidden, false);
    assert.match(failure.textContent, /unavailable for this map/);
    assert.doesNotMatch(failure.textContent, /unavailable in this browser/);
    assert.equal(toggle.textContent, '3D');
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('hovering the idle 3D toggle prefetches the peak DEM tiles once per window', async () => {
    const { dom, window, messages } = loadPeakMap();
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    // The dark theme landing proves the settings message (and terrainEnabled)
    // has been applied.
    await waitFor(dom, () => toggle.dataset.theme === 'dark');

    const prefetches = () => messages.filter(message => message.__bpbTerrain === true && message.type === 'prefetch');
    assert.equal(prefetches().length, 0, 'no prefetch merely because the page loaded');

    toggle.dispatchEvent(new window.Event('pointerenter'));
    assert.equal(prefetches().length, 1, 'hover warms the cache exactly once');
    const prefetch = prefetches()[0];
    assert.equal(prefetch.dir, 'toCS');
    assert.deepEqual(prefetch.center, [48.83115, -121.60214], 'the validated peak coordinate seeds the prefetch');
    assert.equal(prefetch.zoom, 13, 'the summit MapLibre zoom seeds the prefetch');
    assert.ok(Number.isFinite(prefetch.viewport.width) && prefetch.viewport.width > 0);
    assert.ok(Number.isFinite(prefetch.viewport.height) && prefetch.viewport.height > 0);

    // A second hover inside the throttle window posts nothing more.
    toggle.dispatchEvent(new window.Event('focus'));
    toggle.dispatchEvent(new window.Event('pointerenter'));
    assert.equal(prefetches().length, 1, 'the 15 s throttle suppresses a second hover');
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Peak-page 3D shows a compass that tracks the view and resets north', async () => {
    const { dom, window, messages } = loadPeakMap();
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    const iframe = window.document.getElementById('Gmap');
    iframe.contentWindow.mapsPlaceholder = {
        eachLayer() {}, on() {},
        getCenter() { return { lat: 48.84, lng: -121.59 }; },
        getZoom() { return 15; }, setView() {}
    };
    const compass = window.document.getElementById('bpb-terrain-compass');
    const disc = compass.querySelector('.bpb-map-compass-disc');
    assert.ok(compass, 'the compass button exists next to the toggle');
    assert.equal(compass.parentElement.id, 'bpb-map-viewport');
    assert.equal(compass.title, 'Reset to north');
    assert.equal(compass.hidden, true, 'hidden until 3D is active');

    await waitFor(dom, () => toggle.dataset.theme === 'dark');
    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));

    const dispatchPage = data => window.dispatchEvent(new window.MessageEvent('message', {
        source: window, origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', ...data }
    }));
    dispatchPage({ type: 'loaded', navTop: 88 });
    assert.equal(compass.hidden, false, 'the compass shows once 3D is active');
    assert.equal(compass.dataset.theme, 'dark');

    // Bearing normalizes across full turns; pitch is passed through in range.
    dispatchPage({ type: 'view', bearing: 720 + 45, pitch: 40 });
    assert.equal(disc.style.transform, 'rotateX(40deg) rotateZ(-45deg)');
    dispatchPage({ type: 'view', bearing: 350, pitch: 40 });
    const beforeNorth = Number(/rotateZ\((-?[\d.]+)deg\)/.exec(disc.style.transform)[1]);
    dispatchPage({ type: 'view', bearing: 10, pitch: 40 });
    const afterNorth = Number(/rotateZ\((-?[\d.]+)deg\)/.exec(disc.style.transform)[1]);
    assert.ok(Math.abs(afterNorth - beforeNorth) < 180,
        'crossing north advances the transformed needle along the short arc');
    // A non-finite value is ignored — the disc keeps its last transform.
    dispatchPage({ type: 'view', bearing: NaN, pitch: 10 });
    assert.equal(disc.style.transform, `rotateX(40deg) rotateZ(${afterNorth}deg)`);

    compass.click();
    assert.equal(messages.at(-1).type, 'resetNorth');
    assert.equal(messages.at(-1).dir, 'toCS');

    toggle.click(); // request the return to 2D
    assert.equal(compass.hidden, true, 'hidden again once a stop is pending');
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Peak-page 3D uses the extension-owned consent gate when the feature is off', async () => {
    const { dom, window, messages } = loadPeakMap({ enabled: false });
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    await waitFor(dom, () => messages.some(message => message.__bpbPeakMap === true && message.dir === 'toPage'));

    toggle.click();
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'requestConsent'));
    assert.equal(messages.some(message => message.__bpbTerrain === true && message.type === 'init'), false,
        'the page cannot start third-party tile requests before consent');

    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'consentResult', enabled: true }
    }));
    await waitFor(dom, () => messages.some(message => message.__bpbTerrain === true && message.type === 'init'));
    window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __bpbTerrain: true, dir: 'toPage', type: 'loaded' }
    }));
    toggle.click();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Peak-page 3D fails closed when the Dynamic Map does not identify the same subject peak', async () => {
    for (const options of [
        { mapPid: 999 },
        { mapType: 'G' },
        { includeCoordinates: false },
        { fullMapOrigin: 'https://maps.example.test' }
    ]) {
        const { dom, window } = loadPeakMap(options);
        assert.equal(window.document.getElementById('bpb-terrain-toggle'), null);
        assert.equal(window.document.getElementById('Gmap').parentElement.id, '',
            'an ambiguous map stays entirely native');
        await new Promise(resolve => window.setTimeout(resolve, 0));
        dom.window.close();
    }
});
