// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure classification for authenticated Garmin/Strava GPX responses. A 2xx
// status is not sufficient evidence of GPX: sign-in redirects, managed
// challenges, and changed JSON/HTML endpoints can all look successful to
// the provider request. Only allowlisted codes and a bounded retry timestamp
// leave here.

import { isProviderHost } from './provider-url.js';

export const PROVIDER_RESPONSE_PROBE_BYTES = 8192;
export const PROVIDER_RESPONSE_PROBE_CHARS = 4096;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

const headerValue = (headers, name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key] || '').trim() : '';
};

const cleanRetryAt = (headers, now) => {
    const value = headerValue(headers, 'retry-after');
    if (!value) return null;
    const seconds = /^\d+$/.test(value) ? Number(value) : null;
    const candidate = seconds === null ? Date.parse(value) : now + seconds * 1000;
    return Number.isFinite(candidate) && candidate >= now && candidate <= now + MAX_RETRY_DELAY_MS
        ? Math.trunc(candidate)
        : null;
};

const looksLikeSignIn = url => /\/(?:login|signin|sso)(?:[/?#]|$)/i.test(url.pathname);
const looksLikeChallenge = body => {
    const prefix = String(body || '').slice(0, PROVIDER_RESPONSE_PROBE_CHARS);
    return /\bid=["']challenge-form["']/i.test(prefix)
        || /cf-turnstile-response/i.test(prefix)
        || /challenges\.cloudflare\.com/i.test(prefix)
        || /<title[^>]*>\s*just a moment/i.test(prefix);
};
const looksLikeLoginBody = body => {
    const prefix = String(body || '').slice(0, PROVIDER_RESPONSE_PROBE_CHARS);
    return /<form\b[^>]*(?:login|signin)/i.test(prefix)
        || /<input\b[^>]*(?:name|type)=["']password["']/i.test(prefix);
};

const finalUrlFailure = (urlValue, provider) => {
    if (!urlValue) return null;
    try {
        const url = new URL(urlValue);
        if (url.protocol === 'https:' && isProviderHost(provider, url.hostname)
            && !looksLikeSignIn(url)) return null;
        return looksLikeSignIn(url) ? 'provider-signed-out' : 'provider-response-changed';
    } catch (_error) {
        return 'provider-response-changed';
    }
};

export const classifyProviderResponse = (response, {
    provider,
    bodyText = '',
    now = Date.now(),
} = {}) => {
    const status = Number(response?.status ?? (response?.ok ? 200 : 0));
    const headers = response?.headers;
    const contentType = headerValue(headers, 'content-type').toLowerCase();
    const challenged = headerValue(headers, 'cf-mitigated').toLowerCase() === 'challenge'
        || looksLikeChallenge(bodyText);
    if (challenged) return { ok: false, code: 'provider-human-check' };

    const urlFailure = finalUrlFailure(response?.url, provider);
    if (urlFailure) return { ok: false, code: urlFailure };
    if (status === 204) return { ok: false, code: 'no-gps-data' };
    if (status === 401) return { ok: false, code: 'provider-signed-out' };
    if (status === 403) {
        if (!bodyText) return { ok: false, needsBodyProbe: true };
        return { ok: false, code: 'provider-forbidden' };
    }
    if (status === 429) {
        const retryAt = cleanRetryAt(headers, now);
        return { ok: false, code: 'provider-rate-limited', ...(retryAt ? { retryAt } : {}) };
    }
    if (status === 404) return { ok: false, code: 'provider-response-changed' };
    if (status === 0 || status >= 500) return { ok: false, code: 'provider-unavailable' };
    if (status < 200 || status >= 300) return { ok: false, code: 'provider-forbidden' };
    if (contentType.includes('text/html')) {
        if (!bodyText) return { ok: false, needsBodyProbe: true };
        return { ok: false, code: looksLikeLoginBody(bodyText)
            ? 'provider-signed-out'
            : 'provider-response-changed' };
    }
    if (contentType.includes('json')) return { ok: false, code: 'provider-response-changed' };
    return { ok: true };
};

export const classifyProviderBody = text => {
    const body = String(text || '');
    if (!body.trim()) return { ok: false, code: 'no-gps-data' };
    if (looksLikeChallenge(body)) return { ok: false, code: 'provider-human-check' };
    if (looksLikeLoginBody(body)) return { ok: false, code: 'provider-signed-out' };
    if (/^\s*(?:<!doctype\s+html|<html\b|[\[{])/i.test(body)) {
        return { ok: false, code: 'provider-response-changed' };
    }
    return { ok: true };
};

export const providerResponse = {
    PROVIDER_RESPONSE_PROBE_BYTES,
    PROVIDER_RESPONSE_PROBE_CHARS,
    classifyProviderResponse,
    classifyProviderBody,
};
