// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
    preflightArguments, releasePreflight, selectRehearsalArtifact, validateConsecutivePasses,
    validatePublicationSafeguards, validateVerificationJobs, validateVerificationRun,
} from '../../scripts/release-preflight.mjs';
import { writePackageIdentity } from '../../scripts/release-package-identity.mjs';

const commit = 'a'.repeat(40);
const repo = { full_name: 'wilmtang/better-peakbagger' };
const run = { id: 123, run_attempt: 1, repository: repo, head_repository: repo,
    path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: 'main',
    head_sha: commit, status: 'completed', conclusion: 'success' };
const expectation = { commit, workflow: 'release.yml', event: 'workflow_dispatch' };
const job = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
const ciJobs = () => ['Node tests and lint', 'Scale tests', 'Chrome extension smoke', 'Firefox extension smoke'].map(name => job(name));
const rehearsalJobs = () => ['Release scale tests', 'Verify release', 'Packaged chrome 128 floor',
    'Packaged firefox 152.0 floor'].map(name => job(name)).concat([
    job('Submit Chrome Web Store', 'skipped'), job('Submit Firefox Add-ons', 'skipped'),
]);
const log = count => Array.from({ length: count }, (_, index) => [
    `job\tstep\t2026-10-15T00:00:00Z Verification repetition ${index + 1}/${count} started.`,
    `job\tstep\t2026-10-15T00:00:01Z Verification repetition ${index + 1}/${count} passed, including teardown.`,
].join('\n')).join('\n');

test('preflight requires explicit run identities and rejects ambiguous or unknown options', () => {
    const args = ['v4.0.2', '--ci-run', '123', '--rehearsal-run', '456'];
    assert.deepEqual(preflightArguments(args), { tag: 'v4.0.2', ciRunId: '123', rehearsalRunId: '456', output: undefined });
    assert.equal(preflightArguments([...args, '--output', '/tmp/release.json']).output, '/tmp/release.json');
    for (const invalid of [[], ['4.0.2'], ['v04.0.2'], args.slice(0, -1),
        [...args, '--ci-run', '234'], [...args, '--publish'], [...args, '--output'],
        ['v4.0.2', '--ci-run', '01', '--rehearsal-run', '456'],
        ['v4.0.2', '--ci-run', '9007199254740993', '--rehearsal-run', '456']]) {
        assert.throws(() => preflightArguments(invalid), /Usage|Invalid|requires a run ID/);
    }
});

test('only a terminal successful run of the exact workflow, repository, event, main, and commit qualifies', () => {
    assert.doesNotThrow(() => validateVerificationRun(run, expectation));
    for (const change of [{ head_sha: 'b'.repeat(40) }, { status: 'in_progress' }, { conclusion: 'failure' },
        { head_branch: 'codex/other' }, { event: 'push' }, { path: '.github/workflows/other.yml' },
        { repository: { full_name: 'other/repo' } }, { head_repository: { full_name: 'fork/repo' } },
        { id: undefined }, { run_attempt: 0 }]) {
        assert.throws(() => validateVerificationRun({ ...run, ...change }, expectation));
    }
});

test('all required CI and rehearsal jobs must pass, and both store jobs must remain skipped', () => {
    assert.deepEqual(validateVerificationJobs(ciJobs()), []);
    assert.equal(validateVerificationJobs(rehearsalJobs(), true).length, 3);
    for (const rehearsal of [false, true]) {
        const jobs = rehearsal ? rehearsalJobs() : ciJobs();
        for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
            assert.throws(() => validateVerificationJobs([{ ...jobs[0], conclusion }, ...jobs.slice(1)], rehearsal));
        }
        assert.throws(() => validateVerificationJobs(jobs.slice(1), rehearsal));
        assert.throws(() => validateVerificationJobs([...jobs, jobs[0]], rehearsal));
        assert.throws(() => validateVerificationJobs([{ ...jobs[0], status: 'in_progress' }, ...jobs.slice(1)], rehearsal));
    }
    for (const name of ['Submit Chrome Web Store', 'Submit Firefox Add-ons']) {
        assert.throws(() => validateVerificationJobs(rehearsalJobs().map(entry =>
            entry.name === name ? job(name) : entry), true), /conclusion skipped/);
    }
    assert.throws(() => validateVerificationJobs([]), /jobs are missing/);
});

test('rehearsal proof requires all ordered passes and teardown, without hiding a first failure', () => {
    for (const count of [3, 5]) assert.equal(validateConsecutivePasses(log(count), 'Chrome'), count);
    for (const invalid of ['', log(1), log(3).replace('3/3 passed, including teardown.', '3/3 failed.'),
        log(3).replace('2/3 passed, including teardown.', '2/3 passed.'),
        log(3).replace('2/3 started.', '1/3 started.'), log(3).replaceAll('2/3', '2/5'),
        `${log(3)}\n${log(3)}`, log(3).split('\n').reverse().join('\n')]) {
        assert.throws(() => validateConsecutivePasses(invalid, 'Chrome'), /Chrome.*passes/);
    }
    const boundary = '> node scripts/verify-store-packages.mjs\n';
    assert.equal(validateConsecutivePasses(`${log(3)}\n${boundary}${log(3)}`, 'Verify release'), 3);
    assert.throws(() => validateConsecutivePasses(`${log(3)}\n${boundary}${log(1)}`, 'Verify release'), /consecutive passes/);
    assert.throws(() => validateConsecutivePasses(log(3), 'Verify release'), /boundary/);
    assert.throws(() => validateConsecutivePasses(`${boundary}${log(3)}\n${boundary}`, 'Verify release'), /ambiguous/);
});

function safeguards() {
    return {
        rulesets: [
            { id: 1, target: 'branch', enforcement: 'active', bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5 }],
                conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
                rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'required_status_checks', parameters: {
                    strict_required_status_checks_policy: true,
                    required_status_checks: ciJobs().map(entry => ({ context: entry.name })),
                } }] },
            { id: 2, target: 'tag', enforcement: 'active', bypass_actors: [],
                conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
                rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] },
        ],
        environment: { id: 3, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
            protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 4 } }] }] },
        policies: [{ type: 'tag', name: 'v*' }],
    };
}

test('preflight requires active strict main checks, immutable tags, and owner-controlled store review', () => {
    assert.deepEqual(validatePublicationSafeguards(safeguards()), {
        rulesets: [1, 2], environment: 3, reviewers: [{ type: 'User', id: 4 }],
    });
    const changes = [
        state => { state.rulesets[0].rules.pop(); },
        state => { state.rulesets[0].rules[2].parameters.strict_required_status_checks_policy = false; },
        state => { state.rulesets[0].rules[2].parameters.required_status_checks.pop(); },
        state => { state.rulesets[1].enforcement = 'evaluate'; },
        state => { state.rulesets[1].bypass_actors.push({ actor_id: 5 }); },
        state => { state.rulesets[1].rules.pop(); },
        state => { state.rulesets[1].conditions.ref_name.exclude.push('refs/tags/v4*'); },
        state => { state.environment.protection_rules = []; },
        state => { state.environment.protection_rules[0].reviewers = []; },
        state => { state.environment.deployment_branch_policy.protected_branches = true; },
        state => { state.policies.push({ name: 'main', type: 'branch' }); },
        state => { state.policies[0].type = 'branch'; },
    ];
    for (const change of changes) {
        const state = safeguards(); change(state);
        assert.throws(() => validatePublicationSafeguards(state));
    }
});

test('the rehearsal artifact must belong to the exact successful attempt and commit', () => {
    const artifact = { id: 42, name: 'browser-extension-v4.0.2-1', expired: false,
        workflow_run: { id: run.id, head_sha: commit } };
    assert.equal(selectRehearsalArtifact([artifact], run, '4.0.2').id, 42);
    for (const artifacts of [[], [artifact, artifact], [{ ...artifact, expired: true }],
        [{ ...artifact, name: 'browser-extension-v4.0.2-2' }],
        [{ ...artifact, workflow_run: { id: 456, head_sha: commit } }],
        [{ ...artifact, workflow_run: { id: run.id, head_sha: 'b'.repeat(40) } }]]) {
        assert.throws(() => selectRehearsalArtifact(artifacts, run, '4.0.2'), /unexpired package artifact/);
    }
});

test('preflight pins a complete receipt, rejects changed candidates, and removes downloads on success or hash failure', async t => {
    for (const failure of [null, 'changed', 'hash', 'rerun', 'one-pass', 'mixed-passes']) {
        await t.test(failure || 'successful receipt', async () => {
            const state = safeguards();
            let inspections = 0, directory, commands = 0;
            const requests = [];
            const artifact = { id: 42, name: 'browser-extension-v4.0.2-1', expired: false,
                workflow_run: { id: 123, head_sha: commit } };
            const options = {
                inspect: async tag => {
                    assert.equal(tag, 'v4.0.2');
                    return ++inspections === 2 && failure === 'changed' ? 'b'.repeat(40) : commit;
                },
                read: async name => {
                    if (name === 'CHANGELOG.md') return '# Changelog\n\n## 4.0.2 — 2026-10-16\n\n- Changes.\n';
                    return JSON.stringify({ version: '4.0.2', packages: { '': { version: '4.0.2' } },
                        browser_specific_settings: { gecko: { id: 'test@example.test' } } });
                },
                request: async endpoint => {
                    requests.push(endpoint);
                    if (!endpoint) return { default_branch: 'main' };
                    if (endpoint === 'actions/runs/456') return { ...run, id: 456, path: '.github/workflows/test.yml', event: 'push' };
                    if (endpoint === 'actions/runs/123') return { ...run, run_attempt: failure === 'rerun' ? 2 : 1 };
                    if (endpoint === 'environments/browser-stores') return state.environment;
                    if (endpoint.startsWith('rulesets/')) return state.rulesets.find(rule => rule.id === Number(endpoint.split('/')[1]));
                    assert.fail(`Unexpected request: ${endpoint}`);
                },
                paginate: async endpoint => {
                    requests.push(endpoint);
                    if (endpoint.includes('/456/attempts/1/jobs')) return ciJobs();
                    if (endpoint.includes('/123/attempts/1/jobs')) return rehearsalJobs().map((entry, id) => ({ ...entry, id }));
                    if (endpoint.endsWith('/artifacts?per_page=100')) return [artifact];
                    if (endpoint === 'rulesets?per_page=100') return state.rulesets;
                    if (endpoint.includes('deployment-branch-policies')) return state.policies;
                    assert.fail(`Unexpected pagination: ${endpoint}`);
                },
                runCommand: async (program, args) => {
                    commands++;
                    if (program === process.execPath) {
                        assert.ok([
                            'scripts/check-changelog-history.mjs', 'scripts/check-npm-audit.mjs',
                        ].includes(args[0]));
                        if (args[0] === 'scripts/check-npm-audit.mjs') assert.deepEqual(args.slice(1), ['--allow-reviewed-development-advisory']);
                        return '';
                    }
                    assert.equal(program, 'gh');
                    if (args[1] === 'view') return '> node scripts/verify-store-packages.mjs\n'
                        + log(failure === 'one-pass' ? 1
                            : failure === 'mixed-passes' && args[args.indexOf('--job') + 1] === '2' ? 5 : 3);
                    assert.equal(args[1], 'download');
                    directory = args[args.indexOf('--dir') + 1];
                    for (const suffix of ['', '-firefox']) await writeFile(path.join(directory, `better_peakbagger-4.0.2${suffix}.zip`), 'verified package');
                    await writePackageIdentity(directory, '4.0.2', commit);
                    if (failure === 'hash') await writeFile(path.join(directory, 'better_peakbagger-4.0.2.zip'), 'changed bytes');
                    return '';
                },
            };
            const pending = releasePreflight({ tag: 'v4.0.2', ciRunId: '456', rehearsalRunId: '123' }, options);
            if (failure) await assert.rejects(pending, /Candidate changed|Package identity|fresh successful rehearsal|consecutive passes|same repetition count/);
            else {
                const receipt = await pending;
                assert.equal(receipt.commit, commit);
                assert.equal(receipt.rehearsal.id, 123);
                assert.equal(receipt.ci.id, 456);
                assert.equal(receipt.artifact.id, 42);
                assert.equal(receipt.packageIdentity.commit, commit);
                assert.deepEqual(receipt.safeguards.rulesets, [1, 2]);
                assert.equal(inspections, 2);
                assert.ok(commands > 0 && requests.length > 0);
            }
            if (directory) await assert.rejects(access(directory), { code: 'ENOENT' });
        });
    }
});
