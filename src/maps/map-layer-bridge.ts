// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../settings/settings-schema.ts';
import { settings, type SettingsData } from '../settings/settings.ts';
import { createSnotelClient, type SnotelClient, type SnotelStorage } from '../snow/snotel-client.ts';
import { readSnotelMapStations } from '../snow/snotel-map-data.ts';
import { nearbySnotelStations } from '../snow/snotel-data.ts';
import { mountPeakSnow } from '../snow/peak-snow.ts';
import { overlayBounds, viewportStations } from './map-overlay-providers.ts';
import { createPageLifecycle } from '../ui/page-lifecycle.ts';
import { readLayerSnapshot } from './map-layer-protocol.ts';
import { readBCTileCoordinates } from './bc-land-client.ts';

export const OVERLAY_PREFERENCES_KEY = 'bpbMapOverlayOpacityV1';

export interface MapLayerBridgeOptions {
    ownerWindow?: Window & typeof globalThis;
    storage?: SnotelStorage | null;
    client?: SnotelClient;
}

export interface MapLayerBridge {
    client: SnotelClient;
    dispose(): void;
}

export function installMapLayerBridge({ ownerWindow = window, storage = chrome.storage.local,
    client = createSnotelClient({ storage }) }: MapLayerBridgeOptions = {}): MapLayerBridge {
    const post = (detail: Record<string, unknown>) => ownerWindow.postMessage({ __bpbMapLayers: true, dir: 'toPage', ...detail }, ownerWindow.location.origin);
    let allowed = false, active = true, revision = 0, controller: AbortController | null = null, preferences = Schema.mapOverlayPreferences(), retryAt = 0;
    let handoff: ReturnType<typeof readLayerSnapshot> = null, settingsReady = false, preferencesReady = false, preferencesRevision = 0;
    let unitSettings: SettingsData = Schema.clean({});
    const bcRequests = new Set<string>();
    const cancelBC = () => {
        for (const requestId of bcRequests) void chrome.runtime.sendMessage({ type: 'BC_LAND_TILE_CANCEL', requestId }).catch(() => {});
        bcRequests.clear();
    };
    const cancel = () => { revision++; controller?.abort(); controller = null; };
    // Unknown settings are not an opt-out: clearing a handoff here loses the
    // user's selection before the strict read can authorize station requests.
    const announce = () => {
        if (active && settingsReady && preferencesReady) post({
            type: 'preferences', preferences, snotel: allowed,
            units: unitSettings.units, elevationUnits: unitSettings.elevationUnits,
        });
    };
    const handler = async (event: MessageEvent) => {
        const data = event.data as Record<string, unknown> | null | undefined;
        if (event.source !== ownerWindow || event.origin !== ownerWindow.location.origin || !data
            || data.__bpbMapLayers !== true || data.dir !== 'toCS' || !active) return;
        if (data.type === 'preferences') { announce(); return; }
        if (data.type === 'bcTile') {
            const message = data.message as { type?: unknown; requestId?: unknown; coordinates?: unknown; landTypes?: unknown } | null | undefined;
            if (!message || typeof message.type !== 'string' || !['BC_LAND_TILE_GET', 'BC_LAND_TILE_CANCEL'].includes(message.type)
                || typeof message.requestId !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(message.requestId)) return;
            const coordinates = readBCTileCoordinates(message.coordinates);
            if (message.type === 'BC_LAND_TILE_GET' && !coordinates) return;
            if (message.type === 'BC_LAND_TILE_GET') bcRequests.add(message.requestId); else bcRequests.delete(message.requestId);
            try {
                const reply: unknown = await chrome.runtime.sendMessage({
                    type: message.type, requestId: message.requestId, coordinates, landTypes: Schema.mapLandTypes(message.landTypes),
                });
                if (active && message.type === 'BC_LAND_TILE_GET') post({ type: 'bcTileReply', requestId: message.requestId, reply });
            } catch { if (active) post({ type: 'bcTileReply', requestId: message.requestId, reply: { ok: false } }); }
            finally { bcRequests.delete(message.requestId); }
            return;
        }
        if (data.type === 'handoffState') { handoff = readLayerSnapshot(data.snapshot); return; }
        if (data.type === 'save') {
            preferencesRevision++;
            preferences = Schema.mapOverlayPreferences(data.preferences);
            try { await settings.set({ [OVERLAY_PREFERENCES_KEY]: preferences }); } catch { /* Paint works without storage. */ }
            return;
        }
        if (data.type === 'cancel') { cancel(); return; }
        const bounds = overlayBounds(data.bounds);
        if (data.type !== 'stations' || !allowed || !bounds || typeof data.requestId !== 'number'
            || !Number.isSafeInteger(data.requestId) || data.requestId < 1) return;
        cancel(); const owner = revision, requestId = data.requestId;
        if (retryAt > Date.now()) { post({ type: 'stations', requestId, error: true, retryAt }); return; }
        controller = new AbortController();
        try {
            // The complete national catalog is fetched once. The viewport never
            // reaches NRCS and only a bounded public subset crosses worlds.
            const catalog = await client.stations({ signal: controller.signal });
            const visible = viewportStations(catalog, bounds);
            const nearby = data.reveal === true && visible.length === 0;
            // Explicit activation may reveal the nearest stations within 50 km.
            // Ordinary pan/refresh requests remain bounded to the visible map.
            const candidates = nearby ? nearbySnotelStations(catalog, {
                latitude: (bounds[1] + bounds[3]) / 2,
                longitude: (((bounds[0] + bounds[2]) / 2 + 180) % 360 + 360) % 360 - 180,
            }) : visible;
            if (owner !== revision || !active || !allowed) return;
            const stations = candidates.length <= 50 ? readSnotelMapStations(candidates) : [];
            if (!stations) throw new Error('Invalid stations.');
            post({ type: 'stations', requestId, stations, nearby, overflow: visible.length > 50 });
        } catch (error) {
            const err = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; retryAt?: unknown } : null;
            if (owner !== revision || err?.name === 'AbortError') return;
            if (err?.code === 'rate-limit') {
                retryAt = Math.max(retryAt, (typeof err.retryAt === 'number' && err.retryAt) || Date.now() + 300000);
            }
            post({ type: 'stations', requestId, error: true, retryAt });
        } finally { if (owner === revision) controller = null; }
    };
    ownerWindow.addEventListener('message', handler);
    let permissionPending = false;
    const allowBC = (event: MouseEvent) => {
        const target = event.target as { closest?: (selector: string) => Element | null } | null;
        if (!event.isTrusted || !active || permissionPending || !target?.closest?.('[data-bpb-bc-permission="true"]')) return;
        permissionPending = true; post({ type: 'bcPermission', pending: true });
        // Call synchronously from the trusted DOM click, not a postMessage task.
        void chrome.runtime.sendMessage({ type: 'BC_LAND_PERMISSION_REQUEST' }).then((reply: { ok?: unknown; code?: unknown } | undefined) => {
            if (active) post({ type: 'bcPermission', ok: reply?.ok === true, setup: reply?.code === 'permission-setup-opened' });
        }, () => { if (active) post({ type: 'bcPermission', ok: false }); }).finally(() => { permissionPending = false; });
    };
    ownerWindow.document.addEventListener('click', allowBC, true);
    const permissionGranted = (message: unknown, sender: chrome.runtime.MessageSender) => {
        const payload = message as { type?: unknown } | null | undefined;
        if (!active || payload?.type !== 'BC_LAND_PERMISSION_GRANTED' || sender.id !== chrome.runtime.id || !sender.url) return;
        try {
            const source = new URL(sender.url), expected = new URL(chrome.runtime.getURL('bc-land/access.html'));
            if (source.protocol === expected.protocol && source.host === expected.host && source.pathname === expected.pathname) post({ type: 'bcPermission', ok: true });
        } catch { /* A web page cannot acknowledge a permission decision. */ }
    };
    chrome.runtime?.onMessage?.addListener(permissionGranted);
    const navigation = (event: MouseEvent) => {
        if (!event.isTrusted || !active || !handoff) return;
        const link = (event.target as { closest?: (selector: string) => HTMLAnchorElement | null } | null)?.closest?.('a[href]');
        if (!link) return;
        let target: URL;
        try { target = new URL(link.href); } catch { return; }
        if (target.origin !== ownerWindow.location.origin || !/\/map\/bigmap\.aspx$/i.test(target.pathname)) return;
        void chrome.runtime.sendMessage({ type: 'MAP_LAYERS_HANDOFF_PREPARE', destination: target.href, snapshot: handoff }).catch(() => {});
    };
    ownerWindow.document.addEventListener('click', navigation, true);
    if (/\/map\/bigmap\.aspx$/i.test(ownerWindow.location.pathname)) {
        void chrome.runtime.sendMessage({ type: 'MAP_LAYERS_HANDOFF_CONSUME' }).then((reply: { ok?: unknown; snapshot?: unknown } | undefined) => {
            const snapshot = reply?.ok ? readLayerSnapshot(reply.snapshot) : null;
            if (snapshot) post({ type: 'handoff', snapshot });
        }, () => {});
    }
    const unsubscribe = settings.subscribe(next => {
        unitSettings = next; settingsReady = true;
        const stored = (next as Record<string, unknown>)[OVERLAY_PREFERENCES_KEY];
        if (stored != null) preferences = Schema.mapOverlayPreferences(stored);
        allowed = next.showSnotel === true; if (!allowed) cancel(); announce();
    });
    void settings.requireCurrent().then(next => {
        if (settingsReady) return;
        unitSettings = next; settingsReady = true;
        allowed = next.showSnotel === true; announce();
    }, () => { if (!settingsReady) { settingsReady = true; allowed = false; announce(); } });
    void settings.preferences(OVERLAY_PREFERENCES_KEY).then(next => {
        if (preferencesRevision === 0) preferences = Schema.mapOverlayPreferences((next as Record<string, unknown>)[OVERLAY_PREFERENCES_KEY]);
    }, () => {}).finally(() => { preferencesReady = true; announce(); });
    const lifecycle = createPageLifecycle({ ownerWindow,
        onSuspend: () => { active = false; cancel(); cancelBC(); },
        onResume: () => { active = true; announce(); },
        onDispose: () => {
            active = false; cancel(); cancelBC(); unsubscribe(); client.clear();
            ownerWindow.removeEventListener('message', handler);
            ownerWindow.document.removeEventListener('click', navigation, true);
            ownerWindow.document.removeEventListener('click', allowBC, true);
            chrome.runtime?.onMessage?.removeListener(permissionGranted);
        },
    });
    return { client, dispose: () => lifecycle.dispose() };
}

if (typeof window !== 'undefined') {
    const bridge = installMapLayerBridge();
    if (/\/peak\.aspx$/i.test(location.pathname)) mountPeakSnow({ client: bridge.client });
}
