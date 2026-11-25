// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One boundary for failures that may cross from the worker to a product
// surface. Only PublicError instances may carry their message across that
// boundary; browser, storage, and page-world exceptions are logged by their
// owner and reduced to caller-owned recovery copy.

export interface PublicErrorPayload {
    code: string;
    message: string;
}

export interface PublicErrorOptions {
    cause?: unknown;
}

export type PublicErrorFallback = {
    code?: unknown;
    message?: unknown;
} | null | undefined;

const DEFAULT_ERROR: Readonly<PublicErrorPayload> = Object.freeze({
    code: 'unexpected',
    message: 'Better Peakbagger could not complete this action. Reload and try again.',
});

const cleanCode = (value: unknown): string =>
    typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
        ? value
        : DEFAULT_ERROR.code;

const cleanMessage = (value: unknown): string =>
    typeof value === 'string' && value.trim()
        ? value.replace(/\s+/g, ' ').trim().slice(0, 240)
        : DEFAULT_ERROR.message;

class PublicError extends Error {
    code: string;

    constructor(code: unknown, message: unknown, { cause = null }: PublicErrorOptions = {}) {
        super(cleanMessage(message), cause ? { cause } : undefined);
        this.name = 'PublicError';
        this.code = cleanCode(code);
    }
}

export type { PublicError };

const exception = (code: unknown, message: unknown, options?: PublicErrorOptions): PublicError =>
    new PublicError(code, message, options);

const isPublic = (error: unknown): error is PublicError => error instanceof PublicError;

const expose = (error: unknown, fallback: PublicErrorFallback = DEFAULT_ERROR): PublicErrorPayload => {
    const source = isPublic(error) ? error : fallback;
    return {
        code: cleanCode(source?.code),
        message: cleanMessage(source?.message),
    };
};

export const publicErrors = { DEFAULT_ERROR, PublicError, exception, isPublic, expose };
