// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — MapLibre renderer hosted by terrain/terrain.html.

import * as maplibre from 'maplibre-gl';
import { settings } from '../settings/settings.js';
import { startTerrainFrame } from './terrain-frame-runtime.js';

// A web-accessible extension frame can be embedded directly by a Peakbagger
// page. Read the authoritative feature gate in the frame itself before even
// installing the MapLibre activation listener; the one-use worker capability
// remains a second, independent requirement for each init/resume.
void settings.requireCurrent().then(current => {
    if (current.enable3dMap === true) startTerrainFrame(maplibre);
}, () => {});
