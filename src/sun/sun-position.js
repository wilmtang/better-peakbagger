// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as SunCalc from 'suncalc';

import { mountainTime as MountainTime } from '../time/mountain-time.js';

const DIRECTIONS = Object.freeze([
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]);
const MOON_PHASES = Object.freeze([
    'New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
    'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent',
]);

export const normalizeDegrees = value => ((value % 360) + 360) % 360;

export function directionLabel(azimuthDeg) {
    if (!Number.isFinite(azimuthDeg)) return null;
    return DIRECTIONS[Math.round(normalizeDegrees(azimuthDeg) / 22.5) % DIRECTIONS.length];
}

export function moonPhaseLabel(phase) {
    if (!Number.isFinite(phase) || phase < 0 || phase > 1) return null;
    return MOON_PHASES[Math.round(phase * MOON_PHASES.length) % MOON_PHASES.length];
}

const validCoordinate = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
const DAY_MS = 86_400_000;
const SEARCH_DAY_OFFSETS = Object.freeze([0, -1, 1, -2, 2]);

function dateRelation(value, zone, date) {
    const ms = value instanceof Date ? value.getTime() : Number.NaN;
    if (!Number.isFinite(ms)) return null;
    const eventDate = MountainTime.localDate(zone, ms);
    if (!eventDate) return null;
    return Object.freeze({
        ms,
        date: eventDate,
        dayRelation: eventDate === date ? 'same-day' : eventDate < date ? 'previous-day' : 'next-day',
    });
}

const unavailableEvents = () => Object.freeze({
    solarNoonMs: null,
    sunriseMs: null,
    sunriseDate: null,
    sunriseDayRelation: null,
    sunsetMs: null,
    sunsetDate: null,
    sunsetDayRelation: null,
    daylightState: 'unavailable',
});

export function calculateSunEvents({ lat, lon, date, zone, sunCalc = SunCalc }) {
    if (!validCoordinate(lat, lon) || !zone || typeof date !== 'string') return null;
    const noon = MountainTime.civilToInstant(zone, date, 12 * 60);
    if (!noon || noon.date !== date) return null;
    try {
        const seenNoons = new Set();
        for (const dayOffset of SEARCH_DAY_OFFSETS) {
            const times = sunCalc.getTimes(new Date(noon.ms + dayOffset * DAY_MS), lat, lon, 0);
            if (!times || typeof times !== 'object') continue;
            const solarNoonMs = times.solarNoon instanceof Date ? times.solarNoon.getTime() : Number.NaN;
            if (!Number.isFinite(solarNoonMs) || seenNoons.has(solarNoonMs)) continue;
            seenNoons.add(solarNoonMs);
            if (MountainTime.localDate(zone, solarNoonMs) !== date) continue;

            const sunrise = dateRelation(times.sunrise, zone, date);
            const sunset = dateRelation(times.sunset, zone, date);
            if (sunrise && sunset) {
                return Object.freeze({
                    solarNoonMs,
                    sunriseMs: sunrise.ms,
                    sunriseDate: sunrise.date,
                    sunriseDayRelation: sunrise.dayRelation,
                    sunsetMs: sunset.ms,
                    sunsetDate: sunset.date,
                    sunsetDayRelation: sunset.dayRelation,
                    daylightState: 'ordinary',
                });
            }
            if (times.alwaysUp === true || times.alwaysDown === true) {
                return Object.freeze({
                    ...unavailableEvents(),
                    solarNoonMs,
                    daylightState: times.alwaysUp ? 'polar-day' : 'polar-night',
                });
            }
            return unavailableEvents();
        }
    } catch {
        return unavailableEvents();
    }
    return unavailableEvents();
}

export function calculateSunInstant({
    lat,
    lon,
    ms,
    mapBearing = 0,
    sunCalc = SunCalc,
}) {
    if (!validCoordinate(lat, lon) || !Number.isFinite(ms) || !Number.isFinite(mapBearing)) return null;
    let position;
    try {
        position = sunCalc.getPosition(new Date(ms), lat, lon);
    } catch {
        return null;
    }
    const azimuthDeg = position?.azimuth;
    const elevationDeg = position?.altitude;
    if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg)) return null;

    let moon = null;
    try {
        const illumination = sunCalc.getMoonIllumination(new Date(ms));
        const fraction = illumination?.fraction;
        const phase = illumination?.phase;
        const phaseLabel = moonPhaseLabel(phase);
        if (Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && phaseLabel) {
            moon = Object.freeze({
                moonIlluminationFraction: fraction,
                moonPhase: phase,
                moonPhaseIndex: Math.round(phase * MOON_PHASES.length) % MOON_PHASES.length,
                moonPhaseLabel: phaseLabel,
            });
        }
    } catch {
        // Lunar metadata failure must not erase an otherwise valid Sun position.
    }

    const normalizedAzimuth = normalizeDegrees(azimuthDeg);
    return Object.freeze({
        azimuthDeg: normalizedAzimuth,
        directionLabel: directionLabel(normalizedAzimuth),
        elevationDeg,
        isAboveHorizon: elevationDeg >= 0,
        screenAzimuthDeg: normalizeDegrees(normalizedAzimuth - mapBearing),
        moonIlluminationFraction: moon?.moonIlluminationFraction ?? null,
        moonPhase: moon?.moonPhase ?? null,
        moonPhaseIndex: moon?.moonPhaseIndex ?? null,
        moonPhaseLabel: moon?.moonPhaseLabel ?? null,
    });
}

export function calculateSunPosition({ lat, lon, ms, date, zone, mapBearing = 0, sunCalc = SunCalc }) {
    if (!validCoordinate(lat, lon) || !Number.isFinite(ms) || !zone
        || typeof date !== 'string' || !Number.isFinite(mapBearing)) return null;
    // Validate the requested civil date before returning an instantaneous result.
    // Daily-event failure is metadata failure and must not erase a finite position.
    const noon = MountainTime.civilToInstant(zone, date, 12 * 60);
    if (!noon || noon.date !== date) return null;
    const position = calculateSunInstant({ lat, lon, ms, mapBearing, sunCalc });
    if (!position) return null;
    const events = calculateSunEvents({ lat, lon, date, zone, sunCalc }) || unavailableEvents();
    return Object.freeze({ ...position, ...events });
}

export const sunPosition = Object.freeze({
    calculate: calculateSunPosition,
    calculateInstant: calculateSunInstant,
    calculateEvents: calculateSunEvents,
    normalizeDegrees,
    directionLabel,
    moonPhaseLabel,
});
