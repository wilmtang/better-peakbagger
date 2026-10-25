// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const workflow = yaml.load(await readFile(
    new URL('../../.github/workflows/dependabot-auto-merge.yml', import.meta.url), 'utf8',
));
const step = name => workflow.jobs['auto-merge'].steps.find(item => item.name === name).run;
const head = 'a'.repeat(40);
const state = (autoMergeRequest = null, extra = {}) => ({
    state: 'OPEN', headRefOid: head, autoMergeRequest, ...extra,
});

// Execute the actual trusted workflow shell against an isolated GitHub CLI stub.
// The stub covers API failures and postconditions, not GitHub's ruleset enforcement.
async function runStep(name, scenario) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bpb-dependabot-queue-'));
    const callsPath = path.join(directory, 'calls.jsonl');
    try {
        await writeFile(path.join(directory, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const calls = process.env.BPB_QUEUE_CALLS;
const previous = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\\n').map(JSON.parse) : [];
fs.appendFileSync(calls, JSON.stringify(args) + '\\n');
const scenario = JSON.parse(process.env.BPB_QUEUE_SCENARIO);
if (args[0] === 'pr' && args[1] === 'view') {
    if (scenario.readFailure) process.exit(1);
    const index = previous.filter(call => call[1] === 'view').length;
    console.log(JSON.stringify(scenario.states[index] ?? scenario.states.at(-1)));
} else if (args[0] === 'pr' && args[1] === 'merge') {
    if (scenario.writeFailure) process.exit(1);
} else process.exit(2);
`, { mode: 0o700 });
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step(name)], {
            encoding: 'utf8',
            timeout: 5_000,
            env: {
                ...process.env,
                PATH: `${directory}${path.delimiter}${process.env.PATH}`,
                PR_URL: 'https://github.com/wilmtang/better-peakbagger/pull/123',
                HEAD_SHA: head,
                GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'),
                BPB_QUEUE_CALLS: callsPath,
                BPB_QUEUE_SCENARIO: JSON.stringify(scenario),
            },
        });
        assert.ifError(result.error);
        const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
        return { ...result, calls };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const resetName = 'Reset any previously queued merge';
const queueName = 'Queue the npm merge once required checks pass';

test('reset errors and stale event heads cannot silently leave a queued merge', async () => {
    for (const scenario of [
        { states: [state({ mergeMethod: 'MERGE' })], writeFailure: true },
        { states: [state()], readFailure: true },
        { states: [state(null, { headRefOid: 'b'.repeat(40) })] },
        { states: [state({ mergeMethod: 'MERGE' }), state({ mergeMethod: 'MERGE' })] },
    ]) {
        const result = await runStep(resetName, scenario);
        assert.notEqual(result.status, 0, `reset reported success: ${JSON.stringify(scenario)}`);
        if (scenario.readFailure || scenario.states[0].headRefOid !== head) {
            assert.equal(result.calls.some(call => call[1] === 'merge'), false,
                'an unreadable or stale event must not mutate the current queue');
        }
    }
});

test('reset accepts an already-clear queue and verifies successful removal', async () => {
    for (const queued of [null, { mergeMethod: 'MERGE' }]) {
        const result = await runStep(resetName, { states: [state(queued), state()] });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.calls.filter(call => call.includes('--disable-auto')).length,
            queued ? 1 : 0);
    }
});

test('queue success requires the verified head and a merge request or completed merge', async () => {
    for (const final of [
        state(),
        state({ mergeMethod: 'SQUASH' }),
        state({ mergeMethod: 'MERGE' }, { headRefOid: 'b'.repeat(40) }),
        state(null, { state: 'CLOSED' }),
    ]) {
        const result = await runStep(queueName, { states: [final] });
        assert.notEqual(result.status, 0, `queue reported success: ${JSON.stringify(final)}`);
    }
    for (const final of [state({ mergeMethod: 'MERGE' }), state(null, { state: 'MERGED' })]) {
        const result = await runStep(queueName, { states: [final] });
        assert.equal(result.status, 0, result.stderr);
        const command = result.calls.find(call => call[1] === 'merge');
        assert.equal(command[command.indexOf('--match-head-commit') + 1], head);
        assert.ok(command.includes('--merge'));
    }
});

test('queue API failures stay failures', async () => {
    for (const failure of ['readFailure', 'writeFailure']) {
        const result = await runStep(queueName, {
            states: [state({ mergeMethod: 'MERGE' })], [failure]: true,
        });
        assert.notEqual(result.status, 0, failure);
    }
});

test('merge decisions serialize per PR and use failure-preserving bash', () => {
    assert.deepEqual(workflow.concurrency, {
        group: 'dependabot-auto-merge-${{ github.event.pull_request.number }}',
        'cancel-in-progress': false,
    });
    assert.equal(workflow.defaults.run.shell, 'bash');
});
