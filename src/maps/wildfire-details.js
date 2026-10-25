// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { WILDFIRE_SOURCE } from './wildfire-core.js';
export function wildfireDetails(doc, fire, existing = null) {
    const content = existing || doc.createElement('div'); content.className = 'bpb-fire-detail';
    const date = value => value ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Unknown';
    const lines = ['NIFC/WFIGS · Reported wildfire', `Incident update: ${date(fire.incidentUpdated)}`,
        fire.hasPerimeter ? `Perimeter observed: ${date(fire.perimeterObserved)}` : 'Mapped perimeter unavailable.',
        ...(fire.hasPerimeter ? [`Perimeter edited: ${date(fire.perimeterEdited)}`] : []),
        ...(fire.acres !== null ? [`Reported area: ${Number(fire.acres.toFixed(1)).toLocaleString()} acres`] : []),
        ...(fire.contained !== null ? [`Reported containment: ${fire.contained}%`] : [])];
    let link = content.querySelector('a');
    if (!link) { link = doc.createElement('a'); link.href = WILDFIRE_SOURCE; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Official NIFC source'; content.append(link); }
    const previous = [...content.querySelectorAll('p')];
    lines.forEach((text, index) => { const p = previous[index] || doc.createElement('p'); if (p.textContent !== text) p.textContent = text; if (!p.parentNode) content.insertBefore(p, link); });
    previous.slice(lines.length).forEach(p => p.remove());
    return content;
}
// All loaded fires remain keyboard reachable without rendering thousands of
// disclosure nodes or passing geometry through the bridge.
export function createWildfireList(doc) {
    const element = doc.createElement('div'); element.className = 'bpb-fire-list';
    const list = doc.createElement('div'), navigation = doc.createElement('div'); navigation.className = 'bpb-fire-pages';
    const previous = doc.createElement('button'), next = doc.createElement('button'), label = doc.createElement('span');
    previous.type = next.type = 'button'; previous.textContent = 'Previous'; next.textContent = 'Next'; label.setAttribute('aria-live', 'polite');
    navigation.append(previous, label, next); element.append(list, navigation);
    let records = [], offset = 0, signature = '';
    const nodes = new Map();
    const paint = () => {
        const shown = records.slice(offset, offset + 20);
        const focused = doc.activeElement, focusOwner = [...nodes].find(([, value]) => value.detail.contains(focused));
        const desired = shown.map(fire => {
            let entry = nodes.get(fire.id);
            if (!entry) { const detail = doc.createElement('details'), summary = doc.createElement('summary'); const content = wildfireDetails(doc, fire); detail.append(summary, content); entry = { detail, summary, content }; nodes.set(fire.id, entry); }
            if (entry.summary.textContent !== fire.name) entry.summary.textContent = fire.name;
            wildfireDetails(doc, fire, entry.content); return entry.detail;
        });
        desired.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
        for (const child of [...list.children]) if (!desired.includes(child)) child.remove();
        for (const id of nodes.keys()) if (!shown.some(fire => fire.id === id)) nodes.delete(id);
        if (focusOwner && focused.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
        previous.disabled = offset === 0; next.disabled = offset + 20 >= records.length;
        navigation.hidden = records.length <= 20;
        label.textContent = `${offset + 1}–${Math.min(offset + 20, records.length)} of ${records.length}`;
        element.hidden = !records.length;
    };
    previous.addEventListener('click', () => { if (offset > 0) { offset -= 20; paint(); } });
    next.addEventListener('click', () => { if (offset + 20 < records.length) { offset += 20; paint(); } });
    paint();
    return { element, update(value) {
        const key = JSON.stringify(value); if (key === signature) return;
        signature = key; records = value; offset = Math.min(offset, Math.max(0, Math.floor((records.length - 1) / 20) * 20));
        // Keep an open record and its source link focused when its source data
        // is unchanged; polling timestamps do not belong in the record key.
        paint();
    } };
}
