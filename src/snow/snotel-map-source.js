// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { nearbySnotelStations } from './snotel-data.js';
import { readSnotelMapStations } from './snotel-map-data.js';

// Isolated world owns fetching. The page may request this peak's bounded public
// catalog subset or select an exposed station, never supply a location or URL.
export function createSnotelMapSource({ client, subject, onSelect, ownerWindow = window }) {
    let allowed = false, active = true, controller = null, revision = 0, requestId = null, retryAt = 0;
    let selectable = [];
    const post = detail => ownerWindow.postMessage({ __bpbPeakSnow: true, dir: 'toPage', ...detail }, ownerWindow.location.origin);
    const cancel = () => { revision++; controller?.abort(); controller = null; requestId = null; };
    const handle = async event => {
        const data = event.data;
        if (event.source !== ownerWindow || event.origin !== ownerWindow.location.origin
            || !data || data.__bpbPeakSnow !== true || data.dir !== 'toCS') return;
        if (data.type === 'availability') { post({ type: 'availability', enabled: allowed && active }); return; }
        if (data.type === 'cancel') { cancel(); return; }
        if (data.type === 'select') {
            const station = allowed && active && selectable.find(candidate => candidate.id === data.stationId);
            if (station) onSelect?.(station, selectable);
            return;
        }
        if (data.type !== 'get' || !allowed || !active || !Number.isSafeInteger(data.requestId) || data.requestId < 1) return;
        requestId = data.requestId;
        if (controller) return;
        if (retryAt > Date.now()) { post({ type: 'stations', requestId, error: true, retryAt }); return; }
        controller = new AbortController(); const signal = controller.signal, owner = ++revision;
        try {
            const nearby = nearbySnotelStations(await client.stations({ signal }), subject, 50);
            const stations = readSnotelMapStations(nearby);
            if (owner !== revision || !allowed || !active) return;
            if (!stations) throw new Error('Invalid snow stations.');
            selectable = nearby;
            post({ type: 'stations', requestId, stations });
        } catch (error) {
            if (owner !== revision || error.name === 'AbortError') return;
            retryAt = error.code === 'rate-limit' ? error.retryAt : 0;
            post({ type: 'stations', requestId, error: true, retryAt });
        } finally { if (owner === revision) controller = null; }
    };
    ownerWindow.addEventListener('message', handle);
    return {
        setEnabled(value) { allowed = value === true; if (!allowed) { cancel(); selectable = []; } post({ type: 'availability', enabled: allowed && active }); },
        suspend() { active = false; cancel(); },
        resume() { active = true; post({ type: 'availability', enabled: allowed }); },
        dispose() { cancel(); ownerWindow.removeEventListener('message', handle); },
    };
}
