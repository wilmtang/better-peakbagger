// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { createMapLayerControl } from './map-layer-control.js';
import { createLeafletOverlays } from './map-overlay-leaflet.js';
import { createSentinelSession } from './sentinel-session.js';
import { sentinelTarget } from './sentinel-core.js';
import { SLOPE_BANDS, publicLandInfo, overlayBounds, rasterTileStatus } from './map-overlay-providers.js';
import { readLayerSnapshot, readLayerStatus } from './map-layer-protocol.js';
import { readSnotelMapStations } from '../snow/snotel-map-data.js';
import { createSnotelMapReveal } from '../snow/snotel-map-view.js';
import { createMapFrameLifecycle } from '../gpx/map-frame-lifecycle.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';

const MAP_PAGES = /\/(?:ascent|peak|bigmap)\.aspx$/i;
const FRAME_SELECTOR = 'iframe#if, iframe[src*="MasterMap.aspx" i]';
export function installMapLayers(win = window) {
    const doc = win.document;
    // An embedded MasterMap's outer page owns controls even before its map has
    // loaded. Standalone MasterMap and other native map shells own themselves.
    try { if (win.parent !== win && MAP_PAGES.test(win.parent.location.pathname)) return null; } catch { /* Standalone owner. */ }
    const state = Schema.mapOverlayState();
    let touched = false, revision = 1, capture = null;
    let binding = null, polling = null, frameMode = false, booting = false, active = true, disposed = false;
    let terrainView = null, snotelAllowed = false, requestId = 0, stations = [];
    let stationTimer = null, relayFrame = null;
    let cardAvailable = false, nearbyRequest = 900000000, nearbyPending = false, nearbyReady = false;
    let revealPending = false;
    const nativeReveal = createSnotelMapReveal({ window: win, getMap: () => binding?.map });
    const cancelReveal = () => { revealPending = false; nativeReveal.cancel(); };
    const selectable = new Set();
    const statuses = {
        sentinel: { legend: 'Copernicus Sentinel-2 · Microsoft Planetary Computer. Scene clouds can obscure coverage.' },
        slope: { legend: 'USGS 3DEP · Below 20° and no data are clear. Ground slope; resolution varies. Not an avalanche forecast.',
            legendEntries: SLOPE_BANDS.map(band => ({ label: band.to === 91 ? '≥45°' : `${band.from}–${band.to}°`, color: `rgb(${band.color.join(',')})` })) },
        land: publicLandInfo(null),
        snotel: { legend: 'NRCS active stations in the visible map. Station observations may differ from route conditions.' },
    };
    const post = detail => win.postMessage({ __bpbMapLayers: true, dir: 'toCS', ...detail }, win.location.origin);
    const terrain = (type, detail = {}) => win.postMessage({ __bpbTerrain: true, dir: 'toCS', type, ...detail }, win.location.origin);
    const snowCard = detail => win.postMessage({ __bpbPeakSnow: true, dir: 'toCS', ...detail }, win.location.origin);
    const frameLifecycle = createMapFrameLifecycle({ document: doc, MutationObserver: win.MutationObserver, selector: FRAME_SELECTOR });
    const theme = () => doc.documentElement.dataset.bpbTheme === 'dark' || doc.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const paint = () => {
        const bounds = stationView();
        if (bounds) {
            const info = publicLandInfo(bounds);
            if (statuses.land.permission && !info.guidanceKeys.includes('bc')) statuses.land = { ...statuses.land, permission: false, pending: false, error: false, retry: false, message: '' };
            statuses.land = { ...statuses.land, ...info };
        }
        control.render({ state, statuses, theme: theme() });
        position();
    };
    const snapshot = () => ({ revision, state, capture, menuOpen: control.isOpen(), landCooldowns: statuses.land.providerCooldowns,
        cooldowns: Object.fromEntries(Schema.MAP_OVERLAY_IDS.map(id => [id, statuses[id]?.retryAt || 0])) });
    const relay = () => {
        if (relayFrame !== null) return;
        // Keep the parked bridge current too. Otherwise its loaded replay could
        // briefly reactivate an overlay the user turned off while in 2D.
        relayFrame = win.requestAnimationFrame(() => { relayFrame = null; terrain('layers', { snapshot: snapshot() }); });
    };
    const save = () => post({ type: 'save', preferences: Object.fromEntries(Schema.MAP_OVERLAY_IDS.map(id => [id, state[id].opacity])) });
    const stationView = () => {
        if (frameMode) return terrainView?.bounds;
        const bounds = binding?.map.getBounds();
        return bounds ? overlayBounds([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]) : null;
    };
    const sendStations = (reveal = false) => {
        const shown = state.snotel.enabled && active ? stations : [];
        if (frameMode) terrain('snowStations', { snowStations: shown, reveal: reveal && shown.length > 0,
            conditions: shown.filter(station => selectable.has(station.id)).map(station => station.id) });
        else {
            binding?.engine.stations(shown, { selectable, onSelect: stationId => snowCard({ type: 'select', stationId }) });
            if (reveal && shown.length) nativeReveal.show(shown);
        }
    };
    const loadStations = () => {
        clearTimeout(stationTimer); stationTimer = null;
        const bounds = stationView();
        if (!active || !state.snotel.enabled || !snotelAllowed || !bounds || booting || statuses.snotel.retryAt > Date.now()) return;
        requestId++; post({ type: 'cancel' });
        if (cardAvailable && !nearbyPending && !nearbyReady) { nearbyPending = true; snowCard({ type: 'get', requestId: ++nearbyRequest }); }
        statuses.snotel = { ...statuses.snotel, pending: true, error: false, retry: statuses.snotel.retry === true, message: 'Loading stations…' }; paint();
        post({ type: 'stations', requestId, bounds, reveal: revealPending });
    };
    const refresh = event => {
        if (event && revealPending) { cancelReveal(); requestId++; post({ type: 'cancel' }); }
        paint();
        if (!frameMode && !booting) binding?.sentinel.refresh();
        clearTimeout(stationTimer); stationTimer = win.setTimeout(loadStations, 300);
    };
    const apply = () => {
        relay();
        if (!frameMode && !booting && active && binding) {
            for (const id of ['sentinel', 'land', 'slope']) binding.engine.set(id, { ...state[id], retryAt: statuses[id].retryAt, providerCooldowns: statuses[id].providerCooldowns });
            binding.sentinel.cooldown(statuses.sentinel.retryAt);
            if (state.sentinel.enabled && state.sentinel.opacity > 0) binding.sentinel.activate(capture);
            else binding.sentinel.deactivate();
        }
        sendStations(); paint();
        post({ type: 'handoffState', snapshot: snapshot() });
    };
    const changed = () => { touched = true; revision++; apply(); };
    const control = createMapLayerControl({ document: doc,
        onToggle(id, enabled) {
            state[id].enabled = enabled;
            if (id === 'snotel') {
                cancelReveal(); revealPending = enabled;
                requestId++; post({ type: 'cancel' }); stations = [];
                if (!enabled) { nearbyPending = false; nearbyRequest++; snowCard({ type: 'cancel' }); statuses.snotel.pending = false; }
            }
            changed(); if (id === 'snotel' && enabled) loadStations();
        },
        onOpacity(id, opacity) { state[id].opacity = opacity; changed(); }, onCommit: save,
        onCapture(value) {
            if (frameMode) terrain('layerAction', { action: 'capture', id: 'sentinel', capture: value });
            else binding?.sentinel.select(value);
        },
        onRetry(id) {
            if (id === 'snotel') loadStations();
            else if (frameMode) {
                statuses[id] = { ...statuses[id], pending: true, error: false, retry: true,
                    message: id === 'sentinel' ? 'Finding captures…' : id === 'land' ? 'Loading public lands' : 'Loading slope shading' };
                paint(); terrain('layerAction', { action: 'retry', id });
            }
            else if (id === 'sentinel') binding?.sentinel.retry();
            else { statuses[id] = { ...statuses[id], pending: true, error: false, permission: false, retry: true,
                message: id === 'land' ? 'Loading public lands' : 'Loading slope shading' }; binding?.engine.retry(id); paint(); }
        },
        onOpen() { relay(); },
    });
    control.element.hidden = true; doc.body.append(control.element);
    const position = () => {
        const target = (frameMode && doc.getElementById('bpb-terrain-frame'))
            || binding?.frame || binding?.map.getContainer?.();
        if (!target) { control.element.hidden = true; return; }
        const rect = target.getBoundingClientRect();
        control.position(rect);
    };
    const unbind = () => {
        nativeReveal.cancel();
        if (!binding) return;
        binding.map.off('moveend', refresh);
        binding.observer?.disconnect(); binding.sentinel.dispose(); binding.engine.dispose();
        binding = null;
    };
    const bind = () => {
        if (!active || disposed) return false;
        const frame = frameLifecycle.current();
        const candidates = [];
        try { if (frame?.contentWindow) candidates.push({ win: frame.contentWindow, frame }); } catch { /* Wait for replacement. */ }
        candidates.push({ win, frame: null });
        for (const candidate of candidates) {
            try {
                const owner = candidate.win, map = [owner.mapsPlaceholder, owner.map].find(item => item?.getBounds && item?.eachLayer && item?.on && item?.off);
                if (!map || !owner.L?.GridLayer || !owner.L?.marker) continue;
                if (binding?.map === map && binding.win.document === owner.document) { position(); return true; }
                unbind();
                const engine = createLeafletOverlays({ win: owner, bridgeWindow: win, map, onError(id, error) {
                    if (id === 'sentinel') binding?.sentinel.tileError(error);
                    else if (id === 'land') return; // Complete provider outcomes supply land feedback below.
                    else { statuses[id] = { ...statuses[id], pending: false, error: true, retry: true, permission: error?.code === 'bc-permission-required', retryAt: error?.retryAt || 0,
                        message: error?.code === 'bc-permission-required' ? 'Allow BC parcel maps.' : 'Some map tiles are unavailable. Retry.' }; paint();
                    if (error?.retryAt > Date.now()) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); } }
                }, onActivity(id, activity) {
                    if (!active || frameMode || booting || !state[id].enabled || state[id].opacity === 0) return;
                    if (id === 'sentinel') binding?.sentinel.tileActivity(activity);
                    else {
                        if (id === 'slope' && statuses[id].retryAt > Date.now()) return;
                        const previous = JSON.stringify(statuses.land.providerCooldowns);
                        statuses[id] = { ...statuses[id], ...rasterTileStatus(id, activity),
                            retry: activity.error || activity.pending && statuses[id].retry === true };
                        paint();
                        if (id === 'land' && previous !== JSON.stringify(statuses.land.providerCooldowns)) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
                    }
                } });
                const sentinel = createSentinelSession({ readView: () => ({ bounds: map.getBounds(), zoom: map.getZoom() }), fetchImpl: owner.fetch.bind(owner),
                    replaceScenes: scenes => engine.scenes(scenes, state.sentinel.opacity), clearScenes: () => engine.clearSentinel(),
                    retryTiles: () => engine.retry('sentinel'),
                    onStatus: status => {
                        const previous = statuses.sentinel.retryAt;
                        statuses.sentinel = { ...statuses.sentinel, ...status }; paint(); if (!status.pending && status.message) control.announce(status.message);
                        if (status.retryAt > Date.now() && status.retryAt !== previous) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
                    },
                    onCapture: target => { capture = target; revision++; relay(); post({ type: 'handoffState', snapshot: snapshot() }); },
                });
                binding = { ...candidate, map, engine, sentinel };
                map.on('moveend', refresh);
                if (win.ResizeObserver) { binding.observer = new win.ResizeObserver(position); binding.observer.observe(candidate.frame || map.getContainer()); }
                apply(); refresh(); return true;
            } catch (error) { console.warn('Better Peakbagger: map layers could not bind', error); unbind(); }
        }
        if (binding && (!binding.frame?.isConnected || binding.win.document !== binding.map.getContainer()?.ownerDocument)) unbind();
        return false;
    };
    const stopPolling = () => { clearInterval(polling); polling = null; };
    const start = () => {
        stopPolling(); if (bind()) return;
        const began = Date.now(); polling = win.setInterval(() => { if (bind() || Date.now() - began >= 30000) stopPolling(); }, 250);
    };
    const handle = event => {
        const data = event.data;
        if (event.source !== win || event.origin !== win.location.origin || !data || !active) return;
        if (data.__bpbPeakSnow === true && data.dir === 'toPage') {
            if (data.type === 'availability') { cardAvailable = data.enabled === true; if (!cardAvailable) { selectable.clear(); nearbyReady = false; } }
            if (data.type === 'stations' && data.requestId === nearbyRequest) {
                nearbyPending = false; selectable.clear();
                nearbyReady = data.error !== true;
                for (const station of readSnotelMapStations(data.stations) || []) selectable.add(station.id);
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
                    statuses.land.providerCooldowns = next.landCooldowns;
                    Object.assign(state, next.state); capture = next.capture;
                    for (const id of Schema.MAP_OVERLAY_IDS) if (next.cooldowns[id] > Date.now()) statuses[id] = { ...statuses[id], retryAt: next.cooldowns[id], error: true, retry: true, message: 'Map service is busy. Try again later.' };
                    changed(); loadStations();
                }
            } else if (data.type === 'preferences') {
                if (!touched) { const preferences = Schema.mapOverlayPreferences(data.preferences); for (const id of Schema.MAP_OVERLAY_IDS) state[id].opacity = preferences[id]; }
                const wasAllowed = snotelAllowed; snotelAllowed = data.snotel === true;
                statuses.snotel.unavailable = !snotelAllowed;
                if (!snotelAllowed) statuses.snotel.message = 'Enable Show SNOTEL in settings.';
                else if (!wasAllowed) statuses.snotel.message = '';
                if (!snotelAllowed) { cancelReveal(); state.snotel.enabled = false; stations = []; requestId++; }
                apply(); if (!wasAllowed && state.snotel.enabled) loadStations();
            } else if (data.type === 'stations' && data.requestId === requestId && state.snotel.enabled && snotelAllowed) {
                const next = readSnotelMapStations(data.stations);
                let reveal = false;
                if (data.error === true || !next) statuses.snotel = { ...statuses.snotel, pending: false, error: true, retry: true,
                    message: 'Stations unavailable. Retry.', retryAt: Number.isFinite(data.retryAt) ? data.retryAt : 0 };
                else {
                    stations = next; reveal = revealPending; revealPending = false;
                    statuses.snotel = { ...statuses.snotel, pending: false, error: false, retry: false, count: next.length,
                        message: data.overflow === true ? 'More than 50 stations. Zoom in.'
                            : data.nearby === true ? next.length ? `${next.length} nearby stations.` : 'No SNOTEL stations within 50 km.'
                                : next.length ? `${next.length} stations in view.` : 'No SNOTEL stations in view.' };
                }
                sendStations(reveal); paint();
                control.announce(statuses.snotel.message);
                if (statuses.snotel.retryAt > Date.now()) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
            }
        }
        if (data.__bpbTerrain !== true) return;
        if (data.dir === 'toCS' && data.type === 'init') {
            booting = true; binding?.sentinel.deactivate(); binding?.engine.dispose();
            // Recreate the native adapter only when returning to 2D.
            if (binding) { unbind(); start(); }
            requestId++; post({ type: 'cancel' });
        } else if (data.dir === 'toPage' && data.type === 'loaded') {
            frameMode = true; booting = false; revision++; apply(); loadStations();
        } else if (data.dir === 'toPage' && ['destroyed', 'error'].includes(data.type)) {
            frameMode = booting = false; terrainView = null; revision++; apply(); refresh();
        } else if (data.dir === 'toPage' && data.type === 'layerStatus' && frameMode) {
            const status = readLayerStatus(data); if (status && status.revision === revision) {
                const previous = statuses[status.id].retryAt, previousLand = JSON.stringify(statuses.land.providerCooldowns);
                statuses[status.id] = { ...statuses[status.id], ...status }; paint(); if (!status.pending && status.message) control.announce(status.message);
                if (status.retryAt > Date.now() && previous !== status.retryAt || status.id === 'land' && previousLand !== JSON.stringify(statuses.land.providerCooldowns)) { relay(); post({ type: 'handoffState', snapshot: snapshot() }); }
            }
        } else if (data.dir === 'toPage' && data.type === 'layerCapture' && frameMode) {
            // This acknowledges a choice the frame already applied. Advancing
            // the revision here would discard its immediately-following status.
            capture = sentinelTarget(data.target); relay(); post({ type: 'handoffState', snapshot: snapshot() });
        } else if (data.dir === 'toPage' && data.type === 'layerView' && frameMode) {
            const bounds = overlayBounds(data.bounds);
            if (bounds) {
                if (revealPending && terrainView && bounds.some((value, i) => Math.abs(value - terrainView.bounds[i]) > 1e-7)) {
                    cancelReveal(); requestId++; post({ type: 'cancel' });
                }
                terrainView = { bounds, zoom: data.zoom }; paint(); clearTimeout(stationTimer); stationTimer = win.setTimeout(loadStations, 300);
            }
        }
    };
    win.addEventListener('message', handle);
    win.addEventListener('scroll', position, { passive: true, capture: true }); win.addEventListener('resize', position);
    const themeObserver = new win.MutationObserver(paint); themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-bpb-theme', 'data-theme'] });
    frameLifecycle.subscribe(start); frameLifecycle.start(); start(); post({ type: 'preferences' }); snowCard({ type: 'availability' });
    const lifecycle = createPageLifecycle({ ownerWindow: win,
        onSuspend() { active = false; cancelReveal(); stopPolling(); clearTimeout(stationTimer); post({ type: 'cancel' }); unbind(); },
        onResume() { active = true; start(); post({ type: 'preferences' }); },
        onDispose() { disposed = true; active = false; stopPolling(); clearTimeout(stationTimer); if (relayFrame !== null) win.cancelAnimationFrame(relayFrame);
            post({ type: 'cancel' }); unbind(); frameLifecycle.dispose(); themeObserver.disconnect(); control.dispose();
            win.removeEventListener('message', handle); win.removeEventListener('scroll', position, true); win.removeEventListener('resize', position); },
    });
    return { dispose: () => lifecycle.dispose() };
}
if (typeof window !== 'undefined') installMapLayers();
