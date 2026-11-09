// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { verifyPackageIdentity, packageIdentityDigest } from './release-package-identity.mts';
import { validateVerificationRun, validateVerificationJobs, validateConsecutivePasses,
    validatePublicationSafeguards, type VerificationRun, type VerificationJob } from './release-preflight.mts';

export const releaseRepository = 'wilmtang/better-peakbagger';
export const evidenceAgeMs = 24 * 60 * 60_000;
const execute = promisify(execFile);
type Run = VerificationRun & { run_started_at?: string };
type Job = VerificationJob & { started_at?: string; completed_at?: string };
export type EvidenceArtifact = { id: number; name: string; digest: string; expired: boolean; created_at: string;
    workflow_run: { id: number; head_sha: string } };
export type EvidenceDependencies = {
    request: (endpoint: string) => Promise<unknown>;
    paginate: (endpoint: string, key?: string) => Promise<unknown[]>;
    download: (id: number) => Promise<Buffer>;
    log: (id: number) => Promise<string>;
    now: () => number;
};
export const evidenceApiPath = (endpoint: string) => `repos/${releaseRepository}${endpoint ? `/${endpoint}` : ''}`;
export const evidenceDependencies: EvidenceDependencies = {
    request: async endpoint => JSON.parse((await execute('gh', ['api', '--hostname', 'github.com', evidenceApiPath(endpoint)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout),
    paginate: async (endpoint, key) => JSON.parse((await execute('gh', ['api', '--hostname', 'github.com', '--paginate', '--slurp', evidenceApiPath(endpoint)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout).flatMap((page: Record<string, unknown>) => key ? page[key] : page),
    download: async id => (await execute('gh', ['api', '--hostname', 'github.com', `repos/${releaseRepository}/actions/artifacts/${id}/zip`], { encoding: 'buffer', maxBuffer: 200 * 1024 * 1024, timeout: 60_000 })).stdout,
    // The job-log CLI handles GitHub's ANSI-formatted log response. Raw api
    // output is rejected by current gh releases; never relax terminal safety.
    log: async id => (await execute('gh', ['run', 'view', '--job', String(evidenceId(id)), '--repo', `github.com/${releaseRepository}`, '--log'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout,
    now: Date.now,
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function evidenceId(value: unknown) {
    assert.match(String(value), /^[1-9]\d*$/, 'Evidence requires a positive run/artifact ID');
    assert.ok(Number.isSafeInteger(Number(value)), 'Unsafe evidence ID');
    return Number(value);
}
function fresh(value: string | undefined, now: number) {
    const time = Date.parse(value ?? '');
    assert.ok(Number.isFinite(time) && time <= now && time >= now - evidenceAgeMs, 'Missing, future or stale evidence timestamp');
    return time;
}
export function validateFreshJobs(run: Run, jobs: Job[], now: number) {
    const start = fresh(run.run_started_at, now);
    for (const job of jobs.filter(item => item.conclusion === 'success')) {
        const began = fresh(job.started_at, now), completed = fresh(job.completed_at, now);
        assert.ok(began >= start && completed >= began, `Job ${job.name} belongs to stale or inconsistent coverage`);
    }
}
export function selectEvidenceArtifact(artifacts: EvidenceArtifact[], run: Run, name: string, now: number) {
    const matches = artifacts.filter(item => item.name === name);
    assert.equal(matches.length, 1, 'Missing or ambiguous exact-attempt evidence artifact');
    const artifact = matches[0]!;
    evidenceId(artifact.id);
    assert.equal(artifact.expired, false, 'Evidence artifact expired');
    assert.equal(artifact.workflow_run?.id, run.id, 'Artifact belongs to another run');
    assert.equal(artifact.workflow_run?.head_sha, run.head_sha, 'Artifact belongs to another commit');
    assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/, 'Missing GitHub artifact SHA-256');
    assert.ok(fresh(artifact.created_at, now) >= Date.parse(run.run_started_at!), 'Artifact belongs to an earlier attempt');
    return artifact;
}
export async function extractEvidenceArchive(bytes: Buffer, artifact: EvidenceArtifact, directory: string, version: string) {
    assert.equal(`sha256:${hash(bytes)}`, artifact.digest, 'GitHub artifact digest mismatch');
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const allowed = new Set([`better_peakbagger-${version}.zip`, `better_peakbagger-${version}-firefox.zip`, 'package-identity.json', 'candidate-evidence.json']);
    await mkdir(directory, { recursive: true });
    for (const entry of Object.values(zip.files)) {
        assert.ok(!entry.dir && allowed.has(entry.name) && entry.unsafeOriginalName === entry.name, 'Unexpected evidence artifact entry');
        const data = await entry.async('nodebuffer');
        assert.ok(data.length <= 100 * 1024 * 1024, 'Evidence entry exceeds byte budget');
        await writeFile(path.join(directory, entry.name), data, { flag: 'wx' });
    }
}
type Snapshot = { run: Run; artifact: EvidenceArtifact; jobs: Job[] };
type CandidateReceipt = { schemaVersion: 1; sourceCi: { id: number; attempt: number; artifactId: number; digest: string }; packageIdentity: unknown };
async function snapshot(runId: number, workflow: string, event: string, commit: string, version: string, deps: EvidenceDependencies): Promise<Snapshot> {
    const run = await deps.request(`actions/runs/${evidenceId(runId)}`) as Run;
    assert.equal(run.id, runId, 'Run response identity mismatch');
    validateVerificationRun(run, { commit, workflow, event });
    const rehearsal = workflow === 'release.yml';
    if (rehearsal) assert.equal(run.run_attempt, 1, 'A rehearsal must succeed on its first attempt');
    const jobs = await deps.paginate(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs') as Job[];
    const browsers = validateVerificationJobs(jobs, rehearsal);
    validateFreshJobs(run, jobs, deps.now());
    if (rehearsal) {
        const counts = await Promise.all(browsers.map(async job => validateConsecutivePasses(await deps.log(evidenceId(job.id)), job.name)));
        assert.equal(new Set(counts).size, 1, 'Every browser must complete the same repetition count');
    }
    const artifacts = await deps.paginate(`actions/runs/${run.id}/artifacts?per_page=100`, 'artifacts') as EvidenceArtifact[];
    const name = rehearsal ? `browser-extension-v${version}-${run.run_attempt}` : `ci-packages-${commit}-${run.run_attempt}`;
    return { run, jobs, artifact: selectEvidenceArtifact(artifacts, run, name, deps.now()) };
}
async function unchanged(state: Snapshot, deps: EvidenceDependencies) {
    const current = await deps.request(`actions/runs/${state.run.id}`) as Run;
    assert.equal(current.run_attempt, state.run.run_attempt, 'Run attempt changed during acquisition');
    assert.equal(current.status, 'completed'); assert.equal(current.conclusion, 'success');
    assert.equal(current.head_sha, state.run.head_sha); assert.equal(current.path, state.run.path);
    const currentArtifact = await deps.request(`actions/artifacts/${state.artifact.id}`) as EvidenceArtifact;
    assert.deepEqual(currentArtifact, state.artifact, 'Artifact metadata changed during acquisition');
    validateFreshJobs(state.run, state.jobs, deps.now());
    selectEvidenceArtifact([currentArtifact], state.run, state.artifact.name, deps.now());
}
async function load(state: Snapshot, directory: string, version: string, commit: string, deps: EvidenceDependencies) {
    await extractEvidenceArchive(await deps.download(state.artifact.id), state.artifact, directory, version);
    const identity = await verifyPackageIdentity(directory, version, commit);
    await unchanged(state, deps);
    return identity;
}
export async function latestRehearsal(commit: string, deps = evidenceDependencies) {
    const runs = await deps.paginate(`actions/workflows/release.yml/runs?event=workflow_dispatch&head_sha=${commit}&per_page=100`, 'workflow_runs') as Run[];
    const eligible = runs.filter(run => run.head_sha === commit && run.head_branch === 'main' && run.event === 'workflow_dispatch');
    eligible.sort((a, b) => b.id - a.id);
    assert.ok(eligible[0], 'No main rehearsal exists for this exact commit');
    return evidenceId(eligible[0].id);
}
export async function acquireEvidence({ mode, commit, version, ciRunId, rehearsalRunId, directory }: {
    mode: 'rehearsal' | 'publication'; commit: string; version: string; ciRunId?: number; rehearsalRunId?: number; directory: string;
}, deps = evidenceDependencies) {
    assert.match(commit, /^[a-f0-9]{40}$/); assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    if (mode === 'rehearsal') {
        const source = await snapshot(evidenceId(ciRunId), 'test.yml', 'push', commit, version, deps);
        const identity = await load(source, directory, version, commit, deps);
        const receipt: CandidateReceipt = { schemaVersion: 1, sourceCi: { id: source.run.id, attempt: source.run.run_attempt,
            artifactId: source.artifact.id, digest: source.artifact.digest }, packageIdentity: identity };
        await writeFile(path.join(directory, 'candidate-evidence.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
        return { identity, sourceCi: receipt.sourceCi, expiresAt: new Date(Date.parse(source.run.run_started_at!) + evidenceAgeMs).toISOString() };
    }
    assert.equal(mode, 'publication');
    const selected = await latestRehearsal(commit, deps);
    if (rehearsalRunId !== undefined) assert.equal(selected, evidenceId(rehearsalRunId), 'A newer exact-commit rehearsal supersedes the requested run');
    const rehearsal = await snapshot(selected, 'release.yml', 'workflow_dispatch', commit, version, deps);
    const identity = await load(rehearsal, directory, version, commit, deps);
    const receipt = JSON.parse(await readFile(path.join(directory, 'candidate-evidence.json'), 'utf8')) as CandidateReceipt;
    assert.equal(receipt.schemaVersion, 1); evidenceId(receipt.sourceCi?.id);
    if (ciRunId !== undefined) assert.equal(receipt.sourceCi.id, evidenceId(ciRunId), 'Rehearsal used another CI run');
    const source = await snapshot(receipt.sourceCi.id, 'test.yml', 'push', commit, version, deps);
    assert.deepEqual(receipt.sourceCi, { id: source.run.id, attempt: source.run.run_attempt,
        artifactId: source.artifact.id, digest: source.artifact.digest }, 'Rehearsal CI linkage changed');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'bpb-promote-ci-'));
    try {
        const original = await load(source, temp, version, commit, deps);
        assert.deepEqual(identity, original, 'Rehearsal changed the CI package bytes');
        assert.deepEqual(receipt.packageIdentity, identity, 'Receipt package identity differs');
    } finally { await rm(temp, { recursive: true, force: true }); }
    assert.equal(await latestRehearsal(commit, deps), selected, 'Rehearsal selection changed during acquisition');
    await unchanged(rehearsal, deps);
    validateFreshJobs(source.run, source.jobs, deps.now());
    return { identity, sourceCi: receipt.sourceCi, expiresAt: new Date(Math.min(Date.parse(source.run.run_started_at!), Date.parse(rehearsal.run.run_started_at!)) + evidenceAgeMs).toISOString(), rehearsal: { id: selected, attempt: 1, artifactId: rehearsal.artifact.id, digest: rehearsal.artifact.digest } };
}

export async function remotePublicationSafeguards(deps = evidenceDependencies) {
    const info = await deps.request('') as { default_branch?: string };
    assert.equal(info.default_branch, 'main', 'Protected default branch must remain main');
    const rules = await deps.paginate('rulesets?per_page=100') as { id: number }[];
    const rulesets = await Promise.all(rules.map(rule => deps.request(`rulesets/${evidenceId(rule.id)}`)));
    const environment = await deps.request('environments/browser-stores');
    const policies = await deps.paginate('environments/browser-stores/deployment-branch-policies?per_page=100', 'branch_policies');
    const metadataEnvironment = await deps.request('environments/chrome-metadata-review');
    const metadataPolicies = await deps.paginate('environments/chrome-metadata-review/deployment-branch-policies?per_page=100', 'branch_policies');
    return validatePublicationSafeguards({ rulesets, environment, policies, metadataEnvironment, metadataPolicies } as Parameters<typeof validatePublicationSafeguards>[0]);
}

export function assertPublicationDeadline(value: string | undefined, now = Date.now()) {
    const deadline = Date.parse(value ?? '');
    assert.ok(Number.isFinite(deadline) && new Date(deadline).toISOString() === value
        && deadline > now && deadline <= now + evidenceAgeMs, 'Missing, invalid or expired publication evidence deadline');
}

export async function revalidateEvidence({ commit, version, expectedIdentity, directory }: {
    commit: string; version: string; expectedIdentity: string; directory: string;
}, deps = evidenceDependencies) {
    assert.match(expectedIdentity, /^[a-f0-9]{64}$/, 'Missing independently pinned package identity');
    await verifyPackageIdentity(directory, version, commit, expectedIdentity);
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'bpb-revalidate-'));
    try {
        const result = await acquireEvidence({ mode: 'publication', commit, version, directory: temporary }, deps);
        assert.equal(packageIdentityDigest(result.identity), expectedIdentity, 'Revalidated package identity changed');
        return result;
    } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [mode, ...extra] = process.argv.slice(2);
    assert.ok(!extra.length && ['rehearsal', 'publication', 'revalidate', 'assert-fresh'].includes(mode!), 'Usage: release-evidence.mts rehearsal|publication|revalidate|assert-fresh');
    assert.equal(process.env.GITHUB_REPOSITORY, releaseRepository);
    assert.equal(process.env.GITHUB_EVENT_NAME, mode === 'rehearsal' ? 'workflow_dispatch' : 'push');
    if (mode === 'rehearsal') assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Rehearse the protected main branch');
    else assert.match(process.env.GITHUB_REF ?? '', /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    if (mode === 'assert-fresh') {
        assertPublicationDeadline(process.env.BPB_RELEASE_EVIDENCE_EXPIRES_AT);
        console.log('Publication evidence is still within its original validity window.');
        process.exit(0);
    }
    await remotePublicationSafeguards();
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
    if (mode === 'revalidate') {
        const result = await revalidateEvidence({ commit: process.env.GITHUB_SHA!, version: manifest.version,
            expectedIdentity: process.env.EXPECTED_IDENTITY ?? '', directory: 'release-package' });
        assertPublicationDeadline(result.expiresAt);
        if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `BPB_RELEASE_EVIDENCE_EXPIRES_AT=${result.expiresAt}\n`);
        console.log('Fresh publication evidence and package identity revalidated.');
    } else {
        const result = await acquireEvidence({ mode: mode as 'rehearsal' | 'publication', commit: process.env.GITHUB_SHA!, version: manifest.version,
            ciRunId: mode === 'rehearsal' ? evidenceId(process.env.BPB_CI_RUN) : undefined, directory: 'release-package' });
        await writeFile('acquisition-evidence.json', JSON.stringify(result, null, 2));
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${manifest.version}\nidentity-sha256=${packageIdentityDigest(result.identity)}\n`);
    }
}
