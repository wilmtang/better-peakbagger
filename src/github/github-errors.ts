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
} as const);

export type GithubErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface GithubErrorOptions {
    status?: number | null;
    retryAfterSeconds?: number | null;
    cause?: unknown;
}

export interface PublicGithubError {
    code: GithubErrorCode;
    message: string;
    status?: number;
    retryAfterSeconds?: number;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));
const isKnownCode = (code: unknown): code is GithubErrorCode => typeof code === 'string' && KNOWN_CODES.has(code);
const UNKNOWN_MESSAGE = 'GitHub could not complete the request. Reload and try again.';

// A positive whole number of seconds, or null. GitHub states its own retry
// window in headers; carrying it through means the UI can say when to come
// back instead of guessing "a few minutes" at a limit that may last an hour.
const cleanRetryAfter = (value: unknown): number | null => {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
};

class GithubError extends Error {
    code: GithubErrorCode;
    status: number | null;
    retryAfterSeconds: number | null;

    constructor(
        code: GithubErrorCode | string,
        message?: string | null,
        { status = null, retryAfterSeconds = null, cause = null }: GithubErrorOptions = {},
    ) {
        super(message || code);
        this.name = 'GithubError';
        this.code = isKnownCode(code) ? code : ERROR_CODES.UNKNOWN;
        this.status = status;
        this.retryAfterSeconds = cleanRetryAfter(retryAfterSeconds);
        if (cause) this.cause = cause;
    }
}

export type { GithubError };

// The shape that crosses the worker/page message boundary. It stays a plain
// object, so everything the copy layer on the far side needs — the retry window
// and the HTTP status — has to ride along explicitly rather than being read off
// a GithubError that does not survive structured cloning.
const publicError = (error: unknown, fallbackMessage: string | null = UNKNOWN_MESSAGE): PublicGithubError => {
    const typed = error instanceof GithubError ? error : null;
    const retryAfterSeconds = typed ? cleanRetryAfter(typed.retryAfterSeconds) : null;
    const status = typed && typeof typed.status === 'number' && Number.isInteger(typed.status)
        ? typed.status
        : null;
    return {
        code: typed && isKnownCode(typed.code) ? typed.code : ERROR_CODES.UNKNOWN,
        message: typed ? typed.message : (fallbackMessage || UNKNOWN_MESSAGE),
        ...(status == null ? {} : { status }),
        ...(retryAfterSeconds == null ? {} : { retryAfterSeconds }),
    };
};

export const githubErrors = { ERROR_CODES, GithubError, publicError };
