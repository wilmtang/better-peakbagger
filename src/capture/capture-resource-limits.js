// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One resource contract for the activity-capture transaction. These limits
// apply on both sides of the page/worker trust boundary: file/provider GPX
// readers, the pure parser, background validation, Peakbagger response reads,
// and the bounded corridor lookup.

export const MAX_GPX_BYTES = 16 * 1024 * 1024;
export const MAX_GPX_TEXT_CHARS = 16 * 1024 * 1024;
export const MAX_GPX_TRACK_POINTS = 20_000;
export const MAX_GPX_TRACK_SEGMENTS = 50;
export const MAX_GPX_WAYPOINTS = 3_000;

export const MAX_PEAKBAGGER_HTML_BYTES = 8 * 1024 * 1024;
export const MAX_PEAKBAGGER_GPX_BYTES = MAX_GPX_BYTES;
export const MAX_PEAKBAGGER_PEAKS_BYTES = 1024 * 1024;

export const MAX_CORRIDOR_BOXES = 64;
export const MAX_CORRIDOR_REQUESTS = MAX_CORRIDOR_BOXES * 2;
export const CORRIDOR_CONCURRENCY = 4;
export const CORRIDOR_TOTAL_TIMEOUT_MS = 60_000;

export const peakbaggerResponseLimit = kind => {
    if (kind === 'gpx') return MAX_PEAKBAGGER_GPX_BYTES;
    if (kind === 'peaks') return MAX_PEAKBAGGER_PEAKS_BYTES;
    return MAX_PEAKBAGGER_HTML_BYTES;
};

export const gpxLimitMessage = () =>
    'This GPX is too large to process safely. Keep it within 16 MiB, 20,000 track points, 50 track segments, and 3,000 waypoints.';

export const captureResourceLimits = {
    MAX_GPX_BYTES,
    MAX_GPX_TEXT_CHARS,
    MAX_GPX_TRACK_POINTS,
    MAX_GPX_TRACK_SEGMENTS,
    MAX_GPX_WAYPOINTS,
    MAX_PEAKBAGGER_HTML_BYTES,
    MAX_PEAKBAGGER_GPX_BYTES,
    MAX_PEAKBAGGER_PEAKS_BYTES,
    MAX_CORRIDOR_BOXES,
    MAX_CORRIDOR_REQUESTS,
    CORRIDOR_CONCURRENCY,
    CORRIDOR_TOTAL_TIMEOUT_MS,
    peakbaggerResponseLimit,
    gpxLimitMessage,
};
