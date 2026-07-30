// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the vector drape's style fetch, kept out of the MapLibre
// frame so it can be tested without one.
//
// This owns exactly the part that has nothing to do with rendering: reach a
// third-party style host under a deadline, and refuse anything that is not a
// style document. Grafting the result into the live map stays in
// src/terrain/terrain-frame.js, where MapLibre lives.
//
// The bound matters more here than the shape check. The drape picker has
// already switched to the vector entry by the time this resolves, so a style
// host that accepts the connection and never answers leaves that entry selected
// with nothing drawn and no notice — a blank drape reads as a broken feature
// rather than an unavailable one. A deadline turns that into the same
// terrain-only fallback every other style failure takes.

import { requestDeadline as Deadline } from '../net/request-deadline.js';

// A drape is an enhancement over a map that already works, so it waits well
// under the frame's own load timeout rather than holding the picker open.
const DEFAULT_TIMEOUT_MS = 10000;

// MapLibre style documents are version 8 with a sources object and a layers
// array. Anything else — an error page, a captive-portal interstitial, a
// redirect to something JSON-shaped — must not reach map.addSource().
const isStyleDocument = style => !!style
    && style.version === 8
    && !!style.sources
    && typeof style.sources === 'object'
    && Array.isArray(style.layers);

// Fetched once per frame lifetime. A failed attempt is forgotten rather than
// cached, so re-selecting the entry retries instead of staying broken for as
// long as the frame is open.
const createVectorStyleLoader = ({
    styleUrl,
    fetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
    if (typeof styleUrl !== 'string' || !styleUrl) {
        throw new TypeError('vector style loader requires a style URL');
    }
    let pending = null;

    const request = async () => {
        const deadline = Deadline.createRequestDeadline(timeoutMs);
        try {
            const response = await deadline.run(fetch(styleUrl, {
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                signal: deadline.signal,
            }));
            if (!response || !response.ok) {
                throw new Error(`Vector style request failed (${response && response.status})`);
            }
            const style = await deadline.run(response.json());
            if (!isStyleDocument(style)) throw new Error('Unexpected vector style shape');
            return style;
        } finally {
            deadline.clear();
        }
    };

    return {
        load: () => {
            if (!pending) {
                pending = request();
                // Attach a terminal handler here rather than relying on the
                // caller having one: this promise is memoized and may be handed
                // out zero times before it settles.
                pending.catch(() => { pending = null; });
            }
            return pending;
        },
    };
};

export const terrainStyle = { DEFAULT_TIMEOUT_MS, createVectorStyleLoader, isStyleDocument };
