// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const MAX_WAIT = 24 * 3600_000;
export const retryAfterAt = (headers, now = Date.now()) => {
    const raw = String(headers?.get?.('retry-after') || '').trim();
    if (!raw || !Number.isFinite(now)) return null;
    // Reject loose Date.parse inputs such as "1.5"; accept the HTTP-date form.
    const value = /^\d+$/.test(raw) ? now + Number(raw) * 1000
        : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) ? Date.parse(raw) : NaN;
    return Number.isFinite(value) && value > now && value <= now + MAX_WAIT ? Math.trunc(value) : null;
};

export const rateLimitMessage = (service, retryAt = null, now = Date.now()) => {
    const wait = Number.isFinite(retryAt) && retryAt > now && retryAt <= now + MAX_WAIT
        ? `Try again after ${new Date(retryAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`
        : 'Wait a few minutes, then try again.';
    return `${service} request limit reached. ${wait}`;
};

export const cancelResponseBody = response => {
    try { void Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* The stream may already be closed. */ }
};

export const rateLimitError = (service, response, now = Date.now()) => {
    const retryAt = retryAfterAt(response?.headers, now);
    cancelResponseBody(response);
    return Object.assign(new Error(rateLimitMessage(service, retryAt, now)), {
        name: 'RateLimitError', code: 'rate-limit', status: 429, ...(retryAt ? { retryAt } : {}),
    });
};
