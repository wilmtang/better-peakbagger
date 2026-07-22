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
    INVALID: 'invalid',
    UNKNOWN: 'unknown',
});

const KNOWN_CODES = new Set(Object.values(ERROR_CODES));

class GithubError extends Error {
    constructor(code, message, { status = null, cause = null } = {}) {
        super(message || code);
        this.name = 'GithubError';
        this.code = KNOWN_CODES.has(code) ? code : ERROR_CODES.UNKNOWN;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

const publicError = (error, fallbackMessage = '') => ({
    code: error && KNOWN_CODES.has(error.code) ? error.code : ERROR_CODES.UNKNOWN,
    message: (error && error.message) || fallbackMessage,
});

export const githubErrors = { ERROR_CODES, GithubError, publicError };
