// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
// @ts-expect-error js-yaml ships no declarations; parsed workflows are typed below.
import yaml from 'js-yaml';
import {
    ISSUE_TITLE,
    planSweep,
    sweep,
    type QueuedPullRequest,
} from '../../scripts/dependabot-queue-sweep.mts';

const now = Date.parse('2026-11-10T00:00:00Z');
const pull = (number: number, extra: Partial<QueuedPullRequest> = {}): QueuedPullRequest => ({
    number,
    title: `bump ${number}`,
    url: `https://example.test/${number}`,
    createdAt: '2026-11-09T12:00:00Z',
    mergeStateStatus: 'BLOCKED',
    mergeable: 'MERGEABLE',
    autoMergeRequest: { mergeMethod: 'MERGE' },
    author: { login: 'app/dependabot' },
    comments: [],
    statusCheckRollup: [{ name: 'Node tests and lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...extra,
});

test('asks for the oldest behind update only', () => {
    const pulls = [pull(9, { mergeStateStatus: 'BEHIND' }), pull(7, { mergeStateStatus: 'BEHIND' })];
    assert.equal(planSweep(pulls, now).rebase, 7);
});

test('waits while any queued update is still running checks', () => {
    for (const check of [{ status: 'IN_PROGRESS' }, { status: 'QUEUED' }, { state: 'PENDING' }]) {
        const pulls = [pull(7, { mergeStateStatus: 'BEHIND' }), pull(8, { statusCheckRollup: [check] })];
        assert.equal(planSweep(pulls, now).rebase, null);
    }
});

test('does not repeat a recent rebase request, but retries an ignored one', () => {
    const asked = (createdAt: string) => pull(7, { mergeStateStatus: 'BEHIND',
        comments: [{ body: '@dependabot rebase', createdAt }] });
    assert.equal(planSweep([asked('2026-11-09T23:00:00Z')], now).rebase, null);
    assert.equal(planSweep([asked('2026-11-09T20:00:00Z')], now).rebase, 7);
});

test('leaves hand-managed updates and other authors alone', () => {
    const pulls = [
        pull(7, { mergeStateStatus: 'BEHIND', autoMergeRequest: null, createdAt: '2026-10-01T00:00:00Z' }),
        pull(8, { mergeStateStatus: 'BEHIND', author: { login: 'someone' }, createdAt: '2026-10-01T00:00:00Z' }),
    ];
    assert.deepEqual(planSweep(pulls, now), { rebase: null, problems: [] });
});

test('does not rebase a current update whose checks really failed, and reports it once stuck', () => {
    const failed = pull(7, {
        createdAt: '2026-11-01T00:00:00Z',
        statusCheckRollup: [{ name: 'Scale tests', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    const { rebase, problems } = planSweep([failed], now);
    assert.equal(rebase, null);
    assert.deepEqual(problems, ['#7 bump 7 (failing: Scale tests)']);
    assert.deepEqual(planSweep([pull(7, { statusCheckRollup: failed.statusCheckRollup })], now).problems, []);
});

test('reports conflicts and an unmoving merge state after three days', () => {
    const old = '2026-11-06T00:00:00Z';
    assert.match(planSweep([pull(7, { createdAt: old, mergeable: 'CONFLICTING' })], now).problems[0], /merge conflict/);
    assert.match(planSweep([pull(7, { createdAt: old, mergeStateStatus: 'BEHIND' })], now).problems[0], /merge state BEHIND/);
});

const stub = (pulls: QueuedPullRequest[], issues: { number: number; title: string }[]) => {
    const calls: string[][] = [];
    return {
        calls,
        run: (args: string[]) => {
            calls.push(args);
            if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(pulls);
            if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues);
            return '';
        },
    };
};
const writes = (calls: string[][]) => calls.filter(call => call[1] !== 'list').map(call => call.slice(0, 3).join(' '));

test('keeps one tracking issue: create, update, then close', () => {
    const stuck = pull(7, { createdAt: '2026-09-01T00:00:00Z' });
    const open = [{ number: 5, title: ISSUE_TITLE }];
    let { calls, run } = stub([stuck], []);
    sweep(run, now);
    assert.deepEqual(writes(calls), ['issue create --title']);
    ({ calls, run } = stub([stuck], open));
    sweep(run, now);
    assert.deepEqual(writes(calls), ['issue edit 5']);
    ({ calls, run } = stub([], open));
    sweep(run, now);
    assert.deepEqual(writes(calls), ['issue close 5']);
    ({ calls, run } = stub([], [{ number: 6, title: 'unrelated' }]));
    sweep(run, now);
    assert.deepEqual(writes(calls), []);
});

test('finds its own issue by the author filter GitHub accepts, and closes duplicates', () => {
    const open = [{ number: 66, title: ISSUE_TITLE }, { number: 65, title: ISSUE_TITLE }];
    const { calls, run } = stub([], open);
    sweep(run, now);
    const list = calls.find(call => call[0] === 'issue' && call[1] === 'list');
    assert.ok(list);
    assert.equal(list[list.indexOf('--author') + 1], 'github-actions[bot]');
    assert.deepEqual(writes(calls), ['issue close 66', 'issue close 65']);
});

test('comments the exact Dependabot command on the chosen pull request', () => {
    const { calls, run } = stub([pull(7, { mergeStateStatus: 'BEHIND' })], []);
    sweep(run, now);
    assert.deepEqual(calls.find(call => call[1] === 'comment'), ['pr', 'comment', '7', '--body', '@dependabot rebase']);
});

test('the sweep stays unprivileged and on trusted code', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/dependabot-queue-sweep.yml', import.meta.url), 'utf8');
    assert.doesNotMatch(workflow, /pull_request/);
    const parsed = yaml.load(workflow) as {
        permissions: Record<string, string>;
        jobs: { sweep: { permissions: Record<string, string> } };
    };
    assert.deepEqual(parsed.permissions, { contents: 'read' });
    assert.deepEqual(parsed.jobs.sweep.permissions, {
        contents: 'read', issues: 'write', 'pull-requests': 'write',
    });
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /run: node scripts\/dependabot-queue-sweep\.mts/);
    assert.match(workflow, /schedule:/);
});
