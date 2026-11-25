// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import legend from '../fixtures/maps/snow-depth-legend.json' with { type: 'json' };
export const snowDepthSwatch = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
export const snowDepthCatalogue = (time = Date.UTC(2026, 9, 30)) => ({ features: [{ attributes: { idp_validtime: time } }] });
// Public NOAA legend captured October 31, 2026. Preserve the provider's PNG
// swatches and all twelve depth classes for faithful compact-menu checks.
export const snowDepthLegend = () => structuredClone(legend);
