// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Peakbagger-specific Cloudflare managed-challenge detection and recovery copy.
// Response detection mirrors peakbagger-cli: HTTP 403 plus Cloudflare's
// mitigation header or managed-challenge page title. Content scripts have no
// navigation status, so document detection uses the title or challenge markup.

const BODY_PROBE_LENGTH = 2000;

const trim = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const headerValue = (headers, name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return trim(headers.get(name));
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? trim(headers[key]) : '';
};

const isManagedChallenge = (status, headers, bodyText) => {
    if (Number(status) !== 403) return false;
    if (headerValue(headers, 'cf-mitigated').toLowerCase() === 'challenge') return true;
    const body = typeof bodyText === 'string' ? bodyText : '';
    return body.slice(0, BODY_PROBE_LENGTH).includes('Just a moment');
};

const isChallengeDocument = doc => /^Just a moment(?:\.{3}|…)?$/i.test(trim(doc.title))
    || Boolean(doc.querySelector('#challenge-form, #cf-challenge-running'));

const copy = Object.freeze({
    title: 'Peakbagger is asking for a human check',
    message: 'Peakbagger is asking for a human check. Open Peakbagger, complete the check, then try again.',
    action: 'Complete check on Peakbagger',
});

const recovery = ({ url = 'https://www.peakbagger.com/' } = {}) => ({
    label: copy.action,
    href: url,
});

export const peakbaggerCloudflare = {
    BODY_PROBE_LENGTH,
    copy,
    isManagedChallenge,
    isChallengeDocument,
    recovery,
};
