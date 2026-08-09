// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// User-facing GitHub error copy shared by setup and backup surfaces. Typed
// failures get stable, actionable language; an unexpected GitHub message is
// shown only as bounded plain text so the UI does not replace useful detail
// with a vague catch-all or dump an HTML error page into the extension.

import { githubErrors as GithubErrors } from './github-errors.js';

const { ERROR_CODES } = GithubErrors;

const ERROR_TEXT = Object.freeze({
    [ERROR_CODES.AUTH]: 'GitHub authorization is no longer valid. Disconnect and connect GitHub again.',
    [ERROR_CODES.DENIED]: 'GitHub authorization was declined. Connect again and approve the request on GitHub.',
    [ERROR_CODES.EXPIRED]: 'The GitHub authorization code expired before approval. Connect again for a new code.',
    [ERROR_CODES.CANCELLED]: 'GitHub connection was cancelled before authorization finished.',
    [ERROR_CODES.DEVICE_FLOW_DISABLED]: 'GitHub device authorization is disabled for this app. Please report this extension error.',
    [ERROR_CODES.UNSUPPORTED]: 'GitHub does not support the authorization request sent by this extension. Please report this extension error.',
    'no-token': 'The GitHub connection was lost before authorization finished. Connect GitHub again.',
    [ERROR_CODES.NO_ACCESS]: 'Better Peakbagger no longer has access to this repository. Grant access on GitHub or choose another repository.',
    [ERROR_CODES.ARCHIVED]: 'This repository is archived, so GitHub will not accept backup commits. Choose a writable repository.',
    [ERROR_CODES.REPO_CONFLICT]: 'This repository contains backup-like paths that Better Peakbagger cannot safely adopt. Choose another repository.',
    [ERROR_CODES.BRANCH_PROTECTED]: 'GitHub branch rules blocked the backup commit. Allow direct commits or choose another repository.',
    [ERROR_CODES.BRANCH_MISSING]: 'This non-empty repository has no usable default branch. Create its default branch or choose another repository.',
    [ERROR_CODES.RATE_LIMIT]: 'GitHub is temporarily rate-limiting requests. Wait a few minutes, then try again.',
    [ERROR_CODES.CONFLICT]: 'The repository changed while the backup was being committed. Try the backup again.',
    [ERROR_CODES.NETWORK]: 'Better Peakbagger could not reach GitHub. Check your connection and try again.',
    [ERROR_CODES.SERVER]: 'GitHub is temporarily unavailable. Try again in a few minutes.',
    // Deliberately not "nothing was saved": a request that timed out may still
    // have been applied, and a write surface must not promise otherwise.
    [ERROR_CODES.TIMEOUT]: 'GitHub took too long to respond. Check your connection, then try again.',
    'not-connected': 'No GitHub repository is connected. Connect one in extension settings first.',
    'no-repo': 'No backup repository is selected. Choose one in extension settings first.',
    superseded: 'The GitHub connection changed while this request was finishing. Review the current connection and try again.',
    'no-data': 'Better Peakbagger could not read enough ascent information to create this backup.',
    'peakbagger-read': 'Better Peakbagger could not read the saved ascent form. Reload the page and try again.',
    'peakbagger-track': 'Better Peakbagger could not read the stored GPS track. Reload the page and try again.',
    'settings-unavailable': 'Settings could not be read, so no backup was changed.',
    disabled: 'GitHub backup is turned off in extension settings.',
});

const cleanDetail = error => {
    if (!error || typeof error.message !== 'string') return '';
    const detail = error.message.replace(/\s+/g, ' ').trim();
    if (!detail || /^<(?:!doctype|html)\b/i.test(detail)) return '';
    return detail.length > 220 ? `${detail.slice(0, 219)}…` : detail;
};

// Round GitHub's stated retry window to something a person can act on. A limit
// can clear in seconds or in most of an hour, and "wait a few minutes" is wrong
// advice for the second case, so say the size when GitHub tells us.
const waitText = seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds <= 90) return 'in about a minute';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `in about ${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    return hours <= 1 ? 'in about an hour' : `in about ${hours} hours`;
};

const message = (error, { fallback = 'GitHub did not return an error description. Reload the page and try again.' } = {}) => {
    const code = typeof error === 'string' ? error : error && error.code;
    const detail = cleanDetail(error);
    const status = Number(error && error.status) || 0;
    if (code === ERROR_CODES.RATE_LIMIT) {
        const wait = waitText(Number(error && error.retryAfterSeconds));
        return wait
            ? `GitHub is rate-limiting requests. Try again ${wait}.`
            : ERROR_TEXT[ERROR_CODES.RATE_LIMIT];
    }
    // Name the status: an outage is the one case where the user's next move may
    // be to check GitHub's own status page, and the number is what they report.
    if (code === ERROR_CODES.SERVER && status) {
        return `GitHub is temporarily unavailable (HTTP ${status}). Try again in a few minutes.`;
    }
    if (code === ERROR_CODES.INVALID && detail) return `GitHub rejected the request: ${detail}`;
    if ((code === ERROR_CODES.UNKNOWN || !code) && detail) return `GitHub reported: ${detail}`;
    return ERROR_TEXT[code] || fallback;
};

export const githubError = { message };
