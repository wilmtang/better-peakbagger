// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createLeafletWildfires } from './wildfire-leaflet.ts';
import { createOverlayTiles, type OverlayActivityState, type OverlayScene, type OverlayTileError } from './map-overlay-tiles.ts';
import { createPageBCTileFetch } from './bc-land-client.ts';
import { OVERLAY_ATTRIBUTION, OVERLAY_MIN_ZOOM, type OverlayTile } from './map-overlay-providers.ts';
import { SNOW_DEPTH_MAX_ZOOM } from './snow-depth.ts';
import { SENTINEL_ATTRIBUTION } from './sentinel-core.ts';
import { snotelSymbol, snotelPopup, updateSnotelPopupAction } from '../snow/snotel-map-marker.ts';
import type { SnotelMapStation } from '../snow/snotel-map-data.ts';

export interface LeafletOverlayState {
    enabled: boolean;
    opacity: number;
    landTypes?: string[];
    retryAt?: number;
    providerCooldowns?: Record<string, number>;
}

interface LeafletGridLayer {
    on(type: 'tileunload', listener: (event: { tile: HTMLCanvasElement }) => void): unknown;
    setOpacity(value: number): LeafletGridLayer;
    addTo(map: LeafletOverlayMap): unknown;
}

interface LeafletLayerGroup {
    addTo(map: LeafletOverlayMap): unknown;
}

interface LeafletMarker {
    bindPopup(content: HTMLElement, options: { maxWidth: number }): { addTo(group: LeafletLayerGroup): unknown };
}

export interface LeafletOverlayMap {
    getPane(name: string): HTMLElement | undefined;
    createPane(name: string): HTMLElement;
    removeLayer(layer: unknown): unknown;
}

export interface LeafletOverlayWindow {
    document: Document;
    fetch: typeof fetch;
    location: Location;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
    postMessage(message: unknown, targetOrigin: string): void;
    L: {
        GridLayer: {
            extend(methods: {
                createTile(coordinates: OverlayTile, done: (error: unknown, tile: HTMLCanvasElement) => void): HTMLCanvasElement;
            }): new (options: Record<string, unknown>) => LeafletGridLayer;
        };
        layerGroup(): LeafletLayerGroup;
        divIcon(options: { className: string; html: HTMLElement; iconSize: [number, number]; iconAnchor: [number, number] }): unknown;
        marker(latLng: [number, number], options: Record<string, unknown>): LeafletMarker;
    };
}

export interface LeafletOverlaysOptions {
    win: LeafletOverlayWindow;
    map: LeafletOverlayMap;
    onError?: (id: string, error: OverlayTileError) => void;
    onActivity?: (id: string, state: OverlayActivityState) => void;
    bridgeWindow?: Pick<LeafletOverlayWindow, 'document' | 'location' | 'addEventListener' | 'removeEventListener' | 'postMessage'>;
    onWildfireStatus?: (status: Record<string, unknown>) => void;
}

export interface LeafletOverlays {
    set(id: string, state: LeafletOverlayState): void;
    scenes(next: readonly OverlayScene[], opacity: number): void;
    scenes(next: unknown, opacity: number): void;
    clearSentinel(): void;
    retry(id: string): void;
    stations(next: SnotelMapStation[], options?: { selectable?: Set<string>; onSelect?: (stationId: string) => void }): void;
    dispose(): void;
}

interface TileRecord {
    id: string;
    coordinates: OverlayTile;
    canvas: HTMLCanvasElement;
    done: (error: unknown, tile: HTMLCanvasElement) => void;
    failed: boolean;
    loaded: boolean;
}

export function createLeafletOverlays({ win, map, onError, onActivity, bridgeWindow = win, onWildfireStatus = () => {} }: LeafletOverlaysOptions): LeafletOverlays {
    const L = win.L, layers = new Map<string, LeafletGridLayer>(), controllers = new Map<HTMLCanvasElement, AbortController>();
    const records = new Map<HTMLCanvasElement, TileRecord>(), states = new Map<string, LeafletOverlayState>();
    const fetchBCTile = createPageBCTileFetch(bridgeWindow as unknown as Parameters<typeof createPageBCTileFetch>[0]);
    const tiles = createOverlayTiles({ document: win.document, fetchImpl: win.fetch.bind(win), fetchBCTile, onError, onActivity });
    const z: Record<string, number> = { sentinel: 250, land: 260, snow: 265, slope: 270 };
    let wildfire: ReturnType<typeof createLeafletWildfires> | null = null;
    let stations: LeafletLayerGroup | null = null, stationPopups: { station: SnotelMapStation; content: HTMLDivElement }[] = [];
    let stationKey = '', hasScenes = false;
    const draw = (record: TileRecord) => {
        const { id, coordinates, canvas, done } = record, controller = new AbortController();
        controllers.set(canvas, controller); record.failed = false;
        tiles.draw(id, coordinates, canvas, controller.signal).then(() => {
            record.failed = tiles.failed(id, coordinates);
            if (records.get(canvas) === record && controllers.get(canvas) === controller && !record.loaded) {
                // Leaflet's ready callback restarts its tile fade. A canvas
                // already on screen only needs its pixels replaced, once.
                record.loaded = true; done(null, canvas);
            }
        }, (error: unknown) => {
            if (records.get(canvas) !== record || controllers.get(canvas) !== controller) return;
            // A provider cooldown also aborts neighboring visible requests.
            // Those holes need retry too; unloaded records were removed above.
            record.failed = true; if (!record.loaded) done(error, canvas);
        }).finally(() => { if (controllers.get(canvas) === controller) controllers.delete(canvas); });
    };
    const remove = (id: string) => {
        const layer = layers.get(id); if (layer) { map.removeLayer(layer); layers.delete(id); }
        tiles.cancel(id);
    };
    const add = (id: string): LeafletGridLayer => {
        const pane = `bpb-overlay-${id}`;
        if (!map.getPane(pane)) { map.createPane(pane); map.getPane(pane)!.style.cssText = `z-index:${z[id]};pointer-events:none`; }
        const Grid = L.GridLayer.extend({
            createTile(coordinates: OverlayTile, done: (error: unknown, tile: HTMLCanvasElement) => void) {
                const canvas = tiles.canvas(), record: TileRecord = { id, coordinates, canvas, done, failed: false, loaded: false };
                records.set(canvas, record); draw(record);
                return canvas;
            },
        });
        const layer = new Grid({ pane, tileSize: 256, minZoom: OVERLAY_MIN_ZOOM, maxNativeZoom: id === 'sentinel' ? 14 : id === 'snow' ? SNOW_DEPTH_MAX_ZOOM : 15,
            maxZoom: 24, keepBuffer: 1, updateWhenIdle: true, bpbOverlay: true,
            attribution: id === 'sentinel' ? SENTINEL_ATTRIBUTION : OVERLAY_ATTRIBUTION[id as keyof typeof OVERLAY_ATTRIBUTION] });
        layer.on('tileunload', event => {
            controllers.get(event.tile)?.abort(); controllers.delete(event.tile);
            const record = records.get(event.tile); records.delete(event.tile);
            if (record) tiles.forget(id, record.coordinates);
        });
        layers.set(id, layer); layer.addTo(map); return layer;
    };
    return {
        set(id, state) {
            if (id === 'wildfire') {
                if (!wildfire && state.enabled) {
                    wildfire = createLeafletWildfires({
                        win: win as unknown as Parameters<typeof createLeafletWildfires>[0]['win'],
                        map: map as unknown as Parameters<typeof createLeafletWildfires>[0]['map'],
                        document: bridgeWindow.document,
                        onStatus: onWildfireStatus,
                    });
                }
                wildfire?.update(state); return;
            }
            if (id === 'snotel') return;
            states.set(id, { ...state });
            if (id === 'snow') tiles.cooldown(id, state.retryAt);
            if (id === 'land') {
                tiles.landCooldowns(state.providerCooldowns);
                // An explicit filter change must remove deselected pixels,
                // even if a replacement fails. Ordinary pans retain tiles.
                if (tiles.setLandTypes(state.landTypes)) remove(id);
            }
            if (!state.enabled || state.opacity === 0 || id === 'land' && state.landTypes?.length === 0) { remove(id); return; }
            if ((state.retryAt ?? 0) > Date.now() && !layers.has(id) && !(id === 'land' && Object.keys(state.providerCooldowns || {}).length)) return;
            if (id === 'sentinel' && !hasScenes) return; // Wait for a validated capture.
            (layers.get(id) || add(id)).setOpacity(state.opacity / 100);
        },
        scenes(next: unknown, opacity: number) {
            const list = Array.isArray(next) ? next as OverlayScene[] : [];
            hasScenes = list.length > 0; states.set('sentinel', { enabled: hasScenes, opacity }); tiles.setScenes(list);
            if (!hasScenes || opacity === 0) { remove('sentinel'); return; }
            const layer = layers.get('sentinel');
            // Panning can change the selected pass's scene mosaic. Keep the
            // loaded canvases attached until each replacement paints in place.
            if (layer) for (const record of records.values()) if (record.id === 'sentinel') draw(record);
            (layer || add('sentinel')).setOpacity(opacity / 100);
        },
        clearSentinel() { remove('sentinel'); hasScenes = false; tiles.setScenes([]); },
        retry(id) {
            if (id === 'wildfire') { wildfire?.retry(); return; }
            const state = states.get(id);
            if (!state?.enabled || state.opacity === 0 || (state.retryAt ?? 0) > Date.now()
                || id === 'land' && state.landTypes?.length === 0 || id === 'sentinel' && !hasScenes) return;
            if (!tiles.retry(id)) return;
            if (!layers.has(id)) { add(id).setOpacity(state.opacity / 100); return; }
            const visible = [...records.values()].filter(record => record.id === id);
            const failed = visible.filter(record => record.failed);
            // Retry only holes. An explicit Reload refreshes in place, leaving
            // each successful canvas painted until its replacement is ready.
            for (const record of failed.length ? failed : visible) draw(record);
        },
        stations(next, { selectable = new Set<string>(), onSelect } = {}) {
            const key = JSON.stringify(next);
            if (key === stationKey) {
                for (const { station, content } of stationPopups) updateSnotelPopupAction(content, station, selectable.has(station.id) ? onSelect : undefined);
                return;
            }
            stationKey = key; stationPopups = [];
            if (stations) { map.removeLayer(stations); stations = null; }
            if (!next.length) return;
            const group = L.layerGroup();
            stations = group;
            for (const station of next) {
                const content = win.document.createElement('div'); content.append(snotelSymbol(win.document));
                const icon = L.divIcon({ className: 'bpb-snotel-marker', html: content, iconSize: [24, 24], iconAnchor: [12, 12] });
                const popup = snotelPopup(win.document, station, selectable.has(station.id) ? onSelect : undefined);
                stationPopups.push({ station, content: popup });
                L.marker([station.latitude, station.longitude], { icon, title: `${station.name} · SNOTEL`, keyboard: true, bpbOverlay: true })
                    .bindPopup(popup, { maxWidth: 240 }).addTo(group);
            }
            group.addTo(map);
        },
        dispose() {
            wildfire?.dispose();
            for (const id of [...layers.keys()]) remove(id);
            if (stations) map.removeLayer(stations);
            for (const controller of controllers.values()) controller.abort();
            controllers.clear(); tiles.dispose(); fetchBCTile.dispose();
        },
    };
}
