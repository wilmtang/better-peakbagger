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

    toggle.click();
    assert.equal(iframe.style.visibility, 'visible');
    assert.equal(iframe.hasAttribute('aria-hidden'), false);
    assert.equal(toggle.textContent, '3D');
    assert.ok(messages.some(message => message.__bpbTerrain === true && message.type === 'destroy'));
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
