// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { settings } from '../settings/settings.js';
import { createSnotelClient } from '../snow/snotel-client.js';
import { readSnotelMapStations } from '../snow/snotel-map-data.js';
import { mountPeakSnow } from '../snow/peak-snow.js';
import { overlayBounds, viewportStations } from './map-overlay-providers.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { readLayerSnapshot } from './map-layer-protocol.js';

export const OVERLAY_PREFERENCES_KEY = 'bpbMapOverlayOpacityV1';
export function installMapLayerBridge({ ownerWindow = window, storage = chrome.storage.local,
    client = createSnotelClient({ storage }) } = {}) {
    const post = detail => ownerWindow.postMessage({ __bpbMapLayers: true, dir: 'toPage', ...detail }, ownerWindow.location.origin);
    let allowed = false, active = true, revision = 0, controller = null, preferences = Schema.mapOverlayPreferences(), retryAt = 0;
    let handoff = null;
    const cancel = () => { revision++; controller?.abort(); controller = null; };
    const announce = () => post({ type: 'preferences', preferences, snotel: active && allowed });
    const handler = async event => {
        const data = event.data;
        if (event.source !== ownerWindow || event.origin !== ownerWindow.location.origin || !data
            || data.__bpbMapLayers !== true || data.dir !== 'toCS' || !active) return;
        if (data.type === 'preferences') { announce(); return; }
        if (data.type === 'handoffState') { handoff = readLayerSnapshot(data.snapshot); return; }
        if (data.type === 'save') {
            preferences = Schema.mapOverlayPreferences(data.preferences);
            try { await storage.set({ [OVERLAY_PREFERENCES_KEY]: preferences }); } catch { /* Paint works without storage. */ }
            return;
        }
        if (data.type === 'cancel') { cancel(); return; }
        const bounds = overlayBounds(data.bounds);
        if (data.type !== 'stations' || !allowed || !bounds || !Number.isSafeInteger(data.requestId) || data.requestId < 1) return;
        cancel(); const owner = revision, requestId = data.requestId;
        if (retryAt > Date.now()) { post({ type: 'stations', requestId, error: true, retryAt }); return; }
        controller = new AbortController();
        try {
            // The complete national catalog is fetched once. The viewport never
            // reaches NRCS and only a bounded public subset crosses worlds.
            const visible = viewportStations(await client.stations({ signal: controller.signal }), bounds);
            if (owner !== revision || !active || !allowed) return;
            const stations = visible.length <= 50 ? readSnotelMapStations(visible) : [];
            if (!stations) throw new Error('Invalid stations.');
            post({ type: 'stations', requestId, stations, overflow: visible.length > 50 });
        } catch (error) {
            if (owner !== revision || error.name === 'AbortError') return;
            if (error.code === 'rate-limit') retryAt = error.retryAt || Date.now() + 300000;
            post({ type: 'stations', requestId, error: true, retryAt });
        } finally { if (owner === revision) controller = null; }
    };
    ownerWindow.addEventListener('message', handler);
    const navigation = event => {
        if (!event.isTrusted || !active || !handoff) return;
        const link = event.target?.closest?.('a[href]'); if (!link) return;
        let target;
        try { target = new URL(link.href); } catch { return; }
        if (target.origin !== ownerWindow.location.origin || !/\/map\/bigmap\.aspx$/i.test(target.pathname)) return;
        void chrome.runtime.sendMessage({ type: 'MAP_LAYERS_HANDOFF_PREPARE', destination: target.href, snapshot: handoff }).catch(() => {});
    };
    ownerWindow.document.addEventListener('click', navigation, true);
    if (/\/map\/bigmap\.aspx$/i.test(ownerWindow.location.pathname)) {
        void chrome.runtime.sendMessage({ type: 'MAP_LAYERS_HANDOFF_CONSUME' }).then(reply => {
            const snapshot = reply?.ok && readLayerSnapshot(reply.snapshot); if (snapshot) post({ type: 'handoff', snapshot });
        }, () => {});
    }
    const unsubscribe = settings.subscribe(next => { allowed = next.showSnotel === true; if (!allowed) cancel(); announce(); });
    void settings.requireCurrent().then(next => { allowed = next.showSnotel === true; announce(); }, () => {});
    void Promise.resolve(storage.get(OVERLAY_PREFERENCES_KEY)).then(value => {
        preferences = Schema.mapOverlayPreferences(value?.[OVERLAY_PREFERENCES_KEY]); announce();
    }, () => {});
    const lifecycle = createPageLifecycle({ ownerWindow,
        onSuspend: () => { active = false; cancel(); },
        onResume: () => { active = true; announce(); },
        onDispose: () => { active = false; cancel(); unsubscribe(); client.clear(); ownerWindow.removeEventListener('message', handler); ownerWindow.document.removeEventListener('click', navigation, true); },
    });
    return { client, dispose: () => lifecycle.dispose() };
}

if (typeof window !== 'undefined') {
    const bridge = installMapLayerBridge();
    if (/\/peak\.aspx$/i.test(location.pathname)) mountPeakSnow({ client: bridge.client });
}
