// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared core of the narrow read-only settings bridges for MAIN-world map
// coordinators. Each bridge names its own message marker and projects only the
// fields its page needs; storage and write access stay in the isolated world.

import { settings as S } from '../settings/settings.ts';

type Settings = Record<string, unknown>;

export function startMapSettingsBridge(marker: string, project: (settings: Settings) => Record<string, unknown>): void {
    const send = (settings: Settings) => window.postMessage({
        [marker]: true,
        dir: 'toPage',
        ...project(settings),
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
        if (!data || data[marker] !== true || data.dir !== 'toCS' || data.type !== 'get') return;
        await read();
    });

    S.subscribe((settings: Settings) => { settingsGeneration++; send(settings); });
    window.addEventListener('pagehide', () => { settingsGeneration++; });
    window.addEventListener('pageshow', event => { if (event.persisted) void read(); });
}
