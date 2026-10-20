// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// The first elevation unit is Peakbagger's display preference. Keep this
// native-heading probe shared by peak surfaces; conversion and overrides
// remain owned by ui/units.js. Missing or ambiguous metadata is inconclusive.
export function readPeakUnitSystem(doc) {
    const headings = [...doc.querySelectorAll('h2')].filter(node => /^Elevation:/i.test(node.textContent.trim()));
    if (headings.length !== 1) return null;
    const match = /^Elevation:\s*[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(meters?|metres?|m|feet|foot|ft)\b/i
        .exec(headings[0].textContent.trim());
    return match ? /^m/i.test(match[1]) ? 'metric' : 'imperial' : null;
}
