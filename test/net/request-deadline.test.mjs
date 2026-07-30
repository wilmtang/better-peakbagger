// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { requestDeadline as Deadline } from '../../src/net/request-deadline.js';

const { createRequestDeadline, isTimeout } = Deadline;

test('a request that never answers ends on the deadline rather than pending forever', async () => {
    const deadline = createRequestDeadline(10);
    await assert.rejects(deadline.run(new Promise(() => {})), isTimeout);
    assert.equal(deadline.expired, true);
    deadline.clear();
});

test('the deadline aborts the request as well as rejecting the race', async () => {
    const deadline = createRequestDeadline(10);
    let aborted = false;
    deadline.signal.addEventListener('abort', () => { aborted = true; });
    await assert.rejects(deadline.run(new Promise(() => {})), isTimeout);
    assert.equal(aborted, true, 'a stalled socket must be released, not merely abandoned');
    deadline.clear();
});

test('a fetch that ignores the signal still fails, because the race is independent', async () => {
    // Injected and non-conforming fetches do not honor `signal`; the deadline
    // cannot rely on abort alone to end the wait.
    const deadline = createRequestDeadline(10);
    const indifferent = new Promise(resolve => setTimeout(() => resolve('late'), 5000));
    await assert.rejects(deadline.run(indifferent), isTimeout);
    deadline.clear();
});

test('one deadline covers the whole exchange, not each await separately', async () => {
    const deadline = createRequestDeadline(40);
    // Headers arrive in time; the body then stalls. Restarting the clock per
    // step would let the pair run unbounded.
    assert.equal(await deadline.run(Promise.resolve('headers')), 'headers');
    await assert.rejects(deadline.run(new Promise(() => {})), isTimeout);
    deadline.clear();
});

test('a request that finishes first is untouched and leaves no live timer', async () => {
    const deadline = createRequestDeadline(50_000);
    assert.equal(await deadline.run(Promise.resolve('ok')), 'ok');
    assert.equal(deadline.expired, false);
    deadline.clear();
    // A surviving timer would keep an MV3 service worker awake; node exiting
    // this test without a pending handle is the observable proof.
});

test('an expired deadline never surfaces as an unhandled rejection', async () => {
    const rejections = [];
    const record = error => rejections.push(error);
    process.on('unhandledRejection', record);
    try {
        // Nobody races this one: the expiry fires with no observer at all.
        const deadline = createRequestDeadline(5);
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(deadline.expired, true);
        deadline.clear();
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        process.off('unhandledRejection', record);
    }
    assert.deepEqual(rejections, [], 'an unobserved expiry must not take down the worker');
});

test('a caller can cancel early without being reported as too slow', async () => {
    const deadline = createRequestDeadline(50_000);
    let aborted = false;
    deadline.signal.addEventListener('abort', () => { aborted = true; });
    deadline.abort();
    assert.equal(aborted, true);
    assert.equal(deadline.expired, false, 'a cancellation is not a timeout');
    deadline.clear();
});

test('cancelling leaves the deadline armed, because an ignored abort settles nothing', async () => {
    // A transport handed an already-aborted signal may simply never report on
    // it. If abort() disarmed the deadline, the race would then have nothing
    // left to end it — the guarantee would vanish exactly when it is needed.
    const deadline = createRequestDeadline(10);
    deadline.abort();
    await assert.rejects(deadline.run(new Promise(() => {})), isTimeout);
    deadline.clear();
});

test('a malformed timeout falls back to the shared default instead of firing instantly', () => {
    for (const value of [undefined, null, NaN, 0, -5, 'soon']) {
        const deadline = createRequestDeadline(value);
        assert.equal(deadline.expired, false);
        deadline.clear();
    }
});
test('every third-party transport bounds its requests through this one module', async () => {
    // The failure a status code never reports is the one that never arrives.
    // A transport added later must not quietly reintroduce an unbounded wait.
    const transports = [
        'github/github-api.js',
        'github/github-auth.js',
        'photos/imgbb-client.js',
        'peakbagger/peakbagger-request.js',
        // The map surfaces reach third-party hosts too: DEM tiles from
        // Mapterhorn and the vector style from OpenFreeMap. Neither renders
        // through a transport that reports status, so an unbounded wait there
        // shows up as a hole in the mesh or a blank drape rather than an error.
        'terrain/terrain-cache.js',
        'terrain/terrain-frame.js',
    ];
    for (const file of transports) {
        const source = await readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8');
        assert.ok(/request-deadline\.js/.test(source), `${file} must bound its requests`);
    }
});

test('no source module hardcodes its own race-with-timeout', async () => {
    const root = new URL('../../src/', import.meta.url);
    const walk = async dir => {
        const out = [];
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
            if (entry.isDirectory()) out.push(...await walk(child));
            else if (entry.name.endsWith('.js')) out.push(child);
        }
        return out;
    };
    for (const file of await walk(root)) {
        if (path.basename(file.pathname) === 'request-deadline.js') continue;
        const source = await readFile(file, 'utf8');
        assert.ok(
            !/Promise\.race\s*\(\s*\[[^\]]*\btimeout\b/i.test(source),
            `${path.basename(file.pathname)} must use the shared deadline, not a second implementation`,
        );
    }
});
