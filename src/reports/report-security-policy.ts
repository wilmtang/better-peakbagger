// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import rules from './report-protection.json' with { type: 'json' };
import { peakbaggerCloudflare as Cloudflare } from '../peakbagger/peakbagger-cloudflare.js';
import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.js';

export const REPORT_CSP = rules[0].action.responseHeaders![0].value;
const policy = rules.map(rule => ({ priority: rule.priority, action: rule.action.type,
    types: new Set<string>(rule.condition.resourceTypes),
    match: new RegExp(rule.condition.regexFilter, rule.condition.isUrlFilterCaseSensitive ? '' : 'i') }));

export function protectedReportDocument(value: unknown, type = 'main_frame'): boolean {
    if (typeof value !== 'string' || !['main_frame', 'sub_frame'].includes(type) || !isPeakbaggerUrl(value)) return false;
    const url = new URL(value);
    // Browser request URLs have a canonical origin. Credentials are not part of
    // that origin and must not change route policy in direct helper callers.
    const request = url.origin + url.pathname + url.search + url.hash;
    const matched = policy.filter(rule => rule.types.has(type) && rule.match.test(request));
    const allowed = Math.max(0, ...matched.filter(rule => rule.action === 'allow').map(rule => rule.priority));
    // DNR ignores modifyHeaders rules at or below the highest matching allow.
    return matched.some(rule => rule.action === 'modifyHeaders' && rule.priority > allowed);
}

interface ResponseHeader { name: string; value?: string; binaryValue?: number[] }
interface ReportHeaders { url: string; type?: string; responseHeaders?: ResponseHeader[] }
export function protectReportHeaders({ url, type = 'main_frame', responseHeaders = [] }: ReportHeaders) {
    if (!protectedReportDocument(url, type)
        || Cloudflare.hasChallengeHeader(Object.fromEntries(responseHeaders.map(header => [header.name, header.value])))) return {};
    return { responseHeaders: [...responseHeaders, { name: 'Content-Security-Policy', value: REPORT_CSP }] };
}
