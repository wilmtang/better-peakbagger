// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One bound on how long any third-party request may take. Every outbound
// transport — Peakbagger, GitHub, ImgBB, the terrain style host — races its
// fetch and its body read against a deadline, because a hung connection is the
// one failure a status code never reports: a captive portal, a black-holing
// proxy, or a stalled TLS handshake leaves the promise pending forever, and the
// surface waiting on it shows a spinner with no error and no way out. A slow
// service must become a stated failure, not an indefinite wait.
//
// The deadline both aborts the request (so the socket is released) and rejects
// the race (so callers still fail on an injected or non-conforming fetch that
// ignores `signal`). Pure with respect to the extension: no DOM, no extension
// APIs, and every timing primitive is looked up defensively so the module works
// unchanged in the worker, page world, and jsdom tests.

const DEFAULT_TIMEOUT_MS = 15000;

const timeoutError = limit => Object.assign(
    new Error(`Request exceeded its ${limit} ms deadline.`),
    { name: 'TimeoutError' },
);

// True for the rejection this module raises, and for the `TimeoutError` a
// platform `AbortSignal.timeout()` would raise, so callers classify one name.
const isTimeout = error => !!error && error.name === 'TimeoutError';

// A deadline is armed on creation and shared by every step of one logical
// request, so a fast response followed by a stalled body read still fails —
// the timeout covers the whole exchange rather than restarting per await.
const createRequestDeadline = (timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const limit = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let expired = false;
    let timer = null;
    let expiry = null;

    if (typeof globalThis.setTimeout === 'function') {
        expiry = new Promise((_, reject) => {
            timer = globalThis.setTimeout(() => {
                expired = true;
                if (controller) controller.abort();
                reject(timeoutError(limit));
            }, limit);
        });
        // `run()` observes this rejection only when the deadline actually wins a
        // race. Attach a terminal handler so a request that finishes first — or
        // one whose caller never raced at all — cannot surface the expiry as an
        // unhandled rejection and take down an MV3 worker.
        expiry.catch(() => {});
    }

    const clear = () => {
        if (timer !== null && typeof globalThis.clearTimeout === 'function') {
            globalThis.clearTimeout(timer);
        }
        timer = null;
    };

    return {
        // Pass to fetch so the socket is released, not merely abandoned.
        signal: controller ? controller.signal : undefined,
        // Whether the deadline — rather than the network or the caller — ended
        // the request. Callers use it to separate "too slow" from "unreachable",
        // which are different sentences and different remedies.
        get expired() { return expired; },
        run: promise => (expiry ? Promise.race([promise, expiry]) : promise),
        // Cancel early: lets a caller-supplied AbortSignal tear down the same
        // request without needing AbortSignal.any(), which is newer than the
        // browsers this extension supports.
        //
        // The deadline stays armed on purpose. Aborting only asks the transport
        // to stop, and a transport that does not honour the request — an
        // injected fetch, or one handed an already-aborted signal it never
        // reports on — would otherwise leave nothing at all to settle the race.
        // Disarming here would remove the last guarantee precisely when the
        // cancellation has already been ignored. `clear()` is the explicit
        // teardown, and callers run it once the exchange is genuinely over.
        abort: () => { if (controller) controller.abort(); },
        // Always call once the exchange is over; a live timer would otherwise
        // keep an MV3 worker awake and abort a socket nobody is reading.
        clear,
    };
};

export const requestDeadline = { DEFAULT_TIMEOUT_MS, createRequestDeadline, isTimeout };
