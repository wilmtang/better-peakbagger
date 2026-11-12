// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readPeakElevationText } from './peak-page-fields.ts';

// The first elevation unit is Peakbagger's display preference. Keep this
// native-heading probe shared by peak surfaces; conversion and overrides
// remain owned by ui/units.js. Missing or ambiguous metadata is inconclusive.
export function readPeakUnitSystem(doc: Document): 'metric' | 'imperial' | null {
    const text = readPeakElevationText(doc);
    const match = text === null ? null
        : /^[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(meters?|metres?|m|feet|foot|ft)\b/i.exec(text);
    return match ? /^m/i.test(match[1]) ? 'metric' : 'imperial' : null;
}
