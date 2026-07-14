// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — isolated-world 3D terrain renderer.
//
// MapLibre stays in the isolated extension world so its packaged worker and
// public DEM requests are not coupled to Peakbagger's CSP or page globals. The
// MAIN-world GPX analyzer sends only validated coordinate segments after an
// explicit user action. No terrain request is made before that message.

(() => {
    'use strict';

    const MESSAGE_TAG = '__bpbTerrain';
    const TERRAIN_TILEJSON_URL = 'https://tiles.mapterhorn.com/tilejson.json';
    const MAX_ROUTE_POINTS = 3000;
    const MAX_ROUTE_SEGMENTS = 1500;
    const MAX_MERCATOR_LAT = 85.0511287;
    const TERRAIN_EXAGGERATION = 1;
    const MAP_LOAD_TIMEOUT_MS = 15000;
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
    let activeTheme = 'light';
    let activeRouteStyle = { color: '#d9483b', width: 5, casingColor: '#ffffff', casingWidth: 9 };

    const post = (type, detail = {}) => window.postMessage({
        [MESSAGE_TAG]: true,
        dir: 'toPage',
        type,
        ...detail
    }, location.origin);

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
            try { map.remove(); } catch (error) { /* The canvas may already be detached. */ }
            map = null;
        }
        if (mapElement) {
            mapElement.remove();
            mapElement = null;
        }
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

        // A local mountain route should never span half the planet. Reject the
        // ambiguous antimeridian case instead of fitting an almost-global map.
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

    const terrainStyle = theme => {
        const palette = PALETTES[theme];
        return {
            version: 8,
            name: 'Better Peakbagger terrain',
            sources: {
                terrain: {
                    type: 'raster-dem',
                    url: TERRAIN_TILEJSON_URL,
                    encoding: 'terrarium',
                    tileSize: 512,
                    attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener noreferrer">© Mapterhorn</a>'
                }
            },
            layers: [
                { id: 'terrain-background', type: 'background', paint: { 'background-color': palette.background } },
                {
                    id: 'terrain-relief',
                    type: 'color-relief',
                    source: 'terrain',
                    paint: {
                        'color-relief-color': reliefExpression(palette),
                        'color-relief-opacity': 1
                    }
                },
                {
                    id: 'terrain-hillshade',
                    type: 'hillshade',
                    source: 'terrain',
                    paint: {
                        'hillshade-exaggeration': 0.48,
                        'hillshade-shadow-color': palette.hillShadow,
                        'hillshade-highlight-color': palette.hillHighlight,
                        'hillshade-accent-color': palette.hillAccent
                    }
                }
            ],
            terrain: { source: 'terrain', exaggeration: TERRAIN_EXAGGERATION }
        };
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
            type: 'Feature', properties: {},
            geometry: { type: 'Point', coordinates }
        } : { type: 'FeatureCollection', features: [] });
    };

    const createTerrain = data => {
        if (map || mapElement) return;
        const route = validateRoute(data.routeSegments);
        const viewport = document.getElementById('bpb-map-viewport');
        const nativeMap = viewport && viewport.querySelector('iframe[src*="MasterMap.aspx" i]');
        if (!route || !viewport || !nativeMap || !window.maplibregl || !chrome.runtime || !chrome.runtime.getURL) {
            fail('unavailable');
            return;
        }

        activeRouteStyle = validateStyle(data.routeStyle);
        activeTheme = data.theme === 'dark' ? 'dark' : 'light';

        mapElement = document.createElement('div');
        mapElement.id = 'bpb-terrain-map';
        mapElement.dataset.theme = activeTheme;
        mapElement.setAttribute('role', 'region');
        mapElement.setAttribute('aria-label', 'Interactive 3D terrain map');

        const canvas = document.createElement('div');
        canvas.id = 'bpb-terrain-canvas';
        const badge = document.createElement('p');
        badge.className = 'bpb-terrain-badge';
        badge.append('Terrain only');
        const caveat = document.createElement('span');
        caveat.textContent = '· Not live conditions';
        badge.append(caveat);
        const status = document.createElement('p');
        status.className = 'bpb-terrain-status';
        status.setAttribute('role', 'status');
        status.textContent = 'Loading terrain…';
        mapElement.append(canvas, badge, status);
        viewport.append(mapElement);

        try {
            window.maplibregl.setWorkerUrl(chrome.runtime.getURL('vendor/maplibre-gl-csp-worker.js'));
            map = new window.maplibregl.Map({
                container: canvas,
                style: terrainStyle(activeTheme),
                center: [
                    (route.bounds[0][0] + route.bounds[1][0]) / 2,
                    (route.bounds[0][1] + route.bounds[1][1]) / 2
                ],
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
            terrainMap.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
            terrainMap.addControl(new window.maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

            terrainMap.once('load', () => {
                if (map !== terrainMap || !mapElement) return;
                removeLoadTimer();
                terrainMap.addSource('bpb-route', { type: 'geojson', data: route.geojson });
                terrainMap.addLayer({
                    id: 'bpb-route-casing',
                    type: 'line',
                    source: 'bpb-route',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': activeRouteStyle.casingColor, 'line-width': activeRouteStyle.casingWidth }
                });
                terrainMap.addLayer({
                    id: 'bpb-route',
                    type: 'line',
                    source: 'bpb-route',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': activeRouteStyle.color, 'line-width': activeRouteStyle.width }
                });
                terrainMap.addSource('bpb-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                terrainMap.addLayer({
                    id: 'bpb-highlight',
                    type: 'circle',
                    source: 'bpb-highlight',
                    paint: {
                        'circle-radius': 8,
                        'circle-color': '#ff3b30',
                        'circle-stroke-color': '#ffffff',
                        'circle-stroke-width': 2
                    }
                });
                terrainMap.fitBounds(route.bounds, { padding: 46, maxZoom: 15.5, pitch: 60, bearing: 0, duration: 0 });
                loaded = true;
                setTheme(activeTheme);
                status.remove();
                mapElement.style.visibility = 'visible';
                mapElement.style.pointerEvents = 'auto';
                post('loaded');
            });

            loadTimer = setTimeout(() => fail('timeout'), MAP_LOAD_TIMEOUT_MS);
            if (typeof ResizeObserver === 'function') {
                resizeObserver = new ResizeObserver(() => {
                    if (map) map.resize();
                });
                resizeObserver.observe(viewport);
            }
        } catch (error) {
            fail('renderer');
        }
    };

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data[MESSAGE_TAG] !== true || data.dir !== 'toCS') return;

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
})();
