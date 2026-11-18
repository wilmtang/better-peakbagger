// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { units } from '../ui/units.ts';

export const SNOTEL_RADIUS_METERS = 50_000;

export interface SnotelLocation {
    latitude: number;
    longitude: number;
}

export interface SnotelStationLocatable extends SnotelLocation {
    id: string;
}

export interface SnotelStation extends SnotelStationLocatable {
    name: string;
    elevation: number;
    offset: number;
}

export type SnotelNearbyStation = SnotelStation & { distance: number };
export type SnotelDuration = 'DAILY' | 'HOURLY';
export type SnotelElementCode = 'SNWD' | 'WTEQ';

export interface SnotelReading {
    date: string;
    time: number;
    value: number | null;
    qc: string;
    qa: string;
}

export interface SnotelSeriesMap {
    SNWD: SnotelReading[];
    WTEQ: SnotelReading[];
}

function invalid(): never {
    throw Object.assign(new Error('NRCS returned invalid snow observations.'), { code: 'invalid-response' as const });
}

const triplet = (value: unknown): value is string => typeof value === 'string' && /^\d{1,8}:[A-Z]{2}:SNTL$/.test(value);
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validateSnotelStations(body: unknown): SnotelStation[] {
    // This is the whole active network, not a proximity query. An empty global
    // catalog is a service failure, never evidence of no stations near a peak.
    if (!Array.isArray(body) || body.length < 1 || body.length > 3000) invalid();
    const seen = new Set<string>();
    return (body as unknown[]).map(raw => {
        if (!raw || typeof raw !== 'object') invalid();
        const station = raw as Record<string, unknown>;
        if (!triplet(station.stationTriplet) || seen.has(station.stationTriplet)
            || typeof station.name !== 'string' || !station.name.trim() || station.name.length > 120
            || typeof station.latitude !== 'number' || !Number.isFinite(station.latitude) || Math.abs(station.latitude) > 90
            || typeof station.longitude !== 'number' || !Number.isFinite(station.longitude) || Math.abs(station.longitude) > 180
            || typeof station.elevation !== 'number' || !Number.isFinite(station.elevation) || station.elevation < -2000 || station.elevation > 20000
            || typeof station.dataTimeZone !== 'number' || !Number.isFinite(station.dataTimeZone) || station.dataTimeZone < -12 || station.dataTimeZone > 14) invalid();
        seen.add(station.stationTriplet);
        return { id: station.stationTriplet, name: station.name.trim(), latitude: station.latitude, longitude: station.longitude,
            elevation: station.elevation / units.FEET_PER_METER, offset: station.dataTimeZone };
    });
}

export function nearbySnotelStations<T extends SnotelStationLocatable>(
    stations: readonly T[],
    subject: SnotelLocation | null | undefined,
    limit = 3,
): (T & { distance: number })[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid snow station limit.');
    if (!subject || typeof subject.latitude !== 'number' || !Number.isFinite(subject.latitude) || Math.abs(subject.latitude) > 90
        || typeof subject.longitude !== 'number' || !Number.isFinite(subject.longitude) || Math.abs(subject.longitude) > 180) throw new Error('Invalid snow location.');
    const rad = (value: number): number => value * Math.PI / 180;
    return stations.map(station => {
        const a = Math.sin(rad(station.latitude - subject.latitude) / 2) ** 2
            + Math.cos(rad(subject.latitude)) * Math.cos(rad(station.latitude)) * Math.sin(rad(station.longitude - subject.longitude) / 2) ** 2;
        return { ...station, distance: 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) };
    }).filter(station => station.distance <= SNOTEL_RADIUS_METERS)
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, limit);
}

// AWDB timestamps have no zone suffix. Use the station's fixed data offset,
// never the browser timezone or a daylight-saving timezone inferred from GPS.
export function snotelTimestamp(value: unknown, offset: number): number {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) || !day(value.slice(0, 10))) invalid();
    const [hour, minute] = value.slice(11).split(':').map(Number);
    if (hour > 23 || minute > 59 || typeof offset !== 'number' || !Number.isFinite(offset) || offset < -12 || offset > 14) invalid();
    return Date.parse(`${value.replace(' ', 'T')}:00Z`) - offset * 3600_000;
}

export function validateSnotelData(
    body: unknown,
    station: { id: string; offset: number },
    duration: SnotelDuration,
    now: number,
): SnotelSeriesMap {
    if (!['DAILY', 'HOURLY'].includes(duration) || !triplet(station.id) || typeof now !== 'number' || !Number.isFinite(now)
        || !Array.isArray(body) || body.length !== 1) invalid();
    const entry = (body as unknown[])[0];
    if (!entry || typeof entry !== 'object') invalid();
    const record = entry as Record<string, unknown>;
    if (record.stationTriplet !== station.id || !Array.isArray(record.data) || record.data.length > 2) invalid();
    const result: SnotelSeriesMap = { SNWD: [], WTEQ: [] }, seen = new Set<SnotelElementCode>();
    for (const rawSeries of record.data as unknown[]) {
        if (!rawSeries || typeof rawSeries !== 'object') invalid();
        const series = rawSeries as Record<string, unknown>;
        const rawElement = series.stationElement;
        if (!rawElement || typeof rawElement !== 'object') invalid();
        const element = rawElement as Record<string, unknown>;
        const rawCode = element.elementCode;
        if ((rawCode !== 'SNWD' && rawCode !== 'WTEQ') || seen.has(rawCode) || element.ordinal !== 1 || element.heightDepth != null
            || element.durationName !== duration || element.storedUnitCode !== 'in') invalid();
        const code: SnotelElementCode = rawCode;
        seen.add(code);
        // A sensor can lack this duration; do not discard the other sensor.
        if (series.error) continue;
        if (!Array.isArray(series.values) || series.values.length > (duration === 'HOURLY' ? 49 : 8)) invalid();
        let previous = -Infinity;
        for (const rawReading of series.values as unknown[]) {
            if (!rawReading || typeof rawReading !== 'object') invalid();
            const reading = rawReading as Record<string, unknown>;
            const date = reading.date;
            if (typeof date !== 'string') invalid();
            const time = duration === 'HOURLY' ? snotelTimestamp(date, station.offset)
                : day(date) ? Date.parse(`${date}T00:00:00Z`) : invalid();
            const oldest = now - (duration === 'HOURLY' ? 50 * 3600_000 : 9 * 86400_000);
            if (time <= previous || time < oldest || time > now + (duration === 'DAILY' ? 86400_000 : 3600_000)) invalid();
            previous = time;
            const value = reading.value;
            if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (code === 'SNWD' ? 1500 : 500))) invalid();
            for (const flag of ['qcFlag', 'qaFlag'] as const) {
                const flagValue = reading[flag];
                if (flagValue != null && (typeof flagValue !== 'string' || flagValue.length > 10)) invalid();
            }
            result[code].push({ date, time, value: value == null ? null : value * 25.4,
                qc: typeof reading.qcFlag === 'string' ? reading.qcFlag : '',
                qa: typeof reading.qaFlag === 'string' ? reading.qaFlag : '' });
        }
    }
    return result;
}

export function latestSnotelReading(series: readonly SnotelReading[]): SnotelReading | null {
    return series.findLast(reading => reading.value !== null) || null;
}

export function snotelReportUrl(station: { id: string }): string {
    if (!triplet(station.id)) throw new Error('Invalid snow station.');
    return `https://wcc.sc.egov.usda.gov/reportGenerator/view/customSingleStationReport/daily/${encodeURIComponent(station.id)}/-7,0/SNWD::value,WTEQ::value`;
}
