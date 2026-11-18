// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stable, actionable copy for live Peakbagger failures. Callers pass typed
// failures from peakbagger-request.js instead of translating transport and
// page-shape failures independently on every surface.

import { peakbaggerCloudflare as Cloudflare, type CloudflareRecovery } from './peakbagger-cloudflare.ts';
import type { PeakbaggerResourceKind } from './peakbagger-response.ts';
import { rateLimitMessage } from '../net/rate-limit.ts';

export type PeakbaggerErrorCode =
    | 'cloudflare'
    | 'signed-out'
    | 'network'
    | 'timeout'
    | 'cancelled'
    | 'response-read'
    | 'response-too-large'
    | 'rate-limit'
    | 'server'
    | 'not-found'
    | 'http'
    | 'unexpected-content'
    | 'parse'
    | 'identity-mismatch'
    | 'invalid-request'
    | 'storage'
    | 'buddy-cache-unavailable'
    | 'buddy-cache-read'
    | 'buddy-cache-stale';

export interface PeakbaggerFailureDetails {
    resource?: PeakbaggerResourceKind | string;
    status?: number;
    retryAt?: number | null;
    redirectedTo?: string;
    [key: string]: unknown;
}

export interface PeakbaggerErrorLike {
    source?: string;
    code?: PeakbaggerErrorCode | string;
    resource?: PeakbaggerResourceKind | string;
    status?: number;
    retryAt?: number | null;
    redirectedTo?: string;
}

export interface PeakbaggerFailure {
    source: 'peakbagger';
    code: PeakbaggerErrorCode;
    resource?: PeakbaggerResourceKind | string;
    status?: number;
    retryAt?: number | null;
    redirectedTo?: string;
    [key: string]: unknown;
}

export interface PeakbaggerMessageOptions {
    resource?: PeakbaggerResourceKind | string;
    fallback?: string;
}

export interface PeakbaggerRecoveryOptions {
    url?: string;
    label?: string;
}

export type PeakbaggerRecoveryAction = CloudflareRecovery;

const RESOURCE_NAMES: Readonly<Record<string, string>> = Object.freeze({
    buddies: 'Buddy List',
    climber: 'climber page',
    edit: 'saved ascent form',
    list: 'ascent list',
    gpx: 'GPS track',
    peaks: 'nearby summit data',
    html: 'Peakbagger page',
});

const cleanDetail = (value: unknown): string => {
    const detail = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!detail || /^<(?:!doctype|html)\b/i.test(detail)) return '';
    return detail.length > 180 ? `${detail.slice(0, 179)}…` : detail;
};

const errorRecord = (error: unknown): Record<string, unknown> | null =>
    error && typeof error === 'object' ? error as Record<string, unknown> : null;

const errorCode = (error: unknown): string => {
    if (typeof error === 'string') return error;
    const code = errorRecord(error)?.code;
    return typeof code === 'string' ? code : '';
};

const resourceName = (error: unknown, explicit?: string): string => {
    if (explicit) return explicit;
    const resource = errorRecord(error)?.resource;
    return (typeof resource === 'string' && Object.hasOwn(RESOURCE_NAMES, resource)
        ? RESOURCE_NAMES[resource]
        : undefined) || 'Peakbagger page';
};

const message = (
    error: unknown,
    { resource, fallback = 'Peakbagger could not complete the request. Try again.' }: PeakbaggerMessageOptions = {},
): string => {
    const code = errorCode(error);
    const name = resourceName(error, resource);
    const record = errorRecord(error);
    const status = Number(record?.status) || 0;
    const destination = cleanDetail(record?.redirectedTo);
    const redirected = destination ? ` (redirected to ${destination})` : '';
    const messages: Record<string, string> = {
        cloudflare: Cloudflare.copy.message,
        'signed-out': `Peakbagger could not verify your signed-in account while loading the ${name}. Sign in, then try again.`,
        network: `Better Peakbagger could not reach Peakbagger for the ${name}. Check your connection and try again.`,
        timeout: `Peakbagger took too long to return the ${name}. Try again.`,
        cancelled: `Loading the ${name} was cancelled.`,
        'response-read': `Peakbagger responded, but the ${name} could not be read. Try again.`,
        'response-too-large': `Peakbagger returned more ${name} data than Better Peakbagger can process safely. Try a narrower request.`,
        'rate-limit': rateLimitMessage('Peakbagger', record?.retryAt),
        server: `Peakbagger is temporarily unavailable${status ? ` (HTTP ${status})` : ''}. Try again later.`,
        'not-found': `Peakbagger could not find the requested ${name}.`,
        http: `Peakbagger returned HTTP ${status || 'an error'} while loading the ${name}.`,
        'unexpected-content': `Peakbagger returned an unexpected page instead of the ${name}${redirected}. Reload Peakbagger and try again.`,
        parse: `Better Peakbagger could not parse the ${name}. Peakbagger may have changed the page.`,
        'identity-mismatch': `The ${name} belongs to a different Peakbagger account. Nothing was changed.`,
        'invalid-request': 'Better Peakbagger refused an invalid Peakbagger request.',
        storage: `The ${name} loaded, but Better Peakbagger could not save it on this device.`,
        'buddy-cache-unavailable': 'Better Peakbagger could not start this action. Reload the extension, then reload this page and try again.',
        'buddy-cache-read': 'Better Peakbagger could not read your saved Buddy List. Try again.',
        'buddy-cache-stale': 'Your Buddy List changed during refresh. Refresh again.',
    };
    return (Object.hasOwn(messages, code) ? messages[code] : undefined) || fallback;
};

const recovery = (
    error: unknown,
    { url = 'https://www.peakbagger.com/', label = 'Open Peakbagger' }: PeakbaggerRecoveryOptions = {},
): PeakbaggerRecoveryAction | null => {
    const code = errorCode(error);
    if (['storage', 'invalid-request', 'buddy-cache-unavailable', 'buddy-cache-read'].includes(code)) return null;
    if (code === 'signed-out') {
        return { label: 'Sign in to Peakbagger', href: 'https://www.peakbagger.com/Default.aspx' };
    }
    if (code === 'cloudflare') return Cloudflare.recovery({ url });
    return { label, href: url };
};

const failure = (code: PeakbaggerErrorCode, details: PeakbaggerFailureDetails = {}): PeakbaggerFailure => ({
    source: 'peakbagger',
    code,
    ...details,
});

const exception = <T extends PeakbaggerErrorLike | null | undefined = PeakbaggerFailure>(
    error: T,
    options?: PeakbaggerMessageOptions,
): Error & (T extends object ? T : Record<string, never>) =>
    Object.assign(new Error(message(error, options)), error ?? {}) as Error & (T extends object ? T : Record<string, never>);

export const peakbaggerError = { exception, failure, message, recovery };
