// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { VECTOR_MESSAGE, readVectorView, vectorBasemap } from './vector-basemap.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { readRetryAt } from '../net/rate-limit.js';

export function installVectorMapBridge(win = window, ext = globalThis.browser || globalThis.chrome) {
    const entries = new Map();
    const url = ext.runtime.getURL('terrain/vector.html'), parsed = new URL(url);
    const origin = parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
    let active = true;
    const cooldowns = new Map();
    const retryAt = basemap => readRetryAt(cooldowns.get(basemap.id));
    const post = (id, type, detail = {}) => win.postMessage({ [VECTOR_MESSAGE]: true, dir: 'toPage', id, type, ...detail }, win.location.origin);
    const remove = entry => { clearTimeout(entry.timer); entry.frame?.remove(); entry.frame = null; };
    const stop = id => { const entry = entries.get(id); if (entry) remove(entry); entries.delete(id); };
    const fail = entry => { if (entries.get(entry.id) !== entry) return; stop(entry.id); post(entry.id, 'error', { retryAt: retryAt(entry.basemap), basemap: entry.basemap.id }); };
    const send = (entry, type, detail = {}) => entry.frame?.contentWindow?.postMessage({
        [VECTOR_MESSAGE]: true, dir: 'toFrame', type, ...detail,
    }, origin);
    const ensure = entry => {
        if (!active || entry.frame || !entry.view || entry.paused) return;
        if (retryAt(entry.basemap)) { fail(entry); return; }
        const slot = win.document.getElementById(`bpb-vector-slot-${entry.id}`);
        if (!slot?.isConnected) return;
        const frame = win.document.createElement('iframe');
        frame.title = `${entry.basemap.provider} vector basemap`; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
        frame.src = url; entry.frame = frame;
        const logo = win.document.getElementById(`bpb-vector-logo-${entry.id}`);
        if (logo && entry.basemap.id === 'maptoolkit') logo.style.backgroundImage = `url("${ext.runtime.getURL('images/maptoolkit-attribution.png')}")`;
        entry.timer = win.setTimeout(() => fail(entry), 20000);
        slot.append(frame);
    };
    const trusted = event => {
        if (!active || !event.isTrusted) return;
        const control = event.target?.closest?.('[data-bpb-vector-map]');
        if (!control
            || event.type === 'click' && (control.tagName !== 'BUTTON' || control.getAttribute('aria-disabled') === 'true')) return;
        const basemap = vectorBasemap(event.type === 'change' ? control.value : control.dataset.bpbVectorBasemap);
        if (!basemap) return;
        const id = control.dataset.bpbVectorMap;
        if (!/^[a-z0-9-]{1,80}$/i.test(id || '')) return;
        stop(id);
        if (retryAt(basemap)) { post(id, 'error', { retryAt: retryAt(basemap), basemap: basemap.id }); return; }
        // Authority stays in this isolated-world entry for the selected layer's
        // lifetime. Page messages can update/pause it, never create authority.
        entries.set(id, { id, basemap, frame: null, view: null, paused: false });
    };
    const receive = async event => {
        const data = event.data;
        if (!active || !data || data[VECTOR_MESSAGE] !== true) return;
        if (data.dir === 'fromFrame' && event.origin === origin) {
            const entry = [...entries.values()].find(item => item.frame?.contentWindow === event.source);
            if (!entry) return;
            if (data.type === 'ready') {
                if (entry.initializing) return;
                entry.initializing = true;
                const frame = entry.frame;
                const isCurrent = () => active && entries.get(entry.id) === entry && entry.frame === frame;
                try {
                    const activation = await ext.runtime.sendMessage({ type: 'VECTOR_MAP_ACTIVATION_ISSUE', action: 'init' });
                    if (!isCurrent()) return;
                    if (retryAt(entry.basemap)) { fail(entry); return; }
                    if (activation?.ok !== true) { fail(entry); return; }
                    send(entry, 'init', { activation: activation.token, view: entry.view, basemap: entry.basemap.id });
                } catch { if (isCurrent()) fail(entry); }
            } else if (data.type === 'loaded') { clearTimeout(entry.timer); post(entry.id, 'loaded'); }
            else if (data.type === 'error') {
                const until = readRetryAt(data.retryAt);
                if (until) {
                    // Isolated-document lifetime: renderer disposal, another map,
                    // re-selection and 2D/3D suspension cannot reset this limit.
                    cooldowns.set(entry.basemap.id, Math.max(cooldowns.get(entry.basemap.id) || 0, until));
                    for (const current of entries.values()) if (current.basemap === entry.basemap) fail(current);
                } else fail(entry);
            }
            return;
        }
        if (event.source !== win || event.origin !== win.location.origin || data.dir !== 'toCS') return;
        const entry = entries.get(data.id);
        if (!entry) return;
        if (data.type === 'stop') { stop(data.id); return; }
        if (data.type === 'pause') { entry.paused = true; entry.initializing = false; remove(entry); return; }
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
        onSuspend() { active = false; for (const id of entries.keys()) stop(id); },
        onResume() { active = true; },
        onDispose() {
            active = false; for (const id of entries.keys()) stop(id);
            win.document.removeEventListener('change', trusted, true); win.document.removeEventListener('click', trusted, true);
            win.removeEventListener('message', receive);
        },
    });
}
if (typeof window !== 'undefined') installVectorMapBridge();
