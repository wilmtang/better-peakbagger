// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { OVERLAY_MIN_ZOOM } from './map-overlay-providers.js';
import { SENTINEL_MIN_ZOOM } from './sentinel-core.js';

const LABELS = { sentinel: 'Sentinel-2 β', slope: 'Slope angle', land: 'Public lands', snotel: 'SNOTEL stations' };
const NAMES = { ...LABELS, sentinel: 'Sentinel-2 (experimental)' };
const LAND_GUIDANCE = {
    blm: ['BLM camping rules', 'https://www.blm.gov/programs/recreation/camping'],
    bc: ['BC Crown land rules', 'https://www2.gov.bc.ca/gov/content/industry/crown-land-water/crown-land/crown-land-uses'],
    ab: ['Alberta camping rules', 'https://www.alberta.ca/camping-on-public-land'],
};

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
    const trigger = node('button', 'bpb-layers-trigger', 'Overlays'); trigger.type = 'button';
    trigger.setAttribute('aria-expanded', 'false');
    const indicator = node('span', 'bpb-layers-indicator'); indicator.setAttribute('aria-hidden', 'true'); trigger.append(indicator);
    const chevron = className => {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', className); svg.setAttribute('viewBox', '0 0 12 12');
        svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'm2 4 4 4 4-4'); path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
        path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
        svg.append(path); return svg;
    };
    trigger.append(chevron('bpb-layers-caret'));
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
        label.append(checkbox);
        const disclosure = node('button', 'bpb-layers-disclosure'); disclosure.type = 'button';
        disclosure.setAttribute('aria-label', `Adjust ${NAMES[key]}`); disclosure.setAttribute('aria-expanded', 'false');
        disclosure.setAttribute('aria-controls', well.id);
        const value = node('span', 'bpb-layers-value'), amount = node('span', 'bpb-layers-value-number');
        if (key !== 'snotel') value.append(node('span', 'bpb-layers-value-label', 'Opacity'));
        value.append(amount);
        const summary = node('span', 'bpb-layers-summary'), spinner = node('span', 'bpb-layers-spinner'); spinner.setAttribute('aria-hidden', 'true');
        const rowStatus = node('span', 'bpb-layers-row-status'); summary.append(spinner, value, rowStatus);
        const copy = node('span', 'bpb-layers-row-copy'); copy.append(node('span', 'bpb-layers-row-name', LABELS[key]), summary);
        label.append(copy); disclosure.append(chevron('bpb-layers-chevron'));
        row.append(label, disclosure); panel.append(row);
        const detail = node('section', 'bpb-layers-detail'); detail.hidden = true;
        detail.setAttribute('aria-label', `${NAMES[key]} settings`); detail.append(node('div', 'bpb-layers-detail-title', NAMES[key]));
        let slider = null, output = null, capture = null;
        if (key !== 'snotel') {
            const caption = node('label', 'bpb-layers-opacity'); caption.append(node('span', '', 'Opacity'));
            output = node('output'); caption.append(output);
            slider = node('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
            slider.id = `${id}-${key}`; slider.setAttribute('aria-label', `${NAMES[key]} opacity`); caption.htmlFor = slider.id;
            const ends = node('div', 'bpb-layers-opacity-ends'); ends.setAttribute('aria-hidden', 'true');
            ends.append(node('span', '', 'Clear'), node('span', '', 'Solid'));
            detail.append(caption, slider, ends);
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
        const guidance = key === 'land' ? node('div', 'bpb-layers-guidance-links') : null;
        if (guidance) detail.append(guidance);
        const feedback = node('div', 'bpb-layers-feedback');
        const status = node('span'), action = node('span', 'bpb-layers-recovery');
        const retry = node('button', 'bpb-layers-retry', 'Retry'); retry.type = 'button'; retry.hidden = true;
        retry.addEventListener('click', () => {
            const current = model.statuses?.[key];
            if (model.coverage?.[key] === false || current?.pending || current?.retryAt > Date.now() || current?.permission) return;
            const recovery = details.get(key); recovery.recovering = true; recovery.reloading = retry.textContent === 'Reload';
            // Long errors can make a zoomed menu scroll. Shrinking feedback at
            // activation clamps that scroll and moves the focused action. Hold
            // its current space only for this focused recovery transaction.
            const height = recovery.feedback.getBoundingClientRect().height;
            if (height > 0) recovery.feedback.style.minHeight = `${height}px`;
            onRetry(key);
        });
        retry.addEventListener('blur', () => { const recovery = details.get(key); recovery.recovering = false; recovery.reloading = false; recovery.feedback.style.minHeight = ''; paint(); });
        action.append(retry); feedback.append(status, action); detail.append(feedback); well.append(detail);
        checkbox.addEventListener('change', () => {
            if (model.coverage?.[key] === false) { paint(); return; }
            expanded = key;
            onToggle(key, checkbox.checked);
            paint();
        });
        disclosure.addEventListener('click', () => {
            expanded = expanded === key ? null : key;
            paint();
        });
        rows.set(key, { row, checkbox, disclosure, value, amount, spinner, rowStatus });
        details.set(key, { detail, slider, output, capture, legend, guidance, feedback, status, retry, captureKey: '', guidanceKey: '', legendKey: '' });
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
        const needsZoom = key => Number.isFinite(model.zoom) && (key === 'sentinel' ? model.zoom < SENTINEL_MIN_ZOOM
            : (key === 'slope' || key === 'land') && Math.round(model.zoom) < OVERLAY_MIN_ZOOM);
        const active = Schema.MAP_OVERLAY_IDS.filter(key => state[key].enabled && model.coverage?.[key] !== false);
        const failed = active.some(key => !needsZoom(key) && (key === 'snotel' || state[key].opacity > 0) && model.statuses?.[key]?.error && !model.statuses[key].permission);
        indicator.dataset.kind = failed ? 'error' : active.length ? 'active' : 'off';
        trigger.setAttribute('aria-label', `Overlays${active.length ? `, ${active.length} active` : ''}${failed ? ', overlay unavailable' : ''}`);
        for (const key of Schema.MAP_OVERLAY_IDS) {
            const row = rows.get(key), detail = details.get(key), current = state[key], status = model.statuses?.[key] || {};
            const unavailable = model.coverage?.[key] === false;
            const shown = !unavailable && current.enabled && (key === 'snotel' || current.opacity > 0);
            const zoomedOut = shown && needsZoom(key);
            const kind = unavailable ? 'coverage' : !shown ? '' : zoomedOut ? 'zoom' : status.pending ? 'loading' : status.saved ? 'saved' : status.overflow ? 'zoom' : status.permission ? 'permission' : status.error ? 'error' : status.uncovered ? 'coverage' : '';
            const cooldown = status.retryAt > Date.now();
            const summary = kind === 'loading' ? status.permission ? 'Waiting' : 'Loading'
                : kind === 'saved' ? 'Refresh failed' : kind === 'zoom' ? 'Zoom in' : kind === 'permission' ? status.partial ? 'Partly loaded' : 'Needs access'
                    : kind === 'coverage' ? 'No coverage' : kind === 'error' ? cooldown ? 'Service busy' : status.captureError ? 'Search failed' : status.partial ? 'Partly loaded' : 'Couldn’t load' : '';
            const heldRecovery = shown && !zoomedOut && detail.recovering && doc.activeElement === detail.retry && !status.permission;
            const recovered = heldRecovery && !status.pending && !status.error;
            row.row.hidden = model.available && !model.available.includes(key);
            row.row.dataset.unavailable = String(unavailable);
            if (unavailable && [row.checkbox, detail.slider, detail.capture].includes(doc.activeElement)) row.disclosure.focus({ preventScroll: true });
            row.checkbox.checked = !unavailable && current.enabled; row.checkbox.disabled = unavailable || status.unavailable === true;
            row.disclosure.setAttribute('aria-expanded', String(open && expanded === key));
            row.row.dataset.selected = String(open && expanded === key);
            row.disclosure.setAttribute('aria-label', `Adjust ${NAMES[key]}${key === 'snotel' ? '' : ` opacity, ${current.opacity} percent`}${summary ? `: ${summary}` : ''}`);
            row.disclosure.setAttribute('aria-busy', String(kind === 'loading'));
            row.amount.textContent = key === 'snotel' ? current.enabled ? Number.isInteger(status.count) ? `${status.count} in view` : 'On' : 'Off' : `${current.opacity}%`;
            row.value.hidden = Boolean(kind); row.rowStatus.hidden = !kind; row.rowStatus.textContent = summary;
            row.spinner.hidden = kind !== 'loading'; row.row.dataset.status = kind;
            detail.detail.hidden = !open || expanded !== key || row.row.hidden;
            if (detail.slider) {
                detail.slider.value = String(current.opacity); detail.slider.disabled = unavailable || !current.enabled;
                detail.slider.setAttribute('aria-valuetext', `${current.opacity} percent opacity`); detail.output.value = `${current.opacity}%`;
            }
            const legendKey = JSON.stringify([status.legendEntries || [], status.legend || '']);
            if (legendKey !== detail.legendKey) {
                detail.legendKey = legendKey;
                detail.legend.replaceChildren(...(status.legendEntries || []).map(entry => {
                    const item = node('span', 'bpb-layers-legend-item'), swatch = node('i');
                    swatch.style.backgroundColor = entry.color; swatch.setAttribute('aria-hidden', 'true');
                    item.append(swatch, doc.createTextNode(entry.label)); return item;
                }), node('div', 'bpb-layers-legend-caption', status.legend || ''));
            }
            detail.feedback.dataset.kind = recovered ? 'success' : kind;
            detail.status.textContent = unavailable ? 'No coverage here.' : !current.enabled ? status.unavailable ? status.message : 'Turn on to show this overlay.'
                : !shown ? 'Increase opacity to show this overlay.' : zoomedOut ? `Zoom in for ${key === 'sentinel' ? 'imagery' : key === 'land' ? 'public lands' : 'slope shading'}.`
                    : cooldown ? `${status.saved ? 'Showing loaded locations. ' : ''}Service busy. Retry after ${new Date(status.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : status.message || (recovered ? 'Overlay refreshed.' : '');
            if (detail.guidance) {
                const keys = [...new Set((Array.isArray(status.guidanceKeys) ? status.guidanceKeys : ['blm']).slice(0, 3).filter(guide => Object.hasOwn(LAND_GUIDANCE, guide)))];
                const signature = JSON.stringify(keys);
                if (signature !== detail.guidanceKey) {
                    detail.guidanceKey = signature;
                    detail.guidance.replaceChildren(...keys.map(guide => {
                        const [label, url] = LAND_GUIDANCE[guide], link = node('a', 'bpb-layers-guidance', label);
                        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
                    }));
                }
            }
            if (detail.capture) {
                const captures = Array.isArray(status.captures) ? status.captures : [{ id: 'latest', label: 'Latest capture' }];
                const signature = JSON.stringify(captures);
                if (signature !== detail.captureKey) {
                    detail.captureKey = signature;
                    detail.capture.replaceChildren(...captures.map(choice => { const option = node('option', '', choice.label); option.value = choice.id; option.title = choice.title || choice.label; option.setAttribute('aria-label', option.title); return option; }));
                }
                detail.capture.value = status.capture || 'latest'; detail.capture.disabled = unavailable || !current.enabled || (status.capturePending ?? status.pending) === true;
                detail.capture.title = detail.capture.selectedOptions[0]?.title || '';
            }
            const showRetry = shown && !zoomedOut && (status.retry === true || heldRecovery);
            if (!showRetry && doc.activeElement === detail.retry) row.disclosure.focus({ preventScroll: true });
            detail.retry.hidden = !showRetry;
            detail.retry.textContent = status.permission ? 'Allow' : status.error ? 'Retry' : (heldRecovery && !status.pending || detail.reloading) ? 'Reload' : 'Retry';
            detail.retry.dataset.bpbBcPermission = String(key === 'land' && status.permission === true);
            detail.retry.setAttribute('aria-label', status.permission ? 'Allow BC land maps' : detail.retry.textContent);
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
