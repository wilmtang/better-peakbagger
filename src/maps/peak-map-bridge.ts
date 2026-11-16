// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Narrow read-only settings bridge for the MAIN-world Peak-page 3D
// coordinator. The page receives only the feature gates, theme preference, and
// terrain cache budget it needs; storage and write access stay isolated.

import { startMapSettingsBridge } from './map-settings-bridge.ts';

startMapSettingsBridge('__bpbPeakMap', settings => ({
    enable3dMap: settings.enable3dMap === true,
    showSunMoon: settings.showSunMoon,
    theme: settings.theme,
    terrainCacheLimitMb: settings.terrainCacheLimitMb
}));
