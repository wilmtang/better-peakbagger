// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — ImgBB v1 upload client with a narrow response contract.

const API_ROOT = 'https://api.imgbb.com/1/upload';
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const KEY_LIMIT = 512;
const NAME_LIMIT = 200;
const URL_LIMIT = 4096;

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

const parseJson = async response => {
    const text = await response.text();
    try { return JSON.parse(text); }
    catch {
        throw new ImgbbError(
            'invalid-response',
            'ImgBB returned a response Better Peakbagger could not read.',
            { status: response.status },
        );
    }
};

const providerMessage = payload => {
    const message = payload?.error?.message;
    return typeof message === 'string' && message.trim()
        ? message.replace(/\s+/g, ' ').trim().slice(0, 300)
        : null;
};

const cleanUploadResponse = (payload, responseStatus) => {
    if (!payload || payload.success !== true || !payload.data || typeof payload.data !== 'object') {
        throw new ImgbbError(
            'rejected',
            providerMessage(payload) || 'ImgBB rejected the image upload.',
            { status: responseStatus },
        );
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

const upload = async ({
    fetch,
    key,
    blob,
    name = '',
    signal,
    FormDataCtor = globalThis.FormData,
} = {}) => {
    if (typeof fetch !== 'function') throw new TypeError('ImgBB client requires fetch');
    const credential = cleanKey(key);
    if (!credential) throw new ImgbbError('not-configured', 'Enter a valid ImgBB API key.');
    if (!(blob instanceof Blob) || !/^image\//i.test(blob.type) || blob.size <= 0) {
        throw new ImgbbError('invalid-image', 'Choose a browser-decodable image to upload.');
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
        throw new ImgbbError(
            'too-large',
            `The edited image is larger than ImgBB's ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.`,
        );
    }
    const form = new FormDataCtor();
    form.append('image', blob, `better-peakbagger.${blob.type === 'image/png' ? 'png' : 'jpg'}`);
    const uploadName = cleanName(name);
    if (uploadName) form.append('name', uploadName);

    const endpoint = new URL(API_ROOT);
    endpoint.searchParams.set('key', credential);
    let response;
    try {
        response = await fetch(endpoint.toString(), {
            method: 'POST',
            body: form,
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            signal,
        });
    } catch (cause) {
        throw new ImgbbError(
            'ambiguous',
            'The connection ended before ImgBB confirmed the upload. Retrying may create a duplicate.',
            { ambiguous: true, cause },
        );
    }
    const payload = await parseJson(response);
    if (!response.ok) {
        const authFailure = response.status === 400 || response.status === 401 || response.status === 403;
        throw new ImgbbError(
            authFailure ? 'rejected' : 'provider',
            providerMessage(payload) || (authFailure
                ? 'ImgBB rejected the API key or image.'
                : 'ImgBB could not accept the image. Try again later.'),
            { status: response.status },
        );
    }
    return cleanUploadResponse(payload, response.status);
};

export const imgbbClient = {
    API_ROOT,
    MAX_UPLOAD_BYTES,
    ImgbbError,
    cleanKey,
    cleanUploadResponse,
    publicError,
    upload,
};
