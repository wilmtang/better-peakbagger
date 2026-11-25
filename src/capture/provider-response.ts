// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure classification for authenticated Garmin/Strava GPX responses. A 2xx
// status is not sufficient evidence of GPX: sign-in redirects, managed
// challenges, and changed JSON/HTML endpoints can all look successful to
// the provider request. Only allowlisted codes and a bounded retry timestamp
// leave here.

import { isProviderHost } from './provider-url.ts';
import { retryAfterAt } from '../net/rate-limit.ts';

export const PROVIDER_RESPONSE_PROBE_BYTES = 8192;
export const PROVIDER_RESPONSE_PROBE_CHARS = 4096;

export interface ProviderResponseLike {
    status?: number;
    ok?: boolean;
    url?: string;
    headers?: unknown;
}

export interface ClassifyProviderResponseOptions {
    provider?: string | null;
    bodyText?: string;
    now?: number;
}

export type ProviderResponseFailureCode =
    | 'provider-human-check'
    | 'provider-signed-out'
    | 'provider-response-changed'
    | 'no-gps-data'
    | 'provider-forbidden'
    | 'provider-rate-limited'
    | 'provider-unavailable';

export type ProviderResponseClassification =
    | { ok: true }
    | { ok: false; needsBodyProbe: true; code?: undefined; retryAt?: undefined }
    | { ok: false; needsBodyProbe?: false; code: ProviderResponseFailureCode; retryAt?: number };

export type ProviderBodyFailureCode =
    | 'no-gps-data'
    | 'provider-human-check'
    | 'provider-signed-out'
    | 'provider-response-changed';

export type ProviderBodyClassification =
    | { ok: true }
    | { ok: false; code: ProviderBodyFailureCode };

const headerValue = (headers: unknown, name: string): string => {
    if (!headers || typeof headers !== 'object') return '';
    const record = headers as Record<string, unknown>;
    if (typeof record.get === 'function') {
        return String((record as { get(headerName: string): unknown }).get(name) || '').trim();
    }
    const key = Object.keys(record).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? String(record[key] || '').trim() : '';
};

const looksLikeSignIn = (url: URL): boolean => /\/(?:login|signin|sso)(?:[/?#]|$)/i.test(url.pathname);
const looksLikeChallenge = (body: unknown): boolean => {
    const prefix = String(body || '').slice(0, PROVIDER_RESPONSE_PROBE_CHARS);
    return /\bid=["']challenge-form["']/i.test(prefix)
        || /cf-turnstile-response/i.test(prefix)
        || /challenges\.cloudflare\.com/i.test(prefix)
        || /<title[^>]*>\s*just a moment/i.test(prefix);
};
const looksLikeLoginBody = (body: unknown): boolean => {
    const prefix = String(body || '').slice(0, PROVIDER_RESPONSE_PROBE_CHARS);
    return /<form\b[^>]*(?:login|signin)/i.test(prefix)
        || /<input\b[^>]*(?:name|type)=["']password["']/i.test(prefix);
};

const finalUrlFailure = (
    urlValue: string | null | undefined,
    provider: string | null | undefined,
): 'provider-signed-out' | 'provider-response-changed' | null => {
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

export const classifyProviderResponse = (
    response: ProviderResponseLike | null | undefined,
    {
        provider,
        bodyText = '',
        now = Date.now(),
    }: ClassifyProviderResponseOptions = {},
): ProviderResponseClassification => {
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
        const retryAt = retryAfterAt(headers, now);
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

export const classifyProviderBody = (text: unknown): ProviderBodyClassification => {
    const body = String(text || '');
    if (!body.trim()) return { ok: false, code: 'no-gps-data' };
    if (looksLikeChallenge(body)) return { ok: false, code: 'provider-human-check' };
    if (looksLikeLoginBody(body)) return { ok: false, code: 'provider-signed-out' };
    if (/^\s*(?:<!doctype\s+html|<html\b|[[{])/i.test(body)) {
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
