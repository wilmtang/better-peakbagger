// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure response classification for authenticated Peakbagger reads. HTTP 200
// alone is not evidence that Peakbagger returned the requested resource:
// redirects, login pages, Cloudflare challenges, and PBError.aspx all commonly
// finish with a successful status.

const trim = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const headerValue = (headers, name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return trim(headers.get(name));
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? trim(headers[key]) : '';
};

const CHALLENGE_MARKERS = [
    /\bcf-chl-/i,
    /\b_cf_chl_opt\b/i,
    /challenge-platform/i,
    /cloudflare[^<]{0,80}(?:challenge|human|verification)/i,
    /<title>\s*just a moment/i,
    /attention required[^<]{0,80}cloudflare/i,
];

const matchesExpectedContent = (body, kind) => {
    if (kind === 'html') return /<(?:!doctype\s+html|[a-z][a-z0-9:-]*)\b/i.test(body);
    if (kind === 'peaks') return !/<(?:!doctype\s+html|html|body|form)\b/i.test(body);
    if (kind === 'gpx') return /<gpx\b/i.test(body);
    if (kind === 'list') {
        return /ClimbListC\.aspx/i.test(body) && /(?:My Ascents|Ascent List)/i.test(body);
    }
    if (kind === 'buddies') {
        return /\bid=["']RGridView["']/i.test(body) && /Buddy List/i.test(body);
    }
    if (kind === 'climber') {
        return /<h1\b[^>]*>/i.test(body) && /ClimbListC\.aspx\?[^"'<>]*\bcid=\d+/i.test(body);
    }
    return /<form\b[^>]*(?:id|name)=["']Form1["']/i.test(body)
        && /\bJournalText\b/i.test(body)
        && /\bDateText\b/i.test(body)
        && /\bPeakListBox\b/i.test(body);
};

export const classifyResponse = (status, headers, bodyText, { kind = 'edit' } = {}) => {
    const body = typeof bodyText === 'string' ? bodyText : '';
    // Some successful Buddy responses carry Cloudflare mitigation metadata in
    // an otherwise complete page. The report signature is resource-specific,
    // and its signed-in owner is validated after parsing, so it is stronger
    // evidence than a generic challenge marker on a successful response.
    if (status >= 200 && status < 300
        && kind === 'buddies' && matchesExpectedContent(body, kind)) return 'ok';
    if (/challenge/i.test(headerValue(headers, 'cf-mitigated'))
        || CHALLENGE_MARKERS.some(pattern => pattern.test(body))
        || status === 403) return 'challenged';
    if (status === 0 || status === 429 || status >= 500) return 'transient';
    if (status < 200 || status >= 300) return 'wrong-content';
    return matchesExpectedContent(body, kind) ? 'ok' : 'wrong-content';
};

export const peakbaggerResponse = { classifyResponse };
