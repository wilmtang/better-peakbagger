// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateRelease } from './release-check.mjs';
import { validateReleasePreflight } from './release-bump.mjs';
import { verifyPackageIdentity } from './release-package-identity.mjs';

const execute = promisify(execFile);
const repository = 'wilmtang/better-peakbagger';
const requiredChecks = ['Node tests and lint', 'Scale tests', 'Chrome extension smoke', 'Firefox extension smoke'];
const rehearsalChecks = ['Release scale tests', 'Verify release',
    'Packaged chrome 128 floor', 'Packaged firefox 152.0 floor'];
const storeChecks = ['Submit Chrome Web Store', 'Submit Firefox Add-ons'];

function requireEvidence(condition, message) {
    if (!condition) throw new Error(message);
}

export function preflightArguments(args) {
    const [tag, ...options] = args;
    requireEvidence(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag),
        'Usage: release-preflight.mjs vX.Y.Z --ci-run ID --rehearsal-run ID [--output FILE]');
    const values = {};
    for (let index = 0; index < options.length; index += 2) {
        const key = options[index], value = options[index + 1];
        requireEvidence(['--ci-run', '--rehearsal-run', '--output'].includes(key)
            && !Object.hasOwn(values, key) && value && !value.startsWith('--'), `Invalid preflight option: ${key}`);
        values[key] = value;
    }
    for (const key of ['--ci-run', '--rehearsal-run']) {
        requireEvidence(/^[1-9]\d*$/.test(values[key]) && Number.isSafeInteger(Number(values[key])), `${key} requires a run ID`);
    }
    return { tag, ciRunId: values['--ci-run'], rehearsalRunId: values['--rehearsal-run'], output: values['--output'] };
}

export function validateVerificationRun(run, { commit, workflow, event }) {
    requireEvidence(run?.repository?.full_name === repository && run.head_repository?.full_name === repository,
        'Verification must belong to this repository, not a fork');
    requireEvidence(run.path === `.github/workflows/${workflow}` && run.event === event && run.head_branch === 'main',
        `Expected ${workflow} ${event} on main`);
    requireEvidence(run.head_sha === commit, `${workflow} verified a different commit; rerun CI and rehearsal after changes`);
    requireEvidence(run.status === 'completed' && run.conclusion === 'success', `${workflow} must be terminally successful`);
    requireEvidence(Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
        'Verification run identity is missing');
}

export function validateVerificationJobs(jobs, rehearsal = false) {
    requireEvidence(Array.isArray(jobs) && jobs.length > 0, 'Verification jobs are missing');
    for (const job of jobs) {
        requireEvidence(job.status === 'completed' && ['success', 'skipped'].includes(job.conclusion),
            `Verification job did not succeed: ${job.name}`);
    }
    const named = (name, conclusion) => {
        const matches = jobs.filter(job => job.name === name);
        requireEvidence(matches.length === 1 && matches[0].conclusion === conclusion,
            `Expected exactly one ${name} job with conclusion ${conclusion}`);
        return matches[0];
    };
    for (const name of rehearsal ? rehearsalChecks : requiredChecks) named(name, 'success');
    if (rehearsal) for (const name of storeChecks) named(name, 'skipped');
    return rehearsal ? rehearsalChecks.slice(1).map(name => named(name, 'success')) : [];
}

export function validateConsecutivePasses(log, label) {
    if (label === 'Verify release') {
        // Unit tests exercise repeatVerification too. Their synthetic passes
        // must never count as archive execution, nor obscure the real proof.
        const boundaries = [...log.matchAll(/> node scripts\/verify-store-packages\.mjs(?=\r?$)/gm)];
        requireEvidence(boundaries.length === 1, 'The current-package execution boundary is missing or ambiguous');
        log = log.slice(boundaries[0].index + boundaries[0][0].length);
    }
    const markers = [...log.matchAll(/Verification repetition (\d+)\/(\d+) (started|passed, including teardown)\.(?=\r?$)/gm)];
    const count = Number(markers[0]?.[2]);
    requireEvidence([3, 5].includes(count) && markers.length === count * 2,
        `${label} requires three or five consecutive passes, including teardown`);
    for (let index = 0; index < markers.length; index++) {
        requireEvidence(Number(markers[index][1]) === Math.floor(index / 2) + 1
            && Number(markers[index][2]) === count
            && markers[index][3] === (index % 2 ? 'passed, including teardown' : 'started'),
        `${label} has incomplete, repeated, or out-of-order verification passes`);
    }
    return count;
}

export function validatePublicationSafeguards({ rulesets, environment, policies }) {
    const rules = type => rulesets.filter(rule => rule.target === type && rule.enforcement === 'active');
    const covers = (rule, ref) => rule.conditions?.ref_name?.include?.includes(ref)
        && rule.conditions.ref_name.exclude?.length === 0;
    const main = rules('branch').find(rule => covers(rule, '~DEFAULT_BRANCH') || covers(rule, 'refs/heads/main'));
    const tags = rules('tag').find(rule => covers(rule, 'refs/tags/v*') && rule.bypass_actors?.length === 0);
    const hasRule = (rule, type) => rule?.rules?.some(entry => entry.type === type);
    requireEvidence(main && tags && [main, tags].every(rule => hasRule(rule, 'deletion') && hasRule(rule, 'non_fast_forward')),
        'Active main and immutable v* tag rulesets are required; tag bypasses are forbidden');
    const checks = main.rules.find(rule => rule.type === 'required_status_checks')?.parameters;
    requireEvidence(checks?.strict_required_status_checks_policy === true
        && requiredChecks.every(name => checks.required_status_checks.some(check => check.context === name)),
    'Main must strictly require the Node, scale, Chrome, and Firefox checks');
    const reviewer = environment?.protection_rules?.find(rule => rule.type === 'required_reviewers');
    requireEvidence(environment?.deployment_branch_policy?.protected_branches === false
        && environment.deployment_branch_policy.custom_branch_policies === true
        && policies?.length === 1 && policies[0].type === 'tag' && policies[0].name === 'v*'
        && reviewer?.reviewers?.length > 0,
    'browser-stores must allow only v* tags and require a reviewer');
    return { rulesets: [main.id, tags.id], environment: environment.id,
        reviewers: reviewer.reviewers.map(entry => ({ type: entry.type, id: entry.reviewer.id })) };
}

export function selectRehearsalArtifact(artifacts, run, version) {
    const matches = artifacts.filter(artifact => artifact.name === `browser-extension-v${version}-${run.run_attempt}`);
    requireEvidence(matches.length === 1 && matches[0].expired === false
        && matches[0].workflow_run?.id === run.id && matches[0].workflow_run.head_sha === run.head_sha,
    'The successful rehearsal must retain one unexpired package artifact for this attempt and commit');
    return matches[0];
}

async function command(program, args) {
    const result = await execute(program, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return result.stdout.trim();
}
const git = args => command('git', ['-c', 'core.fsmonitor=false', ...args]);
const api = async endpoint => JSON.parse(await command('gh', ['api', '--hostname', 'github.com',
    `repos/${repository}${endpoint ? `/${endpoint}` : ''}`]));
const pages = async (endpoint, key) => JSON.parse(await command('gh', ['api', '--hostname', 'github.com',
    '--paginate', '--slurp', `repos/${repository}/${endpoint}`])).flatMap(page => key ? page[key] : page);

async function inspectCandidate(tag) {
    const remote = await git(['remote', 'get-url', 'origin']);
    requireEvidence([`https://github.com/${repository}.git`, `https://github.com/${repository}`,
        `git@github.com:${repository}.git`].includes(remote), 'origin must be the canonical GitHub repository');
    const [branch, status, commit, trackingMain, localTags] = await Promise.all([
        git(['branch', '--show-current']), git(['status', '--porcelain=v1', '--untracked-files=normal']),
        git(['rev-parse', 'HEAD']), git(['rev-parse', 'refs/remotes/origin/main']),
        git(['tag', '--list', tag]),
    ]);
    validateReleasePreflight({ branch, status, headCommit: commit, originMainCommit: trackingMain,
        localTagExists: localTags !== '', remoteTagExists: false, tag });
    const refs = await git(['ls-remote', 'origin', 'refs/heads/main', `refs/tags/${tag}`]);
    requireEvidence(!refs.split('\n').some(line => line.endsWith(`\trefs/tags/${tag}`)), `Release tag ${tag} already exists on origin`);
    requireEvidence(refs === `${commit}\trefs/heads/main`, 'Remote main changed; fetch, inspect changes, and verify the new commit');
    return commit;
}

export async function releasePreflight({ tag, ciRunId, rehearsalRunId }, {
    inspect = inspectCandidate, read = readFile, request = api, paginate = pages, runCommand = command,
} = {}) {
    const commit = await inspect(tag);
    const [manifest, packageJson, packageLock, changelog] = await Promise.all([
        ...['manifest.json', 'package.json', 'package-lock.json'].map(async name => JSON.parse(await read(name, 'utf8'))),
        read('CHANGELOG.md', 'utf8'),
    ]);
    const version = validateRelease({ tag, manifest, packageJson, packageLock, changelog });
    await runCommand(process.execPath, ['scripts/check-changelog-history.mjs']);
    // A green run from yesterday cannot extend an advisory exception today.
    await runCommand(process.execPath, ['scripts/check-npm-audit.mjs', '--allow-reviewed-development-advisory']);
    const [ci, rehearsal, repositoryInfo] = await Promise.all([
        request(`actions/runs/${ciRunId}`), request(`actions/runs/${rehearsalRunId}`), request(''),
    ]);
    requireEvidence(repositoryInfo.default_branch === 'main', 'The protected default branch must remain main');
    validateVerificationRun(ci, { commit, workflow: 'test.yml', event: 'push' });
    validateVerificationRun(rehearsal, { commit, workflow: 'release.yml', event: 'workflow_dispatch' });
    // A new rehearsal retains failed attempts as evidence instead of replacing
    // them with a green retry. Every component must pass in that fresh run.
    requireEvidence(rehearsal.run_attempt === 1, 'Use a fresh successful rehearsal, not a rerun of a failed rehearsal');
    const [ciJobs, rehearsalJobs] = await Promise.all([ci, rehearsal].map(run =>
        paginate(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs')));
    validateVerificationJobs(ciJobs);
    const browserJobs = validateVerificationJobs(rehearsalJobs, true);
    const repetitions = {};
    for (const job of browserJobs) {
        const log = await runCommand('gh', ['run', 'view', String(rehearsal.id), '--repo', repository,
            '--attempt', String(rehearsal.run_attempt), '--job', String(job.id), '--log']);
        repetitions[job.name] = validateConsecutivePasses(log, job.name);
    }
    requireEvidence(new Set(Object.values(repetitions)).size === 1, 'Every browser must complete the same repetition count');
    const [artifacts, ruleListings, environment, policyPages] = await Promise.all([
        paginate(`actions/runs/${rehearsal.id}/artifacts?per_page=100`, 'artifacts'),
        paginate('rulesets?per_page=100'), request('environments/browser-stores'),
        paginate('environments/browser-stores/deployment-branch-policies?per_page=100', 'branch_policies'),
    ]);
    const artifact = selectRehearsalArtifact(artifacts, rehearsal, version);
    const rulesets = await Promise.all(ruleListings.map(rule => request(`rulesets/${rule.id}`)));
    const safeguards = validatePublicationSafeguards({ rulesets, environment, policies: policyPages });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bpb-release-preflight-'));
    let identity;
    try {
        await runCommand('gh', ['run', 'download', String(rehearsal.id), '--repo', repository,
            '--name', artifact.name, '--dir', directory]);
        identity = await verifyPackageIdentity(directory, version, commit);
    } finally { await rm(directory, { recursive: true, force: true }); }
    // Catch a concurrent edit, commit, merge, or remote push during the checks.
    requireEvidence(await inspect(tag) === commit, 'Candidate changed during preflight');
    return { schemaVersion: 1, checkedAt: new Date().toISOString(), repository, tag, commit,
        ci: { id: ci.id, attempt: ci.run_attempt, url: ci.html_url },
        rehearsal: { id: rehearsal.id, attempt: rehearsal.run_attempt, url: rehearsal.html_url, repetitions },
        artifact: { id: artifact.id, name: artifact.name }, packageIdentity: identity, safeguards };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = preflightArguments(process.argv.slice(2));
        const receipt = `${JSON.stringify(await releasePreflight(options), null, 2)}\n`;
        if (options.output) await writeFile(options.output, receipt, { flag: 'wx' });
        else process.stdout.write(receipt);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
