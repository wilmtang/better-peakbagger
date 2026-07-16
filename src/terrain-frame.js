// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — MapLibre renderer hosted by terrain/terrain.html.

(() => {
    'use strict';

    const FRAME_MESSAGE_TAG = '__bpbTerrainFrame';
    const TERRAIN_TILE_TEMPLATE = 'bpb-dem://{z}/{x}/{y}.webp';
    const MAX_ROUTE_POINTS = 3000;
    const MAX_ROUTE_SEGMENTS = 1500;
    const MAX_MERCATOR_LAT = 85.0511287;
    const MAX_BASEMAP_URL_LENGTH = 2048;
    const MAX_BASEMAP_ATTRIBUTION_LENGTH = 600;
    const TERRAIN_EXAGGERATION = 1;
    const MAP_LOAD_TIMEOUT_MS = 15000;
    const PEAKBAGGER_ORIGIN = /^https?:\/\/(?:www\.)?peakbagger\.com(?::\d+)?$/i;
    const PALETTES = {
        light: {
            background: '#d9ded2',
            relief: ['#607f75', '#7f9879', '#a8ad82', '#b6a47f', '#9c8875', '#cac5b8', '#f2f0ea'],
            hillShadow: '#312d26',
            hillHighlight: '#ffffff',
            hillAccent: '#6d6657'
        },
        dark: {
            background: '#252a27',
            relief: ['#263a38', '#35493b', '#555946', '#665b49', '#65564b', '#77746d', '#a7a59f'],
            hillShadow: '#080b0a',
            hillHighlight: '#c9c6bc',
            hillAccent: '#111512'
        }
    };

    let map = null;
    let mapElement = null;
    let resizeObserver = null;
    let loadTimer = null;
    let loaded = false;
    let parentOrigin = null;
    let activeTheme = 'light';
    let activeBasemap = null;
    let availableBasemaps = [];
    let activeBasemapIndex = -1;
    const failedBasemaps = new Set();
    let basemapErrored = false;
    let basemapContentLoaded = false;
    let basemapChecked = false;
    let pickerElement = null;
    let noticeElement = null;
    let terrainCache = null;
    let terrainProtocolRegistered = false;
    let activeRouteStyle = { color: '#d9483b', width: 5, casingColor: '#ffffff', casingWidth: 9 };

    const post = (type, detail = {}) => {
        if (!parentOrigin) return;
        window.parent.postMessage({
            [FRAME_MESSAGE_TAG]: true,
            dir: 'toParent',
            type,
            ...detail
        }, parentOrigin);
    };

    // Distance from the frame's bottom edge to the top of the bottom-right zoom
    // stack, so the host page can float its 2D/3D toggle just above it — this
    // frame is cross-origin, so the page cannot measure the stack itself.
    const measureNavTop = () => {
        const group = mapElement && mapElement.querySelector('.maplibregl-ctrl-bottom-right .maplibregl-ctrl-group');
        if (!group) return 0;
        return Math.max(0, Math.round(window.innerHeight - group.getBoundingClientRect().top));
    };

    const removeLoadTimer = () => {
        if (loadTimer !== null) {
            clearTimeout(loadTimer);
            loadTimer = null;
        }
    };

    const removeTerrain = () => {
        removeLoadTimer();
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        if (map) {
            try { map.remove(); } catch (error) { /* The frame may already be unloading. */ }
            map = null;
        }
        if (terrainProtocolRegistered && globalThis.maplibregl && typeof globalThis.maplibregl.removeProtocol === 'function') {
            try { globalThis.maplibregl.removeProtocol(globalThis.BPBTerrainCache.PROTOCOL); } catch (error) { /* The frame may already be unloading. */ }
        }
        if (terrainCache) void terrainCache.flush();
        terrainCache = null;
        terrainProtocolRegistered = false;
        if (mapElement) {
            mapElement.remove();
            mapElement = null;
        }
        activeBasemap = null;
        availableBasemaps = [];
        activeBasemapIndex = -1;
        failedBasemaps.clear();
        basemapErrored = false;
        basemapContentLoaded = false;
        basemapChecked = false;
        pickerElement = null;
        noticeElement = null;
        loaded = false;
    };

    const fail = reason => {
        removeTerrain();
        post('error', { reason });
    };

    const validateRoute = segments => {
        if (!Array.isArray(segments) || !segments.length || segments.length > MAX_ROUTE_SEGMENTS) return null;

        let pointCount = 0;
        let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
        const coordinates = [];

        for (const segment of segments) {
            if (!Array.isArray(segment) || segment.length < 2) return null;
            const converted = [];
            for (const point of segment) {
                if (!Array.isArray(point) || point.length !== 2) return null;
                const [lat, lon] = point;
                if (!Number.isFinite(lat) || !Number.isFinite(lon)
                    || Math.abs(lat) > MAX_MERCATOR_LAT || Math.abs(lon) > 180) return null;

                converted.push([lon, lat]);
                minLat = Math.min(minLat, lat);
                minLon = Math.min(minLon, lon);
                maxLat = Math.max(maxLat, lat);
                maxLon = Math.max(maxLon, lon);
                pointCount++;
                if (pointCount > MAX_ROUTE_POINTS) return null;
            }
            coordinates.push(converted);
        }

        if (maxLon - minLon >= 180) return null;

        return {
            geojson: {
                type: 'Feature',
                properties: {},
                geometry: { type: 'MultiLineString', coordinates }
            },
            bounds: [[minLon, minLat], [maxLon, maxLat]]
        };
    };

    const validateStyle = style => {
        const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
        const integer = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
        const width = integer(style && style.width, 1, 12, 5);
        return {
            color: color(style && style.color) ? style.color : '#d9483b',
            width,
            casingColor: color(style && style.casingColor) ? style.casingColor : '#ffffff',
            casingWidth: Math.max(integer(style && style.casingWidth, 3, 20, 9), width + 2)
        };
    };

    const isPublicHostname = hostname => {
        const host = hostname.toLowerCase();
        if (!host || host === 'localhost' || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
        if (['.localhost', '.local', '.internal', '.test', '.invalid'].some(suffix => host.endsWith(suffix))) return false;
        return host.includes('.');
    };

    const validateRemoteUrl = (value, allowTemplate = false) => {
        if (typeof value !== 'string' || !value || value.length > MAX_BASEMAP_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
        if (allowTemplate && !/^https?:\/\//i.test(value)) return null;

        let parsed;
        try { parsed = new URL(value, parentOrigin || undefined); } catch (error) { return null; }
        if (parsed.username || parsed.password || parsed.hash) return null;

        const samePeakbaggerOrigin = parsed.origin === parentOrigin;
        if (parsed.protocol !== 'https:' && !samePeakbaggerOrigin) return null;
        if (!samePeakbaggerOrigin && (!isPublicHostname(parsed.hostname) || (parsed.port && parsed.port !== '443'))) return null;

        if (allowTemplate) {
            const tokens = Array.from(value.matchAll(/\{([^{}]+)\}/g), match => match[1]);
            if (!['z', 'x', 'y'].every(token => tokens.includes(token))
                || tokens.some(token => !['z', 'x', 'y'].includes(token))) return null;
        }
        return allowTemplate ? value : parsed.href;
    };

    const escapeHtml = value => value.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);

    const sanitizeAttribution = value => {
        if (typeof value !== 'string' || value.length > MAX_BASEMAP_ATTRIBUTION_LENGTH) return '';
        const parsed = new DOMParser().parseFromString(value, 'text/html');

        const serialize = node => {
            if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent || '');
            if (node.nodeType === Node.ELEMENT_NODE && ['SCRIPT', 'STYLE'].includes(node.tagName)) return '';
            const children = Array.from(node.childNodes || [], serialize).join('');
            if (node.nodeType !== Node.ELEMENT_NODE || node.tagName !== 'A') return children;
            const href = validateRemoteUrl(node.getAttribute('href'));
            return href
                ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${children}</a>`
                : children;
        };

        return Array.from(parsed.body.childNodes, serialize).join('').trim();
    };

    const validateBasemap = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        const tileUrl = Array.isArray(value.tiles) && value.tiles.length === 1
            ? validateRemoteUrl(value.tiles[0], true)
            : null;
        if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || !tileUrl) return null;

        const integer = (candidate, min, max, fallback) =>
            Number.isInteger(candidate) && candidate >= min && candidate <= max ? candidate : fallback;
        const minzoom = integer(value.minzoom, 0, 22, 0);
        const maxzoom = integer(value.maxzoom, minzoom, 24, Math.max(minzoom, 19));
        return {
            name,
            tiles: [tileUrl],
            tileSize: value.tileSize === 512 ? 512 : 256,
            minzoom,
            maxzoom,
            scheme: value.scheme === 'tms' ? 'tms' : 'xyz',
            attribution: sanitizeAttribution(value.attribution)
        };
    };

    const reliefExpression = palette => [
        'interpolate', ['linear'], ['elevation'],
        -100, palette.relief[0],
        0, palette.relief[1],
        750, palette.relief[2],
        1500, palette.relief[3],
        2500, palette.relief[4],
        3500, palette.relief[5],
        5000, palette.relief[6]
    ];

    const terrainStyle = (theme, basemap) => {
        const palette = PALETTES[theme];
        const sources = {
            terrain: {
                type: 'raster-dem',
                tiles: [TERRAIN_TILE_TEMPLATE],
                encoding: 'terrarium',
                tileSize: 512,
                minzoom: 0,
                maxzoom: 18,
                attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener noreferrer">© Mapterhorn</a>'
            }
        };
        const layers = [
            { id: 'terrain-background', type: 'background', paint: { 'background-color': palette.background } },
            {
                id: 'terrain-relief', type: 'color-relief', source: 'terrain',
                paint: { 'color-relief-color': reliefExpression(palette), 'color-relief-opacity': 1 }
            }
        ];

        if (basemap) {
            sources.basemap = {
                type: 'raster',
                tiles: basemap.tiles,
                tileSize: basemap.tileSize,
                minzoom: basemap.minzoom,
                maxzoom: basemap.maxzoom,
                scheme: basemap.scheme,
                attribution: basemap.attribution
            };
            layers.push({
                id: 'basemap', type: 'raster', source: 'basemap',
                paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }
            });
        }

        layers.push({
            id: 'terrain-hillshade', type: 'hillshade', source: 'terrain',
            paint: {
                'hillshade-exaggeration': 0.48,
                'hillshade-shadow-color': palette.hillShadow,
                'hillshade-highlight-color': palette.hillHighlight,
                'hillshade-accent-color': palette.hillAccent
            }
        });

        return {
            version: 8,
            name: 'Better Peakbagger terrain',
            sources,
            layers,
            terrain: { source: 'terrain', exaggeration: TERRAIN_EXAGGERATION }
        };
    };

    const renderPicker = () => {
        if (!pickerElement) return;
        const options = availableBasemaps.map((basemap, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = failedBasemaps.has(index)
                ? `${basemap.name || `Layer ${index + 1}`} (unavailable)`
                : (basemap.name || `Layer ${index + 1}`);
            option.disabled = failedBasemaps.has(index);
            return option;
        });
        const terrainOption = document.createElement('option');
        terrainOption.value = 'terrain';
        terrainOption.textContent = 'Terrain only';
        pickerElement.replaceChildren(...options, terrainOption);
        pickerElement.value = activeBasemapIndex >= 0 ? String(activeBasemapIndex) : 'terrain';
    };

    const showNotice = text => {
        if (!noticeElement) return;
        noticeElement.textContent = text;
        noticeElement.hidden = !text;
    };

    const addBasemapLayer = basemap => {
        map.addSource('basemap', {
            type: 'raster',
            tiles: basemap.tiles,
            tileSize: basemap.tileSize,
            minzoom: basemap.minzoom,
            maxzoom: basemap.maxzoom,
            scheme: basemap.scheme,
            attribution: basemap.attribution
        });
        // Keep the drape beneath the hillshade so relief still reads through it.
        map.addLayer({
            id: 'basemap', type: 'raster', source: 'basemap',
            paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }
        }, typeof map.getLayer === 'function' && map.getLayer('terrain-hillshade') ? 'terrain-hillshade' : undefined);
    };

    const removeBasemapLayer = () => {
        try {
            if (typeof map.getLayer === 'function' && map.getLayer('basemap')) map.removeLayer('basemap');
            if (map.getSource('basemap') && typeof map.removeSource === 'function') map.removeSource('basemap');
        } catch (error) { /* A failed raster source may already be absent. */ }
    };

    // Switch the draped layer live. index < 0 selects terrain-only. Each swap
    // re-arms the one-shot CORS check so the new layer is judged on its own.
    const swapBasemap = index => {
        if (!map || !loaded) return;
        removeBasemapLayer();
        basemapErrored = false;
        basemapContentLoaded = false;
        basemapChecked = false;
        activeBasemapIndex = index >= 0 && index < availableBasemaps.length && !failedBasemaps.has(index) ? index : -1;
        activeBasemap = activeBasemapIndex >= 0 ? availableBasemaps[activeBasemapIndex] : null;
        if (activeBasemap) addBasemapLayer(activeBasemap);
        renderPicker();
    };

    // A whole layer blocked by CORS renders no tile. Disable it in the picker,
    // remember it for the session, revert to terrain-only, and say why.
    const markBasemapFailed = index => {
        const name = index >= 0 && index < availableBasemaps.length ? availableBasemaps[index].name : '';
        if (index >= 0) failedBasemaps.add(index);
        swapBasemap(-1);
        showNotice(`${name || 'That map layer'} can’t be draped here — the map provider blocks cross-origin tiles. Showing terrain only.`);
    };

    const setRoutePaint = routeStyle => {
        const style = validateStyle(routeStyle);
        activeRouteStyle = style;
        if (!map || !loaded) return;
        map.setPaintProperty('bpb-route-casing', 'line-color', style.casingColor);
        map.setPaintProperty('bpb-route-casing', 'line-width', style.casingWidth);
        map.setPaintProperty('bpb-route', 'line-color', style.color);
        map.setPaintProperty('bpb-route', 'line-width', style.width);
    };

    const setTheme = theme => {
        const nextTheme = theme === 'dark' ? 'dark' : 'light';
        activeTheme = nextTheme;
        if (mapElement) mapElement.dataset.theme = nextTheme;
        if (!map || !loaded) return;

        const palette = PALETTES[nextTheme];
        map.setPaintProperty('terrain-background', 'background-color', palette.background);
        map.setPaintProperty('terrain-relief', 'color-relief-color', reliefExpression(palette));
        map.setPaintProperty('terrain-hillshade', 'hillshade-shadow-color', palette.hillShadow);
        map.setPaintProperty('terrain-hillshade', 'hillshade-highlight-color', palette.hillHighlight);
        map.setPaintProperty('terrain-hillshade', 'hillshade-accent-color', palette.hillAccent);
    };

    const setHighlight = coordinates => {
        if (!map || !loaded) return;
        const source = map.getSource('bpb-highlight');
        if (!source || typeof source.setData !== 'function') return;
        const valid = Array.isArray(coordinates) && coordinates.length === 2
            && Number.isFinite(coordinates[0]) && Math.abs(coordinates[0]) <= 180
            && Number.isFinite(coordinates[1]) && Math.abs(coordinates[1]) <= MAX_MERCATOR_LAT;
        source.setData(valid ? {
            type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates }
        } : { type: 'FeatureCollection', features: [] });
    };

    const createTerrain = data => {
        if (map || mapElement) return;
        const route = validateRoute(data.routeSegments);
        const maplibre = globalThis.maplibregl;
        const cacheLimitMb = Number.isInteger(data.cacheLimitMb) && data.cacheLimitMb >= 0 && data.cacheLimitMb <= 2048
            ? data.cacheLimitMb
            : 256;
        if (!route || !maplibre || !globalThis.BPBTerrainCache || !globalThis.chrome?.runtime?.getURL) {
            fail('unavailable');
            return;
        }

        activeRouteStyle = validateStyle(data.routeStyle);
        activeTheme = data.theme === 'dark' ? 'dark' : 'light';

        // Build the switchable drape list from the layers the page offered,
        // deduped by tile template, with the initially-selected layer as the
        // active one (falling back to the first available, then terrain-only).
        const initialBasemap = validateBasemap(data.basemap);
        const offered = Array.isArray(data.basemaps) ? data.basemaps : [];
        availableBasemaps = [];
        const seenTiles = new Set();
        // Keep the native control's order; append the initial layer only if the
        // offered list somehow omitted it.
        for (const candidate of [...offered.map(validateBasemap), initialBasemap]) {
            if (!candidate) continue;
            const key = candidate.tiles[0];
            if (seenTiles.has(key)) continue;
            seenTiles.add(key);
            availableBasemaps.push(candidate);
        }
        activeBasemapIndex = initialBasemap
            ? availableBasemaps.findIndex(basemap => basemap.tiles[0] === initialBasemap.tiles[0])
            : -1;
        activeBasemap = activeBasemapIndex >= 0 ? availableBasemaps[activeBasemapIndex] : null;
        failedBasemaps.clear();
        basemapErrored = false;
        basemapContentLoaded = false;
        basemapChecked = false;

        mapElement = document.createElement('div');
        mapElement.id = 'bpb-terrain-map';
        mapElement.dataset.theme = activeTheme;
        mapElement.setAttribute('role', 'region');
        mapElement.setAttribute('aria-label', 'Interactive 3D terrain map');

        const canvas = document.createElement('div');
        canvas.id = 'bpb-terrain-canvas';

        const controls = document.createElement('div');
        controls.className = 'bpb-terrain-controls';
        if (availableBasemaps.length) {
            pickerElement = document.createElement('select');
            pickerElement.className = 'bpb-terrain-picker';
            pickerElement.setAttribute('aria-label', 'Draped map layer');
            pickerElement.addEventListener('change', () => {
                showNotice('');
                swapBasemap(pickerElement.value === 'terrain' ? -1 : Number(pickerElement.value));
            });
            controls.appendChild(pickerElement);
        }
        const notice = document.createElement('p');
        notice.className = 'bpb-terrain-notice';
        notice.setAttribute('role', 'status');
        notice.hidden = true;
        noticeElement = notice;
        controls.append(notice);
        renderPicker();

        // Cooperative gestures keep the page from scroll-jacking, so zoom needs
        // a modifier. Spell that out (and how to pan/tilt) with an OS-aware
        // hint, since the requirement is not otherwise discoverable.
        const isMacPlatform = /mac|iphone|ipad|ipod/i.test(
            (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
        const hint = document.createElement('p');
        hint.className = 'bpb-terrain-hint';
        hint.textContent = `Drag to pan · ${isMacPlatform ? '⌘' : 'Ctrl'} + scroll to zoom · right-drag to tilt`;

        const status = document.createElement('p');
        status.className = 'bpb-terrain-status';
        status.setAttribute('role', 'status');
        status.textContent = 'Loading terrain…';
        mapElement.append(canvas, controls, hint, status);
        document.body.append(mapElement);

        try {
            maplibre.setWorkerUrl(chrome.runtime.getURL('vendor/maplibre-gl-csp-worker.js'));
            terrainCache = globalThis.BPBTerrainCache.create({ limitMb: cacheLimitMb });
            maplibre.addProtocol(globalThis.BPBTerrainCache.PROTOCOL, terrainCache.load);
            terrainProtocolRegistered = true;
            // Start at the route's framed camera directly. Initialising at a
            // placeholder zoom and fitting bounds only after 'load' would load a
            // whole throwaway tileset (and rebuild the terrain mesh) for a view
            // the user never sees; the constructor bounds skip that round trip.
            map = new maplibre.Map({
                container: canvas,
                style: terrainStyle(activeTheme, activeBasemap),
                bounds: route.bounds,
                fitBoundsOptions: { padding: 46, maxZoom: 15.5, pitch: 60, bearing: 0 },
                pitch: 60,
                bearing: 0,
                maxPitch: 80,
                maxZoom: 18,
                attributionControl: false,
                cooperativeGestures: true,
                fadeDuration: 0
            });
            const terrainMap = map;
            // Bottom-right, matching the native 2D map's zoom: a compact
            // attribution ("ⓘ") first so it can't wrap and shove the zoom upward,
            // then a zoom-only control (no compass) so the stack is the same
            // two-button height as the 2D zoom and the floating toggle lines up
            // the same way in both. Returning to 2D reframes the route, so the
            // compass's reset role is covered.
            terrainMap.addControl(new maplibre.AttributionControl({ compact: true }), 'bottom-right');
            terrainMap.addControl(new maplibre.NavigationControl({ showCompass: false }), 'bottom-right');
            terrainMap.addControl(new maplibre.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
            terrainMap.on('error', event => {
                if (event && event.sourceId === 'basemap') {
                    basemapErrored = true;
                    return;
                }
                if (!loaded && map === terrainMap) fail('maplibre');
            });
            // A raster tile that loads fires a 'source' data event carrying the
            // tile. One such event proves the drape can render, so a handful of
            // later tile failures must not tear the whole layer down.
            terrainMap.on('data', event => {
                if (map === terrainMap && event && event.sourceId === 'basemap'
                    && event.dataType === 'source' && event.tile) basemapContentLoaded = true;
            });
            // Decide the drape's fate once, after the first full settle: drop it
            // only when it errored and never loaded a single tile (an entire
            // layer blocked by CORS), but keep it through partial coverage gaps.
            terrainMap.on('idle', () => {
                if (basemapChecked || map !== terrainMap || !loaded) return;
                basemapChecked = true;
                if (activeBasemap && basemapErrored && !basemapContentLoaded) markBasemapFailed(activeBasemapIndex);
            });

            terrainMap.once('load', () => {
                if (map !== terrainMap || !mapElement) return;
                removeLoadTimer();
                terrainMap.addSource('bpb-route', { type: 'geojson', data: route.geojson });
                terrainMap.addLayer({
                    id: 'bpb-route-casing', type: 'line', source: 'bpb-route',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': activeRouteStyle.casingColor, 'line-width': activeRouteStyle.casingWidth }
                });
                terrainMap.addLayer({
                    id: 'bpb-route', type: 'line', source: 'bpb-route',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': activeRouteStyle.color, 'line-width': activeRouteStyle.width }
                });
                terrainMap.addSource('bpb-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                terrainMap.addLayer({
                    id: 'bpb-highlight', type: 'circle', source: 'bpb-highlight',
                    paint: { 'circle-radius': 8, 'circle-color': '#ff3b30', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
                });
                loaded = true;
                setTheme(activeTheme);
                status.remove();
                mapElement.style.pointerEvents = 'auto';
                post('loaded', { navTop: measureNavTop() });
            });

            loadTimer = setTimeout(() => fail('timeout'), MAP_LOAD_TIMEOUT_MS);
            if (typeof ResizeObserver === 'function') {
                resizeObserver = new ResizeObserver(() => {
                    if (!map) return;
                    map.resize();
                    if (loaded) post('metrics', { navTop: measureNavTop() });
                });
                resizeObserver.observe(mapElement);
            }
        } catch (error) {
            fail('renderer');
        }
    };

    window.addEventListener('message', event => {
        const data = event.data;
        if (event.source !== window.parent || !PEAKBAGGER_ORIGIN.test(event.origin)
            || !data || data[FRAME_MESSAGE_TAG] !== true || data.dir !== 'toFrame') return;
        parentOrigin = event.origin;

        if (data.type === 'init') createTerrain(data);
        else if (data.type === 'destroy') {
            removeTerrain();
            post('destroyed');
        } else if (data.type === 'highlight') setHighlight(data.coordinates);
        else if (data.type === 'update') {
            setRoutePaint(data.routeStyle);
            setTheme(data.theme);
        }
    });

    // The iframe load event can fire before this listener is installed in
    // Chromium. Tell the bridge when it is safe to deliver the initial route.
    window.parent.postMessage({
        [FRAME_MESSAGE_TAG]: true,
        dir: 'toParent',
        type: 'ready'
    }, '*');
})();
