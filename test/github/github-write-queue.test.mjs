// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The coalescing write queue in isolation: ordering against exclusive
// operations, which writers share a commit, and what a superseded writer is
// told. The injected delay makes the collecting window explicit instead of
// timing-dependent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { githubWriteQueue as Queue } from '../../src/github/github-write-queue.js';

// A commit recorder whose window is a promise the test resolves by hand, so a
// batch stays open exactly as long as the test wants it to.
const harness = ({ commit } = {}) => {
    const commits = [];
    let release = null;
    const window = () => new Promise(resolve => { release = resolve; });
    const queue = Queue.createGithubWriteQueue({
        coalesceWindowMs: 0,
        delay: () => window(),
        commitFiles: async (files, message) => {
            commits.push({ files, message });
            if (commit) return commit(files, message, commits.length);
            return { sha: `sha${commits.length}`, commitUrl: `https://example/${commits.length}`, message };
        },
    });
    // Let the queue reach its window, then close it.
    const closeWindow = async () => {
        for (let i = 0; i < 20 && !release; i += 1) await Promise.resolve();
        assert.ok(release, 'the batch never reached its collecting window');
        const open = release;
        release = null;
        open();
    };
    return { queue, commits, closeWindow };
};

test('writers that arrive during the window share one commit', async () => {
    const { queue, commits, closeWindow } = harness();
    const first = queue.putFile({ path: 'settings.json', content: 'a', message: 'Back up settings' });
    const second = queue.putFile({
        path: 'favorite-climbers.json', content: 'b', message: 'Back up favorite climbers',
    });
    await closeWindow();
    const results = await Promise.all([first, second]);

    assert.equal(commits.length, 1, 'two overlapping root-file writes must not spend two commits');
    assert.deepEqual(commits[0].files, [
        { path: 'settings.json', content: 'a' },
        { path: 'favorite-climbers.json', content: 'b' },
    ]);
    assert.equal(commits[0].message, 'Back up settings; Back up favorite climbers');
    assert.deepEqual(results.map(result => result.path), ['settings.json', 'favorite-climbers.json']);
    assert.deepEqual(results.map(result => result.sha), ['sha1', 'sha1']);
    assert.deepEqual(results.map(result => result.superseded), [false, false]);
});

test('a repeated path keeps only the newest content and says which writer lost', async () => {
    const { queue, commits, closeWindow } = harness();
    const stale = queue.putFile({ path: 'favorite-climbers.json', content: 'old', message: 'Back up favorite climbers' });
    const fresh = queue.putFile({ path: 'favorite-climbers.json', content: 'new', message: 'Back up favorite climbers' });
    await closeWindow();
    const [staleResult, freshResult] = await Promise.all([stale, fresh]);

    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].files, [{ path: 'favorite-climbers.json', content: 'new' }]);
    assert.equal(commits[0].message, 'Back up favorite climbers',
        'one repeated message must not be repeated in the commit subject');
    assert.equal(staleResult.superseded, true, 'the replaced writer must not record its content as synced');
    assert.equal(freshResult.superseded, false);
    assert.equal(staleResult.sha, freshResult.sha, 'both writers still reached the repository');
});

test('a write submitted after the batch closes starts a new commit', async () => {
    const { queue, commits, closeWindow } = harness();
    const first = queue.putFile({ path: 'settings.json', content: 'a', message: 'Back up settings' });
    await closeWindow();
    await first;

    const second = queue.putFile({ path: 'settings.json', content: 'b', message: 'Back up settings' });
    await closeWindow();
    await second;

    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map(entry => entry.files[0].content), ['a', 'b']);
});

test('an exclusive operation closes the batch and keeps submission order', async () => {
    const order = [];
    const { queue, commits, closeWindow } = harness({
        commit: files => { order.push(`files:${files.map(file => file.path).join(',')}`); return { sha: 'x' }; },
    });
    const before = queue.putFile({ path: 'settings.json', content: 'a', message: 'Back up settings' });
    const exclusive = queue.run(async () => { order.push('ascent'); return 'ascent-result'; });
    const after = queue.putFile({ path: 'settings.json', content: 'b', message: 'Back up settings' });

    await closeWindow();
    await before;
    assert.equal(await exclusive, 'ascent-result');
    await closeWindow();
    await after;

    assert.equal(commits.length, 2, 'a write after an exclusive operation cannot join the batch before it');
    assert.deepEqual(order, ['files:settings.json', 'ascent', 'files:settings.json']);
});

test('an exclusive failure does not stop the writes queued behind it', async () => {
    const { queue, commits, closeWindow } = harness();
    const failing = queue.run(async () => { throw new Error('ref conflict'); });
    const queued = queue.putFile({ path: 'settings.json', content: 'a', message: 'Back up settings' });

    await assert.rejects(failing, /ref conflict/);
    await closeWindow();
    await queued;
    assert.equal(commits.length, 1);
});

test('a failed commit rejects every writer in its batch', async () => {
    const { queue, closeWindow } = harness({
        commit: () => { throw new Error('GitHub rejected the commit'); },
    });
    const first = queue.putFile({ path: 'settings.json', content: 'a', message: 'Back up settings' });
    const second = queue.putFile({ path: 'favorite-climbers.json', content: 'b', message: 'Back up favorite climbers' });
    await closeWindow();

    await assert.rejects(first, /GitHub rejected the commit/);
    await assert.rejects(second, /GitHub rejected the commit/);
});

test('the queue refuses to be built without a commit function', () => {
    assert.throws(() => Queue.createGithubWriteQueue({}), TypeError);
});
