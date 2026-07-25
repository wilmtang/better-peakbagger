// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the extension's route overlay on Peakbagger's MasterMap
// frame, and the remembered map-layer preference. Extracted from
// src/gpx/gpx-analyzer.js.
//
// Everything here reaches into a same-origin frame the extension does not own,
// so every path fails closed: if Peakbagger renames its globals, replaces the
// frame, or restricts access, the native map is left exactly as it was. Per
// AGENTS.md the overlay must not mutate Peakbagger's own layers and must stay
// behind its native route and markers.
//
// Runs in the page's MAIN world, so it takes its settings access, the shared
// route-style resolver, and the map-invalidate callback as dependencies rather
// than importing anything with extension-API reach.

export const createMapOverlay = ({
    findMapIframe,
    getSettings,
    setSettings,
    getRouteSegments,
    routeStyleFor,
    scheduleInvalidate,
    terrainBasemap,
    onFrameReload = () => {},
} = {}) => {
    let routeOverlay = null;
    let boundMapIframe = null;
    let boundMapLayerSelect = null;
    let mapLayerChangeHandler = null;

    const removeOverlayLayers = (map, layers) => {
        layers.forEach(layer => {
            try {
                if (map && typeof map.removeLayer === 'function') map.removeLayer(layer);
                else if (layer && typeof layer.remove === 'function') layer.remove();
            } catch (e) { /* Peakbagger may already have discarded the old map. */ }
        });
    };

    const removeRouteOverlay = () => {
        if (!routeOverlay) return;
        removeOverlayLayers(routeOverlay.map, routeOverlay.layers);
        routeOverlay = null;
    };

    const findMapLayerSelect = () => {
        try {
            const iframe = findMapIframe();
            const iframeWin = iframe && iframe.contentWindow;
            const select = iframeWin && iframeWin.document && iframeWin.document.getElementById('selmap');
            return select && select.tagName === 'SELECT' ? select : null;
        } catch (e) {
            return null;
        }
    };

    // Drape/basemap logic is shared with the Full Screen BigMap via
    // src/terrain/terrain-basemap.js (terrainBasemap) so the 2D layer
    // menu and the 3D drape picker cannot diverge. These wrappers only
    // resolve the Ascent page's MasterMap frame and delegate.
    const getTerrainBasemap = () => {
        const B = terrainBasemap;
        if (!B) return null;
        try {
            const iframe = findMapIframe();
            const iframeWin = iframe && iframe.contentWindow;
            const map = iframeWin && iframeWin.mapsPlaceholder;
            const select = iframeWin && iframeWin.document && iframeWin.document.getElementById('selmap');
            return B.active(iframeWin, map, select);
        } catch (error) { /* Peakbagger may replace or restrict its map frame. */ }
        return null;
    };

    const enumerateTerrainBasemaps = () => {
        const B = terrainBasemap;
        return B ? B.enumerate(findMapLayerSelect()) : [];
    };

    const mapLayerExists = (select, value) =>
        !!value && Array.from(select.options).some(option => option.value === value);

    const syncMapLayerPreference = () => {
        const select = findMapLayerSelect();
        if (!select) return false;

        if (select !== boundMapLayerSelect) {
            if (boundMapLayerSelect && mapLayerChangeHandler) {
                try { boundMapLayerSelect.removeEventListener('change', mapLayerChangeHandler); } catch (e) { /* old frame discarded */ }
            }
            boundMapLayerSelect = select;
            mapLayerChangeHandler = () => {
                const settings = getSettings();
                if (!settings.rememberMapLayer || !mapLayerExists(select, select.value) || settings.mapLastLayer === select.value) return;
                setSettings({ mapLastLayer: select.value });
            };
            select.addEventListener('change', mapLayerChangeHandler);
        }

        const settings = getSettings();
        if (!settings.rememberMapLayer) return true;

        if (mapLayerExists(select, settings.mapLastLayer)) {
            if (select.value !== settings.mapLastLayer) {
                select.value = settings.mapLastLayer;
                const iframeWin = select.ownerDocument && select.ownerDocument.defaultView;
                const ChangeEvent = iframeWin && iframeWin.Event ? iframeWin.Event : window.Event;
                select.dispatchEvent(new ChangeEvent('change', { bubbles: true }));
                scheduleInvalidate();
            }
        } else if (mapLayerExists(select, select.value)) {
            setSettings({ mapLastLayer: select.value });
        }
        return true;
    };

    const ensureRouteOverlay = () => {
        if (!getRouteSegments().length) return false;

        try {
            const iframe = findMapIframe();
            const iframeWin = iframe ? iframe.contentWindow : null;
            const map = iframeWin && iframeWin.mapsPlaceholder;
            const L = iframeWin && iframeWin.L;
            if (!map || !L || typeof L.polyline !== 'function') return false;

            if (routeOverlay && routeOverlay.map === map && routeOverlay.layers.every(layer => layer && layer._map === map)) {
                return true;
            }

            removeRouteOverlay();
            const layers = [];

            try {
                const segments = getRouteSegments();
                const routeGeometry = segments.length === 1 ? segments[0] : segments;
                const routeStyle = routeStyleFor(getSettings());
                const outline = L.polyline(routeGeometry, {
                    color: routeStyle.casingColor,
                    weight: routeStyle.casingWidth,
                    opacity: 0.92,
                    interactive: false,
                    lineCap: 'round',
                    lineJoin: 'round',
                    className: 'bpb-route-outline'
                }).addTo(map);
                layers.push(outline);
                const route = L.polyline(routeGeometry, {
                    color: routeStyle.color,
                    weight: routeStyle.width,
                    opacity: 1,
                    interactive: false,
                    lineCap: 'round',
                    lineJoin: 'round',
                    className: 'bpb-route-highlight'
                }).addTo(map);
                layers.push(route);

                // Keep native markers and Peakbagger's own thin route on
                // top. Calling these in reverse order preserves the white
                // casing beneath the red line in Leaflet's shared path pane.
                if (typeof route.bringToBack === 'function') route.bringToBack();
                if (typeof outline.bringToBack === 'function') outline.bringToBack();
            } catch (e) {
                removeOverlayLayers(map, layers);
                return false;
            }

            routeOverlay = { map, layers };
            return true;
        } catch (e) {
            // Same-origin access and Leaflet globals are Peakbagger-owned.
            // If either changes, retain the native map without disruption.
            return false;
        }
    };

    function handleMapIframeLoad() {
        onFrameReload();
        removeRouteOverlay();
        scheduleRouteOverlay();
        scheduleMapLayerSync();
    }

    const bindMapIframeLoad = () => {
        const iframe = findMapIframe();
        if (iframe && iframe !== boundMapIframe) {
            if (boundMapIframe) boundMapIframe.removeEventListener('load', handleMapIframeLoad);
            boundMapIframe = iframe;
            boundMapIframe.addEventListener('load', handleMapIframeLoad);
        }
    };

    // Both of these used to retry exactly 20 times at 250 ms and then stop.
    // On a slow load that budget expired before Peakbagger's map frame was
    // usable, so the route overlay never appeared and the remembered map
    // layer was never applied — with no error, no retry, and no signal that
    // a feature silently did not run. AGENTS.md makes this argument about
    // test fixtures ("gate on the condition, never on a fixed sleep"); it
    // applies at least as strongly here.
    //
    // So: gate on the condition. A MutationObserver reacts to Peakbagger
    // swapping the frame in whenever that happens, the frame's own load
    // handler covers reloads, and the interval is a backstop rather than
    // the mechanism. The ceiling exists only so a page that will never
    // satisfy the condition cannot leave an observer attached forever, and
    // it says so in the log rather than expiring in silence.
    const CONDITION_RETRY_MS = 250;
    const CONDITION_CEILING_MS = 30000;

    const createConditionRetry = (label, attempt) => {
        let timer = null;
        let observer = null;
        let deadline = 0;

        const stop = () => {
            if (timer) { clearInterval(timer); timer = null; }
            if (observer) { observer.disconnect(); observer = null; }
        };

        const satisfied = () => {
            let done;
            try {
                // Rebind first: a frame swapped in late is a new element.
                bindMapIframeLoad();
                done = attempt();
            } catch (e) {
                // A torn-down document throws from these DOM reads. There
                // is nothing left to satisfy, so stop rather than raise
                // once per mutation on a page that is going away.
                done = true;
            }
            if (done) stop();
            return done;
        };

        const start = () => {
            if (satisfied()) return;
            deadline = Date.now() + CONDITION_CEILING_MS;
            if (!timer) {
                timer = setInterval(() => {
                    if (satisfied()) return;
                    if (Date.now() < deadline) return;
                    stop();
                    console.warn(`Better Peakbagger: gave up waiting for ${label}`);
                }, CONDITION_RETRY_MS);
            }
            if (!observer && typeof MutationObserver === 'function' && document.body) {
                observer = new MutationObserver(() => { satisfied(); });
                observer.observe(document.body, { childList: true, subtree: true });
            }
        };

        return { start, stop };
    };

    const mapLayerRetry = createConditionRetry(
        'the Peakbagger map frame’s layer picker', syncMapLayerPreference);
    const routeOverlayRetry = createConditionRetry(
        'the Peakbagger map frame to accept the route overlay', ensureRouteOverlay);

    function scheduleMapLayerSync() {
        mapLayerRetry.start();
    }

    function scheduleRouteOverlay() {
        if (!getRouteSegments().length) {
            bindMapIframeLoad();
            return;
        }
        routeOverlayRetry.start();
    }

    return {
        removeRouteOverlay,
        scheduleRouteOverlay,
        scheduleMapLayerSync,
        // The chart's hover handler re-asserts the overlay before drawing its
        // marker, so a frame that reloaded mid-hover still shows the route.
        ensureRouteOverlay,
        getTerrainBasemap,
        enumerateTerrainBasemaps,
    };
};

export const mapOverlay = { create: createMapOverlay };
