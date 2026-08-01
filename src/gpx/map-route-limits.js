// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the bounds on route geometry handed to the 3D renderer.
//
// Two modules on opposite sides of a trust boundary have to agree on these
// numbers. src/gpx/gpx-metrics.js is the producer: it samples an ascent or
// Full Screen route down to fit them before a MAIN-world coordinator posts it
// across the bridge. src/terrain/terrain-frame.js is the verifier: the frame
// re-checks the arriving payload all-or-nothing, because a page message is
// untrusted no matter how narrow the sender believed it to be.
//
// Both used to spell the numbers out as bare literals in bundles that never
// import each other, and the segment bound was not even named on the producer
// side — it only existed as `segments.length * 2 > MAX_MAP_ROUTE_POINTS`. A
// change to either number would have left the two silently disagreeing, and
// the visible result is not a lint failure but a route that vanishes: the
// frame rejects the whole payload and the user gets the generic "3D map could
// not start" surface for geometry that was in fact fine. Same reason
// src/capture/upload-limits.js exists for Peakbagger's upload bounds, and
// src/settings/settings-schema.js for every settings bound.
//
// Pure by construction: no DOM, no extension APIs, no imports.

// Coordinates across every segment of one route payload.
export const MAX_MAP_ROUTE_POINTS = 3000;
// Segments in one route payload. Every segment needs both endpoints or the
// overlay would bridge a gap it should show, which is what ties this bound to
// half the point budget.
export const MAX_MAP_ROUTE_SEGMENTS = MAX_MAP_ROUTE_POINTS / 2;

export const mapRouteLimits = { MAX_MAP_ROUTE_POINTS, MAX_MAP_ROUTE_SEGMENTS };
