#!/usr/bin/env node
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global caches, document, localStorage */

import assert from 'node:assert/strict';
import { createServer } from 'node:https';

import { chromium, firefox } from 'playwright';

import {
    createFixtureCertificate,
    resolveFixtureFile,
    sendFixtureError,
    sendFixtureFile,
    sendFixtureNotFound,
    sendFixtureText,
} from './browser-verification-fixtures.mjs';
import {
    closeServer,
    createResourceStack,
    listenServer,
} from './resource-stack.mjs';

const FIXTURE_HOST = 'www.peakbagger.com';
const VIEWPORT = { width: 1000, height: 760 };
const TILE_BYTES = 700 * 1024;

const OWNER_HTML = `<!doctype html>
<meta charset="utf-8">
<script type="module">
import { terrainCache } from '/src/terrain/terrain-cache.js';

const storageArea = {
    async get(key) {
        const value = localStorage.getItem(key);
        return { [key]: value === null ? undefined : JSON.parse(value) };
    },
    async set(patch) {
        for (const [key, value] of Object.entries(patch)) {
            localStorage.setItem(key, JSON.stringify(value));
        }
    },
    async remove(key) { localStorage.removeItem(key); }
};

const ownerId = Number(new URL(location.href).searchParams.get('owner'));
const makeWebp = marker => {
    const bytes = new Uint8Array(${TILE_BYTES});
    const ascii = (offset, value) => {
        for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
    };
    ascii(0, 'RIFF');
    ascii(8, 'WEBP');
    ascii(12, 'VP8L');
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.byteLength - 8, true);
    view.setUint32(16, bytes.byteLength - 20, true);
    bytes.fill(marker, 20);
    return bytes;
};

const owner = terrainCache.create({
    limitMb: 1,
    storageArea,
    now: () => ownerId * 100,
    fetchFn: async () => new Response(makeWebp(ownerId), {
        status: 200,
        headers: { 'content-type': 'image/webp' }
    })
});

window.cacheProbe = {
    hasWebLocks: Boolean(navigator.locks && typeof navigator.locks.request === 'function'),
    load: async url => (await owner.load({ url })).data.byteLength,
    flush: () => owner.flush(),
    close: () => owner.close()
};
</script>`;

const INDEX_READER = async () => {
    const { terrainCache } = await import('/src/terrain/terrain-cache.js');
    const storageArea = {
        async get(key) {
            const value = localStorage.getItem(key);
            return { [key]: value === null ? undefined : JSON.parse(value) };
        }
    };
    const cache = await caches.open(terrainCache.CACHE_NAME);
    const requests = await cache.keys();
    const rawIndex = localStorage.getItem(terrainCache.INDEX_KEY);
    return {
        usage: await terrainCache.getUsage({ storageArea }),
        cacheUrls: requests.map(request => request.url).sort(),
        indexUrls: Object.keys(rawIndex ? JSON.parse(rawIndex) : {}).sort()
    };
};

const createFixtureServer = certificate => createServer(certificate, async (request, response) => {
    try {
        const url = new URL(request.url, `https://${FIXTURE_HOST}`);
        if (url.pathname === '/favicon.ico') {
            response.writeHead(204);
            response.end();
            return;
        }
        if (url.pathname === '/' || url.pathname === '/owner.html') {
            sendFixtureText(response, 200, url.pathname === '/'
                ? '<!doctype html><iframe src="/owner.html?owner=1"></iframe><iframe src="/owner.html?owner=2"></iframe>'
                : OWNER_HTML,
            'text/html; charset=utf-8');
            return;
        }
        const file = await resolveFixtureFile(decodeURIComponent(url.pathname));
        if (!file) {
            sendFixtureNotFound(response);
            return;
        }
        await sendFixtureFile(response, file);
    } catch (error) {
        sendFixtureError(response, error);
    }
});

const runCase = async (context, origin, urls) => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    try {
        await page.goto(origin, { waitUntil: 'load' });
        await page.waitForFunction(() => {
            const frames = [...document.querySelectorAll('iframe')];
            return frames.length === 2 && frames.every(frame => frame.contentWindow?.cacheProbe);
        });
        const hasLocks = await page.evaluate(() => [...document.querySelectorAll('iframe')]
            .every(frame => frame.contentWindow.cacheProbe.hasWebLocks));
        assert.equal(hasLocks, true, 'both cache owners require Web Locks');

        await page.evaluate(async () => {
            const { terrainCache } = await import('/src/terrain/terrain-cache.js');
            localStorage.clear();
            await caches.delete(terrainCache.CACHE_NAME);
        });
        const sizes = await page.evaluate(async tileUrls => {
            const frames = [...document.querySelectorAll('iframe')];
            return Promise.all(frames.map((frame, index) => frame.contentWindow.cacheProbe.load(tileUrls[index])));
        }, urls);
        assert.deepEqual(sizes, [TILE_BYTES, TILE_BYTES]);
        const flushed = await page.evaluate(() => Promise.all([...document.querySelectorAll('iframe')]
            .map(frame => frame.contentWindow.cacheProbe.flush())));
        assert.deepEqual(flushed, [true, true]);

        const state = await page.evaluate(INDEX_READER);
        assert.deepEqual(state.usage, {
            bytes: TILE_BYTES,
            entries: 1,
            unmeasuredEntries: 0
        });
        assert.deepEqual(state.indexUrls, state.cacheUrls,
            'the persisted index must exactly describe retained cache entries');
        assert.equal(state.cacheUrls.length, 1);
        await page.evaluate(() => Promise.all([...document.querySelectorAll('iframe')]
            .map(frame => frame.contentWindow.cacheProbe.close())));
        if (errors.length) throw new Error(errors.join('\n'));
        return state;
    } finally {
        await page.close();
    }
};

const verifyBrowser = async ({ name, browserType, launchOptions, origin }) => {
    const browser = await browserType.launch(launchOptions);
    try {
        const context = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
        try {
            const distinct = await runCase(context, origin, [
                'bpb-dem://1/0/0.webp',
                'bpb-dem://1/1/0.webp'
            ]);
            const identical = await runCase(context, origin, [
                'bpb-dem://1/1/0.webp',
                'bpb-dem://1/1/0.webp'
            ]);
            console.log(`${name} ${browser.version()}, hidden/headless ${VIEWPORT.width}x${VIEWPORT.height}: `
                + `distinct=${distinct.usage.entries}, identical=${identical.usage.entries}, `
                + `${distinct.usage.bytes} bytes retained`);
        } finally {
            await context.close();
        }
    } finally {
        await browser.close();
    }
};

async function main() {
    const resources = createResourceStack();
    let primaryError = null;
    try {
        const certificate = await createFixtureCertificate({ host: FIXTURE_HOST, label: 'terrain-cache-owners' });
        resources.defer('terrain cache certificate', () => certificate.remove());
        const server = createFixtureServer({ key: certificate.key, cert: certificate.cert });
        resources.defer('terrain cache fixture server', () => closeServer(server));
        await listenServer(server, 0, '127.0.0.1');
        const origin = `https://${FIXTURE_HOST}:${server.address().port}/`;

        await verifyBrowser({
            name: 'Chromium',
            browserType: chromium,
            launchOptions: {
                channel: 'chromium',
                headless: true,
                args: [`--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1`]
            },
            origin
        });
        await verifyBrowser({
            name: 'Firefox',
            browserType: firefox,
            launchOptions: {
                headless: true,
                firefoxUserPrefs: { 'network.dns.localDomains': FIXTURE_HOST }
            },
            origin
        });
        console.log('Terrain cache owner verification passed; this storage check does not render WebGL or test native focus/window placement.');
    } catch (error) {
        primaryError = error;
    }
    await resources.dispose(primaryError);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
