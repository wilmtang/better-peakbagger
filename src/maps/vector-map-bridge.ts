// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { VECTOR_MESSAGE, VECTOR_KEEPALIVE_MS, readVectorView, readVectorPaint, vectorBasemap } from './vector-basemap.ts';
import type { VectorBasemap, VectorView } from './vector-basemap.ts';
import { createPageLifecycle } from '../ui/page-lifecycle.ts';
import { readRetryAt } from '../net/rate-limit.js';
import { createVisibleDeadline } from '../ui/visible-deadline.ts';
import type { VisibleDeadline } from '../ui/visible-deadline.ts';

interface BridgeEntry {
    id: string; basemap: VectorBasemap; frame: HTMLIFrameElement | null; view: VectorView | null; paused: boolean; revision: number;
    drawFrame?: number | null; drawQueued?: boolean; timer?: VisibleDeadline | null; expiry?: number; initializing?: boolean;
    loaded?: boolean; released?: boolean; generation?: number | null;
}
interface BridgeExtension {
    runtime: { getURL(path: string): string; sendMessage(message: unknown): Promise<{ ok?: boolean; token?: string } | undefined> };
}
type VectorControl = (HTMLSelectElement | HTMLButtonElement) & { dataset: DOMStringMap };

export function installVectorMapBridge(win: Window & typeof globalThis = window, ext: BridgeExtension = (globalThis as { browser?: BridgeExtension }).browser || globalThis.chrome as unknown as BridgeExtension) {
    const entries = new Map<string, BridgeEntry>(), parked = new Map<string, BridgeEntry>();
    const url = ext.runtime.getURL('terrain/vector.html'), parsed = new URL(url);
    const origin = parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
    let active = true, sequence = 0;
    const cooldowns = new Map<string, number>();
    const retryAt = (basemap: VectorBasemap) => readRetryAt(cooldowns.get(basemap.id));
    const post = (id: string, type: string, detail: Record<string, unknown> = {}, transfer: Transferable[] = []) => win.postMessage({ [VECTOR_MESSAGE]: true, dir: 'toPage', id, type, ...detail }, win.location.origin, transfer);
    const key = (entry: BridgeEntry) => `${entry.id}:${entry.basemap.id}`;
    const remove = (entry: BridgeEntry) => {
        if (entry.drawFrame != null) win.cancelAnimationFrame(entry.drawFrame); entry.drawFrame = null; entry.drawQueued = false;
        entry.timer?.clear(); win.clearTimeout(entry.expiry); entry.revision++; entry.initializing = false;
        entry.frame?.remove(); entry.frame = null; entry.loaded = false; entry.released = false;
        if (parked.get(key(entry)) === entry) parked.delete(key(entry));
    };
    const stop = (id: string) => { const entry = entries.get(id); if (entry) remove(entry); entries.delete(id); };
    // A suspended page ignores errors and later resumes this same selection, so
    // only its renderer is discarded; resuming then boots or reports afresh.
    const fail = (entry: BridgeEntry) => { if (entries.get(entry.id) !== entry || entry.paused) { remove(entry); return; } stop(entry.id); post(entry.id, 'error', { retryAt: retryAt(entry.basemap), basemap: entry.basemap.id }); };
    const send = (entry: BridgeEntry, type: string, detail: Record<string, unknown> = {}) => entry.frame?.contentWindow?.postMessage({
        [VECTOR_MESSAGE]: true, dir: 'toFrame', type, ...detail,
    }, origin);
    const release = (entry: BridgeEntry) => {
        if (entry.drawFrame != null) win.cancelAnimationFrame(entry.drawFrame); entry.drawFrame = null; entry.drawQueued = false;
        entry.timer?.clear(); entry.revision++; entry.generation = null; entry.initializing = false; entry.paused = true;
        if (!entry.loaded) { remove(entry); return; }
        // The frame clears its style and aborts every provider request. Keep
        // only its GL/worker setup and accepted style for a bounded warm start.
        send(entry, 'release'); entry.released = true; entry.frame!.dataset.bpbVectorParked = 'true';
        win.clearTimeout(entry.expiry);
        entry.expiry = win.setTimeout(() => remove(entry), VECTOR_KEEPALIVE_MS);
    };
    const park = (id: string) => {
        const entry = entries.get(id); if (!entry) return;
        release(entry); entries.delete(id);
        if (entry.frame) parked.set(key(entry), entry);
    };
    const activate = async (entry: BridgeEntry, type: string) => {
        if (entry.initializing) return;
        entry.initializing = true;
        entry.generation = ++sequence;
        const frame = entry.frame, revision = ++entry.revision;
        const isCurrent = () => active && entries.get(entry.id) === entry && !entry.paused && entry.frame === frame && revision === entry.revision;
        try {
            const activation = await ext.runtime.sendMessage({ type: 'VECTOR_MAP_ACTIVATION_ISSUE', action: 'init' });
            if (!isCurrent()) return;
            if (retryAt(entry.basemap) || activation?.ok !== true) { fail(entry); return; }
            send(entry, type, { activation: activation.token, view: entry.view, basemap: entry.basemap.id, generation: entry.generation });
        } catch { if (isCurrent()) fail(entry); }
    };
    const ensure = (entry: BridgeEntry) => {
        if (!active || !entry.view || entry.paused) return;
        if (retryAt(entry.basemap)) { fail(entry); return; }
        if (entry.frame) {
            if (entry.released) {
                entry.released = false; delete entry.frame.dataset.bpbVectorParked; win.clearTimeout(entry.expiry);
                entry.timer = createVisibleDeadline(win.document, 20000, () => fail(entry)); void activate(entry, 'resume');
            }
            return;
        }
        const slot = win.document.getElementById(`bpb-vector-slot-${entry.id}-${entry.basemap.id}`);
        if (!slot?.isConnected) return;
        const frame = win.document.createElement('iframe');
        frame.title = `${entry.basemap.provider} vector basemap`; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
        frame.src = url; entry.frame = frame;
        const logo = win.document.getElementById(`bpb-vector-logo-${entry.id}`);
        if (logo && entry.basemap.id === 'maptoolkit') logo.style.backgroundImage = `url("${ext.runtime.getURL('images/maptoolkit-attribution.png')}")`;
        entry.timer = createVisibleDeadline(win.document, 20000, () => fail(entry));
        slot.append(frame);
    };
    const trusted = (event: Event) => {
        if (!active || !event.isTrusted) return;
        const control = (event.target as Element | null)?.closest?.('[data-bpb-vector-map]') as VectorControl | null | undefined;
        if (!control
            || event.type === 'click' && (control.tagName !== 'BUTTON' || control.getAttribute('aria-disabled') === 'true')) return;
        const basemap = vectorBasemap(event.type === 'change' ? control.value : control.dataset.bpbVectorBasemap);
        if (!basemap) return;
        const id = control.dataset.bpbVectorMap as string;
        if (!/^[a-z0-9-]{1,80}$/i.test(id || '')) return;
        park(id);
        if (retryAt(basemap)) { post(id, 'error', { retryAt: retryAt(basemap), basemap: basemap.id }); return; }
        // Authority stays in this isolated-world entry for the selected layer's
        // lifetime. Page messages can update/pause it, never create authority.
        const cached = parked.get(`${id}:${basemap.id}`);
        if (cached) { parked.delete(key(cached)); win.clearTimeout(cached.expiry); cached.view = null; cached.paused = false; }
        entries.set(id, cached || { id, basemap, frame: null, view: null, paused: false, revision: 0 });
    };
    const receive = async (event: MessageEvent) => {
        const data = event.data;
        if (!active || !data || data[VECTOR_MESSAGE] !== true) return;
        if (data.dir === 'fromFrame' && event.origin === origin) {
            const entry = [...entries.values(), ...parked.values()].find(item => item.frame?.contentWindow === event.source);
            if (data.type === 'painted') {
                const bitmap = data.bitmap, paint = readVectorPaint(data);
                if (!(typeof win.ImageBitmap === 'function' && bitmap instanceof win.ImageBitmap)) return;
                if (!entry || entries.get(entry.id) !== entry || entry.paused || data.generation !== entry.generation
                    || !paint
                    || bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 16384 || bitmap.height > 16384) { bitmap.close(); return; }
                post(entry.id, 'painted', { ...paint, bitmap, basemap: entry.basemap.id }, [bitmap]);
                entry.loaded = true;
                entry.timer?.clear();
                return;
            }
            if (!entry) return;
            const current = entries.get(entry.id) === entry && !entry.paused;
            if (data.type === 'renderNeeded' && current && data.generation === entry.generation && !entry.drawQueued) {
                const frame = entry.frame, generation = entry.generation;
                entry.drawQueued = true;
                entry.drawFrame = win.requestAnimationFrame(() => {
                    entry.drawFrame = null;
                    if (active && entries.get(entry.id) === entry && !entry.paused && entry.frame === frame && entry.generation === generation) {
                        win.postMessage({ [VECTOR_MESSAGE]: true, dir: 'toCS', type: 'renderClock', id: entry.id, generation }, win.location.origin);
                    }
                });
                return;
            }
            if (data.type === 'ready') {
                if (current && entry.view && !entry.loaded) await activate(entry, 'init');
            } else if (data.type === 'loaded' && current && data.generation === entry.generation) {
                if (JSON.stringify(readVectorView(data.view)) !== JSON.stringify(entry.view)) return;
                entry.loaded = true; post(entry.id, 'loaded');
            }
            else if (data.type === 'error') {
                const until = readRetryAt(data.retryAt);
                if (until) {
                    // Isolated-document lifetime: renderer disposal, another map,
                    // re-selection and 2D/3D suspension cannot reset this limit.
                    cooldowns.set(entry.basemap.id, Math.max(cooldowns.get(entry.basemap.id) || 0, until));
                    for (const affected of [...entries.values(), ...parked.values()]) if (affected.basemap === entry.basemap) fail(affected);
                // A released renderer has no generation to match, but it disposed itself
                // and cannot answer a later warm start.
                } else if (entry.released || data.generation === entry.generation) fail(entry);
            }
            return;
        }
        if (event.source !== win || event.origin !== win.location.origin || data.dir !== 'toCS') return;
        if (data.type === 'dispose') { stop(data.id); for (const entry of [...parked.values()]) if (entry.id === data.id) remove(entry); return; }
        const entry = entries.get(data.id);
        if (!entry) return;
        if (data.type === 'stop') { park(data.id); return; }
        if (data.type === 'pause') { release(entry); return; }
        if (data.type === 'renderClock' || data.type === 'render') {
            if (entry.paused || !entry.drawQueued || data.generation !== entry.generation) return;
            // Post a second task so every camera update queued by this rAF
            // batch reaches the frame before its animation callbacks.
            if (data.type === 'renderClock') win.postMessage({ [VECTOR_MESSAGE]: true, dir: 'toCS', type: 'render', id: entry.id, generation: entry.generation }, win.location.origin);
            else { entry.drawQueued = false; send(entry, 'render', { generation: entry.generation }); }
            return;
        }
        if (data.type === 'resume') entry.paused = false;
        const view = readVectorView(data.view);
        if (!view) return;
        entry.view = view;
        ensure(entry); send(entry, 'view', { view });
    };
    win.document.addEventListener('change', trusted, true);
    win.document.addEventListener('click', trusted, true);
    win.addEventListener('message', receive);
    return createPageLifecycle({ ownerWindow: win,
        onSuspend() { active = false; for (const id of entries.keys()) stop(id); for (const entry of [...parked.values()]) remove(entry); },
        onResume() { active = true; },
        onDispose() {
            active = false; for (const id of entries.keys()) stop(id); for (const entry of [...parked.values()]) remove(entry);
            win.document.removeEventListener('change', trusted, true); win.document.removeEventListener('click', trusted, true);
            win.removeEventListener('message', receive);
        },
    });
}
if (typeof window !== 'undefined') installVectorMapBridge();
