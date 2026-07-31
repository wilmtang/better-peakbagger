// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Report presentation for Photo Topos. This does not participate in project
// rendering or raster export: it resolves only the optional width attribute
// sent back to the trip-report editor.

import { settingsSchema as Schema } from '../settings/settings-schema.js';

const CHOICES = Object.freeze([
    Object.freeze({ token: '320', label: 'Small · 320 px', width: 320 }),
    Object.freeze({ token: '480', label: 'Medium · 480 px', width: 480 }),
    Object.freeze({ token: '640', label: 'Large · 640 px', width: 640 }),
    Object.freeze({ token: 'original', label: 'Original', width: null }),
]);

const choiceFromToken = token =>
    CHOICES.find(choice => choice.token === String(token)) || null;

const tokenFromWidth = width => {
    const cleaned = Schema.reportImageWidth(width);
    return CHOICES.find(choice => choice.width === cleaned)?.token
        || String(Schema.DEFAULTS.reportImageWidth);
};

const displayWidth = (sourceWidth, preferredWidth) => {
    if (!Number.isSafeInteger(sourceWidth) || sourceWidth <= 0) return null;
    const cleaned = Schema.reportImageWidth(preferredWidth);
    return cleaned === null ? null : Math.min(sourceWidth, cleaned);
};

export const photoReportSize = {
    CHOICES,
    choiceFromToken,
    tokenFromWidth,
    displayWidth,
};
