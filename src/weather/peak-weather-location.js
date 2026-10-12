// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';

// Both map worlds and the isolated card validate this narrow message. Opening
// the menu never fetches weather; only its explicit action selects a location.
export function readWeatherMapPoint(data) {
    if (!data || !Number.isFinite(data.latitude) || Math.abs(data.latitude) > 90
        || !Number.isFinite(data.longitude) || Math.abs(data.longitude) > 180
        || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;
    return { latitude: data.latitude, longitude: data.longitude, x: data.x, y: data.y };
}

export const weatherLocationLabel = point => `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`;

export function createWeatherLocationMenu({ enabled, canSelect = () => true, onSelect }) {
    const action = dom.element('button', { type: 'button', role: 'menuitem', text: 'Forecast and archive for this location' });
    const coordinates = dom.element('p', { class: 'bpb-weather-menu-coordinates', 'aria-hidden': 'true' });
    const menu = dom.element('div', { id: 'bpb-peak-weather-menu', hidden: '', role: 'menu', tabindex: '-1', 'aria-label': 'Map weather' }, [action, coordinates]);
    document.body.append(menu);
    let selected = null, returnFocus = null, frameDocument = null;
    const close = (restore = false) => {
        if (menu.hidden) return;
        menu.hidden = true; selected = null;
        frameDocument?.removeEventListener('pointerdown', outside);
        frameDocument?.removeEventListener('keydown', keyboard);
        frameDocument = null;
        if (restore) returnFocus?.focus({ preventScroll: true });
    };
    const outside = event => { if (!menu.contains(event.target)) close(); };
    const keyboard = event => {
        if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') close();
        else if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); action.focus({ preventScroll: true }); }
    };
    const dismiss = () => close();
    const receive = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.__bpbPeakWeather !== true) return;
        if (event.data.type === 'dismiss') { close(); return; }
        if (!enabled() || event.data.type !== 'context' || !['native', 'terrain'].includes(event.data.map)) return;
        const point = readWeatherMapPoint(event.data);
        const frame = document.getElementById(event.data.map === 'terrain' ? 'bpb-terrain-frame' : 'Gmap');
        if (!point || !frame || frame.getAttribute('aria-hidden') === 'true') return;
        const rect = frame.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return;
        close(); selected = point; returnFocus = frame;
        action.disabled = !canSelect();
        action.title = action.disabled ? 'Weather requests are temporarily limited. Try again after the cooldown.' : '';
        coordinates.textContent = weatherLocationLabel(point);
        menu.hidden = false;
        const size = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - size.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - size.height - 8))}px`;
        // Same-origin 2D clicks occur in another document. The 3D bridge sends
        // a dismiss message instead; its extension frame is cross-origin.
        try { frameDocument = frame.contentDocument; } catch { frameDocument = null; }
        frameDocument?.addEventListener('pointerdown', outside);
        frameDocument?.addEventListener('keydown', keyboard);
        (action.disabled ? menu : action).focus({ preventScroll: true });
    };
    action.addEventListener('click', () => {
        const point = selected; close(true);
        if (point && enabled() && canSelect()) onSelect({ latitude: point.latitude, longitude: point.longitude, elevation: null });
    });
    window.addEventListener('message', receive);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return { close, dispose() {
        close(); menu.remove(); window.removeEventListener('message', receive);
        document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true);
        window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss);
    } };
}
