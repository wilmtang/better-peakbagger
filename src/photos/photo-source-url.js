// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { requestDeadline as Deadline } from '../net/request-deadline.js';
import { rateLimitError } from '../net/rate-limit.js';

// A clicked report image may be public but not present in the local library.
// Respect CORS, omit credentials, and bound both time and encoded bytes.
export const readPhotoSourceUrl = async (value, { maxBytes, fetchFn = globalThis.fetch } = {}) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error('Use an HTTPS image URL.');
    }
    const deadline = Deadline.createRequestDeadline(15000);
    let reader;
    try {
        const response = await deadline.run(fetchFn(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: deadline.signal }));
        if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('The image redirected to an insecure URL.');
        if (response.status === 429) throw rateLimitError('Image host', response);
        if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '')) throw new Error('The image host did not return a readable image.');
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('The image is too large to edit.');
        reader = response.body?.getReader();
        if (!reader) throw new Error('The image could not be read.');
        const chunks = [];
        let bytes = 0;
        while (true) {
            const { done, value: chunk } = await deadline.run(reader.read());
            if (done) break;
            bytes += chunk.byteLength;
            if (bytes > maxBytes) throw new Error('The image is too large to edit.');
            chunks.push(chunk);
        }
        if (!bytes) throw new Error('The image is empty.');
        let filename = url.pathname.split('/').pop() || 'report-image';
        // A valid fetch URL may contain a literal percent or non-UTF-8 bytes.
        // Its display name must not invalidate already validated image data.
        try { filename = decodeURIComponent(filename); } catch { /* Keep the URL spelling. */ }
        return new File(chunks, filename, { type: response.headers.get('content-type').split(';')[0] });
    } finally {
        deadline.abort();
        deadline.clear();
        void reader?.cancel().catch(() => {});
    }
};
