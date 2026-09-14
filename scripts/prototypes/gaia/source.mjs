// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPeakbaggerUrl } from '../../../src/peakbagger/peakbagger-origin.js';
import { fetchPeakbaggerResource } from '../../../src/peakbagger/peakbagger-request.js';
import { peakbaggerError } from '../../../src/peakbagger/peakbagger-error.js';

export const MAX_PROTOTYPE_BYTES = 4 * 1024 * 1024;

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

export function storedTrackLink(doc, identity) {
    const links = new Set();
    for (const anchor of doc.querySelectorAll('a[href]')) {
        try {
            const url = new URL(anchor.getAttribute('href'), identity.url);
            if (url.origin !== identity.origin || url.username || url.password
                || !/^\/climber\/GPXFile\.aspx$/i.test(url.pathname)
                || url.searchParams.getAll('aid').length !== 1
                || url.searchParams.get('aid') !== identity.id) continue;
            links.add(url.href);
        } catch { /* An unrelated malformed link is not a GPX source. */ }
    }
    if (links.size !== 1) throw new Error('This ascent needs one unambiguous saved GPX download link.');
    return [...links][0];
}

// Only Peakbagger's saved export enters this prototype. Provider capture data
// and the analyzer's reduced/derived arrays are deliberately not inputs.
export async function readSourceGpx({
    doc = globalThis.document,
    pageUrl = globalThis.location.href,
    fetchResource = fetchPeakbaggerResource,
} = {}) {
    try {
        const identity = ascentIdentity(pageUrl);
        if (!identity) throw new Error('Open a Peakbagger ascent with a saved GPS track.');
        const url = storedTrackLink(doc, identity);
        const response = await fetchResource(url, { kind: 'gpx' });
        if (response.kind !== 'ok') throw new Error(peakbaggerError.message(response.error));
        if (new URL(response.url).origin !== identity.origin) throw new Error('The GPX download left Peakbagger.');
        if (new TextEncoder().encode(response.text).length > MAX_PROTOTYPE_BYTES) {
            throw new Error('This prototype accepts GPX files up to 4 MiB. Import this file manually in Gaia.');
        }
        const xml = new doc.defaultView.DOMParser().parseFromString(response.text, 'application/xml');
        if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'gpx'
            || xml.doctype || !xml.querySelector('trkpt, rtept')) {
            throw new Error('Peakbagger did not return a valid GPX track or route.');
        }
        return { ok: true, sourceUrl: identity.url, gpx: response.text, filename: `peakbagger-${identity.id}.gpx` };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}
