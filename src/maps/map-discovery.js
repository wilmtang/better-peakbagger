// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Capture Leaflet instances before host inline scripts create unnamed maps.
// The registry is discovery only; every adapter still validates/claims its map.
export function installMapDiscovery(win = window) {
    const key = Symbol.for('bpb.leafletMaps');
    if (win[key]) return;
    const maps = new Set(); Object.defineProperty(win, key, { value: maps });
    const hooked = new WeakSet();
    const hook = library => {
        if (!library?.Map?.addInitHook || hooked.has(library.Map)) return;
        hooked.add(library.Map);
        library.Map.addInitHook(function () {
            const map = this;
            queueMicrotask(() => {
                maps.add(map); map.on('unload', () => maps.delete(map));
                win.dispatchEvent(new win.CustomEvent('bpb-map-ready', { detail: { map } }));
            });
        });
    };
    const descriptor = Object.getOwnPropertyDescriptor(win, 'L');
    if (descriptor) { hook(win.L); return; }
    Object.defineProperty(win, 'L', { configurable: true, enumerable: true,
        get() { return undefined; }, set(library) {
            Object.defineProperty(win, 'L', { configurable: true, enumerable: true, writable: true, value: library });
            hook(library);
        } });
}
if (typeof window !== 'undefined') installMapDiscovery();
