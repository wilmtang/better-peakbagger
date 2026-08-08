// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — MapLibre renderer hosted by terrain/terrain.html.

import * as maplibre from 'maplibre-gl';
import { startTerrainFrame } from './terrain-frame-runtime.js';

startTerrainFrame(maplibre);
