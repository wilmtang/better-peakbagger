// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
// @ts-expect-error js-yaml ships no declarations; parsed workflows are typed below.
import yaml from 'js-yaml';
import { cleanupMergedBranches } from '../../scripts/dependabot-branch-cleanup.mts';

const head = 'a'.repeat(40);
const main = 'b'.repeat(40);
const branchName = 'dependabot/npm_and_yarn/tooling-example';
const branch = { name: branchName, protected: false, commit: { sha: head } };
const pull = {
    merged_at: '2026-11-08T03:36:10Z', user: { login: 'dependabot[bot]' },
    base: { ref: 'main' },
    head: { ref: branchName, sha: head, repo: { full_name: 'wilmtang/better-peakbagger' } },
};
function fixture(options: {
    branches?: unknown[]; closed?: unknown[][]; open?: unknown[][];
    status?: string; fail?: 'read' | 'push';
} = {}) {
    const calls: { command: string; args: string[] }[] = [];
    const run = (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === 'git') {
            if (options.fail === 'push') throw new Error('stale lease or denied deletion');
            return '';
        }
        if (options.fail === 'read') throw new Error('API unavailable');
        const endpoint = args.at(-1) ?? '';
        const lines = (pages: unknown[][]) => pages.flat().map(item => JSON.stringify(item)).join('\n');
        if (endpoint.includes('/branches?')) return lines([
            [{ name: 'main', protected: true, commit: { sha: main } }], options.branches ?? [branch],
        ]);
        if (endpoint.includes('state=closed')) return lines(options.closed ?? [[], [pull]]);
        if (endpoint.includes('state=open')) return lines(options.open ?? [[]]);
        if (endpoint.includes('/compare/')) return JSON.stringify({ status: options.status ?? 'ahead' });
        throw new Error(`Unexpected call: ${command} ${args.join(' ')}`);
    };
    return { calls, run };
}

test('retries missed deletions across API pages with an exact SHA lease and explicit repository', () => {
    for (const status of ['ahead', 'identical']) {
        const { run, calls } = fixture({ status });
        assert.deepEqual(cleanupMergedBranches(run), [branchName]);
        const read = calls.filter(call => call.args.includes('--paginate'));
        assert.equal(read.length, 3);
        assert.ok(read.every(call => call.args.includes('--jq') && !call.args.includes('--slurp')),
            'gh forbids combining --slurp with --jq; use compact JSON lines across pages');
        assert.ok(calls.some(call => call.args.at(-1)?.endsWith(`/compare/${head}...${main}`)));
        assert.deepEqual(calls.find(call => call.command === 'git')?.args, [
            '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
            'push', `--force-with-lease=refs/heads/${branchName}:${head}`,
            'https://github.com/wilmtang/better-peakbagger.git', `:refs/heads/${branchName}`,
        ]);
    }
});

test('projects oversized PR bodies away before buffering and parses compact JSON lines', () => {
    const { run, calls } = fixture();
    const projected = (command: string, args: string[]) => {
        if (command === 'gh' && args.at(-1)?.includes('state=closed')) {
            const filter = args[args.indexOf('--jq') + 1];
            assert.ok(filter, 'the CLI must filter data before Node buffers it');
            const output = execFileSync('jq', ['-r', filter], {
                input: JSON.stringify([{ ...pull, body: 'x'.repeat(2 * 1024 * 1024) }]), encoding: 'utf8',
            });
            assert.ok(output.length < 1024, 'release-note bodies must not reach the subprocess output buffer');
            return output;
        }
        return run(command, args);
    };
    assert.deepEqual(cleanupMergedBranches(projected), [branchName]);
    assert.equal(calls.filter(call => call.command === 'git').length, 1);
});

test('preserves protected, non-bot, fork, unmerged, changed and non-ancestor branches', () => {
    const scenarios = [
        { branches: [{ ...branch, protected: true }] },
        { branches: [{ ...branch, name: 'feature/manual' }] },
        { closed: [[{ ...pull, merged_at: null }]] },
        { closed: [[{ ...pull, user: { login: 'someone' } }]] },
        { closed: [[{ ...pull, base: { ref: 'release' } }]] },
        { closed: [[{ ...pull, head: { ...pull.head, repo: { full_name: 'someone/fork' } } }]] },
        { closed: [[{ ...pull, head: { ...pull.head, repo: null } }]] },
        { branches: [{ ...branch, commit: { sha: 'c'.repeat(40) } }] },
        { branches: [{ ...branch, commit: { sha: 'invalid' } }] },
        { closed: [[]] },
        { status: 'behind' }, { status: 'diverged' }, { status: 'unexpected' },
    ];
    for (const scenario of scenarios) {
        const { run, calls } = fixture(scenario);
        assert.deepEqual(cleanupMergedBranches(run), [], JSON.stringify(scenario));
        assert.equal(calls.some(call => call.command === 'git'), false);
    }
});

test('preserves a merged branch referenced as head or base by an open PR on any page', () => {
    for (const openPull of [
        { ...pull, merged_at: null },
        { ...pull, merged_at: null, base: { ref: branchName }, head: { ...pull.head, ref: 'another' } },
    ]) {
        const { run, calls } = fixture({ open: [[], [openPull]] });
        assert.deepEqual(cleanupMergedBranches(run), []);
        assert.equal(calls.some(call => call.command === 'git'), false);
    }
});

test('read and deletion failures stay failures rather than reporting successful cleanup', () => {
    for (const fail of ['read', 'push'] as const) {
        const { run, calls } = fixture({ fail });
        assert.throws(() => cleanupMergedBranches(run), /API unavailable|stale lease or denied deletion/);
        assert.equal(calls.filter(call => call.command === 'git').length, fail === 'push' ? 1 : 0);
    }
});

test('missed Dependabot branch deletions have a scheduled retry with isolated write permissions', async () => {
    const workflow = yaml.load(await readFile(new URL('../../.github/workflows/dependabot-queue-sweep.yml', import.meta.url), 'utf8')) as {
        on: { schedule: unknown; workflow_dispatch: unknown };
        jobs: Record<string, { permissions: Record<string, string>; steps: { run?: string; with?: Record<string, unknown> }[] }>;
    };
    assert.ok(workflow.jobs['cleanup-branches'], 'a successful merge must not leave missed branch deletion without a retry');
    assert.ok(workflow.on.schedule);
    assert.ok('workflow_dispatch' in workflow.on);
    assert.equal(workflow.jobs.sweep.permissions.contents, 'read');
    const cleanup = workflow.jobs['cleanup-branches'];
    assert.deepEqual(cleanup.permissions, { contents: 'write', 'pull-requests': 'read' });
    assert.ok(cleanup.steps.some(step => step.run === 'node scripts/dependabot-branch-cleanup.mts'));
    assert.ok(cleanup.steps.some(step => step.with?.ref === 'main' && step.with['persist-credentials'] === false));
});
