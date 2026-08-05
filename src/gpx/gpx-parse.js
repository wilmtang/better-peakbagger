// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure GPX-text parsing shared by the provider adapter (Garmin/Strava export)
// and the ascent-editor upload flow, so both entry points read a file with the
// same code. Raw GPX is parsed on the page it lives on; only the analysis
// fields returned here (segments, optional waypoint lat/lon/name, track name)
// may leave that page. No DOM beyond DOMParser and no extension APIs.

const directChild = (element, localName) => [...element.children]
    .find(child => child.localName === localName);

const elementsByLocalName = (root, localName) => {
    if (root.getElementsByTagNameNS) return [...root.getElementsByTagNameNS('*', localName)];
    return [...root.getElementsByTagName(localName)];
};

const cleanName = value => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, 200)
    : '';

const parseOptionalNumber = text => {
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
// chart. Accept the ISO-shaped forms GPX writers emit, then let Date.parse
// validate their calendar and offset semantics.
const GPX_TIME_PATTERN =
    /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

const parseOptionalTime = (text, hasElement = false) => {
    if (text === null) {
        return { value: null, state: 'missing' };
    }
    const normalized = String(text).trim();
    if (!normalized) {
        return { value: null, state: hasElement ? 'invalid' : 'missing' };
    }
    const value = GPX_TIME_PATTERN.test(normalized) ? Date.parse(normalized) : Number.NaN;
    return Number.isFinite(value)
        ? { value, state: 'valid' }
        : { value: null, state: 'invalid' };
};

const parseTrackPoint = (trackPoint, options = {}) => {
    const lat = parseOptionalNumber(trackPoint.getAttribute('lat'));
    const lon = parseOptionalNumber(trackPoint.getAttribute('lon'));
    const elevationElement = directChild(trackPoint, 'ele');
    const elevation = parseOptionalNumber(elevationElement?.textContent ?? null);
    const timeElement = directChild(trackPoint, 'time');
    const time = parseOptionalTime(timeElement?.textContent ?? null, !!timeElement);
    const parsed = {
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
};

const noGpsError = () => {
    const error = new Error('This activity has no recorded route to capture. Manually created activities need recorded track data before a GPX can be generated.');
    error.code = 'no-gps-data';
    return error;
};

const parseGpxData = (text, options = {}) => {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (elementsByLocalName(xml, 'parsererror').length) {
        const error = new Error('The GPX file contains invalid XML.');
        error.code = 'invalid-gpx';
        throw error;
    }
    const trackSegments = elementsByLocalName(xml, 'trkseg');
    const segments = trackSegments.map(segment =>
        elementsByLocalName(segment, 'trkpt').map(trackPoint => parseTrackPoint(trackPoint)));
    if (!segments.length || !segments.some(segment => segment.length)) throw noGpsError();
    const waypoints = options.retainWaypoints
        ? elementsByLocalName(xml, 'wpt').map(waypoint => {
            const latText = waypoint.getAttribute('lat');
            const lonText = waypoint.getAttribute('lon');
            return {
                lat: latText === null || !latText.trim() ? null : Number(latText),
                lon: lonText === null || !lonText.trim() ? null : Number(lonText),
                name: cleanName(directChild(waypoint, 'name')?.textContent || '')
            };
        })
        : [];
    const firstTrack = elementsByLocalName(xml, 'trk')[0];
    const trackName = options.includeTripName
        ? cleanName((firstTrack && directChild(firstTrack, 'name')?.textContent) || '')
        : '';
    return { segments, waypoints, trackName };
};

export const gpxParse = { parseGpxData, parseTrackPoint, cleanName, noGpsError };
