// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readCustomRegistry, CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY } from '../src/maps/custom-overlay-schema.js';

export function initCustomLayers({ extensionApi, flash }) {
    const list = document.getElementById('custom-layer-list'), add = document.getElementById('custom-layer-add'), status = document.getElementById('custom-layer-status');
    if (!list || !add || !status) return;
    const dialog = document.getElementById('custom-layer-dialog'), frame = dialog.querySelector('iframe'), token = crypto.randomUUID(), rows = new Map(), pending = new Map();
    const origin = `${location.protocol}//${location.host}`, tag = '__bpbCustomOverlays';
    let sources = [], preferences = {}, revision = 0, ready = false, opening = null, returnFocus = add;
    const node = (tagName, text, className) => { const element = document.createElement(tagName); element.textContent = text || ''; if (className) element.className = className; return element; };
    const button = text => { const element = node('button', text, 'panel-button secondary'); element.type = 'button'; return element; };
    const send = detail => frame.contentWindow.postMessage({ [tag]: true, token, ...detail }, origin);
    const close = () => { send({ type: 'dismiss' }); dialog.close(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); };
    const open = (sourceId, trigger) => {
        returnFocus = trigger; opening = sourceId; frame.hidden = true;
        dialog.showModal();
        if (ready) send({ type: 'open', sourceId, mapId: '', theme: document.documentElement.dataset.bpbTheme });
        else if (!frame.hasAttribute('src')) frame.src = extensionApi.runtime.getURL(`custom-overlay/editor.html#${token}`);
    };
    frame.addEventListener('load', () => send({ type: 'hello' }));
    window.addEventListener('message', event => {
        const data = event.data;
        if (event.source !== frame.contentWindow || event.origin !== origin || !data?.[tag] || data.token !== token) return;
        if (data.type === 'ready') { ready = true; send({ type: 'open', sourceId: opening, mapId: '', theme: document.documentElement.dataset.bpbTheme }); }
        if (data.type === 'opened' && dialog.open) { frame.hidden = false; frame.focus({ preventScroll: true }); }
        if (data.type === 'close') close();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    add.addEventListener('click', () => open('', add));
    const paint = () => {
        for (const [id, row] of rows) if (!sources.some(source => source.id === id)) { row.element.remove(); rows.delete(id); }
        for (const source of sources) {
            let row = rows.get(source.id);
            if (!row) {
                const element = node('li', '', 'custom-layer-row'), text = node('div'), name = node('strong'), detail = node('span', '', 'desc'), actions = node('div', '', 'custom-layer-actions');
                const edit = button('Edit'), remove = button('Remove'), opacity = node('input'), value = node('output');
                opacity.type = 'range'; opacity.min = '0'; opacity.max = '100'; opacity.id = `opacity-${source.id}`; opacity.setAttribute('aria-label', `${source.name} opacity`);
                const label = node('label', 'Opacity', 'custom-layer-opacity'); label.htmlFor = opacity.id; label.append(opacity, value);
                text.append(name, detail); actions.append(edit, remove); element.append(text, actions, label);
                const confirmation = node('div', '', 'custom-layer-remove'); confirmation.hidden = true;
                const question = node('p'), confirm = button('Remove layer'), cancel = button('Keep layer'); confirmation.append(question, confirm, cancel); element.append(confirmation); list.append(element);
                row = { element, name, detail, opacity, value, source, question }; rows.set(source.id, row);
                edit.onclick = () => open(source.id, edit);
                remove.onclick = () => { question.textContent = `Remove ${row.source.name} from all maps on this device?`; confirmation.hidden = false; confirm.focus(); };
                cancel.onclick = () => { confirmation.hidden = true; remove.focus(); };
                confirm.onclick = async () => {
                    if (confirm.getAttribute('aria-disabled') === 'true') return;
                    confirm.setAttribute('aria-disabled', 'true');
                    try {
                        const reply = await extensionApi.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_REMOVE', id: source.id, expectedRevision: row.source.revision });
                        if (!reply?.ok) throw new Error(reply?.error || 'Couldn’t remove this layer.');
                        add.focus({ preventScroll: true }); await refresh(); flash('Custom layer removed');
                    } catch (error) { flash(error.message, { error: true }); }
                    finally { confirm.setAttribute('aria-disabled', 'false'); }
                };
                opacity.oninput = () => { pending.set(source.id, +opacity.value); value.value = `${opacity.value}%`; };
                opacity.onchange = async () => {
                    const amount = +opacity.value; pending.set(source.id, amount);
                    try { const reply = await extensionApi.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_OPACITY', id: source.id, opacity: amount }); if (!reply?.ok) throw new Error('Opacity could not be saved.'); }
                    catch (error) { flash(error.message, { error: true }); }
                    finally { if (pending.get(source.id) === amount) pending.delete(source.id); void refresh(); }
                };
            }
            row.source = source; row.name.textContent = source.name;
            const url = source.source.dataUrl || source.source.metadataUrl || source.source.tiles[0];
            row.detail.textContent = `${{ raster: 'Raster tiles', mvt: 'Vector tiles', geojson: 'GeoJSON' }[source.kind]} · ${new URL(url).hostname}`;
            row.opacity.setAttribute('aria-label', `${source.name} opacity`); row.opacity.value = pending.get(source.id) ?? preferences[source.id] ?? source.appearance.opacity; row.value.value = `${row.opacity.value}%`;
        }
        status.textContent = sources.length ? `${sources.length} saved ${sources.length === 1 ? 'layer' : 'layers'}. Enable them from Overlays on any map.` : 'No custom layers yet. Add a public map source to get started.';
        add.disabled = sources.length >= 20; list.hidden = sources.length === 0;
    };
    const refresh = async () => {
        const owner = ++revision;
        try {
            const reply = await extensionApi.runtime.sendMessage({ type: 'CUSTOM_OVERLAYS_GET' });
            const registry = reply?.ok && readCustomRegistry(reply.registry); if (!registry) throw new Error('Custom layers could not be loaded. Reopen Settings to try again.');
            if (owner !== revision) return; sources = registry.sources; preferences = reply.preferences; paint();
        } catch (error) { if (owner === revision) { status.textContent = error.message; add.disabled = true; } }
    };
    extensionApi.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes[CUSTOM_REGISTRY_KEY] || changes[CUSTOM_PREFERENCES_KEY])) void refresh(); });
    void refresh();
}
