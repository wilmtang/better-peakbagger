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
    let terrainTheme = 'system';
    let settingsRevision = 0;
    let consentElement = null;
    let consentKeyHandler = null;
    let consentReturnFocus = null;

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
        terrainTheme = settings && typeof settings.theme === 'string' ? settings.theme : 'system';
        if (!terrainEnabled && frame) fail('unavailable');
    };

    const dismissConsent = () => {
        if (!consentElement) return;
        document.removeEventListener('keydown', consentKeyHandler, true);
        consentElement.remove();
        consentElement = null;
        consentKeyHandler = null;
        const returnFocus = consentReturnFocus;
        consentReturnFocus = null;
        if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
    };

    const finishConsent = enabled => {
        dismissConsent();
        postToPage('consentResult', { enabled: enabled === true });
    };

    const createTextElement = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        element.textContent = text;
        return element;
    };

    const showConsent = () => {
        if (consentElement) {
            consentElement.querySelector('.bpb-terrain-consent-primary')?.focus();
            return;
        }

        const backdrop = document.createElement('div');
        backdrop.id = 'bpb-terrain-consent';
        backdrop.className = 'bpb-terrain-consent-backdrop';
        backdrop.dataset.theme = globalThis.BPBSettings?.resolveTheme
            ? globalThis.BPBSettings.resolveTheme(terrainTheme)
            : 'light';

        const dialog = document.createElement('section');
        dialog.className = 'bpb-terrain-consent-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'bpb-terrain-consent-title');
        dialog.setAttribute('aria-describedby', 'bpb-terrain-consent-summary bpb-terrain-consent-later');

        const eyebrow = createTextElement('p', 'bpb-terrain-consent-eyebrow', 'Experimental feature');
        const title = createTextElement('h2', '', 'Turn on 3D maps?');
        title.id = 'bpb-terrain-consent-title';
        const summary = createTextElement('p', '',
            'Better Peakbagger will request map tiles for the area you view. Tile coordinates and standard request metadata are sent to third-party, open-source services:');
        summary.id = 'bpb-terrain-consent-summary';

        const providerList = document.createElement('ul');
        providerList.className = 'bpb-terrain-consent-providers';
        const addProvider = (name, detail, href) => {
            const item = document.createElement('li');
            const copy = document.createElement('span');
            const providerName = createTextElement('strong', '', name);
            const providerDetail = createTextElement('span', '', detail);
            copy.append(providerName, providerDetail);
            const link = createTextElement('a', '', 'Privacy notice');
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.setAttribute('aria-label', `${name} privacy notice`);
            item.append(copy, link);
            providerList.append(item);
        };
        addProvider('Mapterhorn', 'Elevation tiles', 'https://mapterhorn.com/privacy-policy/');
        addProvider('OpenFreeMap', 'OSM vector tiles, when selected', 'https://openfreemap.org/privacy/');

        const selectedProvider = createTextElement('p', 'bpb-terrain-consent-detail',
            'Your selected 2D map layer may also be requested from the provider named in the layer menu.');
        const later = createTextElement('p', 'bpb-terrain-consent-later',
            'Choose Not now to keep 3D maps off. You can enable them later in Better Peakbagger Settings.');
        later.id = 'bpb-terrain-consent-later';
        const error = createTextElement('p', 'bpb-terrain-consent-error', '');
        error.setAttribute('role', 'status');
        error.setAttribute('aria-live', 'polite');

        const actions = document.createElement('div');
        actions.className = 'bpb-terrain-consent-actions';
        const cancel = createTextElement('button', 'bpb-terrain-consent-secondary', 'Not now');
        cancel.type = 'button';
        const enable = createTextElement('button', 'bpb-terrain-consent-primary', 'Enable and open 3D');
        enable.type = 'button';
        actions.append(cancel, enable);

        dialog.append(eyebrow, title, summary, providerList, selectedProvider, later, error, actions);
        backdrop.append(dialog);
        consentElement = backdrop;
        consentReturnFocus = document.getElementById('bpb-terrain-toggle');

        const cancelConsent = () => finishConsent(false);
        cancel.addEventListener('click', cancelConsent);
        enable.addEventListener('click', async event => {
            // Isolated-world handlers are private, but their DOM nodes are
            // shared with the host page. Require real user activation so page
            // script cannot call button.click() to flip an extension feature
            // gate without consent.
            if (!event.isTrusted) return;
            enable.disabled = true;
            cancel.disabled = true;
            enable.textContent = 'Enabling…';
            error.textContent = '';
            try {
                if (!globalThis.BPBSettings) throw new Error('Settings are unavailable');
                const next = await globalThis.BPBSettings.set({ enable3dMap: true });
                if (!next || next.enable3dMap !== true) throw new Error('Setting was not saved');
                applySettings(next);
                finishConsent(true);
            } catch (exception) {
                enable.disabled = false;
                cancel.disabled = false;
                enable.textContent = 'Try again';
                error.textContent = '3D maps could not be enabled. Try again or use Better Peakbagger Settings.';
                enable.focus();
            }
        });

        consentKeyHandler = event => {
            if (!consentElement) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                cancelConsent();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(dialog.querySelectorAll('a[href], button:not(:disabled)'));
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', consentKeyHandler, true);
        document.body.append(backdrop);
        enable.focus();
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
        // The MAIN-world coordinator (ascent GPX analyzer, Full Screen BigMap,
        // or a Peak page) owns the map viewport element and only sends 'init'
        // once it has a validated route or summit focus to draw, so the bridge
        // just needs the shared mount to exist.
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
            focus: data.focus,
            focusZoom: data.focusZoom,
            focusPeak: data.focusPeak,
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
            if (data.type === 'requestConsent') {
                void settingsReady.then(() => {
                    if (terrainEnabled) postToPage('consentResult', { enabled: true });
                    else showConsent();
                });
            } else if (data.type === 'init') createFrame(data);
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
