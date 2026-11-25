// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The XML fixtures whose structure fixtures-privacy.browser.mts checks with the
// browser's XML parser. fixtures-privacy.test.mts fails when the checkout's
// XML fixtures differ from this list, so a new one cannot skip the check.

export const XML_FIXTURES = Object.freeze([
    'gpx/capitol-2021-segment-order.gpx.gz.b64',
]);

// Elements and attributes a sanitized XML fixture must not retain.
export const FORBIDDEN_XML_ELEMENTS = Object.freeze([
    'metadata', 'author', 'copyright', 'link', 'email', 'name',
    'desc', 'cmt', 'wpt', 'rte',
]);
