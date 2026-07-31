// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — settings bridge for the MAIN-world GPX analyzer.
// Runs in the isolated world on ascent pages at document_start. The analyzer
// (page MAIN world) cannot touch chrome.storage, so it exchanges settings with
// this bridge over window.postMessage:
//   page -> bridge : { __bpb:true, dir:'toCS',   kind:'get' | 'set', patch }
//   bridge -> page : { __bpb:true, dir:'toPage', settings }
//                 or { __bpb:true, dir:'toPage', kind:'setResult',
//                      requestId, ok, settings?, message? }
// The bridge also pushes updated settings to the page whenever storage changes
// (options page, another tab), so the chart re-themes / re-units live.

import { settings as S } from './settings.js';

// The page world may only write the settings the GPX Analyzer owns.
// Everything else — feature gates, capture privacy options, theme — stays
// writable solely from extension-owned surfaces (options page, popup).
const WRITABLE_KEYS = new Set([
    'units',
    'mapRouteColor', 'mapRouteCasingColor',
    'mapViewportWidth', 'mapViewportHeight',
    'mapLastLayer'
]);

// The page-world panel rolls its inline controls back on a rejected write.
// Carry a sentence it can show, so the analyzer matches what the options
// page says rather than snapping a control back in silence. The underlying
// exception is logged here, never sent: it is browser internals.
const WRITE_FAILED_MESSAGE = 'Settings couldn’t be saved. Try again.';
// A page-world write outside WRITABLE_KEYS is a bug in the caller, not a
// condition the user can act on, so the copy stays generic rather than
// naming a key or inviting a retry that would be refused identically.
const WRITE_REFUSED_MESSAGE = 'That setting can’t be changed from this page.';

const send = (settings, detail = {}) =>
    window.postMessage({ __bpb: true, dir: 'toPage', ...detail, ...(settings && { settings }) }, location.origin);

window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.__bpb !== true || data.dir !== 'toCS') return;

    if (data.kind === 'get') {
        send(await S.get());
    } else if (data.kind === 'set' && data.patch && typeof data.patch === 'object') {
        const patch = Object.fromEntries(Object.entries(data.patch)
            .filter(([key]) => WRITABLE_KEYS.has(key)));
        // A patch with nothing writable left in it is refused, not ignored.
        // Staying silent left the page client's pending write to time out
        // and then blame a storage failure it never had — five seconds
        // after a decision this bridge made immediately.
        if (!Object.keys(patch).length) {
            send(null, {
                kind: 'setResult',
                requestId: data.requestId,
                ok: false,
                message: WRITE_REFUSED_MESSAGE
            });
            return;
        }
        try {
            const next = await S.set(patch);
            send(next, { kind: 'setResult', requestId: data.requestId, ok: true });
        } catch (error) {
            // The MAIN-world client keeps the last confirmed settings and
            // uses this response to roll back its optimistic controls.
            console.warn('Better Peakbagger: page-world settings write failed', error);
            send(null, {
                kind: 'setResult',
                requestId: data.requestId,
                ok: false,
                message: WRITE_FAILED_MESSAGE
            });
        }
    }
});

S.subscribe(settings => send(settings));
