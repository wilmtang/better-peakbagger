// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readCustomRegistry, CUSTOM_REGISTRY_KEY } from '../src/maps/custom-overlay-schema.js';
import type { FlashOptions } from './options-utils.ts';

type CustomSourceKind = 'raster' | 'mvt' | 'geojson';

interface CustomLayerSource {
    id: string;
    revision: number;
    name: string;
    kind: CustomSourceKind;
    privateRequests?: boolean;
    source: {
        dataUrl?: string;
        metadataUrl?: string;
        tiles?: string[];
    };
}

interface CustomLayerRegistry {
    schemaVersion: number;
    revision: number;
    sources: CustomLayerSource[];
}

interface CustomLayerRow {
    element: HTMLLIElement;
    name: HTMLElement;
    detail: HTMLSpanElement;
    source: CustomLayerSource;
    question: HTMLParagraphElement;
    up: HTMLButtonElement;
    down: HTMLButtonElement;
}

interface CustomOverlayReply {
    ok?: boolean;
    error?: string;
    registry?: unknown;
}

export interface CustomLayersOptions {
    extensionApi: typeof chrome;
    flash: (msg?: string, options?: FlashOptions) => unknown;
}

const errorMessage = (error: unknown): string =>
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error ?? '');

export function initCustomLayers({ extensionApi, flash }: CustomLayersOptions): void {
    const list = document.getElementById('custom-layer-list') as HTMLUListElement | null;
    const add = document.getElementById('custom-layer-add') as HTMLButtonElement | null;
    const status = document.getElementById('custom-layer-status') as HTMLElement | null;
    if (!list || !add || !status) return;
    const dialog = document.getElementById('custom-layer-dialog') as HTMLDialogElement;
    const frame = dialog.querySelector('iframe') as HTMLIFrameElement;
    const token = crypto.randomUUID();
    const rows = new Map<string, CustomLayerRow>();
    const origin = `${location.protocol}//${location.host}`;
    const tag = '__bpbCustomOverlays';
    let sources: CustomLayerSource[] = [];
    let revision = 0;
    let registryRevision = 0;
    let orderPending = false;
    let ready = false;
    let opening: string | null = null;
    let returnFocus: HTMLElement = add;
    const node = <Tag extends keyof HTMLElementTagNameMap>(
        tagName: Tag,
        text?: string,
        className?: string,
    ): HTMLElementTagNameMap[Tag] => {
        const element = document.createElement(tagName);
        element.textContent = text || '';
        if (className) element.className = className;
        return element;
    };
    const button = (text: string): HTMLButtonElement => {
        const element = node('button', text, 'panel-button secondary');
        element.type = 'button';
        return element;
    };
    const moveButton = (direction: -1 | 1): HTMLButtonElement => {
        const element = button('');
        element.classList.add('custom-layer-move');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true' })) {
            svg.setAttribute(key, value);
        }
        for (const [key, value] of Object.entries({
            d: direction === -1 ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.6',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        })) {
            path.setAttribute(key, value);
        }
        svg.append(path);
        element.append(svg);
        return element;
    };
    const send = (detail: Record<string, unknown>): void => {
        frame.contentWindow?.postMessage({ [tag]: true, token, ...detail }, origin);
    };
    const close = (): void => {
        send({ type: 'dismiss' });
        dialog.close();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    const open = (sourceId: string, trigger: HTMLElement): void => {
        returnFocus = trigger;
        opening = sourceId;
        frame.hidden = true;
        dialog.showModal();
        if (ready) send({ type: 'open', sourceId, mapId: '', theme: document.documentElement.dataset.bpbTheme });
        else if (!frame.hasAttribute('src')) frame.src = extensionApi.runtime.getURL(`custom-overlay/editor.html#${token}`);
    };
    frame.addEventListener('load', () => send({ type: 'hello' }));
    window.addEventListener('message', event => {
        const data = event.data as Record<string, unknown> | null;
        if (event.source !== frame.contentWindow || event.origin !== origin || !data?.[tag] || data.token !== token) return;
        if (data.type === 'ready') {
            ready = true;
            send({ type: 'open', sourceId: opening, mapId: '', theme: document.documentElement.dataset.bpbTheme });
        }
        if (data.type === 'opened' && dialog.open) {
            frame.hidden = false;
            frame.focus({ preventScroll: true });
        }
        if (data.type === 'close') close();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    add.addEventListener('click', () => open('', add));
    const move = async (id: string, direction: -1 | 1): Promise<void> => {
        const index = sources.findIndex(source => source.id === id);
        const target = index + direction;
        if (orderPending || index < 0 || target < 0 || target >= sources.length) return;
        const ids = sources.map(source => source.id);
        [ids[index], ids[target]] = [ids[target], ids[index]];
        orderPending = true;
        list.setAttribute('aria-busy', 'true');
        paint();
        try {
            const reply = await extensionApi.runtime.sendMessage<Record<string, unknown>, CustomOverlayReply | undefined>({
                type: 'CUSTOM_OVERLAYS_REORDER',
                ids,
                expectedRevision: registryRevision,
            });
            if (!reply?.ok) throw new Error(reply?.error || 'Layer order could not be saved.');
            const registry = readCustomRegistry(reply.registry) as CustomLayerRegistry | null;
            if (!registry) throw new Error('Layer order could not be confirmed.');
            if (registry.revision >= registryRevision) {
                sources = registry.sources;
                registryRevision = registry.revision;
            }
            const name = sources.find(source => source.id === id)?.name;
            const orderStatus = document.getElementById('custom-layer-order-status');
            if (orderStatus) orderStatus.textContent = `${name} moved to position ${target + 1} of ${sources.length}.`;
        } catch (error) {
            flash(errorMessage(error), { error: true });
        } finally {
            orderPending = false;
            list.removeAttribute('aria-busy');
            paint();
            void refresh();
        }
    };
    const paint = (): void => {
        const focused = list.contains(document.activeElement) ? document.activeElement as HTMLElement | null : null;
        for (const [id, row] of rows) {
            if (!sources.some(source => source.id === id)) {
                row.element.remove();
                rows.delete(id);
            }
        }
        for (const [index, source] of sources.entries()) {
            let row = rows.get(source.id);
            if (!row) {
                const element = node('li', '', 'custom-layer-row');
                const text = node('div');
                const name = node('strong');
                const detail = node('span', '', 'desc');
                const actions = node('div', '', 'custom-layer-actions');
                const edit = button('Edit');
                const remove = button('Delete');
                const up = moveButton(-1);
                const down = moveButton(1);
                up.onclick = () => { void move(source.id, -1); };
                down.onclick = () => { void move(source.id, 1); };
                const ordering = node('div', '', 'custom-layer-order');
                ordering.append(up, down);
                element.dataset.customLayer = source.id;
                text.append(name, detail);
                actions.append(ordering, edit, remove);
                element.append(text, actions);
                const confirmation = node('div', '', 'custom-layer-remove');
                confirmation.hidden = true;
                const question = node('p');
                const confirm = button('Delete layer');
                const cancel = button('Keep layer');
                confirmation.append(question, confirm, cancel);
                element.append(confirmation);
                list.append(element);
                const createdRow: CustomLayerRow = { element, name, detail, source, question, up, down };
                row = createdRow;
                rows.set(source.id, createdRow);
                edit.onclick = () => open(source.id, edit);
                remove.onclick = () => {
                    question.textContent = `Delete ${createdRow.source.name} from your saved layers on this device?`;
                    confirmation.hidden = false;
                    confirm.focus();
                };
                cancel.onclick = () => { confirmation.hidden = true; remove.focus(); };
                confirm.onclick = async () => {
                    if (confirm.getAttribute('aria-disabled') === 'true') return;
                    confirm.setAttribute('aria-disabled', 'true');
                    try {
                        const reply = await extensionApi.runtime.sendMessage<Record<string, unknown>, CustomOverlayReply | undefined>({
                            type: 'CUSTOM_OVERLAYS_REMOVE',
                            id: source.id,
                            expectedRevision: createdRow.source.revision,
                        });
                        if (!reply?.ok) throw new Error(reply?.error || 'Couldn’t remove this layer.');
                        add.focus({ preventScroll: true });
                        await refresh();
                        flash('Custom layer deleted');
                    } catch (error) {
                        flash(errorMessage(error), { error: true });
                    } finally {
                        confirm.setAttribute('aria-disabled', 'false');
                    }
                };
            }
            row.source = source;
            row.name.textContent = source.name;
            row.up.setAttribute('aria-label', `Move ${source.name} up`);
            row.down.setAttribute('aria-label', `Move ${source.name} down`);
            row.up.title = 'Move up';
            row.down.title = 'Move down';
            row.up.setAttribute('aria-disabled', String(orderPending || index === 0));
            row.down.setAttribute('aria-disabled', String(orderPending || index === sources.length - 1));
            if (list.children[index] !== row.element) list.insertBefore(row.element, list.children[index] || null);
            const url = source.source.dataUrl || source.source.metadataUrl || source.source.tiles?.[0] || '';
            row.detail.textContent = `${{ raster: 'Raster tiles', mvt: 'Vector tiles', geojson: 'GeoJSON' }[source.kind]} · ${source.privateRequests ? 'Private requests' : new URL(url).hostname}`;
        }
        status.textContent = sources.length
            ? `${sources.length} saved ${sources.length === 1 ? 'layer' : 'layers'}. Enable them from Overlays on any map.`
            : 'No custom layers yet. Add a public map source to get started.';
        add.disabled = sources.length >= 20;
        list.hidden = sources.length === 0;
        if (focused?.isConnected && document.activeElement === document.body) focused.focus({ preventScroll: true });
    };
    const refresh = async (): Promise<void> => {
        const owner = ++revision;
        try {
            const reply = await extensionApi.runtime.sendMessage<Record<string, unknown>, CustomOverlayReply | undefined>({
                type: 'CUSTOM_OVERLAYS_GET',
            });
            const registry = (reply?.ok && readCustomRegistry(reply.registry)) as CustomLayerRegistry | null | false;
            if (!registry) throw new Error('Custom layers could not be loaded. Reopen Settings to try again.');
            if (owner !== revision || registry.revision < registryRevision) return;
            sources = registry.sources;
            registryRevision = registry.revision;
            paint();
        } catch (error) {
            if (owner === revision) {
                status.textContent = errorMessage(error);
                add.disabled = true;
            }
        }
    };
    extensionApi.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[CUSTOM_REGISTRY_KEY]) void refresh();
    });
    const themes = new MutationObserver(() => {
        if (ready) send({ type: 'theme', theme: document.documentElement.dataset.bpbTheme });
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bpbTheme'] });
    window.addEventListener('pagehide', event => { if (!event.persisted) themes.disconnect(); });
    void refresh();
}
