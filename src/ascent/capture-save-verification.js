// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fetchPeakbaggerDocument, fetchPeakbaggerResource } from '../peakbagger/peakbagger-request.js';
import { ascentPage } from './ascent-page.js';
import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.js';

// Compare the whole retained route, tolerating only coordinate formatting.
// An HTTP 200, a GPX element, or a preview map does not prove saved points.
export const sameSavedTrack = (expected, actual, Parser = globalThis.DOMParser) => {
    const coordinates = text => {
        const doc = new Parser().parseFromString(text, 'application/xml');
        if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'gpx') return null;
        const points = [...doc.getElementsByTagNameNS('*', 'trkpt')];
        if (points.length < 2) return null;
        return points.map(point => ['lat', 'lon'].map(name => {
            const value = point.getAttribute(name);
            return value?.trim() ? Number(value) : NaN;
        }));
    };
    const left = coordinates(expected);
    const right = coordinates(actual);
    return !!left && !!right && left.length === right.length
        && left.every((point, index) => point.every((value, axis) => Number.isFinite(value)
            && Number.isFinite(right[index][axis]) && Math.abs(value - right[index][axis]) <= 0.000001));
};

export const verifyCaptureSave = async ({ aid, send, origin,
    readDocument = fetchPeakbaggerDocument, readResource = fetchPeakbaggerResource,
    Parser = globalThis.DOMParser,
}) => {
    const context = await send({ type: 'DRAFT_SAVE_CONTEXT', aid });
    if (!context || context.action === 'ignore') return null;
    if (context.action !== 'verify') throw new Error(context.message || 'The saved ascent could not be checked.');
    const displayUrl = new URL(`/climber/ascent.aspx?aid=${aid}`, origin).href;
    const display = await readDocument(displayUrl, { kind: 'html' });
    if (display.kind !== 'ok') throw new Error(display.reason || 'The saved ascent could not be read.');
    const saved = ascentPage.read({ doc: display.document, search: `?aid=${aid}` });
    if (!saved.isOwner || String(saved.peak.id) !== String(context.pid)) {
        throw new Error('The saved ascent identity could not be confirmed.');
    }
    const editUrl = new URL(saved.editUrl, displayUrl);
    const gpxUrl = saved.gpxUrl ? new URL(saved.gpxUrl, displayUrl) : null;
    if (!isPeakbaggerUrl(editUrl.href) || !/\/climber\/ascentedit\.aspx$/i.test(editUrl.pathname)
        || editUrl.searchParams.get('aid') !== String(aid)
        || !gpxUrl || !isPeakbaggerUrl(gpxUrl.href) || !/\/climber\/(?:GPXFile|GetAscentGPX)\.aspx$/i.test(gpxUrl.pathname)
        || gpxUrl.searchParams.get('aid') !== String(aid)) {
        throw new Error('The saved ascent has no verified GPX download.');
    }
    let tripId = null;
    if (context.tripRequired) {
        const edit = await readDocument(editUrl.href, { kind: 'edit' });
        if (edit.kind !== 'ok') throw new Error(edit.reason || 'The saved trip could not be read.');
        const trip = edit.document.getElementById('TripDD');
        tripId = /^[1-9]\d*$/.test(trip?.value || '') ? trip.value : null;
        if (!tripId || (context.tripId && tripId !== context.tripId)) {
            throw new Error('The saved ascent is not in the shared trip. Correct its Trip Info before continuing.');
        }
    }
    const track = await readResource(gpxUrl.href, { kind: 'gpx' });
    if (track.kind !== 'ok') throw new Error(track.reason || 'The saved GPX could not be read.');
    if (!sameSavedTrack(context.gpx, track.text, Parser)) {
        throw new Error('The saved GPX is empty or differs from the prepared track. Edit this saved ascent and use Attach GPX to repair it, then check again.');
    }
    const result = await send({ type: 'DRAFT_SAVE_CONFIRMED', aid, jobId: context.jobId,
        pid: context.pid, cid: context.cid, tripId, gpxVerified: true });
    if (!result?.ok) throw new Error(result?.message || 'The capture changed before its saved ascent could be confirmed.');
    return result;
};
