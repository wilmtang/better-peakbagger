// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — MapLibre renderer hosted by terrain/terrain.html.

import { settingsSchema } from './settings-schema.js';
import { terrainCache as TerrainCache } from './terrain-cache.js';

// Kept as an IIFE for scoping; maplibregl remains a separately-loaded vendor
// global (see terrain/terrain.html); no globals are published here.
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
    const HIGHLIGHT_COLORS = Object.freeze({ distance: '#ff3b30', time: '#0055ff' });
    const PEAKBAGGER_ORIGIN = /^https?:\/\/(?:www\.)?peakbagger\.com(?::\d+)?$/i;
    // Extension-provided vector basemap (not mirrored from Peakbagger's 2D
    // Leaflet menu): OpenFreeMap's keyless, CORS-clean OpenStreetMap tiles,
    // grafted into the live style so labels billboard upright over the
    // terrain instead of rotating with a raster drape. Selecting it contacts
    // tiles.openfreemap.org — see the dated provider evaluation in
    // docs/archive/3d-vector-basemap-investigation.md.
    const VECTOR_BASEMAP = {
        name: 'OSM Vector (experimental)',
        styleUrl: 'https://tiles.openfreemap.org/styles/liberty'
    };
    const VECTOR_PREFIX = 'bpb-vector:';
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
    // Peak markers: Peakbagger's own dot feed, relayed by the host page on
    // request as the camera settles. Every visual and behavioral knob lives in
    // this one spec so restyling the markers — swapping the hollow rings for
    // solid dots, recoloring states, resizing, or replacing the layer type
    // wholesale in buildPeakLayers() — is a single-place change.
    const PEAK_MARKERS = {
        sourceId: 'bpb-peaks',
        layerId: 'bpb-peaks-ring',
        // The native 2D map hides its dots below Leaflet z12; MapLibre's z11
        // shows the same ground area (512px vs 256px tiles), so this is the
        // same "no dots when the map covers too big an area" rule.
        minZoom: 11,
        debounceMs: 250,
        maxCount: 400,
        // Ask for at most this multiple of the straight-down viewport around
        // the camera center: a pitched camera's raw bounds stretch to the
        // horizon, where dots would be sub-pixel clutter anyway.
        boundsFactor: 3,
        // Peakbagger's native ring colors (image/GreenCircle16.gif,
        // PinkCircle16.gif, SmallOrangeCircle.gif). 'unknown' is what the
        // feed reports when nobody is signed in.
        states: {
            climbed: { color: '#00ff00' },
            unclimbed: { color: '#ff6699' },
            unknown: { color: '#ffcc33' }
        },
        fallbackState: 'unknown',
        // Hollow ring like the 16x16 2D marker gifs: transparent fill keeps
        // the terrain visible through the center.
        ring: { radius: 6, strokeWidth: 2.5, opacity: 0.95 },
        // Extra pixels beyond the drawn ring edge that still count as a hit —
        // a small touch allowance that also absorbs the slight offset between
        // the shader's terrain sample and map.project()'s at high pitch.
        hitSlopPx: 4,
        // Peakbagger's database coordinate is commonly a few dozen meters off
        // the DEM's rendered apex, which a pitched camera turns into a ring
        // sitting visibly downslope. Each dot is walked uphill on the rendered
        // terrain to the nearest local summit — but never further than the
        // leash, never onto ground that keeps rising past it (that is a
        // neighboring, bigger mountain, not this dot's summit), and never up
        // more than the rise leash: matching the horizontal leash, 100 m of
        // gain exceeds any plausible coordinate error times any plausible
        // smoothed-DEM slope, so such a "summit" is a taller neighbor whose
        // own apex sits inside the horizontal leash, or a DEM artifact. The
        // feed carries no peak elevation, so gain above the feed point's own
        // terrain is the only vertical reference available.
        snap: { leashM: 100, riseM: 100, strideM: 24, finestStrideM: 3 }
    };

    // The eight compass directions a snap step can move in.
    const COMPASS_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

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
    let activeRouteStyle = { ...settingsSchema.ROUTE_STYLE };
    let vectorActive = false;
    let vectorStylePromise = null;
    let vectorSwapToken = 0;
    let vectorLayerIds = [];
    let vectorSourceIds = [];
    // True when the route carries per-track colors (group maps), so the route
    // line is painted data-driven from each feature instead of one flat color.
    let routeHasFeatureColors = false;
    let peakPopup = null;
    let peaksRequestId = 0;
    let peaksDebounceTimer = null;
    let peaksUnavailable = false;
    let lastPeaksBoundsKey = null;
    // The currently rendered peak features, kept for the screen-space hit
    // test, and the pointer's last position for the frame-throttled hover.
    let peakFeatures = [];
    // Peak pages pass their subject explicitly because Peakbagger's `t=P`
    // nearby-marker feed may exclude that same peak. Keep it independent of
    // each replace-style feed response so the summit never disappears.
    let focusPeakFeature = null;
    let peakPointerPoint = null;
    let peakPointerFrame = null;
    // Summit-snap verdicts by peak, recency-ordered so the least-recently used
    // entry trims first. ~10 dense screenfuls; a long pan session stays bounded.
    const peakSnapCache = new Map();
    const PEAK_SNAP_CACHE_LIMIT = 4000;

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
        if (peaksDebounceTimer !== null) {
            clearTimeout(peaksDebounceTimer);
            peaksDebounceTimer = null;
        }
        if (peakPopup) {
            try { peakPopup.remove(); } catch (error) { /* Already detached with its map. */ }
            peakPopup = null;
        }
        peaksRequestId = 0;
        peaksUnavailable = false;
        lastPeaksBoundsKey = null;
        peakSnapCache.clear();
        peakFeatures = [];
        focusPeakFeature = null;
        peakPointerPoint = null;
        if (peakPointerFrame !== null) {
            cancelAnimationFrame(peakPointerFrame);
            peakPointerFrame = null;
        }
        if (map) {
            try { map.remove(); } catch (error) { /* The frame may already be unloading. */ }
            map = null;
        }
        if (terrainProtocolRegistered && globalThis.maplibregl && typeof globalThis.maplibregl.removeProtocol === 'function') {
            try { globalThis.maplibregl.removeProtocol(TerrainCache.PROTOCOL); } catch (error) { /* The frame may already be unloading. */ }
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
        routeHasFeatureColors = false;
        vectorActive = false;
        vectorSwapToken++;
        vectorLayerIds = [];
        vectorSourceIds = [];
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

    const validateRoute = (segments, colors) => {
        if (!Array.isArray(segments) || !segments.length || segments.length > MAX_ROUTE_SEGMENTS) return null;
        const colorList = Array.isArray(colors) ? colors : [];
        const hexColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;

        let pointCount = 0;
        let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
        const features = [];
        let hasFeatureColors = false;

        for (let index = 0; index < segments.length; index++) {
            const segment = segments[index];
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
            const color = hexColor(colorList[index]);
            if (color) hasFeatureColors = true;
            features.push({
                type: 'Feature',
                properties: color ? { color } : {},
                geometry: { type: 'LineString', coordinates: converted }
            });
        }

        if (maxLon - minLon >= 180) return null;

        return {
            geojson: { type: 'FeatureCollection', features },
            bounds: [[minLon, minLat], [maxLon, maxLat]],
            hasFeatureColors
        };
    };

    const validateFocus = (value, requestedZoom) => {
        if (!Array.isArray(value) || value.length !== 2) return null;
        const [lat, lon] = value;
        if (!Number.isFinite(lat) || Math.abs(lat) > MAX_MERCATOR_LAT
            || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
        const zoom = Number.isFinite(requestedZoom) && requestedZoom >= 0 && requestedZoom <= 18
            ? requestedZoom
            : 13;
        return { center: [lon, lat], zoom };
    };

    // The host page is cross-origin to this frame, so its style is untrusted;
    // the shared schema keeps this check identical to the page-world and
    // storage-side ones.
    const validateStyle = style => settingsSchema.routeStyle(style);

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
            stockLod: value.stockLod === true,
            attribution: sanitizeAttribution(value.attribution)
        };
    };

    // With terrain on, MapLibre picks a per-tile zoom for every source from a
    // pitch-sensitive heuristic. At its stock setting a ~2 degree tilt can drop
    // the drape under the camera a whole level, which halves the topo's
    // resolution across most of the frame in one step and snaps back when the
    // tilt is undone. Tightening the spread to 4 zoom levels holds the drape
    // beneath the camera at full resolution through the pitches the 3D view
    // actually uses, at the cost of roughly 2-3x more tile requests — so it is
    // opt-out per layer (see stockLod) and never applied to the terrain source,
    // whose tiles are 2048px render targets rather than cheap images.
    const DRAPE_LOD_ZOOM_LEVELS_ON_SCREEN = 4;
    const DRAPE_LOD_TILE_COUNT_RATIO = 3;

    const applyBasemapLod = basemap => {
        if (!basemap || basemap.stockLod || typeof map.setSourceTileLodParams !== 'function') return;
        try {
            map.setSourceTileLodParams(DRAPE_LOD_ZOOM_LEVELS_ON_SCREEN, DRAPE_LOD_TILE_COUNT_RATIO, 'basemap');
        } catch (error) { /* An older MapLibre or a source that already went away. */ }
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
                // Anchor the light to the map's north, not the viewport. The
                // default 'viewport' pins the light to the top of the screen, so
                // a small right-drag (which rotates as well as tilts) swings the
                // light across the terrain and the shading flips dramatically.
                // 'map' keeps the sun fixed as the camera moves.
                'hillshade-illumination-anchor': 'map',
                'hillshade-illumination-direction': 335,
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
        const vectorOption = document.createElement('option');
        vectorOption.value = 'vector';
        vectorOption.textContent = VECTOR_BASEMAP.name;
        const terrainOption = document.createElement('option');
        terrainOption.value = 'terrain';
        terrainOption.textContent = 'Terrain only';
        pickerElement.replaceChildren(...options, vectorOption, terrainOption);
        pickerElement.value = vectorActive
            ? 'vector'
            : activeBasemapIndex >= 0 ? String(activeBasemapIndex) : 'terrain';
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
        applyBasemapLod(basemap);
    };

    const removeBasemapLayer = () => {
        try {
            if (typeof map.getLayer === 'function' && map.getLayer('basemap')) map.removeLayer('basemap');
            if (map.getSource('basemap') && typeof map.removeSource === 'function') map.removeSource('basemap');
        } catch (error) { /* A failed raster source may already be absent. */ }
    };

    // Fetch the provider's style once per frame lifetime; a failed fetch is
    // forgotten so the entry can be retried instead of staying broken.
    const fetchVectorStyle = () => {
        if (!vectorStylePromise) {
            vectorStylePromise = fetch(VECTOR_BASEMAP.styleUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' })
                .then(response => {
                    if (!response.ok) throw new Error(`Vector style request failed (${response.status})`);
                    return response.json();
                })
                .then(style => {
                    if (!style || style.version !== 8 || !style.sources
                        || typeof style.sources !== 'object' || !Array.isArray(style.layers)) {
                        throw new Error('Unexpected vector style shape');
                    }
                    return style;
                });
            vectorStylePromise.catch(() => { vectorStylePromise = null; });
        }
        return vectorStylePromise;
    };

    // Graft the provider style into the live inline style instead of
    // map.setStyle, so the Mapterhorn terrain mesh, hillshade, and route
    // layers survive untouched. Everything is added under prefixed ids so it
    // can be removed wholesale and can never collide with extension layers.
    const addVectorBasemap = style => {
        if (typeof style.glyphs === 'string' && typeof map.setGlyphs === 'function') map.setGlyphs(style.glyphs);
        if (typeof style.sprite === 'string' && typeof map.setSprite === 'function') map.setSprite(style.sprite);
        for (const [id, source] of Object.entries(style.sources)) {
            const prefixed = `${VECTOR_PREFIX}${id}`;
            map.addSource(prefixed, source);
            vectorSourceIds.push(prefixed);
        }
        const hasLayer = id => typeof map.getLayer === 'function' && map.getLayer(id);
        for (const layer of style.layers) {
            const copy = { ...layer, id: `${VECTOR_PREFIX}${layer.id}` };
            if (typeof copy.source === 'string') copy.source = `${VECTOR_PREFIX}${copy.source}`;
            // Ground geometry slides under the hillshade so relief keeps
            // shading the map exactly as it does raster drapes; labels go
            // above the route (below the hover highlight) so text stays
            // crisp, upright, and readable over both terrain and track.
            const before = layer.type === 'symbol'
                ? (hasLayer('bpb-highlight') ? 'bpb-highlight' : undefined)
                : (hasLayer('terrain-hillshade') ? 'terrain-hillshade' : undefined);
            map.addLayer(copy, before);
            vectorLayerIds.push(copy.id);
        }
    };

    const removeVectorBasemap = () => {
        try {
            for (const id of vectorLayerIds) {
                if (typeof map.getLayer === 'function' && map.getLayer(id)) map.removeLayer(id);
            }
            for (const id of vectorSourceIds) {
                if (map.getSource(id) && typeof map.removeSource === 'function') map.removeSource(id);
            }
        } catch (error) { /* A partially-added style may already be absent. */ }
        vectorLayerIds = [];
        vectorSourceIds = [];
        vectorActive = false;
    };

    // Switch the draped layer live. index < 0 selects terrain-only, 'vector'
    // selects the extension-provided vector basemap. Each swap re-arms the
    // one-shot CORS check so the new layer is judged on its own.
    const swapBasemap = selection => {
        if (!map || !loaded) return;
        removeBasemapLayer();
        removeVectorBasemap();
        vectorSwapToken++;
        basemapErrored = false;
        basemapContentLoaded = false;
        basemapChecked = false;
        activeBasemapIndex = -1;
        activeBasemap = null;
        if (selection === 'vector') {
            vectorActive = true;
            renderPicker();
            const token = vectorSwapToken;
            fetchVectorStyle()
                .then(style => {
                    if (!map || !loaded || token !== vectorSwapToken) return;
                    addVectorBasemap(style);
                })
                .catch(() => {
                    if (!map || !loaded || token !== vectorSwapToken) return;
                    vectorActive = false;
                    renderPicker();
                    showNotice(`${VECTOR_BASEMAP.name} is unavailable right now. Showing terrain only.`);
                });
            return;
        }
        const index = selection;
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

    // Group maps paint each track its own color (falling back to the preferred
    // color for any track without one); single tracks use one flat color.
    const routeLineColor = style => routeHasFeatureColors
        ? ['coalesce', ['get', 'color'], style.color]
        : style.color;

    const setRoutePaint = routeStyle => {
        const style = validateStyle(routeStyle);
        activeRouteStyle = style;
        if (!map || !loaded) return;
        map.setPaintProperty('bpb-route-casing', 'line-color', style.casingColor);
        map.setPaintProperty('bpb-route-casing', 'line-width', style.casingWidth);
        map.setPaintProperty('bpb-route', 'line-color', routeLineColor(style));
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

    // MapLibre supports Ctrl + primary-button drag as an alternative to a
    // secondary-button drag. On macOS Firefox, however, the browser rewrites
    // that mousedown as button=2 while leaving buttons=1. MapLibre records the
    // inconsistent secondary-button start, then rejects the primary-button
    // move events that follow, so the camera never tilts. Normalize only that
    // impossible physical-button combination into the Chrome-shaped event;
    // real secondary-button drags report buttons=2 and pass through untouched.
    const normalizeControlPrimaryDrag = container => {
        container.addEventListener('mousedown', event => {
            if (!event.ctrlKey || event.button !== 2 || event.buttons !== 1) return;
            const target = event.target;
            if (!target || typeof target.dispatchEvent !== 'function') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            target.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                detail: event.detail,
                screenX: event.screenX,
                screenY: event.screenY,
                clientX: event.clientX,
                clientY: event.clientY,
                ctrlKey: true,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
                button: 0,
                buttons: 1,
                relatedTarget: event.relatedTarget
            }));
        }, true);
    };

    const setHighlight = (coordinates, series) => {
        if (!map || !loaded) return;
        const source = map.getSource('bpb-highlight');
        if (!source || typeof source.setData !== 'function') return;
        const valid = Array.isArray(coordinates) && coordinates.length === 2
            && Number.isFinite(coordinates[0]) && Math.abs(coordinates[0]) <= 180
            && Number.isFinite(coordinates[1]) && Math.abs(coordinates[1]) <= MAX_MERCATOR_LAT;
        if (valid) {
            const color = Object.hasOwn(HIGHLIGHT_COLORS, series)
                ? HIGHLIGHT_COLORS[series]
                : HIGHLIGHT_COLORS.distance;
            map.setPaintProperty('bpb-highlight', 'circle-color', color);
        }
        source.setData(valid ? {
            type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates }
        } : { type: 'FeatureCollection', features: [] });
    };

    // === Peak markers ===
    // The frame owns when to ask (camera settle, zoom cutoff) and how to draw;
    // the host page owns the actual same-origin feed request. Everything the
    // page sends back is re-validated here — a bad batch renders no dots, and
    // the terrain view never fails because of them.

    const peakStateColor = () => {
        const expression = ['match', ['get', 'state']];
        for (const [state, style] of Object.entries(PEAK_MARKERS.states)) expression.push(state, style.color);
        expression.push(PEAK_MARKERS.states[PEAK_MARKERS.fallbackState].color);
        return expression;
    };

    // The single place that decides what a peak marker looks like. The rings
    // billboard at a constant screen size ('circle-pitch-scale': 'viewport'),
    // like the native map's fixed 16px gifs — which also keeps the drawn
    // extent identical to peakFeatureAt()'s screen-space hit radius at every
    // camera pitch and distance.
    const buildPeakLayers = () => [{
        id: PEAK_MARKERS.layerId, type: 'circle', source: PEAK_MARKERS.sourceId,
        paint: {
            'circle-radius': PEAK_MARKERS.ring.radius,
            'circle-color': 'rgba(0, 0, 0, 0)',
            'circle-pitch-scale': 'viewport',
            'circle-stroke-width': PEAK_MARKERS.ring.strokeWidth,
            'circle-stroke-color': peakStateColor(),
            'circle-stroke-opacity': PEAK_MARKERS.ring.opacity
        }
    }];

    // All-or-nothing like validateRoute: one malformed row drops the batch.
    const validatePeaks = value => {
        if (!Array.isArray(value) || value.length > PEAK_MARKERS.maxCount) return null;
        const features = [];
        for (const peak of value) {
            if (!peak || typeof peak !== 'object') return null;
            const { id, name, lat, lon, state } = peak;
            if (!Number.isInteger(id) || id === 0 || Math.abs(id) > 1e9) return null;
            if (typeof name !== 'string' || !name || name.length > 120
                || /[\u0000-\u001f\u007f]/.test(name)) return null;
            if (!Number.isFinite(lat) || Math.abs(lat) > MAX_MERCATOR_LAT
                || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
            features.push({
                type: 'Feature',
                properties: {
                    id,
                    name,
                    state: Object.hasOwn(PEAK_MARKERS.states, state) ? state : PEAK_MARKERS.fallbackState
                },
                geometry: { type: 'Point', coordinates: [lon, lat] }
            });
        }
        return features;
    };

    // The drawn extent of a ring in screen pixels (MapLibre strokes outward
    // from the fill radius), plus the spec's touch allowance.
    const PEAK_HIT_RADIUS = PEAK_MARKERS.ring.radius + PEAK_MARKERS.ring.strokeWidth + PEAK_MARKERS.hitSlopPx;

    // Screen-space hit test against the rendered rings. MapLibre's own
    // layer-scoped events cannot be used here: with terrain enabled the
    // library resolves the cursor through the terrain surface behind the
    // pixel, so a click on a ring billboarded over a summit "lands" wherever
    // the grazing ray strikes ground — kilometers past the peak, or in the
    // sky — the peak's tile is never queried, and the dots go dead as the
    // camera tilts toward horizontal (see docs/3d-peak-markers.md). The rings
    // are drawn as fixed-size billboards around a terrain-elevated anchor,
    // and map.project() returns exactly that anchor in screen pixels, so a
    // pixel-distance test against the ring spec reproduces the drawn shape at
    // any pitch. Nearest hit wins; anything unprojectable is a miss.
    const peakFeatureAt = point => {
        if (!map || !loaded || typeof map.project !== 'function'
            || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        let best = null;
        let bestDistance = PEAK_HIT_RADIUS;
        try {
            for (const feature of peakFeatures) {
                const coordinates = feature.geometry.coordinates;
                const projected = map.project([coordinates[0], coordinates[1]]);
                if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
                const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
                if (distance <= bestDistance) {
                    best = feature;
                    bestDistance = distance;
                }
            }
        } catch (error) {
            return null;
        }
        return best;
    };

    const updatePeakCursor = point => {
        const canvas = map && typeof map.getCanvas === 'function' ? map.getCanvas() : null;
        if (canvas) canvas.style.cursor = peakFeatureAt(point) ? 'pointer' : '';
    };

    // Hover hit tests are deferred to the next animation frame so a fast
    // pointer costs at most one scan of the (≤400) dots per painted frame.
    const schedulePeakCursorUpdate = point => {
        peakPointerPoint = point;
        if (peakPointerFrame !== null) return;
        peakPointerFrame = requestAnimationFrame(() => {
            peakPointerFrame = null;
            if (peakPointerPoint) updatePeakCursor(peakPointerPoint);
        });
    };

    // Walk one dot uphill on the rendered terrain to the local summit near
    // its database coordinates, so it reads as "on top" once relief exists to
    // betray a few dozen meters of coordinate error. The climb queries the
    // same DEM the mountains are drawn from, in shrinking compass strides,
    // leashed to snap.leashM. Everything fails closed to the feed's own
    // coordinates:
    // - MapLibre reports elevation 0 for a DEM tile it has not loaded, which
    //   is indistinguishable from the sea — an unreadable start must not
    //   "climb" toward whatever ground happens to be loaded nearby.
    // - A resting point must be a genuine local maximum: if the ground keeps
    //   rising in some direction just past it (a leash-length slope), the dot
    //   is on a neighboring, bigger mountain's flank — not its own summit.
    // - The climb may not gain more than snap.riseM: within one leash, that
    //   much height is a taller neighboring feature's own summit (or a DEM
    //   spike), never a plausible correction of the feed coordinate.
    //
    // A verdict is cached per peak and reused until the camera crosses into a
    // higher integer zoom level. queryTerrainElevation reads whatever terrain
    // tiles happen to be loaded, and tilting the camera can change their
    // resolution — on a knife-edge ridge the coarser DEM's apex sits somewhere
    // else entirely, so an uncached dot wandered with every tilt. A higher
    // integer zoom is the only event allowed to adopt a potentially finer DEM
    // sample; it also leaves every settle after a readable verdict free of
    // climbing. When the zoom crossing outruns the DEM stream and the climb
    // is unreadable, the previous verdict keeps rendering at its old zoom —
    // never an interim hop back to the feed coordinates — and the re-climb
    // retries on the next batch (see docs/3d-peak-markers.md, "Known
    // limitations").
    const climbToLocalSummit = feature => {
        const { leashM, riseM, strideM, finestStrideM } = PEAK_MARKERS.snap;
        const [feedLon, feedLat] = feature.geometry.coordinates;
        const metersPerDegreeLat = 111320;
        const metersPerDegreeLon = metersPerDegreeLat * Math.cos(feedLat * Math.PI / 180);
        if (!(metersPerDegreeLon > 0)) return null;
        const elevationAt = (lon, lat) => {
            try {
                const elevation = map.queryTerrainElevation([lon, lat]);
                return Number.isFinite(elevation) ? elevation : 0;
            } catch (error) {
                return 0;
            }
        };
        const metersFromFeed = (lon, lat) =>
            Math.hypot((lon - feedLon) * metersPerDegreeLon, (lat - feedLat) * metersPerDegreeLat);
        let best = elevationAt(feedLon, feedLat);
        if (!(best > 0)) return null;
        const startElevation = best;
        let lon = feedLon;
        let lat = feedLat;
        for (let stride = strideM; stride >= finestStrideM; stride /= 2) {
            for (let moved = true; moved;) {
                moved = false;
                for (const [east, north] of COMPASS_STEPS) {
                    const stepLon = lon + east * stride / metersPerDegreeLon;
                    const stepLat = lat + north * stride / metersPerDegreeLat;
                    if (metersFromFeed(stepLon, stepLat) > leashM) continue;
                    const elevation = elevationAt(stepLon, stepLat);
                    if (elevation > best) {
                        best = elevation;
                        lon = stepLon;
                        lat = stepLat;
                        moved = true;
                    }
                }
            }
        }
        // Gaining more than the rise leash means the walk summited a taller
        // neighboring feature inside the horizontal leash, or a DEM spike —
        // a few dozen meters of database error never buys this much height.
        if (best - startElevation > riseM) return { lon: feedLon, lat: feedLat };
        if (lon !== feedLon || lat !== feedLat) {
            for (const [east, north] of COMPASS_STEPS) {
                const beyondLon = lon + east * finestStrideM / metersPerDegreeLon;
                const beyondLat = lat + north * finestStrideM / metersPerDegreeLat;
                if (elevationAt(beyondLon, beyondLat) > best) return { lon: feedLon, lat: feedLat };
            }
        }
        return { lon, lat };
    };

    const snapToLocalSummit = feature => {
        if (!map || typeof map.queryTerrainElevation !== 'function'
            || typeof map.getZoom !== 'function') return feature;
        const [feedLon, feedLat] = feature.geometry.coordinates;
        const zoom = Math.floor(map.getZoom());
        const cacheKey = `${feature.properties.id}:${feedLon}:${feedLat}`;
        let verdict = peakSnapCache.get(cacheKey);
        if (!verdict || verdict.zoom < zoom) {
            const climbed = climbToLocalSummit(feature);
            if (climbed) {
                verdict = { zoom, lon: climbed.lon, lat: climbed.lat };
            } else if (!verdict) {
                // An unreadable start is missing data, not a verdict — leave
                // the dot at the feed position and let the next batch retry.
                return feature;
            }
            // An unreadable climb with a stale verdict means zooming in outran
            // the finer DEM tile: hold the stale verdict (its zoom stays old,
            // so the next batch re-climbs once the tile loads) rather than
            // hopping to the feed coordinates and back off the summit.
        }
        // Delete-then-set refreshes recency: the cache trims from the oldest
        // end, and dots still on screen must never be the ones trimmed.
        peakSnapCache.delete(cacheKey);
        peakSnapCache.set(cacheKey, verdict);
        while (peakSnapCache.size > PEAK_SNAP_CACHE_LIMIT) {
            peakSnapCache.delete(peakSnapCache.keys().next().value);
        }
        return verdict.lon === feedLon && verdict.lat === feedLat
            ? feature
            : { ...feature, geometry: { type: 'Point', coordinates: [verdict.lon, verdict.lat] } };
    };

    const setPeakData = features => {
        const merged = focusPeakFeature
            ? [focusPeakFeature, ...features
                .filter(feature => feature.properties.id !== focusPeakFeature.properties.id)
                .slice(0, PEAK_MARKERS.maxCount - 1)]
            : features;
        peakFeatures = merged.map(snapToLocalSummit);
        const source = map && map.getSource(PEAK_MARKERS.sourceId);
        if (source && typeof source.setData === 'function') {
            source.setData({ type: 'FeatureCollection', features: peakFeatures });
        }
        // The native map rebuilds its markers on every settle, which closes
        // any open marker popup; mirror that so a popup never outlives the
        // dot it points at.
        if (peakPopup) {
            try { peakPopup.remove(); } catch (error) { /* Already detached. */ }
            peakPopup = null;
        }
        // Keep the hover cursor honest when the dots refresh or clear under a
        // resting pointer.
        if (peakPointerPoint) updatePeakCursor(peakPointerPoint);
    };

    // The visible bounds, clamped to boundsFactor × the straight-down viewport
    // around the camera center so a pitched camera never asks for the horizon.
    const peakRequestBounds = () => {
        const rawBounds = map.getBounds();
        const center = map.getCenter();
        const canvas = typeof map.getCanvas === 'function' ? map.getCanvas() : null;
        const width = canvas ? (canvas.clientWidth || canvas.width) : 0;
        const height = canvas ? (canvas.clientHeight || canvas.height) : 0;
        if (!rawBounds || !center || !(width > 0) || !(height > 0)) return null;
        const degreesPerPixel = 360 / (512 * Math.pow(2, map.getZoom()));
        const halfLon = (width * degreesPerPixel * PEAK_MARKERS.boundsFactor) / 2;
        const halfLat = (height * degreesPerPixel * PEAK_MARKERS.boundsFactor) / 2
            * Math.cos(center.lat * Math.PI / 180);
        const round = value => Math.round(value * 1e4) / 1e4;
        const bounds = {
            miny: round(Math.max(rawBounds.getSouth(), center.lat - halfLat)),
            maxy: round(Math.min(rawBounds.getNorth(), center.lat + halfLat)),
            minx: round(Math.max(rawBounds.getWest(), center.lng - halfLon)),
            maxx: round(Math.min(rawBounds.getEast(), center.lng + halfLon))
        };
        return bounds.miny < bounds.maxy && bounds.minx < bounds.maxx ? bounds : null;
    };

    const requestPeaks = () => {
        if (!map || !loaded || peaksUnavailable) return;
        try {
            if (map.getZoom() < PEAK_MARKERS.minZoom) {
                lastPeaksBoundsKey = null;
                setPeakData([]);
                return;
            }
            const bounds = peakRequestBounds();
            if (!bounds) return;
            const key = JSON.stringify(bounds);
            if (key === lastPeaksBoundsKey) return;
            lastPeaksBoundsKey = key;
            peaksRequestId++;
            post('peaksRequest', { requestId: peaksRequestId, bounds });
        } catch (error) { /* Peak dots are an overlay; the terrain view never fails for them. */ }
    };

    const schedulePeaksRequest = () => {
        if (peaksDebounceTimer !== null) clearTimeout(peaksDebounceTimer);
        peaksDebounceTimer = setTimeout(() => {
            peaksDebounceTimer = null;
            requestPeaks();
        }, PEAK_MARKERS.debounceMs);
    };

    const applyPeaks = data => {
        if (!map || !loaded) return;
        if (data.unavailable === true) {
            // This surface has no peak feed (e.g. group maps): stop asking.
            peaksUnavailable = true;
            setPeakData([]);
            return;
        }
        // Only the newest request may answer; stale replies are dropped.
        if (data.requestId !== peaksRequestId) return;
        setPeakData(validatePeaks(data.peaks) || []);
    };

    // The same white name-link bubble the 2D markers open, rebuilt from
    // validated fields only: the link target is derived from the integer peak
    // id, never from received markup.
    const showPeakPopup = feature => {
        const maplibre = globalThis.maplibregl;
        const properties = (feature && feature.properties) || {};
        const id = properties.id;
        const name = properties.name;
        const coordinates = feature && feature.geometry && feature.geometry.coordinates;
        if (!Number.isInteger(id) || id === 0 || typeof name !== 'string' || !name
            || !Array.isArray(coordinates) || !parentOrigin
            || !maplibre || typeof maplibre.Popup !== 'function') return;
        if (peakPopup) {
            try { peakPopup.remove(); } catch (error) { /* Already detached. */ }
            peakPopup = null;
        }
        const content = document.createElement('div');
        content.className = 'bpb-peak-popup';
        const link = document.createElement('a');
        link.href = `${parentOrigin}/peak.aspx?pid=${id}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = name;
        content.append(link);
        peakPopup = new maplibre.Popup({
            closeButton: true,
            closeOnClick: true,
            maxWidth: '280px',
            offset: PEAK_MARKERS.ring.radius + PEAK_MARKERS.ring.strokeWidth
        })
            .setLngLat([coordinates[0], coordinates[1]])
            .setDOMContent(content)
            .addTo(map);
    };

    const createTerrain = data => {
        if (map || mapElement) return;
        const route = validateRoute(data.routeSegments, data.routeColors);
        const focus = validateFocus(data.focus, data.focusZoom);
        routeHasFeatureColors = Boolean(route && route.hasFeatureColors);
        const maplibre = globalThis.maplibregl;
        const cacheLimitMb = settingsSchema.terrainCacheLimitMb(data.cacheLimitMb);
        if ((!route && !focus) || !maplibre || !TerrainCache || !globalThis.chrome?.runtime?.getURL) {
            fail('unavailable');
            return;
        }

        const focusPeak = focus ? validatePeaks([data.focusPeak]) : null;
        focusPeakFeature = focusPeak && focusPeak.length === 1
            && Math.abs(focusPeak[0].geometry.coordinates[0] - focus.center[0]) < 1e-6
            && Math.abs(focusPeak[0].geometry.coordinates[1] - focus.center[1]) < 1e-6
            ? focusPeak[0]
            : null;

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
        normalizeControlPrimaryDrag(canvas);

        const controls = document.createElement('div');
        controls.className = 'bpb-terrain-controls';
        // Always offered: the extension-provided vector entry and terrain-only
        // exist even when the page offers no drape-able raster layer.
        pickerElement = document.createElement('select');
        pickerElement.className = 'bpb-terrain-picker';
        pickerElement.setAttribute('aria-label', 'Draped map layer');
        pickerElement.addEventListener('change', () => {
            showNotice('');
            swapBasemap(pickerElement.value === 'terrain'
                ? -1
                : pickerElement.value === 'vector' ? 'vector' : Number(pickerElement.value));
        });
        controls.appendChild(pickerElement);
        const notice = document.createElement('p');
        notice.className = 'bpb-terrain-notice';
        notice.setAttribute('role', 'status');
        notice.hidden = true;
        noticeElement = notice;
        controls.append(notice);
        renderPicker();

        // Scroll zooms directly, matching the native 2D map. Pan and tilt are
        // still not discoverable, so keep a persistent hint for those.
        const hint = document.createElement('p');
        hint.className = 'bpb-terrain-hint';
        hint.textContent = 'Drag to pan · scroll to zoom · right-drag to tilt';

        const status = document.createElement('p');
        status.className = 'bpb-terrain-status';
        status.setAttribute('role', 'status');
        status.textContent = 'Loading terrain…';
        mapElement.append(canvas, controls, hint, status);
        document.body.append(mapElement);

        try {
            maplibre.setWorkerUrl(chrome.runtime.getURL('vendor/maplibre-gl-csp-worker.js'));
            terrainCache = TerrainCache.create({ limitMb: cacheLimitMb });
            maplibre.addProtocol(TerrainCache.PROTOCOL, terrainCache.load);
            terrainProtocolRegistered = true;
            // Start at the final camera directly. Route views frame the track;
            // Peak pages center on their summit. Initialising at a placeholder
            // camera and moving only after 'load' would fetch and mesh a whole
            // throwaway tileset for a view the user never sees.
            const initialCamera = route
                ? {
                    bounds: route.bounds,
                    fitBoundsOptions: { padding: 46, maxZoom: 15.5, pitch: 60, bearing: 0 }
                }
                : { center: focus.center, zoom: focus.zoom };
            map = new maplibre.Map({
                container: canvas,
                style: terrainStyle(activeTheme, activeBasemap),
                ...initialCamera,
                pitch: 60,
                bearing: 0,
                maxPitch: 80,
                maxZoom: 18,
                attributionControl: false,
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
                // The constructor style already carries the drape source, so it
                // needs the same LOD treatment addBasemapLayer() gives later picks.
                applyBasemapLod(activeBasemap);
                terrainMap.addSource('bpb-route', {
                    type: 'geojson',
                    data: route ? route.geojson : { type: 'FeatureCollection', features: [] }
                });
                terrainMap.addLayer({
                    id: 'bpb-route-casing', type: 'line', source: 'bpb-route',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': activeRouteStyle.casingColor, 'line-width': activeRouteStyle.casingWidth }
                });
                terrainMap.addLayer({
                    id: 'bpb-route', type: 'line', source: 'bpb-route',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': routeLineColor(activeRouteStyle), 'line-width': activeRouteStyle.width }
                });
                terrainMap.addSource(PEAK_MARKERS.sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                for (const layer of buildPeakLayers()) terrainMap.addLayer(layer);
                setPeakData([]);
                // Click and hover go through the screen-space hit test —
                // never layer-scoped events, which die on a pitched terrain
                // camera (see peakFeatureAt).
                terrainMap.on('click', event => {
                    if (map !== terrainMap || !event) return;
                    const feature = peakFeatureAt(event.point);
                    if (feature) showPeakPopup(feature);
                });
                terrainMap.on('mousemove', event => {
                    if (map === terrainMap && event && event.point) schedulePeakCursorUpdate(event.point);
                });
                terrainMap.on('mouseout', () => {
                    if (map !== terrainMap) return;
                    peakPointerPoint = null;
                    const canvas = typeof terrainMap.getCanvas === 'function' ? terrainMap.getCanvas() : null;
                    if (canvas) canvas.style.cursor = '';
                });
                terrainMap.addSource('bpb-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                terrainMap.addLayer({
                    id: 'bpb-highlight', type: 'circle', source: 'bpb-highlight',
                    paint: { 'circle-radius': 8, 'circle-color': HIGHLIGHT_COLORS.distance, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
                });
                terrainMap.on('moveend', () => {
                    if (map === terrainMap) schedulePeaksRequest();
                });
                loaded = true;
                setTheme(activeTheme);
                status.remove();
                mapElement.style.pointerEvents = 'auto';
                post('loaded', { navTop: measureNavTop() });
                schedulePeaksRequest();
            });

            loadTimer = setTimeout(() => fail('timeout'), MAP_LOAD_TIMEOUT_MS);
            if (typeof ResizeObserver === 'function') {
                resizeObserver = new ResizeObserver(() => {
                    if (!map) return;
                    map.resize();
                    // resize() re-allocates the canvas backing store, which the
                    // browser clears to transparent, and MapLibre only repaints
                    // on the next animation frame — so every drag step of the
                    // host page's resize handle would composite one blank frame
                    // and the 3D view flickers. ResizeObserver callbacks run
                    // before paint, so a synchronous redraw here refills the
                    // canvas before the browser ever shows it.
                    if (typeof map.redraw === 'function') map.redraw();
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
        } else if (data.type === 'highlight') setHighlight(data.coordinates, data.series);
        else if (data.type === 'peaks') applyPeaks(data);
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
