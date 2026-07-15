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

    const createFrame = data => {
        if (frame) return;
        const viewport = document.getElementById('bpb-map-viewport');
        const nativeMap = viewport && viewport.querySelector('iframe[src*="MasterMap.aspx" i]');
        if (!viewport || !nativeMap || !globalThis.chrome?.runtime?.getURL) {
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
            routeStyle: data.routeStyle,
            theme: data.theme,
            basemap: data.basemap,
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
            postToPage('loaded');
        } else if (data.type === 'error') {
            fail(data.reason);
        }
    });
})();
