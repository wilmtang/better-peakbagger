// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One fail-closed boundary for user-triggered Peakbagger HTML and GPX reads.
// It owns origin validation, authenticated fetch policy, timeout handling,
// response classification, bounded error details, and DOM parser failures.

import { peakbaggerError as PeakbaggerError } from './peakbagger-error.js';
import { isPeakbaggerUrl } from './peakbagger-origin.js';
import { classifyResponse } from './peakbagger-response.js';
import { requestDeadline as Deadline } from '../net/request-deadline.js';
import { boundedText as BoundedText } from '../net/bounded-text.js';
import {
    MAX_GPX_TEXT_CHARS,
    peakbaggerResponseLimit,
} from '../capture/capture-resource-limits.js';

const DEFAULT_TIMEOUT_MS = 15000;
const OWNER_REQUIRED_KINDS = new Set(['buddies', 'edit', 'list']);

const trim = value => (typeof value === 'string' ? value : value == null ? '' : String(value)).trim();
const pageName = value => {
    try { return new URL(value).pathname.split('/').filter(Boolean).pop() || ''; }
    catch { return ''; }
};
const looksSignedOut = (text, kind, resolvedUrl) => {
    const body = typeof text === 'string' ? text : '';
    let redirectedToLogin = false;
    try { redirectedToLogin = /\/Default\.aspx$/i.test(new URL(resolvedUrl).pathname); }
    catch { /* the requested URL is validated separately */ }
    const ownerCue = /(?:My Home Page|My Ascents|Add Ascent|Edit Account)/i.test(body);
    if (redirectedToLogin) return !ownerCue;
    if (!OWNER_REQUIRED_KINDS.has(kind)) return false;
    const loginCue = /(?:href=["'][^"']*Default\.aspx[^"']*["'][^>]*>[\s\S]{0,60}?Log\s*In|\bPasswordText\b|\bLoginButton\b)/i.test(body);
    return loginCue && !ownerCue;
};
const baseResult = ({ requestedUrl, response }) => ({
    requestedUrl,
    url: trim(response && response.url) || requestedUrl,
    status: Number(response && response.status) || (response && response.ok === true ? 200 : 0),
    redirected: !!(response && response.redirected),
});
const rejected = (base, orchestrationKind, error) => ({
    kind: orchestrationKind,
    requestedUrl: base.requestedUrl,
    url: base.url,
    status: base.status,
    redirected: base.redirected,
    error,
    reason: PeakbaggerError.message(error),
});

const responseFailure = (classification, base, text, resource) => {
    let code;
    if (classification === 'challenged') code = 'cloudflare';
    else if (base.status === 429) code = 'rate-limit';
    else if (classification === 'transient' && base.status >= 500) code = 'server';
    else if (classification === 'transient') code = 'network';
    else if (base.status === 401 || looksSignedOut(text, resource, base.url)) code = 'signed-out';
    else if (base.status === 404) code = 'not-found';
    else if (base.status < 200 || base.status >= 300) code = 'http';
    else code = 'unexpected-content';
    return PeakbaggerError.failure(code, {
        resource,
        status: base.status,
        ...(base.redirected && pageName(base.url) ? { redirectedTo: pageName(base.url) } : {}),
    });
};

export const fetchPeakbaggerResource = async (url, {
    kind = 'edit',
    fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    init = {},
    signal = init.signal,
} = {}) => {
    const requestedUrl = trim(url);
    if (!isPeakbaggerUrl(requestedUrl) || typeof fetchFn !== 'function') {
        const base = { requestedUrl, url: requestedUrl, status: 0, redirected: false };
        const error = PeakbaggerError.failure('invalid-request', { resource: kind });
        return rejected(base, 'wrong-content', error);
    }

    // One deadline covers the fetch and the body read together, so a prompt
    // header followed by a stalled stream still fails.
    const deadline = Deadline.createRequestDeadline(timeoutMs);
    const timedOut = cause => deadline.expired || Deadline.isTimeout(cause);
    let cancelled = false;
    let rejectCancellation = null;
    const cancellation = signal ? new Promise((_, reject) => { rejectCancellation = reject; }) : null;
    cancellation?.catch(() => {});
    const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        deadline.abort();
        rejectCancellation?.(Object.assign(new Error('Peakbagger request cancelled.'), { name: 'AbortError' }));
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const run = promise => deadline.run(cancellation ? Promise.race([promise, cancellation]) : promise);
    const clear = () => {
        deadline.clear();
        signal?.removeEventListener('abort', cancel);
    };
    let response;
    try {
        response = await run(fetchFn(requestedUrl, {
            ...init,
            credentials: 'include',
            redirect: 'follow',
            cache: 'no-store',
            ...(deadline.signal ? { signal: deadline.signal } : {}),
        }));
    } catch (cause) {
        clear();
        const base = { requestedUrl, url: requestedUrl, status: 0, redirected: false };
        const code = cancelled ? 'cancelled' : timedOut(cause) ? 'timeout' : 'network';
        return rejected(base, 'transient', PeakbaggerError.failure(code, { resource: kind }));
    }

    const base = baseResult({ requestedUrl, response });
    let text;
    try {
        const maxBytes = peakbaggerResponseLimit(kind);
        text = await run(BoundedText.readBoundedResponseText(response, {
            maxBytes,
            maxChars: kind === 'gpx' ? MAX_GPX_TEXT_CHARS : maxBytes,
            signal: deadline.signal,
            label: `Peakbagger ${kind} response`,
        }));
    } catch (cause) {
        clear();
        const tooLarge = BoundedText.isLimitError(cause);
        const code = cancelled ? 'cancelled'
            : tooLarge ? 'response-too-large'
                : timedOut(cause) ? 'timeout' : 'response-read';
        return rejected(base, tooLarge ? 'wrong-content' : 'transient', PeakbaggerError.failure(code, {
            resource: kind,
            status: base.status,
        }));
    }
    clear();

    const classification = classifyResponse(base.status, response && response.headers, text, { kind });
    if (classification !== 'ok') {
        return rejected(base, classification, responseFailure(classification, base, text, kind));
    }
    return { kind: 'ok', ...base, text };
};

export const fetchPeakbaggerDocument = async (url, {
    mimeType = 'text/html',
    parser = globalThis.DOMParser,
    ...options
} = {}) => {
    const result = await fetchPeakbaggerResource(url, options);
    if (result.kind !== 'ok') return result;
    let document;
    try {
        if (typeof parser !== 'function') throw new TypeError('DOMParser is unavailable');
        document = new parser().parseFromString(result.text, mimeType);
        if (!document || typeof document.querySelector !== 'function'
            || (mimeType !== 'text/html' && document.querySelector('parsererror'))) {
            throw new Error('DOMParser rejected the response');
        }
    } catch {
        const error = PeakbaggerError.failure('parse', {
            resource: options.kind || 'edit',
            status: result.status,
        });
        return rejected(result, 'wrong-content', error);
    }
    return { ...result, document };
};

export const peakbaggerRequest = { fetchPeakbaggerDocument, fetchPeakbaggerResource };
