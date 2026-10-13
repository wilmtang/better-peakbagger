// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeChromeStub, waitFor } from '../helpers/load-page.mjs';
import { pointerEvent } from '../helpers/pointer-event.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
    showSunMoon = true,
    storedSize = null, storageBlocked = false, coarsePointer = false,
    includeCoordinates = true, fullMapOrigin = 'https://www.peakbagger.com',
    nowMs = Date.parse('2026-08-25T18:45:00Z') } = {}) => {
    const dom = new JSDOM(peakHtml({ mapPid, mapType, includeCoordinates, fullMapOrigin }), {
        url: 'https://www.peakbagger.com/Peak.aspx?pid=2829',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    if (storedSize !== null) window.localStorage.setItem('pbPeakMapViewport.v1', storedSize);
    if (storageBlocked) Object.defineProperty(window, 'localStorage', {
        get() { throw new window.DOMException('Storage blocked', 'SecurityError'); },
    });
    window.Date.now = () => nowMs;
    const messages = [];
    window.chrome = makeChromeStub({ bpbSettings: {
        enable3dMap: enabled,
        showSunMoon,
        theme: 'dark',
        terrainCacheLimitMb: 384
    } });
    window.matchMedia = query => ({ matches: coarsePointer && query === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} });
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

test('native map right-click projects the live point only with a visible weather card and survives frame reloads', async () => {
    const { window, messages } = loadPeakMap();
    try {
        const frame = window.document.getElementById('Gmap'), doc = frame.contentDocument;
        doc.open(); doc.write('<!doctype html><html><body></body></html>'); doc.close();
        frame.dispatchEvent(new window.Event('load'));
        frame.getBoundingClientRect = () => ({ left: 200, top: 100 });
        frame.contentWindow.mapsPlaceholder = { on() {}, eachLayer() {}, mouseEventToLatLng: () => ({ lat: 46.8, lng: 238.3 }) };
        const card = window.document.createElement('section'); card.id = 'bpb-peak-weather'; window.document.body.append(card);
        const rightClick = () => {
            const event = new window.MouseEvent('contextmenu', { clientX: 20, clientY: 30, bubbles: true, cancelable: true });
            doc.body.dispatchEvent(event); return event;
        };
        assert.equal(rightClick().defaultPrevented, true);
        const context = messages.filter(message => message.__bpbPeakWeather && message.type === 'context').at(-1);
        assert.equal(context.latitude, 46.8); assert.ok(Math.abs(context.longitude + 121.7) < 1e-8);
        assert.equal(context.x, 220); assert.equal(context.y, 130);
        const wheel = new window.WheelEvent('wheel', { bubbles: true, cancelable: true });
        doc.body.dispatchEvent(wheel);
        assert.equal(wheel.defaultPrevented, false); assert.equal(messages.at(-1).type, 'dismiss');
        doc.dispatchEvent(new window.Event('scroll')); assert.equal(messages.at(-1).type, 'dismiss');
        card.hidden = true; assert.equal(rightClick().defaultPrevented, false);
        card.hidden = false;
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(rightClick().defaultPrevented, false);
        const suspendedCount = messages.length; doc.body.dispatchEvent(wheel); assert.equal(messages.length, suspendedCount);
        window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
        frame.dispatchEvent(new window.Event('load')); frame.dispatchEvent(new window.Event('load'));
        const count = messages.filter(message => message.type === 'context').length;
        rightClick(); assert.equal(messages.filter(message => message.type === 'context').length, count + 1);
    } finally { window.dispatchEvent(new window.PageTransitionEvent('pagehide')); window.close(); }
});

test('Sun display opt-out updates live independently of terrain, including BFCache', async () => {
    const { dom, window } = loadPeakMap({ showSunMoon: false, enabled: false });
    try {
        const sun = window.document.querySelector('.bpb-sun-calculator');
        await waitFor(dom, () => sun.dataset.theme === 'dark');
        assert.equal(sun.hidden, true);
        const iframe = window.document.getElementById('Gmap');
        await window.chrome.storage.sync.set({ bpbSettings: { showSunMoon: true, enable3dMap: false } });
        await waitFor(dom, () => sun.hidden === false);
        await window.chrome.storage.sync.set({ bpbSettings: { showSunMoon: false } });
        await waitFor(dom, () => sun.hidden === true);
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
        await waitFor(dom, () => sun.hidden === true);
        assert.equal(window.document.querySelectorAll('.bpb-sun-calculator').length, 1);
        assert.equal(window.document.getElementById('Gmap'), iframe);
    } finally { window.dispatchEvent(new window.PageTransitionEvent('pagehide')); window.close(); }
});

test('Peak pages wrap the Dynamic Map with a 3D toggle and open a validated summit-focused view', async () => {
    const { dom, window, messages } = loadPeakMap();
    const iframe = window.document.getElementById('Gmap');
    const mount = window.document.getElementById('bpb-map-viewport');
    const toggle = window.document.getElementById('bpb-terrain-toggle');
    const sun = window.document.querySelector('.bpb-sun-calculator');
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
    assert.equal(mount.style.height, '441px', 'the wrapper adds a 16px resize rail below the native 425px map');
    assert.equal(iframe.style.height, 'calc(100% - 16px)');
    assert.equal(iframe.parentElement, mount, 'the native iframe stays intact inside the terrain mount');
    assert.equal(toggle.textContent, '3D');
    assert.equal(toggle.getAttribute('aria-label'), 'Show 3D terrain');
    assert.ok(sun, 'a calculator is created from the same validated summit subject');
    assert.equal(iframe.closest('td').lastElementChild, sun,
        'the calculator follows the complete native map legend and full-screen link');
    assert.equal(sun.previousElementSibling.textContent.trim(), 'Click Here for a Full Screen Map');
    assert.equal(sun.querySelector('.bpb-sun-calculator__panel').hidden, false,
        'Peak-page Sun & Moon opens automatically below the map');
    assert.equal(sun.querySelector('.bpb-sun-calculator__toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(sun.querySelector('input[type="date"]').value, '2026-08-25');
    assert.equal(sun.querySelector('input[type="range"]').value, String(11 * 60 + 45),
        'the initial clock is current time at the summit, not the viewer');
    assert.match(sun.textContent, /PDT/);

    const sunDate = sun.querySelector('input[type="date"]');
    const sunTime = sun.querySelector('input[type="range"]');
    sunTime.value = String(9 * 60 + 20);
    sunTime.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(dom, () => sunTime.value === String(9 * 60 + 20)
        && /9:20\s*AM PDT/i.test(sunTime.getAttribute('aria-valuetext') || ''));
    sunDate.value = '2026-11-01';
    sunDate.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(sunTime.value, String(9 * 60 + 20), 'changing date preserves the chosen clock time');
    assert.equal(setViewCalls.length, 0, 'solar controls never move the native map');

    await waitFor(dom, () => toggle.dataset.theme === 'dark');
    assert.equal(sun.dataset.theme, 'dark');
    const settingsReply = messages.find(message => message.__bpbPeakMap === true && message.dir === 'toPage');
    assert.deepEqual(Object.keys(settingsReply).sort(),
        ['__bpbPeakMap', 'dir', 'enable3dMap', 'showSunMoon', 'terrainCacheLimitMb', 'theme'],
        'the Peak-page bridge exposes only the read-only terrain and Sun display settings');

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
    window.dispatchEvent(new window.PageTransitionEvent('pagehide'));
    assert.equal(window.document.querySelector('.bpb-sun-calculator'), null,
        'page teardown disposes the calculator');
    dom.window.close();
});

test('Peak map survives repeated persisted traversal and adopts a replaced native frame', async () => {
    const { dom, window, messages } = loadPeakMap();
    await waitFor(dom, () => window.document.getElementById('bpb-terrain-toggle')?.dataset.theme === 'dark');
    const mount = window.document.getElementById('bpb-map-viewport');
    const calculator = window.document.querySelector('.bpb-sun-calculator');
    const original = window.document.getElementById('Gmap');
    const settingsGets = () => messages.filter(message =>
        message.__bpbPeakMap === true && message.dir === 'toCS' && message.type === 'get').length;
    const settingsReplies = () => messages.filter(message =>
        message.__bpbPeakMap === true && message.dir === 'toPage').length;
    const initialGets = settingsGets();
    const initialReplies = settingsReplies();

    window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
    const replacement = window.document.createElement('iframe');
    replacement.id = 'Gmap';
    replacement.src = original.src;
    original.replaceWith(replacement);
    window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(dom, () => replacement.parentElement === mount
        && settingsGets() === initialGets + 1 && settingsReplies() === initialReplies + 1);
    window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(dom, () => settingsGets() === initialGets + 2
        && settingsReplies() === initialReplies + 2);

    assert.equal(calculator.isConnected, true);
    assert.equal(window.document.querySelectorAll('#bpb-terrain-toggle').length, 1);
    assert.equal(window.document.querySelectorAll('.bpb-sun-calculator').length, 1);
    assert.equal(window.document.querySelectorAll('#bpb-map-resize-handle').length, 1);
    assert.equal(replacement.style.height, 'calc(100% - 16px)');
    window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }));
    assert.equal(calculator.isConnected, false);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    dom.window.close();
});

test('Peak map resize supports keyboard, centered pointer drags, persistence, and reset without moving the camera', async () => {
    const { dom, window } = loadPeakMap({ enabled: false });
    try {
        const mount = window.document.getElementById('bpb-map-viewport');
        const iframe = window.document.getElementById('Gmap');
        const handle = window.document.getElementById('bpb-map-resize-handle');
        let invalidations = 0;
        let cameraChanges = 0;
        const syncBefore = await window.chrome.storage.sync.get(null);
        iframe.contentWindow.map = {
            eachLayer() {}, on() {}, getCenter: () => ({ lat: 48.83115, lng: -121.60214 }), getZoom: () => 14,
            invalidateSize(animate) { assert.equal(animate, false); invalidations++; },
            setView() { cameraChanges++; },
        };
        assert.equal(handle.type, 'button');
        assert.match(handle.getAttribute('aria-label'), /Resize map.*425 pixels high/);
        mount.parentElement.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000 });
        mount.getBoundingClientRect = () => {
            const width = parseFloat(mount.style.width);
            return { left: (1000 - width) / 2, right: (1000 + width) / 2, width, height: parseFloat(mount.style.height) };
        };
        handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
        assert.equal(mount.style.height, '491px');
        assert.equal(window.localStorage.getItem('pbPeakMapViewport.v1'), null, 'key repeats do not persist each step');
        handle.dispatchEvent(pointerEvent(dom, 'pointerdown', { pointerId: 1, button: 0, clientX: 725, clientY: 491 }));
        handle.dispatchEvent(pointerEvent(dom, 'pointermove', { pointerId: 1, clientX: 745, clientY: 511 }));
        assert.equal(mount.style.width, '490px', 'centered sizing keeps the edge under the pointer');
        assert.equal(mount.style.height, '511px');
        handle.dispatchEvent(pointerEvent(dom, 'pointerup', { pointerId: 1 }));
        assert.deepEqual(JSON.parse(window.localStorage.getItem('pbPeakMapViewport.v1')), { width: 490, height: 495 });
        await waitFor(dom, () => invalidations > 0);
        handle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        assert.equal(mount.style.width, '450px');
        assert.equal(mount.style.height, '441px');
        assert.equal(window.localStorage.getItem('pbPeakMapViewport.v1'), null);
        assert.deepEqual(await window.chrome.storage.sync.get(null), syncBefore, 'Peak sizing does not change GPX sync settings');
        assert.equal(cameraChanges, 0);
    } finally { window.dispatchEvent(new window.PageTransitionEvent('pagehide')); window.close(); }
});

for (const [name, storedSize, width, height] of [
    ['saved', '{"width":640,"height":360}', '640px', '376px'],
    ['bounded', '{"width":99999,"height":1}', '4096px', '256px'],
    ['malformed', 'not json', '450px', '441px'],
    ['wrong types', '{"width":"640","height":360}', '450px', '441px'],
]) {
    test(`Peak map restores ${name} page-local sizing before asynchronous settings`, async () => {
        const { dom, window } = loadPeakMap({ storedSize });
        try {
            const mount = window.document.getElementById('bpb-map-viewport');
            assert.equal(mount.style.width, width);
            assert.equal(mount.style.height, height);
            await waitFor(dom, () => window.document.getElementById('bpb-terrain-toggle').dataset.theme === 'dark');
            assert.equal(mount.style.width, width);
            assert.equal(mount.style.height, height, 'the settings reply cannot replace the chosen size');
        } finally { window.dispatchEvent(new window.PageTransitionEvent('pagehide')); window.close(); }
    });
}

test('Peak map remains resizable with blocked storage and reserves a touch target for coarse pointers', () => {
    const { window } = loadPeakMap({ storageBlocked: true, coarsePointer: true });
    try {
        const mount = window.document.getElementById('bpb-map-viewport');
        const handle = window.document.getElementById('bpb-map-resize-handle');
        assert.equal(handle.style.height, '44px');
        assert.equal(mount.style.height, '469px');
        handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        assert.equal(mount.style.height, '459px');
        handle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        assert.equal(mount.style.height, '469px');
    } finally { window.dispatchEvent(new window.PageTransitionEvent('pagehide')); window.close(); }
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
    const solar = window.document.querySelector('.bpb-sun-calculator');
    const solarNorth = solar.querySelector('[data-azimuth="0"]');
    const solarSummary = solar.querySelector('.bpb-sun-calculator__summary');
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
    const absoluteSummary = solarSummary.textContent;
    await waitFor(dom, () => /rotate\(-45deg\)/.test(solarNorth.style.transform));
    assert.equal(solarSummary.textContent, absoluteSummary,
        'absolute azimuth and elevation text do not change with map bearing');
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
    await waitFor(dom, () => /rotate\(0deg\)/.test(solarNorth.style.transform));
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
        assert.equal(window.document.querySelector('.bpb-sun-calculator'), null,
            'an ambiguous map must not expose an unverified solar coordinate');
        assert.equal(window.document.getElementById('Gmap').parentElement.id, '',
            'an ambiguous map stays entirely native');
        await new Promise(resolve => window.setTimeout(resolve, 0));
        dom.window.close();
    }
});
