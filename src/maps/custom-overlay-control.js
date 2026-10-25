// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readCustomRegistry, readCustomSource, readCustomSelection, CUSTOM_LIMITS } from './custom-overlay-schema.js';
import { createCustomClient, customPoolForWindow, customFailure } from './custom-overlay-client.js';
import { probeCustomSource } from './custom-overlay-probe.js';
import { createCustomRenderer } from './custom-overlay-render.js';

export function createCustomOverlayControl({ win, panel, onChange = () => {}, readView }) {
    const tag = '__bpbCustomOverlays', mapId = crypto.randomUUID(), selected = new Map(), reloads = {}, rows = new Map(), parseJobs = new Map();
    let sources = [], preferences = {}, engine = null, native = null, terrain = false, active = true, registryVersion = 0, libraryGeneration = null, previewId = null, previewBaseline = null, pendingAdoption = null;
    const statuses = {}, pool = customPoolForWindow(win), taskJobs = new Map(), terrainTasks = new Set();
    const send = detail => win.postMessage({ [tag]: true, dir: 'toCS', ...detail }, win.location.origin);
    const parse = (job, signal) => new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID(), abort = () => {
            clearTimeout(timer); parseJobs.get(requestId)?.done(); parseJobs.delete(requestId); send({ type: 'cancelParse', requestId }); reject(new DOMException('Cancelled.', 'AbortError'));
        };
        const timer = setTimeout(() => { abort(); }, 10000);
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        parseJobs.set(requestId, { resolve, reject, done() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
        send({ type: 'parse', requestId, job });
    });
    const node = (tagName, text) => { const element = win.document.createElement(tagName); if (text != null) element.textContent = text; return element; };
    const section = node('section'), header = node('div'), title = node('div', 'Custom layers'), list = node('div'), add = node('a', 'Add custom layer…');
    section.className = 'bpb-custom-section'; header.className = 'bpb-custom-header'; title.className = 'bpb-layers-detail-title';
    const settingsLink = link => { link.href = '#custom-map-layers'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.bpbCustomSettings = ''; };
    settingsLink(add);
    const live = node('p'); live.className = 'bpb-custom-live'; live.setAttribute('role', 'status');
    header.append(title, add); section.append(header, list, live); panel.append(section);
    const currentSources = () => sources.filter(source => selected.get(source.id) === source.revision).slice(0, CUSTOM_LIMITS.active);
    const publish = () => {
        if (active && !terrain) engine?.update(currentSources(), preferences, reloads);
        onChange();
    };
    const paint = () => {
        for (const [id, row] of rows) if (!sources.some(source => source.id === id)) { row.element.remove(); rows.delete(id); }
        for (const source of sources) {
            let row = rows.get(source.id);
            if (!row) {
                const element = node('details'), heading = node('summary'), label = node('label'), checkbox = node('input'), name = node('span'), summary = node('span');
                element.className = 'bpb-custom-source'; checkbox.type = 'checkbox'; label.append(checkbox, name); heading.append(label, summary); element.append(heading);
                const slider = node('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.dataset.bpbCustomOpacity = source.id;
                const opacity = node('label', 'Opacity'); opacity.append(slider);
                const attribution = node('p'), message = node('p'), retry = node('button', 'Retry'), edit = node('a', 'Edit in Settings');
                retry.type = 'button'; settingsLink(edit); if (add.href) edit.href = add.href;
                message.className = 'bpb-custom-feedback';
                const help = node('details'), helpTitle = node('summary', 'How to fix URL / CORS errors');
                help.append(helpTitle, node('p', 'Check the URL and source format. Public metadata and tile endpoints must allow browser access (CORS), usually Access-Control-Allow-Origin: *. Use a compatible endpoint or contact the provider. BPB has no proxy.'));
                const actions = node('div'); actions.className = 'bpb-custom-actions'; actions.append(retry, edit);
                element.append(opacity, attribution, message, help, actions); list.append(element);
                row = { element, checkbox, name, summary, slider, attribution, message, retry }; rows.set(source.id, row);
                checkbox.addEventListener('click', event => event.stopPropagation());
                checkbox.addEventListener('change', () => {
                    const latest = sources.find(item => item.id === source.id);
                    if (!latest) return;
                    if (checkbox.checked && selected.size >= CUSTOM_LIMITS.active) { checkbox.checked = false; live.textContent = 'Enable up to three custom overlays at a time.'; return; }
                    if (checkbox.checked) selected.set(source.id, latest.revision); else selected.delete(source.id);
                    statuses[source.id] = {}; publish(); paint();
                });
                slider.oninput = () => { preferences[source.id] = +slider.value; publish(); paint(); };
                retry.onclick = () => { if (!selected.has(source.id) || statuses[source.id]?.pending || statuses[source.id]?.retryAt > Date.now()) return; reloads[source.id] = (reloads[source.id] || 0) + 1; publish(); };
            }
            const status = statuses[source.id] || {}, enabled = selected.has(source.id);
            row.name.textContent = source.name; row.checkbox.setAttribute('aria-label', source.name); row.checkbox.checked = enabled;
            row.slider.value = preferences[source.id] ?? source.appearance.opacity; row.slider.setAttribute('aria-label', `${source.name} opacity`);
            row.summary.textContent = enabled ? status.pending ? 'Loading' : status.error ? status.partial ? 'Partly loaded' : status.code === 'access' ? 'Check URL / CORS' : 'Couldn’t load' : status.lower ? 'Lower detail' : `${row.slider.value}%` : 'Off';
            const view = readView(), zoom = view?.zoom;
            const zoomedOut = source.kind !== 'geojson' && Number.isFinite(zoom) && zoom < source.source.minNativeZoom + (source.kind === 'mvt' || source.source.tileSize === 512 ? 1 : 0);
            if (enabled && zoomedOut) row.summary.textContent = 'Zoom in';
            row.attribution.textContent = [source.kind.toUpperCase(), source.attribution.text, ...source.approvedOrigins].filter(Boolean).join(' · ');
            row.message.textContent = enabled ? zoomedOut ? 'Zoom in to this source’s available range.' : status.error && status.code === 'access' ? 'Source unavailable. Check the URL or provider CORS settings.' : status.message ? status.error ? customFailure(status) : status.message : 'Loading status appears here.' : 'Enable to load this source.';
            row.retry.setAttribute('aria-disabled', String(!enabled || status.pending || status.retryAt > Date.now()));
        }
        const focused = list.contains(win.document.activeElement) ? win.document.activeElement : null;
        sources.forEach((source, index) => { const row = rows.get(source.id); if (list.children[index] !== row.element) list.insertBefore(row.element, list.children[index] || null); });
        if (focused?.isConnected && win.document.activeElement === win.document.body) focused.focus({ preventScroll: true });
    };
    const onStatus = (id, status) => { const before = statuses[id]?.message; statuses[id] = status; paint(); if (!status.pending && status.message && status.message !== before) live.textContent = `${sources.find(source => source.id === id)?.name || 'Overlay'}: ${status.error ? customFailure(status) : status.message}`; };
    const getRegistry = async () => {
        send({ type: 'get', mapId });
    };
    const handle = async event => {
        const data = event.data;
        if (event.source !== win || event.origin !== win.location.origin || !data?.[tag] || data.dir !== 'toPage' || !active) return;
        if (data.type === 'registry') {
            if (data.mapId && data.mapId !== mapId) return;
            const registry = readCustomRegistry(data.registry); if (!registry) { live.textContent = 'Saved overlays are unavailable. Retry by reopening the map.'; return; }
            if (libraryGeneration !== null && libraryGeneration !== (registry.generation || 0)) { selected.clear(); previewId = previewBaseline = pendingAdoption = null; cancelTasks(); }
            libraryGeneration = registry.generation || 0;
            try { const url = new URL(data.settingsUrl); if (['chrome-extension:', 'moz-extension:'].includes(url.protocol) && url.pathname === '/options/options.html') {
                for (const link of section.querySelectorAll('[data-bpb-custom-settings]')) link.href = url.href;
            } } catch { /* Wait for the isolated bridge's packaged destination. */ }
            sources = registry.sources; preferences = data.preferences || {}; registryVersion++;
            for (const id of selected.keys()) { const source = sources.find(item => item.id === id); if (source) selected.set(id, source.revision); else if (id !== previewId) selected.delete(id); }
            if (pendingAdoption) { for (const item of pendingAdoption) if (sources.some(source => source.id === item.id && source.revision === item.sourceRevision)) selected.set(item.id, item.sourceRevision); pendingAdoption = null; }
            publish(); paint();
        }
        if (data.type === 'settingsError') { live.textContent = data.message; live.classList.add('bpb-custom-error'); }
        if (data.type === 'parsed') {
            const entry = parseJobs.get(data.requestId); if (!entry) return; parseJobs.delete(data.requestId); entry.done();
            if (data.reply?.ok) entry.resolve(data.reply.value); else entry.reject(new Error('Invalid or oversized vector data.'));
        }
        if (data.mapId !== mapId) return;
        if (data.type === 'preview') {
            if (!previewId) previewBaseline = { revision: selected.get(data.sourceId) };
            previewId = data.sourceId; selected.set(previewId, data.sourceRevision); send({ type: 'get', mapId });
        }
        if (data.type === 'previewEnd') {
            if (previewId && data.savedRevision !== selected.get(previewId)) {
                if (previewBaseline?.revision) selected.set(previewId, previewBaseline.revision); else selected.delete(previewId);
            }
            previewId = previewBaseline = null; void getRegistry();
        }
        if (data.type === 'taskCancel') { taskJobs.get(data.requestId)?.abort(); if (terrain) win.postMessage({ __bpbTerrain: true, dir: 'toCS', type: 'customTask', requestId: data.requestId, action: 'cancel', mapId }, win.location.origin); return; }
        if (data.type === 'task') {
            const source = readCustomSource(data.source), view = readView();
            if (!source) return;
            if (terrain) {
                terrainTasks.add(data.requestId);
                win.postMessage({ __bpbTerrain: true, dir: 'toCS', type: 'customTask', requestId: data.requestId, mapId, action: data.action, id: source.id, sourceRevision: source.revision }, win.location.origin);
                return;
            }
            const owner = new AbortController(); taskJobs.set(data.requestId, owner);
            const client = createCustomClient({ fetchImpl: (native?.win || win).fetch.bind(native?.win || win), parse, pool });
            try {
                let value;
                if (data.action === 'resolve') value = await client.resolve(source, owner.signal, false);
                else if (data.action === 'test') value = await probeCustomSource(client, source, view, owner.signal, '2D');
                else throw new Error('Choose a visible map to test this source.');
                send({ type: 'taskReply', requestId: data.requestId, reply: { ok: true, value } });
            } catch (error) { send({ type: 'taskReply', requestId: data.requestId, reply: { ok: false, error: customFailure(error) } }); }
            finally { taskJobs.delete(data.requestId); }
        }
    };
    const cancelTasks = () => {
        for (const owner of taskJobs.values()) owner.abort(); taskJobs.clear();
        for (const requestId of terrainTasks) {
            win.postMessage({ __bpbTerrain: true, dir: 'toCS', type: 'customTask', action: 'cancel', requestId, mapId }, win.location.origin);
            send({ type: 'taskReply', requestId, reply: { ok: false, error: 'Test cancelled. The map or source changed.' } });
        }
        terrainTasks.clear();
    };
    const cancelParsers = () => { for (const [requestId, entry] of parseJobs) { entry.done(); send({ type: 'cancelParse', requestId }); entry.reject(new DOMException('Cancelled.', 'AbortError')); } parseJobs.clear(); };
    const visibility = () => { if (win.document.hidden) cancelTasks(); };
    win.document.addEventListener('visibilitychange', visibility);
    win.addEventListener('message', handle); void getRegistry();
    return { section, mapId, snapshot: () => ({ custom: [...selected].slice(0, 3).map(([id, sourceRevision]) => ({ id, sourceRevision, enabled: true })), customSession: mapId, customRevision: registryVersion,
        customOpacity: { ...preferences }, customReloads: { ...reloads } }),
    adopt(value) { pendingAdoption = readCustomSelection(value); for (const item of pendingAdoption) if (sources.some(source => source.id === item.id && source.revision === item.sourceRevision)) selected.set(item.id, item.sourceRevision); publish(); paint(); },
    bind(owner, map) { engine?.dispose(); native = { win: owner, map }; engine = createCustomRenderer({ win: owner, map, parse, pool, onStatus }); publish(); paint(); },
    suspend() { engine?.dispose(); engine = null; cancelParsers(); cancelTasks(); },
    mode(value) { if (terrain !== value) { cancelTasks(); for (const id of selected.keys()) statuses[id] = { pending: true }; } terrain = value; if (value) { engine?.dispose(); engine = null; } paint(); },
    cancelTasks,
    taskReply(data) { if (data.mapId === mapId && terrainTasks.delete(data.requestId)) send({ type: 'taskReply', requestId: data.requestId, reply: data.reply }); },
    status: onStatus, refresh: paint,
    dispose() { active = false; engine?.dispose(); cancelParsers(); cancelTasks(); win.removeEventListener('message', handle); win.document.removeEventListener('visibilitychange', visibility); section.remove(); } };
}
