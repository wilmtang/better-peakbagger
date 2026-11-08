// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requestDeadline as Deadline } from '../../src/net/request-deadline.js';

import { runtimeSources } from '../helpers/runtime-sources.mts';
import { deadlineFindings, directFetch, DEADLINE_EXCEPTION_FILES } from '../helpers/source-policies.mts';

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
    deadline.signal!.addEventListener('abort', () => { aborted = true; });
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
    const rejections: unknown[] = [];
    const record = (error: unknown) => rejections.push(error);
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
    deadline.signal!.addEventListener('abort', () => { aborted = true; });
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
        const deadline = createRequestDeadline(value as unknown as number);
        assert.equal(deadline.expired, false);
        deadline.clear();
    }
});
test('every third-party transport bounds its requests through this one module', async () => {
    // The failure a status code never reports is the one that never arrives.
    // A transport added later must not quietly reintroduce an unbounded wait.
    const injectedTransports = [
        'github/github-api.js',
        'github/github-auth.js',
        'photos/imgbb-client.js',
        'peakbagger/peakbagger-request.js',
        // The map surfaces reach third-party hosts too: DEM tiles from
        // Mapterhorn and the vector style from Maptoolkit. Neither renders
        // through a transport that reports status, so an unbounded wait there
        // shows up as a hole in the mesh or a blank drape rather than an error.
        'terrain/terrain-cache.js',
    ];
    for (const file of injectedTransports) {
        const source = await readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8');
        assert.ok(/request-deadline\.js/.test(source), `${file} must bound its requests`);
    }

    // Discover every module that calls the global fetch directly. Peak markers
    // remain the one narrow exception: they keep one abort timer alive across
    // both fetch and body read for their native same-origin request. GitHub
    // routes now own an additional whole-operation deadline on top of the
    // deadline-owning clients they receive the native fetch through. Any new
    // direct owner has to import the shared deadline or make a reviewed
    // exception here; it cannot disappear from a hand-kept allowlist.
    const sources = await runtimeSources();
    assert.ok(sources.length >= 15);
    assert.deepEqual(sources.flatMap(deadlineFindings), []);
    assert.deepEqual(sources.filter(source => directFetch(source) && DEADLINE_EXCEPTION_FILES.includes(source.file as typeof DEADLINE_EXCEPTION_FILES[number]))
        .map(source => source.file).sort(), [...DEADLINE_EXCEPTION_FILES].sort(), 'every reviewed exception must still be a direct fetch owner');
});

test('no source module hardcodes its own race-with-timeout', async () => {
    assert.deepEqual((await runtimeSources()).flatMap(deadlineFindings).filter(message => message.includes('race-with-timeout')), []);
});
