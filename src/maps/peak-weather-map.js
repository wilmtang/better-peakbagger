// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readMapPoint } from './map-location-menu.js';

// MAIN-world native projection, shared by every Leaflet map. The map-layer
// lifecycle owns this binding so replaced frames cannot retain old listeners.
export function bindMapLocationMenu({ ownerWindow, map, frame, menu }) {
    const doc = ownerWindow.document, container = map.getContainer();
    const dismiss = event => { if (!event?.target?.closest?.('#bpb-peak-weather-menu')) menu.close(); };
    const open = (event, keyboard) => {
        if (!event.isTrusted || !container.contains(event.target)
            || event.target.closest?.('.leaflet-control, .leaflet-popup, a, button, input, textarea, select')) return;
        try {
            const rect = container.getBoundingClientRect(), offset = frame?.getBoundingClientRect();
            const point = keyboard ? map.getCenter() : map.mouseEventToLatLng(event);
            const latitude = point?.lat, longitude = ((point?.lng + 180) % 360 + 360) % 360 - 180;
            const x = (keyboard ? rect.left + rect.width / 2 : event.clientX) + (offset ? offset.left + frame.clientLeft : 0);
            const y = (keyboard ? rect.top + rect.height / 2 : event.clientY) + (offset ? offset.top + frame.clientTop : 0);
            if (!readMapPoint({ latitude, longitude, x, y })) return;
            event.preventDefault(); event.stopPropagation(); menu.show({ latitude, longitude, x, y, keyboard }, frame || container);
        } catch { /* Leave an unavailable or replaced map's native menu usable. */ }
    };
    const context = event => open(event, event.button !== 2 && event.clientX === 0 && event.clientY === 0);
    const keydown = event => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) open(event, true);
    };
    doc.addEventListener('contextmenu', context, true); doc.addEventListener('pointerdown', dismiss, true);
    doc.addEventListener('keydown', keydown, true);
    doc.addEventListener('wheel', dismiss, { capture: true, passive: true }); doc.addEventListener('scroll', dismiss, true);
    return () => {
        dismiss(); doc.removeEventListener('contextmenu', context, true); doc.removeEventListener('pointerdown', dismiss, true);
        doc.removeEventListener('keydown', keydown, true);
        doc.removeEventListener('wheel', dismiss, true); doc.removeEventListener('scroll', dismiss, true);
    };
}
