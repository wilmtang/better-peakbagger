// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface SnotelMapStation {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    elevation: number;
}

export type SnotelMapOcclusion = [number, number, number, number];

// Revalidate public metadata at each page-world / renderer boundary. Never
// accept a URL, HTML, measurements, or an unbounded catalog through the bridge.
export function readSnotelMapStations(value: unknown): SnotelMapStation[] | null {
    if (!Array.isArray(value) || value.length > 50) return null;
    const ids = new Set<string>(), stations: SnotelMapStation[] = [];
    for (const raw of value as unknown[]) {
        if (!raw || typeof raw !== 'object') return null;
        const station = raw as Record<string, unknown>;
        if (typeof station.id !== 'string' || !/^\d{1,8}:[A-Z]{2}:SNTL$/.test(station.id)
            || ids.has(station.id) || typeof station.name !== 'string' || !station.name.trim() || station.name.length > 120
            || /[\u0000-\u001f\u007f]/.test(station.name)
            || typeof station.latitude !== 'number' || !Number.isFinite(station.latitude) || Math.abs(station.latitude) > 90
            || typeof station.longitude !== 'number' || !Number.isFinite(station.longitude) || Math.abs(station.longitude) > 180
            || typeof station.elevation !== 'number' || !Number.isFinite(station.elevation) || station.elevation < -610 || station.elevation > 6100) return null;
        ids.add(station.id);
        stations.push({ id: station.id, name: station.name.trim(), latitude: station.latitude,
            longitude: station.longitude, elevation: station.elevation });
    }
    return stations;
}

// The outer menu's normalized screen rectangle, revalidated at each relay.
// The renderer converts it to its own CSS pixels.
export function readSnotelMapOcclusion(value: unknown): SnotelMapOcclusion | null {
    if (!Array.isArray(value) || value.length !== 4) return null;
    const items = value as unknown[];
    if (!items.every((number): number is number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1)) return null;
    return items[0] < items[2] && items[1] < items[3] ? [items[0], items[1], items[2], items[3]] : null;
}


export function readSnotelMapOcclusions(value: unknown): SnotelMapOcclusion[] {
    if (!Array.isArray(value) || value.length > 8) return [];
    const rectangles = (value as unknown[]).map(readSnotelMapOcclusion);
    return rectangles.every((rect): rect is SnotelMapOcclusion => rect !== null) ? rectangles : [];
}
