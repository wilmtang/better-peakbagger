// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isPeakbaggerPageOrigin } from '../peakbagger/peakbagger-origin.js';
import { readCustomSource, customUrl, readCustomRegistry } from './custom-overlay-schema.js';
import { createCustomParser } from './custom-overlay-parser.js';
import { createCustomClient, customFailure } from './custom-overlay-client.js';
import { readPrivateParameters, RELAY_HOST } from './custom-overlay-private.js';
import { inferCustomSourceUrl, defaultCustomRules } from './custom-overlay-source.js';

const ext = globalThis.browser || globalThis.chrome, tag = '__bpbCustomOverlays';
if (parent === window) {
    location.replace(ext.runtime.getURL('options/options.html#custom-map-layers'));
} else {
    const token = location.hash.slice(1), parser = createCustomParser(ext.runtime.getURL('custom-overlay/worker.js'));
    const client = createCustomClient({ parse: parser.parse });
    let parentOrigin = null, mapId = '', expectedRevision = 0, sourceId = '', pending = false, dirty = false, resolved = null, controller = null;
    let openRevision = 0, privateMode = false, detectedKind = null;
    let savedAttribution = { text: '' };
    const manualFields = new Set();
    const jobs = new Map(), tasks = new Map();
    const send = detail => { if (parentOrigin) parent.postMessage({ [tag]: true, token, ...detail }, parentOrigin); };
    const root = document.getElementById('editor');
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Custom map overlays');
    const field = id => document.getElementById(id), scrollArea = field('editor-fields'), feedback = message => {
        field('notice').hidden = !message; field('feedback').textContent = message;
        if (message && field('feedback').scrollHeight > field('feedback').clientHeight) field('feedback').tabIndex = 0;
        else field('feedback').removeAttribute('tabindex');
    };
    const parameterRows = [];
    const addParameter = (parameter = { key: '', value: '' }) => {
        if (parameterRows.length >= 12) return;
        const row = document.createElement('div');row.className = 'parameter-row';
        const key = document.createElement('input'), value = document.createElement('input'), remove = document.createElement('button');
        const id = crypto.randomUUID();key.id = `parameter-key-${id}`;value.id = `parameter-value-${id}`;
        key.maxLength = 80;value.maxLength = 2048;value.type = 'password';value.autocomplete = 'off';key.spellcheck = value.spellcheck = false;
        key.value = parameter.key;value.value = parameter.value;
        for (const [input, text] of [[key, 'Parameter name'], [value, 'Private value']]) { const label = document.createElement('label');label.htmlFor = input.id;label.textContent = text;const wrap = document.createElement('div');wrap.append(label, input);row.append(wrap); }
        remove.type = 'button';remove.textContent = 'Remove';remove.setAttribute('aria-label', 'Remove request parameter');row.append(remove);
        const entry = { key, value, row };parameterRows.push(entry);field('parameter-list').append(row);
        remove.onclick = () => { dirty = true;resolved = null;controller?.abort();row.remove();parameterRows.splice(parameterRows.indexOf(entry), 1);field('add-parameter').focus({ preventScroll: true }); };
    };
    field('add-parameter').onclick = () => { addParameter();parameterRows.at(-1)?.key.focus(); };
    const parameters = () => readPrivateParameters(parameterRows.map(({ key, value }) => ({ key: key.value.trim(), value: value.value })));
    let feedbackControl = 'test';
    field('dismiss-feedback').onclick = () => { feedback(''); field(feedbackControl).focus({ preventScroll: true }); };
    let activeHelp = null, pinnedHelp = false, helpTimer, pointerHelp = null, pendingHelpFocus = null;
    const closeHelp = () => {
        clearTimeout(helpTimer);
        pendingHelpFocus = null;
        if (!activeHelp) return;
        field(activeHelp.getAttribute('aria-describedby')).hidden = true;
        activeHelp.setAttribute('aria-expanded', 'false'); activeHelp = null; pinnedHelp = false;
    };
    const showHelp = button => {
        clearTimeout(helpTimer);
        const changed = activeHelp !== button;
        if (changed) closeHelp();
        activeHelp = button;
        const tip = field(button.getAttribute('aria-describedby')), previousScroll = changed ? 0 : tip.scrollTop;
        tip.hidden = false; tip.style.maxHeight = 'none'; button.setAttribute('aria-expanded', 'true');
        const anchor = button.getBoundingClientRect(), box = tip.getBoundingClientRect(), gap = 8;
        tip.style.left = `${Math.max(gap, Math.min(anchor.left, document.documentElement.clientWidth - box.width - gap))}px`;
        const viewport = scrollArea.getBoundingClientRect();
        const topEdge = Math.max(gap, viewport.top + gap), bottomEdge = Math.min(innerHeight, viewport.bottom) - gap;
        const below = Math.max(0, bottomEdge - anchor.bottom - gap), above = Math.max(0, anchor.top - topEdge - gap);
        const useBelow = box.height <= below || box.height > above && below >= above;
        const available = Math.max(0, useBelow ? below : above);
        tip.style.maxHeight = `${available}px`;
        const top = useBelow ? anchor.bottom + gap : anchor.top - Math.min(box.height, available) - gap;
        tip.style.top = `${Math.max(topEdge, top)}px`;
        tip.scrollTop = previousScroll;
        return box.height;
    };
    for (const button of document.querySelectorAll('.info')) {
        const tip = field(button.getAttribute('aria-describedby'));
        button.onpointerenter = () => showHelp(button);
        const focusHelp = () => {
            const height = showHelp(button);
            if (pointerHelp === button) return;
            const anchor = button.getBoundingClientRect();
            const viewport = scrollArea.getBoundingClientRect();
            const minimum = anchor.bottom - viewport.bottom + 8, maximum = anchor.top - viewport.top - 8;
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
        const leave = event => {
            if (activeHelp !== button || pinnedHelp || document.activeElement === button || button.contains(event.relatedTarget) || tip.contains(event.relatedTarget)) return;
            helpTimer = setTimeout(() => { if (activeHelp === button && !pinnedHelp && document.activeElement !== button && !button.matches(':hover') && !tip.matches(':hover')) closeHelp(); }, 200);
        };
        button.onpointerleave = tip.onpointerleave = leave;
        button.onblur = () => { if (activeHelp === button && !button.matches(':hover') && !tip.matches(':hover')) closeHelp(); };
        button.onclick = () => { if (activeHelp === button && pinnedHelp) closeHelp(); else { showHelp(button); pinnedHelp = true; } };
        button.addEventListener('keydown', event => {
            if (event.altKey || event.ctrlKey || event.metaKey || activeHelp !== button || tip.hidden || tip.scrollHeight <= tip.clientHeight) return;
            const line = parseFloat(getComputedStyle(tip).lineHeight) || 20;
            const delta = { ArrowDown: line, ArrowUp: -line, PageDown: tip.clientHeight, PageUp: -tip.clientHeight,
                Home: -tip.scrollHeight, End: tip.scrollHeight }[event.key];
            if (delta == null) return;
            event.preventDefault(); tip.scrollTop += delta;
        });
    }
    document.addEventListener('pointerdown', event => { pointerHelp = event.target.closest('.info'); if (!event.target.closest('.info,.tooltip')) closeHelp(); });
    const endPointer = () => { pointerHelp = null; };
    document.addEventListener('pointerup', endPointer); document.addEventListener('pointercancel', endPointer);
    const repositionHelp = () => {
        if (!activeHelp) return;
        const box = activeHelp.getBoundingClientRect(), viewport = scrollArea.getBoundingClientRect();
        if (!box.width || box.bottom <= viewport.top || box.top >= viewport.bottom) {
            if (pendingHelpFocus !== activeHelp) closeHelp();
        } else showHelp(activeHelp);
    };
    scrollArea.addEventListener('scroll', repositionHelp);
    window.addEventListener('scroll', repositionHelp); window.addEventListener('resize', repositionHelp);
    const ruleValues = [];
    const addRule = (rule = { geometry: 'line', color: '#26734d', width: 2, radius: 5, fillOpacity: .3, sourceLayer: '' }) => {
        if (ruleValues.length >= 16) return;
        const row = document.createElement('div'); row.className = 'rule';
        const index = crypto.randomUUID();
        const controls = {};
        for (const [key, label, type, value] of [['sourceLayer', 'Vector source layer', 'text', rule.sourceLayer || ''], ['geometry', 'Geometry', 'select', rule.geometry],
            ['color', 'Color', 'color', rule.color.slice(0, 7)], ['width', 'Line width', 'number', rule.width], ['radius', 'Point radius', 'number', rule.radius], ['fillOpacity', 'Polygon fill opacity (0–1)', 'number', rule.fillOpacity]]) {
            const wrap = document.createElement('div'), caption = document.createElement('label'), input = document.createElement(type === 'select' ? 'select' : 'input');
            caption.textContent = label; input.id = `${index}-${key}`; caption.htmlFor = input.id;
            if (type === 'select') for (const item of ['point', 'line', 'polygon']) { const option = document.createElement('option'); option.value = option.textContent = item; input.append(option); }
            else input.type = type;
            if (type === 'number') { input.step = key === 'fillOpacity' ? '.1' : '.5'; input.min = key === 'fillOpacity' ? '0' : key === 'width' ? '.5' : '1'; input.max = key === 'fillOpacity' ? '1' : key === 'width' ? '12' : '16'; }
            input.value = value; controls[key] = input; wrap.append(caption, input); if (key === 'sourceLayer') wrap.dataset.sourceLayer = 'true'; row.append(wrap);
            if (key === 'sourceLayer') input.setAttribute('list', 'source-layers');
        }
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove rule';
        const record = { controls, row }; ruleValues.push(record);
        remove.onclick = () => { ruleValues.splice(ruleValues.indexOf(record), 1); row.remove(); dirty = true; manualFields.add('appearance');resolved = null;controller?.abort(); };
        row.append(remove); field('rules').append(row); updateKind();
    };
    const sourceKind = () => field('kind').value === 'auto' ? detectedKind || inferCustomSourceUrl(field('url').value.trim())?.kind || 'raster' : field('kind').value;
    const sourceFormat = () => field('format').value === 'auto' ? inferCustomSourceUrl(field('url').value.trim())?.format || 'template' : field('format').value;
    const detection = () => ({ detectKind: field('kind').value === 'auto', styleAuto: field('kind').value === 'auto' && !manualFields.has('appearance'), manualFields: [...manualFields], inspect: true });
    const replaceRules = rules => { ruleValues.length = 0;field('rules').replaceChildren();for (const rule of rules) addRule({ ...rule, sourceLayer: rule.sourceLayer === '__choose_layer__' ? '' : rule.sourceLayer }); };
    function updateKind() {
        const kind = sourceKind(), geo = kind === 'geojson';
        field('tile-fields').hidden = geo; field('format').hidden = field('format-label').hidden = geo;
        field('source-values').hidden = geo || sourceFormat() !== 'tilejson';
        field('tile-size').hidden = field('tile-size-label').hidden = kind !== 'raster'; field('appearance').hidden = kind === 'raster';
        for (const wrap of document.querySelectorAll('[data-source-layer]')) wrap.hidden = kind !== 'mvt';
        field('preview').disabled = !mapId; field('preview').hidden = !mapId && parent !== window;
        field('test').textContent = mapId ? 'Test source' : 'Check source'; field('test').disabled = false;
        const hint = inferCustomSourceUrl(field('url').value.trim());
        field('source-summary').textContent = !field('url').value.trim() ? 'Paste a source URL to detect its format.'
            : !resolved && !geo && sourceFormat() === 'tilejson' ? 'JSON source · Check or Save to detect details.'
                : geo ? 'GeoJSON · appearance is available in Advanced.'
                    : kind === 'mvt' ? `Vector tiles · ${ruleValues.every(({ controls }) => controls.sourceLayer.value) ? 'source layer filled' : 'source layer needed in Advanced'}`
                        : field('kind').value === 'auto' && hint?.format === 'template' && !hint.kind ? 'Tile type unclear. Choose Source type in Advanced.'
                            : `Raster tiles · ${field('scheme').value.toUpperCase()} · zoom ${field('minimum').value}–${field('maximum').value}${['minimum', 'maximum'].some(id => field(id).dataset.origin === 'manual') ? ' (custom)' : resolved?.source.metadataZoom ? '' : ' (defaults)'}`;
    }
    const sourceFromForm = (discover = false) => {
        const kind = sourceKind(), url = field('url').value.trim(), tiled = kind !== 'geojson';
        const tiles = tiled && sourceFormat() === 'template' ? [url] : [];
        if (!customUrl(url, tiles.length > 0)) throw new Error('Use a public HTTPS URL with {z}, {x} and {y} for tile templates.');
        if (tiles.length && field('kind').value === 'auto' && !inferCustomSourceUrl(url)?.kind) { field('advanced').open = true;throw new Error('The URL does not identify its tile type. Choose Source type in Advanced.'); }
        const raw = { id: sourceId, revision: expectedRevision + 1, name: field('name').value.trim(), kind,
            source: { ...(tiled ? { tiles, ...(tiles.length ? {} : { metadataUrl: url }), minNativeZoom: +field('minimum').value, maxNativeZoom: +field('maximum').value,
                zoomOrigin: { min: field('minimum').dataset.origin || 'default', max: field('maximum').dataset.origin || 'default' }, scheme: field('scheme').value, tileSize: +field('tile-size').value } : { dataUrl: url }),
            bounds: field('bounds').value.trim() ? field('bounds').value.split(',').map(Number) : null,
            manualFields: [...manualFields].filter(key => ['scheme', 'tile-size', 'bounds'].includes(key)) },
            approvedOrigins: [...new Set([new URL(url).origin, ...(resolved?.approvedOrigins || [])])],
            attribution: { ...savedAttribution },
            appearance: { opacity: resolved?.appearance.opacity ?? 60, rules: kind === 'raster' ? [] : ruleValues.map(({ controls }) => Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, ['width', 'radius', 'fillOpacity'].includes(key) ? +input.value : key === 'sourceLayer' && !input.value && discover ? '__choose_layer__' : input.value]))) } };
        const source = readCustomSource(raw); if (!source) { field('advanced').open = true;throw new Error('Check the zoom range, bounds and appearance in Advanced. Vector tiles need a source layer; use TileJSON to detect it.'); }
        if (resolved && resolved.kind === kind && resolved.source.metadataUrl === source.source.metadataUrl) { source.source.tiles = resolved.source.tiles; if (resolved.source.metadataZoom) source.source.metadataZoom = resolved.source.metadataZoom; }
        return source;
    };
    const task = async (action, source) => {
        if (parameters().length || privateMode) {
            if (action !== 'resolve') throw new Error('Save this private source, then approve and enable it on a map.');
            const signal = controller.signal, abort = () => { void ext.runtime.sendMessage({ type: 'CUSTOM_PRIVATE_CHECK_CANCEL' }).catch(() => {}); };
            signal.addEventListener('abort', abort, { once: true });
            try {
                const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_PRIVATE_CHECK', source, requestParameters: parameters(), detection: detection() });
                if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
                if (!reply?.ok) throw new Error(reply?.error || 'Private source could not be checked.');return reply.value;
            } finally { signal.removeEventListener('abort', abort); }
        }
        if (!mapId) return action === 'resolve' ? client.resolve(source, controller.signal, false, detection()) : Promise.reject(new Error('Choose a map to test tiles.'));
        const grant = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_PREVIEW', mapId, source });
        if (!grant?.ok) throw new Error(grant?.error || 'Source test unavailable.');
        const signal = controller.signal;
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID(), cancel = () => { send({ type: 'task', detail: { type: 'taskCancel', requestId, mapId } }); tasks.delete(requestId); clearTimeout(timer); reject(new DOMException('Cancelled.', 'AbortError')); }, timer = setTimeout(cancel, 30000);
            if (signal.aborted) { cancel(); return; }
            signal.addEventListener('abort', cancel, { once: true });
            tasks.set(requestId, { resolve, reject, timer, done: () => signal.removeEventListener('abort', cancel) }); send({ type: 'task', detail: { type: 'task', requestId, mapId, action, source, detection: detection() } });
        });
    };
    const busy = value => { pending = value; for (const id of ['preview', 'test', 'save']) field(id).setAttribute('aria-disabled', String(value)); };
    const run = async action => {
        if (pending) return; feedbackControl = action === 'resolve' ? 'test' : action; busy(true); dirty = false;
        const work = controller = new AbortController(), opening = openRevision;
        const current = () => controller === work && !work.signal.aborted && opening === openRevision;
        feedback(action === 'save' ? 'Saving…' : 'Checking source…');
        try {
            if (!field('form').reportValidity()) { feedback('Check the highlighted fields.'); return; }
            let source = sourceFromForm(true);
            const requestParameters = parameters();
            if (requestParameters.length || privateMode) {
                // Called directly from Save/Check before any asynchronous work.
                const origins = source.approvedOrigins.map(origin => `https://${new URL(origin).hostname}/*`);
                if (!await ext.permissions.request({ origins })) throw new Error('Provider access wasn’t granted. Your entries are still here.');
                if (!current()) throw new DOMException('Cancelled.', 'AbortError');
            }
            const automatic = field('kind').value === 'auto' || source.kind !== 'geojson' && field('format').value === 'auto';
            if (action !== 'save' || automatic && !resolved && (source.source.metadataUrl || source.kind === 'geojson')) {
                const result = await task('resolve', source);
                if (!current() || dirty) return;
                resolved = result.source; source = resolved;
                if (field('kind').value === 'auto') detectedKind = source.kind;
                if (detection().styleAuto && source.kind !== 'raster') replaceRules(source.appearance.rules);
                if (source.kind === 'mvt' && result.layers?.length) {
                    field('source-layers').replaceChildren(...result.layers.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
                    for (const { controls } of ruleValues) if (!controls.sourceLayer.value && result.layers.length === 1) controls.sourceLayer.value = result.layers[0];
                }
                if (!manualFields.has('bounds')) field('bounds').value = source.source.bounds?.join(', ') || '';
                if (source.kind !== 'geojson') {
                    for (const [id, key] of [['minimum', 'min'], ['maximum', 'max']]) {
                        if (field(id).dataset.origin !== 'manual') { field(id).value = source.source[key === 'min' ? 'minNativeZoom' : 'maxNativeZoom']; field(id).dataset.origin = source.source.zoomOrigin[key]; }
                    }
                    field('scheme').value = source.source.scheme;
                    if (source.kind === 'raster') field('tile-size').value = source.source.tileSize;
                    const declared = source.source.metadataZoom;
                    field('zoom-origin').textContent = `Minimum: ${source.source.zoomOrigin.min}; maximum: ${source.source.zoomOrigin.max}.` + (declared ? ` Source: ${declared.min}–${declared.max}${declared.maxDeclared ? '' : ' (default maximum)'}. BPB supports zooms up to 22.` : '');
                }
                updateKind();
                if (result.origins?.length) {
                    feedback(`Tile hosts: ${result.source.approvedOrigins.join(', ')}. Click ${action === 'save' ? 'Save' : action === 'preview' ? 'Preview' : field('test').textContent} again to approve and continue.`); return;
                }
                if (action === 'test') { const tested = await task('test', source); if (!dirty) feedback(tested.message); return; }
                if (action === 'resolve') { feedback(source.kind === 'mvt' && ruleValues.some(({ controls }) => !controls.sourceLayer.value)
                    ? 'Source detected. Choose a vector source layer in Advanced, then Save.'
                    : source.kind !== 'geojson' && !source.source.metadataUrl ? 'Tile template recognized. Review defaults or overrides in Advanced, then Save. Tile coverage has not been tested.'
                        : 'Source values loaded. Save when ready; Advanced contains the detected details. Tile coverage has not been tested.'); return; }
            }
            source = sourceFromForm();
            if (!current()) return;
            if (action === 'preview') {
                const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_PREVIEW', mapId, source });
                if (!reply?.ok) throw new Error(reply?.error || 'Preview unavailable.');
                send({ type: 'preview', detail: { type: 'preview', mapId, sourceId: source.id, sourceRevision: source.revision } });
                feedback('Preview enabled on the map. Check its loading status; saving keeps this selection.');
            } else {
                const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_SAVE', id: sourceId, source, expectedRevision, requestParameters });
                if (!reply?.ok) throw new Error(reply?.error || 'Couldn’t save.');
                if (opening !== openRevision || source.id !== sourceId) return;
                expectedRevision++; feedback(current() ? 'Saved on this device.' : 'Earlier values saved. Review your changes and Save again.'); await library();
            }
        } catch (error) { if (current() && error.name !== 'AbortError') feedback(customFailure(error)); }
        finally { if (controller === work) { busy(false); controller = null; } }
    };
    const reset = source => {
        closeHelp();
        privateMode = source?.privateRequests === true;
        detectedKind = source?.kind || null;
        sourceId = source?.id || 'custom:' + crypto.randomUUID(); expectedRevision = source?.revision || 0; resolved = source || null; dirty = false;
        // These credits are no longer editable here. Keep existing/imported
        // provider attribution through ordinary edits, checks and previews.
        savedAttribution = { ...(source?.attribution || { text: '' }) };
        field('form-title').textContent = source ? 'Edit overlay' : 'Add custom overlay';
        manualFields.clear();if (source) { for (const key of source.source.manualFields || ['scheme', 'tile-size', 'bounds']) manualFields.add(key);manualFields.add('appearance'); }
        field('advanced').open = !!source;
        field('name').value = source?.name || ''; field('kind').value = source?.kind || 'auto';
        field('url').value = source?.source.metadataUrl || source?.source.dataUrl || source?.source.tiles[0] || '';
        if (source?.reconnect || field('url').value.includes(RELAY_HOST)) field('url').value = '';
        parameterRows.length = 0;field('parameter-list').replaceChildren();for (const parameter of source?.requestParameters || []) addParameter(parameter);
        field('private-parameters').open = parameterRows.length > 0;
        field('format').value = source ? source.source.metadataUrl ? 'tilejson' : 'template' : 'auto';
        field('minimum').value = source?.source.minNativeZoom ?? 0; field('maximum').value = source?.source.maxNativeZoom ?? 18;
        field('minimum').dataset.origin = source?.source.zoomOrigin?.min || 'default'; field('maximum').dataset.origin = source?.source.zoomOrigin?.max || 'default';
        field('zoom-origin').textContent = source ? `Minimum: ${field('minimum').dataset.origin}; maximum: ${field('maximum').dataset.origin}.` : 'Default — not checked';
        field('source-layers').replaceChildren();
        field('scheme').value = source?.source.scheme || 'xyz'; field('tile-size').value = source?.source.tileSize || 256;
        field('bounds').value = source?.source.bounds?.join(', ') || '';
        ruleValues.length = 0; field('rules').replaceChildren(); for (const rule of source?.appearance.rules.length ? source.appearance.rules : [undefined]) addRule(rule);
        field('remove').hidden = !source; feedback(''); updateKind();
    };
    async function library() {
        const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET' }), registry = reply?.ok && readCustomRegistry(reply.registry);
        if (!registry) throw new Error('Saved overlays are unavailable.');
        // The schema intentionally drops secrets. Reattach only this trusted
        // Settings-only reply's private editor fields; never post them out.
        for (const source of registry.sources) { const raw = reply.registry.sources.find(item => item.id === source.id);
            if (source.privateRequests) { source.editSource = raw.editSource;source.requestParameters = raw.requestParameters || [];source.reconnect = raw.reconnect === true; }
        }
        const list = field('library'); list.replaceChildren();
        if (!mapId && parent === window) {
            for (const source of registry.sources) { const button = document.createElement('button'); button.type = 'button'; button.textContent = source.name; button.onclick = () => reset(source); list.append(button); }
            const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Add custom overlay'; button.onclick = () => reset(); list.append(button);
        }
        return registry;
    }
    const stopPreview = async () => {
        controller?.abort(); for (const entry of tasks.values()) { clearTimeout(entry.timer); entry.done(); entry.reject(new DOMException('Cancelled.', 'AbortError')); } tasks.clear();
        if (mapId) {
            await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_PREVIEW', mapId, source: null });
            send({ type: 'previewEnd', detail: { type: 'previewEnd', mapId, savedRevision: expectedRevision } });
        }
    };
    field('form').onsubmit = event => { event.preventDefault(); void run('save'); };
    field('preview').onclick = () => { dirty = false; void run('preview'); };
    field('test').onclick = () => { dirty = false; void run(mapId ? 'test' : 'resolve'); };
    field('add-rule').onclick = () => { dirty = true; manualFields.add('appearance');resolved = null; controller?.abort(); addRule(); };
    field('source-values').onclick = () => { field('minimum').dataset.origin = field('maximum').dataset.origin = 'default'; for (const key of ['scheme', 'tile-size', 'bounds']) manualFields.delete(key);resolved = null; dirty = false; void run('resolve'); };
    field('remove').onclick = async () => { if (pending || !expectedRevision) return; busy(true); try { const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_REMOVE', id: sourceId, expectedRevision }); if (!reply?.ok) throw new Error(reply?.error || 'Couldn’t remove.'); await stopPreview(); reset(); await library(); feedback('Overlay removed.'); } catch (error) { feedback(error.message); } finally { busy(false); } };
    field('cancel').onclick = () => { closeHelp(); void stopPreview().finally(() => send({ type: 'close' })); };
    document.addEventListener('keydown', event => {
        if (event.key === 'Tab' && parent !== window) { const controls = [...document.querySelectorAll('button,input,select,summary,a[href],[tabindex="0"]')].filter(element => !element.disabled && element.getClientRects().length);
            const index = controls.indexOf(document.activeElement); if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); } else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
        }
        if (event.key === 'Escape') { event.preventDefault(); if (activeHelp) closeHelp(); else field('cancel').click(); } });
    field('form').addEventListener('input', event => {
        dirty = true; resolved = null; if (['minimum', 'maximum'].includes(event.target.id)) event.target.dataset.origin = 'manual';
        if (['scheme', 'tile-size', 'bounds'].includes(event.target.id)) manualFields.add(event.target.id);
        if (field('appearance').contains(event.target)) manualFields.add('appearance');
        controller?.abort();if (pending) feedback('Source changed. Check or Save again.');
        if (event.target.id === 'url') {
            detectedKind = null;
            for (const [id, value] of [['minimum', 0], ['maximum', 18]]) if (field(id).dataset.origin !== 'manual') { field(id).value = value;field(id).dataset.origin = 'default'; }
            for (const [id, value] of [['scheme', 'xyz'], ['tile-size', 256], ['bounds', '']]) if (!manualFields.has(id)) field(id).value = value;
            if (field('kind').value === 'auto' && !manualFields.has('appearance')) replaceRules(sourceKind() === 'raster' ? defaultCustomRules('', ['line']) : defaultCustomRules());
        }
        updateKind();
    });
    field('form').addEventListener('change', event => {
        if (event.target.id.endsWith('-sourceLayer') && event.target.value) for (const { controls } of ruleValues) if (!controls.sourceLayer.value) controls.sourceLayer.value = event.target.value;
    });
    field('kind').onchange = () => { detectedKind = null;void stopPreview(); updateKind(); };
    field('format').onchange = () => { void stopPreview(); updateKind(); };
    field('url').onchange = () => { void stopPreview(); };
    window.addEventListener('message', event => {
        const data = event.data;
        let optionsParent = false;
        try { const expected = new URL(ext.runtime.getURL('options/options.html')); optionsParent = event.origin === `${expected.protocol}//${expected.host}` && parent.location.pathname === expected.pathname; } catch { /* Peakbagger is cross-origin. */ }
        if (event.source !== parent || !data?.[tag] || data.token !== token || !isPeakbaggerPageOrigin(event.origin) && !optionsParent) return;
        parentOrigin = event.origin;
        if (data.type === 'hello') send({ type: 'ready' });
        if (data.type === 'open') {
            const revision = ++openRevision;
            if (optionsParent) root.setAttribute('role', 'form');
            void stopPreview().then(async () => { mapId = typeof data.mapId === 'string' ? data.mapId : ''; document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
                const registry = await library(); if (revision !== openRevision) return;
                const source = registry.sources.find(item => item.id === data.sourceId);
                reset(source?.editSource ? { ...source.editSource, privateRequests: true, requestParameters: source.requestParameters } : source); send({ type: 'opened' }); field('name').focus();
            }).catch(error => { feedback(error.message); send({ type: 'opened' }); });
        }
        if (data.type === 'theme' && optionsParent) document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
        if (data.type === 'dismiss') { closeHelp(); openRevision++; void stopPreview(); }
        if (data.type === 'parse') {
            const owner = new AbortController(); jobs.set(data.requestId, owner);
            parser.parse(data.job, owner.signal).then(value => send({ type: 'parsed', requestId: data.requestId, reply: { ok: true, value } }),
                () => send({ type: 'parsed', requestId: data.requestId, reply: { ok: false } })).finally(() => jobs.delete(data.requestId));
        }
        if (data.type === 'cancelParse') { jobs.get(data.requestId)?.abort(); jobs.delete(data.requestId); }
        if (data.type === 'taskReply') {
            const entry = tasks.get(data.requestId); if (!entry) return; tasks.delete(data.requestId); clearTimeout(entry.timer); entry.done();
            if (data.reply?.ok) entry.resolve(data.reply.value); else entry.reject(new Error(data.reply?.error || 'Couldn’t load this source. Check the URL and CORS settings.'));
        }
    });
    window.addEventListener('pagehide', () => { closeHelp(); parser.dispose(); controller?.abort(); });
    reset(); void library().catch(error => feedback(error.message));

}
