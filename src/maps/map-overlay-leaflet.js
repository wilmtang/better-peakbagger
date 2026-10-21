// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOverlayTiles } from './map-overlay-tiles.js';
import { createPageBCTileFetch } from './bc-land-client.js';
import { OVERLAY_ATTRIBUTION } from './map-overlay-providers.js';
import { SENTINEL_ATTRIBUTION } from './sentinel-core.js';
import { snotelSymbol, snotelPopup } from '../snow/snotel-map-marker.js';

export function createLeafletOverlays({ win, map, onError, onActivity, bridgeWindow = win }) {
    const L = win.L, layers = new Map(), controllers = new Map(), records = new Map();
    const fetchBCTile = createPageBCTileFetch(bridgeWindow);
    const tiles = createOverlayTiles({ document: win.document, fetchImpl: win.fetch.bind(win), fetchBCTile, onError, onActivity });
    const z = { sentinel: 250, land: 260, slope: 270 };
    let stations = null, stationKey = '', hasScenes = false;
    const draw = record => {
        const { id, coordinates, canvas, done } = record, controller = new AbortController();
        controllers.set(canvas, controller); record.failed = false;
        tiles.draw(id, coordinates, canvas, controller.signal).then(() => {
            record.failed = tiles.failed(id, coordinates);
            if (records.get(canvas) === record && controllers.get(canvas) === controller) done(null, canvas);
        }, error => {
            if (records.get(canvas) !== record || controllers.get(canvas) !== controller) return;
            // A provider cooldown also aborts neighboring visible requests.
            // Those holes need retry too; unloaded records were removed above.
            record.failed = true; done(error, canvas);
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
                const canvas = tiles.canvas(), record = { id, coordinates, canvas, done, failed: false };
                records.set(canvas, record); draw(record);
                return canvas;
            },
        });
        const layer = new Grid({ pane, tileSize: 256, minZoom: 8, maxNativeZoom: id === 'sentinel' ? 14 : 15,
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
            if (id === 'land') tiles.landCooldowns(state.providerCooldowns);
            if (!state.enabled || state.opacity === 0) { remove(id); return; }
            if (state.retryAt > Date.now() && !layers.has(id) && !(id === 'land' && Object.keys(state.providerCooldowns || {}).length)) return;
            if (id === 'sentinel' && !hasScenes) return; // Wait for a validated capture.
            (layers.get(id) || add(id)).setOpacity(state.opacity / 100);
        },
        scenes(scenes, opacity) { remove('sentinel'); hasScenes = scenes.length > 0; tiles.setScenes(scenes); if (hasScenes && opacity > 0) add('sentinel').setOpacity(opacity / 100); },
        clearSentinel() { remove('sentinel'); hasScenes = false; tiles.setScenes([]); },
        retry(id) {
            if (!tiles.retry(id)) return;
            const visible = [...records.values()].filter(record => record.id === id);
            const failed = visible.filter(record => record.failed);
            // Retry only holes. An explicit Reload refreshes in place, leaving
            // each successful canvas painted until its replacement is ready.
            for (const record of failed.length ? failed : visible) draw(record);
        },
        stations(next, { selectable = new Set(), onSelect } = {}) {
            const key = JSON.stringify([next, [...selectable].sort()]); if (key === stationKey) return; stationKey = key;
            if (stations) { map.removeLayer(stations); stations = null; }
            if (!next.length) return;
            stations = L.layerGroup();
            for (const station of next) {
                const content = win.document.createElement('div'); content.append(snotelSymbol(win.document));
                const icon = L.divIcon({ className: 'bpb-snotel-marker', html: content, iconSize: [24, 24], iconAnchor: [12, 12] });
                L.marker([station.latitude, station.longitude], { icon, title: `${station.name} · SNOTEL`, keyboard: true, bpbOverlay: true })
                    .bindPopup(snotelPopup(win.document, station, selectable.has(station.id) ? onSelect : undefined), { maxWidth: 240 }).addTo(stations);
            }
            stations.addTo(map);
        },
        dispose() { for (const id of [...layers.keys()]) remove(id); if (stations) map.removeLayer(stations); for (const controller of controllers.values()) controller.abort(); controllers.clear(); tiles.dispose(); fetchBCTile.dispose(); },
    };
}
