// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Narrow read-only settings bridge for the MAIN-world Peak-page 3D
// coordinator. The page receives only the feature gates, theme preference, and
// terrain cache budget it needs; storage and write access stay isolated.

import { settings as S } from '../settings/settings.js';

const send = settings => window.postMessage({
    __bpbPeakMap: true,
    dir: 'toPage',
    enable3dMap: settings.enable3dMap === true,
    showSunMoon: settings.showSunMoon,
    theme: settings.theme,
    terrainCacheLimitMb: settings.terrainCacheLimitMb
}, location.origin);

let settingsGeneration = 0;
const read = async () => {
    const generation = ++settingsGeneration;
    const settings = await S.get();
    if (generation === settingsGeneration) send(settings);
};

window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.__bpbPeakMap !== true || data.dir !== 'toCS' || data.type !== 'get') return;
    await read();
});

S.subscribe(settings => { settingsGeneration++; send(settings); });
window.addEventListener('pagehide', () => { settingsGeneration++; });
window.addEventListener('pageshow', event => { if (event.persisted) void read(); });
