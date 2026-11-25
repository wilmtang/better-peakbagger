// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as SunCalc from 'suncalc';

import { mountainTime as MountainTime } from '../time/mountain-time.ts';
import type { MountainZone } from '../time/mountain-time.ts';

export type DayRelation = 'same-day' | 'previous-day' | 'next-day' | 'earlier-day' | 'later-day';
export type DaylightState = 'ordinary' | 'polar-day' | 'polar-night' | 'unavailable';
export type MoonVisibilityState = 'ordinary' | 'always-up' | 'always-down' | 'unavailable';
export type MoonVisibilitySelection =
    | 'active'
    | 'upcoming'
    | 'previous'
    | 'unselected'
    | 'inactive'
    | 'unavailable';

export interface SunPositionReading {
    azimuth?: number | null;
    altitude?: number | null;
}

export interface SunTimesReading {
    solarNoon?: Date | null;
    sunrise?: Date | null;
    sunset?: Date | null;
    alwaysUp?: boolean;
    alwaysDown?: boolean;
}

export interface MoonIlluminationReading {
    fraction?: number | null;
    phase?: number | null;
}

export interface MoonTimesReading {
    rise?: Date | null;
    set?: Date | null;
    alwaysUp?: boolean;
    alwaysDown?: boolean;
}

export interface SunCalcProvider {
    getPosition?: (date: Date, lat: number, lng: number) => SunPositionReading | null | undefined;
    getTimes?: (date: Date, lat: number, lng: number, height?: number) => SunTimesReading | null | undefined;
    getMoonPosition?: (date: Date, lat: number, lng: number) => SunPositionReading | null | undefined;
    getMoonIllumination?: (date?: Date) => MoonIlluminationReading | null | undefined;
    getMoonTimes?: (date: Date, lat: number, lng: number) => MoonTimesReading | null | undefined;
}

export interface MoonVisibilityInterval {
    readonly riseMs: number;
    readonly riseAzimuthDeg: number | null;
    readonly riseDate: string;
    readonly riseDayRelation: DayRelation;
    readonly midpointMs: number;
    readonly midpointAzimuthDeg: number | null;
    readonly setMs: number;
    readonly setAzimuthDeg: number | null;
    readonly setDate: string;
    readonly setDayRelation: DayRelation;
}

export interface SolarEvents {
    readonly solarNoonMs: number | null;
    readonly solarNoonAzimuthDeg: number | null;
    readonly sunriseMs: number | null;
    readonly sunriseAzimuthDeg: number | null;
    readonly sunriseDate: string | null;
    readonly sunriseDayRelation: DayRelation | null;
    readonly sunsetMs: number | null;
    readonly sunsetAzimuthDeg: number | null;
    readonly sunsetDate: string | null;
    readonly sunsetDayRelation: DayRelation | null;
    readonly daylightState: DaylightState;
}

export interface MoonEvents {
    readonly moonriseMs: number | null;
    readonly moonriseAzimuthDeg: number | null;
    readonly moonriseDate: string | null;
    readonly moonriseDayRelation: DayRelation | null;
    readonly moonVisibleMidpointMs: number | null;
    readonly moonVisibleMidpointAzimuthDeg: number | null;
    readonly moonsetMs: number | null;
    readonly moonsetAzimuthDeg: number | null;
    readonly moonsetDate: string | null;
    readonly moonsetDayRelation: DayRelation | null;
    readonly moonVisibilityIntervals: readonly MoonVisibilityInterval[];
    readonly moonVisibilityIntervalIndex: number | null;
    readonly moonVisibilitySelection: MoonVisibilitySelection;
    readonly moonVisibilityState: MoonVisibilityState;
}

export interface SunEvents extends SolarEvents, MoonEvents {}

export interface SunInstantResult {
    readonly azimuthDeg: number;
    readonly directionLabel: string | null;
    readonly elevationDeg: number;
    readonly isAboveHorizon: boolean;
    readonly screenAzimuthDeg: number;
    readonly moonAzimuthDeg: number | null;
    readonly moonDirectionLabel: string | null;
    readonly moonElevationDeg: number | null;
    readonly moonIsAboveHorizon: boolean | null;
    readonly moonScreenAzimuthDeg: number | null;
    readonly moonIlluminationFraction: number | null;
    readonly moonPhase: number | null;
    readonly moonPhaseIndex: number | null;
    readonly moonPhaseLabel: string | null;
}

export interface SunPositionResult extends SunInstantResult, SunEvents {}

export interface CalculateSunEventsInput {
    lat: number;
    lon: number;
    date: string;
    zone: MountainZone | null | undefined;
    sunCalc?: SunCalcProvider;
}

export interface CalculateSunInstantInput {
    lat: number;
    lon: number;
    ms: number;
    mapBearing?: number;
    sunCalc?: SunCalcProvider;
}

export interface CalculateSunPositionInput extends CalculateSunEventsInput, CalculateSunInstantInput {}

const DIRECTIONS = Object.freeze([
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]);
const MOON_PHASES = Object.freeze([
    'New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
    'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent',
]);

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

export const normalizeDegrees = (value: number): number => ((value % 360) + 360) % 360;

export function directionLabel(azimuthDeg: number | null | undefined): string | null {
    if (!isFiniteNumber(azimuthDeg)) return null;
    return DIRECTIONS[Math.round(normalizeDegrees(azimuthDeg) / 22.5) % DIRECTIONS.length];
}

export function moonPhaseLabel(phase: number | null | undefined): string | null {
    if (!isFiniteNumber(phase) || phase < 0 || phase > 1) return null;
    return MOON_PHASES[Math.round(phase * MOON_PHASES.length) % MOON_PHASES.length];
}

const validCoordinate = (lat: unknown, lon: unknown): boolean =>
    isFiniteNumber(lat) && isFiniteNumber(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
const DAY_MS = 86_400_000;
const SEARCH_DAY_OFFSETS = Object.freeze([0, -1, 1, -2, 2]);
const MOON_SEARCH_DAY_OFFSETS = Object.freeze([-2, -1, 0, 1, 2]);
const EMPTY_MOON_INTERVALS: readonly MoonVisibilityInterval[] = Object.freeze([]);

function dateRelation(
    value: Date | null | undefined,
    zone: MountainZone,
    date: string,
): { readonly ms: number; readonly date: string; readonly dayRelation: DayRelation } | null {
    const ms = value instanceof Date ? value.getTime() : Number.NaN;
    if (!Number.isFinite(ms)) return null;
    const eventDate = MountainTime.localDate(zone, ms);
    if (!eventDate) return null;
    return Object.freeze({
        ms,
        date: eventDate,
        dayRelation: eventDate === date ? 'same-day' : eventDate === shiftedCivilDate(date, -1) ? 'previous-day'
            : eventDate === shiftedCivilDate(date, 1) ? 'next-day' : eventDate < date ? 'earlier-day' : 'later-day',
    });
}

const unavailableSolarEvents = (): SolarEvents => ({
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

const unavailableMoonEvents = (): MoonEvents => ({
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

const unavailableEvents = (): SunEvents => Object.freeze({
    ...unavailableSolarEvents(),
    ...unavailableMoonEvents(),
});

function eventAzimuth(sunCalc: SunCalcProvider, ms: number, lat: number, lon: number): number | null {
    if (!Number.isFinite(ms) || typeof sunCalc?.getPosition !== 'function') return null;
    try {
        const azimuth = sunCalc.getPosition(new Date(ms), lat, lon)?.azimuth;
        return isFiniteNumber(azimuth) ? normalizeDegrees(azimuth) : null;
    } catch {
        return null;
    }
}

function moonEventAzimuth(sunCalc: SunCalcProvider, ms: number, lat: number, lon: number): number | null {
    if (!Number.isFinite(ms) || typeof sunCalc?.getMoonPosition !== 'function') return null;
    try {
        const azimuth = sunCalc.getMoonPosition(new Date(ms), lat, lon)?.azimuth;
        return isFiniteNumber(azimuth) ? normalizeDegrees(azimuth) : null;
    } catch {
        return null;
    }
}

function shiftedCivilDate(date: string, days: number): string | null {
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

const selectedMoonInterval = (
    intervals: readonly MoonVisibilityInterval[],
    moonVisibilityState: MoonVisibilityState,
    interval: MoonVisibilityInterval,
    index: number,
    selection: MoonVisibilitySelection,
): MoonEvents => ({
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
    moonVisibilityIntervals: intervals,
    moonVisibilityIntervalIndex: index,
    moonVisibilitySelection: selection,
    moonVisibilityState,
});

export function selectMoonVisibility(
    events: Partial<MoonEvents> | null | undefined,
    ms: number | null | undefined,
): MoonEvents {
    const state = events?.moonVisibilityState;
    const intervals = Array.isArray(events?.moonVisibilityIntervals)
        ? events.moonVisibilityIntervals
        : EMPTY_MOON_INTERVALS;
    if (state !== 'ordinary' || !intervals.length || !isFiniteNumber(ms)) {
        return {
            ...unavailableMoonEvents(),
            moonVisibilityIntervals: intervals,
            moonVisibilitySelection: state === 'always-up' ? 'active'
                : state === 'always-down' ? 'inactive' : 'unavailable',
            moonVisibilityState: state || 'unavailable',
        };
    }
    let index = intervals.findIndex(interval => ms >= interval.riseMs && ms <= interval.setMs);
    let selection: MoonVisibilitySelection = 'active';
    if (index < 0) {
        index = intervals.findIndex(interval => interval.riseMs > ms);
        if (index >= 0) selection = 'upcoming';
        else {
            index = intervals.length - 1;
            selection = 'previous';
        }
    }
    return selectedMoonInterval(intervals, state, intervals[index], index, selection);
}

function calculateMoonEvents({ lat, lon, date, zone, noonMs, sunCalc }: {
    lat: number;
    lon: number;
    date: string;
    zone: MountainZone;
    noonMs: number;
    sunCalc: SunCalcProvider;
}): MoonEvents {
    if (typeof sunCalc?.getMoonTimes !== 'function'
        || typeof sunCalc?.getMoonPosition !== 'function') return unavailableMoonEvents();
    const dayStart = MountainTime.civilToInstant(zone, date, 0);
    const nextDate = shiftedCivilDate(date, 1);
    const dayEnd = nextDate ? MountainTime.civilToInstant(zone, nextDate, 0) : null;
    if (!dayStart || !dayEnd || dayEnd.ms <= dayStart.ms) return unavailableMoonEvents();
    const crossings: { readonly type: 'rise' | 'set'; readonly ms: number }[] = [];
    const seen = new Set<string>();
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
            for (const [type, value] of [['rise', times.rise], ['set', times.set]] as const) {
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
    const candidates: { readonly riseMs: number; readonly midpointMs: number; readonly setMs: number }[] = [];
    let riseMs: number | null = null;
    for (const crossing of crossings) {
        if (crossing.type === 'rise') {
            riseMs = crossing.ms;
            continue;
        }
        if (!isFiniteNumber(riseMs) || crossing.ms <= riseMs) continue;
        const midpointMs = riseMs + (crossing.ms - riseMs) / 2;
        if (riseMs < dayEnd.ms && crossing.ms > dayStart.ms) {
            candidates.push(Object.freeze({ riseMs, midpointMs, setMs: crossing.ms }));
        }
        riseMs = null;
    }

    if (candidates.some(interval => interval.riseMs <= dayStart.ms && interval.setMs >= dayEnd.ms)) return {
        ...unavailableMoonEvents(), moonVisibilitySelection: 'active', moonVisibilityState: 'always-up',
    };
    candidates.sort((a, b) => a.riseMs - b.riseMs);
    const intervals: MoonVisibilityInterval[] = [];
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

export function calculateSunEvents({
    lat,
    lon,
    date,
    zone,
    sunCalc = SunCalc,
}: CalculateSunEventsInput): SunEvents | null {
    if (!validCoordinate(lat, lon) || !zone || typeof date !== 'string') return null;
    const noon = MountainTime.civilToInstant(zone, date, 12 * 60);
    if (!noon || noon.date !== date) return null;
    const moonEvents = calculateMoonEvents({ lat, lon, date, zone, noonMs: noon.ms, sunCalc });
    const withMoonEvents = (solarEvents: SolarEvents): SunEvents =>
        Object.freeze({ ...solarEvents, ...moonEvents });
    try {
        if (typeof sunCalc?.getTimes !== 'function') return withMoonEvents(unavailableSolarEvents());
        const seenNoons = new Set<number>();
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
}: CalculateSunInstantInput): SunInstantResult | null {
    if (!validCoordinate(lat, lon) || !isFiniteNumber(ms) || !isFiniteNumber(mapBearing)) return null;
    let position: SunPositionReading | null | undefined;
    try {
        if (typeof sunCalc?.getPosition !== 'function') return null;
        position = sunCalc.getPosition(new Date(ms), lat, lon);
    } catch {
        return null;
    }
    const azimuthDeg = position?.azimuth;
    const elevationDeg = position?.altitude;
    if (!isFiniteNumber(azimuthDeg) || !isFiniteNumber(elevationDeg)) return null;

    let moonPosition: {
        readonly moonAzimuthDeg: number;
        readonly moonDirectionLabel: string | null;
        readonly moonElevationDeg: number;
        readonly moonIsAboveHorizon: boolean;
        readonly moonScreenAzimuthDeg: number;
    } | null = null;
    try {
        if (typeof sunCalc?.getMoonPosition === 'function') {
            const positionResult = sunCalc.getMoonPosition(new Date(ms), lat, lon);
            const moonAzimuthDeg = positionResult?.azimuth;
            const moonElevationDeg = positionResult?.altitude;
            if (isFiniteNumber(moonAzimuthDeg) && isFiniteNumber(moonElevationDeg)) {
                const normalizedMoonAzimuth = normalizeDegrees(moonAzimuthDeg);
                moonPosition = Object.freeze({
                    moonAzimuthDeg: normalizedMoonAzimuth,
                    moonDirectionLabel: directionLabel(normalizedMoonAzimuth),
                    moonElevationDeg,
                    moonIsAboveHorizon: moonElevationDeg >= 0,
                    moonScreenAzimuthDeg: normalizeDegrees(normalizedMoonAzimuth - mapBearing),
                });
            }
        }
    } catch {
        // Lunar position failure must not erase valid Sun or Moon-phase metadata.
    }

    let moonIllumination: {
        readonly moonIlluminationFraction: number;
        readonly moonPhase: number;
        readonly moonPhaseIndex: number;
        readonly moonPhaseLabel: string;
    } | null = null;
    try {
        if (typeof sunCalc?.getMoonIllumination === 'function') {
            const illumination = sunCalc.getMoonIllumination(new Date(ms));
            const fraction = illumination?.fraction;
            const phase = illumination?.phase;
            const phaseLabel = moonPhaseLabel(phase);
            if (isFiniteNumber(fraction) && fraction >= 0 && fraction <= 1
                && isFiniteNumber(phase) && phaseLabel) {
                moonIllumination = Object.freeze({
                    moonIlluminationFraction: fraction,
                    moonPhase: phase,
                    moonPhaseIndex: Math.round(phase * MOON_PHASES.length) % MOON_PHASES.length,
                    moonPhaseLabel: phaseLabel,
                });
            }
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

export function calculateSunPosition({
    lat,
    lon,
    ms,
    date,
    zone,
    mapBearing = 0,
    sunCalc = SunCalc,
}: CalculateSunPositionInput): SunPositionResult | null {
    if (!validCoordinate(lat, lon) || !isFiniteNumber(ms) || !zone
        || typeof date !== 'string' || !isFiniteNumber(mapBearing)) return null;
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
