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


    // The native 2D map hides all peak markers below this zoom ("the map
    // covers too big an area"). The 3D view mirrors the same cutoff.
    const MIN_PEAK_ZOOM = 12;
    // Defensive cap on rendered markers; when the feed returns more, the most
    // prominent peaks win. The native map draws everything, but a pitched 3D
    // camera can legitimately see more area than a 2D viewport ever would.
    const MAX_PEAKS = 400;
    // A z12 two-axis viewport spans ~0.1°; anything near this guard means the
    // requester's bounds math is broken, so fail closed rather than ask the
    // server for a continent.
    const MAX_BBOX_SPAN_DEGREES = 6;
    const REQUEST_TIMEOUT_MS = 10000;
    // Map types whose native map loads peak markers (the Leaflet renderer's
    // list). Group maps ('G') intentionally never show other peaks.
    const PEAK_MAP_TYPES = new Set(['P', 'A', 'K', 'W', 'I', 'E', 'U', 'J', 'S']);
    // Types that pass the page's subject peak id so the server can exclude it.
    const PID_MAP_TYPES = new Set(['P', 'K', 'I', 'U', 'E']);

    const parseIntegerParam = value => {
        if (typeof value !== 'string' || !/^-?\d{1,9}$/.test(value.trim())) return null;
        return parseInt(value, 10);
    };

    // Read the peak-feed context from the same-origin MasterMap iframe URL.
    // Returns null (no markers, fail closed) for cross-origin frames, map
    // types that do not show peaks natively, or an unrecognizable URL.
    const contextFrom = iframeSrc => {
        if (typeof iframeSrc !== 'string' || !iframeSrc) return null;
        let url;
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

    const clampCoordinate = (value, limit) =>
        Math.max(-limit, Math.min(limit, Math.round(value * 1e6) / 1e6));

    // Build the same request URL the native map builds for these bounds, or
    // null when the bounds are unusable.
    const requestUrl = (context, bounds) => {
        if (!context || !bounds) return null;
        const numbers = [bounds.miny, bounds.maxy, bounds.minx, bounds.maxx];
        if (!numbers.every(Number.isFinite)) return null;
        const miny = clampCoordinate(bounds.miny, 90);
        const maxy = clampCoordinate(bounds.maxy, 90);
        const minx = clampCoordinate(bounds.minx, 180);
        const maxx = clampCoordinate(bounds.maxx, 180);
        if (!(miny < maxy) || !(minx < maxx)) return null;
        if (maxy - miny > MAX_BBOX_SPAN_DEGREES || maxx - minx > MAX_BBOX_SPAN_DEGREES) return null;

        let url = `${context.endpoint}?miny=${miny}&maxy=${maxy}&minx=${minx}&maxx=${maxx}&t=${context.mapType}`;
        if (context.pid !== null) url += `&pid=${context.pid}`;
        if (context.cid !== null) url += `&cid=${context.cid}`;
        return url;
    };

    const stateFromClimbedFlag = flag => {
        if (flag === '1') return 'climbed';
        if (flag === '2') return 'unknown';
        return 'unclimbed';
    };

    // Parse a PLLBB response into validated marker records. Any row that does
    // not look exactly like a peak is dropped; a document that does not parse
    // yields no markers. Mirrors the native prominence filter (r >= hj, with
    // non-numeric prominence always dropped).
    const parsePeaks = (xmlText, hj) => {
        if (typeof xmlText !== 'string' || !xmlText) return [];
        let doc;
        try { doc = new DOMParser().parseFromString(xmlText, 'text/xml'); } catch (error) { return []; }
        if (!doc || doc.getElementsByTagName('parsererror').length) return [];

        const cutoff = Number.isInteger(hj) && hj >= 0 ? hj : 0;
        const rows = [];
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
    const createClient = iframeSrc => {
        const context = contextFrom(iframeSrc);
        if (!context) return null;
        let inflight = null;

        return {
            context,
            request: async bounds => {
                const url = requestUrl(context, bounds);
                if (!url) return [];
                if (inflight) inflight.abort();
                const controller = new AbortController();
                inflight = controller;
                const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                try {
                    const response = await fetch(url, {
                        signal: controller.signal,
                        credentials: 'same-origin',
                        headers: { Accept: 'text/xml' }
                    });
                    const text = response.ok ? await response.text() : '';
                    if (controller !== inflight) return null;
                    return response.ok ? parsePeaks(text, context.hj) : [];
                } catch (error) {
                    // A superseded request stays silent; a genuine failure
                    // clears the markers until the next camera settle.
                    return controller === inflight ? [] : null;
                } finally {
                    clearTimeout(timeout);
                    if (inflight === controller) inflight = null;
                }
            }
        };
    };

    export const peakMarkers = { MIN_PEAK_ZOOM, MAX_PEAKS, contextFrom, requestUrl, parsePeaks, createClient };

