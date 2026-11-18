// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { WILDFIRE_SOURCE, type WildfireRecord } from './wildfire-core.ts';

export type WildfireDetailsInput = Omit<WildfireRecord, 'id' | 'name'> & {
    id?: string;
    name?: string;
};

export interface WildfireList {
    element: HTMLDivElement;
    update(value: readonly unknown[]): void;
}

interface WildfireListNode {
    detail: HTMLDetailsElement;
    summary: HTMLElement;
    content: HTMLDivElement;
}

const asWildfireRecord = (value: unknown): WildfireRecord | null => {
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.name !== 'string') return null;
    return {
        id: item.id,
        name: item.name,
        incidentUpdated: typeof item.incidentUpdated === 'number' ? item.incidentUpdated : null,
        perimeterObserved: typeof item.perimeterObserved === 'number' ? item.perimeterObserved : null,
        perimeterEdited: typeof item.perimeterEdited === 'number' ? item.perimeterEdited : null,
        acres: typeof item.acres === 'number' ? item.acres : null,
        contained: typeof item.contained === 'number' ? item.contained : null,
        hasPerimeter: item.hasPerimeter === true,
    };
};

export function wildfireDetails(doc: Document, fire: WildfireDetailsInput, existing: HTMLDivElement | null = null): HTMLDivElement {
    const content = existing || doc.createElement('div'); content.className = 'bpb-fire-detail';
    const date = (value: number | null | undefined): string => value ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Unknown';
    const lines = ['NIFC/WFIGS · Reported wildfire', `Incident update: ${date(fire.incidentUpdated)}`,
        fire.hasPerimeter ? `Perimeter observed: ${date(fire.perimeterObserved)}` : 'Mapped perimeter unavailable.',
        ...(fire.hasPerimeter ? [`Perimeter edited: ${date(fire.perimeterEdited)}`] : []),
        ...(typeof fire.acres === 'number' && Number.isFinite(fire.acres) ? [`Reported area: ${Number(fire.acres.toFixed(1)).toLocaleString()} acres`] : []),
        ...(typeof fire.contained === 'number' && Number.isFinite(fire.contained) ? [`Reported containment: ${fire.contained}%`] : [])];
    let link = content.querySelector('a');
    if (!link) { link = doc.createElement('a'); link.href = WILDFIRE_SOURCE; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Official NIFC source'; content.append(link); }
    const previous = [...content.querySelectorAll('p')];
    lines.forEach((text, index) => { const p = previous[index] || doc.createElement('p'); if (p.textContent !== text) p.textContent = text; if (!p.parentNode) content.insertBefore(p, link); });
    previous.slice(lines.length).forEach(p => p.remove());
    return content;
}

// All loaded fires remain keyboard reachable without rendering thousands of
// disclosure nodes or passing geometry through the bridge.
export function createWildfireList(doc: Document): WildfireList {
    const element = doc.createElement('div'); element.className = 'bpb-fire-list';
    const list = doc.createElement('div'), navigation = doc.createElement('div'); navigation.className = 'bpb-fire-pages';
    const previous = doc.createElement('button'), next = doc.createElement('button'), label = doc.createElement('span');
    previous.type = next.type = 'button'; previous.textContent = 'Previous'; next.textContent = 'Next'; label.setAttribute('aria-live', 'polite');
    navigation.append(previous, label, next); element.append(list, navigation);
    let records: WildfireRecord[] = [], offset = 0, signature = '';
    const nodes = new Map<string, WildfireListNode>();
    const paint = () => {
        const shown = records.slice(offset, offset + 20);
        const focused = doc.activeElement as (Element & { focus?(options?: FocusOptions): void }) | null;
        const focusOwner = focused ? [...nodes].find(([, value]) => value.detail.contains(focused)) : undefined;
        const desired: Element[] = shown.map(fire => {
            let entry = nodes.get(fire.id);
            if (!entry) {
                const detail = doc.createElement('details'), summary = doc.createElement('summary');
                const content = wildfireDetails(doc, fire); detail.append(summary, content);
                entry = { detail, summary, content }; nodes.set(fire.id, entry);
            }
            if (entry.summary.textContent !== fire.name) entry.summary.textContent = fire.name;
            wildfireDetails(doc, fire, entry.content); return entry.detail;
        });
        desired.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
        for (const child of [...list.children]) if (!desired.includes(child)) child.remove();
        for (const id of nodes.keys()) if (!shown.some(fire => fire.id === id)) nodes.delete(id);
        if (focusOwner && focused && focused.isConnected && doc.activeElement !== focused && typeof focused.focus === 'function') {
            focused.focus({ preventScroll: true });
        }
        previous.disabled = offset === 0; next.disabled = offset + 20 >= records.length;
        navigation.hidden = records.length <= 20;
        label.textContent = `${offset + 1}–${Math.min(offset + 20, records.length)} of ${records.length}`;
        element.hidden = !records.length;
    };
    previous.addEventListener('click', () => { if (offset > 0) { offset -= 20; paint(); } });
    next.addEventListener('click', () => { if (offset + 20 < records.length) { offset += 20; paint(); } });
    paint();
    return {
        element,
        update(value: readonly unknown[]) {
            const key = JSON.stringify(value); if (key === signature) return;
            signature = key;
            records = value.map(asWildfireRecord).filter((item): item is WildfireRecord => item !== null);
            offset = Math.min(offset, Math.max(0, Math.floor((records.length - 1) / 20) * 20));
            // Keep an open record and its source link focused when its source data
            // is unchanged; polling timestamps do not belong in the record key.
            paint();
        },
    };
}
