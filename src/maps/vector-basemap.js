// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const VECTOR_BASEMAP = Object.freeze({
    code: 'BPB_VECTOR',
    name: 'OSM Vector (experimental)',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
});
export const VECTOR_MESSAGE = '__bpbVectorMap';

// The Leaflet adapter sends the camera in MapLibre's 512-pixel zoom convention.
// Unlike terrain, a planar map can show the whole world at Leaflet zoom zero.
export function readVectorView(value) {
    if (!value || !Array.isArray(value.center) || value.center.length !== 2
        || !value.center.every(Number.isFinite) || Math.abs(value.center[0]) > 85.0511287
        || Math.abs(value.center[1]) > 180 || !Number.isFinite(value.zoom)
        || value.zoom < -1 || value.zoom > 23) return null;
    return { center: [...value.center], zoom: value.zoom };
}
