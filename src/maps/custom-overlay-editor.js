// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isPeakbaggerPageOrigin } from '../peakbagger/peakbagger-origin.js';
import { readCustomSource, customUrl, readCustomRegistry } from './custom-overlay-schema.js';
import { createCustomParser } from './custom-overlay-parser.js';
import { createCustomClient, customFailure } from './custom-overlay-client.js';

const ext = globalThis.browser || globalThis.chrome, tag = '__bpbCustomOverlays';
const token = location.hash.slice(1), parser = createCustomParser(ext.runtime.getURL('custom-overlay/worker.js'));
const client = createCustomClient({ parse: parser.parse });
let parentOrigin = null, mapId = '', expectedRevision = 0, sourceId = '', pending = false, dirty = false, resolved = null, controller = null;
const jobs = new Map(), tasks = new Map();
const send = detail => { if (parentOrigin) parent.postMessage({ [tag]: true, token, ...detail }, parentOrigin); };
const root = document.getElementById('editor');
root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Custom map overlays');
root.innerHTML = `<h1>Custom map overlays</h1><section id="library"></section>
<form id="form"><fieldset><legend id="form-title">Add custom overlay</legend>
<label for="name">Name</label><input id="name" maxlength="80" required>
<label for="kind">Source type</label><select id="kind"><option value="raster">Raster tiles</option><option value="mvt">Vector tiles (MVT)</option><option value="geojson">GeoJSON</option></select>
<label for="url">URL</label><input id="url" type="text" spellcheck="false" required aria-describedby="url-hint feedback">
<p id="url-hint" class="hint">Use a public HTTPS source. URL keys are visible to the Peakbagger page; do not use confidential tokens.</p>
<label id="format-label" for="format">URL format</label><select id="format"><option value="template">Tile template: {z}, {x}, {y}</option><option value="tilejson">TileJSON metadata</option></select>
<details id="advanced"><summary>Advanced</summary><section id="tile-fields"><p>Available tile zoom range</p>
<p class="hint">Zooming in further enlarges the last available tile.</p><div class="fields">
<div><label for="minimum">Minimum</label><input id="minimum" type="number" min="0" max="22" value="0"></div>
<div><label for="maximum">Maximum</label><input id="maximum" type="number" min="0" max="22" value="18"></div></div>
<p id="zoom-origin" class="hint">Default — not checked</p><button type="button" id="source-values">Use source values</button>
<label for="scheme">Tile coordinates</label><select id="scheme"><option value="xyz">XYZ (normal Y)</option><option value="tms">TMS (reversed Y)</option></select>
<label id="size-label" for="tile-size">Tile size</label><select id="tile-size"><option value="256">256 pixels</option><option value="512">512 pixels</option></select></section>
<label for="bounds">Bounds (optional)</label><input id="bounds" placeholder="west, south, east, north">
<label for="attribution">Attribution</label><input id="attribution" maxlength="600"><label for="attribution-url">Attribution link (optional)</label><input id="attribution-url" type="url">
</details><fieldset id="appearance"><legend>Appearance</legend><p class="hint">Simple points, lines and polygons. Full map styles, labels and icons are not supported.</p><datalist id="source-layers"></datalist><div id="rules"></div><button type="button" id="add-rule">Add style rule</button></fieldset>
<p id="feedback" class="feedback" role="status" aria-live="polite"></p>
<details class="help"><summary>How to fix URL / CORS errors</summary><p>Check the URL, format and zoom range. Public metadata and tile servers must allow browser access, usually with <code>Access-Control-Allow-Origin: *</code>. A normal image link working does not prove CORS support. Use a browser-compatible endpoint or contact the provider. BPB has no proxy.</p><a target="_blank" rel="noopener noreferrer" href="https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors">Browser troubleshooting guide</a></details>
<footer class="actions"><button type="button" id="preview">Preview</button><button type="button" id="test">Test source</button><button type="submit" class="primary" id="save">Save</button><button type="button" id="cancel">Close</button><button type="button" id="remove">Remove</button></footer>
</fieldset></form>`;
const field = id => document.getElementById(id), feedback = message => { field('feedback').textContent = message; };
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
    remove.onclick = () => { ruleValues.splice(ruleValues.indexOf(record), 1); row.remove(); dirty = true; resolved = null; };
    row.append(remove); field('rules').append(row); updateKind();
};
function updateKind() {
    const kind = field('kind').value, geo = kind === 'geojson';
    field('tile-fields').hidden = geo; field('format').hidden = field('format-label').hidden = geo;
    field('tile-size').hidden = field('size-label').hidden = kind !== 'raster'; field('appearance').hidden = kind === 'raster';
    for (const wrap of document.querySelectorAll('[data-source-layer]')) wrap.hidden = kind !== 'mvt';
    field('preview').disabled = !mapId; field('test').disabled = !mapId || geo;
}
const sourceFromForm = (discover = false) => {
    const kind = field('kind').value, url = field('url').value.trim(), tiled = kind !== 'geojson';
    const tiles = tiled && field('format').value === 'template' ? [url] : [];
    if (!customUrl(url, tiles.length > 0)) throw new Error('Use a public HTTPS URL with {z}, {x} and {y} for tile templates.');
    const raw = { id: sourceId, revision: expectedRevision + 1, name: field('name').value.trim(), kind,
        source: { ...(tiled ? { tiles, ...(tiles.length ? {} : { metadataUrl: url }), minNativeZoom: +field('minimum').value, maxNativeZoom: +field('maximum').value,
            zoomOrigin: { min: field('minimum').dataset.origin || 'default', max: field('maximum').dataset.origin || 'default' }, scheme: field('scheme').value, tileSize: +field('tile-size').value } : { dataUrl: url }),
        bounds: field('bounds').value.trim() ? field('bounds').value.split(',').map(Number) : null },
        approvedOrigins: [...new Set([new URL(url).origin, ...(resolved?.approvedOrigins || [])])],
        attribution: { text: field('attribution').value, ...(field('attribution-url').value ? { url: field('attribution-url').value } : {}) },
        appearance: { opacity: resolved?.appearance.opacity ?? 60, rules: kind === 'raster' ? [] : ruleValues.map(({ controls }) => Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, ['width', 'radius', 'fillOpacity'].includes(key) ? +input.value : key === 'sourceLayer' && !input.value && discover && field('format').value === 'tilejson' ? '__choose_layer__' : input.value]))) } };
    const source = readCustomSource(raw); if (!source) throw new Error('Check the name, zoom range, bounds and appearance. Vector rules need a source layer.');
    if (resolved && resolved.kind === kind && resolved.source.metadataUrl === source.source.metadataUrl) { source.source.tiles = resolved.source.tiles; if (resolved.source.metadataZoom) source.source.metadataZoom = resolved.source.metadataZoom; }
    return source;
};
const task = async (action, source) => {
    if (!mapId) return action === 'resolve' ? client.resolve(source, controller.signal, false) : Promise.reject(new Error('Choose a map to test tiles.'));
    const grant = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_PREVIEW', mapId, source });
    if (!grant?.ok) throw new Error(grant?.error || 'Source test unavailable.');
    const signal = controller.signal;
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID(), cancel = () => { send({ type: 'task', detail: { type: 'taskCancel', requestId, mapId } }); tasks.delete(requestId); clearTimeout(timer); reject(new DOMException('Cancelled.', 'AbortError')); }, timer = setTimeout(cancel, 30000);
        if (signal.aborted) { cancel(); return; }
        signal.addEventListener('abort', cancel, { once: true });
        tasks.set(requestId, { resolve, reject, timer, done: () => signal.removeEventListener('abort', cancel) }); send({ type: 'task', detail: { type: 'task', requestId, mapId, action, source } });
    });
};
const busy = value => { pending = value; for (const id of ['preview', 'test', 'save']) field(id).setAttribute('aria-disabled', String(value)); };
const run = async action => {
    if (pending) return; busy(true); controller = new AbortController(); feedback(action === 'save' ? 'Saving…' : 'Checking source…');
    try {
        if (!field('form').reportValidity()) { feedback('Check the highlighted fields.'); return; }
        let source = sourceFromForm(action !== 'save');
        if (action !== 'save') {
            const result = await task('resolve', source);
            if (dirty) return;
            if (source.kind === 'mvt' && result.layers?.length) {
                field('source-layers').replaceChildren(...result.layers.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
                for (const { controls } of ruleValues) if (!controls.sourceLayer.value && result.layers.length === 1) controls.sourceLayer.value = result.layers[0];
            }
            if (result.origins?.length) {
                resolved = result.source; feedback(`Tile hosts: ${result.source.approvedOrigins.join(', ')}. Click ${action === 'preview' ? 'Preview' : 'Test source'} again to approve and continue.`); return;
            }
            resolved = result.source; source = resolved;
            if (source.kind === 'mvt') source.appearance.rules = sourceFromForm().appearance.rules;
            if (source.kind !== 'geojson') {
                for (const [id, key] of [['minimum', 'min'], ['maximum', 'max']]) {
                    if (field(id).dataset.origin !== 'manual') { field(id).value = source.source[key === 'min' ? 'minNativeZoom' : 'maxNativeZoom']; field(id).dataset.origin = source.source.zoomOrigin[key]; }
                }
                field('scheme').value = source.source.scheme;
                const declared = source.source.metadataZoom;
                field('zoom-origin').textContent = `Minimum: ${source.source.zoomOrigin.min}; maximum: ${source.source.zoomOrigin.max}.` + (declared ? ` Source: ${declared.min}–${declared.max}${declared.maxDeclared ? '' : ' (default maximum)'}. BPB supports zooms up to 22.` : '');
            }
            if (action === 'test') { const tested = await task('test', source); if (!dirty) feedback(tested.message); return; }
            const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_PREVIEW', mapId, source });
            if (!reply?.ok) throw new Error(reply?.error || 'Preview unavailable.');
            send({ type: 'preview', detail: { type: 'preview', mapId, sourceId: source.id, sourceRevision: source.revision } });
            feedback('Preview enabled on the map. Check its loading status; saving keeps this selection.');
        } else {
            const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_SAVE', id: sourceId, source, expectedRevision });
            if (!reply?.ok) throw new Error(reply?.error || 'Couldn’t save.');
            expectedRevision++; feedback('Saved on this device.'); await library();
        }
    } catch (error) { if (error.name !== 'AbortError') feedback(customFailure(error)); }
    finally { busy(false); controller = null; }
};
const reset = source => {
    sourceId = source?.id || 'custom:' + crypto.randomUUID(); expectedRevision = source?.revision || 0; resolved = source || null; dirty = false;
    field('form-title').textContent = source ? 'Edit overlay' : 'Add custom overlay';
    field('name').value = source?.name || ''; field('kind').value = source?.kind || 'raster';
    field('url').value = source?.source.metadataUrl || source?.source.dataUrl || source?.source.tiles[0] || '';
    field('format').value = source?.source.metadataUrl ? 'tilejson' : 'template';
    field('minimum').value = source?.source.minNativeZoom ?? 0; field('maximum').value = source?.source.maxNativeZoom ?? 18;
    field('minimum').dataset.origin = source?.source.zoomOrigin?.min || 'default'; field('maximum').dataset.origin = source?.source.zoomOrigin?.max || 'default';
    field('scheme').value = source?.source.scheme || 'xyz'; field('tile-size').value = source?.source.tileSize || 256;
    field('bounds').value = source?.source.bounds?.join(', ') || ''; field('attribution').value = source?.attribution.text || ''; field('attribution-url').value = source?.attribution.url || '';
    ruleValues.length = 0; field('rules').replaceChildren(); for (const rule of source?.appearance.rules.length ? source.appearance.rules : [undefined]) addRule(rule);
    field('remove').hidden = !source; feedback(''); updateKind();
};
async function library() {
    const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET' }), registry = reply?.ok && readCustomRegistry(reply.registry);
    if (!registry) throw new Error('Saved overlays are unavailable.');
    const list = field('library'); list.replaceChildren();
    if (!mapId) {
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
field('test').onclick = () => { dirty = false; void run('test'); };
field('add-rule').onclick = () => { dirty = true; resolved = null; controller?.abort(); addRule(); };
field('source-values').onclick = () => { field('minimum').dataset.origin = field('maximum').dataset.origin = 'default'; resolved = null; feedback('Click Preview or Test source to read the source values.'); };
field('remove').onclick = async () => { if (pending || !expectedRevision) return; busy(true); try { const reply = await ext.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_REMOVE', id: sourceId, expectedRevision }); if (!reply?.ok) throw new Error(reply?.error || 'Couldn’t remove.'); await stopPreview(); reset(); await library(); feedback('Overlay removed.'); } catch (error) { feedback(error.message); } finally { busy(false); } };
field('cancel').onclick = () => { void stopPreview().finally(() => send({ type: 'close' })); };
document.addEventListener('keydown', event => {
    if (event.key === 'Tab' && parent !== window) { const controls = [...document.querySelectorAll('button,input,select,summary,a[href]')].filter(element => !element.disabled && element.getClientRects().length);
        const index = controls.indexOf(document.activeElement); if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); } else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
    }
    if (event.key === 'Escape') { event.preventDefault(); field('cancel').click(); } });
field('form').addEventListener('input', event => { dirty = true; resolved = null; if (['minimum', 'maximum'].includes(event.target.id)) event.target.dataset.origin = 'manual'; controller?.abort(); });
field('kind').onchange = () => { void stopPreview(); updateKind(); };
field('url').onchange = () => { void stopPreview(); };
window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || !data?.[tag] || data.token !== token || !isPeakbaggerPageOrigin(event.origin)) return;
    parentOrigin = event.origin;
    if (data.type === 'hello') send({ type: 'ready' });
    if (data.type === 'open') {
        void stopPreview().then(async () => { mapId = typeof data.mapId === 'string' ? data.mapId : ''; document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
            const registry = await library(); reset(registry.sources.find(source => source.id === data.sourceId)); send({ type: 'opened' }); field('name').focus();
        }).catch(error => { feedback(error.message); send({ type: 'opened' }); });
    }
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
window.addEventListener('pagehide', () => { parser.dispose(); controller?.abort(); });
reset(); void library().catch(error => feedback(error.message));
