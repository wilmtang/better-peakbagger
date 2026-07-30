// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared authenticated GitHub REST transport. All api.github.com traffic uses
// this module for origin validation, headers, cache policy, response parsing,
// and HTTP-to-domain error classification. GitHub's device-flow endpoints live
// on github.com and use a different form/body protocol, so they intentionally
// stay in github-auth.js while sharing the same error type and codes.

import { githubErrors as GithubErrors } from './github-errors.js';
import { requestDeadline as Deadline } from '../net/request-deadline.js';

const API_ROOT = 'https://api.github.com';
const { ERROR_CODES, GithubError } = GithubErrors;
const DEFAULT_TIMEOUT_MS = 20000;
// A read is repeatable by definition, so a transient GitHub blip on one need
// not end a whole backup. Writes are deliberately excluded: a 502 after a ref
// update may have applied it, and only the caller's compare-and-swap retry can
// tell. Kept short — this is for a blip, not an outage.
const TRANSIENT_RETRY_DELAYS = [400, 1200];
const TRANSIENT_CODES = new Set([ERROR_CODES.SERVER, ERROR_CODES.TIMEOUT]);

const isProtectionMessage = message =>
    /protected branch|branch protection|required status|required review|not authorized to push/i.test(message || '');

const isFastForwardMessage = message =>
    /fast forward|not a fast-forward|update is not a fast|reference already exists/i.test(message || '');

const header = (headers, name) => (headers && typeof headers.get === 'function'
    ? headers.get(name)
    : null);

// `phase` carries the one endpoint-specific distinction GitHub's status alone
// cannot express: a 404/422 while updating a ref differs from the same status
// while reading or building repository objects.
const classify = (status, message, headers, phase = '') => {
    const remaining = header(headers, 'x-ratelimit-remaining');
    if (status === 401) return ERROR_CODES.AUTH;
    if (status === 429) return ERROR_CODES.RATE_LIMIT;
    if (status === 403) {
        if (remaining === '0' || /rate limit|secondary rate|abuse/i.test(message)) return ERROR_CODES.RATE_LIMIT;
        if (/archiv/i.test(message)) return ERROR_CODES.ARCHIVED;
        if (isProtectionMessage(message)) return ERROR_CODES.BRANCH_PROTECTED;
        return ERROR_CODES.NO_ACCESS;
    }
    if (status === 404) return phase === 'ref' ? ERROR_CODES.BRANCH_MISSING : ERROR_CODES.NO_ACCESS;
    if (status === 409) return ERROR_CODES.CONFLICT;
    if (status === 422) {
        if (phase === 'ref' && isFastForwardMessage(message)) return ERROR_CODES.CONFLICT;
        if (isProtectionMessage(message)) return ERROR_CODES.BRANCH_PROTECTED;
        return ERROR_CODES.INVALID;
    }
    // GitHub answers its own outages with an HTML error page rather than the
    // usual JSON envelope, so this must be decided on status alone.
    if (status >= 500) return ERROR_CODES.SERVER;
    return ERROR_CODES.UNKNOWN;
};

// How long GitHub says to wait: `retry-after` on a secondary limit, otherwise
// the absolute `x-ratelimit-reset` instant for a primary one. Only the
// documented numeric forms are read; anything else leaves the window unstated
// rather than inventing a number for the UI to promise.
const retryAfterSeconds = (headers, now) => {
    const after = Number(header(headers, 'retry-after'));
    if (Number.isFinite(after) && after > 0) return Math.ceil(after);
    const reset = Number(header(headers, 'x-ratelimit-reset'));
    if (!Number.isFinite(reset) || reset <= 0) return null;
    const seconds = Math.ceil(reset - now() / 1000);
    return seconds > 0 ? seconds : null;
};

const createGithubApi = ({
    fetch,
    token,
    now = Date.now,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) => {
    if (typeof fetch !== 'function') throw new TypeError('github api requires an injected fetch');
    if (!token) throw new TypeError('github api requires a token');

    const resolveUrl = path => {
        let url;
        try {
            url = new URL(path, `${API_ROOT}/`);
        } catch (cause) {
            throw new GithubError(ERROR_CODES.INVALID, 'GitHub API URL is invalid.', { cause });
        }
        if (url.origin !== API_ROOT) {
            throw new GithubError(ERROR_CODES.INVALID, 'GitHub API URL has an unexpected origin.');
        }
        return url;
    };

    const attempt = async (method, url, {
        body = undefined,
        phase = '',
        allowNotFound = false,
        withResponse = false,
    } = {}) => {
        const deadline = Deadline.createRequestDeadline(timeoutMs);
        let response;
        try {
            response = await deadline.run(fetch(url.href, {
                method,
                // A stale authenticated ref read can make every bounded conflict
                // retry rebuild against the same obsolete parent.
                cache: 'no-store',
                signal: deadline.signal,
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }));
        } catch (cause) {
            deadline.clear();
            throw deadline.expired
                ? new GithubError(ERROR_CODES.TIMEOUT, 'GitHub did not respond in time.', { cause })
                : new GithubError(ERROR_CODES.NETWORK, 'Network request to GitHub failed.', { cause });
        }

        if (!response || typeof response.text !== 'function') {
            deadline.clear();
            throw new GithubError(ERROR_CODES.UNKNOWN, 'GitHub returned an unexpected response.');
        }

        // The body read shares the deadline: headers can arrive promptly and
        // the stream still stall, which would otherwise hang past every bound.
        let text = '';
        try { text = await deadline.run(response.text()); }
        catch (cause) {
            if (deadline.expired) {
                deadline.clear();
                throw new GithubError(ERROR_CODES.TIMEOUT, 'GitHub stopped responding while sending its answer.', {
                    status: response.status, cause,
                });
            }
            text = '';
        }
        deadline.clear();

        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }

        if (!response.ok) {
            if (allowNotFound && response.status === 404) return null;
            const message = (data && data.message) || text || `GitHub responded ${response.status}`;
            throw new GithubError(
                classify(response.status, message, response.headers, phase),
                message,
                {
                    status: response.status,
                    retryAfterSeconds: retryAfterSeconds(response.headers, now),
                },
            );
        }
        if (data == null) {
            throw new GithubError(ERROR_CODES.UNKNOWN, 'GitHub returned an unexpected response.', {
                status: response.status,
            });
        }
        return withResponse
            ? { data, headers: response.headers, status: response.status, url: url.href }
            : data;
    };

    const request = async (method, path, options = {}) => {
        const url = resolveUrl(path);
        const retryable = method === 'GET';
        for (let tries = 0; ; tries += 1) {
            try {
                return await attempt(method, url, options);
            } catch (error) {
                if (!retryable
                    || !(error instanceof GithubError)
                    || !TRANSIENT_CODES.has(error.code)
                    || tries >= TRANSIENT_RETRY_DELAYS.length) throw error;
                await sleep(TRANSIENT_RETRY_DELAYS[tries]);
            }
        }
    };

    return { request, resolveUrl };
};

export const githubApi = { API_ROOT, DEFAULT_TIMEOUT_MS, createGithubApi };
