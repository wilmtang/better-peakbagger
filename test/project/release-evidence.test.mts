// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { packageIdentityDigest, verifyPackageIdentity, writePackageIdentity } from '../../scripts/release-package-identity.mts';
import { writeFile } from 'node:fs/promises';
import { acquireEvidence, evidenceApiPath, extractEvidenceArchive, validateFreshJobs, latestRehearsal,
    type EvidenceArtifact, type EvidenceDependencies } from '../../scripts/release-evidence.mts';
const commit = 'a'.repeat(40), version = '4.2.0', now = Date.parse('2026-11-08T12:00:00Z');
const time = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const log = (count = 3) => Array.from({ length: count }, (_, i) => `Verification repetition ${i + 1}/${count} started.\nVerification repetition ${i + 1}/${count} passed, including teardown.`).join('\n');
const job = (name: string, id: number) => ({ id, name, status: 'completed', conclusion: 'success', started_at: time(50), completed_at: time(5) });
async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bpb-evidence-test-'));
    const repo = { full_name: 'wilmtang/better-peakbagger' };
    const run = (id: number, workflow: string, event: string) => ({ id, run_attempt: 1, repository: repo, head_repository: repo,
        path: `.github/workflows/${workflow}`, event, head_branch: 'main', head_sha: commit, status: 'completed', conclusion: 'success', run_started_at: time(60) });
    const ci = run(1, 'test.yml', 'push'), rehearsal = run(2, 'release.yml', 'workflow_dispatch');
    const ciJobs = ['Node tests and lint', 'Scale tests', 'Chrome extension smoke', 'Firefox extension smoke'].map(job);
    const rehearsalJobs = ['Prepare release candidate', 'Verify release', 'Packaged chrome current', 'Packaged firefox current', 'Packaged chrome 128', 'Packaged firefox 152.0'].map((name, i) => job(name, i + 10)).concat(
        ['Submit Chrome Web Store', 'Submit Firefox Add-ons'].map((name, i) => ({ ...job(name, i + 20), conclusion: 'skipped' })));
    const zip = new JSZip(), archives: Record<string, string> = {};
    for (const suffix of ['', '-firefox']) {
        const name = `better_peakbagger-${version}${suffix}.zip`, bytes = Buffer.from(`exact ${suffix} bytes`);
        zip.file(name, bytes); archives[name] = digest(bytes).slice(7);
    }
    const identity = { version, commit, archives };
    zip.file('package-identity.json', JSON.stringify(identity));
    const ciBytes = await zip.generateAsync({ type: 'nodebuffer' });
    const artifact = (id: number, runId: number, name: string, bytes: Buffer): EvidenceArtifact => ({ id, name, digest: digest(bytes), expired: false, created_at: time(4), workflow_run: { id: runId, head_sha: commit } });
    const ciArtifact = artifact(100, 1, `ci-packages-${commit}-1`, ciBytes);
    const receipt = { schemaVersion: 1, sourceCi: { id: 1, attempt: 1, artifactId: 100, digest: ciArtifact.digest }, packageIdentity: identity };
    zip.file('candidate-evidence.json', JSON.stringify(receipt));
    const rehearsalBytes = await zip.generateAsync({ type: 'nodebuffer' });
    const rehearsalArtifact = artifact(200, 2, `browser-extension-v${version}-1`, rehearsalBytes);
    const state = { ci, rehearsal, ciJobs, rehearsalJobs, ciArtifact, rehearsalArtifact, ciBytes, rehearsalBytes,
        runs: [rehearsal], logs: log(), changedAttempt: false, ciReads: 0 };
    const deps: EvidenceDependencies = {
        now: () => now,
        request: async endpoint => {
            if (endpoint === 'actions/runs/1') return { ...state.ci, run_attempt: state.changedAttempt && ++state.ciReads > 1 ? 2 : state.ci.run_attempt };
            if (endpoint === 'actions/runs/2') return state.rehearsal;
            if (endpoint === 'actions/artifacts/100') return state.ciArtifact;
            if (endpoint === 'actions/artifacts/200') return state.rehearsalArtifact;
            assert.fail(endpoint);
        },
        paginate: async endpoint => {
            if (endpoint.startsWith('actions/workflows/')) return state.runs;
            if (endpoint.includes('/1/attempts/')) return state.ciJobs;
            if (endpoint.includes('/2/attempts/')) return state.rehearsalJobs;
            if (endpoint === 'actions/runs/1/artifacts?per_page=100') return [state.ciArtifact];
            if (endpoint === 'actions/runs/2/artifacts?per_page=100') return [state.rehearsalArtifact];
            assert.fail(endpoint);
        },
        download: async id => id === 100 ? state.ciBytes : state.rehearsalBytes,
        log: async () => state.logs,
    };
    return { root, state, deps, identity, clean: () => rm(root, { recursive: true, force: true }) };
}
test('rehearsal and publication consume the same exact CI packages and reconstruct provenance', async () => {
    const f = await fixture();
    try {
        const candidate = await acquireEvidence({ mode: 'rehearsal', commit, version, ciRunId: 1, directory: path.join(f.root, 'manual') }, f.deps);
        const promoted = await acquireEvidence({ mode: 'publication', commit, version, ciRunId: 1, rehearsalRunId: 2, directory: path.join(f.root, 'tag') }, f.deps);
        assert.deepEqual(candidate.identity, f.identity); assert.deepEqual(promoted.identity, candidate.identity);
        assert.equal(promoted.rehearsal?.artifactId, 200);
        assert.equal(await readFile(path.join(f.root, 'tag', `better_peakbagger-${version}.zip`), 'utf8'), 'exact  bytes');
    } finally { await f.clean(); }
});
test('acquisition rejects untrusted, incomplete, stale, changed and rerun evidence', async t => {
    const mutations: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => void> = {
        fork: f => { f.state.ci.head_repository = { full_name: 'fork/repo' }; },
        pr: f => { f.state.ci.event = 'pull_request'; },
        workflow: f => { f.state.ci.path = '.github/workflows/fake.yml'; },
        sha: f => { f.state.ci.head_sha = 'b'.repeat(40); },
        requiredSkipped: f => { f.state.ciJobs[0]!.conclusion = 'skipped'; },
        requiredMissing: f => { f.state.ciJobs.shift(); },
        requiredDuplicate: f => { f.state.ciJobs.push(f.state.ciJobs[0]!); },
        oldCoverage: f => { f.state.ciJobs[0]!.completed_at = time(1500); },
        futureCoverage: f => { f.state.ciJobs[0]!.completed_at = time(-1); },
        missingCoverage: f => { f.state.ciJobs[0]!.completed_at = ''; },
        oldAttemptCoverage: f => { f.state.ciJobs[0]!.started_at = time(61); },
        changedAttempt: f => { f.state.changedAttempt = true; },
        expired: f => { f.state.ciArtifact.expired = true; },
        artifactRun: f => { f.state.ciArtifact.workflow_run.id = 99; },
        artifactHash: f => { f.state.ciArtifact.digest = `sha256:${'0'.repeat(64)}`; },
        staleArtifact: f => { f.state.ciArtifact.created_at = time(61); },
        rehearsalRerun: f => { f.state.rehearsal.run_attempt = 2; },
        onePass: f => { f.state.logs = log(1); },
        partialPass: f => { f.state.logs = log().replace('3/3 passed, including teardown.', '3/3 failed.'); },
        duplicatedPass: f => { f.state.logs += '\n' + log(); },
        newerFailed: f => { f.state.runs.push({ ...f.state.rehearsal, id: 3, conclusion: 'failure' }); },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
        const f = await fixture();
        try { mutate(f); await assert.rejects(acquireEvidence({ mode: 'publication', commit, version, ciRunId: 1, rehearsalRunId: 2, directory: path.join(f.root, 'candidate') }, f.deps)); }
        finally { await f.clean(); }
    });
});
test('promotion rejects rewritten receipt or edited inner package even with a valid outer digest', async t => {
    for (const mode of ['receipt', 'package']) await t.test(mode, async () => {
        const f = await fixture();
        try {
            const zip = await JSZip.loadAsync(f.state.rehearsalBytes);
            zip.file(mode === 'receipt' ? 'candidate-evidence.json' : `better_peakbagger-${version}.zip`, mode === 'receipt' ? JSON.stringify({ schemaVersion: 1, sourceCi: { id: 99 } }) : 'changed package');
            f.state.rehearsalBytes = await zip.generateAsync({ type: 'nodebuffer' });
            f.state.rehearsalArtifact.digest = digest(f.state.rehearsalBytes);
            await assert.rejects(acquireEvidence({ mode: 'publication', commit, version, directory: path.join(f.root, 'tag') }, f.deps));
        } finally { await f.clean(); }
    });
});
test('artifact extraction rejects unexpected entries and hash mismatches before writing', async () => {
    const f = await fixture();
    try {
        await assert.rejects(extractEvidenceArchive(Buffer.from('wrong'), f.state.ciArtifact, path.join(f.root, 'wrong'), version), /digest mismatch/);
        const zip = new JSZip(); zip.file('private.txt', 'unexpected'); const bytes = await zip.generateAsync({ type: 'nodebuffer' });
        await assert.rejects(extractEvidenceArchive(bytes, { ...f.state.ciArtifact, digest: digest(bytes) }, path.join(f.root, 'unsafe'), version), /Unexpected/);
        assert.throws(() => validateFreshJobs(f.state.ci, [{ ...f.state.ciJobs[0]!, completed_at: undefined }], now), /timestamp/);
        f.state.runs = [];
        await assert.rejects(latestRehearsal(commit, f.deps), /No main rehearsal/);
    } finally { await f.clean(); }
});


test('independently pinned identity rejects rewritten ZIPs and their matching downloaded identity', async () => {
    const f = await fixture();
    try {
        const directory = path.join(f.root, 'candidate');
        const result = await acquireEvidence({ mode: 'rehearsal', commit, version, ciRunId: 1, directory }, f.deps);
        const expected = packageIdentityDigest(result.identity);
        await verifyPackageIdentity(directory, version, commit, expected);
        await writeFile(path.join(directory, `better_peakbagger-${version}.zip`), 'rewritten');
        await writePackageIdentity(directory, version, commit);
        await verifyPackageIdentity(directory, version, commit); // self-consistency alone is insufficient
        await assert.rejects(verifyPackageIdentity(directory, version, commit, expected), /independently pinned/);
        await assert.rejects(verifyPackageIdentity(directory, version, commit, ''), /independently pinned/);
    } finally { await f.clean(); }
});


test('coverage that expires during acquisition cannot be promoted', async () => {
    const f = await fixture();
    try {
        let elapsed = 0;
        const deps = { ...f.deps, now: () => now + elapsed,
            download: async (id: number) => { const bytes = await f.deps.download(id); elapsed = 24 * 60 * 60_000; return bytes; } };
        await assert.rejects(acquireEvidence({ mode: 'publication', commit, version, directory: path.join(f.root, 'tag') }, deps), /stale evidence/);
    } finally { await f.clean(); }
});


test('canonical GitHub repository endpoint has no trailing slash', () => {
    assert.equal(evidenceApiPath(''), 'repos/wilmtang/better-peakbagger');
    assert.equal(evidenceApiPath('actions/runs/1'), 'repos/wilmtang/better-peakbagger/actions/runs/1');
});
