// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { PEAKBAGGER_HOSTS } from '../peakbagger/peakbagger-origin.js';
import { protectReportHeaders } from './report-security-policy.js';
// Register synchronously on every background boot, before storage or routes.
// Chrome uses the packaged static rules instead; no async install gap.
globalThis.browser?.webRequest?.onHeadersReceived?.addListener(protectReportHeaders, {
    urls: [...PEAKBAGGER_HOSTS].map(host => `https://${host}/*`),
    types: ['main_frame', 'sub_frame'],
}, ['blocking', 'responseHeaders']);
