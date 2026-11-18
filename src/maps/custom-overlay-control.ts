// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    readCustomRegistry,
    readCustomSource,
    readCustomSelection,
    CUSTOM_LIMITS,
} from './custom-overlay-schema.ts';
import { createCustomClient, customPoolForWindow, customFailure } from './custom-overlay-client.ts';
import { probeCustomSource } from './custom-overlay-probe.ts';
import {
    createCustomRenderer,
    type CustomOverlayStatus,
    type CustomRendererMap,
    type CustomRendererOptions,
    type CustomRendererWindow,
    type CustomRenderSource,
} from './custom-overlay-render.ts';
import { PRIVATE_LIMITS } from './custom-overlay-private.ts';
import type { CustomGeoJsonCollection, CustomMvtResult, CustomParseRequest } from './custom-overlay-data.ts';

export interface CustomControlView {
    center?: { lat: number; lng: number } | null;
    zoom?: number;
    bounds?: number[];
    footer?: number;
}

export interface CustomControlStatus {
    pending?: boolean;
    error?: boolean;
    partial?: boolean;
    lower?: boolean;
    message?: string;
    code?: string;
    status?: number;
    retryAt?: number;
}

export interface CustomOverlayControlOptions {
    win: CustomRendererWindow;
    panel: Element | null;
    onChange?: () => void;
    readView: () => CustomControlView | null | undefined;
}

interface CustomControlSource extends CustomRenderSource {
    name: string;
}

interface CustomControlRegistry {
    schemaVersion: number;
    revision: number;
    generation?: number;
    sources: CustomControlSource[];
}

interface ParseJobEntry {
    resolve(value: CustomGeoJsonCollection | CustomMvtResult): void;
    reject(reason?: unknown): void;
    done(): void;
}

interface ControlRow {
    element: HTMLDetailsElement;
    heading: HTMLElement;
    checkbox: HTMLInputElement;
    name: HTMLSpanElement;
    summary: HTMLSpanElement;
    amount: HTMLSpanElement;
    state: HTMLSpanElement;
    value: HTMLSpanElement;
    spinner: HTMLSpanElement;
    slider: HTMLInputElement;
    output: HTMLOutputElement;
    attribution: HTMLParagraphElement;
    message: HTMLParagraphElement;
    retry: HTMLButtonElement;
    approve: HTMLButtonElement;
    intent: string;
}

export function createCustomOverlayControl({
    win,
    panel,
    onChange = () => {},
    readView,
}: CustomOverlayControlOptions) {
    if (!panel) throw new Error('Custom overlay control requires a panel.');
    const tag = '__bpbCustomOverlays';
    const mapId = crypto.randomUUID();
    const selected = new Map<string, number>();
    const reloads: Record<string, number> = {};
    const rows = new Map<string, ControlRow>();
    const parseJobs = new Map<string, ParseJobEntry>();
    let sources: CustomControlSource[] = [];
    let preferences: Record<string, number> = {};
    let engine: ReturnType<typeof createCustomRenderer> | null = null;
    let native: { win: CustomRendererWindow; map: CustomRendererMap } | null = null;
    let terrain = false;
    let active = true;
    let registryVersion = 0;
    let libraryGeneration: number | null = null;
    let previewId: string | null = null;
    let previewBaseline: { revision: number | undefined } | null = null;
    let pendingAdoption: { id: string; sourceRevision: number; enabled: boolean }[] | null = null;
    const statuses: Record<string, CustomControlStatus> = {};
    const pool = customPoolForWindow(win);
    const taskJobs = new Map<string, AbortController>();
    const terrainTasks = new Set<string>();
    const refreshes = new Map<string, string>();

    const send = (detail: Record<string, unknown>): void =>
        win.postMessage({ [tag]: true, dir: 'toCS', ...detail }, win.location.origin);

    const parse = (job: CustomParseRequest, signal?: AbortSignal | null): Promise<CustomGeoJsonCollection | CustomMvtResult> =>
        new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const abort = (): void => {
                clearTimeout(timer);
                parseJobs.get(requestId)?.done();
                parseJobs.delete(requestId);
                send({ type: 'cancelParse', requestId });
                reject(new DOMException('Cancelled.', 'AbortError'));
            };
            timer = setTimeout(() => { abort(); }, 10000);
            if (signal?.aborted) { abort(); return; }
            signal?.addEventListener('abort', abort, { once: true });
            parseJobs.set(requestId, {
                resolve,
                reject,
                done() {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', abort);
                },
            });
            send({ type: 'parse', requestId, job });
        });

    const node = <K extends keyof HTMLElementTagNameMap>(tagName: K, text?: string): HTMLElementTagNameMap[K] => {
        const element = win.document.createElement(tagName);
        if (text != null) element.textContent = text;
        return element;
    };

    const section = node('section');
    const header = node('div');
    const title = node('div', 'Custom layers');
    const list = node('div');
    const add = node('a', 'Add custom layer…');
    section.className = 'bpb-custom-section';
    header.className = 'bpb-custom-header';
    title.className = 'bpb-layers-detail-title';
    const settingsLink = (link: HTMLAnchorElement): void => {
        link.href = '#custom-map-layers';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.dataset.bpbCustomSettings = '';
    };
    settingsLink(add);
    const live = node('p');
    live.className = 'bpb-custom-live';
    live.setAttribute('role', 'status');
    header.append(title, add);
    section.append(header, list, live);
    panel.append(section);

    const currentSources = (): CustomControlSource[] =>
        sources.filter(source => selected.get(source.id) === source.revision).slice(0, CUSTOM_LIMITS.active);

    const publish = (): void => {
        if (active && !terrain) engine?.update(currentSources(), preferences, reloads);
        onChange();
    };

    const paint = (): void => {
        for (const [id, row] of rows) {
            if (!sources.some(source => source.id === id)) {
                row.element.remove();
                rows.delete(id);
            }
        }
        for (const source of sources) {
            let row = rows.get(source.id);
            if (!row) {
                const element = node('details');
                const heading = node('summary');
                const label = node('label');
                const checkbox = node('input');
                const name = node('span');
                const summary = node('span');
                const copy = node('span');
                element.className = 'bpb-custom-source';
                heading.className = 'bpb-layers-row';
                label.className = 'bpb-layers-choice';
                name.className = 'bpb-layers-row-name';
                copy.className = 'bpb-layers-row-copy';
                summary.className = 'bpb-layers-summary';
                const spinner = node('span');
                const amount = node('span');
                const state = node('span');
                const value = node('span');
                const valueLabel = node('span', 'Opacity');
                spinner.className = 'bpb-layers-spinner';
                spinner.setAttribute('aria-hidden', 'true');
                spinner.hidden = true;
                amount.className = 'bpb-layers-value-number';
                value.className = 'bpb-layers-value';
                valueLabel.className = 'bpb-layers-value-label';
                state.className = 'bpb-layers-row-status';
                value.append(valueLabel, amount);
                summary.append(spinner, value, state);
                copy.append(name, summary);
                checkbox.type = 'checkbox';
                checkbox.setAttribute('form', '');
                label.append(checkbox, copy);
                const disclosure = node('span');
                disclosure.className = 'bpb-layers-disclosure';
                disclosure.setAttribute('aria-hidden', 'true');
                const chevron = win.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                const path = win.document.createElementNS('http://www.w3.org/2000/svg', 'path');
                chevron.setAttribute('class', 'bpb-layers-chevron');
                chevron.setAttribute('viewBox', '0 0 12 12');
                chevron.setAttribute('focusable', 'false');
                for (const [key, attribute] of Object.entries({
                    d: 'm2 4 4 4 4-4',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '1.5',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round',
                })) path.setAttribute(key, attribute);
                chevron.append(path);
                disclosure.append(chevron);
                heading.append(label, disclosure);
                element.append(heading);
                const slider = node('input');
                slider.type = 'range';
                slider.min = '0';
                slider.max = '100';
                slider.dataset.bpbCustomOpacity = source.id;
                slider.setAttribute('form', '');
                slider.id = `${mapId}-${source.id}-opacity`;
                const opacity = node('label');
                const output = node('output');
                opacity.className = 'bpb-layers-opacity';
                opacity.htmlFor = slider.id;
                opacity.append(node('span', 'Opacity'), output);
                const ends = node('div');
                ends.className = 'bpb-layers-opacity-ends';
                ends.setAttribute('aria-hidden', 'true');
                ends.append(node('span', 'Clear'), node('span', 'Solid'));
                const attribution = node('p');
                const message = node('p');
                const retry = node('button', 'Retry');
                const edit = node('a', 'Edit in Settings');
                const approve = node('button', 'Approve private access…');
                approve.type = 'button';
                approve.dataset.bpbPrivateLayer = source.id;
                retry.type = 'button';
                settingsLink(edit);
                if (add.href) edit.href = add.href;
                message.className = 'bpb-custom-feedback';
                const help = node('details');
                const helpTitle = node('summary', 'Troubleshooting');
                help.append(
                    helpTitle,
                    node('p', 'Public sources need browser access (CORS). Private request parameters use BPB’s limited background relay and require approval in BPB. Check the provider URL, source format and access settings.'),
                );
                const actions = node('div');
                actions.className = 'bpb-custom-actions';
                actions.append(approve, retry, edit);
                const detail = node('section');
                detail.className = 'bpb-layers-detail';
                detail.append(opacity, slider, ends, attribution, actions, message, help);
                element.append(detail);
                list.append(element);
                row = {
                    element,
                    heading,
                    checkbox,
                    name,
                    summary,
                    amount,
                    state,
                    value,
                    spinner,
                    slider,
                    output,
                    attribution,
                    message,
                    retry,
                    approve,
                    intent: crypto.randomUUID(),
                };
                rows.set(source.id, row);
                checkbox.addEventListener('click', event => event.stopPropagation());
                checkbox.addEventListener('change', () => {
                    const latest = sources.find(item => item.id === source.id);
                    if (!latest) return;
                    if (checkbox.checked && selected.size >= CUSTOM_LIMITS.active) {
                        checkbox.checked = false;
                        live.textContent = 'Enable up to three custom overlays at a time.';
                        return;
                    }
                    refreshes.delete(source.id);
                    row!.intent = crypto.randomUUID();
                    if (checkbox.checked) selected.set(source.id, latest.revision);
                    else selected.delete(source.id);
                    statuses[source.id] = {};
                    publish();
                    paint();
                });
                slider.oninput = () => {
                    preferences[source.id] = +slider.value;
                    publish();
                    paint();
                };
                retry.onclick = () => {
                    if (!selected.has(source.id)
                        || sources.find(item => item.id === source.id)?.privateRequests
                        || statuses[source.id]?.pending
                        || (statuses[source.id]?.retryAt ?? 0) > Date.now()) return;
                    reloads[source.id] = (reloads[source.id] || 0) + 1;
                    publish();
                };
            }
            const status: CustomControlStatus = refreshes.has(source.id)
                ? { ...statuses[source.id], pending: true }
                : statuses[source.id] || {};
            const enabled = selected.has(source.id);
            row.name.textContent = source.name;
            row.checkbox.setAttribute('aria-label', source.name);
            row.checkbox.checked = enabled;
            row.slider.value = String(preferences[source.id] ?? source.appearance.opacity);
            row.slider.setAttribute('aria-label', `${source.name} opacity`);
            row.output.value = row.amount.textContent = `${row.slider.value}%`;
            row.spinner.hidden = !enabled || !status.pending;
            row.value.hidden = !enabled || Boolean(status.pending) || Boolean(status.error);
            row.state.textContent = enabled
                ? status.pending
                    ? 'Loading'
                    : status.error
                        ? status.partial
                            ? 'Partly loaded'
                            : status.code === 'approval' || status.code === 'permission' ? 'Needs access' : 'Couldn’t load'
                        : ''
                : 'Off';
            row.heading.dataset.selected = String(enabled);
            row.heading.dataset.status = status.pending ? 'loading' : status.error ? 'error' : '';
            const view = readView();
            const zoom = view?.zoom;
            const zoomedOut = source.kind !== 'geojson'
                && typeof zoom === 'number'
                && Number.isFinite(zoom)
                && zoom < (source.source.minNativeZoom ?? 0) + (source.kind === 'mvt' || (source.kind === 'raster' && source.source.tileSize === 512) ? 1 : 0);
            if (enabled && zoomedOut) {
                row.value.hidden = true;
                row.spinner.hidden = true;
                row.state.textContent = 'Zoom in';
            }
            row.state.hidden = !row.state.textContent;
            row.attribution.textContent = [{ raster: 'Raster tiles', mvt: 'Vector tiles', geojson: 'GeoJSON' }[source.kind], source.attribution.text]
                .filter(Boolean).join(' · ');
            row.message.textContent = enabled
                ? zoomedOut
                    ? 'Zoom in to this source’s available range.'
                    : status.error && status.code === 'access'
                        ? 'Source unavailable. Check the URL or provider CORS settings.'
                        : status.error
                            ? customFailure(status)
                            : status.lower
                                ? 'Showing enlarged tiles from a lower zoom level. Zoom out for the source’s original detail.'
                                : status.pending ? 'Loading map tiles…' : status.message || 'Loading status appears here.'
                : 'Enable to load this source.';
            row.retry.setAttribute('aria-disabled', String(!enabled || Boolean(status.pending) || (status.retryAt ?? 0) > Date.now()));
            row.retry.dataset.bpbCustomRefresh = source.privateRequests ? source.id : '';
            row.retry.dataset.revision = String(source.revision);
            row.retry.dataset.mapId = mapId;
            row.retry.dataset.intent = row.intent;
            row.retry.textContent = status.error ? 'Retry' : 'Reload';
            row.approve.hidden = !source.privateRequests;
            row.approve.dataset.revision = String(source.revision);
            if (source.privateRequests && enabled && status.code === 'approval') {
                row.message.textContent = `Approve access in BPB, then Retry. Each approval allows up to ${PRIVATE_LIMITS.grantRequests.toLocaleString('en-US')} requests for ${PRIVATE_LIMITS.grantMs / 3600000} hours.`;
            }
        }
        const focused = list.contains(win.document.activeElement) ? win.document.activeElement as HTMLElement | null : null;
        sources.forEach((source, index) => {
            const row = rows.get(source.id);
            if (row && list.children[index] !== row.element) list.insertBefore(row.element, list.children[index] || null);
        });
        if (focused?.isConnected && win.document.activeElement === win.document.body) focused.focus({ preventScroll: true });
    };

    const onStatus = (id: string, nextStatus: CustomControlStatus | CustomOverlayStatus): void => {
        const before = statuses[id]?.message;
        statuses[id] = nextStatus;
        paint();
        if (!nextStatus.pending && nextStatus.message && nextStatus.message !== before) {
            live.textContent = `${sources.find(source => source.id === id)?.name || 'Overlay'}: ${nextStatus.error ? customFailure(nextStatus) : nextStatus.message}`;
        }
    };

    const getRegistry = async (): Promise<void> => {
        send({ type: 'get', mapId });
    };

    const cancelTasks = (): void => {
        for (const owner of taskJobs.values()) owner.abort();
        taskJobs.clear();
        for (const requestId of terrainTasks) {
            win.postMessage({ __bpbTerrain: true, dir: 'toCS', type: 'customTask', action: 'cancel', requestId, mapId }, win.location.origin);
            send({ type: 'taskReply', requestId, reply: { ok: false, error: 'Test cancelled. The map or source changed.' } });
        }
        terrainTasks.clear();
    };

    const handle = async (event: MessageEvent): Promise<void> => {
        const data = event.data as Record<string, unknown> | null | undefined;
        if (event.source !== win || event.origin !== win.location.origin || !data?.[tag] || data.dir !== 'toPage' || !active) return;
        if (data.type === 'registry') {
            if (data.mapId && data.mapId !== mapId) return;
            const registry = readCustomRegistry(data.registry) as CustomControlRegistry | null;
            if (!registry) {
                live.textContent = 'Saved overlays are unavailable. Retry by reopening the map.';
                return;
            }
            if (libraryGeneration !== null && libraryGeneration !== (registry.generation || 0)) {
                selected.clear();
                previewId = previewBaseline = pendingAdoption = null;
                cancelTasks();
            }
            libraryGeneration = registry.generation || 0;
            try {
                const url = new URL(String(data.settingsUrl ?? ''));
                if (['chrome-extension:', 'moz-extension:'].includes(url.protocol) && url.pathname === '/options/options.html') {
                    for (const link of section.querySelectorAll<HTMLAnchorElement>('[data-bpb-custom-settings]')) link.href = url.href;
                }
            } catch { /* Wait for the isolated bridge's packaged destination. */ }
            sources = registry.sources;
            preferences = (data.preferences as Record<string, number>) || {};
            registryVersion++;
            refreshes.clear();
            for (const id of selected.keys()) {
                const source = sources.find(item => item.id === id);
                if (source) selected.set(id, source.revision);
                else if (id !== previewId) selected.delete(id);
            }
            if (pendingAdoption) {
                for (const item of pendingAdoption) {
                    if (sources.some(source => source.id === item.id && source.revision === item.sourceRevision)) {
                        selected.set(item.id, item.sourceRevision);
                    }
                }
                pendingAdoption = null;
            }
            publish();
            paint();
        }
        if (data.type === 'settingsError') {
            live.textContent = String(data.message ?? '');
            live.classList.add('bpb-custom-error');
        }
        if (data.type === 'parsed') {
            const requestId = data.requestId as string;
            const entry = parseJobs.get(requestId);
            if (!entry) return;
            parseJobs.delete(requestId);
            entry.done();
            const reply = data.reply as { ok?: boolean; value?: CustomGeoJsonCollection | CustomMvtResult } | undefined;
            if (reply?.ok && reply.value !== undefined) entry.resolve(reply.value);
            else entry.reject(new Error('Invalid or oversized vector data.'));
        }
        if (data.mapId !== mapId) return;
        const messageId = data.id as string;
        if (data.type === 'refreshPending' && selected.get(messageId) === data.revision && rows.get(messageId)?.intent === data.intent) {
            refreshes.set(messageId, data.requestId as string);
            paint();
        }
        if (data.type === 'refreshReply' && refreshes.get(messageId) === data.requestId) {
            refreshes.delete(messageId);
            if (selected.get(messageId) !== data.revision || rows.get(messageId)?.intent !== data.intent) return;
            const reply = data.reply as { ok?: boolean; code?: string; error?: string } | undefined;
            if (reply?.ok) {
                reloads[messageId] = (reloads[messageId] || 0) + 1;
                publish();
                paint();
            } else {
                onStatus(messageId, {
                    ...statuses[messageId],
                    pending: false,
                    error: true,
                    code: reply?.code || 'private-source',
                    message: reply?.error || 'Couldn’t refresh this source. Try again.',
                });
            }
        }
        if (data.type === 'preview') {
            const sourceId = data.sourceId as string;
            if (!previewId) previewBaseline = { revision: selected.get(sourceId) };
            previewId = sourceId;
            selected.set(previewId, data.sourceRevision as number);
            send({ type: 'get', mapId });
        }
        if (data.type === 'previewEnd') {
            if (previewId && data.savedRevision !== selected.get(previewId)) {
                if (previewBaseline?.revision) selected.set(previewId, previewBaseline.revision);
                else selected.delete(previewId);
            }
            previewId = previewBaseline = null;
            void getRegistry();
        }
        if (data.type === 'taskCancel') {
            const requestId = data.requestId as string;
            taskJobs.get(requestId)?.abort();
            if (terrain) {
                win.postMessage({ __bpbTerrain: true, dir: 'toCS', type: 'customTask', requestId, action: 'cancel', mapId }, win.location.origin);
            }
            return;
        }
        if (data.type === 'task') {
            const source = readCustomSource(data.source) as CustomControlSource | null;
            const view = readView();
            if (!source) return;
            const requestId = data.requestId as string;
            if (terrain) {
                terrainTasks.add(requestId);
                win.postMessage({
                    __bpbTerrain: true,
                    dir: 'toCS',
                    type: 'customTask',
                    requestId,
                    mapId,
                    action: data.action,
                    id: source.id,
                    sourceRevision: source.revision,
                }, win.location.origin);
                return;
            }
            const owner = new AbortController();
            taskJobs.set(requestId, owner);
            const activeWin = native?.win || win;
            const client = createCustomClient({ fetchImpl: activeWin.fetch.bind(activeWin), parse, pool });
            try {
                let value: unknown;
                if (data.action === 'resolve') {
                    value = await client.resolve(
                        source as Parameters<typeof client.resolve>[0],
                        owner.signal,
                        false,
                        (data.detection as Parameters<typeof client.resolve>[3]) || {},
                    );
                } else if (data.action === 'test') {
                    value = await probeCustomSource(
                        client as Parameters<typeof probeCustomSource>[0],
                        source as Parameters<typeof probeCustomSource>[1],
                        view as Parameters<typeof probeCustomSource>[2],
                        owner.signal,
                        '2D',
                    );
                } else {
                    throw new Error('Choose a visible map to test this source.');
                }
                send({ type: 'taskReply', requestId, reply: { ok: true, value } });
            } catch (error) {
                send({ type: 'taskReply', requestId, reply: { ok: false, error: customFailure(error) } });
            } finally {
                taskJobs.delete(requestId);
            }
        }
    };

    const cancelParsers = (): void => {
        for (const [requestId, entry] of parseJobs) {
            entry.done();
            send({ type: 'cancelParse', requestId });
            entry.reject(new DOMException('Cancelled.', 'AbortError'));
        }
        parseJobs.clear();
    };

    const visibility = (): void => { if (win.document.hidden) cancelTasks(); };
    win.document.addEventListener('visibilitychange', visibility);
    win.addEventListener('message', handle);
    void getRegistry();

    return {
        section,
        mapId,
        snapshot: () => ({
            custom: [...selected].slice(0, 3).map(([id, sourceRevision]) => ({ id, sourceRevision, enabled: true })),
            customSession: mapId,
            customRevision: registryVersion,
            customOpacity: { ...preferences },
            customReloads: { ...reloads },
        }),
        adopt(value: unknown): void {
            pendingAdoption = readCustomSelection(value);
            for (const item of pendingAdoption) {
                if (sources.some(source => source.id === item.id && source.revision === item.sourceRevision)) {
                    selected.set(item.id, item.sourceRevision);
                }
            }
            publish();
            paint();
        },
        bind(owner: CustomRendererWindow, map: CustomRendererMap): void {
            engine?.dispose();
            native = { win: owner, map };
            engine = createCustomRenderer({
                win: owner,
                map,
                parse,
                pool,
                onStatus,
                requestWindow: win,
            } as CustomRendererOptions);
            publish();
            paint();
        },
        suspend(): void {
            refreshes.clear();
            for (const row of rows.values()) row.intent = crypto.randomUUID();
            engine?.dispose();
            engine = null;
            cancelParsers();
            cancelTasks();
        },
        mode(value: boolean): void {
            if (terrain !== value) {
                refreshes.clear();
                for (const row of rows.values()) row.intent = crypto.randomUUID();
                cancelTasks();
                for (const id of selected.keys()) statuses[id] = { pending: true };
            }
            terrain = value;
            if (value) {
                engine?.dispose();
                engine = null;
            }
            paint();
        },
        cancelTasks,
        taskReply(data: { mapId?: unknown; requestId?: unknown; reply?: unknown }): void {
            if (data.mapId === mapId && typeof data.requestId === 'string' && terrainTasks.delete(data.requestId)) {
                send({ type: 'taskReply', requestId: data.requestId, reply: data.reply });
            }
        },
        status: onStatus,
        refresh: paint,
        dispose(): void {
            active = false;
            engine?.dispose();
            cancelParsers();
            cancelTasks();
            win.removeEventListener('message', handle);
            win.document.removeEventListener('visibilitychange', visibility);
            section.remove();
        },
    };
}
