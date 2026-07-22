// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure response classification for authenticated Peakbagger reads. HTTP 200
// alone is not evidence that Peakbagger returned the requested resource:
// redirects, login pages, and PBError.aspx can finish with a successful status.

import { peakbaggerCloudflare as Cloudflare } from './peakbagger-cloudflare.js';

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
    if (Cloudflare.isManagedChallenge(status, headers, body)) return 'challenged';
    if (status === 0 || status === 429 || status >= 500) return 'transient';
    if (status < 200 || status >= 300) return 'wrong-content';
    return matchesExpectedContent(body, kind) ? 'ok' : 'wrong-content';
};

export const peakbaggerResponse = { classifyResponse };
