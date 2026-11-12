// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a match's classification and confidence read on screen. Confidence is
// the integer percentage capture-core assigns (0–100); it is never rescaled
// here. Every surface that prints a reading uses this so the popup and the
// activity inbox say the same thing, visibly and to assistive technology.
import { matchLabel } from './match-confidence.js';

export interface MatchReading { text: string; spoken: string }

export const matchReading = (classification: string, confidence?: unknown): MatchReading => {
    const label = matchLabel(classification);
    const percent = typeof confidence === 'number' && Number.isFinite(confidence) ? Math.round(confidence) : null;
    return percent === null
        ? { text: label, spoken: `${label} match` }
        : { text: `${label} · ${percent}%`, spoken: `${label} match · ${percent}% confidence` };
};
