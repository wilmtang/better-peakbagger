// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface RateLimitResponseLike {
    headers?: unknown;
    body?: { cancel?(): unknown } | null;
}

export interface RateLimitError extends Error {
    name: 'RateLimitError';
    code: 'rate-limit';
    status: 429;
    retryAt?: number;
}

const MAX_WAIT = 24 * 3600_000;
export const readRetryAt = (value: unknown, now: number = Date.now()): number | null =>
    typeof value === 'number' && Number.isFinite(value) && typeof now === 'number' && Number.isFinite(now)
    && value > now && value <= now + MAX_WAIT ? Math.trunc(value) : null;
export const retryAfterAt = (headers: unknown, now: number = Date.now()): number | null => {
    const record = headers && typeof headers === 'object' ? headers as Record<string, unknown> : null;
    const hasGetter = !!(record && typeof record.get === 'function');
    const key = record && !hasGetter
        ? Object.keys(record).find(candidate => candidate.toLowerCase() === 'retry-after') ?? null
        : null;
    const headerValue = hasGetter
        ? (record as { get(name: string): unknown }).get('retry-after')
        : key ? record![key] : '';
    const raw = String(headerValue || '').trim();
    if (!raw || typeof now !== 'number' || !Number.isFinite(now)) return null;
    // Reject loose Date.parse inputs such as "1.5"; accept the HTTP-date form.
    const value = /^\d+$/.test(raw) ? now + Number(raw) * 1000
        : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) ? Date.parse(raw) : NaN;
    return readRetryAt(value, now);
};

export const rateLimitMessage = (service: string, retryAt: unknown = null, now: number = Date.now()): string => {
    const wait = typeof retryAt === 'number' && Number.isFinite(retryAt) && typeof now === 'number' && Number.isFinite(now)
        && retryAt > now && retryAt <= now + MAX_WAIT
        ? `Try again after ${new Date(retryAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`
        : 'Wait a few minutes, then try again.';
    return `${service} request limit reached. ${wait}`;
};

export const cancelResponseBody = (response: { body?: { cancel?(): unknown } | null } | null | undefined): void => {
    try { void Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* The stream may already be closed. */ }
};

export const rateLimitError = (
    service: string,
    response?: RateLimitResponseLike | null,
    now: number = Date.now(),
): RateLimitError => {
    const retryAt = retryAfterAt(response?.headers, now);
    cancelResponseBody(response);
    return Object.assign(new Error(rateLimitMessage(service, retryAt, now)), {
        name: 'RateLimitError' as const, code: 'rate-limit' as const, status: 429 as const, ...(retryAt ? { retryAt } : {}),
    });
};
