// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOverlayTiles } from './map-overlay-tiles.js';
import { createPageBCTileFetch } from './bc-land-client.js';
import { OVERLAY_ATTRIBUTION, OVERLAY_MIN_ZOOM } from './map-overlay-providers.js';
import { SENTINEL_ATTRIBUTION } from './sentinel-core.js';
import { snotelSymbol, snotelPopup, updateSnotelPopupAction } from '../snow/snotel-map-marker.js';

export function createLeafletOverlays({ win, map, onError, onActivity, bridgeWindow = win }) {
    const L = win.L, layers = new Map(), controllers = new Map(), records = new Map(), states = new Map();
    const fetchBCTile = createPageBCTileFetch(bridgeWindow);
    const tiles = createOverlayTiles({ document: win.document, fetchImpl: win.fetch.bind(win), fetchBCTile, onError, onActivity });
    const z = { sentinel: 250, land: 260, slope: 270 };
    let stations = null, stationPopups = [], stationKey = '', hasScenes = false;
    const draw = record => {
        const { id, coordinates, canvas, done } = record, controller = new AbortController();
        controllers.set(canvas, controller); record.failed = false;
        tiles.draw(id, coordinates, canvas, controller.signal).then(() => {
            record.failed = tiles.failed(id, coordinates);
            if (records.get(canvas) === record && controllers.get(canvas) === controller && !record.loaded) {
                // Leaflet's ready callback restarts its tile fade. A canvas
                // already on screen only needs its pixels replaced, once.
                record.loaded = true; done(null, canvas);
            }
        }, error => {
            if (records.get(canvas) !== record || controllers.get(canvas) !== controller) return;
            // A provider cooldown also aborts neighboring visible requests.
            // Those holes need retry too; unloaded records were removed above.
            record.failed = true; if (!record.loaded) done(error, canvas);
        }).finally(() => { if (controllers.get(canvas) === controller) controllers.delete(canvas); });
    };
    const remove = id => {
        const layer = layers.get(id); if (layer) { map.removeLayer(layer); layers.delete(id); }
        tiles.cancel(id);
    };
    const add = id => {
        const pane = `bpb-overlay-${id}`;
        if (!map.getPane(pane)) { map.createPane(pane); map.getPane(pane).style.cssText = `z-index:${z[id]};pointer-events:none`; }
        const Grid = L.GridLayer.extend({
            createTile(coordinates, done) {
                const canvas = tiles.canvas(), record = { id, coordinates, canvas, done, failed: false, loaded: false };
                records.set(canvas, record); draw(record);
                return canvas;
            },
        });
        const layer = new Grid({ pane, tileSize: 256, minZoom: OVERLAY_MIN_ZOOM, maxNativeZoom: id === 'sentinel' ? 14 : 15,
            maxZoom: 24, keepBuffer: 1, updateWhenIdle: true, bpbOverlay: true,
            attribution: id === 'sentinel' ? SENTINEL_ATTRIBUTION : OVERLAY_ATTRIBUTION[id] });
        layer.on('tileunload', event => {
            controllers.get(event.tile)?.abort(); controllers.delete(event.tile);
            const record = records.get(event.tile); records.delete(event.tile);
            if (record) tiles.forget(id, record.coordinates);
        });
        layers.set(id, layer); layer.addTo(map); return layer;
    };
    return {
        set(id, state) {
            if (id === 'snotel') return;
            states.set(id, { ...state });
            if (id === 'land') {
                tiles.landCooldowns(state.providerCooldowns);
                // An explicit filter change must remove deselected pixels,
                // even if a replacement fails. Ordinary pans retain tiles.
                if (tiles.setLandTypes(state.landTypes)) remove(id);
            }
            if (!state.enabled || state.opacity === 0 || id === 'land' && state.landTypes?.length === 0) { remove(id); return; }
            if (state.retryAt > Date.now() && !layers.has(id) && !(id === 'land' && Object.keys(state.providerCooldowns || {}).length)) return;
            if (id === 'sentinel' && !hasScenes) return; // Wait for a validated capture.
            (layers.get(id) || add(id)).setOpacity(state.opacity / 100);
        },
        scenes(scenes, opacity) {
            hasScenes = scenes.length > 0; states.set('sentinel', { enabled: hasScenes, opacity }); tiles.setScenes(scenes);
            if (!hasScenes || opacity === 0) { remove('sentinel'); return; }
            const layer = layers.get('sentinel');
            // Panning can change the selected pass's scene mosaic. Keep the
            // loaded canvases attached until each replacement paints in place.
            if (layer) for (const record of records.values()) if (record.id === 'sentinel') draw(record);
            (layer || add('sentinel')).setOpacity(opacity / 100);
        },
        clearSentinel() { remove('sentinel'); hasScenes = false; tiles.setScenes([]); },
        retry(id) {
            const state = states.get(id);
            if (!state?.enabled || state.opacity === 0 || state.retryAt > Date.now() || id === 'land' && state.landTypes?.length === 0 || id === 'sentinel' && !hasScenes) return;
            if (!tiles.retry(id)) return;
            if (!layers.has(id)) { add(id).setOpacity(state.opacity / 100); return; }
            const visible = [...records.values()].filter(record => record.id === id);
            const failed = visible.filter(record => record.failed);
            // Retry only holes. An explicit Reload refreshes in place, leaving
            // each successful canvas painted until its replacement is ready.
            for (const record of failed.length ? failed : visible) draw(record);
        },
        stations(next, { selectable = new Set(), onSelect } = {}) {
            const key = JSON.stringify(next);
            if (key === stationKey) {
                for (const { station, content } of stationPopups) updateSnotelPopupAction(content, station, selectable.has(station.id) ? onSelect : undefined);
                return;
            }
            stationKey = key; stationPopups = [];
            if (stations) { map.removeLayer(stations); stations = null; }
            if (!next.length) return;
            stations = L.layerGroup();
            for (const station of next) {
                const content = win.document.createElement('div'); content.append(snotelSymbol(win.document));
                const icon = L.divIcon({ className: 'bpb-snotel-marker', html: content, iconSize: [24, 24], iconAnchor: [12, 12] });
                const popup = snotelPopup(win.document, station, selectable.has(station.id) ? onSelect : undefined);
                stationPopups.push({ station, content: popup });
                L.marker([station.latitude, station.longitude], { icon, title: `${station.name} · SNOTEL`, keyboard: true, bpbOverlay: true })
                    .bindPopup(popup, { maxWidth: 240 }).addTo(stations);
            }
            stations.addTo(map);
        },
        dispose() { for (const id of [...layers.keys()]) remove(id); if (stations) map.removeLayer(stations); for (const controller of controllers.values()) controller.abort(); controllers.clear(); tiles.dispose(); fetchBCTile.dispose(); },
    };
}
