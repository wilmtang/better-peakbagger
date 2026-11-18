// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime as MountainTime } from '../time/mountain-time.ts';
import type { MountainZone } from '../time/mountain-time.ts';
import { sunPosition as SunPosition } from './sun-position.ts';
import type { SunEvents, SunInstantResult } from './sun-position.ts';

export type SunStateMode = 'peak' | 'gpx';
export type SunAvailability = 'terminal' | 'recoverable' | 'prompt' | 'ready';

export interface SunCalculationInput {
    lat: number;
    lon: number;
    ms: number;
    date: string;
    zone: MountainZone;
    mapBearing: number;
}

export type SunResult = Readonly<SunInstantResult & Partial<SunEvents>>;

export interface SunStateInstant {
    readonly ms: number;
    readonly date: string | null;
    readonly minute: number | null;
    readonly adjusted: boolean;
    readonly ambiguous: boolean;
}

export interface SunStateSnapshot {
    readonly mode: SunStateMode | null;
    readonly subject: Readonly<{ lat: number; lon: number }> | null;
    readonly routeIdentity: string | number | null;
    readonly zone: MountainZone | null;
    readonly date: string | null;
    readonly minute: number | null;
    readonly dateSource: string | null;
    readonly timeSource: string | null;
    readonly mapBearing: number;
    readonly instant: SunStateInstant | null;
    readonly result: SunResult | null;
    readonly unavailable: string | null;
    readonly availability: SunAvailability;
}

export interface PeakSubjectInput {
    lat: number;
    lon: number;
    zone: MountainZone | null | undefined;
    nowMs?: number;
}

export interface RoutePointLike {
    lat?: number | null;
    lon?: number | null;
    ms?: number | null;
    timeState?: string | null;
    routeIdentity?: string | number | null;
    sourceIndex?: number | null;
    index?: number | null;
}

export interface CreateSunStateOptions {
    calculate?: ((input: SunCalculationInput) => SunResult | null) | null;
    calculateInstant?: (input: SunCalculationInput) => SunInstantResult | null;
    calculateEvents?: (input: SunCalculationInput) => Partial<SunEvents> | null;
}

export interface SunStateController {
    readonly get: () => SunStateSnapshot;
    readonly setPeakSubject: (input: PeakSubjectInput) => SunStateSnapshot;
    readonly setPeakDate: (date: string | null | undefined) => SunStateSnapshot;
    readonly setPreviewMinute: (minute: number | null | undefined) => SunStateSnapshot;
    readonly selectRoutePoint: (
        point: RoutePointLike | null | undefined,
        ascentDate: string | null | undefined,
        zone: MountainZone | null | undefined,
    ) => SunStateSnapshot;
    readonly setMapBearing: (bearing: number | null | undefined) => SunStateSnapshot;
    readonly resetSubject: () => SunStateSnapshot;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
const validCoordinate = (point: { lat?: unknown; lon?: unknown } | null | undefined): point is { lat: number; lon: number } =>
    Boolean(point && isFiniteNumber(point.lat) && isFiniteNumber(point.lon)
        && point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180);
const validMinute = (minute: unknown): minute is number =>
    typeof minute === 'number' && Number.isInteger(minute) && minute >= 0 && minute <= 1439;

function completeDate(value: unknown): string | null {
    if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1
        && candidate.getUTCDate() === day ? value : null;
}

const unavailableEvents: SunEvents = Object.freeze({
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
    moonVisibilityIntervals: Object.freeze([]),
    moonVisibilityIntervalIndex: null,
    moonVisibilitySelection: 'unavailable',
    moonVisibilityState: 'unavailable',
});

export function createSunState({
    calculate = null,
    calculateInstant = SunPosition.calculateInstant,
    calculateEvents = SunPosition.calculateEvents,
}: CreateSunStateOptions = {}): SunStateController {
    let eventCache: Readonly<{ key: string; events: Partial<SunEvents> }> | null = null;
    let state: SunStateSnapshot = Object.freeze({
        mode: null,
        subject: null,
        routeIdentity: null,
        zone: null,
        date: null,
        minute: null,
        dateSource: null,
        timeSource: null,
        mapBearing: 0,
        instant: null,
        result: null,
        unavailable: null,
        availability: 'terminal',
    });

    const replace = (patch: Partial<SunStateSnapshot>): SunStateSnapshot => {
        state = Object.freeze({ ...state, ...patch });
        return state;
    };
    const eventsFor = (input: SunCalculationInput): Partial<SunEvents> => {
        const key = [
            input.lat, input.lon, input.date,
            input.zone.timeZone || '', input.zone.offsetMs, Boolean(input.zone.estimated),
        ].join('|');
        if (eventCache?.key === key) return eventCache.events;
        const events = calculateEvents(input) || unavailableEvents;
        eventCache = Object.freeze({ key, events });
        return events;
    };
    const calculateResult = (input: SunCalculationInput): SunResult | null => {
        if (typeof calculate === 'function') return calculate(input);
        const position = calculateInstant(input);
        if (!position) return null;
        const events = eventsFor(input);
        return Object.freeze({
            ...position,
            ...events,
            ...SunPosition.selectMoonVisibility(events, input.ms),
        });
    };
    const recompute = (): SunStateSnapshot => {
        const date = completeDate(state.date);
        if (!validCoordinate(state.subject) || !state.zone || !date
            || !validMinute(state.minute)) {
            const recoverable = validCoordinate(state.subject) && Boolean(state.zone);
            return replace({
                instant: null,
                result: null,
                unavailable: recoverable
                    ? 'Sun position is unavailable for this date and time.'
                    : 'Sun position is unavailable.',
                availability: recoverable ? 'recoverable' : 'terminal',
            });
        }
        const instant = MountainTime.civilToInstant(state.zone, date, state.minute);
        if (!instant) return replace({
            instant: null,
            result: null,
            unavailable: 'Sun position is unavailable for this date and time.',
            availability: 'recoverable',
        });
        const result = calculateResult({
            lat: state.subject.lat,
            lon: state.subject.lon,
            ms: instant.ms,
            date: instant.date,
            zone: state.zone,
            mapBearing: state.mapBearing,
        });
        if (!result) return replace({
            instant,
            result: null,
            unavailable: 'Sun position is unavailable for this date and time.',
            availability: 'recoverable',
        });
        return replace({
            date: instant.date,
            minute: instant.minute,
            instant,
            result,
            unavailable: null,
            availability: 'ready',
        });
    };

    const setPeakSubject = ({ lat, lon, zone, nowMs = Date.now() }: PeakSubjectInput): SunStateSnapshot => {
        const subject = { lat, lon };
        const validSubject = validCoordinate(subject);
        const date = validSubject ? MountainTime.localDate(zone, nowMs) : null;
        const minute = validSubject ? MountainTime.localMinute(zone, nowMs) : null;
        replace({
            mode: 'peak',
            subject: validSubject ? Object.freeze(subject) : null,
            routeIdentity: null,
            zone: zone || null,
            date,
            minute,
            dateSource: 'Selected date',
            timeSource: 'Preview time',
            mapBearing: 0,
            unavailable: validSubject && date && validMinute(minute)
                ? null
                : 'Sun position is unavailable.',
            availability: validSubject && zone && date && validMinute(minute)
                ? 'ready'
                : 'terminal',
        });
        return recompute();
    };

    const setPeakDate = (date: string | null | undefined): SunStateSnapshot => {
        const validDate = completeDate(date);
        if (state.mode !== 'peak' || !validDate) return state;
        replace({ date: validDate, dateSource: 'Selected date' });
        return recompute();
    };

    const setPreviewMinute = (minute: number | null | undefined): SunStateSnapshot => {
        if (!validMinute(minute) || !state.subject || !state.date) return state;
        replace({ minute, timeSource: 'Preview time' });
        return recompute();
    };

    const selectRoutePoint = (
        point: RoutePointLike | null | undefined,
        ascentDate: string | null | undefined,
        zone: MountainZone | null | undefined,
    ): SunStateSnapshot => {
        const subject = validCoordinate(point) ? Object.freeze({ lat: point.lat, lon: point.lon }) : null;
        const routeIdentity = point?.routeIdentity ?? point?.sourceIndex ?? point?.index ?? null;
        if (!subject || !zone || !point) {
            return replace({
                mode: 'gpx', subject: null, routeIdentity, zone: zone || null,
                date: null, minute: null, dateSource: null, timeSource: null,
                instant: null, result: null, unavailable: 'No selected track point is available.',
                availability: 'terminal',
            });
        }

        const pointMs = point.ms;
        const recorded = point.timeState === 'valid' && isFiniteNumber(pointMs);
        if (recorded) {
            const date = MountainTime.localDate(zone, pointMs);
            const minute = MountainTime.localMinute(zone, pointMs);
            const result = date && validMinute(minute) ? calculateResult({
                lat: subject.lat,
                lon: subject.lon,
                ms: pointMs,
                date,
                zone,
                mapBearing: state.mapBearing,
            }) : null;
            replace({
                mode: 'gpx', subject, routeIdentity, zone, date, minute,
                dateSource: 'GPX point', timeSource: 'Recorded at selected GPX point',
                instant: Object.freeze({
                    ms: pointMs, date, minute, adjusted: false, ambiguous: false,
                }),
                result,
                unavailable: result ? null : 'Sun position is unavailable for this date and time.',
                availability: result ? 'ready' : 'recoverable',
            });
            return state;
        }

        const date = completeDate(ascentDate);
        if (!date) {
            return replace({
                mode: 'gpx', subject, routeIdentity, zone, date: null,
                minute: state.mode === 'gpx' && validMinute(state.minute) ? state.minute : 12 * 60,
                dateSource: null, timeSource: null, instant: null, result: null,
                unavailable: 'No track or ascent date is available.',
                availability: 'prompt',
            });
        }
        replace({
            mode: 'gpx', subject, routeIdentity, zone, date,
            minute: validMinute(state.minute) ? state.minute : 12 * 60,
            dateSource: 'Peakbagger ascent date', timeSource: 'Preview time', unavailable: null,
            availability: 'ready',
        });
        return recompute();
    };

    const setMapBearing = (bearing: number | null | undefined): SunStateSnapshot => {
        if (!isFiniteNumber(bearing)) return state;
        const mapBearing = SunPosition.normalizeDegrees(bearing);
        const result = state.result ? Object.freeze({
            ...state.result,
            screenAzimuthDeg: SunPosition.normalizeDegrees(state.result.azimuthDeg - mapBearing),
            moonScreenAzimuthDeg: isFiniteNumber(state.result.moonAzimuthDeg)
                ? SunPosition.normalizeDegrees(state.result.moonAzimuthDeg - mapBearing)
                : null,
        }) : null;
        return replace({ mapBearing, result });
    };

    const resetSubject = (): SunStateSnapshot => {
        eventCache = null;
        return replace({
            mode: null, subject: null, routeIdentity: null, zone: null, date: null, minute: null,
            dateSource: null, timeSource: null, mapBearing: 0, instant: null, result: null,
            unavailable: null, availability: 'terminal',
        });
    };

    return Object.freeze({
        get: () => state,
        setPeakSubject,
        setPeakDate,
        setPreviewMinute,
        selectRoutePoint,
        setMapBearing,
        resetSubject,
    });
}

export const sunState = Object.freeze({ create: createSunState });
