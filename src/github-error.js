// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// User-facing GitHub error copy shared by setup and backup surfaces. Typed
// failures get stable, actionable language; an unexpected GitHub message is
// shown only as bounded plain text so the UI does not replace useful detail
// with a vague catch-all or dump an HTML error page into the extension.

const ERROR_TEXT = Object.freeze({
    auth: 'GitHub authorization is no longer valid. Disconnect and connect GitHub again.',
    denied: 'GitHub authorization was declined. Connect again and approve the request on GitHub.',
    expired: 'The GitHub authorization code expired before approval. Connect again for a new code.',
    cancelled: 'GitHub connection was cancelled before authorization finished.',
    'device-flow-disabled': 'GitHub device authorization is disabled for this app. Please report this extension error.',
    unsupported: 'GitHub does not support the authorization request sent by this extension. Please report this extension error.',
    'no-token': 'The GitHub connection was lost before authorization finished. Connect GitHub again.',
    'no-access': 'Better Peakbagger no longer has access to this repository. Grant access on GitHub or choose another repository.',
    archived: 'This repository is archived, so GitHub will not accept backup commits. Choose a writable repository.',
    'repo-conflict': 'This repository contains backup-like paths that Better Peakbagger cannot safely adopt. Choose another repository.',
    'branch-protected': 'GitHub branch rules blocked the backup commit. Allow direct commits or choose another repository.',
    'branch-missing': 'This non-empty repository has no usable default branch. Create its default branch or choose another repository.',
    'rate-limit': 'GitHub is temporarily rate-limiting requests. Wait a few minutes, then try again.',
    conflict: 'The repository changed while the backup was being committed. Try the backup again.',
    network: 'Better Peakbagger could not reach GitHub. Check your connection and try again.',
    'not-connected': 'No GitHub repository is connected. Connect one in extension settings first.',
    'no-repo': 'No backup repository is selected. Choose one in extension settings first.',
    'no-data': 'Better Peakbagger could not read enough ascent information to create this backup.',
    disabled: 'GitHub backup is turned off in extension settings.',
});

const cleanDetail = error => {
    if (!error || typeof error.message !== 'string') return '';
    const detail = error.message.replace(/\s+/g, ' ').trim();
    if (!detail || /^<(?:!doctype|html)\b/i.test(detail)) return '';
    return detail.length > 220 ? `${detail.slice(0, 219)}…` : detail;
};

const message = (error, { fallback = 'GitHub did not return an error description. Reload the page and try again.' } = {}) => {
    const code = typeof error === 'string' ? error : error && error.code;
    const detail = cleanDetail(error);
    if (code === 'invalid' && detail) return `GitHub rejected the request: ${detail}`;
    if ((code === 'unknown' || !code) && detail) return `GitHub reported: ${detail}`;
    return ERROR_TEXT[code] || fallback;
};

export const githubError = { message };
