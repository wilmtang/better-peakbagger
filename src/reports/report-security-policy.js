// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import rules from './report-protection.json' with { type: 'json' };
import { peakbaggerCloudflare as Cloudflare } from '../peakbagger/peakbagger-cloudflare.js';
import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.js';

export const REPORT_CSP = rules[0].action.responseHeaders[0].value;
export function protectedReportDocument(value, type = 'main_frame') {
    if (!isPeakbaggerUrl(value)) return false;
    const raw = new URL(value).pathname;
    if (raw.includes('%')) return true;
    const path = raw.toLowerCase().replace(/\/+/g, '/');
    if (type === 'sub_frame') return path !== '/map/mastermap.aspx';
    return type === 'main_frame' && /^\/climber\/ascent\.aspx(?:[\/;]|$)/.test(path);
}
export function protectReportHeaders({ url, type, responseHeaders = [] }) {
    if (!protectedReportDocument(url, type)
        || Cloudflare.hasChallengeHeader(Object.fromEntries(responseHeaders.map(header => [header.name, header.value])))) return {};
    return { responseHeaders: [...responseHeaders, { name: 'Content-Security-Policy', value: REPORT_CSP }] };
}
