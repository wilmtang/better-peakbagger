// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readCustomRegistry, CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY, CUSTOM_LIMITS } from './custom-overlay-schema.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';

export function installCustomOverlayBridge(win = window) {
    const ext = globalThis.browser || globalThis.chrome, tag = '__bpbCustomOverlays', token = crypto.randomUUID();
    let frame = null, active = true, ready = false, returnFocus = null;
    const waiting = [], jobs = new Map(), maps = new Set(), revisions = new Map();
    const url = ext.runtime.getURL(`custom-overlay/editor.html#${token}`), target = new URL(url);
    const origin = `${target.protocol}//${target.host}`;
    const post = detail => { if (active) win.postMessage({ [tag]: true, dir: 'toPage', ...detail }, win.location.origin); };
    const send = detail => { if (ready) frame.contentWindow.postMessage({ [tag]: true, token, ...detail }, origin); else waiting.push(detail); };
    const ensure = () => {
        if (frame) return;
        frame = win.document.createElement('iframe'); frame.src = url; frame.title = 'Custom map overlays';
        frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
        frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-100px;top:-100px;border:0;visibility:hidden;pointer-events:none';
        frame.addEventListener('load', () => frame.contentWindow.postMessage({ [tag]: true, token, type: 'hello' }, origin));
        win.document.documentElement.append(frame);
    };
    const announce = async (mapId) => {
        const owner = (revisions.get(mapId) || 0) + 1; revisions.set(mapId, owner);
        try {
            const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET', mapId });
            if (active && owner === revisions.get(mapId)) post({ type: 'registry', mapId, registry: reply?.ok ? readCustomRegistry(reply.registry) : null, preferences: reply?.preferences });
        } catch { if (active && owner === revisions.get(mapId)) post({ type: 'registry', mapId, registry: null }); }
    };
    const close = () => {
        if (!frame) return;
        frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-100px;top:-100px;border:0;visibility:hidden;pointer-events:none';
        frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); returnFocus = null;
    };
    const open = event => {
        if (!event.isTrusted || !active) return;
        const button = event.target?.closest?.('[data-bpb-custom-editor]'); if (!button) return;
        ensure(); returnFocus = button;
        frame.style.cssText = 'position:fixed;z-index:2147483646;inset:5vh max(12px,calc((100vw - 600px)/2));width:calc(100% - max(24px,calc(100vw - 600px)));height:90vh;max-width:600px;border:1px solid #526752;border-radius:12px;box-shadow:0 12px 70px #0007;background:#fcfbf5';
        frame.style.visibility = 'hidden';
        frame.removeAttribute('aria-hidden'); frame.tabIndex = 0;
        send({ type: 'open', mapId: button.dataset.bpbCustomMap, sourceId: button.dataset.bpbCustomEditor || '',
            theme: win.document.documentElement.dataset.bpbTheme || win.document.documentElement.dataset.theme });
        frame.focus({ preventScroll: true });
    };
    const receive = event => {
        const data = event.data; if (!data?.[tag] || !active) return;
        if (event.source === frame?.contentWindow && event.origin === origin && data.token === token) {
            if (data.type === 'ready') { ready = true; for (const detail of waiting.splice(0)) send(detail); }
            else if (data.type === 'opened') { frame.style.visibility = 'visible'; frame.focus({ preventScroll: true }); }
            else if (data.type === 'close') close();
            else if (['preview', 'previewEnd', 'task'].includes(data.type)) post(data.detail);
            else if (data.type === 'parsed') { jobs.delete(data.requestId); post({ type: 'parsed', requestId: data.requestId, reply: data.reply }); }
            return;
        }
        if (event.source !== win || event.origin !== win.location.origin || data.dir !== 'toCS') return;
        if (data.type === 'get' && typeof data.mapId === 'string' && /^[a-z0-9-]{1,80}$/i.test(data.mapId) && (maps.has(data.mapId) || maps.size < 32)) { maps.add(data.mapId); void announce(data.mapId); }
        if (data.type === 'parse' && typeof data.requestId === 'string' && data.requestId.length < 100
            && data.job?.bytes instanceof ArrayBuffer && data.job.bytes.byteLength <= CUSTOM_LIMITS.geojson && jobs.size < 64) {
            ensure(); jobs.set(data.requestId, true); send({ type: 'parse', requestId: data.requestId, job: data.job });
        }
        if (data.type === 'cancelParse') { jobs.delete(data.requestId); if (frame) send({ type: 'cancelParse', requestId: data.requestId }); }
        if (data.type === 'taskReply') send({ type: 'taskReply', requestId: data.requestId, reply: data.reply });
    };
    const announceAll = () => { for (const mapId of maps) void announce(mapId); };
    const change = (changes, area) => { if (area === 'local' && (changes[CUSTOM_REGISTRY_KEY] || changes[CUSTOM_PREFERENCES_KEY])) announceAll(); };
    win.addEventListener('message', receive); win.document.addEventListener('click', open, true); ext.storage.onChanged.addListener(change);
    const opacity = event => {
        if (!event.isTrusted || !active) return;
        const slider = event.target?.closest?.('[data-bpb-custom-opacity]'); if (!slider) return;
        void ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_OPACITY', id: slider.dataset.bpbCustomOpacity, opacity: Number(slider.value) });
    };
    win.document.addEventListener('change', opacity, true);
    const lifecycle = createPageLifecycle({ ownerWindow: win, onSuspend() { active = false; for (const id of jobs.keys()) send({ type: 'cancelParse', requestId: id }); jobs.clear(); },
        onResume() { active = true; announceAll(); }, onDispose() { active = false; frame?.remove(); win.removeEventListener('message', receive); win.document.removeEventListener('click', open, true); win.document.removeEventListener('change', opacity, true); ext.storage.onChanged.removeListener(change); } });
    return { dispose: lifecycle.dispose };
}
if (typeof window !== 'undefined') installCustomOverlayBridge();
