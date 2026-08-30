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
const MOON_SEARCH_DAY_OFFSETS = Object.freeze([-2, -1, 0, 1, 2]);
const EMPTY_MOON_INTERVALS = Object.freeze([]);

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

const unavailableSolarEvents = () => ({
    solarNoonMs: null,
    solarNoonAzimuthDeg: null,
    sunriseMs: null,
    sunriseAzimuthDeg: null,
    sunriseDate: null,
    sunriseDayRelation: null,
    sunsetMs: null,
    sunsetAzimuthDeg: null,
    sunsetDate: null,
    sunsetDayRelation: null,
    daylightState: 'unavailable',
});

const unavailableMoonEvents = () => ({
    moonriseMs: null,
    moonriseAzimuthDeg: null,
    moonriseDate: null,
    moonriseDayRelation: null,
    moonVisibleMidpointMs: null,
    moonVisibleMidpointAzimuthDeg: null,
    moonsetMs: null,
    moonsetAzimuthDeg: null,
    moonsetDate: null,
    moonsetDayRelation: null,
    moonVisibilityIntervals: EMPTY_MOON_INTERVALS,
    moonVisibilityIntervalIndex: null,
    moonVisibilitySelection: 'unavailable',
    moonVisibilityState: 'unavailable',
});

const unavailableEvents = () => Object.freeze({
    ...unavailableSolarEvents(),
    ...unavailableMoonEvents(),
});

function eventAzimuth(sunCalc, ms, lat, lon) {
    if (!Number.isFinite(ms) || typeof sunCalc?.getPosition !== 'function') return null;
    try {
        const azimuth = sunCalc.getPosition(new Date(ms), lat, lon)?.azimuth;
        return Number.isFinite(azimuth) ? normalizeDegrees(azimuth) : null;
    } catch {
        return null;
    }
}

function moonEventAzimuth(sunCalc, ms, lat, lon) {
    if (!Number.isFinite(ms) || typeof sunCalc?.getMoonPosition !== 'function') return null;
    try {
        const azimuth = sunCalc.getMoonPosition(new Date(ms), lat, lon)?.azimuth;
        return Number.isFinite(azimuth) ? normalizeDegrees(azimuth) : null;
    } catch {
        return null;
    }
}

function shiftedCivilDate(date, days) {
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

const selectedMoonInterval = (events, interval, index, selection) => ({
    moonriseMs: interval.riseMs,
    moonriseAzimuthDeg: interval.riseAzimuthDeg,
    moonriseDate: interval.riseDate,
    moonriseDayRelation: interval.riseDayRelation,
    moonVisibleMidpointMs: interval.midpointMs,
    moonVisibleMidpointAzimuthDeg: interval.midpointAzimuthDeg,
    moonsetMs: interval.setMs,
    moonsetAzimuthDeg: interval.setAzimuthDeg,
    moonsetDate: interval.setDate,
    moonsetDayRelation: interval.setDayRelation,
    moonVisibilityIntervals: events.moonVisibilityIntervals,
    moonVisibilityIntervalIndex: index,
    moonVisibilitySelection: selection,
    moonVisibilityState: events.moonVisibilityState,
});

export function selectMoonVisibility(events, ms) {
    const state = events?.moonVisibilityState;
    const intervals = Array.isArray(events?.moonVisibilityIntervals)
        ? events.moonVisibilityIntervals
        : EMPTY_MOON_INTERVALS;
    if (state !== 'ordinary' || !intervals.length || !Number.isFinite(ms)) {
        return {
            ...unavailableMoonEvents(),
            moonVisibilityIntervals: intervals,
            moonVisibilitySelection: state === 'always-up' ? 'active'
                : state === 'always-down' ? 'inactive' : 'unavailable',
            moonVisibilityState: state || 'unavailable',
        };
    }
    let index = intervals.findIndex(interval => ms >= interval.riseMs && ms <= interval.setMs);
    let selection = 'active';
    if (index < 0) {
        index = intervals.findIndex(interval => interval.riseMs > ms);
        if (index >= 0) selection = 'upcoming';
        else {
            index = intervals.length - 1;
            selection = 'previous';
        }
    }
    return selectedMoonInterval(events, intervals[index], index, selection);
}

function calculateMoonEvents({ lat, lon, date, zone, noonMs, sunCalc }) {
    if (typeof sunCalc?.getMoonTimes !== 'function'
        || typeof sunCalc?.getMoonPosition !== 'function') return unavailableMoonEvents();
    const dayStart = MountainTime.civilToInstant(zone, date, 0);
    const nextDate = shiftedCivilDate(date, 1);
    const dayEnd = nextDate ? MountainTime.civilToInstant(zone, nextDate, 0) : null;
    if (!dayStart || !dayEnd || dayEnd.ms <= dayStart.ms) return unavailableMoonEvents();
    const crossings = [];
    const seen = new Set();
    let selectedDayAlwaysUp = false;
    let selectedDayAlwaysDown = false;
    try {
        // SunCalc scans UTC calendar days. Query adjacent UTC days and pair the
        // crossings ourselves so mountain-local midnight cannot choose the wrong cycle.
        for (const dayOffset of MOON_SEARCH_DAY_OFFSETS) {
            const times = sunCalc.getMoonTimes(new Date(noonMs + dayOffset * DAY_MS), lat, lon);
            if (!times || typeof times !== 'object') continue;
            if (dayOffset === 0) {
                selectedDayAlwaysUp = times.alwaysUp === true;
                selectedDayAlwaysDown = times.alwaysDown === true;
            }
            for (const [type, value] of [['rise', times.rise], ['set', times.set]]) {
                const ms = value instanceof Date ? value.getTime() : Number.NaN;
                const key = `${type}:${ms}`;
                if (!Number.isFinite(ms) || seen.has(key)) continue;
                seen.add(key);
                crossings.push(Object.freeze({ type, ms }));
            }
        }
    } catch {
        return unavailableMoonEvents();
    }

    crossings.sort((a, b) => a.ms - b.ms || a.type.localeCompare(b.type));
    const candidates = [];
    let riseMs = null;
    for (const crossing of crossings) {
        if (crossing.type === 'rise') {
            riseMs = crossing.ms;
            continue;
        }
        if (!Number.isFinite(riseMs) || crossing.ms <= riseMs) continue;
        const midpointMs = riseMs + (crossing.ms - riseMs) / 2;
        if (riseMs < dayEnd.ms && crossing.ms > dayStart.ms) {
            candidates.push(Object.freeze({ riseMs, midpointMs, setMs: crossing.ms }));
        }
        riseMs = null;
    }

    candidates.sort((a, b) => a.riseMs - b.riseMs);
    const intervals = [];
    for (const candidate of candidates) {
        const rise = dateRelation(new Date(candidate.riseMs), zone, date);
        const set = dateRelation(new Date(candidate.setMs), zone, date);
        const moonriseAzimuthDeg = moonEventAzimuth(sunCalc, candidate.riseMs, lat, lon);
        const moonVisibleMidpointAzimuthDeg = moonEventAzimuth(
            sunCalc, candidate.midpointMs, lat, lon,
        );
        const moonsetAzimuthDeg = moonEventAzimuth(sunCalc, candidate.setMs, lat, lon);
        if (!rise || !set) continue;
        intervals.push(Object.freeze({
            riseMs: rise.ms,
            riseAzimuthDeg: moonriseAzimuthDeg,
            riseDate: rise.date,
            riseDayRelation: rise.dayRelation,
            midpointMs: candidate.midpointMs,
            midpointAzimuthDeg: moonVisibleMidpointAzimuthDeg,
            setMs: set.ms,
            setAzimuthDeg: moonsetAzimuthDeg,
            setDate: set.date,
            setDayRelation: set.dayRelation,
        }));
    }
    if (intervals.length) return {
        ...unavailableMoonEvents(),
        moonVisibilityIntervals: Object.freeze(intervals),
        moonVisibilitySelection: 'unselected',
        moonVisibilityState: 'ordinary',
    };
    if (selectedDayAlwaysUp !== selectedDayAlwaysDown) return {
        ...unavailableMoonEvents(),
        moonVisibilitySelection: selectedDayAlwaysUp ? 'active' : 'inactive',
        moonVisibilityState: selectedDayAlwaysUp ? 'always-up' : 'always-down',
    };
    return unavailableMoonEvents();
}

export function calculateSunEvents({ lat, lon, date, zone, sunCalc = SunCalc }) {
    if (!validCoordinate(lat, lon) || !zone || typeof date !== 'string') return null;
    const noon = MountainTime.civilToInstant(zone, date, 12 * 60);
    if (!noon || noon.date !== date) return null;
    const moonEvents = calculateMoonEvents({ lat, lon, date, zone, noonMs: noon.ms, sunCalc });
    const withMoonEvents = solarEvents => Object.freeze({ ...solarEvents, ...moonEvents });
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
                return withMoonEvents({
                    solarNoonMs,
                    solarNoonAzimuthDeg: eventAzimuth(sunCalc, solarNoonMs, lat, lon),
                    sunriseMs: sunrise.ms,
                    sunriseAzimuthDeg: eventAzimuth(sunCalc, sunrise.ms, lat, lon),
                    sunriseDate: sunrise.date,
                    sunriseDayRelation: sunrise.dayRelation,
                    sunsetMs: sunset.ms,
                    sunsetAzimuthDeg: eventAzimuth(sunCalc, sunset.ms, lat, lon),
                    sunsetDate: sunset.date,
                    sunsetDayRelation: sunset.dayRelation,
                    daylightState: 'ordinary',
                });
            }
            if (times.alwaysUp === true || times.alwaysDown === true) {
                return withMoonEvents({
                    ...unavailableSolarEvents(),
                    solarNoonMs,
                    daylightState: times.alwaysUp ? 'polar-day' : 'polar-night',
                });
            }
            return withMoonEvents(unavailableSolarEvents());
        }
    } catch {
        return withMoonEvents(unavailableSolarEvents());
    }
    return withMoonEvents(unavailableSolarEvents());
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

    let moonPosition = null;
    try {
        const positionResult = sunCalc.getMoonPosition(new Date(ms), lat, lon);
        const moonAzimuthDeg = positionResult?.azimuth;
        const moonElevationDeg = positionResult?.altitude;
        if (Number.isFinite(moonAzimuthDeg) && Number.isFinite(moonElevationDeg)) {
            const normalizedMoonAzimuth = normalizeDegrees(moonAzimuthDeg);
            moonPosition = Object.freeze({
                moonAzimuthDeg: normalizedMoonAzimuth,
                moonDirectionLabel: directionLabel(normalizedMoonAzimuth),
                moonElevationDeg,
                moonIsAboveHorizon: moonElevationDeg >= 0,
                moonScreenAzimuthDeg: normalizeDegrees(normalizedMoonAzimuth - mapBearing),
            });
        }
    } catch {
        // Lunar position failure must not erase valid Sun or Moon-phase metadata.
    }

    let moonIllumination = null;
    try {
        const illumination = sunCalc.getMoonIllumination(new Date(ms));
        const fraction = illumination?.fraction;
        const phase = illumination?.phase;
        const phaseLabel = moonPhaseLabel(phase);
        if (Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && phaseLabel) {
            moonIllumination = Object.freeze({
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
        moonAzimuthDeg: moonPosition?.moonAzimuthDeg ?? null,
        moonDirectionLabel: moonPosition?.moonDirectionLabel ?? null,
        moonElevationDeg: moonPosition?.moonElevationDeg ?? null,
        moonIsAboveHorizon: moonPosition?.moonIsAboveHorizon ?? null,
        moonScreenAzimuthDeg: moonPosition?.moonScreenAzimuthDeg ?? null,
        moonIlluminationFraction: moonIllumination?.moonIlluminationFraction ?? null,
        moonPhase: moonIllumination?.moonPhase ?? null,
        moonPhaseIndex: moonIllumination?.moonPhaseIndex ?? null,
        moonPhaseLabel: moonIllumination?.moonPhaseLabel ?? null,
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
    return Object.freeze({ ...position, ...events, ...selectMoonVisibility(events, ms) });
}

export const sunPosition = Object.freeze({
    calculate: calculateSunPosition,
    calculateInstant: calculateSunInstant,
    calculateEvents: calculateSunEvents,
    normalizeDegrees,
    directionLabel,
    moonPhaseLabel,
    selectMoonVisibility,
});
