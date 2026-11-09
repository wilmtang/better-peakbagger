// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { overlayBounds, mapOverlayCoverage } from './map-overlay-providers.ts';
import { fetchWildfireComponent } from './wildfire-client.js';
import { WILDFIRE_MIN_ZOOM, wildfireRecords } from './wildfire-core.js';

interface FirePart { features: { id?: unknown; [field: string]: unknown }[]; at: number; }
export type WildfireData = Record<'incidents' | 'perimeters', FirePart['features']>;
interface BoundsReader { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number; }
interface WildfireSessionOptions {
    document: Document; readView(): { bounds?: BoundsReader | number[]; zoom?: number } | null | undefined;
    onData(data: WildfireData): void; onStatus(status: Record<string, unknown>): void; fetchImpl?: typeof fetch; now?: () => number; debounceMs?: number; refreshMs?: number;
}
export function createWildfireSession({ document: doc, readView, onData, onStatus, fetchImpl, now = Date.now, debounceMs = 300, refreshMs = 300000 }: WildfireSessionOptions) {
    let enabled = false, disposed = false, controller: AbortController | null = null, generation = 0, timer: ReturnType<typeof setTimeout> | null = null, retryAt = 0;
    let viewKey = '', requestedKey = '', attemptedAt: number | null = null, status: Record<string, unknown> = {};
    const kinds = ['incidents', 'perimeters'] as const;
    let parts: Partial<Record<typeof kinds[number], FirePart>> = {};
    // After a pan the old fires stay drawn until the new view's answer replaces
    // them whole, but they never count as the current result for that view.
    let stale = false;
    const data = () => Object.fromEntries(kinds.map(kind => [kind, parts[kind]?.features || []])) as WildfireData;
    const metadata = () => {
        if (stale) return { fires: [], count: 0, loadedAt: 0 };
        const result = data(), fires = wildfireRecords(result.incidents, result.perimeters);
        return { fires, count: fires.length, loadedAt: Object.keys(parts).length ? Math.min(...Object.values(parts).map(part => part!.at)) : 0 };
    };
    const emit = (patch: Record<string, unknown>) => { status = { ...status, ...patch }; onStatus(status); };
    const cancel = () => { if (requestedKey) attemptedAt = null; generation++; controller?.abort(); controller = null; clearTimeout(timer!); timer = null; requestedKey = ''; };
    const clear = () => { parts = {}; stale = false; onData(data()); };
    const expire = () => {
        let changed = false;
        for (const kind of kinds) if (parts[kind] && now() - parts[kind]!.at >= 1800000) { delete parts[kind]; changed = true; }
        if (changed) onData(data());
    };
    const view = () => {
        const value = readView(), b = value?.bounds;
        return { bounds: overlayBounds((Array.isArray(b) ? b : b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null) as never), zoom: value?.zoom };
    };
    const eligible = () => enabled && !disposed && doc.visibilityState !== 'hidden';
    const later = (delay = refreshMs) => { clearTimeout(timer!); if (eligible()) timer = setTimeout(() => refresh(true), Math.max(1, delay)); };
    async function load(bounds: unknown, owner: number) {
        if (!eligible() || owner !== generation) return;
        controller = new AbortController(); const request = controller, budget = { bytes: 0, vertices: 0 };
        attemptedAt = now();
        const settled = await Promise.allSettled(kinds.map(kind => fetchWildfireComponent(kind, bounds, { fetchImpl, signal: request.signal, budget } as never).then(features => {
            if (owner === generation && !request.signal.aborted && eligible() && !stale) {
                parts[kind] = { features, at: now() } as FirePart; onData(data());
                emit({ ...metadata(), pending: true, message: 'Loading fire reports…' });
            }
            return { features, at: now() } as FirePart;
        })));
        if (owner !== generation || request.signal.aborted || !eligible()) return;
        controller = null; requestedKey = '';
        if (stale) {
            stale = false;
            parts = Object.fromEntries(kinds.flatMap((kind, index) => { const result = settled[index]; return result.status === 'fulfilled' ? [[kind, result.value]] : []; }));
        }
        expire();
        const missing = [], failures = []; let saved = false;
        for (const [index, kind] of kinds.entries()) {
            const result = settled[index];
            if (result.status === 'rejected') { missing.push(kind); failures.push(result.reason); saved ||= !!parts[kind]; retryAt = Math.max(retryAt, result.reason.retryAt || 0); }
        }
        onData(data());
        const meta = metadata(), overflow = failures.some(error => ['overflow', 'response-too-large'].includes(error.code));
        emit({ ...meta, pending: false, error: missing.length > 0, partial: missing.length === 1, saved, overflow, retry: true, retryAt,
            message: overflow ? 'Too much fire detail. Zoom in.' : missing.length ? missing.length === 2 ? saved ? 'Refresh failed. Loaded reports shown.' : 'Locations and perimeters unavailable.' : `${missing[0] === 'incidents' ? 'Locations' : 'Perimeters'} ${saved ? 'refresh failed.' : 'unavailable.'}`
                : meta.count ? `${meta.count} reported ${meta.count === 1 ? 'fire' : 'fires'} in view.` : 'No reported fires in this view.' });
        later();
    }
    function refresh(force = false) {
        if (!eligible()) { cancel(); return; }
        const { bounds, zoom } = view();
        if (!bounds || !Number.isFinite(zoom)) return;
        const covered = mapOverlayCoverage(bounds)?.wildfire === true;
        if (!covered || Math.round(zoom!) < WILDFIRE_MIN_ZOOM) {
            cancel(); clear(); viewKey = ''; attemptedAt = null;
            emit({ pending: false, error: false, saved: false, partial: false, fires: [], count: 0, retry: false,
                overflow: covered, message: covered ? 'Zoom in for reported fires.' : 'US reported fires only. No coverage here.' }); return;
        }
        const key = JSON.stringify(bounds);
        if (requestedKey === key) return;
        if (viewKey !== key) { cancel(); stale = Object.keys(parts).length > 0; viewKey = key; attemptedAt = null; }
        expire();
        if (!force && attemptedAt !== null && now() - attemptedAt < refreshMs) { later(refreshMs - (now() - attemptedAt)); return; }
        cancel();
        if (retryAt > now()) { if (stale) clear(); emit({ ...metadata(), pending: false, error: true, retry: true, retryAt, message: 'Fire service is busy. Try again later.' }); later(); return; }
        const owner = generation; requestedKey = key;
        emit({ ...metadata(), pending: true, error: false, partial: false, overflow: false, saved: false, retry: true, retryAt,
            message: Object.keys(parts).length ? 'Refreshing fire reports…' : 'Loading fire reports…' });
        timer = setTimeout(() => { timer = null; void load(bounds, owner); }, force ? 0 : debounceMs);
    }
    const visibility = () => { if (doc.visibilityState === 'hidden') cancel(); else refresh(); };
    doc.addEventListener('visibilitychange', visibility);
    return {
        update(state: { enabled?: boolean; retryAt?: number }) { retryAt = Math.max(retryAt, state.retryAt || 0); const changed = enabled !== state.enabled; enabled = state.enabled === true;
            if (!enabled) { cancel(); if (changed) { clear(); viewKey = ''; attemptedAt = null; emit({ pending: false, error: false, saved: false, fires: [], count: 0, message: '' }); } }
            else refresh(); },
        refresh, retry: () => refresh(true), moving: cancel,
        status: () => status,
        dispose() { disposed = true; enabled = false; cancel(); clear(); doc.removeEventListener('visibilitychange', visibility); },
    };
}
