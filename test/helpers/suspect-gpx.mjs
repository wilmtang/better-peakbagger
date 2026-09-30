// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Synthetic relationships from ascent 1170663; no source coordinates retained.
export function suspectSegments() {
    const start = Date.UTC(2026, 5, 8, 11, 38);
    const route = Array.from({ length: 56 }, (_, i) => ({
        lat: 46 + i * 0.0005, lon: -120 + Math.sin(i / 10) * 0.002,
        ele: 1400 + Math.sin(i * Math.PI / 55) * 1100,
        time: start + i * (12 * 60 + 32) * 60_000 / 55,
        elevationState: 'valid', timeState: 'valid',
    }));
    return [
        [{ ...route[0], lat: 48, lon: -122, ele: 133, time: start - (55 * 60 + 56) * 60_000 }],
        route,
        route.map(point => ({ ...point, ele: 0, time: start })),
    ];
}

export const metricInputs = segments => segments.flatMap((segment, coordinateGroup) =>
    segment.map(point => ({
        lat: point.lat, lon: point.lon, rawEleM: point.ele, ms: point.time,
        elevationState: point.elevationState, timeState: point.timeState, coordinateGroup,
    })));

export const segmentsGpx = segments => `<gpx version="1.1"><trk>${segments.map(segment =>
    `<trkseg>${segment.map(point => `<trkpt lat="${point.lat}" lon="${point.lon}"><ele>${point.ele}</ele><time>${new Date(point.time).toISOString()}</time></trkpt>`).join('')}</trkseg>`).join('')}</trk></gpx>`;
