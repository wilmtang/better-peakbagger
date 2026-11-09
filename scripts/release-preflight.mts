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
import { acquireEvidence } from './release-evidence.mts';

const execute = promisify(execFile);
const repository = 'wilmtang/better-peakbagger';
const requiredChecks = ['Node tests and lint', 'Scale tests', 'Chrome extension smoke', 'Firefox extension smoke'];
const rehearsalChecks = ['Prepare release candidate', 'Verify release', 'Packaged chrome current',
    'Packaged firefox current', 'Packaged chrome 128', 'Packaged firefox 152.0'];
const storeChecks = ['Upload Chrome Web Store', 'Review Chrome metadata', 'Submit Chrome Web Store', 'Submit Firefox Add-ons'];

// The GitHub API fields these validators read. Every one is untrusted until the
// validator has checked it, so each stays optional.
type Repository = { full_name?: string };
export type VerificationRun = {
    id: number; run_attempt: number; html_url?: string; path?: string; event?: string; head_branch?: string;
    head_sha?: string; status?: string; conclusion?: string; repository?: Repository; head_repository?: Repository;
};
export type VerificationJob = { id?: number; name: string; status?: string; conclusion?: string | null };
type RulesetRule = { type: string; parameters?: {
    strict_required_status_checks_policy?: boolean; required_status_checks: { context: string }[];
} };
export type Ruleset = {
    id?: number; target?: string; enforcement?: string; bypass_actors?: unknown[];
    conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }; rules?: RulesetRule[];
};
type Reviewer = { type: string; reviewer: { id: number } };
export type Environment = {
    id?: number; can_admins_bypass?: boolean; protection_rules?: { type: string; reviewers?: Reviewer[] }[];
    deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean };
};
type Safeguards = { rulesets: Ruleset[]; environment?: Environment; policies?: { type?: string; name?: string }[];
    metadataEnvironment?: Environment; metadataPolicies?: { type?: string; name?: string }[] };
type Artifact = { id?: number; name: string; expired?: boolean; workflow_run?: { id?: number; head_sha?: string } };
type ApiRecord = Record<string, unknown>;
type PreflightDependencies = {
    acquire?: typeof acquireEvidence;
    inspect?: (tag: string) => Promise<string>;
    read?: (file: string, encoding: 'utf8') => Promise<string>;
    request?: (endpoint: string) => Promise<ApiRecord>;
    paginate?: (endpoint: string, key?: string) => Promise<ApiRecord[]>;
    runCommand?: (program: string, args: string[]) => Promise<string>;
};

function requireEvidence(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

export function preflightArguments(args: string[]) {
    const [tag, ...options] = args;
    requireEvidence(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag),
        'Usage: release-preflight.mts vX.Y.Z --ci-run ID --rehearsal-run ID [--output FILE]');
    const values: Record<string, string> = {};
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

export function validateVerificationRun(run: VerificationRun | null | undefined, { commit, workflow, event }: { commit: string; workflow: string; event: string }) {
    requireEvidence(run?.repository?.full_name === repository && run.head_repository?.full_name === repository,
        'Verification must belong to this repository, not a fork');
    requireEvidence(run!.path === `.github/workflows/${workflow}` && run.event === event && run.head_branch === 'main',
        `Expected ${workflow} ${event} on main`);
    requireEvidence(run.head_sha === commit, `${workflow} verified a different commit; rerun CI and rehearsal after changes`);
    requireEvidence(run.status === 'completed' && run.conclusion === 'success', `${workflow} must be terminally successful`);
    requireEvidence(Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
        'Verification run identity is missing');
}

export function validateVerificationJobs(jobs: VerificationJob[], rehearsal = false) {
    requireEvidence(Array.isArray(jobs) && jobs.length > 0, 'Verification jobs are missing');
    for (const job of jobs) {
        requireEvidence(job.status === 'completed' && ['success', 'skipped'].includes(job.conclusion ?? ''),
            `Verification job did not succeed: ${job.name}`);
    }
    const named = (name: string, conclusion: string) => {
        const matches = jobs.filter(job => job.name === name);
        requireEvidence(matches.length === 1 && matches[0].conclusion === conclusion,
            `Expected exactly one ${name} job with conclusion ${conclusion}`);
        return matches[0];
    };
    for (const name of rehearsal ? rehearsalChecks : requiredChecks) named(name, 'success');
    if (rehearsal) for (const name of storeChecks) named(name, 'skipped');
    return rehearsal ? rehearsalChecks.filter(name => name.startsWith('Packaged ')).map(name => named(name, 'success')) : [];
}

export function validateConsecutivePasses(log: string, label: string) {
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

export function validatePublicationSafeguards({ rulesets, environment, policies, metadataEnvironment, metadataPolicies }: Safeguards) {
    const rules = (type: string) => rulesets.filter(rule => rule.target === type && rule.enforcement === 'active');
    const covers = (rule: Ruleset, ref: string) => rule.conditions?.ref_name?.include?.includes(ref)
        && rule.conditions.ref_name?.exclude?.length === 0;
    const main = rules('branch').find(rule => (covers(rule, '~DEFAULT_BRANCH') || covers(rule, 'refs/heads/main'))
        && rule.rules?.some(entry => entry.type === 'required_status_checks'));
    const tags = rules('tag').find(rule => covers(rule, 'refs/tags/v*') && rule.bypass_actors?.length === 0);
    const hasRule = (rule: Ruleset, type: string) => rule?.rules?.some(entry => entry.type === type);
    requireEvidence(main && tags && [main, tags].every(rule => hasRule(rule, 'deletion') && hasRule(rule, 'non_fast_forward')),
        'Active main and immutable v* tag rulesets are required; tag bypasses are forbidden');
    const checks = main.rules?.find(rule => rule.type === 'required_status_checks')?.parameters;
    requireEvidence(checks?.strict_required_status_checks_policy === true
        && requiredChecks.every(name => checks.required_status_checks.some(check => check.context === name)),
    'Main must strictly require the Node, scale, Chrome, and Firefox checks');
    const reviewer = environment?.protection_rules?.find(rule => rule.type === 'required_reviewers');
    requireEvidence(environment?.deployment_branch_policy?.protected_branches === false
        && environment.deployment_branch_policy.custom_branch_policies === true
        && policies?.length === 1 && policies[0].type === 'tag' && policies[0].name === 'v*'
        && reviewer?.reviewers?.length,
    'browser-stores must allow only v* tags and require a reviewer');
    const metadataReviewer = metadataEnvironment?.protection_rules?.find(rule => rule.type === 'required_reviewers');
    requireEvidence(metadataEnvironment?.can_admins_bypass === false
        && metadataEnvironment.deployment_branch_policy?.protected_branches === false
        && metadataEnvironment.deployment_branch_policy.custom_branch_policies === true
        && metadataPolicies?.length === 1 && metadataPolicies[0].type === 'tag' && metadataPolicies[0].name === 'v*'
        && metadataReviewer?.reviewers?.length,
    'chrome-metadata-review must allow only v* tags, require a reviewer and forbid admin bypass');
    return { rulesets: [main.id, tags.id], environment: environment.id, metadataEnvironment: metadataEnvironment.id,
        reviewers: reviewer.reviewers.map(entry => ({ type: entry.type, id: entry.reviewer.id })) };
}

export function selectRehearsalArtifact(artifacts: Artifact[], run: VerificationRun, version: string) {
    const matches = artifacts.filter(artifact => artifact.name === `browser-extension-v${version}-${run.run_attempt}`);
    requireEvidence(matches.length === 1 && matches[0].expired === false
        && matches[0].workflow_run?.id === run.id && matches[0].workflow_run.head_sha === run.head_sha,
    'The successful rehearsal must retain one unexpired package artifact for this attempt and commit');
    return matches[0];
}

async function command(program: string, args: string[]) {
    const result = await execute(program, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return result.stdout.trim();
}
const git = (args: string[]) => command('git', ['-c', 'core.fsmonitor=false', ...args]);
const api = async (endpoint: string): Promise<ApiRecord> => JSON.parse(await command('gh', ['api', '--hostname', 'github.com',
    `repos/${repository}${endpoint ? `/${endpoint}` : ''}`]));
const pages = async (endpoint: string, key?: string): Promise<ApiRecord[]> => JSON.parse(await command('gh', ['api', '--hostname', 'github.com',
    '--paginate', '--slurp', `repos/${repository}/${endpoint}`])).flatMap((page: ApiRecord) => key ? page[key] : page);

async function inspectCandidate(tag: string) {
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

export async function releasePreflight({ tag, ciRunId, rehearsalRunId }: { tag: string; ciRunId: string; rehearsalRunId: string }, {
    inspect = inspectCandidate, read = readFile, request = api, paginate = pages, runCommand = command, acquire = acquireEvidence,
}: PreflightDependencies = {}) {
    const commit = await inspect(tag);
    const [manifest, packageJson, packageLock, changelog] = await Promise.all([
        ...['manifest.json', 'package.json', 'package-lock.json'].map(async name => JSON.parse(await read(name, 'utf8'))),
        read('CHANGELOG.md', 'utf8'),
    ]);
    const version = validateRelease({ tag, manifest, packageJson, packageLock, changelog });
    await runCommand(process.execPath, ['scripts/check-changelog-history.mjs']);
    // A green run from yesterday cannot cover an advisory disclosed today.
    await runCommand(process.execPath, ['scripts/check-npm-audit.mts']);
    await runCommand(process.execPath, ['scripts/release-readiness.mts']);
    const repositoryInfo = await request('');
    requireEvidence(repositoryInfo.default_branch === 'main', 'The protected default branch must remain main');
    const [ruleListings, environment, policyPages, metadataEnvironment, metadataPolicies] = await Promise.all([
        paginate('rulesets?per_page=100'), request('environments/browser-stores'),
        paginate('environments/browser-stores/deployment-branch-policies?per_page=100', 'branch_policies'),
        request('environments/chrome-metadata-review'),
        paginate('environments/chrome-metadata-review/deployment-branch-policies?per_page=100', 'branch_policies'),
    ]) as [Ruleset[], Environment, Safeguards['policies'], Environment, Safeguards['metadataPolicies']];
    const rulesets = await Promise.all(ruleListings.map(rule => request(`rulesets/${rule.id}`))) as Ruleset[];
    const safeguards = validatePublicationSafeguards({ rulesets, environment, policies: policyPages, metadataEnvironment, metadataPolicies });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bpb-release-preflight-'));
    let candidate;
    try {
        candidate = await acquire({ mode: 'publication', commit, version, ciRunId: Number(ciRunId),
            rehearsalRunId: Number(rehearsalRunId), directory });
    } finally { await rm(directory, { recursive: true, force: true }); }
    // Catch a concurrent edit, commit, merge, or remote push during the checks.
    requireEvidence(await inspect(tag) === commit, 'Candidate changed during preflight');
    requireEvidence(candidate.rehearsal, 'Publication evidence is missing its rehearsal');
    return { schemaVersion: 2, checkedAt: new Date().toISOString(), repository, tag, commit,
        ci: candidate.sourceCi, rehearsal: candidate.rehearsal,
        artifact: { id: candidate.rehearsal.artifactId }, packageIdentity: candidate.identity, safeguards };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = preflightArguments(process.argv.slice(2));
        const receipt = `${JSON.stringify(await releasePreflight(options), null, 2)}\n`;
        if (options.output) await writeFile(options.output, receipt, { flag: 'wx' });
        else process.stdout.write(receipt);
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
}
