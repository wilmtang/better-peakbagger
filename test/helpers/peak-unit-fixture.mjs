// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const peakUnitHeadings = [
    ['4391.0 meters, 14,406.2 feet', 'metric'],
    ['4,391.0 m, 14,406.2 ft', 'metric'],
    ['14,406.2 feet, 4391.0 meters', 'imperial'],
    ['14,406.2 ft, 4,391.0 m', 'imperial'],
];
export const withPeakElevation = (html, heading) => html.replace(/<h2>Elevation:[^<]*<\/h2>/,
    `<h2>Elevation: ${heading}</h2>`);
