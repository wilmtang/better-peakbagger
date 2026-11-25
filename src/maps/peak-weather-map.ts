// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readMapPoint } from './map-location-menu.ts';

export interface LeafletLocationMap {
    getContainer(): HTMLElement;
    getCenter(): { lat: number; lng: number };
    mouseEventToLatLng?(event: MouseEvent): { lat: number; lng: number } | null | undefined;
}

export interface LocationMenuTarget {
    close(): void;
    show(data: unknown, target: HTMLElement): void;
}

export interface BindMapLocationMenuOptions {
    ownerWindow: { document: Document };
    map: LeafletLocationMap;
    frame?: HTMLElement | null;
    menu: LocationMenuTarget;
}

// MAIN-world native projection, shared by every Leaflet map. The map-layer
// lifecycle owns this binding so replaced frames cannot retain old listeners.
export function bindMapLocationMenu({ ownerWindow, map, frame, menu }: BindMapLocationMenuOptions): () => void {
    const doc = ownerWindow.document;
    const container = map.getContainer();
    const dismiss = (event?: Event): void => {
        if (!(event?.target as Element | null | undefined)?.closest?.('#bpb-peak-weather-menu')) menu.close();
    };
    const open = (event: MouseEvent | KeyboardEvent, keyboard: boolean): void => {
        if (!event.isTrusted || !container.contains(event.target as Node | null)
            || (event.target as Element | null | undefined)?.closest?.('.leaflet-control, .leaflet-popup, a, button, input, textarea, select')) return;
        try {
            const rect = container.getBoundingClientRect();
            const offset = frame ? frame.getBoundingClientRect() : null;
            const point = keyboard ? map.getCenter() : map.mouseEventToLatLng?.(event as MouseEvent);
            const latitude = point?.lat;
            const longitude = point ? ((point.lng + 180) % 360 + 360) % 360 - 180 : NaN;
            const x = (keyboard ? rect.left + rect.width / 2 : (event as MouseEvent).clientX)
                + (offset && frame ? offset.left + frame.clientLeft : 0);
            const y = (keyboard ? rect.top + rect.height / 2 : (event as MouseEvent).clientY)
                + (offset && frame ? offset.top + frame.clientTop : 0);
            if (!readMapPoint({ latitude, longitude, x, y })) return;
            event.preventDefault();
            event.stopPropagation();
            menu.show({ latitude, longitude, x, y, keyboard }, frame || container);
        } catch { /* Leave an unavailable or replaced map's native menu usable. */ }
    };
    const context = (event: MouseEvent): void => open(event, event.button !== 2 && event.clientX === 0 && event.clientY === 0);
    const keydown = (event: KeyboardEvent): void => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) open(event, true);
    };
    doc.addEventListener('contextmenu', context, true);
    doc.addEventListener('pointerdown', dismiss, true);
    doc.addEventListener('keydown', keydown, true);
    doc.addEventListener('wheel', dismiss, { capture: true, passive: true });
    doc.addEventListener('scroll', dismiss, true);
    return () => {
        dismiss();
        doc.removeEventListener('contextmenu', context, true);
        doc.removeEventListener('pointerdown', dismiss, true);
        doc.removeEventListener('keydown', keydown, true);
        doc.removeEventListener('wheel', dismiss, true);
        doc.removeEventListener('scroll', dismiss, true);
    };
}
