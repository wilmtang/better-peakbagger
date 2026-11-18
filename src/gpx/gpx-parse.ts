// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure GPX-text parsing shared by the provider adapter (Garmin/Strava export)
// and the ascent-editor upload flow, so both entry points read a file with the
// same code. Raw GPX is parsed on the page it lives on; only the analysis
// fields returned here (segments, optional waypoint lat/lon/name, track name)
// may leave that page. No DOM beyond DOMParser and no extension APIs.

import {
    MAX_GPX_TEXT_CHARS,
    MAX_GPX_TRACK_POINTS,
    MAX_GPX_TRACK_SEGMENTS,
    MAX_GPX_WAYPOINTS,
    gpxLimitMessage,
} from '../capture/capture-resource-limits.ts';

export type ParsedQualityState = 'valid' | 'missing' | 'invalid';

export type GpxParseErrorCode = 'no-gps-data' | 'gpx-too-large' | 'invalid-gpx';

export interface GpxParseError extends Error {
    code: GpxParseErrorCode;
}

export interface ParseTrackPointOptions {
    includeQuality?: boolean;
}

export interface ParseGpxOptions extends ParseTrackPointOptions {
    allowEmpty?: boolean;
    retainWaypoints?: boolean;
    includeTripName?: boolean;
}

export interface ParsedTrackPoint {
    lat: number | null;
    lon: number | null;
    ele: number | null;
    time: number | null;
    invalidTime: boolean;
    elevationState?: ParsedQualityState;
    timeState?: ParsedQualityState;
}

export interface ParsedQualityTrackPoint extends ParsedTrackPoint {
    elevationState: ParsedQualityState;
    timeState: ParsedQualityState;
}

export interface ParsedWaypoint {
    lat: number | null;
    lon: number | null;
    name: string;
}

export interface ParsedGpxData<TPoint extends ParsedTrackPoint = ParsedTrackPoint> {
    segments: TPoint[][];
    waypoints: ParsedWaypoint[];
    trackName: string;
}

interface ParsedOptionalNumber {
    value: number | null;
    state: ParsedQualityState;
}

interface ParsedOptionalTime {
    value: number | null;
    state: ParsedQualityState;
}

const directChild = (element: Element, localName: string): Element | undefined => [...element.children]
    .find(child => child.localName === localName);

const directChildren = (element: Element, localName: string): Element[] => [...element.children]
    .filter(child => child.localName === localName);

const elementsByLocalName = (root: Document | Element, localName: string): Element[] => {
    if (typeof root.getElementsByTagNameNS === 'function') return [...root.getElementsByTagNameNS('*', localName)];
    return [...root.getElementsByTagName(localName)];
};

const cleanName = (value: unknown): string => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, 200)
    : '';

const parseOptionalNumber = (text: string | null): ParsedOptionalNumber => {
    if (text === null || !String(text).trim()) {
        return { value: null, state: 'missing' };
    }
    const value = Number(String(text).trim());
    return Number.isFinite(value)
        ? { value, state: 'valid' }
        : { value: Number.NaN, state: 'invalid' };
};

// GPX 1.1 uses XML Schema dateTime. Date.parse also admits locale-like strings
// such as "July 10", which makes the ascent-page analyzer disagree with the
// stricter provider/upload path and can turn malformed input into a plausible
// chart. Accept the ISO-shaped forms GPX writers emit, validate their calendar
// fields explicitly, then let Date.parse produce the instant.
const GPX_TIME_PATTERN =
    /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

const validCalendarTime = (match: RegExpExecArray | null): boolean => {
    if (!match) return false;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    if (![year, month, day, hour, minute, second].every(Number.isSafeInteger)
        || month < 1 || month > 12 || day < 1 || minute > 59 || second > 59
        || hour > 24) return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > daysInMonth[month - 1]) return false;
    if (hour === 24 && (minute !== 0 || second !== 0 || /[1-9]/.test(match[7] || ''))) return false;
    if (match[8]) {
        const offsetHour = Number(match[9]);
        const offsetMinute = Number(match[10]);
        if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
    }
    return true;
};

const parseOptionalTime = (text: string | null, hasElement = false): ParsedOptionalTime => {
    if (text === null) {
        return { value: null, state: 'missing' };
    }
    const normalized = String(text).trim();
    if (!normalized) {
        return { value: null, state: hasElement ? 'invalid' : 'missing' };
    }
    const match = GPX_TIME_PATTERN.exec(normalized);
    const value = validCalendarTime(match) ? Date.parse(normalized) : Number.NaN;
    return Number.isFinite(value)
        ? { value, state: 'valid' }
        : { value: null, state: 'invalid' };
};

function parseTrackPoint(trackPoint: Element, options: ParseTrackPointOptions & { includeQuality: true }): ParsedQualityTrackPoint;
function parseTrackPoint(trackPoint: Element, options?: ParseTrackPointOptions): ParsedTrackPoint;
function parseTrackPoint(trackPoint: Element, options: ParseTrackPointOptions = {}): ParsedTrackPoint {
    const lat = parseOptionalNumber(trackPoint.getAttribute('lat'));
    const lon = parseOptionalNumber(trackPoint.getAttribute('lon'));
    const elevationElement = directChild(trackPoint, 'ele');
    const elevation = parseOptionalNumber(elevationElement?.textContent ?? null);
    const timeElement = directChild(trackPoint, 'time');
    const time = parseOptionalTime(timeElement?.textContent ?? null, !!timeElement);
    const parsed: ParsedTrackPoint = {
        lat: lat.value,
        lon: lon.value,
        ele: elevation.value,
        time: time.value,
        invalidTime: time.state === 'invalid'
    };
    if (options.includeQuality) {
        parsed.elevationState = elevation.state;
        parsed.timeState = time.state;
    }
    return parsed;
}

const noGpsError = (): GpxParseError => Object.assign(
    new Error('This activity has no recorded route to capture. Manually created activities need recorded track data before a GPX can be generated.'),
    { code: 'no-gps-data' as const },
);

const gpxLimitError = (): GpxParseError => Object.assign(new Error(gpxLimitMessage()), { code: 'gpx-too-large' as const });

const invalidGpxError = (message: string): GpxParseError => Object.assign(new Error(message), { code: 'invalid-gpx' as const });

const exceedsElementLimit = (text: string, localName: string, limit: number): boolean => {
    const element = new RegExp(`<\\s*(?:[\\w.-]+:)?${localName}(?=[\\s/>])`, 'gi');
    let count = 0;
    while (element.exec(text)) {
        count++;
        if (count > limit) return true;
    }
    return false;
};

// Fail closed before DOMParser materializes a certainly excessive document.
// This deliberately counts namespaced and nested lookalikes too: the later
// ownership-aware DOM walk may ignore nested extension geometry, but an input
// that already exceeds a safety ceiling before filtering is not worth building
// into a full page-realm DOM merely to discover that distinction.
const preflightGpxStructure = (text: string): void => {
    if (exceedsElementLimit(text, 'trkpt', MAX_GPX_TRACK_POINTS)
        || exceedsElementLimit(text, 'trkseg', MAX_GPX_TRACK_SEGMENTS)
        || exceedsElementLimit(text, 'wpt', MAX_GPX_WAYPOINTS)) {
        throw gpxLimitError();
    }
};

function parseGpxDocument(xml: Document, options: ParseGpxOptions & { includeQuality: true }): ParsedGpxData<ParsedQualityTrackPoint>;
function parseGpxDocument(xml: Document, options?: ParseGpxOptions): ParsedGpxData;
function parseGpxDocument(xml: Document, options: ParseGpxOptions = {}): ParsedGpxData {
    if (elementsByLocalName(xml, 'parsererror').length) {
        throw invalidGpxError('The GPX file contains invalid XML.');
    }
    const gpxRoot = xml.documentElement?.localName === 'gpx'
        ? xml.documentElement
        : null;
    if (!gpxRoot) {
        throw invalidGpxError('The document root is not GPX data.');
    }
    const tracks = gpxRoot ? directChildren(gpxRoot, 'trk') : [];
    const trackSegments = tracks.flatMap(track => directChildren(track, 'trkseg'));
    if (trackSegments.length > MAX_GPX_TRACK_SEGMENTS) throw gpxLimitError();
    let trackPointCount = 0;
    const segments = trackSegments.map(segment => {
        const points = directChildren(segment, 'trkpt');
        trackPointCount += points.length;
        if (trackPointCount > MAX_GPX_TRACK_POINTS) throw gpxLimitError();
        return points.map(trackPoint => parseTrackPoint(trackPoint, {
            includeQuality: !!options.includeQuality,
        }));
    });
    if ((!segments.length || !segments.some(segment => segment.length)) && !options.allowEmpty) {
        throw noGpsError();
    }
    const waypointElements = directChildren(gpxRoot, 'wpt');
    if (waypointElements.length > MAX_GPX_WAYPOINTS) throw gpxLimitError();
    const waypoints: ParsedWaypoint[] = options.retainWaypoints
        ? waypointElements.map(waypoint => {
            const latText = waypoint.getAttribute('lat');
            const lonText = waypoint.getAttribute('lon');
            return {
                lat: latText === null || !latText.trim() ? null : Number(latText),
                lon: lonText === null || !lonText.trim() ? null : Number(lonText),
                name: cleanName(directChild(waypoint, 'name')?.textContent || '')
            };
        })
        : [];
    const firstTrack = tracks[0];
    const trackName = options.includeTripName
        ? cleanName((firstTrack && directChild(firstTrack, 'name')?.textContent) || '')
        : '';
    return { segments, waypoints, trackName };
}

function parseGpxData(text: string, options: ParseGpxOptions & { includeQuality: true }): ParsedGpxData<ParsedQualityTrackPoint>;
function parseGpxData(text: string, options?: ParseGpxOptions): ParsedGpxData;
function parseGpxData(text: string, options: ParseGpxOptions = {}): ParsedGpxData {
    if (typeof text !== 'string' || text.length > MAX_GPX_TEXT_CHARS) throw gpxLimitError();
    preflightGpxStructure(text);
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    return parseGpxDocument(xml, options);
}

export const gpxParse = {
    parseGpxData,
    parseGpxDocument,
    parseTrackPoint,
    cleanName,
    noGpsError,
    preflightGpxStructure,
};
