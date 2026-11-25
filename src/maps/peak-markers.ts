// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — shared MAIN-world client for Peakbagger's own
// peak-marker feed, `/Async/PLLBB.aspx` (peaks by lat/lon bounding box). The
// native 2D map calls this endpoint on every pan/zoom settle and draws the
// green/pink/orange dot markers from it; this module lets the 3D terrain view
// make the *same* request with the same parameters, so 3D dots stay
// personalized (climbed state) and filtered (prominence cutoff) exactly like
// the 2D map, with no new origin and no request the native map would not make.
// Used by the ascent GPX analyzer, Full Screen BigMap, and Peak-page map.
//
// Native semantics mirrored here (from MasterMap.aspx):
//   GET ../Async/PLLBB.aspx?miny&maxy&minx&maxx&t=<mapType>[&pid=][&cid=]
//   -> <ts><t i="<peakId>" n="<name>" a="<lat>" o="<lon>" c="<0|1|2>" r="<prominence>"/></ts>
//   - only map types P/A/K/W/I/E/U/J/S load peak markers (group maps do not);
//   - markers only render at zoom >= 12 and are cleared below it;
//   - rows with prominence below the page's `hj` value are dropped client-side
//     (a missing/non-numeric prominence never passes, matching parseInt);
//   - c="1" is climbed (green), c="2" is unknown/anonymous (orange), anything
//     else is unclimbed (pink); peak ids can be negative (provisional peaks).

import { boundedText as BoundedText } from '../net/bounded-text.ts';
import { rateLimitError, cancelResponseBody, type RateLimitError } from '../net/rate-limit.ts';

export type PeakMarkerState = 'climbed' | 'unknown' | 'unclimbed';

export interface PeakMarker {
    id: number;
    name: string;
    lat: number;
    lon: number;
    state: PeakMarkerState;
}

export interface PeakMarkerContext {
    endpoint: string;
    mapType: string;
    pid: number | null;
    cid: number | null;
    hj: number;
}

export interface PeakMarkerBounds {
    miny: number;
    maxy: number;
    minx: number;
    maxx: number;
}

export interface PeakMarkerClient {
    context: PeakMarkerContext;
    request: (bounds: unknown) => Promise<PeakMarker[] | null>;
}

export interface TerrainResponderOptions {
    getIframeSrc: () => string | null | undefined;
    post: (type: string, detail?: Record<string, unknown>) => void;
}

export interface TerrainPeaksResponder {
    answer: (data: unknown) => Promise<PeakMarker[] | null> | null;
    reset: () => void;
}

// Defensive cap on rendered markers; when the feed returns more, the most
// prominent peaks win. The native map draws everything, but a pitched 3D
// camera can legitimately see more area than a 2D viewport ever would.
const MAX_PEAKS = 400;
// A z12 two-axis viewport spans ~0.1°; anything near this guard means the
// requester's bounds math is broken, so fail closed rather than ask the
// server for a continent.
const MAX_BBOX_SPAN_DEGREES = 6;
const REQUEST_TIMEOUT_MS = 10000;
const RESPONSE_MAX_BYTES = 512 * 1024;
const MAX_SOURCE_PEAKS = 2000;
const MAX_XML_TAGS = MAX_SOURCE_PEAKS + 4;
// Map types whose native map loads peak markers (the Leaflet renderer's
// list). Group maps ('G') intentionally never show other peaks.
const PEAK_MAP_TYPES = new Set(['P', 'A', 'K', 'W', 'I', 'E', 'U', 'J', 'S']);
// Types that pass the page's subject peak id so the server can exclude it.
const PID_MAP_TYPES = new Set(['P', 'K', 'I', 'U', 'E']);

const parseIntegerParam = (value: unknown): number | null => {
    if (typeof value !== 'string' || !/^-?\d{1,9}$/.test(value.trim())) return null;
    return parseInt(value, 10);
};

// Read the peak-feed context from the same-origin MasterMap iframe URL.
// Returns null (no markers, fail closed) for cross-origin frames, map
// types that do not show peaks natively, or an unrecognizable URL.
const contextFrom = (iframeSrc: unknown): PeakMarkerContext | null => {
    if (typeof iframeSrc !== 'string' || !iframeSrc) return null;
    let url: URL;
    try { url = new URL(iframeSrc, location.href); } catch (error) { return null; }
    if (url.origin !== location.origin || !/\/mastermap\.aspx$/i.test(url.pathname)) return null;

    const mapType = (url.searchParams.get('t') || '').trim().toUpperCase();
    if (!PEAK_MAP_TYPES.has(mapType)) return null;

    const hj = parseIntegerParam(url.searchParams.get('hj'));
    return {
        endpoint: new URL('../Async/PLLBB.aspx', url).href,
        mapType,
        pid: PID_MAP_TYPES.has(mapType) ? parseIntegerParam(url.searchParams.get('d')) : null,
        cid: parseIntegerParam(url.searchParams.get('c')),
        hj: hj !== null && hj >= 0 ? hj : 0
    };
};

const clampCoordinate = (value: number, limit: number): number =>
    Math.max(-limit, Math.min(limit, Math.round(value * 1e6) / 1e6));

// Build the same request URL the native map builds for these bounds, or
// null when the bounds are unusable.
const requestUrl = (context: PeakMarkerContext | null | undefined, bounds: unknown): string | null => {
    if (!context || !bounds || typeof bounds !== 'object') return null;
    const record = bounds as Record<string, unknown>;
    const rawMiny = record.miny;
    const rawMaxy = record.maxy;
    const rawMinx = record.minx;
    const rawMaxx = record.maxx;
    if (typeof rawMiny !== 'number' || typeof rawMaxy !== 'number'
        || typeof rawMinx !== 'number' || typeof rawMaxx !== 'number') return null;
    if (![rawMiny, rawMaxy, rawMinx, rawMaxx].every(Number.isFinite)) return null;
    const miny = clampCoordinate(rawMiny, 90);
    const maxy = clampCoordinate(rawMaxy, 90);
    const minx = clampCoordinate(rawMinx, 180);
    const maxx = clampCoordinate(rawMaxx, 180);
    if (!(miny < maxy) || !(minx < maxx)) return null;
    if (maxy - miny > MAX_BBOX_SPAN_DEGREES || maxx - minx > MAX_BBOX_SPAN_DEGREES) return null;

    let url = `${context.endpoint}?miny=${miny}&maxy=${maxy}&minx=${minx}&maxx=${maxx}&t=${context.mapType}`;
    if (context.pid !== null) url += `&pid=${context.pid}`;
    if (context.cid !== null) url += `&cid=${context.cid}`;
    return url;
};

const stateFromClimbedFlag = (flag: string | null): PeakMarkerState => {
    if (flag === '1') return 'climbed';
    if (flag === '2') return 'unknown';
    return 'unclimbed';
};

// Parse a PLLBB response into validated marker records. Any row that does
// not look exactly like a peak is dropped; a document that does not parse
// yields no markers. Mirrors the native prominence filter (r >= hj, with
// non-numeric prominence always dropped).
const parsePeaks = (xmlText: unknown, hj: unknown = 0): PeakMarker[] => {
    if (typeof xmlText !== 'string' || !xmlText) return [];
    // The feed is a flat <ts> list of self-closing <t> rows. Bound its node
    // count and reject DTD/entity input before DOMParser can expand anything.
    if (/<!DOCTYPE|<!ENTITY/i.test(xmlText)) return [];
    const tags = xmlText.match(/</g);
    if ((tags?.length || 0) > MAX_XML_TAGS) return [];
    const sourceRows = xmlText.match(/<t(?:\s|\/?>)/g);
    if ((sourceRows?.length || 0) > MAX_SOURCE_PEAKS) return [];
    let doc: Document;
    try { doc = new DOMParser().parseFromString(xmlText, 'text/xml'); } catch (error) { return []; }
    if (!doc || doc.getElementsByTagName('parsererror').length) return [];

    const cutoff = typeof hj === 'number' && Number.isInteger(hj) && hj >= 0 ? hj : 0;
    const rows: { prominence: number; peak: PeakMarker }[] = [];
    for (const row of Array.from(doc.getElementsByTagName('t'))) {
        const id = parseIntegerParam(row.getAttribute('i'));
        const name = (row.getAttribute('n') || '').trim();
        const lat = Number(row.getAttribute('a'));
        const lon = Number(row.getAttribute('o'));
        const prominence = parseIntegerParam(row.getAttribute('r'));
        if (id === null || id === 0 || prominence === null || prominence < cutoff) continue;
        if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) continue;
        if (!Number.isFinite(lat) || Math.abs(lat) > 85.0511287
                || !Number.isFinite(lon) || Math.abs(lon) > 180) continue;
        rows.push({ prominence, peak: { id, name, lat, lon, state: stateFromClimbedFlag(row.getAttribute('c')) } });
    }
    // Keep the most significant peaks when the feed exceeds the cap.
    if (rows.length > MAX_PEAKS) rows.sort((left, right) => right.prominence - left.prominence);
    return rows.slice(0, MAX_PEAKS).map(row => row.peak);
};

// A single-flight fetcher for one map surface: a new request aborts the
// in-flight one (the camera has moved on). Resolves to a peaks array to
// deliver, or null when this request was superseded and must not be
// answered at all (the newer request will answer instead).
const createClient = (iframeSrc: unknown): PeakMarkerClient | null => {
    const context = contextFrom(iframeSrc);
    if (!context) return null;
    let inflight: AbortController | null = null;
    let limit: RateLimitError | null = null;
    let limitedUntil = 0;

    return {
        context,
        request: async (bounds: unknown): Promise<PeakMarker[] | null> => {
            const url = requestUrl(context, bounds);
            if (!url) return [];
            if (limit && Date.now() < limitedUntil) throw limit;
            if (inflight) inflight.abort();
            const controller = new AbortController();
            inflight = controller;
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            let response: Response | undefined;
            try {
                response = await fetch(url, {
                    signal: controller.signal,
                    credentials: 'same-origin',
                    headers: { Accept: 'text/xml' }
                });
                if (controller !== inflight) return null;
                if (response.status === 429) {
                    limit = rateLimitError('Peakbagger', response);
                    // A local backoff without a header is not a promised reset.
                    limitedUntil = limit.retryAt || Date.now() + 60000;
                    throw limit;
                }
                const text = response.ok ? await BoundedText.readBoundedResponseText(response, {
                    maxBytes: RESPONSE_MAX_BYTES,
                    signal: controller.signal,
                    label: 'Peak marker response',
                }) : '';
                if (controller !== inflight) return null;
                return response.ok ? parsePeaks(text, context.hj) : [];
            } catch (error) {
                if (controller === inflight && (error as { code?: unknown } | null | undefined)?.code === 'rate-limit') throw error;
                // A superseded request stays silent; a genuine failure
                // clears the markers until the next camera settle.
                return controller === inflight ? [] : null;
            } finally {
                cancelResponseBody(response);
                clearTimeout(timeout);
                if (inflight === controller) inflight = null;
            }
        }
    };
};

// Adapt one peak-feed client to the terrain bridge protocol. The source is
// resolved once per map-frame generation, including an unusable source, so a
// surface whose native map has no peak feed answers unavailable consistently.
// reset() also suppresses a response from a frame that has since been replaced.
const createTerrainResponder = ({ getIframeSrc, post }: TerrainResponderOptions): TerrainPeaksResponder => {
    if (typeof getIframeSrc !== 'function' || typeof post !== 'function') {
        throw new TypeError('Peak marker responders require a frame source and post function');
    }
    let client: PeakMarkerClient | null = null;
    let clientResolved = false;
    let generation = 0;

    const resolveClient = (): PeakMarkerClient | null => {
        if (clientResolved) return client;
        clientResolved = true;
        let iframeSrc: string | null | undefined = null;
        try { iframeSrc = getIframeSrc(); } catch (error) { /* A replaced frame is unavailable. */ }
        client = createClient(iframeSrc);
        return client;
    };

    const answer = (data: unknown): Promise<PeakMarker[] | null> | null => {
        const record = data && typeof data === 'object' ? data as { requestId?: unknown; bounds?: unknown } : null;
        const requestId = record?.requestId;
        if (typeof requestId !== 'number' || !Number.isFinite(requestId)) return null;
        const activeClient = resolveClient();
        if (!activeClient) {
            post('peaks', { requestId, peaks: [], unavailable: true });
            return null;
        }
        const requestGeneration = generation;
        const request = activeClient.request(record!.bounds);
        return request.then(peaks => {
            // A superseded request resolves null and stays silent; a reset
            // means the old frame's otherwise-valid answer is stale too.
            if (peaks && requestGeneration === generation) post('peaks', { requestId, peaks });
            return peaks;
        }, (error: unknown) => {
            const rateError = error as { code?: unknown; retryAt?: unknown } | null | undefined;
            if (requestGeneration === generation && rateError?.code === 'rate-limit') {
                post('peaks', { requestId, rateLimited: true, ...(rateError.retryAt ? { retryAt: rateError.retryAt } : {}) });
            }
            return null;
        });
    };

    const reset = (): void => {
        client = null;
        clientResolved = false;
        generation++;
    };

    return { answer, reset };
};

export const peakMarkers = {
    MAX_PEAKS,
    RESPONSE_MAX_BYTES,
    MAX_SOURCE_PEAKS,
    contextFrom,
    requestUrl,
    parsePeaks,
    createClient,
    createTerrainResponder,
};
