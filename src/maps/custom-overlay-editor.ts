// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isPeakbaggerPageOrigin } from '../peakbagger/peakbagger-origin.ts';
import { readCustomSource, customUrl, readCustomRegistry } from './custom-overlay-schema.ts';
import { createCustomParser } from './custom-overlay-parser.ts';
import { createCustomClient, customFailure } from './custom-overlay-client.ts';
import { readPrivateParameters, RELAY_HOST, type PrivateParameter } from './custom-overlay-private.ts';
import { inferCustomSourceUrl, defaultCustomRules } from './custom-overlay-source.ts';
import type { CustomParseRequest } from './custom-overlay-data.ts';

type CustomSourceKind = 'raster' | 'mvt' | 'geojson';
type CustomGeometryKind = 'point' | 'line' | 'polygon';

interface EditorRule {
    geometry: CustomGeometryKind;
    color: string;
    width?: number;
    radius?: number;
    fillOpacity?: number;
    sourceLayer?: string;
}

interface EditableSourceFields {
    dataUrl?: string;
    metadataUrl?: string;
    tiles?: string[];
    minNativeZoom?: number;
    maxNativeZoom?: number;
    zoomOrigin?: { min: string; max: string };
    metadataZoom?: { min: number; max: number; minDeclared: boolean; maxDeclared: boolean };
    scheme?: string;
    tileSize?: number;
    bounds?: number[] | null;
    manualFields?: string[];
}

interface EditableCustomSource {
    id: string;
    revision: number;
    name: string;
    kind: CustomSourceKind;
    privateRequests?: boolean;
    source: EditableSourceFields;
    approvedOrigins: string[];
    attribution: { text: string; url?: string };
    appearance: { opacity: number; rules: EditorRule[] };
    editSource?: EditableCustomSource;
    requestParameters?: PrivateParameter[];
    reconnect?: boolean;
}

interface RawPrivateFields {
    id?: unknown;
    editSource?: EditableCustomSource;
    requestParameters?: PrivateParameter[];
    reconnect?: unknown;
}

interface ParameterEntry {
    key: HTMLInputElement;
    value: HTMLInputElement;
    row: HTMLDivElement;
}

interface RuleControls {
    sourceLayer: HTMLInputElement;
    geometry: HTMLSelectElement;
    color: HTMLInputElement;
    width: HTMLInputElement;
    radius: HTMLInputElement;
    fillOpacity: HTMLInputElement;
}

interface RuleRecord {
    controls: RuleControls;
    row: HTMLDivElement;
}

interface PendingTask {
    resolve(value: unknown): void;
    reject(reason?: unknown): void;
    timer: ReturnType<typeof setTimeout>;
    done(): void;
}

interface ResolveTaskResult {
    source: EditableCustomSource;
    origins?: string[];
    layers?: string[];
}

interface EditorRuntimeReply {
    ok?: boolean;
    error?: string;
    value?: unknown;
    registry?: unknown;
}

const errorMessage = (error: unknown): string =>
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error ?? '');

const ext = globalThis.browser || globalThis.chrome;
const tag = '__bpbCustomOverlays';

if (parent === window) {
    location.replace(ext.runtime.getURL('options/options.html#custom-map-layers'));
} else {
    const token = location.hash.slice(1);
    const parser = createCustomParser(ext.runtime.getURL('custom-overlay/worker.js'));
    const client = createCustomClient({
        parse: parser.parse as NonNullable<Parameters<typeof createCustomClient>[0]>['parse'],
    });
    let parentOrigin: string | null = null;
    let mapId = '';
    let expectedRevision = 0;
    let sourceId = '';
    let pending = false;
    let dirty = false;
    let resolved: EditableCustomSource | null = null;
    let controller: AbortController | null = null;
    let openRevision = 0;
    let privateMode = false;
    let detectedKind: CustomSourceKind | null = null;
    let savedAttribution: { text: string; url?: string } = { text: '' };
    const manualFields = new Set<string>();
    const jobs = new Map<string, AbortController>();
    const tasks = new Map<string, PendingTask>();

    const send = (detail: Record<string, unknown>): void => {
        if (parentOrigin) parent.postMessage({ [tag]: true, token, ...detail }, parentOrigin);
    };
    const field = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
    const inputField = (id: string): HTMLInputElement => field<HTMLInputElement>(id);
    const selectField = (id: string): HTMLSelectElement => field<HTMLSelectElement>(id);
    const detailsField = (id: string): HTMLDetailsElement => field<HTMLDetailsElement>(id);
    const buttonField = (id: string): HTMLButtonElement => field<HTMLButtonElement>(id);
    const tipFor = (button: HTMLElement): HTMLElement | null => {
        const id = button.getAttribute('aria-describedby');
        return id ? field(id) : null;
    };

    const root = field('editor');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Custom map overlays');
    const scrollArea = field('editor-fields');
    const feedback = (message: string): void => {
        field('notice').hidden = !message;
        const feedbackEl = field('feedback');
        feedbackEl.textContent = message;
        if (message && feedbackEl.scrollHeight > feedbackEl.clientHeight) feedbackEl.tabIndex = 0;
        else feedbackEl.removeAttribute('tabindex');
    };

    const parameterRows: ParameterEntry[] = [];
    const addParameter = (parameter: PrivateParameter = { key: '', value: '' }): void => {
        if (parameterRows.length >= 12) return;
        const row = document.createElement('div');
        row.className = 'parameter-row';
        const key = document.createElement('input');
        const value = document.createElement('input');
        const remove = document.createElement('button');
        const id = crypto.randomUUID();
        key.id = `parameter-key-${id}`;
        value.id = `parameter-value-${id}`;
        key.maxLength = 80;
        value.maxLength = 2048;
        value.type = 'password';
        value.autocomplete = 'off';
        key.spellcheck = value.spellcheck = false;
        key.value = parameter.key;
        value.value = parameter.value;
        for (const [input, text] of [[key, 'Parameter name'], [value, 'Private value']] as const) {
            const label = document.createElement('label');
            label.htmlFor = input.id;
            label.textContent = text;
            const wrap = document.createElement('div');
            wrap.append(label, input);
            row.append(wrap);
        }
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', 'Remove request parameter');
        row.append(remove);
        const entry: ParameterEntry = { key, value, row };
        parameterRows.push(entry);
        field('parameter-list').append(row);
        remove.onclick = () => {
            dirty = true;
            resolved = null;
            controller?.abort();
            row.remove();
            parameterRows.splice(parameterRows.indexOf(entry), 1);
            buttonField('add-parameter').focus({ preventScroll: true });
        };
    };
    buttonField('add-parameter').onclick = () => {
        addParameter();
        parameterRows.at(-1)?.key.focus();
    };
    const parameters = (): PrivateParameter[] =>
        readPrivateParameters(parameterRows.map(({ key, value }) => ({ key: key.value.trim(), value: value.value })));

    let feedbackControl = 'test';
    buttonField('dismiss-feedback').onclick = () => {
        feedback('');
        field(feedbackControl).focus({ preventScroll: true });
    };

    let activeHelp: HTMLButtonElement | null = null;
    let pinnedHelp = false;
    let helpTimer: ReturnType<typeof setTimeout> | undefined;
    let pointerHelp: HTMLButtonElement | null = null;
    let pendingHelpFocus: HTMLButtonElement | null = null;

    const closeHelp = (): void => {
        clearTimeout(helpTimer);
        pendingHelpFocus = null;
        if (!activeHelp) return;
        const tip = tipFor(activeHelp);
        if (tip) tip.hidden = true;
        activeHelp.setAttribute('aria-expanded', 'false');
        activeHelp = null;
        pinnedHelp = false;
    };

    const showHelp = (button: HTMLButtonElement): number => {
        clearTimeout(helpTimer);
        const changed = activeHelp !== button;
        if (changed) closeHelp();
        activeHelp = button;
        const tip = tipFor(button);
        if (!tip) return 0;
        const previousScroll = changed ? 0 : tip.scrollTop;
        tip.hidden = false;
        tip.style.maxHeight = 'none';
        button.setAttribute('aria-expanded', 'true');
        const anchor = button.getBoundingClientRect();
        const box = tip.getBoundingClientRect();
        const gap = 8;
        tip.style.left = `${Math.max(gap, Math.min(anchor.left, document.documentElement.clientWidth - box.width - gap))}px`;
        const viewport = scrollArea.getBoundingClientRect();
        const topEdge = Math.max(gap, viewport.top + gap);
        const bottomEdge = Math.min(innerHeight, viewport.bottom) - gap;
        const below = Math.max(0, bottomEdge - anchor.bottom - gap);
        const above = Math.max(0, anchor.top - topEdge - gap);
        const useBelow = box.height <= below || box.height > above && below >= above;
        const available = Math.max(0, useBelow ? below : above);
        tip.style.maxHeight = `${available}px`;
        const top = useBelow ? anchor.bottom + gap : anchor.top - Math.min(box.height, available) - gap;
        tip.style.top = `${Math.max(topEdge, top)}px`;
        tip.scrollTop = previousScroll;
        return box.height;
    };

    for (const button of document.querySelectorAll<HTMLButtonElement>('.info')) {
        const tip = tipFor(button);
        if (!tip) continue;
        button.onpointerenter = () => { showHelp(button); };
        const focusHelp = (): void => {
            const height = showHelp(button);
            if (pointerHelp === button) return;
            const anchor = button.getBoundingClientRect();
            const viewport = scrollArea.getBoundingClientRect();
            const minimum = anchor.bottom - viewport.bottom + 8;
            const maximum = anchor.top - viewport.top - 8;
            let delta = Math.max(minimum, Math.min(maximum, 0));
            if (anchor.top - delta < viewport.top + height + 16 && viewport.bottom - anchor.bottom + delta < height + 16) {
                // Help can be taller than the entire field clip at browser
                // zoom. Preserve the trigger; overflowing help scrolls itself.
                delta = Math.max(minimum, Math.min(maximum, anchor.bottom + height + 16 - viewport.bottom));
            }
            // Browser zoom rounds scrolling to device pixels. Leave a pixel of
            // room so rounding cannot flip the tooltip back over its trigger.
            if (delta) scrollArea.scrollBy({ top: Math.ceil(delta) + 1, behavior: 'instant' });
            showHelp(button);
        };
        button.onfocus = () => {
            focusHelp();
            if (pointerHelp === button) return;
            // Firefox can complete native focus scrolling after the focus
            // handler. Recheck once before paint, owned by this focus intent.
            pendingHelpFocus = button;
            requestAnimationFrame(() => {
                if (pendingHelpFocus === button && document.activeElement === button) focusHelp();
                if (pendingHelpFocus === button) pendingHelpFocus = null;
            });
        };
        tip.onpointerenter = () => clearTimeout(helpTimer);
        const leave = (event: PointerEvent): void => {
            const related = event.relatedTarget as Node | null;
            if (activeHelp !== button || pinnedHelp || document.activeElement === button
                || button.contains(related) || tip.contains(related)) return;
            helpTimer = setTimeout(() => {
                if (activeHelp === button && !pinnedHelp && document.activeElement !== button
                    && !button.matches(':hover') && !tip.matches(':hover')) closeHelp();
            }, 200);
        };
        button.onpointerleave = tip.onpointerleave = leave;
        button.onblur = () => {
            if (activeHelp === button && !button.matches(':hover') && !tip.matches(':hover')) closeHelp();
        };
        button.onclick = () => {
            if (activeHelp === button && pinnedHelp) closeHelp();
            else {
                showHelp(button);
                pinnedHelp = true;
            }
        };
        button.addEventListener('keydown', event => {
            if (event.altKey || event.ctrlKey || event.metaKey || activeHelp !== button
                || tip.hidden || tip.scrollHeight <= tip.clientHeight) return;
            const line = parseFloat(getComputedStyle(tip).lineHeight) || 20;
            const deltas: Record<string, number> = {
                ArrowDown: line,
                ArrowUp: -line,
                PageDown: tip.clientHeight,
                PageUp: -tip.clientHeight,
                Home: -tip.scrollHeight,
                End: tip.scrollHeight,
            };
            const delta = deltas[event.key];
            if (delta == null) return;
            event.preventDefault();
            tip.scrollTop += delta;
        });
    }

    document.addEventListener('pointerdown', event => {
        const target = event.target as Element | null;
        pointerHelp = target?.closest<HTMLButtonElement>('.info') ?? null;
        if (!target?.closest('.info,.tooltip')) closeHelp();
    });
    const endPointer = (): void => { pointerHelp = null; };
    document.addEventListener('pointerup', endPointer);
    document.addEventListener('pointercancel', endPointer);

    const repositionHelp = (): void => {
        if (!activeHelp) return;
        const box = activeHelp.getBoundingClientRect();
        const viewport = scrollArea.getBoundingClientRect();
        if (!box.width || box.bottom <= viewport.top || box.top >= viewport.bottom) {
            if (pendingHelpFocus !== activeHelp) closeHelp();
        } else {
            showHelp(activeHelp);
        }
    };
    scrollArea.addEventListener('scroll', repositionHelp);
    window.addEventListener('scroll', repositionHelp);
    window.addEventListener('resize', repositionHelp);

    const ruleValues: RuleRecord[] = [];
    const addRule = (
        rule: EditorRule = { geometry: 'line', color: '#26734d', width: 2, radius: 5, fillOpacity: 0.3, sourceLayer: '' },
    ): void => {
        if (ruleValues.length >= 16) return;
        const row = document.createElement('div');
        row.className = 'rule';
        const index = crypto.randomUUID();
        const controls = {} as RuleControls;
        const ruleFields = [
            ['sourceLayer', 'Vector source layer', 'text', rule.sourceLayer || ''],
            ['geometry', 'Geometry', 'select', rule.geometry],
            ['color', 'Color', 'color', rule.color.slice(0, 7)],
            ['width', 'Line width', 'number', rule.width ?? 2],
            ['radius', 'Point radius', 'number', rule.radius ?? 5],
            ['fillOpacity', 'Polygon fill opacity (0–1)', 'number', rule.fillOpacity ?? 0.3],
        ] as const;
        for (const [key, label, type, value] of ruleFields) {
            const wrap = document.createElement('div');
            const caption = document.createElement('label');
            caption.textContent = label;
            const inputId = `${index}-${key}`;
            caption.htmlFor = inputId;
            if (key === 'geometry') {
                const select = document.createElement('select');
                select.id = inputId;
                for (const item of ['point', 'line', 'polygon']) {
                    const option = document.createElement('option');
                    option.value = option.textContent = item;
                    select.append(option);
                }
                select.value = value;
                controls.geometry = select;
                wrap.append(caption, select);
            } else {
                const input = document.createElement('input');
                input.id = inputId;
                input.type = type;
                if (type === 'number') {
                    input.step = key === 'fillOpacity' ? '.1' : '.5';
                    input.min = key === 'fillOpacity' ? '0' : key === 'width' ? '.5' : '1';
                    input.max = key === 'fillOpacity' ? '1' : key === 'width' ? '12' : '16';
                }
                input.value = String(value);
                controls[key] = input;
                wrap.append(caption, input);
                if (key === 'sourceLayer') {
                    wrap.dataset.sourceLayer = 'true';
                    input.setAttribute('list', 'source-layers');
                }
            }
            row.append(wrap);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove rule';
        const record: RuleRecord = { controls, row };
        ruleValues.push(record);
        remove.onclick = () => {
            ruleValues.splice(ruleValues.indexOf(record), 1);
            row.remove();
            dirty = true;
            manualFields.add('appearance');
            resolved = null;
            controller?.abort();
        };
        row.append(remove);
        field('rules').append(row);
        updateKind();
    };

    const sourceKind = (): CustomSourceKind => {
        const selectedKind = selectField('kind').value;
        return selectedKind === 'auto'
            ? detectedKind || inferCustomSourceUrl(inputField('url').value.trim())?.kind || 'raster'
            : selectedKind as CustomSourceKind;
    };
    const sourceFormat = (): 'template' | 'tilejson' => {
        const selectedFormat = selectField('format').value;
        return selectedFormat === 'auto'
            ? inferCustomSourceUrl(inputField('url').value.trim())?.format || 'template'
            : selectedFormat as 'template' | 'tilejson';
    };
    const detection = () => ({
        detectKind: selectField('kind').value === 'auto',
        styleAuto: selectField('kind').value === 'auto' && !manualFields.has('appearance'),
        manualFields: [...manualFields],
        inspect: true,
    });
    const replaceRules = (rules: readonly EditorRule[]): void => {
        ruleValues.length = 0;
        field('rules').replaceChildren();
        for (const rule of rules) {
            addRule({ ...rule, sourceLayer: rule.sourceLayer === '__choose_layer__' ? '' : rule.sourceLayer });
        }
    };

    function updateKind(): void {
        const kind = sourceKind();
        const geo = kind === 'geojson';
        field('tile-fields').hidden = geo;
        selectField('format').hidden = field('format-label').hidden = geo;
        buttonField('source-values').hidden = geo || sourceFormat() !== 'tilejson';
        selectField('tile-size').hidden = field('tile-size-label').hidden = kind !== 'raster';
        field('appearance').hidden = kind === 'raster';
        for (const wrap of document.querySelectorAll<HTMLElement>('[data-source-layer]')) wrap.hidden = kind !== 'mvt';
        buttonField('preview').disabled = !mapId;
        buttonField('preview').hidden = !mapId && parent !== window;
        buttonField('test').textContent = mapId ? 'Test source' : 'Check source';
        buttonField('test').disabled = false;
        const urlValue = inputField('url').value.trim();
        const hint = inferCustomSourceUrl(urlValue);
        field('source-summary').textContent = !urlValue
            ? 'Paste a source URL to detect its format.'
            : !resolved && !geo && sourceFormat() === 'tilejson'
                ? 'JSON source · Check or Save to detect details.'
                : geo
                    ? 'GeoJSON · appearance is available in Advanced.'
                    : kind === 'mvt'
                        ? `Vector tiles · ${ruleValues.every(({ controls }) => controls.sourceLayer.value) ? 'source layer filled' : 'source layer needed in Advanced'}`
                        : selectField('kind').value === 'auto' && hint?.format === 'template' && !hint.kind
                            ? 'Tile type unclear. Choose Source type in Advanced.'
                            : `Raster tiles · ${selectField('scheme').value.toUpperCase()} · zoom ${inputField('minimum').value}–${inputField('maximum').value}${['minimum', 'maximum'].some(id => inputField(id).dataset.origin === 'manual') ? ' (custom)' : resolved?.source.metadataZoom ? '' : ' (defaults)'}`;
    }

    const sourceFromForm = (discover = false): EditableCustomSource => {
        const kind = sourceKind();
        const url = inputField('url').value.trim();
        const tiled = kind !== 'geojson';
        const tiles = tiled && sourceFormat() === 'template' ? [url] : [];
        if (!customUrl(url, tiles.length > 0)) {
            throw new Error('Use a public HTTPS URL with {z}, {x} and {y} for tile templates.');
        }
        if (tiles.length && selectField('kind').value === 'auto' && !inferCustomSourceUrl(url)?.kind) {
            detailsField('advanced').open = true;
            throw new Error('The URL does not identify its tile type. Choose Source type in Advanced.');
        }
        const raw = {
            id: sourceId,
            revision: expectedRevision + 1,
            name: inputField('name').value.trim(),
            kind,
            source: {
                ...(tiled
                    ? {
                        tiles,
                        ...(tiles.length ? {} : { metadataUrl: url }),
                        minNativeZoom: +inputField('minimum').value,
                        maxNativeZoom: +inputField('maximum').value,
                        zoomOrigin: {
                            min: inputField('minimum').dataset.origin || 'default',
                            max: inputField('maximum').dataset.origin || 'default',
                        },
                        scheme: selectField('scheme').value,
                        tileSize: +selectField('tile-size').value,
                    }
                    : { dataUrl: url }),
                bounds: inputField('bounds').value.trim() ? inputField('bounds').value.split(',').map(Number) : null,
                manualFields: [...manualFields].filter(key => ['scheme', 'tile-size', 'bounds'].includes(key)),
            },
            approvedOrigins: [...new Set([new URL(url).origin, ...(resolved?.approvedOrigins || [])])],
            attribution: { ...savedAttribution },
            appearance: {
                opacity: resolved?.appearance.opacity ?? 60,
                rules: kind === 'raster' ? [] : ruleValues.map(({ controls }) => ({
                    sourceLayer: !controls.sourceLayer.value && discover ? '__choose_layer__' : controls.sourceLayer.value,
                    geometry: controls.geometry.value,
                    color: controls.color.value,
                    width: +controls.width.value,
                    radius: +controls.radius.value,
                    fillOpacity: +controls.fillOpacity.value,
                })),
            },
        };
        const source = readCustomSource(raw) as EditableCustomSource | null;
        if (!source) {
            detailsField('advanced').open = true;
            throw new Error('Check the zoom range, bounds and appearance in Advanced. Vector tiles need a source layer; use TileJSON to detect it.');
        }
        if (resolved && resolved.kind !== 'geojson' && source.kind !== 'geojson'
            && resolved.source.metadataUrl === source.source.metadataUrl) {
            source.source.tiles = resolved.source.tiles;
            if (resolved.source.metadataZoom) source.source.metadataZoom = resolved.source.metadataZoom;
        }
        return source;
    };

    const task = async (action: string, source: EditableCustomSource): Promise<unknown> => {
        if (!controller) throw new DOMException('Cancelled.', 'AbortError');
        const signal = controller.signal;
        if (parameters().length || privateMode) {
            if (action !== 'resolve') throw new Error('Save this private source, then approve and enable it on a map.');
            const abort = (): void => { void ext.runtime.sendMessage({ type: 'CUSTOM_PRIVATE_CHECK_CANCEL' }).catch(() => {}); };
            signal.addEventListener('abort', abort, { once: true });
            try {
                const reply = await ext.runtime.sendMessage<Record<string, unknown>, EditorRuntimeReply | undefined>({
                    type: 'CUSTOM_PRIVATE_CHECK',
                    source,
                    requestParameters: parameters(),
                    detection: detection(),
                });
                if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
                if (!reply?.ok) throw new Error(reply?.error || 'Private source could not be checked.');
                return reply.value;
            } finally {
                signal.removeEventListener('abort', abort);
            }
        }
        if (!mapId) {
            return action === 'resolve'
                ? client.resolve(
                    source as Parameters<typeof client.resolve>[0],
                    signal,
                    false,
                    detection() as Parameters<typeof client.resolve>[3],
                )
                : Promise.reject(new Error('Choose a map to test tiles.'));
        }
        const grant = await ext.runtime.sendMessage<Record<string, unknown>, EditorRuntimeReply | undefined>({
            type: 'CUSTOM_OVERLAYS_PREVIEW',
            mapId,
            source,
        });
        if (!grant?.ok) throw new Error(grant?.error || 'Source test unavailable.');
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const cancel = (): void => {
                send({ type: 'task', detail: { type: 'taskCancel', requestId, mapId } });
                tasks.delete(requestId);
                clearTimeout(timer);
                reject(new DOMException('Cancelled.', 'AbortError'));
            };
            const timer = setTimeout(cancel, 30000);
            if (signal.aborted) { cancel(); return; }
            signal.addEventListener('abort', cancel, { once: true });
            tasks.set(requestId, { resolve, reject, timer, done: () => signal.removeEventListener('abort', cancel) });
            send({ type: 'task', detail: { type: 'task', requestId, mapId, action, source, detection: detection() } });
        });
    };

    const busy = (value: boolean): void => {
        pending = value;
        for (const id of ['preview', 'test', 'save']) field(id).setAttribute('aria-disabled', String(value));
    };

    const run = async (action: 'save' | 'preview' | 'test' | 'resolve'): Promise<void> => {
        if (pending) return;
        feedbackControl = action === 'resolve' ? 'test' : action;
        busy(true);
        dirty = false;
        const work = controller = new AbortController();
        const opening = openRevision;
        const current = (): boolean => controller === work && !work.signal.aborted && opening === openRevision;
        feedback(action === 'save' ? 'Saving…' : 'Checking source…');
        try {
            if (!field<HTMLFormElement>('form').reportValidity()) {
                feedback('Check the highlighted fields.');
                return;
            }
            let source = sourceFromForm(true);
            const requestParameters = parameters();
            if (requestParameters.length || privateMode) {
                // Called directly from Save/Check before any asynchronous work.
                const origins = source.approvedOrigins.map(origin => `https://${new URL(origin).hostname}/*`);
                if (!await ext.permissions.request({ origins })) {
                    throw new Error('Provider access wasn’t granted. Your entries are still here.');
                }
                if (!current()) throw new DOMException('Cancelled.', 'AbortError');
            }
            const automatic = selectField('kind').value === 'auto'
                || source.kind !== 'geojson' && selectField('format').value === 'auto';
            const resolvable = Boolean(source.source.metadataUrl) || source.kind === 'geojson';
            if (action !== 'save' || automatic && !resolved && resolvable) {
                const result = await task('resolve', source) as ResolveTaskResult;
                if (!current() || dirty) return;
                resolved = result.source;
                source = resolved;
                if (selectField('kind').value === 'auto') detectedKind = source.kind;
                if (detection().styleAuto && source.kind !== 'raster') replaceRules(source.appearance.rules);
                if (source.kind === 'mvt' && result.layers?.length) {
                    const layerNames = result.layers;
                    field('source-layers').replaceChildren(...layerNames.map(name => {
                        const option = document.createElement('option');
                        option.value = name;
                        return option;
                    }));
                    for (const { controls } of ruleValues) {
                        if (!controls.sourceLayer.value && layerNames.length === 1) controls.sourceLayer.value = layerNames[0];
                    }
                }
                if (!manualFields.has('bounds')) inputField('bounds').value = source.source.bounds?.join(', ') || '';
                if (source.kind !== 'geojson') {
                    for (const [id, key] of [['minimum', 'min'], ['maximum', 'max']] as const) {
                        if (inputField(id).dataset.origin !== 'manual') {
                            inputField(id).value = String(source.source[key === 'min' ? 'minNativeZoom' : 'maxNativeZoom'] ?? '');
                            inputField(id).dataset.origin = source.source.zoomOrigin?.[key] || 'default';
                        }
                    }
                    selectField('scheme').value = source.source.scheme || 'xyz';
                    if (source.kind === 'raster') selectField('tile-size').value = String(source.source.tileSize ?? 256);
                    const declared = source.source.metadataZoom;
                    field('zoom-origin').textContent = `Minimum: ${source.source.zoomOrigin?.min || 'default'}; maximum: ${source.source.zoomOrigin?.max || 'default'}.`
                        + (declared ? ` Source: ${declared.min}–${declared.max}${declared.maxDeclared ? '' : ' (default maximum)'}. BPB supports zooms up to 22.` : '');
                }
                updateKind();
                if (result.origins?.length) {
                    const actionLabel = action === 'save' ? 'Save' : action === 'preview' ? 'Preview' : buttonField('test').textContent;
                    feedback(`Tile hosts: ${result.source.approvedOrigins.join(', ')}. Click ${actionLabel} again to approve and continue.`);
                    return;
                }
                if (action === 'test') {
                    const tested = await task('test', source) as { message: string };
                    if (!dirty) feedback(tested.message);
                    return;
                }
                if (action === 'resolve') {
                    feedback(
                        source.kind === 'mvt' && ruleValues.some(({ controls }) => !controls.sourceLayer.value)
                            ? 'Source detected. Choose a vector source layer in Advanced, then Save.'
                            : source.kind !== 'geojson' && !source.source.metadataUrl
                                ? 'Tile template recognized. Review defaults or overrides in Advanced, then Save. Tile coverage has not been tested.'
                                : 'Source values loaded. Save when ready; Advanced contains the detected details. Tile coverage has not been tested.',
                    );
                    return;
                }
            }
            source = sourceFromForm();
            if (!current()) return;
            if (action === 'preview') {
                const reply = await ext.runtime.sendMessage<Record<string, unknown>, EditorRuntimeReply | undefined>({
                    type: 'CUSTOM_OVERLAYS_PREVIEW',
                    mapId,
                    source,
                });
                if (!reply?.ok) throw new Error(reply?.error || 'Preview unavailable.');
                send({ type: 'preview', detail: { type: 'preview', mapId, sourceId: source.id, sourceRevision: source.revision } });
                feedback('Preview enabled on the map. Check its loading status; saving keeps this selection.');
            } else {
                const reply = await ext.runtime.sendMessage<Record<string, unknown>, EditorRuntimeReply | undefined>({
                    type: 'CUSTOM_OVERLAYS_SAVE',
                    id: sourceId,
                    source,
                    expectedRevision,
                    requestParameters,
                });
                if (!reply?.ok) throw new Error(reply?.error || 'Couldn’t save.');
                if (opening !== openRevision || source.id !== sourceId) return;
                expectedRevision++;
                feedback(current() ? 'Saved on this device.' : 'Earlier values saved. Review your changes and Save again.');
                await library();
            }
        } catch (error) {
            if (current() && (error as { name?: unknown } | null)?.name !== 'AbortError') feedback(customFailure(error));
        } finally {
            if (controller === work) {
                busy(false);
                controller = null;
            }
        }
    };

    const reset = (source?: EditableCustomSource | null): void => {
        closeHelp();
        privateMode = source?.privateRequests === true;
        detectedKind = source?.kind || null;
        sourceId = source?.id || 'custom:' + crypto.randomUUID();
        expectedRevision = source?.revision || 0;
        resolved = source || null;
        dirty = false;
        // These credits are no longer editable here. Keep existing/imported
        // provider attribution through ordinary edits, checks and previews.
        savedAttribution = { ...(source?.attribution || { text: '' }) };
        field('form-title').textContent = source ? 'Edit overlay' : 'Add custom overlay';
        manualFields.clear();
        if (source) {
            for (const key of source.source.manualFields || ['scheme', 'tile-size', 'bounds']) manualFields.add(key);
            manualFields.add('appearance');
        }
        detailsField('advanced').open = !!source;
        inputField('name').value = source?.name || '';
        selectField('kind').value = source?.kind || 'auto';
        const tiledSource = source && source.kind !== 'geojson' ? source.source : null;
        inputField('url').value = source?.kind === 'geojson'
            ? source.source.dataUrl || ''
            : tiledSource?.metadataUrl || tiledSource?.tiles?.[0] || '';
        if (source?.reconnect || inputField('url').value.includes(RELAY_HOST)) inputField('url').value = '';
        parameterRows.length = 0;
        field('parameter-list').replaceChildren();
        for (const parameter of source?.requestParameters || []) addParameter(parameter);
        detailsField('private-parameters').open = parameterRows.length > 0;
        selectField('format').value = source ? (tiledSource?.metadataUrl ? 'tilejson' : 'template') : 'auto';
        inputField('minimum').value = String(tiledSource?.minNativeZoom ?? 0);
        inputField('maximum').value = String(tiledSource?.maxNativeZoom ?? 18);
        inputField('minimum').dataset.origin = tiledSource?.zoomOrigin?.min || 'default';
        inputField('maximum').dataset.origin = tiledSource?.zoomOrigin?.max || 'default';
        field('zoom-origin').textContent = source
            ? `Minimum: ${inputField('minimum').dataset.origin}; maximum: ${inputField('maximum').dataset.origin}.`
            : 'Default — not checked';
        field('source-layers').replaceChildren();
        selectField('scheme').value = tiledSource?.scheme || 'xyz';
        selectField('tile-size').value = String(source?.kind === 'raster' ? source.source.tileSize || 256 : 256);
        inputField('bounds').value = source?.source.bounds?.join(', ') || '';
        ruleValues.length = 0;
        field('rules').replaceChildren();
        for (const rule of source?.appearance.rules.length ? source.appearance.rules : [undefined]) addRule(rule);
        buttonField('remove').hidden = !source;
        feedback('');
        updateKind();
    };

    async function library(): Promise<{ schemaVersion: number; revision: number; generation?: number; sources: EditableCustomSource[] }> {
        const reply = await ext.runtime.sendMessage<Record<string, unknown>, EditorRuntimeReply | undefined>({
            type: 'CUSTOM_OVERLAYS_GET',
        });
        const registry = reply?.ok && readCustomRegistry(reply.registry);
        if (!registry) throw new Error('Saved overlays are unavailable.');
        // The schema intentionally drops secrets. Reattach only this trusted
        // Settings-only reply's private editor fields; never post them out.
        const rawSources = Array.isArray((reply.registry as { sources?: unknown } | undefined)?.sources)
            ? (reply.registry as { sources: RawPrivateFields[] }).sources
            : [];
        const editableSources: EditableCustomSource[] = (registry.sources as EditableCustomSource[]).map(source => {
            const raw = rawSources.find(item => item.id === source.id);
            return source.privateRequests && raw ? {
                ...source,
                editSource: raw.editSource,
                requestParameters: Array.isArray(raw.requestParameters) ? raw.requestParameters : [],
                reconnect: raw.reconnect === true,
            } : { ...source };
        });
        const list = field('library');
        list.replaceChildren();
        if (!mapId && parent === window) {
            for (const source of editableSources) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = source.name;
                button.onclick = () => reset(source);
                list.append(button);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Add custom overlay';
            button.onclick = () => reset();
            list.append(button);
        }
        return { ...registry, sources: editableSources };
    }

    const stopPreview = async (): Promise<void> => {
        controller?.abort();
        for (const entry of tasks.values()) {
            clearTimeout(entry.timer);
            entry.done();
            entry.reject(new DOMException('Cancelled.', 'AbortError'));
        }
        tasks.clear();
        if (mapId) {
            await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_PREVIEW', mapId, source: null });
            send({ type: 'previewEnd', detail: { type: 'previewEnd', mapId, savedRevision: expectedRevision } });
        }
    };

    field<HTMLFormElement>('form').onsubmit = event => { event.preventDefault(); void run('save'); };
    buttonField('preview').onclick = () => { dirty = false; void run('preview'); };
    buttonField('test').onclick = () => { dirty = false; void run(mapId ? 'test' : 'resolve'); };
    buttonField('add-rule').onclick = () => {
        dirty = true;
        manualFields.add('appearance');
        resolved = null;
        controller?.abort();
        addRule();
    };
    buttonField('source-values').onclick = () => {
        inputField('minimum').dataset.origin = inputField('maximum').dataset.origin = 'default';
        for (const key of ['scheme', 'tile-size', 'bounds']) manualFields.delete(key);
        resolved = null;
        dirty = false;
        void run('resolve');
    };
    buttonField('remove').onclick = async () => {
        if (pending || !expectedRevision) return;
        busy(true);
        try {
            const reply = await ext.runtime.sendMessage<Record<string, unknown>, EditorRuntimeReply | undefined>({
                type: 'CUSTOM_OVERLAYS_REMOVE',
                id: sourceId,
                expectedRevision,
            });
            if (!reply?.ok) throw new Error(reply?.error || 'Couldn’t remove.');
            await stopPreview();
            reset();
            await library();
            feedback('Overlay removed.');
        } catch (error) {
            feedback(errorMessage(error));
        } finally {
            busy(false);
        }
    };
    buttonField('cancel').onclick = () => {
        closeHelp();
        void stopPreview().finally(() => send({ type: 'close' }));
    };

    document.addEventListener('keydown', event => {
        if (event.key === 'Tab' && parent !== window) {
            const controls = [...document.querySelectorAll<HTMLElement>('button,input,select,summary,a[href],[tabindex="0"]')]
                .filter(element => !(element as { disabled?: boolean }).disabled && element.getClientRects().length);
            const index = controls.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && index <= 0) {
                event.preventDefault();
                controls.at(-1)?.focus();
            } else if (!event.shiftKey && index === controls.length - 1) {
                event.preventDefault();
                controls[0]?.focus();
            }
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            if (activeHelp) closeHelp();
            else buttonField('cancel').click();
        }
    });

    field<HTMLFormElement>('form').addEventListener('input', event => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        dirty = true;
        resolved = null;
        if (['minimum', 'maximum'].includes(target.id)) target.dataset.origin = 'manual';
        if (['scheme', 'tile-size', 'bounds'].includes(target.id)) manualFields.add(target.id);
        if (field('appearance').contains(target)) manualFields.add('appearance');
        controller?.abort();
        if (pending) feedback('Source changed. Check or Save again.');
        if (target.id === 'url') {
            detectedKind = null;
            for (const [id, value] of [['minimum', '0'], ['maximum', '18']] as const) {
                if (inputField(id).dataset.origin !== 'manual') {
                    inputField(id).value = value;
                    inputField(id).dataset.origin = 'default';
                }
            }
            for (const [id, value] of [['scheme', 'xyz'], ['tile-size', '256'], ['bounds', '']] as const) {
                if (!manualFields.has(id)) field<HTMLInputElement | HTMLSelectElement>(id).value = value;
            }
            if (selectField('kind').value === 'auto' && !manualFields.has('appearance')) {
                replaceRules(
                    (sourceKind() === 'raster' ? defaultCustomRules('', ['line']) : defaultCustomRules()) as EditorRule[],
                );
            }
        }
        updateKind();
    });

    field<HTMLFormElement>('form').addEventListener('change', event => {
        const target = event.target as HTMLInputElement | null;
        if (target?.id.endsWith('-sourceLayer') && target.value) {
            for (const { controls } of ruleValues) {
                if (!controls.sourceLayer.value) controls.sourceLayer.value = target.value;
            }
        }
    });

    selectField('kind').onchange = () => { detectedKind = null; void stopPreview(); updateKind(); };
    selectField('format').onchange = () => { void stopPreview(); updateKind(); };
    inputField('url').onchange = () => { void stopPreview(); };

    window.addEventListener('message', event => {
        const data = event.data as Record<string, unknown> | null | undefined;
        let optionsParent = false;
        try {
            const expected = new URL(ext.runtime.getURL('options/options.html'));
            optionsParent = event.origin === `${expected.protocol}//${expected.host}` && parent.location.pathname === expected.pathname;
        } catch { /* Peakbagger is cross-origin. */ }
        if (event.source !== parent || !data?.[tag] || data.token !== token || !isPeakbaggerPageOrigin(event.origin) && !optionsParent) return;
        parentOrigin = event.origin;
        if (data.type === 'hello') send({ type: 'ready' });
        if (data.type === 'open') {
            const revision = ++openRevision;
            if (optionsParent) root.setAttribute('role', 'form');
            void stopPreview().then(async () => {
                mapId = typeof data.mapId === 'string' ? data.mapId : '';
                document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
                const registry = await library();
                if (revision !== openRevision) return;
                const source = registry.sources.find(item => item.id === data.sourceId);
                reset(source?.editSource ? { ...source.editSource, privateRequests: true, requestParameters: source.requestParameters } : source);
                send({ type: 'opened' });
                inputField('name').focus();
            }).catch(error => {
                feedback(errorMessage(error));
                send({ type: 'opened' });
            });
        }
        if (data.type === 'theme' && optionsParent) {
            document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
        }
        if (data.type === 'dismiss') {
            closeHelp();
            openRevision++;
            void stopPreview();
        }
        if (data.type === 'parse') {
            const requestId = data.requestId as string;
            const owner = new AbortController();
            jobs.set(requestId, owner);
            parser.parse(data.job as CustomParseRequest, owner.signal).then(
                value => send({ type: 'parsed', requestId, reply: { ok: true, value } }),
                () => send({ type: 'parsed', requestId, reply: { ok: false } }),
            ).finally(() => jobs.delete(requestId));
        }
        if (data.type === 'cancelParse') {
            const requestId = data.requestId as string;
            jobs.get(requestId)?.abort();
            jobs.delete(requestId);
        }
        if (data.type === 'taskReply') {
            const requestId = data.requestId as string;
            const entry = tasks.get(requestId);
            if (!entry) return;
            tasks.delete(requestId);
            clearTimeout(entry.timer);
            entry.done();
            const reply = data.reply as EditorRuntimeReply | undefined;
            if (reply?.ok) entry.resolve(reply.value);
            else entry.reject(new Error(reply?.error || 'Couldn’t load this source. Check the URL and CORS settings.'));
        }
    });

    window.addEventListener('pagehide', () => {
        closeHelp();
        parser.dispose();
        controller?.abort();
    });
    reset();
    void library().catch(error => feedback(errorMessage(error)));
}
