// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { requestDeadline } from '../net/request-deadline.js';
import { readBoundedResponseText } from '../net/bounded-text.js';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.js';

export const SNOW_DEPTH_SERVICE = 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer';
// The service envelope includes neighboring parts of Canada and Mexico. It is
// not a promise of data in each pixel, or of country-wide Canadian coverage.
export const SNOW_DEPTH_BOUNDS = [-130.516667, 24.10001, -62.250003, 58.233342];
export const SNOW_DEPTH_MAX_ZOOM = 11;
export const SNOW_DEPTH_LEGEND = 'NOAA NOHRSC · Modeled depth, about 1 km resolution. Primarily contiguous US. Clear areas may have no snow or no data.';

export function readSnowDepthTime(value, now = Date.now()) {
    if (value?.exceededTransferLimit || !Array.isArray(value?.features) || value.features.length !== 1) return 0;
    const time = value.features[0]?.attributes?.idp_validtime;
    return Number.isSafeInteger(time) && time >= Date.UTC(2003, 0, 1) && time <= now + 300000 ? time : 0;
}
export function readSnowDepthLegend(value) {
    if (!Array.isArray(value?.layers) || value.layers.length > 16) return [];
    const entries = value.layers.find(layer => layer?.layerId === 3)?.legend;
    if (!Array.isArray(entries) || !entries.length || entries.length > 16) return [];
    const result = [];
    for (const entry of entries) {
        if (typeof entry.label !== 'string' || !/^\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?$/.test(entry.label)
            || entry.label.length > 40 || entry.contentType !== 'image/png' || typeof entry.imageData !== 'string'
            || entry.imageData.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.imageData)) return [];
        try {
            const bytes = Uint8Array.from(atob(entry.imageData), character => character.charCodeAt(0));
            const data = new DataView(bytes.buffer);
            if (bytes.length < 33 || data.getUint32(0) !== 0x89504e47 || data.getUint32(4) !== 0x0d0a1a0a
                || data.getUint32(12) !== 0x49484452 || !data.getUint32(16) || data.getUint32(16) > 32
                || !data.getUint32(20) || data.getUint32(20) > 32) return [];
        } catch { return []; }
        result.push({ label: `${entry.label.replace(/\s*-\s*/, '–')} in`, image: `data:image/png;base64,${entry.imageData}` });
    }
    return result;
}

// The outer map owner retains this small, credential-free catalogue across
// renderer switches. No arbitrary URL, route or account data enters a request.
export function createSnowDepthMetadata({ fetchImpl = globalThis.fetch, onStatus, now = Date.now, timeoutMs = 15000 }) {
    let enabled = false, disposed = false, generation = 0, controller = null, attemptedAt = null, retryAt = 0;
    let status = { analysisTime: 0, legendEntries: [], metadataPending: false, metadataError: false, metadataRetryAt: 0 };
    const emit = patch => { status = { ...status, ...patch }; onStatus(status); };
    const cancel = () => { generation++; controller?.abort(); controller = null; };
    async function json(url, signal) {
        const deadline = requestDeadline.createRequestDeadline(timeoutMs);
        let response, rejectCancel;
        const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
        cancelled.catch(() => {});
        const abort = () => { deadline.abort(); rejectCancel(new DOMException('Cancelled.', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
        const run = promise => deadline.run(Promise.race([promise, cancelled]));
        try {
            if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
            response = await run(fetchImpl(url, { signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-cache' }));
            if (response.status === 429) {
                const error = rateLimitError('NOAA', response); error.retryAt ||= now() + 300000; throw error;
            }
            if (!response.ok || !/json|text\/plain/i.test(response.headers.get('content-type') || '')) throw new Error('Snow analysis details unavailable.');
            const value = JSON.parse(await run(readBoundedResponseText(response, { maxBytes: 65536, signal: deadline.signal, label: 'Snow analysis details' })));
            if (value.error) throw new Error('Snow analysis details unavailable.');
            return value;
        } finally { cancelResponseBody(response); deadline.clear(); signal.removeEventListener('abort', abort); }
    }
    async function refresh(force = false) {
        if (!enabled || disposed || controller || retryAt > now() || !force && attemptedAt !== null && now() - attemptedAt < 300000) return;
        const owner = ++generation, request = new AbortController(); controller = request; attemptedAt = now();
        emit({ metadataPending: true, metadataError: false });
        try {
            // Sequential requests also stop legend work immediately on a busy
            // catalogue endpoint. Never replay a provider rate limit.
            const catalogue = await json(`${SNOW_DEPTH_SERVICE}/2/query?where=1%3D1&outFields=idp_validtime&returnGeometry=false&f=json`, request.signal);
            const analysisTime = readSnowDepthTime(catalogue, now());
            if (!analysisTime) throw new Error('Snow analysis time unavailable.');
            const legendEntries = readSnowDepthLegend(await json(`${SNOW_DEPTH_SERVICE}/legend?f=json`, request.signal));
            if (!legendEntries.length) throw new Error('Snow depth legend unavailable.');
            if (owner === generation && enabled && !disposed) emit({ analysisTime, legendEntries, metadataPending: false, metadataError: false, metadataRetryAt: 0 });
        } catch (error) {
            if (owner !== generation || !enabled || disposed || error.name === 'AbortError') return;
            retryAt = Math.max(retryAt, error.retryAt || 0);
            emit({ metadataPending: false, metadataError: true, metadataRetryAt: retryAt });
        } finally { if (controller === request) controller = null; }
    }
    return {
        update(value) {
            const changed = enabled !== value; enabled = value === true;
            if (!enabled) {
                if (controller) { cancel(); attemptedAt = null; }
                if (changed) emit({ metadataPending: false });
            } else void refresh();
        },
        retry: () => { void refresh(true); },
        dispose() { disposed = true; enabled = false; cancel(); },
    };
}
