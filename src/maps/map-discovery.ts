// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface DiscoveredLeafletMap {
    on(type: 'unload', listener: () => void): unknown;
}

export interface LeafletMapConstructor {
    addInitHook?(hook: (this: DiscoveredLeafletMap) => void): unknown;
}

export interface LeafletLibraryLike {
    Map?: LeafletMapConstructor;
}

export interface MapDiscoveryWindow {
    L?: LeafletLibraryLike;
    CustomEvent: new <T = unknown>(type: string, eventInitDict?: CustomEventInit<T>) => CustomEvent<T>;
    dispatchEvent(event: Event): boolean;
}

// Capture Leaflet instances before host inline scripts create unnamed maps.
// The registry is discovery only; every adapter still validates/claims its map.
export function installMapDiscovery(win: MapDiscoveryWindow = window): void {
    const key = Symbol.for('bpb.leafletMaps');
    const registry = win as unknown as Record<symbol, Set<DiscoveredLeafletMap> | undefined>;
    if (registry[key]) return;
    const maps = new Set<DiscoveredLeafletMap>();
    Object.defineProperty(win, key, { value: maps });
    const hooked = new WeakSet<LeafletMapConstructor>();
    const hook = (library: LeafletLibraryLike | undefined) => {
        if (!library?.Map?.addInitHook || hooked.has(library.Map)) return;
        hooked.add(library.Map);
        library.Map.addInitHook(function (this: DiscoveredLeafletMap) {
            queueMicrotask(() => {
                maps.add(this); this.on('unload', () => maps.delete(this));
                win.dispatchEvent(new win.CustomEvent('bpb-map-ready', { detail: { map: this } }));
            });
        });
    };
    const descriptor = Object.getOwnPropertyDescriptor(win, 'L');
    if (descriptor) { hook(win.L); return; }
    Object.defineProperty(win, 'L', { configurable: true, enumerable: true,
        get() { return undefined; },
        set(library: LeafletLibraryLike | undefined) {
            Object.defineProperty(win, 'L', { configurable: true, enumerable: true, writable: true, value: library });
            hook(library);
        } });
}
if (typeof window !== 'undefined') installMapDiscovery();
