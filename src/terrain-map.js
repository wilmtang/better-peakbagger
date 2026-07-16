// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — isolated-world bridge for the extension-owned terrain
// frame. MapLibre and its worker run in terrain/terrain.html, where they have a
// real extension origin instead of a browser-specific content-script sandbox.

(() => {
    'use strict';

    const PAGE_MESSAGE_TAG = '__bpbTerrain';
    const FRAME_MESSAGE_TAG = '__bpbTerrainFrame';
    const ALLOWED_FAILURES = new Set(['frame', 'maplibre', 'renderer', 'timeout', 'unavailable']);

    let frame = null;
    let pendingInit = null;
    let terrainEnabled = false;
    let settingsRevision = 0;

    const postToPage = (type, detail = {}) => window.postMessage({
        [PAGE_MESSAGE_TAG]: true,
        dir: 'toPage',
        type,
        ...detail
    }, location.origin);

    const removeFrame = () => {
        if (!frame) return;
        frame.remove();
        frame = null;
        pendingInit = null;
    };

    const postToFrame = (type, detail = {}) => {
        if (!frame || !frame.contentWindow) return;
        frame.contentWindow.postMessage({
            [FRAME_MESSAGE_TAG]: true,
            dir: 'toFrame',
            type,
            ...detail
        }, '*');
    };

    const fail = reason => {
        removeFrame();
        postToPage('error', { reason: ALLOWED_FAILURES.has(reason) ? reason : 'renderer' });
    };

    const applySettings = settings => {
        terrainEnabled = settings && settings.enable3dMap === true;
        if (!terrainEnabled && frame) fail('unavailable');
    };

    const initialSettingsRevision = settingsRevision;
    const settingsReady = globalThis.BPBSettings
        ? globalThis.BPBSettings.get().then(settings => {
            // A storage push can beat the initial async read. Never let that
            // stale read override the newer feature-gate value.
            if (settingsRevision === initialSettingsRevision) applySettings(settings);
        }, () => {
            if (settingsRevision === initialSettingsRevision) terrainEnabled = false;
        })
        : Promise.resolve();

    if (globalThis.BPBSettings) globalThis.BPBSettings.subscribe(settings => {
        settingsRevision++;
        applySettings(settings);
    });

    const createFrame = async data => {
        await settingsReady;
        if (frame) return;
        if (!terrainEnabled) {
            fail('unavailable');
            return;
        }
        // The MAIN-world coordinator (ascent GPX analyzer or Full Screen BigMap)
        // owns the map viewport element and only sends 'init' once it has a real
        // route to draw, so the bridge just needs the shared mount to exist.
        const viewport = document.getElementById('bpb-map-viewport');
        if (!viewport || !globalThis.chrome?.runtime?.getURL) {
            fail('unavailable');
            return;
        }

        const terrainFrame = document.createElement('iframe');
        terrainFrame.id = 'bpb-terrain-frame';
        terrainFrame.title = 'Interactive 3D terrain map';
        terrainFrame.setAttribute('aria-label', 'Interactive 3D terrain map');
        terrainFrame.addEventListener('error', () => {
            if (frame === terrainFrame) fail('frame');
        }, { once: true });
        pendingInit = {
            routeSegments: data.routeSegments,
            routeColors: data.routeColors,
            routeStyle: data.routeStyle,
            theme: data.theme,
            basemap: data.basemap,
            basemaps: data.basemaps,
            cacheLimitMb: data.cacheLimitMb
        };
        terrainFrame.src = chrome.runtime.getURL('terrain/terrain.html');
        frame = terrainFrame;
        viewport.append(terrainFrame);
    };

    window.addEventListener('message', event => {
        const data = event.data;

        if (event.source === window && event.origin === location.origin
            && data && data[PAGE_MESSAGE_TAG] === true && data.dir === 'toCS') {
            if (data.type === 'init') createFrame(data);
            else if (data.type === 'destroy') {
                postToFrame('destroy');
                removeFrame();
                postToPage('destroyed');
            } else if (data.type === 'highlight') {
                postToFrame('highlight', { coordinates: data.coordinates });
            } else if (data.type === 'peaks') {
                postToFrame('peaks', { requestId: data.requestId, peaks: data.peaks, unavailable: data.unavailable });
            } else if (data.type === 'update') {
                if (pendingInit) {
                    pendingInit.routeStyle = data.routeStyle;
                    pendingInit.theme = data.theme;
                }
                postToFrame('update', { routeStyle: data.routeStyle, theme: data.theme });
            }
            return;
        }

        if (!frame || event.source !== frame.contentWindow
            || !data || data[FRAME_MESSAGE_TAG] !== true || data.dir !== 'toParent') return;

        if (data.type === 'ready') {
            if (pendingInit) postToFrame('init', pendingInit);
        } else if (data.type === 'loaded') {
            pendingInit = null;
            frame.style.opacity = '1';
            frame.style.pointerEvents = 'auto';
            postToPage('loaded', { navTop: data.navTop });
        } else if (data.type === 'metrics') {
            postToPage('metrics', { navTop: data.navTop });
        } else if (data.type === 'peaksRequest') {
            postToPage('peaksRequest', { requestId: data.requestId, bounds: data.bounds });
        } else if (data.type === 'error') {
            fail(data.reason);
        }
    });
})();
