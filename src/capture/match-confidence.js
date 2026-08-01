// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — how a detected summit's confidence is named on screen.
//
// src/capture/capture-core.js classifies every encounter as one of four
// values. Only 'strong' and 'probable' clear the visible-match bar, so most
// surfaces see just those two — but a local-file process bound to a peak the
// track merely brushes offers that peak as an explicit closest-approach
// fallback, and that draft carries 'possible' or 'weak' all the way to the
// ascent form.
//
// Every renderer used to spell the mapping as its own `=== 'strong' ? … : …`
// ternary. Two of them collapsed the four values into two, so the summit
// picker described a peak as "Off track" and the draft banner then announced
// the same peak as a "Probable match" seconds later. Confidence copy is the
// one thing in this product that must not overstate, so the names live here
// and every surface resolves through them — the same reason the upload limits
// live in src/capture/upload-limits.js and the settings bounds live in
// src/settings/settings-schema.js.
//
// Pure by construction: no DOM, no extension APIs, no imports.

// Every value capture-core can assign, strongest first.
// test/capture/match-confidence.test.mjs checks this against the literals
// capture-core actually assigns, so a fifth classification cannot appear
// without a name and a tone.
export const CLASSIFICATIONS = Object.freeze(['strong', 'probable', 'possible', 'weak']);

// Classifications below the visible bar share one name and one tone. The
// distance to the summit is the useful number for those, and each surface
// already shows it; splitting "possible" from "weak" in the label would offer
// a precision the score does not support.
const LABELS = Object.freeze({ strong: 'Strong', probable: 'Probable' });
const TONES = Object.freeze({ strong: 'strong', probable: 'probable' });
const BELOW_BAR_LABEL = 'Off track';
const BELOW_BAR_TONE = 'off';

// The user-facing name: 'Strong', 'Probable', or 'Off track'.
export const matchLabel = classification =>
    LABELS[classification] || BELOW_BAR_LABEL;

// The CSS class suffix a surface appends to its own component name, e.g.
// `bpb-summit-chip-off` / `bpb-draft-banner-off`. Returning a value from a
// closed set is what keeps an unstyled class — which silently falls back to
// the component's light-mode defaults — from reaching the page.
export const matchTone = classification =>
    TONES[classification] || BELOW_BAR_TONE;

export const matchConfidence = { CLASSIFICATIONS, matchLabel, matchTone };
