// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.js';
import { fetchPeakbaggerResource } from '../peakbagger/peakbagger-request.js';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.js';
const DEFAULT_MAX_GPX_BYTES = 15 * 1024 * 1024;

export function ascentIdentity(value) {
    try {
        const url = new URL(value);
        const ids = url.searchParams.getAll('aid');
        if (!isPeakbaggerUrl(value) || url.username || url.password
            || !/^\/climber\/ascent\.aspx$/i.test(url.pathname)
            || ids.length !== 1 || !/^[1-9]\d*$/.test(ids[0])) return null;
        return { url: url.href, id: ids[0], origin: url.origin };
    } catch { return null; }
}

export function storedTrackLink(value, identity) {
    try {
        const url = new URL(value, identity?.url);
        if (!identity || url.origin !== identity.origin || url.username || url.password
            || !/^\/climber\/GPXFile\.aspx$/i.test(url.pathname)
            || url.searchParams.getAll('aid').length !== 1
            || url.searchParams.get('aid') !== identity.id) return null;
        return url.href;
    } catch { return null; }
}

export function validateGpx(gpx, {
    maxBytes = DEFAULT_MAX_GPX_BYTES,
    parseXml = value => new DOMParser().parseFromString(value, 'application/xml'),
} = {}) {
    if (typeof gpx !== 'string' || new Blob([gpx]).size > maxBytes) return false;
    const xml = parseXml(gpx);
    if (!xml || xml.querySelector('parsererror') || xml.documentElement?.localName !== 'gpx' || xml.doctype) {
        return false;
    }
    return !!xml.querySelector('trkpt, rtept, wpt');
}

// Only the exact saved-track link displayed by Peakbagger enters this path.
// Provider capture payloads and analyzer-derived arrays are deliberately not
// inputs, and the GPX is never written to extension storage.
export async function readSourceGpx({
    pageUrl,
    gpxUrl,
    fetchResource = fetchPeakbaggerResource,
    maxBytes = DEFAULT_MAX_GPX_BYTES,
    parseXml,
} = {}) {
    try {
        const identity = ascentIdentity(pageUrl);
        if (!identity) throw new Error('Open a saved Peakbagger ascent.');
        const sourceUrl = storedTrackLink(gpxUrl, identity);
        if (!sourceUrl) throw new Error('This ascent does not have one valid saved GPX download.');
        const response = await fetchResource(sourceUrl, { kind: 'gpx' });
        if (response.kind !== 'ok') throw new Error(PeakbaggerError.message(response.error));
        if (new URL(response.url).origin !== identity.origin) throw new Error('The GPX download left Peakbagger.');
        if (!validateGpx(response.text, { maxBytes, ...(parseXml ? { parseXml } : {}) })) {
            const mebibyte = 1024 * 1024;
            const limit = Number.isInteger(maxBytes)
                ? maxBytes % mebibyte === 0
                    ? `${maxBytes / mebibyte} MiB`
                    : `${Math.floor(maxBytes / 1_000_000)} MB`
                : 'the destination limit';
            throw new Error(`Peakbagger did not return a valid GPX file under ${limit}.`);
        }
        return {
            ok: true,
            sourceUrl: identity.url,
            gpx: response.text,
            filename: `peakbagger-${identity.id}.gpx`,
        };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

export const savedGpxSource = { ascentIdentity, storedTrackLink, validateGpx, readSourceGpx };
