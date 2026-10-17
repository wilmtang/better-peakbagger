// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Only the user-selected local file uses this projection. Provider captures
// are newly serialized from allowlisted fields in capture-core instead.
export function removeGpxTimestamps(text) {
    const document = new DOMParser().parseFromString(text, 'application/xml');
    if (document.getElementsByTagNameNS('*', 'parsererror').length
        || document.documentElement?.localName !== 'gpx' || document.doctype) {
        throw new Error('The GPX file contains invalid XML.');
    }
    // Includes metadata, waypoints, routes, tracks, and prefixed GPX elements.
    // Remove extension time elements too; retaining one would contradict the choice.
    for (const element of [...document.getElementsByTagNameNS('*', 'time')]) element.remove();
    return new XMLSerializer().serializeToString(document);
}
