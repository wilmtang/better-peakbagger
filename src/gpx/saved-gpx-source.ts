// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPeakbaggerUrl } from '../peakbagger/peakbagger-origin.ts';
import { fetchPeakbaggerResource } from '../peakbagger/peakbagger-request.ts';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.ts';
const DEFAULT_MAX_GPX_BYTES = 15 * 1024 * 1024;

export interface AscentIdentity {
    url: string;
    id: string;
    origin: string;
}

export interface GpxXmlDocument {
    querySelector(selectors: string): Element | null;
    documentElement: { localName?: string | null } | null;
    doctype: unknown;
}

export interface ValidateGpxOptions {
    maxBytes?: number;
    parseXml?: (value: string) => GpxXmlDocument | null | undefined;
}

export interface FetchResourceSuccess {
    kind: 'ok';
    url: string;
    text: string;
}

export interface FetchResourceFailure {
    kind: string;
    error?: Parameters<typeof PeakbaggerError.message>[0];
}

export type FetchResourceResult = FetchResourceSuccess | FetchResourceFailure;

export interface ReadSourceGpxOptions {
    pageUrl?: unknown;
    gpxUrl?: unknown;
    fetchResource?: (
        url: string,
        options: { kind: 'gpx'; signal?: AbortSignal; timeoutMs?: number },
    ) => Promise<FetchResourceResult>;
    maxBytes?: number;
    parseXml?: (value: string) => GpxXmlDocument | null | undefined;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface ReadSourceGpxSuccess {
    ok: true;
    sourceUrl: string;
    gpx: string;
    filename: string;
}

export interface ReadSourceGpxFailure {
    ok: false;
    message: string;
}

export type ReadSourceGpxResult = ReadSourceGpxSuccess | ReadSourceGpxFailure;

export function ascentIdentity(value?: unknown): AscentIdentity | null {
    try {
        const raw = value == null ? '' : String(value);
        const url = new URL(raw);
        const ids = url.searchParams.getAll('aid');
        if (!isPeakbaggerUrl(raw) || url.username || url.password
            || !/^\/climber\/ascent\.aspx$/i.test(url.pathname)
            || ids.length !== 1 || !/^[1-9]\d*$/.test(ids[0])) return null;
        return { url: url.href, id: ids[0], origin: url.origin };
    } catch { return null; }
}

export function storedTrackLink(
    value: unknown,
    identity: AscentIdentity | null | undefined,
): string | null {
    try {
        if (value === undefined) return null;
        const url = new URL(String(value), identity?.url);
        if (!identity || url.origin !== identity.origin || url.username || url.password
            || !/^\/climber\/GPXFile\.aspx$/i.test(url.pathname)
            || url.searchParams.getAll('aid').length !== 1
            || url.searchParams.get('aid') !== identity.id) return null;
        return url.href;
    } catch { return null; }
}

export function validateGpx(gpx: unknown, {
    maxBytes = DEFAULT_MAX_GPX_BYTES,
    parseXml = value => new DOMParser().parseFromString(value, 'application/xml'),
}: ValidateGpxOptions = {}): boolean {
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
    signal,
    timeoutMs,
}: ReadSourceGpxOptions = {}): Promise<ReadSourceGpxResult> {
    try {
        const identity = ascentIdentity(pageUrl);
        if (!identity) throw new Error('Open a saved Peakbagger ascent.');
        const sourceUrl = storedTrackLink(gpxUrl, identity);
        if (!sourceUrl) throw new Error('This ascent does not have one valid saved GPX download.');
        const response = await fetchResource(sourceUrl, { kind: 'gpx', signal, timeoutMs });
        if (response.kind !== 'ok') throw new Error(PeakbaggerError.message((response as FetchResourceFailure).error));
        const okResponse = response as FetchResourceSuccess;
        if (!storedTrackLink(okResponse.url, identity)) throw new Error('The GPX download no longer matches this ascent.');
        if (!validateGpx(okResponse.text, { maxBytes, ...(parseXml ? { parseXml } : {}) })) {
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
            gpx: okResponse.text,
            filename: `peakbagger-${identity.id}.gpx`,
        };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}

export const savedGpxSource = { ascentIdentity, storedTrackLink, validateGpx, readSourceGpx };
