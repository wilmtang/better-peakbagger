// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Peakbagger-specific Cloudflare managed-challenge detection and recovery copy.
// Response detection mirrors peakbagger-cli: HTTP 403 plus Cloudflare's
// mitigation header or managed-challenge page title. Content scripts have no
// navigation status, so document detection uses the title or challenge markup.

export interface ChallengeDocumentLike {
    title?: unknown;
    querySelector?: (selectors: string) => unknown;
}

export interface CloudflareCopy {
    readonly title: string;
    readonly message: string;
    readonly action: string;
}

export interface CloudflareRecovery {
    label: string;
    href: string;
}

const BODY_PROBE_LENGTH = 2000;
const CHALLENGE_HEADER = 'cf-mitigated';
const CHALLENGE_VALUE = 'challenge';

const trim = (value: unknown): string => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const headerValue = (headers: unknown, name: string): string => {
    if (!headers || typeof headers !== 'object') return '';
    const record = headers as Record<string, unknown>;
    if (typeof record.get === 'function') {
        return trim((record as { get(headerName: string): unknown }).get(name));
    }
    const key = Object.keys(record).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? trim(record[key]) : '';
};

const hasChallengeHeader = (headers: unknown): boolean =>
    headerValue(headers, CHALLENGE_HEADER).toLowerCase() === CHALLENGE_VALUE;

const isManagedChallenge = (status: unknown, headers?: unknown, bodyText?: unknown): boolean => {
    if (Number(status) !== 403) return false;
    if (hasChallengeHeader(headers)) return true;
    const body = typeof bodyText === 'string' ? bodyText : '';
    return body.slice(0, BODY_PROBE_LENGTH).includes('Just a moment');
};

const isChallengeDocument = (doc: ChallengeDocumentLike | null | undefined): boolean => Boolean(doc) && (
    /^Just a moment(?:\.{3}|…)?$/i.test(trim(doc?.title))
    || Boolean(doc?.querySelector?.('#challenge-form, #cf-challenge-running'))
);

const copy: CloudflareCopy = Object.freeze({
    title: 'Peakbagger is asking for a human check',
    message: 'Peakbagger is asking for a human check. Open Peakbagger, complete the check, then try again.',
    action: 'Complete check on Peakbagger',
});

const recovery = ({ url = 'https://www.peakbagger.com/' }: { url?: string } = {}): CloudflareRecovery => ({
    label: copy.action,
    href: url,
});

export const peakbaggerCloudflare = {
    BODY_PROBE_LENGTH,
    CHALLENGE_HEADER,
    CHALLENGE_VALUE,
    hasChallengeHeader,
    copy,
    isManagedChallenge,
    isChallengeDocument,
    recovery,
};
