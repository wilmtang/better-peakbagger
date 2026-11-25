// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { requestDeadline as Deadline } from '../net/request-deadline.ts';
import { rateLimitError } from '../net/rate-limit.ts';

export interface PhotoSourceReader {
    read(): Promise<ReadableStreamReadResult<Uint8Array>>;
    cancel?(reason?: unknown): Promise<unknown>;
}

export interface PhotoSourceResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly url?: string;
    readonly headers: { get(name: string): string | null };
    readonly body?: {
        getReader(): PhotoSourceReader;
        cancel?(): unknown;
    } | null;
}

export type PhotoSourceFetch = (input: string, init?: RequestInit) => Promise<PhotoSourceResponse>;

export interface ReadPhotoSourceUrlOptions {
    maxBytes?: number;
    fetchFn?: PhotoSourceFetch;
}

// A clicked report image may be public but not present in the local library.
// Respect CORS, omit credentials, and bound both time and encoded bytes.
export const readPhotoSourceUrl = async (
    value: string | URL,
    { maxBytes, fetchFn = globalThis.fetch }: ReadPhotoSourceUrlOptions = {},
): Promise<File> => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password
        || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error('Use an HTTPS image URL.');
    }
    const deadline = Deadline.createRequestDeadline(15000);
    let reader: PhotoSourceReader | undefined;
    try {
        const response = await deadline.run(fetchFn(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: deadline.signal }));
        if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('The image redirected to an insecure URL.');
        if (response.status === 429) throw rateLimitError('Image host', response);
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !/^image\//i.test(contentType)) throw new Error('The image host did not return a readable image.');
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('The image is too large to edit.');
        reader = response.body?.getReader();
        if (!reader) throw new Error('The image could not be read.');
        const chunks: BlobPart[] = [];
        let bytes = 0;
        while (true) {
            const { done, value: chunk } = await deadline.run(reader.read());
            if (done) break;
            bytes += chunk.byteLength;
            if (bytes > maxBytes) throw new Error('The image is too large to edit.');
            chunks.push(chunk as BlobPart);
        }
        if (!bytes) throw new Error('The image is empty.');
        let filename = url.pathname.split('/').pop() || 'report-image';
        // A valid fetch URL may contain a literal percent or non-UTF-8 bytes.
        // Its display name must not invalidate already validated image data.
        try { filename = decodeURIComponent(filename); } catch { /* Keep the URL spelling. */ }
        return new File(chunks, filename, { type: contentType.split(';')[0] });
    } finally {
        deadline.abort();
        deadline.clear();
        void reader?.cancel?.().catch(() => {});
    }
};
