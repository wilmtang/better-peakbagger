// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Revalidate public metadata at each page-world / renderer boundary. Never
// accept a URL, HTML, measurements, or an unbounded catalog through the bridge.
export function readSnotelMapStations(value) {
    if (!Array.isArray(value) || value.length > 50) return null;
    const ids = new Set(), stations = [];
    for (const station of value) {
        if (!station || typeof station.id !== 'string' || !/^\d{1,8}:[A-Z]{2}:SNTL$/.test(station.id)
            || ids.has(station.id) || typeof station.name !== 'string' || !station.name.trim() || station.name.length > 120
            || /[\u0000-\u001f\u007f]/.test(station.name)
            || !Number.isFinite(station.latitude) || Math.abs(station.latitude) > 90
            || !Number.isFinite(station.longitude) || Math.abs(station.longitude) > 180
            || !Number.isFinite(station.elevation) || station.elevation < -610 || station.elevation > 6100) return null;
        ids.add(station.id);
        stations.push({ id: station.id, name: station.name.trim(), latitude: station.latitude,
            longitude: station.longitude, elevation: station.elevation });
    }
    return stations;
}

// The outer menu's normalized screen rectangle, revalidated at each relay.
// The renderer converts it to its own CSS pixels.
export function readSnotelMapOcclusion(value) {
    return Array.isArray(value) && value.length === 4 && value.every(number => Number.isFinite(number) && number >= 0 && number <= 1)
        && value[0] < value[2] && value[1] < value[3] ? value.slice() : null;
}


export function readSnotelMapOcclusions(value) {
    if (!Array.isArray(value) || value.length > 8) return [];
    const rectangles = value.map(readSnotelMapOcclusion);
    return rectangles.every(Boolean) ? rectangles : [];
}
