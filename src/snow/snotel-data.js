// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { units } from '../ui/units.js';

export const SNOTEL_RADIUS_METERS = 50_000;
const invalid = () => { throw Object.assign(new Error('NRCS returned invalid snow observations.'), { code: 'invalid-response' }); };
const triplet = value => typeof value === 'string' && /^\d{1,8}:[A-Z]{2}:SNTL$/.test(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validateSnotelStations(body) {
    // This is the whole active network, not a proximity query. An empty global
    // catalog is a service failure, never evidence of no stations near a peak.
    if (!Array.isArray(body) || body.length < 1 || body.length > 3000) invalid();
    const seen = new Set();
    return body.map(station => {
        if (!station || !triplet(station.stationTriplet) || seen.has(station.stationTriplet)
            || typeof station.name !== 'string' || !station.name.trim() || station.name.length > 120
            || !Number.isFinite(station.latitude) || Math.abs(station.latitude) > 90
            || !Number.isFinite(station.longitude) || Math.abs(station.longitude) > 180
            || !Number.isFinite(station.elevation) || station.elevation < -2000 || station.elevation > 20000
            || !Number.isFinite(station.dataTimeZone) || station.dataTimeZone < -12 || station.dataTimeZone > 14) invalid();
        seen.add(station.stationTriplet);
        return { id: station.stationTriplet, name: station.name.trim(), latitude: station.latitude, longitude: station.longitude,
            elevation: station.elevation / units.FEET_PER_METER, offset: station.dataTimeZone };
    });
}

export function nearbySnotelStations(stations, subject, limit = 3) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid snow station limit.');
    if (!Number.isFinite(subject?.latitude) || Math.abs(subject.latitude) > 90
        || !Number.isFinite(subject?.longitude) || Math.abs(subject.longitude) > 180) throw new Error('Invalid snow location.');
    const rad = value => value * Math.PI / 180;
    return stations.map(station => {
        const a = Math.sin(rad(station.latitude - subject.latitude) / 2) ** 2
            + Math.cos(rad(subject.latitude)) * Math.cos(rad(station.latitude)) * Math.sin(rad(station.longitude - subject.longitude) / 2) ** 2;
        return { ...station, distance: 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) };
    }).filter(station => station.distance <= SNOTEL_RADIUS_METERS)
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, limit);
}

// AWDB timestamps have no zone suffix. Use the station's fixed data offset,
// never the browser timezone or a daylight-saving timezone inferred from GPS.
export function snotelTimestamp(value, offset) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) || !day(value.slice(0, 10))) invalid();
    const [hour, minute] = value.slice(11).split(':').map(Number);
    if (hour > 23 || minute > 59 || !Number.isFinite(offset) || offset < -12 || offset > 14) invalid();
    return Date.parse(`${value.replace(' ', 'T')}:00Z`) - offset * 3600_000;
}

export function validateSnotelData(body, station, duration, now) {
    if (!['DAILY', 'HOURLY'].includes(duration) || !triplet(station.id) || !Number.isFinite(now)
        || !Array.isArray(body) || body.length !== 1 || body[0]?.stationTriplet !== station.id
        || !Array.isArray(body[0].data) || body[0].data.length > 2) invalid();
    const result = { SNWD: [], WTEQ: [] }, seen = new Set();
    for (const series of body[0].data) {
        const element = series?.stationElement, code = element?.elementCode;
        if (!Object.hasOwn(result, code) || seen.has(code) || element.ordinal !== 1 || element.heightDepth != null
            || element.durationName !== duration || element.storedUnitCode !== 'in') invalid();
        seen.add(code);
        // A sensor can lack this duration; do not discard the other sensor.
        if (series.error) continue;
        if (!Array.isArray(series.values) || series.values.length > (duration === 'HOURLY' ? 49 : 8)) invalid();
        let previous = -Infinity;
        for (const reading of series.values) {
            if (!reading || typeof reading !== 'object') invalid();
            const time = duration === 'HOURLY' ? snotelTimestamp(reading.date, station.offset)
                : day(reading.date) ? Date.parse(`${reading.date}T00:00:00Z`) : invalid();
            const oldest = now - (duration === 'HOURLY' ? 50 * 3600_000 : 9 * 86400_000);
            if (time <= previous || time < oldest || time > now + (duration === 'DAILY' ? 86400_000 : 3600_000)) invalid();
            previous = time;
            const value = reading.value;
            if (value != null && (!Number.isFinite(value) || value < 0 || value > (code === 'SNWD' ? 1500 : 500))) invalid();
            for (const flag of ['qcFlag', 'qaFlag']) if (reading[flag] != null && (typeof reading[flag] !== 'string' || reading[flag].length > 10)) invalid();
            result[code].push({ date: reading.date, time, value: value == null ? null : value * 25.4,
                qc: reading.qcFlag || '', qa: reading.qaFlag || '' });
        }
    }
    return result;
}

export function latestSnotelReading(series) {
    return series.findLast(reading => reading.value !== null) || null;
}

export function snotelReportUrl(station) {
    if (!triplet(station.id)) throw new Error('Invalid snow station.');
    return `https://wcc.sc.egov.usda.gov/reportGenerator/view/customSingleStationReport/daily/${encodeURIComponent(station.id)}/-7,0/SNWD::value,WTEQ::value`;
}
