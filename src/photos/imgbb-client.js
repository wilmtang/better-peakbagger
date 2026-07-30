// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — ImgBB v1 upload client with a narrow response contract.
//
// An upload is not idempotent: ImgBB stores the image and hands back a URL, so
// a failure the client cannot classify is not merely an error to show — it
// decides whether the library records the photo as "outcome unknown" (and asks
// the user to check ImgBB) or silently resets it for a retry that would upload
// the same picture twice. Every failure below therefore states whether ImgBB
// definitely refused the image (`ambiguous: false`) or may already be holding
// it (`ambiguous: true`). When in doubt the client says so; a duplicate the
// user never learns about is the worse outcome.

import { requestDeadline as Deadline } from '../net/request-deadline.js';

const API_ROOT = 'https://api.imgbb.com/1/upload';
const KEY_LIMIT = 512;
const NAME_LIMIT = 200;
const URL_LIMIT = 4096;
// Photos are megabytes over a consumer uplink, so this is deliberately far
// longer than a page read — long enough for a slow upload to finish, short
// enough that a dead connection still becomes a stated failure.
const DEFAULT_TIMEOUT_MS = 120000;

class ImgbbError extends Error {
    constructor(code, message, { status = null, ambiguous = false, cause = null } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'ImgbbError';
        this.code = code;
        this.status = status;
        this.ambiguous = ambiguous;
    }
}

const cleanKey = value => {
    if (typeof value !== 'string') return null;
    const key = value.trim();
    return key && key.length <= KEY_LIMIT && !/\s/.test(key) ? key : null;
};

const cleanName = value => String(value ?? '')
    .replace(/\.[A-Za-z0-9]{1,10}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_LIMIT);

const cleanHttpsUrl = value => {
    if (typeof value !== 'string' || value.length > URL_LIMIT) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    } catch { return null; }
};

const positiveInteger = value => {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const unixTime = value => {
    const seconds = positiveInteger(value);
    if (seconds == null) return null;
    const milliseconds = seconds * 1000;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

const nullableExpiration = value => value == null || value === 0 || value === '0'
    ? null
    : unixTime(value);

const parseJson = text => {
    try { return JSON.parse(text); }
    catch { return undefined; }
};

// ImgBB's own `{ success: false, error: {...} }` envelope: proof the service
// itself answered, rather than something in front of it.
const hasProviderEnvelope = payload => !!payload && typeof payload === 'object' && !!payload.error;

const providerMessage = payload => {
    const message = payload?.error?.message;
    return typeof message === 'string' && message.trim()
        ? message.replace(/\s+/g, ' ').trim().slice(0, 300)
        : null;
};

// ImgBB states the size ceiling in its own rejection ("File too big - max 32
// MB"), and that ceiling is a property of the account, not of this extension —
// a paid plan reports a larger one. So there is no local byte limit to enforce:
// the upload is attempted and ImgBB answers. What its answers never carry is
// what the reader should do next, so each code we have actually observed adds
// one remedy sentence and maps onto the caller's own error vocabulary.
const PROVIDER_FAILURES = new Map([
    [100, { code: 'not-configured', remedy: 'Add a working key under Settings → Activity creation → Trip report photos.' }],
    [313, { code: 'too-large', remedy: 'Use a smaller photo, or crop it before drawing the topo.' }],
    [415, { code: 'invalid-image', remedy: 'Choose a JPEG or PNG photo.' }],
]);

const providerFailure = (payload, status, fallbackCode, fallbackMessage) => {
    const code = payload?.error?.code;
    const known = PROVIDER_FAILURES.get(Number.isInteger(code) ? code : null);
    const stated = providerMessage(payload);
    if (!stated) return new ImgbbError(fallbackCode, fallbackMessage, { status });
    // ImgBB's wording is the fact; the remedy is the advice. Keep them as two
    // sentences so the reader can see which part came from the provider.
    const message = known ? `ImgBB: ${stated.replace(/[.\s]+$/, '')}. ${known.remedy}` : stated;
    return new ImgbbError(known?.code || fallbackCode, message, { status });
};

// A 2xx whose body is not ImgBB's envelope is the most dangerous shape there
// is: ImgBB said yes, and the one thing lost is the URL of an image it is now
// hosting. It must never look like a clean refusal the caller can retry.
const UNREADABLE_SUCCESS = 'ImgBB accepted the upload but sent a reply Better Peakbagger could not read.'
    + ' Check your ImgBB account before uploading it again.';

const cleanUploadResponse = (payload, responseStatus) => {
    if (payload === undefined) {
        throw new ImgbbError('invalid-response', UNREADABLE_SUCCESS, {
            status: responseStatus, ambiguous: true,
        });
    }
    if (!payload || payload.success !== true || !payload.data || typeof payload.data !== 'object') {
        throw providerFailure(payload, responseStatus, 'rejected', 'ImgBB rejected the image upload.');
    }
    const data = payload.data;
    const providerId = typeof data.id === 'string' ? data.id.trim().slice(0, 200) : '';
    const url = cleanHttpsUrl(data.url);
    const displayUrl = cleanHttpsUrl(data.display_url);
    const viewerUrl = cleanHttpsUrl(data.url_viewer);
    const thumbnailUrl = cleanHttpsUrl(data.thumb?.url);
    const mediumUrl = data.medium?.url == null ? null : cleanHttpsUrl(data.medium.url);
    const deleteUrl = cleanHttpsUrl(data.delete_url);
    const width = positiveInteger(data.width);
    const height = positiveInteger(data.height);
    const bytes = positiveInteger(data.size);
    const uploadedAt = unixTime(data.time);
    const expiresAt = nullableExpiration(data.expiration);
    if (!providerId || !url || !displayUrl || !viewerUrl || !thumbnailUrl || !deleteUrl
        || width == null || height == null || bytes == null || !uploadedAt
        || (data.medium?.url != null && !mediumUrl)
        || (data.expiration != null && data.expiration !== 0 && data.expiration !== '0' && !expiresAt)) {
        throw new ImgbbError(
            'invalid-response',
            'ImgBB accepted the upload but returned incomplete image metadata.',
            { status: responseStatus, ambiguous: true },
        );
    }
    return {
        remote: {
            providerId,
            url,
            displayUrl,
            viewerUrl,
            thumbnailUrl,
            mediumUrl,
            uploadedAt,
            expiresAt,
        },
        deleteUrl,
        providerImage: { width, height, bytes },
    };
};

const publicError = (error, fallback = 'The ImgBB upload failed.') => {
    if (error instanceof ImgbbError) {
        return {
            code: error.code,
            message: error.message,
            ambiguous: error.ambiguous,
            ...(error.status == null ? {} : { status: error.status }),
        };
    }
    return { code: 'unknown', message: fallback, ambiguous: false };
};

// The statuses where ImgBB rejected the request itself, so nothing was stored
// and the message can name the key or the image. Rate limits and outages are
// classified before this is consulted.
const refusedOutright = status => status === 400 || status === 401 || status === 403;

const upload = async ({
    fetch,
    key,
    blob,
    name = '',
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    FormDataCtor = globalThis.FormData,
} = {}) => {
    if (typeof fetch !== 'function') throw new TypeError('ImgBB client requires fetch');
    const credential = cleanKey(key);
    if (!credential) throw new ImgbbError('not-configured', 'Enter a valid ImgBB API key.');
    if (!(blob instanceof Blob) || !/^image\//i.test(blob.type) || blob.size <= 0) {
        throw new ImgbbError('invalid-image', 'Choose a browser-decodable image to upload.');
    }
    const form = new FormDataCtor();
    form.append('image', blob, `better-peakbagger.${blob.type === 'image/png' ? 'png' : 'jpg'}`);
    const uploadName = cleanName(name);
    if (uploadName) form.append('name', uploadName);

    const endpoint = new URL(API_ROOT);
    endpoint.searchParams.set('key', credential);

    const deadline = Deadline.createRequestDeadline(timeoutMs);
    // The caller's own cancellation tears down the same request. Forwarding it
    // to the deadline's controller avoids AbortSignal.any(), which is newer
    // than the browsers this extension supports.
    const cancel = () => deadline.abort();
    if (signal) {
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
    }
    const release = () => {
        deadline.clear();
        signal?.removeEventListener?.('abort', cancel);
    };

    let response;
    try {
        response = await deadline.run(fetch(endpoint.toString(), {
            method: 'POST',
            body: form,
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            signal: deadline.signal,
        }));
    } catch (cause) {
        release();
        // Both shapes are ambiguous: the image was already on the wire. They
        // differ only in what the user should do about it.
        throw deadline.expired
            ? new ImgbbError(
                'timeout',
                'ImgBB did not respond in time. Check your ImgBB account before uploading this photo again.',
                { ambiguous: true, cause },
            )
            : new ImgbbError(
                'ambiguous',
                'The connection ended before ImgBB confirmed the upload. Retrying may create a duplicate.',
                { ambiguous: true, cause },
            );
    }

    let text;
    try { text = await deadline.run(response.text()); }
    catch (cause) {
        release();
        throw new ImgbbError(
            deadline.expired ? 'timeout' : 'ambiguous',
            'ImgBB stopped responding before Better Peakbagger could read the result.'
                + ' Check your ImgBB account before uploading this photo again.',
            { status: response.status, ambiguous: true, cause },
        );
    }
    release();

    // Classify the status first. A service failure is answered by ImgBB's edge,
    // not by its JSON envelope, so parsing before checking turned every outage
    // page into "returned a response Better Peakbagger could not read" — a
    // parser complaint standing in for "ImgBB is down".
    const payload = parseJson(text);
    if (!response.ok) {
        if (response.status === 429) {
            throw providerFailure(payload, response.status, 'rate-limit',
                'ImgBB is rate-limiting uploads. Wait a few minutes, then try again.');
        }
        // A 5xx carrying ImgBB's own error envelope is ImgBB rejecting the
        // image, so it is definite. A 5xx without one came from whatever sits
        // in front of ImgBB and says nothing about whether the backend behind
        // it stored the image, so the outcome stays unknown.
        if (response.status >= 500 && !hasProviderEnvelope(payload)) {
            throw new ImgbbError(
                'unavailable',
                `ImgBB is temporarily unavailable (HTTP ${response.status}). Try again in a few minutes.`
                    + ' Check your ImgBB account before uploading this photo again.',
                { status: response.status, ambiguous: true },
            );
        }
        const refused = refusedOutright(response.status);
        throw providerFailure(
            payload,
            response.status,
            refused ? 'rejected' : 'provider',
            refused
                ? 'ImgBB rejected the API key or image.'
                : 'ImgBB could not accept the image. Try again later.',
        );
    }
    return cleanUploadResponse(payload, response.status);
};

export const imgbbClient = {
    API_ROOT,
    ImgbbError,
    cleanKey,
    cleanUploadResponse,
    publicError,
    upload,
};
