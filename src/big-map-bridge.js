// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Narrow read-only bridge for the MAIN-world BigMap enhancer. It exposes only
// the validated route width, not the full settings object or a settings write
// path.

(() => {
    'use strict';
    const S = globalThis.BPBSettings;
    if (!S) return;

    const send = settings => window.postMessage({
        __bpbBigMap: true,
        dir: 'toPage',
        routeWidth: settings.mapRouteWidth
    }, location.origin);

    window.addEventListener('message', async event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpbBigMap !== true || data.dir !== 'toCS' || data.type !== 'get') return;
        send(await S.get());
    });

    S.subscribe(send);
})();
