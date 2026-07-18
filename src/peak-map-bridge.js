// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Narrow read-only settings bridge for the MAIN-world Peak-page 3D
// coordinator. The page receives only the feature gate, theme preference, and
// terrain cache budget it needs; storage and write access stay isolated.

import { settings as S } from './settings.js';

    const send = settings => window.postMessage({
        __bpbPeakMap: true,
        dir: 'toPage',
        enable3dMap: settings.enable3dMap === true,
        theme: settings.theme,
        terrainCacheLimitMb: settings.terrainCacheLimitMb
    }, location.origin);

    window.addEventListener('message', async event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__bpbPeakMap !== true || data.dir !== 'toCS' || data.type !== 'get') return;
        send(await S.get());
    });

    S.subscribe(send);
