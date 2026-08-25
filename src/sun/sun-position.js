// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as SunCalc from 'suncalc';

import { mountainTime as MountainTime } from '../time/mountain-time.js';

const DIRECTIONS = Object.freeze([
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]);

export const normalizeDegrees = value => ((value % 360) + 360) % 360;

export function directionLabel(azimuthDeg) {
    if (!Number.isFinite(azimuthDeg)) return null;
    return DIRECTIONS[Math.round(normalizeDegrees(azimuthDeg) / 22.5) % DIRECTIONS.length];
}

const validCoordinate = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

function eventMs(value, zone, date) {
    const ms = value instanceof Date ? value.getTime() : Number.NaN;
    return Number.isFinite(ms) && MountainTime.localDate(zone, ms) === date ? ms : null;
}

export function calculateSunPosition({
    lat,
    lon,
    ms,
    date,
    zone,
    mapBearing = 0,
    sunCalc = SunCalc,
}) {
    if (!validCoordinate(lat, lon) || !Number.isFinite(ms) || !zone
        || typeof date !== 'string' || !Number.isFinite(mapBearing)) return null;
    try {
        const position = sunCalc.getPosition(new Date(ms), lat, lon);
        const azimuthDeg = position?.azimuth;
        const elevationDeg = position?.altitude;
        if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg)) return null;

        // Noon anchors SunCalc's solar-day lookup to the requested civil date.
        // DST gaps at noon are technically possible after political changes;
        // the shared conversion applies the same documented snap-forward rule.
        const noon = MountainTime.civilToInstant(zone, date, 12 * 60);
        if (!noon) return null;
        const times = sunCalc.getTimes(new Date(noon.ms), lat, lon, 0);
        if (!times || typeof times !== 'object') return null;
        const sunriseMs = eventMs(times.sunrise, zone, date);
        const sunsetMs = eventMs(times.sunset, zone, date);
        let daylightState = 'ordinary';
        if (sunriseMs === null || sunsetMs === null) {
            if (times.alwaysUp === true) daylightState = 'polar-day';
            else if (times.alwaysDown === true) daylightState = 'polar-night';
            else return null;
        }

        const normalizedAzimuth = normalizeDegrees(azimuthDeg);
        return Object.freeze({
            azimuthDeg: normalizedAzimuth,
            directionLabel: directionLabel(normalizedAzimuth),
            elevationDeg,
            isAboveHorizon: elevationDeg >= 0,
            screenAzimuthDeg: normalizeDegrees(normalizedAzimuth - mapBearing),
            sunriseMs,
            sunsetMs,
            daylightState,
        });
    } catch {
        return null;
    }
}

export const sunPosition = Object.freeze({
    calculate: calculateSunPosition,
    normalizeDegrees,
    directionLabel,
});
