// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared MAIN-world helpers that turn Peakbagger's Leaflet
// basemap layers into MapLibre raster "drape" specs for the 3D terrain view.
// Used by the ascent GPX analyzer, Full Screen BigMap, and Peak-page map so the
// 2D layer menu and the 3D drape picker cannot diverge. Pure with respect to
// the extension: it only reads the same-origin page/frame that owns Leaflet.

(() => {
    'use strict';

    // Peakbagger builds each 2D basemap on demand inside its MasterMap
    // MapChange() switch, so there is no per-layer global to read and only the
    // *active* layer is ever present on the map — reading globals could
    // therefore only ever surface one layer. To mirror the full 2D menu in 3D we
    // carry drape specs for the well-known layers that are plain {z}/{x}/{y}
    // raster tiles AND serve CORS-clean tiles WebGL/MapLibre can sample. WMS
    // layers, dynamic image exports, funky projections, and the Google/Bing
    // layers cannot drape and are omitted; the live active layer (below) still
    // covers national basemaps we carry no spec for. Codes match #selmap option
    // values; any {s} is pre-resolved because a MapLibre raster source takes one
    // fixed URL template.
    const TERRAIN_DRAPE_LAYERS = {
        L_CT: { tiles: 'https://caltopo.s3.amazonaws.com/topo/{z}/{x}/{y}.png?v=1', minzoom: 6, maxzoom: 16, attribution: '&copy; <a href="https://caltopo.com" target="_blank" rel="noopener noreferrer">CalTopo</a>' },
        L_FS: { tiles: 'https://ctusfs.s3.amazonaws.com/fstopo/{z}/{x}/{y}.png', minzoom: 6, maxzoom: 16, attribution: '&copy; <a href="https://caltopo.com" target="_blank" rel="noopener noreferrer">CalTopo</a> / USFS' },
        L_MT: { tiles: 'https://tileserver.trimbleoutdoors.com/SecureTile/TileHandler.ashx?mapType=Topo&partnerID=12153&hash=b19f07d8-6f01-4981-9146-40875a18d2fa&x={x}&y={y}&z={z}', minzoom: 9, maxzoom: 16, attribution: '&copy; <a href="https://mytopo.com" target="_blank" rel="noopener noreferrer">MyTopo</a>' },
        // stockLod: OpenTopoMap is volunteer-run under a tile usage policy, so
        // it keeps MapLibre's stock (thriftier) drape LOD even though that
        // leaves it prone to the tilt-driven resolution step the other layers
        // are tuned out of. Courtesy to the host outranks our sharpness.
        L_OT: { tiles: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', minzoom: 0, maxzoom: 15, stockLod: true, attribution: '&copy; <a href="https://opentopomap.org" target="_blank" rel="noopener noreferrer">OpenTopoMap</a> (CC-BY-SA)' },
        L_OS: { tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', minzoom: 0, maxzoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' },
        L_AG: { tiles: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', minzoom: 0, maxzoom: 19, attribution: '&copy; <a href="https://www.esri.com" target="_blank" rel="noopener noreferrer">Esri</a>' },
        L_AI: { tiles: 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', minzoom: 0, maxzoom: 19, attribution: '&copy; <a href="https://www.esri.com" target="_blank" rel="noopener noreferrer">Esri</a>' },
        L_XX: { tiles: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', minzoom: 0, maxzoom: 16, attribution: '&copy; <a href="https://www.esri.com" target="_blank" rel="noopener noreferrer">Esri</a>' },
        L_AU: { tiles: 'https://services.arcgisonline.com/ArcGIS/rest/services/USA_Topo_Maps/MapServer/tile/{z}/{y}/{x}.png', minzoom: 0, maxzoom: 15, attribution: '&copy; <a href="https://www.esri.com" target="_blank" rel="noopener noreferrer">Esri</a>' }
    };

    const drapeFromCode = (code, name) => {
        const spec = TERRAIN_DRAPE_LAYERS[code];
        if (!spec) return null;
        return {
            name: String(name || '').trim().slice(0, 80) || code,
            tiles: [spec.tiles],
            tileSize: 256,
            minzoom: spec.minzoom,
            maxzoom: spec.maxzoom,
            scheme: 'xyz',
            stockLod: spec.stockLod === true,
            attribution: spec.attribution
        };
    };

    const expandLeafletTileUrl = (layer, mapWin) => {
        const options = layer && layer.options && typeof layer.options === 'object' ? layer.options : {};
        if (!layer || typeof layer._url !== 'string' || !layer._url || layer.wmsParams
            || options.zoomReverse === true || (Number.isFinite(options.zoomOffset) && options.zoomOffset !== 0)) return null;

        let template = layer._url;
        if (template.includes('{s}')) {
            const subdomains = Array.isArray(options.subdomains)
                ? options.subdomains
                : typeof options.subdomains === 'string' ? options.subdomains.split('') : [];
            const subdomain = subdomains.find(value => /^[a-z0-9-]{1,20}$/i.test(String(value)));
            if (!subdomain) return null;
            template = template.replaceAll('{s}', String(subdomain));
        }
        template = template.replaceAll('{r}', mapWin.L && mapWin.L.Browser && mapWin.L.Browser.retina ? '@2x' : '');

        const placeholders = { z: '__BPB_TILE_Z__', x: '__BPB_TILE_X__', y: '__BPB_TILE_Y__' };
        const protectedUrl = template.replace(/\{([zxy])\}/g, (match, token) => placeholders[token]);
        let absolute;
        try { absolute = new URL(protectedUrl, mapWin.location && mapWin.location.href || location.href).href; } catch (error) { return null; }
        template = absolute
            .replaceAll(placeholders.z, '{z}')
            .replaceAll(placeholders.x, '{x}')
            .replaceAll(placeholders.y, '{y}');

        const tokens = Array.from(template.matchAll(/\{([^{}]+)\}/g), match => match[1]);
        return ['z', 'x', 'y'].every(token => tokens.includes(token))
            && tokens.every(token => ['z', 'x', 'y'].includes(token))
            ? template
            : null;
    };

    const fromLayer = (layer, name, mapWin) => {
        const tiles = expandLeafletTileUrl(layer, mapWin);
        if (!tiles) return null;
        const options = layer.options || {};
        const minzoom = Number.isInteger(options.minZoom) ? Math.min(22, Math.max(0, options.minZoom)) : 0;
        const maxzoom = Number.isInteger(options.maxZoom) ? Math.min(24, Math.max(minzoom, options.maxZoom)) : 19;
        return {
            name: String(name || '').trim().slice(0, 80),
            tiles: [tiles],
            tileSize: Number(options.tileSize) === 512 ? 512 : 256,
            minzoom,
            maxzoom,
            scheme: options.tms === true ? 'tms' : 'xyz',
            // A live Leaflet layer is whatever national basemap the page had
            // active — an unknown host on unknown terms. Leave those on the
            // stock LOD rather than tripling tile requests to a stranger.
            stockLod: true,
            attribution: typeof options.attribution === 'string' ? options.attribution.slice(0, 600) : ''
        };
    };

    // The same drape-able choices the native #selmap lists, so the 3D view
    // mirrors the 2D layer menu. Only layers we carry a drape spec for are
    // offered; the rest stay 2D-only because MapLibre cannot sample them.
    const enumerate = select => {
        try {
            if (!select || !select.options) return [];
            const basemaps = [];
            const seen = new Set();
            for (const option of Array.from(select.options)) {
                const code = typeof option.value === 'string' ? option.value : '';
                if (!code || seen.has(code)) continue;
                const drape = drapeFromCode(code, option.textContent);
                if (drape) {
                    seen.add(code);
                    basemaps.push(drape);
                }
            }
            return basemaps;
        } catch (error) { /* Peakbagger may replace or restrict its map frame. */ }
        return [];
    };

    // The active drape for the currently-selected #selmap option. `mapWin` owns
    // the Leaflet globals; `map` is the live Leaflet map; `select` is #selmap.
    const active = (mapWin, map, select) => {
        try {
            const option = select && select.options && select.options[select.selectedIndex];
            if (!mapWin || !map || !option) return null;

            // A well-known active layer reuses its shared drape spec so it
            // dedupes cleanly against the picker list.
            const drape = drapeFromCode(select.value, option.textContent);
            if (drape) return drape;

            // Otherwise read the live Leaflet layer, so a national basemap we
            // carry no spec for still drapes when it is the active choice.
            const selectedLayer = typeof select.value === 'string' ? mapWin[select.value] : null;
            const activeLayers = Object.values(map._layers || {})
                .sort((left, right) => (Number(left && left.options && left.options.zIndex) || 0)
                    - (Number(right && right.options && right.options.zIndex) || 0));
            const candidates = [selectedLayer, ...activeLayers]
                .filter(layer => layer && typeof layer._url === 'string'
                    && (typeof map.hasLayer !== 'function' || map.hasLayer(layer)))
                .filter((layer, index, layers) => layers.indexOf(layer) === index);

            for (const layer of candidates) {
                const basemap = fromLayer(layer, option.textContent, mapWin);
                if (basemap) return basemap;
            }
        } catch (error) { /* Peakbagger may replace or restrict its map frame. */ }
        return null;
    };

    globalThis.BPBTerrainBasemap = { TERRAIN_DRAPE_LAYERS, drapeFromCode, fromLayer, enumerate, active };
})();
