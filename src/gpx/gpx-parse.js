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

    const noGpsError = () => {
        const error = new Error('This activity has no recorded route to capture. Manually created activities need recorded track data before a GPX can be generated.');
        error.code = 'no-gps-data';
        return error;
    };

    const parseGpxData = (text, options = {}) => {
        const xml = new DOMParser().parseFromString(text, 'application/xml');
        if (elementsByLocalName(xml, 'parsererror').length) throw new Error('The provider returned invalid GPX XML.');
        const trackSegments = elementsByLocalName(xml, 'trkseg');
        const segments = trackSegments.map(segment => elementsByLocalName(segment, 'trkpt').map(trackPoint => {
            const latText = trackPoint.getAttribute('lat');
            const lonText = trackPoint.getAttribute('lon');
            const elevationText = directChild(trackPoint, 'ele')?.textContent?.trim() || '';
            const timeElement = directChild(trackPoint, 'time');
            const timeText = timeElement?.textContent?.trim() || '';
            const parsedTime = timeText ? Date.parse(timeText) : NaN;
            return {
                lat: latText === null || !latText.trim() ? null : Number(latText),
                lon: lonText === null || !lonText.trim() ? null : Number(lonText),
                ele: elevationText === '' ? null : Number(elevationText),
                time: Number.isFinite(parsedTime) ? parsedTime : null,
                invalidTime: !!timeElement && !Number.isFinite(parsedTime)
            };
        }));
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

    export const gpxParse = { parseGpxData, cleanName, noGpsError };
