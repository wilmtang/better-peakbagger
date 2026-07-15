// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — settings bridge for the MAIN-world GPX analyzer.
// Runs in the isolated world on ascent pages at document_start. The analyzer
// (page MAIN world) cannot touch chrome.storage, so it exchanges settings with
// this bridge over window.postMessage:
//   page -> bridge : { __bpb:true, dir:'toCS',   kind:'get' | 'set', patch }
//   bridge -> page : { __bpb:true, dir:'toPage', settings }
// The bridge also pushes updated settings to the page whenever storage changes
// (options page, another tab), so the chart re-themes / re-units live.

(() => {
    const S = window.BPBSettings;
    if (!S) return;

    // The page world may only write the settings the GPX Analyzer owns.
    // Everything else — feature gates, capture privacy options, theme — stays
    // writable solely from extension-owned surfaces (options page, popup).
    const WRITABLE_KEYS = new Set([
        'units',
        'mapRouteColor', 'mapRouteCasingColor',
        'mapViewportWidth', 'mapViewportHeight',
        'mapLastLayer'
    ]);

    const send = settings => window.postMessage({ __bpb: true, dir: 'toPage', settings }, location.origin);

    window.addEventListener('message', async event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpb !== true || data.dir !== 'toCS') return;

        if (data.kind === 'get') {
            send(await S.get());
        } else if (data.kind === 'set' && data.patch && typeof data.patch === 'object') {
            const patch = Object.fromEntries(Object.entries(data.patch)
                .filter(([key]) => WRITABLE_KEYS.has(key)));
            if (Object.keys(patch).length) await S.set(patch); // storage.onChanged -> subscribe -> pushes back to the page
        }
    });

    S.subscribe(settings => send(settings));
})();
