// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM, type TestWindow } from '../helpers/test-dom.mts';

// The built page bundle, evaluated in the activity page's realm as injected.
const source = await fs.readFile(new URL('../../dist/provider-page.js', import.meta.url), 'utf8');

type ProviderWindow = Omit<TestWindow, 'fetch'> & {
    BPBProviderPage: { capture(): Promise<{ ok: boolean; code?: string }> };
    fetch: (url: string, init?: unknown) => Promise<unknown>;
};

const stravaPage = `<!doctype html><body>
  <header id="global-header"><a href="/athletes/42">Viewer</a></header>
  <main><section id="heading" data-testid="activity-header"><a href="/athletes/42">Author</a></section>
    <a href="/activities/123/edit">Edit</a><h1>Morning hike</h1></main></body>`;

const streamOf = (text: string, chunkSize = 1024) => {
    const bytes = new TextEncoder().encode(text);
    let offset = 0, cancelled = false;
    return {
        get cancelled() { return cancelled; },
        body: new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset >= bytes.length) { controller.close(); return; }
                controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
            },
            cancel() { cancelled = true; },
        }),
    };
};

const capture = async (response: Record<string, unknown>) => {
    const dom = new JSDOM(stravaPage, { url: 'https://www.strava.com/activities/123', runScripts: 'outside-only' });
    const window = dom.window as unknown as ProviderWindow;
    (window as unknown as { eval(code: string): unknown }).eval(source);
    window.fetch = async () => response;
    try { return await window.BPBProviderPage.capture(); } finally { window.close(); }
};

const padding = (size: number) => `<!-- ${'x'.repeat(size)} -->`;
const html: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
const none: Record<string, string> = {};

test('a provider error page larger than the probe is classified, not reported as a large GPX', async t => {
    const cases = [
        { name: '403 page', status: 403, headers: none, body: `<p>Forbidden</p>${padding(9000)}`, code: 'provider-forbidden' },
        { name: '403 challenge', status: 403, headers: none, body: `<title>Just a moment...</title>${padding(9000)}`, code: 'provider-human-check' },
        { name: '200 sign-in page', status: 200, headers: html, body: `<form action="/login"><input type="password"></form>${padding(9000)}`, code: 'provider-signed-out' },
        { name: '200 application shell', status: 200, headers: html, body: `<!doctype html><div id="app"></div>${padding(9000)}`, code: 'provider-response-changed' },
        { name: 'single large chunk', status: 403, headers: none, body: `<p>Forbidden</p>${padding(20000)}`, chunk: 32768, code: 'provider-forbidden' },
        { name: 'large declared length', status: 403, headers: { 'content-length': '50000' } as Record<string, string>, body: `<p>Forbidden</p>${padding(9000)}`, code: 'provider-forbidden' },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            const stream = streamOf(item.body, item.chunk);
            const result = await capture({ ok: item.status < 300, status: item.status, url: 'https://www.strava.com/activities/123/export_gpx',
                headers: new Headers(item.headers), body: stream.body });
            assert.equal(result.ok, false);
            assert.equal(result.code, item.code);
            // A body delivered in one chunk has nothing left to cancel.
            if (!item.chunk) assert.equal(stream.cancelled, true, 'the probe stops reading once it has enough of the page');
        });
    }
});

test('an empty probed body still receives a definite failure code', async t => {
    for (const [name, status, headers, code] of [
        ['empty 403', 403, none, 'provider-forbidden'],
        ['empty HTML', 200, html, 'provider-response-changed'],
    ] as const) {
        await t.test(name, async () => {
            const result = await capture({ ok: status < 300, status, url: 'https://www.strava.com/activities/123/export_gpx',
                headers: new Headers(headers), body: streamOf('').body });
            assert.equal(result.code, code);
        });
    }
});
