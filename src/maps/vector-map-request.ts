// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { VECTOR_BASEMAP, vectorProviderUrl } from './vector-basemap.ts';
import type { VectorBasemap } from './vector-basemap.ts';
import { requestDeadline } from '../net/request-deadline.js';
import { cancelResponseBody, rateLimitError } from '../net/rate-limit.js';

export const VECTOR_PROTOCOL = 'bpb-vector';
const prefix = `${VECTOR_PROTOCOL}://`;
export function vectorRequestUrl(url: unknown, basemap: VectorBasemap = VECTOR_BASEMAP) {
    const approved = vectorProviderUrl(url, basemap);
    if (!approved) throw new Error('Unapproved vector map provider.');
    return prefix + approved;
}

// MapLibre's built-in AJAXError omits headers. Its public protocol API lets us
// retain Retry-After before errors cross the renderer/worker boundary.
export interface VectorRequestParameters { url?: string; type?: string; }
export interface VectorRequestOptions {
    basemap?: VectorBasemap; fetch?: typeof globalThis.fetch;
    onRateLimit?: (error: Error & { retryAt?: number | null }) => void; timeoutMs?: number;
}
export function createVectorMapRequest({ basemap = VECTOR_BASEMAP, fetch = globalThis.fetch, onRateLimit = () => {}, timeoutMs = 15000 }: VectorRequestOptions = {}) {
    return async (parameters: VectorRequestParameters, controller: AbortController) => {
        const url = parameters.url?.startsWith(prefix) ? vectorProviderUrl(parameters.url.slice(prefix.length), basemap) : null;
        if (!url) throw new Error('Unapproved vector map provider.');
        const deadline = requestDeadline.createRequestDeadline(timeoutMs), signal = controller.signal;
        let response: Response | undefined, rejectAbort!: (reason: Error) => void;
        const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const abort = () => { deadline.abort(); rejectAbort(Object.assign(new Error('Vector request cancelled.'), { name: 'AbortError' })); };
        signal.addEventListener('abort', abort, { once: true });
        const run = <T>(promise: Promise<T>) => deadline.run(Promise.race([promise, aborted])) as Promise<T>;
        try {
            if (signal.aborted) throw Object.assign(new Error('Vector request cancelled.'), { name: 'AbortError' });
            response = await run(fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: deadline.signal }));
            if (response.status === 429) {
                const error = rateLimitError(basemap.provider, response);
                error.retryAt ??= Date.now() + 300000;
                onRateLimit(error); throw error;
            }
            if (!response.ok) throw Object.assign(new Error(`Vector resource unavailable (${response.status}).`), { status: response.status, url });
            if (!vectorProviderUrl(response.url, basemap)) throw new Error('Unapproved vector map response.');
            const data = await run(parameters.type === 'json' ? response.json()
                : parameters.type === 'string' ? response.text() : response.arrayBuffer());
            return { data, cacheControl: response.headers.get('cache-control'), expires: response.headers.get('expires') };
        } finally {
            signal.removeEventListener('abort', abort); cancelResponseBody(response); deadline.clear();
        }
    };
}
