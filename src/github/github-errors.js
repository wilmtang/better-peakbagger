// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stable failures shared by GitHub OAuth, authenticated REST reads, and
// repository writes. Protocol modules may add context when classifying a
// response, but they all throw this one error type and use this one code set.

const ERROR_CODES = Object.freeze({
    AUTH: 'auth',
    DEVICE_FLOW_DISABLED: 'device-flow-disabled',
    DENIED: 'denied',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
    UNSUPPORTED: 'unsupported',
    NO_ACCESS: 'no-access',
    ARCHIVED: 'archived',
    REPO_CONFLICT: 'repo-conflict',
    BRANCH_PROTECTED: 'branch-protected',
    BRANCH_MISSING: 'branch-missing',
    RATE_LIMIT: 'rate-limit',
    CONFLICT: 'conflict',
    NETWORK: 'network',
    // A GitHub-side outage and a request that never came back are both
    // "try again later", but they are not the same advice as a network error
    // and they must not fall into UNKNOWN — an outage answers with an HTML
    // error page, which the copy layer strips, leaving the user a catch-all
    // that tells them to reload something GitHub cannot serve either way.
    SERVER: 'server',
    TIMEOUT: 'timeout',
    INVALID: 'invalid',
    UNKNOWN: 'unknown',
});

const KNOWN_CODES = new Set(Object.values(ERROR_CODES));
const UNKNOWN_MESSAGE = 'GitHub could not complete the request. Reload and try again.';

// A positive whole number of seconds, or null. GitHub states its own retry
// window in headers; carrying it through means the UI can say when to come
// back instead of guessing "a few minutes" at a limit that may last an hour.
const cleanRetryAfter = value => {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
};

class GithubError extends Error {
    constructor(code, message, { status = null, retryAfterSeconds = null, cause = null } = {}) {
        super(message || code);
        this.name = 'GithubError';
        this.code = KNOWN_CODES.has(code) ? code : ERROR_CODES.UNKNOWN;
        this.status = status;
        this.retryAfterSeconds = cleanRetryAfter(retryAfterSeconds);
        if (cause) this.cause = cause;
    }
}

// The shape that crosses the worker/page message boundary. It stays a plain
// object, so everything the copy layer on the far side needs — the retry window
// and the HTTP status — has to ride along explicitly rather than being read off
// a GithubError that does not survive structured cloning.
const publicError = (error, fallbackMessage = UNKNOWN_MESSAGE) => {
    const typed = error instanceof GithubError;
    const retryAfterSeconds = typed ? cleanRetryAfter(error.retryAfterSeconds) : null;
    const status = typed && Number.isInteger(error.status) ? error.status : null;
    return {
        code: typed && KNOWN_CODES.has(error.code) ? error.code : ERROR_CODES.UNKNOWN,
        message: typed ? error.message : (fallbackMessage || UNKNOWN_MESSAGE),
        ...(status == null ? {} : { status }),
        ...(retryAfterSeconds == null ? {} : { retryAfterSeconds }),
    };
};

export const githubErrors = { ERROR_CODES, GithubError, publicError };
