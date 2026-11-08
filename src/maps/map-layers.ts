// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createCustomOverlayControl } from './custom-overlay-control.js';
import { settingsSchema as Schema } from '../settings/settings-schema.ts';
import { createMapLayerControl } from './map-layer-control.ts';
import { createLeafletOverlays } from './map-overlay-leaflet.js';
import { createSentinelSession } from './sentinel-session.js';
import { createSnowDepthMetadata, SNOW_DEPTH_LEGEND } from './snow-depth.js';
import { WILDFIRE_LEGEND } from './wildfire-core.js';
import { sentinelTarget } from './sentinel-core.js';
import { OVERLAY_MIN_ZOOM, SLOPE_BANDS, publicLandInfo, overlayBounds, rasterTileStatus, viewportStations, mapOverlayCoverage } from './map-overlay-providers.js';
import { readLayerSnapshot, readLayerStatus, mergeLandCooldowns, readAttributionInset } from './map-layer-protocol.ts';
import { readSnotelMapStations } from '../snow/snotel-map-data.js';
import { createSnotelMapReveal } from '../snow/snotel-map-view.js';
import { createMapFrameLifecycle } from '../gpx/map-frame-lifecycle.js';
import { createPageLifecycle } from '../ui/page-lifecycle.ts';
import { createMapLocationMenu } from './map-location-menu.ts';
import { bindMapLocationMenu } from './peak-weather-map.js';

interface OverlayState { enabled: boolean; opacity: number; }
interface OverlayStatus {
    legend?: string; legendEntries?: { label: string; color: string; value?: string }[]; retryAt?: number; pending?: boolean; error?: boolean;
    retry?: boolean; saved?: boolean; overflow?: boolean; count?: number; message?: string; partial?: boolean; permission?: boolean;
    providerCooldowns?: Record<string, number>; unavailable?: boolean; metadataRetryAt?: number; metadataPending?: boolean; guidanceKeys?: (string | false)[]; [field: string]: unknown;
}
// The minimal page-owned Leaflet contract this owner reads.
interface LayerMap {
    getContainer(): HTMLElement; getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
    getCenter(): { lat: number; lng: number }; getZoom(): number;
    on(type: string, listener: (event?: unknown) => void): unknown; off(type: string, listener: (event?: unknown) => void): unknown;
    __bpbOverlayOwner?: unknown; __bpbOverlayRemoved?: boolean;
}
type MapOwnerWindow = Window & typeof globalThis & {
    mapsPlaceholder?: LayerMap; map?: LayerMap; L?: { GridLayer?: unknown; marker?: unknown }; [leafletMaps: symbol]: LayerMap[] | undefined;
};
interface MapBinding {
    win: MapOwnerWindow; frame: HTMLIFrameElement | null; map: LayerMap; moving: boolean; observer?: ResizeObserver;
    engine: ReturnType<typeof createLeafletOverlays>; sentinel: ReturnType<typeof createSentinelSession>;
    unbindLocation(): void; moveStarted(): void; unloaded(): void;
}
interface TerrainView { bounds: number[]; zoom: number; footer: number; }

const MAP_PAGES = /\/(?:ascent|peak|bigmap)\.aspx$/i;
const FRAME_SELECTOR = 'iframe#if, iframe[src*="MasterMap.aspx" i]';
export function installMapLayers(win = window as MapOwnerWindow, { fixedMap = null, secondary = false }: { fixedMap?: LayerMap | null; secondary?: boolean } = {}) {
    const doc = win.document;
    // An embedded MasterMap's outer page owns controls even before its map has
    // loaded. Standalone MasterMap and other native map shells own themselves.
    try { if (!fixedMap && win.parent !== win && MAP_PAGES.test(win.parent.location.pathname) && win.parent.document.querySelector(FRAME_SELECTOR) === win.frameElement) return null; } catch { /* Standalone owner. */ }
    const locationMenu = createMapLocationMenu({ window: win });
    const state = Schema.mapOverlayState() as Record<string, OverlayState>;
    let custom: ReturnType<typeof createCustomOverlayControl> | null = null, handoffActive = !secondary;
    let touched = false, preferencesReady = false, revision = 1, capture: unknown = null, landTypes = Schema.mapLandTypes();
    let binding: MapBinding | null = null, polling: number | null = null, frameMode = false, active = true, disposed = false;
    let terrainView: TerrainView | null = null, snotelAllowed = false, requestId = 0, stations: { id: string }[] = [], coverage: Record<string, boolean> | null = null;
    let stationTimer: number | null = null, relayFrame: number | null = null;
    let cardAvailable = false, nearbyRequest = 900000000, nearbyPending = false, nearbyReady = false;
    let revealPending = false, terrainMoving = false;
    let landViewKey = '', landInfo: OverlayStatus | null = null;
    const revealOcclusions = () => {
        const target = frameMode ? doc.getElementById('bpb-terrain-frame') : binding?.frame || binding?.map.getContainer?.();
        const bounds = target?.getBoundingClientRect();
        if (!bounds?.width || !bounds.height || control.element.hidden) return [];
        const menu = control.element.querySelector('.bpb-layers-panel');
        const trigger = control.trigger.getBoundingClientRect(), rect = control.isOpen() ? menu!.getBoundingClientRect() : trigger;
        const overlay = {left:Math.min(rect.left,trigger.left),top:Math.min(rect.top,trigger.top),right:Math.max(rect.right,trigger.right),bottom:Math.max(rect.bottom,trigger.bottom)};
        const chrome = [...doc.querySelectorAll('#bpb-terrain-toggle, .bpb-map-compass')].map(node => node.getBoundingClientRect())
            .filter(box => box.width > 0 && box.height > 0);
        return [overlay, ...chrome].slice(0, 8).map(box => [(box.left - bounds.left) / bounds.width, (box.top - bounds.top) / bounds.height,
            (box.right - bounds.left) / bounds.width, (box.bottom - bounds.top) / bounds.height].map(value => Math.max(0, Math.min(1, value))))
            .filter(box => box[0] < box[2] && box[1] < box[3]);
    };
    const nativeReveal = createSnotelMapReveal({ window: win, getMap: () => binding?.map, getOcclusions: revealOcclusions } as Parameters<typeof createSnotelMapReveal>[0]);
    const cancelReveal = () => { revealPending = false; nativeReveal.cancel(); };
    const navigationStarted = () => {
        if (!revealPending) return;
        cancelReveal(); requestId++; post({ type: 'cancel' });
    };
    const selectable = new Set<string>();
    let snowInfo: OverlayStatus = {};
    const statuses: Record<string, OverlayStatus> = {
        snow: { legend: SNOW_DEPTH_LEGEND },
        wildfire: { legend: WILDFIRE_LEGEND },
        sentinel: { legend: 'Copernicus Sentinel-2 · Microsoft Planetary Computer. Scene clouds can obscure coverage.' },
        slope: { legend: 'USGS 3DEP · Below 20° and no data are clear. Ground slope; resolution varies. Not an avalanche forecast.',
            legendEntries: SLOPE_BANDS.map(band => ({ label: band.to === 91 ? '≥45°' : `${band.from}–${band.to}°`, color: `rgb(${band.color.join(',')})` })) },
        land: publicLandInfo(null),
        snotel: { legend: 'NRCS active stations in the visible map. Station observations may differ from route conditions.' },
    };
    const post = (detail: { type: string; [field: string]: unknown }) => { if (detail.type !== 'handoffState' || handoffActive) win.postMessage({ __bpbMapLayers: true, dir: 'toCS', ...detail }, win.location.origin); };
    const terrain = (type: string, detail: Record<string, unknown> = {}) => win.postMessage({ __bpbTerrain: true, dir: 'toCS', type, ...detail }, win.location.origin);
    const snowCard = (detail: Record<string, unknown>) => win.postMessage({ __bpbPeakSnow: true, dir: 'toCS', ...detail }, win.location.origin);
    const snowMetadata = createSnowDepthMetadata({ fetchImpl: win.fetch.bind(win), onStatus: (info: OverlayStatus) => {
        snowInfo = info;
        if (info.metadataRetryAt! > Date.now()) {
            statuses.snow.retryAt = Math.max(statuses.snow.retryAt || 0, info.metadataRetryAt!);
            if (!frameMode) binding?.engine.set('snow', { ...state.snow, retryAt: statuses.snow.retryAt });
            relay();
        }
        paint();
    } });
    const frameLifecycle = createMapFrameLifecycle({ document: doc, MutationObserver: win.MutationObserver, selector: FRAME_SELECTOR } as Parameters<typeof createMapFrameLifecycle>[0]);
    const theme = () => doc.documentElement.dataset.bpbTheme === 'dark' || doc.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const paint = () => {
        const bounds = stationView();
        if (bounds) {
            const key = JSON.stringify(bounds);
            if (key !== landViewKey) { landViewKey = key; landInfo = publicLandInfo(bounds); }
            const info = landInfo;
            if (statuses.land.permission && !info!.guidanceKeys!.includes('bc')) statuses.land = { ...statuses.land, permission: false, pending: false, error: false, retry: false, message: '' };
            statuses.land = { ...statuses.land, ...info };
        }
        control.render({ state, landTypes, statuses: { ...statuses, snow: { ...statuses.snow, ...snowInfo, pending: statuses.snow.pending === true || snowInfo.metadataPending === true, retry: true } } as unknown as Parameters<typeof control.render>[0]['statuses'], coverage: coverage!, theme: theme(), zoom: frameMode ? terrainView?.zoom : binding?.map.getZoom() });
        custom?.refresh(); position();
    };
    const snapshot = () => ({ revision, state, landTypes, capture, menuOpen: control.isOpen(), landCooldowns: statuses.land.providerCooldowns,
        cooldowns: Object.fromEntries(Schema.MAP_OVERLAY_IDS.map(id => [id, statuses[id]?.retryAt || 0])), ...custom?.snapshot() });
    const relay = () => {
        if (relayFrame !== null) return;
        // Keep the parked bridge current too. Otherwise its loaded replay could
        // briefly reactivate an overlay the user turned off while in 2D.
        relayFrame = win.requestAnimationFrame(() => { relayFrame = null; terrain('layers', { snapshot: snapshot() }); });
    };
    const save = () => post({ type: 'save', preferences: { ...Object.fromEntries(Schema.MAP_OVERLAY_IDS.map(id => [id, state[id].opacity])), landTypes } });
    const stationView = () => {
        if (frameMode) return terrainView?.bounds;
        const bounds = binding?.map.getBounds();
        return bounds ? overlayBounds([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]) : null;
    };
    const reconcileCoverage = () => {
        coverage = mapOverlayCoverage(stationView());
        let changed = false;
        for (const id of Schema.MAP_OVERLAY_IDS) if (coverage?.[id] === false && state[id].enabled) {
            state[id].enabled = false; changed = true;
            if (id === 'snotel') {
                cancelReveal(); requestId++; post({ type: 'cancel' }); stations = [];
                nearbyPending = false; nearbyRequest++; snowCard({ type: 'cancel' });
                statuses.snotel = { ...statuses.snotel, pending: false, saved: false, overflow: false, count: 0 };
            }
        }
        if (changed) revision++;
    };
    const sendStations = (reveal = false) => {
        const shown = state.snotel.enabled && active ? stations : [];
        if (frameMode) terrain('snowStations', { snowStations: shown, reveal: reveal && shown.length > 0, occlusions: revealOcclusions(),
            conditions: shown.filter(station => selectable.has(station.id)).map(station => station.id) });
        else {
            binding?.engine.stations(shown, { selectable, onSelect: (stationId: string) => snowCard({ type: 'select', stationId }) } as Parameters<MapBinding['engine']['stations']>[1]);
            if (reveal && shown.length) nativeReveal.show(shown);
        }
    };
    const loadNearby = () => {
        if (!active || !state.snotel.enabled || !snotelAllowed || !cardAvailable || nearbyPending || nearbyReady) return;
        nearbyPending = true; snowCard({ type: 'get', requestId: ++nearbyRequest });
    };
    const loadStations = () => {
        clearTimeout(stationTimer!); stationTimer = null;
        const bounds = stationView();
        if (!active || !state.snotel.enabled || !snotelAllowed || !bounds || statuses.snotel.retryAt! > Date.now()) return;
        requestId++; post({ type: 'cancel' });
        loadNearby();
        statuses.snotel = { ...statuses.snotel, pending: true, error: false, retry: statuses.snotel.retry === true, message: 'Loading stations…' }; paint();
        post({ type: 'stations', requestId, bounds, reveal: revealPending });
    };
    const refresh = (event?: unknown) => {
        if (event && binding) binding.moving = false;
        if (event && revealPending) { cancelReveal(); requestId++; post({ type: 'cancel' }); }
        apply();
        if (!frameMode) binding?.sentinel.refresh();
        clearTimeout(stationTimer!); stationTimer = win.setTimeout(loadStations, 300);
    };
    const apply = (opacityId: string | null = null) => {
        // An opacity input does not change the viewport or station membership.
        // Keep it synchronous without revisiting unrelated providers/popups.
        if (!opacityId) reconcileCoverage();
        relay();
        if (!opacityId || opacityId === 'snow') snowMetadata.update(active && state.snow.enabled && state.snow.opacity > 0 && coverage?.snow !== false
            && ((frameMode ? terrainView?.zoom : binding?.map.getZoom()) ?? -Infinity) >= OVERLAY_MIN_ZOOM);
        if (!frameMode && active && binding) {
            for (const id of opacityId ? [opacityId] : ['sentinel', 'land', 'snow', 'slope', 'wildfire']) binding.engine.set(id, { ...state[id], landTypes, retryAt: statuses[id].retryAt, providerCooldowns: statuses[id].providerCooldowns });
            if (!opacityId || opacityId === 'sentinel') {
                binding.sentinel.cooldown(statuses.sentinel.retryAt);
                if (state.sentinel.enabled && state.sentinel.opacity > 0) binding.sentinel.activate(capture);
                else binding.sentinel.deactivate();
            }
        }
        if (!opacityId) sendStations();
        paint();
        post({ type: 'handoffState', snapshot: snapshot() });
    };
    const changed = (opacityId?: string) => { touched = true; revision++; apply(opacityId); };
    const control = createMapLayerControl({ document: doc,
        getFooterInset() {
            if (frameMode) return readAttributionInset(terrainView?.footer) * (doc.getElementById('bpb-terrain-frame')?.getBoundingClientRect().height || 0);
            const container = binding?.map.getContainer?.(), logo = container?.querySelector('.bpb-vector-maptoolkit-logo:not([hidden])');
            if (!logo) return 0;
            const bounds = container!.getBoundingClientRect(), footer = logo.getBoundingClientRect();
            const scale = binding!.frame && bounds.height > 0 ? binding!.frame.getBoundingClientRect().height / bounds.height : 1;
            return (bounds.bottom - footer.top + 8) * scale;
        },
        onToggle(id: string, enabled: boolean) {
            if (coverage?.[id] === false) { paint(); return; }
            state[id].enabled = enabled;
            if (id === 'snotel') {
                cancelReveal(); revealPending = enabled && !(frameMode ? terrainMoving : binding?.moving);
                requestId++; post({ type: 'cancel' }); stations = [];
                statuses.snotel.saved = false; statuses.snotel.overflow = false; statuses.snotel.count = 0;
                if (!enabled) { nearbyPending = false; nearbyRequest++; snowCard({ type: 'cancel' }); statuses.snotel.pending = false; }
            }
            changed(); if (id === 'snotel' && enabled) loadStations();
        },
        onOpacity(id: string, opacity: number) { state[id].opacity = opacity; changed(id); }, onCommit: save,
        onLandTypes(value: string[]) {
            const selected = Schema.mapLandTypes(value);
            if (JSON.stringify(selected) === JSON.stringify(landTypes)) return;
            landTypes = selected;
            statuses.land = { ...statuses.land, pending: false, error: false, retry: false, partial: false, permission: false, message: '', retryAt: 0 };
            changed('land'); save();
        },
        onCapture(value: string) {
            if (coverage?.sentinel === false) return;
            if (frameMode) terrain('layerAction', { action: 'capture', id: 'sentinel', capture: value });
            else binding?.sentinel.select(value);
        },
        onRetry(id: string) {
            if (coverage?.[id] === false || !state[id].enabled) return;
            if (id === 'snow') snowMetadata.retry();
            if (id === 'snotel') loadStations();
            else if (frameMode) {
                statuses[id] = { ...statuses[id], pending: true, error: false, retry: true,
                    message: id === 'wildfire' ? 'Loading fire reports…' : id === 'sentinel' ? 'Finding captures…' : id === 'land' ? 'Loading public lands' : id === 'snow' ? 'Loading snow depth' : 'Loading slope shading' };
                paint(); terrain('layerAction', { action: 'retry', id });
            }
            else if (id === 'sentinel') binding?.sentinel.retry();
            else { statuses[id] = { ...statuses[id], pending: true, error: false, permission: false, retry: true,
                message: id === 'wildfire' ? 'Loading fire reports…' : id === 'land' ? 'Loading public lands' : id === 'snow' ? 'Loading snow depth' : 'Loading slope shading' }; binding?.engine.retry(id); paint(); }
        },
        onOpen() { relay(); },
    });
    custom = createCustomOverlayControl({ win, panel: control.element.querySelector('.bpb-layers-panel'), onChange: () => { revision++; relay(); post({ type: 'handoffState', snapshot: snapshot() }); },
        readView: () => frameMode && terrainView ? { ...terrainView, center: { lat: (terrainView.bounds[1] + terrainView.bounds[3]) / 2, lng: (terrainView.bounds[0] + terrainView.bounds[2]) / 2 } }
            : binding ? { center: binding.map.getCenter(), zoom: binding.map.getZoom() } : null });
    const activateMap = () => win.dispatchEvent(new win.CustomEvent('bpb-map-owner', { detail: { mapId: custom.mapId } }));
    const activeMap = (event: Event) => { handoffActive = (event as CustomEvent).detail?.mapId === custom!.mapId; if (handoffActive) post({ type: 'handoffState', snapshot: snapshot() }); };
    control.element.addEventListener('pointerdown', activateMap); control.element.addEventListener('focusin', activateMap);
    win.addEventListener('bpb-map-owner', activeMap);
    control.element.hidden = true; doc.body.append(control.element);
    const position = () => {
        // A visible control could mark defaults as user-owned before the
        // isolated bridge delivers saved opacity. Its absolute overlay occupies
        // no native layout space while the initial read is pending.
        if (!preferencesReady) { control.element.hidden = true; return; }
        const target = (frameMode && doc.getElementById('bpb-terrain-frame'))
            || binding?.frame || binding?.map.getContainer?.();
        if (!target) { control.element.hidden = true; return; }
        const rect = target.getBoundingClientRect();
        control.position(rect);
    };
    const unbind = () => {
        nativeReveal.cancel(); custom?.suspend();
        if (!binding) return;
        binding.map.off('moveend', refresh);
        binding.map.off('movestart', binding.moveStarted);
        binding.map.off('unload', binding.unloaded);
        binding.map.getContainer().removeEventListener('pointerdown', activateMap);
        binding.unbindLocation();
        binding.observer?.disconnect(); binding.sentinel.dispose(); binding.engine.dispose();
        if (binding.map.__bpbOverlayOwner === win) delete binding.map.__bpbOverlayOwner;
        binding = null;
    };
    const bind = () => {
        if (!active || disposed || frameMode) return false;
        const frame = frameLifecycle.current();
        const candidates: { win: MapOwnerWindow; frame: HTMLIFrameElement | null }[] = [];
        try { if (!fixedMap && frame?.contentWindow) candidates.push({ win: frame.contentWindow as MapOwnerWindow, frame: frame as HTMLIFrameElement }); } catch { /* Wait for replacement. */ }
        candidates.push({ win, frame: null });
        for (const candidate of candidates) {
            try {
                const owner = candidate.win, map = (fixedMap ? [fixedMap] : [owner.mapsPlaceholder, owner.map, ...owner[Symbol.for('bpb.leafletMaps')] || []]).find(item => !item?.__bpbOverlayRemoved && (item as { getBounds?: unknown } | undefined)?.getBounds && (item as { eachLayer?: unknown } | undefined)?.eachLayer && (item as { on?: unknown } | undefined)?.on && (item as { off?: unknown } | undefined)?.off && (!item!.__bpbOverlayOwner || item!.__bpbOverlayOwner === win || candidate.frame));
                if (!map || !owner.L?.GridLayer || !owner.L?.marker) continue;
                if (binding?.map === map && binding.win.document === owner.document) { position(); return true; }
                const claim = map.__bpbOverlayOwner;
                if (claim && claim !== win) {
                    if (candidate.frame && claim === candidate.win) candidate.win.dispatchEvent(new candidate.win.CustomEvent('bpb-overlay-yield', { detail: { map } }));
                    else continue;
                }
                unbind(); map.__bpbOverlayOwner = win;
                const engine = createLeafletOverlays({ win: owner, bridgeWindow: win, map, onWildfireStatus(status: OverlayStatus) {
                    if (!active || frameMode) return;
                    const previous = statuses.wildfire.retryAt || 0;
                    statuses.wildfire = { ...statuses.wildfire, ...status, retryAt: Math.max(previous, status.retryAt || 0) };
                    paint();
                    if (status.retryAt! > Date.now() && status.retryAt !== previous) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
                }, onError(id: string, error: { code?: string; retryAt?: number } | null | undefined) {
                    if (id === 'sentinel') binding?.sentinel.tileError(error);
                    else if (id === 'land') return; // Complete provider outcomes supply land feedback below.
                    else { statuses[id] = { ...statuses[id], pending: false, error: true, retry: true, permission: error?.code === 'bc-permission-required', retryAt: Math.max(statuses[id].retryAt || 0, error?.retryAt || 0),
                        message: error?.code === 'bc-permission-required' ? 'Allow BC parcel maps.' : 'Some map tiles are unavailable. Retry.' }; paint();
                    if ((error?.retryAt ?? 0) > Date.now()) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); } }
                }, onActivity(id: string, activity: { error?: boolean; pending?: boolean }) {
                    if (!active || frameMode || !state[id].enabled || state[id].opacity === 0) return;
                    if (id === 'sentinel') binding?.sentinel.tileActivity(activity);
                    else {
                        if (['slope', 'snow'].includes(id) && statuses[id].retryAt! > Date.now()) return;
                        const previous = JSON.stringify(statuses.land.providerCooldowns);
                        statuses[id] = { ...statuses[id], ...rasterTileStatus(id, activity),
                            retry: activity.error || activity.pending && statuses[id].retry === true };
                        paint();
                        if (id === 'land' && previous !== JSON.stringify(statuses.land.providerCooldowns)) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
                    }
                } } as Parameters<typeof createLeafletOverlays>[0]);
                const sentinel = createSentinelSession({ readView: () => ({ bounds: map.getBounds(), zoom: map.getZoom() }), fetchImpl: owner.fetch.bind(owner),
                    replaceScenes: (scenes: unknown) => engine.scenes(scenes, state.sentinel.opacity), clearScenes: () => engine.clearSentinel(),
                    retryTiles: () => engine.retry('sentinel'),
                    onStatus: (status: OverlayStatus) => {
                        const previous = statuses.sentinel.retryAt;
                        statuses.sentinel = { ...statuses.sentinel, ...status, retryAt: Math.max(previous || 0, status.retryAt || 0) }; paint(); if (!status.pending && status.message) control.announce(status.message);
                        if (status.retryAt! > Date.now() && status.retryAt !== previous) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
                    },
                    onCapture: (target: unknown) => { capture = target; revision++; relay(); post({ type: 'handoffState', snapshot: snapshot() }); },
                } as Parameters<typeof createSentinelSession>[0]);
                const unbindLocation = bindMapLocationMenu({ ownerWindow: owner, map, frame: candidate.frame, menu: locationMenu });
                const moveStarted = () => { if (binding?.map === map) binding.moving = true; custom?.cancelTasks(); navigationStarted(); };
                const unloaded = () => { map.__bpbOverlayRemoved = true; if (secondary) lifecycle.dispose(); else { unbind(); control.element.hidden = true; start(); } };
                binding = { ...candidate, map, engine, sentinel, unbindLocation, moveStarted, unloaded, moving: false };
                map.on('movestart', moveStarted);
                map.on('moveend', refresh);
                map.on('unload', unloaded); map.getContainer().addEventListener('pointerdown', activateMap);
                if (win.ResizeObserver) {
                    const observer = new win.ResizeObserver(position); binding.observer = observer;
                    // Expanding preceding content can move a same-size map.
                    // Keep body-mounted controls anchored through those reflows.
                    for (let target: Element | null = candidate.frame || map.getContainer(); target; target = target.parentElement) observer.observe(target);
                }
                custom?.mode(false); custom?.bind(owner, map); apply(); refresh(); return true;
            } catch (error) { console.warn('Better Peakbagger: map layers could not bind', error); unbind(); }
        }
        if (binding && (!binding.frame?.isConnected || binding.win.document !== binding.map.getContainer()?.ownerDocument)) unbind();
        return false;
    };
    const stopPolling = () => { clearInterval(polling!); polling = null; };
    const start = () => {
        stopPolling(); if (!active || disposed || frameMode || bind()) return;
        const began = Date.now(); polling = win.setInterval(() => { if (bind() || Date.now() - began >= 30000) stopPolling(); }, 250);
    };
    const handle = (event: MessageEvent) => {
        const data = event.data;
        if (event.source !== win || event.origin !== win.location.origin || !data || !active) return;
        if (data.__bpbMapLocation === true) {
            if (data.type === 'dismiss') locationMenu.close();
            else if (data.type === 'context' && data.map === 'terrain' && frameMode) {
                locationMenu.show(data, doc.getElementById('bpb-terrain-frame')!);
            }
            return;
        }
        if (data.__bpbPeakSnow === true && data.dir === 'toPage') {
            if (data.type === 'availability') {
                cardAvailable = data.enabled === true;
                if (!cardAvailable) { selectable.clear(); nearbyReady = nearbyPending = false; nearbyRequest++; sendStations(); }
                else loadNearby();
            }
            if (data.type === 'stations' && data.requestId === nearbyRequest && cardAvailable && state.snotel.enabled && snotelAllowed) {
                nearbyPending = false; selectable.clear();
                const nearby = data.error === true ? null : readSnotelMapStations(data.stations);
                nearbyReady = nearby !== null;
                for (const station of nearby || []) selectable.add(station.id);
                sendStations();
            }
        }
        if (data.__bpbMapLayers === true && data.dir === 'toPage') {
            if (data.type === 'bcPermission') {
                statuses.land.pending = data.pending === true;
                if (!statuses.land.pending) {
                    statuses.land.permission = data.ok !== true; statuses.land.error = data.ok !== true;
                    statuses.land.retry = data.ok !== true;
                    statuses.land.message = data.ok ? '' : data.setup === true ? 'Allow BC maps in opened tab.' : 'BC access not granted.';
                    if (data.ok && state.land.enabled) {
                        if (frameMode) terrain('layerAction', { action: 'retry', id: 'land' }); else binding?.engine.retry('land');
                    }
                }
                paint(); return;
            }
            if (data.type === 'handoff' && !touched) {
                const next = readLayerSnapshot(data.snapshot);
                if (next) {
                    statuses.land.providerCooldowns = mergeLandCooldowns(statuses.land.providerCooldowns, next.landCooldowns);
                    custom?.adopt(next.custom); Object.assign(state, next.state); capture = next.capture; landTypes = next.landTypes;
                    for (const id of Schema.MAP_OVERLAY_IDS) if (next.cooldowns[id] > Date.now()) statuses[id] = { ...statuses[id], retryAt: Math.max(statuses[id].retryAt || 0, next.cooldowns[id]), error: true, retry: true, message: 'Map service is busy. Try again later.' };
                    changed(); loadStations();
                }
            } else if (data.type === 'preferences') {
                locationMenu.setUnits({ units: data.units, elevationUnits: data.elevationUnits });
                preferencesReady = true;
                if (!touched) { const preferences = Schema.mapOverlayPreferences(data.preferences) as unknown as Record<string, number> & { landTypes: string[] }; for (const id of Schema.MAP_OVERLAY_IDS) state[id].opacity = preferences[id]; landTypes = preferences.landTypes; }
                const wasAllowed = snotelAllowed; snotelAllowed = data.snotel === true;
                statuses.snotel.unavailable = !snotelAllowed;
                if (!snotelAllowed) statuses.snotel.message = 'Enable Show SNOTEL in settings.';
                else if (!wasAllowed) statuses.snotel.message = '';
                if (!snotelAllowed) { cancelReveal(); state.snotel.enabled = false; stations = []; requestId++; }
                apply(); if (!wasAllowed && state.snotel.enabled) loadStations();
            } else if (data.type === 'stations' && data.requestId === requestId && state.snotel.enabled && snotelAllowed) {
                const next = readSnotelMapStations(data.stations);
                let reveal = false;
                if (data.error === true || !next) {
                    const visible = viewportStations(stations, stationView());
                    statuses.snotel = { ...statuses.snotel, pending: false, error: true, retry: true, saved: visible.length > 0, overflow: false, count: visible.length,
                        message: visible.length ? 'Showing loaded locations.' : 'Couldn’t load station locations. Try again.',
                        retryAt: Math.max(statuses.snotel.retryAt || 0, Number.isFinite(data.retryAt) ? data.retryAt : 0) };
                }
                else {
                    stations = next; reveal = revealPending; revealPending = false;
                    statuses.snotel = { ...statuses.snotel, pending: false, error: false, retry: false, saved: false, overflow: data.overflow === true, count: next.length,
                        message: data.overflow === true ? 'More than 50 stations. Zoom in.'
                            : data.nearby === true ? next.length ? `${next.length} nearby stations.` : 'No SNOTEL stations within 50 km.'
                                : next.length ? `${next.length} stations in view.` : 'No SNOTEL stations in view.' };
                }
                sendStations(reveal); paint();
                control.announce(statuses.snotel.message!);
                if (statuses.snotel.retryAt! > Date.now()) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
            }
        }
        if (data.__bpbTerrain !== true || secondary) return;
        if (data.dir === 'toPage' && data.type === 'customTaskReply') { custom?.taskReply(data); return; }
        if (data.dir === 'toPage' && data.type === 'customLayerStatus') { custom?.status(data.id, data.status); return; }
        if (data.dir === 'toCS' && data.type === 'init') {
            // The native map stays up, overlays included, until 3D covers it.
            locationMenu.close();
        } else if (data.dir === 'toPage' && data.type === 'loaded') {
            stopPolling();
            custom?.mode(true);
            // Recreate the native adapter only when returning to 2D.
            unbind();
            requestId++; post({ type: 'cancel' });
            frameMode = true; terrainMoving = false; revision++; apply(); loadStations();
        } else if (data.dir === 'toPage' && ['destroyed', 'error'].includes(data.type)) {
            custom?.mode(false); frameMode = terrainMoving = false; terrainView = null; revision++; start(); apply(); refresh();
        } else if (data.dir === 'toPage' && data.type === 'layerMoveStart' && frameMode) {
            terrainMoving = true; navigationStarted();
        } else if (data.dir === 'toPage' && data.type === 'layerStatus' && frameMode) {
            const status = readLayerStatus(data); if (status && status.revision === revision) {
                const previous = statuses[status.id].retryAt, previousLand = JSON.stringify(statuses.land.providerCooldowns);
                statuses[status.id] = { ...statuses[status.id], ...status,
                    retryAt: status.id === 'land' ? status.retryAt : Math.max(previous || 0, status.retryAt),
                    providerCooldowns: mergeLandCooldowns(statuses[status.id].providerCooldowns, status.providerCooldowns) };
                paint(); if (!status.pending && status.message) control.announce(status.message);
                if (status.retryAt > Date.now() && previous !== status.retryAt || status.id === 'land' && previousLand !== JSON.stringify(statuses.land.providerCooldowns)) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
            }
        } else if (data.dir === 'toPage' && data.type === 'layerCapture' && frameMode) {
            // This acknowledges a choice the frame already applied. Advancing
            // the revision here would discard its immediately-following status.
            capture = sentinelTarget(data.target); relay(); post({ type: 'handoffState', snapshot: snapshot() });
        } else if (data.dir === 'toPage' && data.type === 'layerView' && frameMode) {
            terrainMoving = false;
            const bounds = overlayBounds(data.bounds);
            if (bounds) {
                if (revealPending && terrainView && bounds.some((value, i) => Math.abs(value - terrainView!.bounds[i]) > 1e-7)) {
                    cancelReveal(); requestId++; post({ type: 'cancel' });
                }
                terrainView = { bounds, zoom: data.zoom, footer: readAttributionInset(data.footer) }; apply(); clearTimeout(stationTimer!); stationTimer = win.setTimeout(loadStations, 300);
            }
        }
    };
    win.addEventListener('message', handle);
    win.addEventListener('scroll', position, { passive: true, capture: true }); win.addEventListener('resize', position);
    const themeObserver = new win.MutationObserver(paint); themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-bpb-theme', 'data-theme'] });
    frameLifecycle.subscribe(start); frameLifecycle.start(); start(); post({ type: 'preferences' }); snowCard({ type: 'availability' });
    const lifecycle = createPageLifecycle({ ownerWindow: win,
        onSuspend() { active = false; snowMetadata.update(false); locationMenu.close(); cancelReveal(); stopPolling(); clearTimeout(stationTimer!); post({ type: 'cancel' }); unbind(); },
        onResume() { active = true; start(); post({ type: 'preferences' }); },
        onDispose() { disposed = true; active = false; snowMetadata.dispose(); stopPolling(); clearTimeout(stationTimer!); if (relayFrame !== null) win.cancelAnimationFrame(relayFrame);
            post({ type: 'cancel' }); unbind(); frameLifecycle.dispose(); themeObserver.disconnect(); custom?.dispose(); control.dispose(); locationMenu.dispose();
            win.removeEventListener('message', handle); win.removeEventListener('scroll', position, true); win.removeEventListener('resize', position); win.removeEventListener('bpb-overlay-yield', yieldMap); win.removeEventListener('bpb-map-owner', activeMap); },
    });
    const yieldMap = (event: Event) => { if ((event as CustomEvent).detail?.map === binding?.map) lifecycle.dispose(); };
    win.addEventListener('bpb-overlay-yield', yieldMap);
    return { dispose: () => lifecycle.dispose() };
}
if (typeof window !== 'undefined') {
    installMapLayers();
    const extra = new WeakSet<LayerMap>();
    const page = window as MapOwnerWindow;
    const attach = (map?: LayerMap | null) => {
        if (!map?.getContainer || map.__bpbOverlayOwner || extra.has(map)) return;
        extra.add(map); installMapLayers(page, { fixedMap: map, secondary: true });
    };
    for (const map of [page.mapsPlaceholder, page.map, ...page[Symbol.for('bpb.leafletMaps')] || []]) attach(map);
    window.addEventListener('bpb-map-ready', event => attach((event as CustomEvent).detail?.map));
}
