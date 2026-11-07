// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createElevationClient } from './map-elevation.js';
import { units } from '../ui/units.js';
import { readPeakUnitSystem } from '../peakbagger/peak-units.js';
import { settingsSchema as Schema } from '../settings/settings-schema.ts';
import { createStableText } from '../ui/stable-text.js';

import { createInspectionLayers, inspectionContext, subscribeLayerInspection } from './map-layer-inspection.ts';
import type { InspectionPoint, InspectableMapLayer } from './map-layer-inspection.ts';

export function readMapPoint(data: unknown): InspectionPoint | null {
    if (!data || typeof data !== 'object') return null;
    const value = data as Record<string, unknown>;
    if (['latitude', 'longitude', 'x', 'y'].some(key => typeof value[key] !== 'number')) return null;
    return validateMapPoint(value as unknown as InspectionPoint);
}
function validateMapPoint(data: InspectionPoint) {
    if (!data || !Number.isFinite(data.latitude) || Math.abs(data.latitude) > 90
        || !Number.isFinite(data.longitude) || Math.abs(data.longitude) > 180
        || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;
    return { latitude: data.latitude, longitude: data.longitude, x: data.x, y: data.y };
}

interface MenuOptions {
    window?: Window;
    client?: {lookup(point: InspectionPoint, options: {signal: AbortSignal}): Promise<number | null>; clear(): void};
    layers?: InspectableMapLayer[];
}
export function createMapLocationMenu({ window: win = window, client = createElevationClient({ document: win.document }),
    layers = createInspectionLayers(globalThis.fetch?.bind(globalThis)) }: MenuOptions = {}) {
    const doc = win.document;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
        const node = doc.createElement(tag); node.className = className;
        if (text) node.textContent = text; return node;
    };
    // Keep the existing ID so weather's action remains discoverable to callers.
    const menu = element('div', 'bpb-map-location-menu'); menu.id = 'bpb-peak-weather-menu';
    menu.hidden = true; menu.tabIndex = -1; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'Map location');
    const reading = element('div', 'bpb-map-location-reading');
    const label = element('div', 'bpb-map-location-label', 'Elevation');
    const value = element('div', 'bpb-map-location-value');
    const alternative = element('div', 'bpb-map-location-alternative');
    const valueText = createStableText(value), alternativeText = createStableText(alternative);
    valueText.reserve(['Loading…', 'Unavailable', '≈ −39,370 ft']);
    alternativeText.reserve(['Checking data…', 'Try again later', 'Try another point', '−12,000 m']);
    reading.setAttribute('role', 'status'); reading.setAttribute('aria-live', 'polite'); reading.setAttribute('aria-atomic', 'true');
    reading.append(label, value, alternative);
    const coordinates = element('div', 'bpb-weather-menu-coordinates'); coordinates.setAttribute('aria-label', 'Coordinates');
    const note = element('div', 'bpb-map-location-source', 'Terrain estimate · Mapterhorn');
    note.title = 'Elevation is approximate. Terrain grids can smooth over summits, cliffs and ridges.';
    const action = element('button', 'bpb-map-location-weather', 'Forecast and archive for this location');
    action.type = 'button'; action.hidden = true;
    const layerReadings = element('dl', 'bpb-map-location-layers'); layerReadings.hidden = true;
    menu.append(reading, coordinates, note, layerReadings, action); doc.body.append(menu);
    let selected: InspectionPoint | null = null, returnFocus: HTMLElement | null = null, controller: AbortController | null = null, generation = 0, meters: number | null = null;
    let preference = Schema.clean({}), state = 'loading', disposed = false;
    const weatherCard = () => doc.getElementById('bpb-peak-weather');
    const updateWeather = () => {
        const card = weatherCard();
        const hadFocus = doc.activeElement === action;
        action.hidden = !card || card.hidden || !card.dataset.bpbMapWeather;
        action.disabled = card?.dataset.bpbMapWeather !== 'ready';
        action.title = action.disabled ? 'Weather requests are temporarily limited. Try again after the cooldown.' : '';
        if (!menu.hidden && hadFocus && (action.hidden || action.disabled)) menu.focus({ preventScroll: true });
        if (!menu.hidden && !action.hidden && !action.disabled && doc.activeElement === menu) action.focus({ preventScroll: true });
    };
    const paint = () => {
        menu.dataset.state = state;
        if (state === 'ready' && meters !== null) {
            const system = units.resolveUnits(preference, () => readPeakUnitSystem(doc), 'elevation');
            const number = (targetSystem: string) => Math.round(targetSystem === 'imperial' ? units.feetFromMeters(meters!) : meters!).toLocaleString();
            const other = system === 'metric' ? 'imperial' : 'metric';
            valueText.set(`≈ ${number(system)} ${system === 'metric' ? 'm' : 'ft'}`);
            alternativeText.set(`${number(other)} ${other === 'metric' ? 'm' : 'ft'}`);
        } else {
            valueText.set(state === 'loading' ? 'Loading…' : 'Unavailable');
            alternativeText.set(state === 'loading' ? 'Checking data…' : state === 'limited' ? 'Try again later' : 'Try another point');
        }
    };
    const close = (restore = false) => {
        generation++; controller?.abort(); controller = null; selected = null;
        if (menu.hidden) return;
        menu.hidden = true;
        if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    const show = (data: unknown, target: HTMLElement) => {
        const point = readMapPoint(data); if (!point || !target || disposed) return;
        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return;
        close(); selected = point; returnFocus = target; state = 'loading'; meters = null;
        menu.dataset.keyboard = (data as Record<string, unknown>).keyboard === true ? 'true' : 'false';
        coordinates.textContent = `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`;
        controller = new AbortController(); const owner = generation, signal = controller.signal;
        const context = inspectionContext(doc, point);
        const applicable = context ? layers.filter(layer => layer.applicable(context, point)) : [];
        layerReadings.replaceChildren(); layerReadings.hidden = applicable.length === 0;
        for (const layer of applicable) {
            const row = element('div', 'bpb-map-location-layer'); row.dataset.layer = layer.id;
            const name = element('dt', '', layer.label), result = element('dd', '', 'Loading…');
            const text = createStableText(result);
            // Reserve the bounded values before positioning: late provider
            // responses must not move the menu or its forecast action.
            text.reserve(layer.id === 'land' ? ['Other federal', 'Local / district', 'No mapped parcel', 'No selected type', '8 land types', 'Unavailable', 'Loading…', 'Service busy']
                : ['394–787 in', 'Unavailable', 'Loading…', 'Service busy', '≈ 90.0°']);
            row.setAttribute('role', 'status'); row.setAttribute('aria-live', 'polite'); row.setAttribute('aria-atomic', 'true');
            row.append(name, result); layerReadings.append(row);
            void Promise.resolve().then(() => layer.rightClick(point, context!, signal)).then(layerReading => {
                if (owner !== generation || disposed) return;
                text.set(layerReading.value); row.title = layerReading.detail; result.setAttribute('aria-label', `${layerReading.value}. ${layerReading.detail}`);
            }, error => {
                if (owner !== generation || disposed) return;
                text.set(error instanceof Error && error.message === 'Service busy' ? 'Service busy' : 'Unavailable');
                row.title = 'Point information could not be loaded. Close and right-click to try again.';
            });
        }
        updateWeather(); paint(); menu.hidden = false;
        const size = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(point.x, win.innerWidth - size.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(point.y, win.innerHeight - size.height - 8))}px`;
        (action.hidden || action.disabled ? menu : action).focus({ preventScroll: true });
        void client.lookup(point, { signal }).then(result => {
            if (owner !== generation || disposed) return;
            meters = Number.isFinite(result) ? result : null; state = meters === null ? 'unavailable' : 'ready'; paint();
        }, error => {
            if (owner !== generation || disposed) return;
            state = error?.code === 'rate-limit' ? 'limited' : 'unavailable'; paint();
        });
    };
    const outside = (event: Event) => { if (!event.target || !('nodeType' in event.target) || !menu.contains(event.target as Node)) close(); };
    const keyboard = (event: KeyboardEvent) => {
        if (menu.hidden) return;
        menu.dataset.keyboard = 'true';
        if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault(); event.stopPropagation(); close(true);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !action.hidden && !action.disabled) {
            event.preventDefault(); action.focus({ preventScroll: true });
        }
    };
    const dismiss = () => close();
    const unsubscribe = subscribeLayerInspection(doc, dismiss);
    action.addEventListener('click', () => {
        if (action.hidden || action.disabled || !selected) return;
        const point = selected; close(true);
        win.postMessage({ __bpbPeakWeather: true, type: 'select', ...point }, win.location.origin);
    });
    doc.addEventListener('bpb-map-weather-change', updateWeather);
    doc.addEventListener('bpb-map-menu-close', dismiss);
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('focusin', outside);
    doc.addEventListener('keydown', keyboard, true);
    win.addEventListener('blur', dismiss); win.addEventListener('scroll', outside, true); win.addEventListener('resize', dismiss);
    return { show, close,
        setUnits(settings: unknown) { preference = Schema.clean(settings); if (!menu.hidden) paint(); },
        dispose() {
            disposed = true; unsubscribe(); close(); client.clear(); menu.remove();
            doc.removeEventListener('bpb-map-weather-change', updateWeather); doc.removeEventListener('bpb-map-menu-close', dismiss);
            doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('focusin', outside); doc.removeEventListener('keydown', keyboard, true);
            win.removeEventListener('blur', dismiss); win.removeEventListener('scroll', outside, true); win.removeEventListener('resize', dismiss);
        },
    };
}
