// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the limits Peakbagger's GPX upload enforces.
//
// Two modules on opposite sides of a trust boundary have to agree on these
// numbers: src/capture/capture-core.js reduces and serializes a track to fit
// them, and src/ascent/ascent-draft.js re-validates the finished GPX against
// them before attaching it to the ascent form. ascent-draft.js used to spell
// both out as bare literals because capture-core is not in its bundle, so a
// change to either number would have left the producer and the verifier
// silently disagreeing — the verifier would refuse a valid upload, or admit an
// oversized one. Same reason src/settings/settings-schema.js owns every
// settings bound.
//
// Pure by construction: no DOM, no extension APIs, no imports.

// Trackpoints plus waypoints in one uploaded GPX.
export const MAX_UPLOAD_POINTS = 3000;
// <trkseg> elements in one uploaded GPX.
export const MAX_TRACK_SEGMENTS = 50;

export const uploadLimits = { MAX_UPLOAD_POINTS, MAX_TRACK_SEGMENTS };
