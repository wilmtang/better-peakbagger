// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameSavedTrack, verifyCaptureSave, type VerifyCaptureSaveOptions } from '../../src/ascent/capture-save-verification.ts';
import { fetchPeakbaggerResource } from '../../src/peakbagger/peakbagger-request.ts';

const Parser = DOMParser;
const GPX = '<gpx><trk><trkseg><trkpt lat="47" lon="-121"/><trkpt lat="47.1" lon="-121.1"/></trkseg></trk></gpx>';
const document = (html: string) => new Parser().parseFromString(html, 'text/html');
const harness = ({ track = GPX, tripId = '44', expectedTripId = null as string | null, peak = 7, gpxAid = 123 } = {}) => {
    const messages: Record<string, unknown>[] = [];
    const reads: string[] = [];
    const args: VerifyCaptureSaveOptions & Required<Pick<VerifyCaptureSaveOptions, 'readDocument' | 'readResource'>> = {
        aid: '123', origin: 'https://www.peakbagger.com', Parser,
        send: async message => {
            messages.push(message);
            return message.type === 'DRAFT_SAVE_CONTEXT'
                ? { action: 'verify', jobId: 'capture-123', pid: 7, cid: 77, tripRequired: true, tripId: expectedTripId, gpx: GPX }
                : { ok: true };
        },
        readDocument: async url => {
            reads.push(url);
            return { kind: 'ok', url, document: document(url.includes('ascentedit')
                ? `<form id="Form1"><select id="TripDD"><option selected value="${tripId}">Shared trip</option></select></form>`
                : `<a href="https://www.peakbagger.com/peak.aspx?pid=${peak}">Peak</a><a href="https://www.peakbagger.com/climber/ascentedit.aspx?aid=123">Edit Ascent</a><a href="https://www.peakbagger.com/climber/GPXFile.aspx?aid=${gpxAid}">Download this GPS track</a>`) };
        },
        readResource: async url => { reads.push(url); return { kind: 'ok', url, text: track }; },
    };
    return { messages, reads, args };
};

test('saved-track verification requires the complete ordered track, not empty XML or a partial route', () => {
    assert.equal(sameSavedTrack(GPX, GPX.replace('lat="47"', 'lat="47.000000"'), Parser), true);
    for (const track of ['<gpx/>', '<gpx><trk/></gpx>', '<gpx', GPX.replace('<trkpt lat="47.1" lon="-121.1"/>', ''), GPX.replace('47.1', '48.1')]) {
        assert.equal(sameSavedTrack(GPX, track, Parser), false);
    }
});

test('confirmed saves return the actual persisted trip id after checking all track points', async () => {
    const h = harness();
    assert.deepEqual(await verifyCaptureSave(h.args), { ok: true });
    assert.equal(h.reads.length, 3);
    assert.deepEqual(h.messages[1], { type: 'DRAFT_SAVE_CONFIRMED', aid: '123', jobId: 'capture-123', pid: 7, cid: 77, tripId: '44', gpxVerified: true });
});

test('missing GPX points, wrong peak, wrong download aid, and missing or changed trip cannot advance the queue', async () => {
    for (const options of [{ track: '<gpx/>' }, { peak: 8 }, { gpxAid: 456 }, { tripId: '-1' }, { expectedTripId: '45' }]) {
        const h = harness(options);
        await assert.rejects(verifyCaptureSave(h.args));
        assert.equal(h.messages.length, 1);
    }
});

test('a challenged save read leaves the retained draft pending and ordinary saves make no reads', async () => {
    const h = harness();
    h.args.readDocument = async () => ({ kind: 'challenged', reason: 'Sign in to Peakbagger.' });
    await assert.rejects(verifyCaptureSave(h.args), /Sign in/);
    assert.equal(h.messages.length, 1);
    h.args.send = async () => ({ action: 'ignore' });
    assert.equal(await verifyCaptureSave(h.args), null);
});

test('changed response identities never confirm a saved ascent, trip, or matching track', async () => {
    for (const stage of ['ascent.aspx', 'ascentedit.aspx', 'GPXFile.aspx']) {
        for (const responseUrl of [undefined,
            `https://www.peakbagger.com/climber/${stage}?aid=456`,
            `https://www.peakbagger.com/climber/${stage}?aid=123&aid=456`,
            `https://example.com/climber/${stage}?aid=123`,
            'https://www.peakbagger.com/Default.aspx?aid=123',
            `https://user@www.peakbagger.com/climber/${stage}?aid=123`]) {
            const h = harness();
            const changed = <R extends { url?: string }>(url: string, response: R) =>
                new URL(url).pathname.endsWith(`/${stage}`) ? { ...response, url: responseUrl } : response;
            if (stage === 'GPXFile.aspx') {
                const readResource = h.args.readResource;
                h.args.readResource = async (url, options) => changed(url, await readResource(url, options));
            } else {
                const readDocument = h.args.readDocument;
                h.args.readDocument = async (url, options) => changed(url, await readDocument(url, options));
            }
            await assert.rejects(verifyCaptureSave(h.args), /no longer matches/);
            assert.equal(h.messages.length, 1, 'no save confirmation can reach the worker');
        }
    }
});

test('the real request helper cannot confirm a matching track redirected to another ascent', async () => {
    const h = harness();
    h.args.readResource = (url, options) => fetchPeakbaggerResource(url, { ...options, fetchFn: async () => {
        const response = new Response(GPX, { headers: { 'content-type': 'application/gpx+xml' } });
        Object.defineProperties(response, {
            url: { value: 'https://www.peakbagger.com/climber/GPXFile.aspx?aid=456' },
            redirected: { value: true },
        });
        return response;
    } });
    await assert.rejects(verifyCaptureSave(h.args), /GPX response no longer matches/);
    assert.equal(h.messages.length, 1);
});

test('same-ascent legacy GPX redirects and query options remain supported', async () => {
    const h = harness();
    h.args.readResource = async () => ({ kind: 'ok', text: GPX,
        url: 'https://www.peakbagger.com/climber/GetAscentGPX.aspx?aid=123&sep=1' });
    assert.deepEqual(await verifyCaptureSave(h.args), { ok: true });
});
