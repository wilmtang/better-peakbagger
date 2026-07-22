// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared authenticated GitHub REST transport. All api.github.com traffic uses
// this module for origin validation, headers, cache policy, response parsing,
// and HTTP-to-domain error classification. GitHub's device-flow endpoints live
// on github.com and use a different form/body protocol, so they intentionally
// stay in github-auth.js while sharing the same error type and codes.

import { githubErrors as GithubErrors } from './github-errors.js';

const API_ROOT = 'https://api.github.com';
const { ERROR_CODES, GithubError } = GithubErrors;

const isProtectionMessage = message =>
    /protected branch|branch protection|required status|required review|not authorized to push/i.test(message || '');

const isFastForwardMessage = message =>
    /fast forward|not a fast-forward|update is not a fast|reference already exists/i.test(message || '');

// `phase` carries the one endpoint-specific distinction GitHub's status alone
// cannot express: a 404/422 while updating a ref differs from the same status
// while reading or building repository objects.
const classify = (status, message, headers, phase = '') => {
    const remaining = headers && typeof headers.get === 'function'
        ? headers.get('x-ratelimit-remaining')
        : null;
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
    return ERROR_CODES.UNKNOWN;
};

const createGithubApi = ({ fetch, token } = {}) => {
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

    const request = async (method, path, {
        body = undefined,
        phase = '',
        allowNotFound = false,
        withResponse = false,
    } = {}) => {
        const url = resolveUrl(path);
        let response;
        try {
            response = await fetch(url.href, {
                method,
                // A stale authenticated ref read can make every bounded conflict
                // retry rebuild against the same obsolete parent.
                cache: 'no-store',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch (cause) {
            throw new GithubError(ERROR_CODES.NETWORK, 'Network request to GitHub failed.', { cause });
        }

        if (!response || typeof response.text !== 'function') {
            throw new GithubError(ERROR_CODES.UNKNOWN, 'GitHub returned an unexpected response.');
        }

        let text = '';
        try { text = await response.text(); } catch { text = ''; }
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }

        if (!response.ok) {
            if (allowNotFound && response.status === 404) return null;
            const message = (data && data.message) || text || `GitHub responded ${response.status}`;
            throw new GithubError(
                classify(response.status, message, response.headers, phase),
                message,
                { status: response.status },
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

    return { request, resolveUrl };
};

export const githubApi = { API_ROOT, createGithubApi };
