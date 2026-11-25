// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { FixtureDom } from '../helpers/fixture-dom.mts';

const source = await fs.readFile(new URL('../../dist/peakbagger-page.js', import.meta.url), 'utf8');
const ORIGIN = 'https://www.peakbagger.com';
const LOGIN_URL = `${ORIGIN}/Default.aspx`;
const PEAKS_URL = `${ORIGIN}/Async/pllbb2.aspx?miny=1&maxy=2&minx=3&maxx=4`;

type FetchFn = (url: string, init: RequestInit) => Promise<unknown>;
type PageResult = { kind: string; error?: { code: string } };
// The page-world transport the bundle publishes.
interface PageTransport {
    readonly version: number;
    request(id: string, url: string, kind: string): Promise<PageResult>;
    cancel(id: string): boolean;
    accountEvidence(): unknown;
}
const transport = (dom: FixtureDom) => (dom.window as unknown as { BPBPeakbaggerPage: PageTransport }).BPBPeakbaggerPage;

const load = async ({ url = LOGIN_URL, html = '<!doctype html><title>Peakbagger</title>', fetchFn = (async () => ({
    ok: true,
    status: 200,
    url: LOGIN_URL,
    redirected: false,
    headers: new Headers(),
    text: async () => '<html><a href="/climber/climber.aspx?cid=77">My Home Page</a></html>',
})) as FetchFn } = {}) => {
    const dom = await FixtureDom.open(html, { url });
    // A fake response with the fields the transport reads.
    dom.window.fetch = fetchFn as unknown as typeof fetch;
    dom.window.eval(source);
    return dom;
};

const until = async (predicate: () => unknown) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('condition not reached');
        await new Promise(resolve => setTimeout(resolve, 1));
    }
};

test('the page transport uses the signed-in page fetch policy for its two capture resources', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const dom = await load({
        fetchFn: async (url, init) => {
            calls.push({ url, init });
            const peaks = String(url).includes('/Async/');
            return {
                ok: true,
                status: 200,
                url,
                redirected: false,
                headers: new Headers(),
                text: async () => peaks
                    ? '<p><t i="7" n="Test Peak" a="1" o="2" e="3" r="4" l="Range"/></p>'
                    : '<html><a href="/climber/climber.aspx?cid=77">My Home Page</a></html>',
            };
        },
    });
    const api = transport(dom);

    assert.equal(api.version, 3);
    assert.equal(Object.isFrozen(api), true);
    assert.equal((await api.request('login-1', LOGIN_URL, 'html')).kind, 'ok');
    assert.equal((await api.request('peaks-1', PEAKS_URL, 'peaks')).kind, 'ok');
    assert.deepEqual(calls.map(call => call.url), [LOGIN_URL, PEAKS_URL]);
    for (const { init } of calls) {
        assert.equal(init.credentials, 'include');
        assert.equal(init.redirect, 'follow');
        assert.equal(init.cache, 'no-store');
    }
});

test('fresh-page account evidence exposes only corroborated navigation links', async () => {
    const dom = await load({
        html: `<!doctype html><div>Logged in: Test Climber |
            <a href="/climber/climber.aspx?cid=77">My Home Page</a>
            <a href="/climber/climberedit.aspx?cid=77">Edit Account</a>
            <a href="/climber/ascentedit.aspx?cid=77">Add Ascent</a>
            <a href="/climber/climblistc.aspx?cid=77">My Ascents</a></div><h1>Content</h1>
            <a href="/climber/climber.aspx?cid=999">Someone else's profile</a>
            <a href="/other.aspx?cid=77">My Home Page</a>
            <p>Private page text and cid=1234 must not cross the boundary.</p>`,
    });

    assert.deepEqual(JSON.parse(JSON.stringify(transport(dom).accountEvidence())), {
        pageUrl: LOGIN_URL,
        links: [
            { label: 'My Home Page', href: `${ORIGIN}/climber/climber.aspx?cid=77` },
            { label: 'Edit Account', href: `${ORIGIN}/climber/climberedit.aspx?cid=77` },
            { label: 'Add Ascent', href: `${ORIGIN}/climber/ascentedit.aspx?cid=77` },
            { label: 'My Ascents', href: `${ORIGIN}/climber/climblistc.aspx?cid=77` },
        ],
    });
});

test('the page transport refuses arbitrary same-origin and cross-origin requests before fetch', async () => {
    let fetches = 0;
    const dom = await load({ fetchFn: async () => { fetches++; throw new Error('must not fetch'); } });
    const api = transport(dom);
    const invalid = [
        [LOGIN_URL, 'edit'],
        [`${ORIGIN}/climber/ClimberEdit.aspx?cid=77`, 'html'],
        ['https://example.com/Default.aspx', 'html'],
        [`${PEAKS_URL}&extra=1`, 'peaks'],
        [`${ORIGIN}/Async/pllbb2.aspx?miny=2&maxy=1&minx=3&maxx=4`, 'peaks'],
        [`${ORIGIN}/Async/pllbb2.aspx?miny=-91&maxy=1&minx=3&maxx=4`, 'peaks'],
    ];

    for (const [url, kind] of invalid) {
        const result = await api.request(`invalid-${fetches}-${kind}`, url, kind);
        assert.equal(result.error?.code, 'invalid-request', `${kind}: ${url}`);
    }
    assert.equal(fetches, 0);
});

test('a non-canonical Peakbagger page cannot use the transport', async () => {
    let fetches = 0;
    const dom = await load({
        url: 'https://peakbagger.com/Default.aspx',
        fetchFn: async () => { fetches++; throw new Error('must not fetch'); },
    });
    assert.equal(transport(dom).accountEvidence(), null);
    const result = await transport(dom).request('wrong-page', LOGIN_URL, 'html');
    assert.equal(result.error?.code, 'invalid-request');
    assert.equal(fetches, 0);
});

test('cancelling one page request aborts only that request and clears its owner', async () => {
    let signal: AbortSignal | undefined;
    const dom = await load({
        fetchFn: async (_url, init) => {
            const current = init.signal!;
            signal = current;
            return new Promise((_resolve, reject) => {
                current.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
        },
    });
    const api = transport(dom);
    const pending = api.request('cancel-me', LOGIN_URL, 'html');
    await until(() => !!signal);

    assert.equal(api.cancel('not-mine'), false);
    assert.equal(signal!.aborted, false);
    assert.equal(api.cancel('cancel-me'), true);
    const result = await pending;
    assert.equal(result.error?.code, 'cancelled');
    assert.equal(signal!.aborted, true);
    assert.equal(api.cancel('cancel-me'), false);
});
