// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime as MountainTime } from '../time/mountain-time.js';
import { sunPosition as SunPosition } from './sun-position.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validCoordinate = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180;
const validMinute = minute => Number.isInteger(minute) && minute >= 0 && minute <= 1439;

function completeDate(value) {
    if (!DATE_RE.test(value || '')) return null;
    const [year, month, day] = value.split('-').map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1
        && candidate.getUTCDate() === day ? value : null;
}

const unavailableEvents = Object.freeze({
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

export function createSunState({
    calculate = null,
    calculateInstant = SunPosition.calculateInstant,
    calculateEvents = SunPosition.calculateEvents,
} = {}) {
    let eventCache = null;
    let state = Object.freeze({
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

    const replace = patch => { state = Object.freeze({ ...state, ...patch }); return state; };
    const eventsFor = input => {
        const key = [
            input.lat, input.lon, input.date,
            input.zone.timeZone || '', input.zone.offsetMs, Boolean(input.zone.estimated),
        ].join('|');
        if (eventCache?.key === key) return eventCache.events;
        const events = calculateEvents(input) || unavailableEvents;
        eventCache = Object.freeze({ key, events });
        return events;
    };
    const calculateResult = input => {
        if (typeof calculate === 'function') return calculate(input);
        const position = calculateInstant(input);
        if (!position) return null;
        return Object.freeze({ ...position, ...eventsFor(input) });
    };
    const recompute = () => {
        if (!validCoordinate(state.subject) || !state.zone || !completeDate(state.date)
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
        const instant = MountainTime.civilToInstant(state.zone, state.date, state.minute);
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

    const setPeakSubject = ({ lat, lon, zone, nowMs = Date.now() }) => {
        const subject = { lat, lon };
        const date = validCoordinate(subject) ? MountainTime.localDate(zone, nowMs) : null;
        const minute = validCoordinate(subject) ? MountainTime.localMinute(zone, nowMs) : null;
        replace({
            mode: 'peak',
            subject: validCoordinate(subject) ? Object.freeze(subject) : null,
            routeIdentity: null,
            zone: zone || null,
            date,
            minute,
            dateSource: 'Selected date',
            timeSource: 'Preview time',
            mapBearing: 0,
            unavailable: validCoordinate(subject) && date && validMinute(minute)
                ? null
                : 'Sun position is unavailable.',
            availability: validCoordinate(subject) && zone && date && validMinute(minute)
                ? 'ready'
                : 'terminal',
        });
        return recompute();
    };

    const setPeakDate = date => {
        if (state.mode !== 'peak' || !completeDate(date)) return state;
        replace({ date, dateSource: 'Selected date' });
        return recompute();
    };

    const setPreviewMinute = minute => {
        if (!validMinute(minute) || !state.subject || !state.date) return state;
        replace({ minute, timeSource: 'Preview time' });
        return recompute();
    };

    const selectRoutePoint = (point, ascentDate, zone) => {
        const subject = validCoordinate(point) ? Object.freeze({ lat: point.lat, lon: point.lon }) : null;
        const routeIdentity = point?.routeIdentity ?? point?.sourceIndex ?? point?.index ?? null;
        if (!subject || !zone) {
            return replace({
                mode: 'gpx', subject: null, routeIdentity, zone: zone || null,
                date: null, minute: null, dateSource: null, timeSource: null,
                instant: null, result: null, unavailable: 'No selected track point is available.',
                availability: 'terminal',
            });
        }

        const recorded = point.timeState === 'valid' && Number.isFinite(point.ms);
        if (recorded) {
            const date = MountainTime.localDate(zone, point.ms);
            const minute = MountainTime.localMinute(zone, point.ms);
            const result = date && validMinute(minute) ? calculateResult({
                lat: subject.lat,
                lon: subject.lon,
                ms: point.ms,
                date,
                zone,
                mapBearing: state.mapBearing,
            }) : null;
            replace({
                mode: 'gpx', subject, routeIdentity, zone, date, minute,
                dateSource: 'GPX point', timeSource: 'Recorded at selected GPX point',
                instant: Object.freeze({
                    ms: point.ms, date, minute, adjusted: false, ambiguous: false,
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

    const setMapBearing = bearing => {
        if (!Number.isFinite(bearing)) return state;
        const mapBearing = SunPosition.normalizeDegrees(bearing);
        const result = state.result ? Object.freeze({
            ...state.result,
            screenAzimuthDeg: SunPosition.normalizeDegrees(state.result.azimuthDeg - mapBearing),
        }) : null;
        return replace({ mapBearing, result });
    };

    const resetSubject = () => {
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
