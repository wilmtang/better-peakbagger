// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { nearbySnotelStations, type SnotelLocation, type SnotelNearbyStation } from './snotel-data.ts';
import { readSnotelMapStations } from './snotel-map-data.ts';
import type { SnotelClient } from './snotel-client.ts';

export interface SnotelMapSourceWindow {
    readonly location: { readonly origin: string };
    postMessage(message: unknown, targetOrigin: string): void;
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

export interface SnotelMapSourceOptions {
    client: Pick<SnotelClient, 'stations'>;
    subject: SnotelLocation;
    onSelect?: (station: SnotelNearbyStation, nearby: SnotelNearbyStation[]) => void;
    ownerWindow?: SnotelMapSourceWindow;
}

export interface SnotelMapSource {
    setEnabled(value: boolean): void;
    suspend(): void;
    resume(): void;
    dispose(): void;
}

// Isolated world owns fetching. The page may request this peak's bounded public
// catalog subset or select an exposed station, never supply a location or URL.
export function createSnotelMapSource({ client, subject, onSelect, ownerWindow = window }: SnotelMapSourceOptions): SnotelMapSource {
    let allowed = false, active = true, revision = 0, retryAt = 0;
    let controller: AbortController | null = null;
    let requestId: number | null = null;
    let selectable: SnotelNearbyStation[] = [];
    const post = (detail: Record<string, unknown>) =>
        ownerWindow.postMessage({ __bpbPeakSnow: true, dir: 'toPage', ...detail }, ownerWindow.location.origin);
    const cancel = () => { revision++; controller?.abort(); controller = null; requestId = null; };
    const handle = async (event: MessageEvent<unknown>) => {
        const raw = event.data;
        if (event.source !== ownerWindow || event.origin !== ownerWindow.location.origin
            || !raw || typeof raw !== 'object') return;
        const data = raw as Record<string, unknown>;
        if (data.__bpbPeakSnow !== true || data.dir !== 'toCS') return;
        if (data.type === 'availability') { post({ type: 'availability', enabled: allowed && active }); return; }
        if (data.type === 'cancel') { cancel(); return; }
        if (data.type === 'select') {
            const station = allowed && active ? selectable.find(candidate => candidate.id === data.stationId) : undefined;
            if (station) onSelect?.(station, selectable);
            return;
        }
        if (data.type !== 'get' || !allowed || !active || typeof data.requestId !== 'number'
            || !Number.isSafeInteger(data.requestId) || data.requestId < 1) return;
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
            const err = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; retryAt?: unknown } : null;
            if (owner !== revision || err?.name === 'AbortError') return;
            retryAt = err?.code === 'rate-limit' && typeof err.retryAt === 'number' ? err.retryAt : 0;
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
