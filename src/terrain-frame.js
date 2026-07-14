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
    let basemapFailed = false;
    let badgeElement = null;
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
        basemapFailed = false;
        badgeElement = null;
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

    const renderBadge = () => {
        if (!badgeElement) return;
        const caveat = document.createElement('span');
        caveat.textContent = '· Not live conditions';
        badgeElement.replaceChildren(document.createTextNode(activeBasemap ? `${activeBasemap.name} · 3D terrain` : 'Terrain only'), caveat);
    };

    const removeFailedBasemap = () => {
        if (!map || !activeBasemap) return;
        try {
            if (typeof map.getLayer === 'function' && map.getLayer('basemap')) map.removeLayer('basemap');
            if (map.getSource('basemap') && typeof map.removeSource === 'function') map.removeSource('basemap');
        } catch (error) { /* A failed raster source may already be absent. */ }
        activeBasemap = null;
        renderBadge();
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
        activeBasemap = validateBasemap(data.basemap);
        basemapFailed = false;

        mapElement = document.createElement('div');
        mapElement.id = 'bpb-terrain-map';
        mapElement.dataset.theme = activeTheme;
        mapElement.setAttribute('role', 'region');
        mapElement.setAttribute('aria-label', 'Interactive 3D terrain map');

        const canvas = document.createElement('div');
        canvas.id = 'bpb-terrain-canvas';
        const badge = document.createElement('p');
        badge.className = 'bpb-terrain-badge';
        badgeElement = badge;
        renderBadge();
        const status = document.createElement('p');
        status.className = 'bpb-terrain-status';
        status.setAttribute('role', 'status');
        status.textContent = 'Loading terrain…';
        mapElement.append(canvas, badge, status);
        document.body.append(mapElement);

        try {
            maplibre.setWorkerUrl(chrome.runtime.getURL('vendor/maplibre-gl-csp-worker.js'));
            terrainCache = globalThis.BPBTerrainCache.create({ limitMb: cacheLimitMb });
            maplibre.addProtocol(globalThis.BPBTerrainCache.PROTOCOL, terrainCache.load);
            terrainProtocolRegistered = true;
            map = new maplibre.Map({
                container: canvas,
                style: terrainStyle(activeTheme, activeBasemap),
                center: [(route.bounds[0][0] + route.bounds[1][0]) / 2, (route.bounds[0][1] + route.bounds[1][1]) / 2],
                zoom: 11,
                pitch: 60,
                bearing: 0,
                maxPitch: 80,
                maxZoom: 18,
                attributionControl: true,
                cooperativeGestures: true,
                fadeDuration: 0
            });
            const terrainMap = map;
            terrainMap.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'top-right');
            terrainMap.addControl(new maplibre.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
            terrainMap.on('error', event => {
                if (event && event.sourceId === 'basemap') {
                    basemapFailed = true;
                    if (loaded && map === terrainMap) removeFailedBasemap();
                    return;
                }
                if (!loaded && map === terrainMap) fail('maplibre');
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
                terrainMap.fitBounds(route.bounds, { padding: 46, maxZoom: 15.5, pitch: 60, bearing: 0, duration: 0 });
                loaded = true;
                if (basemapFailed) removeFailedBasemap();
                setTheme(activeTheme);
                status.remove();
                mapElement.style.pointerEvents = 'auto';
                post('loaded');
            });

            loadTimer = setTimeout(() => fail('timeout'), MAP_LOAD_TIMEOUT_MS);
            if (typeof ResizeObserver === 'function') {
                resizeObserver = new ResizeObserver(() => { if (map) map.resize(); });
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
