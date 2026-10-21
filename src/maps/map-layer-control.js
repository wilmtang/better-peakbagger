// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../settings/settings-schema.js';

const LABELS = { sentinel: 'Sentinel-2 β', slope: 'Slope angle', land: 'Public lands', snotel: 'SNOTEL stations' };
const NAMES = { ...LABELS, sentinel: 'Sentinel-2 (experimental)' };

// Presentation only. The owner supplies validated state and performs all I/O.
export function createMapLayerControl({ document: doc, onToggle = () => {}, onOpacity = () => {},
    onCommit = () => {}, onCapture = () => {}, onRetry = () => {}, onOpen = () => {} }) {
    const win = doc.defaultView;
    const node = (tag, className, text) => {
        const element = doc.createElement(tag);
        if (tag === 'select' || tag === 'input') element.setAttribute('form', '');
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const element = node('div', 'bpb-map-layers');
    const trigger = node('button', 'bpb-layers-trigger', 'Layers'); trigger.type = 'button';
    trigger.setAttribute('aria-expanded', 'false');
    const indicator = node('span', 'bpb-layers-indicator'); indicator.setAttribute('aria-hidden', 'true'); trigger.append(indicator);
    const caret = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    caret.setAttribute('class', 'bpb-layers-caret'); caret.setAttribute('viewBox', '0 0 12 12');
    caret.setAttribute('aria-hidden', 'true'); caret.setAttribute('focusable', 'false');
    const caretPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    caretPath.setAttribute('d', 'm2 4 4 4 4-4'); caretPath.setAttribute('fill', 'none');
    caretPath.setAttribute('stroke', 'currentColor'); caretPath.setAttribute('stroke-width', '1.5');
    caretPath.setAttribute('stroke-linecap', 'round'); caretPath.setAttribute('stroke-linejoin', 'round');
    caret.append(caretPath); trigger.append(caret);
    const panel = node('div', 'bpb-layers-panel'); panel.hidden = true;
    const id = `bpb-layers-${Math.random().toString(36).slice(2)}`;
    panel.id = id; trigger.setAttribute('aria-controls', id);
    const rows = new Map(), details = new Map();
    const well = node('div', 'bpb-layers-details'); well.hidden = true;
    well.id = `${id}-details`;
    const live = node('span', 'bpb-layers-live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    let open = false, expanded = null, rect = null, model = {}, disposed = false, cooldownTimer = null;
    for (const key of Schema.MAP_OVERLAY_IDS) {
        const row = node('div', 'bpb-layers-row'); row.dataset.layer = key;
        const label = node('label', 'bpb-layers-choice');
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', NAMES[key]);
        label.append(checkbox, node('span', '', LABELS[key]));
        const disclosure = node('button', 'bpb-layers-disclosure'); disclosure.type = 'button';
        disclosure.setAttribute('aria-label', `Adjust ${NAMES[key]}`); disclosure.setAttribute('aria-expanded', 'false');
        disclosure.setAttribute('aria-controls', well.id);
        const value = node('span', 'bpb-layers-value'), chevron = node('span', '', '›'); chevron.setAttribute('aria-hidden', 'true');
        disclosure.append(value, chevron); row.append(label, disclosure); panel.append(row);
        const detail = node('section', 'bpb-layers-detail'); detail.hidden = true;
        detail.setAttribute('aria-label', `${NAMES[key]} settings`); detail.append(node('div', 'bpb-layers-detail-title', NAMES[key]));
        let slider = null, output = null, capture = null;
        if (key !== 'snotel') {
            const caption = node('label', 'bpb-layers-opacity'); caption.append(node('span', '', 'Opacity'));
            output = node('output'); caption.append(output);
            slider = node('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
            slider.id = `${id}-${key}`; slider.setAttribute('aria-label', `${NAMES[key]} opacity`); caption.htmlFor = slider.id;
            detail.append(caption, slider);
            slider.addEventListener('input', () => onOpacity(key, Number(slider.value)));
            slider.addEventListener('change', () => onCommit());
        }
        if (key === 'sentinel') {
            capture = node('select'); capture.setAttribute('aria-label', 'Sentinel-2 capture');
            capture.addEventListener('change', () => {
                capture.title = capture.selectedOptions[0]?.title || '';
                onCapture(capture.value);
            }); detail.append(capture);
        }
        const legend = node('div', 'bpb-layers-legend'); detail.append(legend);
        const feedback = node('div', 'bpb-layers-feedback');
        const status = node('span'), action = node('span', 'bpb-layers-recovery');
        const retry = node('button', 'bpb-layers-retry', 'Retry'); retry.type = 'button'; retry.hidden = true;
        retry.addEventListener('click', () => {
            const current = model.statuses?.[key];
            if (current?.pending || current?.retryAt > Date.now()) return;
            onRetry(key);
        });
        action.append(retry); feedback.append(status, action); detail.append(feedback); well.append(detail);
        checkbox.addEventListener('change', () => onToggle(key, checkbox.checked));
        disclosure.addEventListener('click', () => {
            expanded = expanded === key ? null : key;
            paint();
        });
        rows.set(key, { row, checkbox, disclosure, value });
        details.set(key, { detail, slider, output, capture, legend, status, retry, captureKey: '' });
    }
    panel.append(well); element.append(trigger, panel, live);
    const position = () => {
        if (!rect) return;
        const width = win.innerWidth || doc.documentElement.clientWidth || 320;
        const height = win.innerHeight || 800;
        const left = Math.max(8, Math.min(rect.left + 10, width - 110));
        const top = rect.top + 10;
        element.style.left = `${left}px`; element.style.top = `${top}px`;
        panel.style.width = `${Math.min(232, width - 16)}px`;
        panel.style.left = `${Math.min(0, width - 8 - left - Math.min(232, width - 16))}px`;
        const panelTop = Number.parseFloat(win.getComputedStyle(panel).top) || 38;
        panel.style.maxHeight = `${Math.max(40, height - Math.max(8, top) - panelTop - 8)}px`;
        element.hidden = rect.width < 120 || rect.height < 80 || rect.bottom < 42 || rect.top > height - 30;
    };
    const paint = () => {
        if (disposed) return;
        win.clearTimeout(cooldownTimer);
        const nextRetry = Math.min(...Object.values(model.statuses || {}).map(status => status.retryAt).filter(value => value > Date.now()));
        if (Number.isFinite(nextRetry)) cooldownTimer = win.setTimeout(paint, Math.max(1, Math.min(86400000, nextRetry - Date.now() + 1)));
        element.dataset.theme = model.theme === 'dark' ? 'dark' : 'light';
        panel.hidden = !open; well.hidden = !open || !expanded;
        trigger.setAttribute('aria-expanded', String(open));
        const state = Schema.mapOverlayState(model.state);
        const active = Schema.MAP_OVERLAY_IDS.filter(key => state[key].enabled);
        const failed = active.some(key => model.statuses?.[key]?.error);
        indicator.dataset.kind = failed ? 'error' : active.length ? 'active' : 'off';
        trigger.setAttribute('aria-label', `Layers${active.length ? `, ${active.length} active` : ''}${failed ? ', layer unavailable' : ''}`);
        for (const key of Schema.MAP_OVERLAY_IDS) {
            const row = rows.get(key), detail = details.get(key), current = state[key], status = model.statuses?.[key] || {};
            row.row.hidden = model.available && !model.available.includes(key);
            row.checkbox.checked = current.enabled; row.checkbox.disabled = status.unavailable === true;
            row.disclosure.setAttribute('aria-expanded', String(open && expanded === key));
            row.disclosure.setAttribute('aria-label', `Adjust ${NAMES[key]}${status.message ? `: ${status.message}` : ''}`);
            row.value.textContent = key === 'snotel' ? (Number.isInteger(status.count) ? String(status.count) : '') : `${current.opacity}%`;
            row.row.dataset.status = status.error ? 'error' : status.pending ? 'pending' : '';
            detail.detail.hidden = !open || expanded !== key || row.row.hidden;
            if (detail.slider) {
                detail.slider.value = String(current.opacity); detail.slider.disabled = !current.enabled;
                detail.slider.setAttribute('aria-valuetext', `${current.opacity} percent`); detail.output.value = `${current.opacity}%`;
            }
            detail.legend.replaceChildren(...(status.legendEntries || []).map(entry => {
                const item = node('span', 'bpb-layers-legend-item'), swatch = node('i');
                swatch.style.backgroundColor = entry.color; swatch.setAttribute('aria-hidden', 'true');
                item.append(swatch, doc.createTextNode(entry.label)); return item;
            }), doc.createTextNode(status.legend || ''));
            detail.status.textContent = status.message || '';
            if (detail.capture) {
                const captures = Array.isArray(status.captures) ? status.captures : [{ id: 'latest', label: 'Latest capture' }];
                const signature = JSON.stringify(captures);
                if (signature !== detail.captureKey) {
                    detail.captureKey = signature;
                    detail.capture.replaceChildren(...captures.map(choice => { const option = node('option', '', choice.label); option.value = choice.id; option.title = choice.title || choice.label; option.setAttribute('aria-label', option.title); return option; }));
                }
                detail.capture.value = status.capture || 'latest'; detail.capture.disabled = !current.enabled || status.pending === true;
                detail.capture.title = detail.capture.selectedOptions[0]?.title || '';
            }
            const showRetry = current.enabled && status.retry === true;
            if (!showRetry && doc.activeElement === detail.retry) row.disclosure.focus({ preventScroll: true });
            detail.retry.hidden = !showRetry;
            detail.retry.setAttribute('aria-disabled', String(status.pending === true || status.retryAt > Date.now()));
            detail.retry.title = status.retryAt > Date.now() ? `Try again after ${new Date(status.retryAt).toLocaleTimeString()}` : '';
        }
        position();
    };
    const setOpen = value => {
        if (open === value) return;
        open = value;
        if (!open) expanded = null;
        paint(); onOpen(open);
    };
    trigger.addEventListener('click', () => setOpen(!open));
    paint();
    return {
        element, trigger,
        render(next) { model = next; paint(); },
        position(next) { rect = next; position(); },
        isOpen: () => open,
        announce(message) { live.textContent = message; },
        dispose() { disposed = true; win.clearTimeout(cooldownTimer); element.remove(); },
    };
}
