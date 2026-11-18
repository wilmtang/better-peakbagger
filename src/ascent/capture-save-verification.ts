// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    fetchPeakbaggerDocument,
    fetchPeakbaggerResource,
    type DomParserConstructor,
} from '../peakbagger/peakbagger-request.ts';
import { ascentPage } from './ascent-page.ts';
import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.ts';

export type CaptureSaveSendFn = (message: Record<string, unknown>) => Promise<unknown>;

export interface CaptureSaveDocumentResult {
    kind: string;
    url?: string;
    document?: Document;
    reason?: string;
}

export interface CaptureSaveResourceResult {
    kind: string;
    url?: string;
    text?: string;
    reason?: string;
}

export interface VerifyCaptureSaveContext {
    action?: string;
    message?: string;
    pid?: number | string;
    cid?: number | string;
    jobId?: string;
    tripRequired?: boolean;
    tripId?: string | null;
    gpx?: string;
}

export interface VerifyCaptureSaveConfirmation {
    ok?: boolean;
    message?: string;
    [key: string]: unknown;
}

export interface VerifyCaptureSaveOptions {
    aid: string | number;
    send: CaptureSaveSendFn;
    origin: string;
    readDocument?: (
        url: string,
        options: { kind: 'html' | 'edit' },
    ) => Promise<CaptureSaveDocumentResult>;
    readResource?: (
        url: string,
        options: { kind: 'gpx' },
    ) => Promise<CaptureSaveResourceResult>;
    Parser?: DomParserConstructor;
}

const matchesAscentResource = (
    value: string | null | undefined,
    origin: string,
    aid: string | number,
    path: RegExp,
): boolean => {
    if (!value) return false;
    try {
        const url = new URL(value);
        return isPeakbaggerUrl(url.href) && url.origin === origin && !url.username && !url.password
            && path.test(url.pathname) && url.searchParams.getAll('aid').length === 1
            && url.searchParams.get('aid') === String(aid);
    } catch { return false; }
};
const DISPLAY_PATH = /^\/climber\/ascent\.aspx$/i;
const EDIT_PATH = /^\/climber\/ascentedit\.aspx$/i;
const GPX_PATH = /^\/climber\/(?:GPXFile|GetAscentGPX)\.aspx$/i;

// Compare the whole retained route, tolerating only coordinate formatting.
// An HTTP 200, a GPX element, or a preview map does not prove saved points.
export const sameSavedTrack = (
    expected: string,
    actual: string,
    Parser: DomParserConstructor = globalThis.DOMParser,
): boolean => {
    const coordinates = (text: string): number[][] | null => {
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

export const verifyCaptureSave = async ({
    aid,
    send,
    origin,
    readDocument = fetchPeakbaggerDocument,
    readResource = fetchPeakbaggerResource,
    Parser = globalThis.DOMParser,
}: VerifyCaptureSaveOptions): Promise<VerifyCaptureSaveConfirmation | null> => {
    const rawContext = await send({ type: 'DRAFT_SAVE_CONTEXT', aid });
    const context = rawContext && typeof rawContext === 'object' ? rawContext as VerifyCaptureSaveContext : null;
    if (!context || context.action === 'ignore') return null;
    if (context.action !== 'verify') throw new Error(context.message || 'The saved ascent could not be checked.');
    const displayUrl = new URL(`/climber/ascent.aspx?aid=${aid}`, origin).href;
    const display = await readDocument(displayUrl, { kind: 'html' });
    if (display.kind !== 'ok') throw new Error(display.reason || 'The saved ascent could not be read.');
    if (!matchesAscentResource(display.url, origin, aid, DISPLAY_PATH) || !display.document) {
        throw new Error('The saved ascent response no longer matches this ascent. Reload and check again.');
    }
    const saved = ascentPage.read({ doc: display.document, search: `?aid=${aid}` });
    if (!saved.isOwner || String(saved.peak.id) !== String(context.pid)) {
        throw new Error('The saved ascent identity could not be confirmed.');
    }
    const editUrl = saved.editUrl ? new URL(saved.editUrl, displayUrl) : null;
    const gpxUrl = saved.gpxUrl ? new URL(saved.gpxUrl, displayUrl) : null;
    if (!editUrl || !matchesAscentResource(editUrl.href, origin, aid, EDIT_PATH)
        || !gpxUrl || !matchesAscentResource(gpxUrl.href, origin, aid, GPX_PATH)) {
        throw new Error('The saved ascent has no verified GPX download.');
    }
    let tripId: string | null = null;
    if (context.tripRequired) {
        const edit = await readDocument(editUrl.href, { kind: 'edit' });
        if (edit.kind !== 'ok') throw new Error(edit.reason || 'The saved trip could not be read.');
        if (!matchesAscentResource(edit.url, origin, aid, EDIT_PATH) || !edit.document) {
            throw new Error('The saved trip response no longer matches this ascent. Reload and check again.');
        }
        const trip = edit.document.getElementById('TripDD') as (HTMLElement & { value?: unknown }) | null;
        const tripValue = typeof trip?.value === 'string' ? trip.value : '';
        tripId = /^[1-9]\d*$/.test(tripValue) ? tripValue : null;
        if (!tripId || (context.tripId && tripId !== context.tripId)) {
            throw new Error('The saved ascent is not in the shared trip. Correct its Trip Info before continuing.');
        }
    }
    const track = await readResource(gpxUrl.href, { kind: 'gpx' });
    if (track.kind !== 'ok') throw new Error(track.reason || 'The saved GPX could not be read.');
    if (!matchesAscentResource(track.url, origin, aid, GPX_PATH)) {
        throw new Error('The saved GPX response no longer matches this ascent. Reload and check again.');
    }
    if (!sameSavedTrack(context.gpx ?? '', track.text ?? '', Parser)) {
        throw new Error('The saved GPX is empty or differs from the prepared track. Edit this saved ascent and use Attach GPX to repair it, then check again.');
    }
    const rawResult = await send({ type: 'DRAFT_SAVE_CONFIRMED', aid, jobId: context.jobId,
        pid: context.pid, cid: context.cid, tripId, gpxVerified: true });
    const result = rawResult && typeof rawResult === 'object' ? rawResult as VerifyCaptureSaveConfirmation : null;
    if (!result?.ok) throw new Error(result?.message || 'The capture changed before its saved ascent could be confirmed.');
    return result;
};
