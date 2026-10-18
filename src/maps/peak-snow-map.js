// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readSnotelMapStations } from '../snow/snotel-map-data.js';
import { snotelSymbol, snotelPopup } from '../snow/snotel-map-marker.js';
import { createRetryCooldown } from '../ui/retry-cooldown.js';

// MAIN world owns only rendering. The independent overlay never changes
// Peakbagger's basemap, native markers, or layer picker. Toggling preserves
// the camera; opening an edge popup may pan just enough to keep it readable.
export function createPeakSnowMap({ mount, getContext, postTerrain }) {
    const doc = mount.ownerDocument, win = doc.defaultView;
    const button = doc.createElement('button'); button.id = 'bpb-snow-map-toggle'; button.type = 'button';
    button.className = 'bpb-snow-map-toggle'; button.hidden = true; button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'SNOTEL stations within 50 km of this peak');
    const symbol = snotelSymbol(doc), text = doc.createElement('span'); text.textContent = 'Snow'; button.append(symbol, text);
    const notice = doc.createElement('div'); notice.className = 'bpb-snow-map-notice'; notice.hidden = true;
    const status = doc.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.hidden = true;
    retry.setAttribute('aria-label', 'Retry SNOTEL stations'); notice.append(status, retry); mount.append(button, notice);
    let available = false, selected = false, active = true, pending = false, stations = null, requestId = 0;
    let group = null, boundMap = null, polling = null;
    const post = detail => win.postMessage({ __bpbPeakSnow: true, dir: 'toCS', ...detail }, win.location.origin);
    const cooldown = createRetryCooldown(() => retry.setAttribute('aria-disabled', String(cooldown.active())));
    const stopPolling = () => { if (polling !== null) win.clearInterval(polling); polling = null; };
    const clearNative = () => { stopPolling(); if (group) group.remove(); group = null; boundMap = null; };
    const attach = () => {
        if (!active || !selected || !stations?.length) { clearNative(); return true; }
        const context = getContext(), L = context?.win?.L, map = context?.map;
        if (!map || !L?.marker || !L?.divIcon || !L?.layerGroup) return false;
        if (boundMap === map && group) return true;
        clearNative();
        const next = L.layerGroup();
        try {
            for (const station of stations) {
                const owner = context.win.document;
                const icon = L.divIcon({ html: snotelSymbol(owner), className: 'bpb-snotel-marker', iconSize: [24, 24], iconAnchor: [12, 12] });
                L.marker([station.latitude, station.longitude], { icon, title: `${station.name} · SNOTEL`, keyboard: true,
                    // These station badges must stay distinct from summit dots.
                    zIndexOffset: 200 }).bindPopup(snotelPopup(owner, station), { autoPanPadding: [12, 12], maxWidth: 260 }).addTo(next);
            }
            next.addTo(map); group = next; boundMap = map;
        } catch { next.remove(); return false; }
        return true;
    };
    const reattach = () => {
        clearNative();
        if (attach()) return;
        const started = Date.now();
        polling = win.setInterval(() => {
            if (attach() || Date.now() - started >= 30_000) stopPolling();
        }, 250);
    };
    const render = () => {
        button.hidden = !available;
        button.setAttribute('aria-pressed', String(selected)); button.setAttribute('aria-busy', String(pending));
        button.title = selected ? `Hide SNOTEL stations within 50 km of this peak${stations ? ` (${stations.length})` : ''}`
            : 'Show SNOTEL stations within 50 km of this peak';
        button.classList.toggle('bpb-snow-map-loading', pending);
    };
    const sendTerrain = () => postTerrain('snowStations', { snowStations: available && selected ? stations || [] : [] });
    const load = () => {
        if (!available || !active || pending) return;
        if (cooldown.active()) {
            status.textContent = 'NRCS is busy. Try again in a few minutes.';
            notice.hidden = false; retry.hidden = false; return;
        }
        pending = true; status.textContent = 'Loading SNOTEL stations…'; notice.hidden = false; retry.hidden = true;
        render(); post({ type: 'get', requestId: ++requestId });
    };
    const handle = event => {
        const data = event.data;
        if (event.source !== win || event.origin !== win.location.origin || !data || data.__bpbPeakSnow !== true || data.dir !== 'toPage') return;
        if (data.type === 'availability') {
            available = data.enabled === true;
            if (!available) { selected = false; pending = false; requestId++; stations = null; notice.hidden = true; clearNative(); sendTerrain(); }
            render(); return;
        }
        if (!active || !available || !selected || !pending || data.type !== 'stations' || data.requestId !== requestId) return;
        const next = readSnotelMapStations(data.stations);
        pending = false;
        if (data.error === true || !next) {
            status.textContent = 'SNOTEL stations unavailable.'; retry.hidden = false;
            if (Number.isFinite(data.retryAt) && data.retryAt > Date.now() && data.retryAt <= Date.now() + 86400_000) {
                status.textContent = 'NRCS is busy. Try again in a few minutes.'; cooldown.set(data.retryAt);
            }
        } else {
            stations = next; retry.hidden = true;
            status.textContent = 'No SNOTEL stations within 50 km of this peak.'; notice.hidden = next.length > 0;
            reattach(); sendTerrain();
        }
        render();
    };
    button.addEventListener('click', () => {
        selected = !selected;
        if (!selected) { pending = false; requestId++; post({ type: 'cancel' }); notice.hidden = true; clearNative(); sendTerrain(); }
        else if (stations) { notice.hidden = stations.length > 0; reattach(); sendTerrain(); }
        else load();
        render();
    });
    retry.addEventListener('click', () => { if (!cooldown.active()) { button.focus({ preventScroll: true }); load(); } });
    win.addEventListener('message', handle);
    post({ type: 'availability' });
    return {
        attach: reattach,
        setTheme(theme) { button.dataset.theme = notice.dataset.theme = theme; },
        snapshot: () => available && selected ? stations || [] : [],
        suspend() { active = false; pending = false; requestId++; post({ type: 'cancel' }); clearNative(); cooldown.suspend(); },
        resume() { active = true; cooldown.resume(); reattach(); if (selected && !stations) load(); post({ type: 'availability' }); },
        dispose() { clearNative(); cooldown.dispose(); win.removeEventListener('message', handle); button.remove(); notice.remove(); },
    };
}
