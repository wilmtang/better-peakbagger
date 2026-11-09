// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
// @ts-expect-error js-yaml has no declarations; the consumed workflow shape is below.
import yaml from 'js-yaml';
type Step = { name: string; id?: string; uses?: string; run?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> };
type Job = { needs?: string[]; if?: string; environment?: string; permissions: Record<string, string>; steps: Step[]; env: Record<string, string>;
    strategy: { matrix: { include: { browser: string; version: string; runner: string; chrome: string; firefox: string }[] } }; outputs: Record<string, string>; 'runs-on': string };
type Workflow = { on: { workflow_dispatch: { inputs: Record<string, { required?: boolean; default?: string; options?: string[] }> } }; concurrency: { group: string; 'cancel-in-progress': boolean }; jobs: Record<string, Job> };
const load = async (name: string): Promise<Workflow> => yaml.load(await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));
const workflow = await load('release.yml');

test('dispatches never authorize store jobs, including on a release tag', () => {
    for (const store of ['chrome-upload', 'chrome-metadata', 'chrome', 'firefox']) {
        const job = workflow.jobs[store]!;
        assert.equal(job.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
        const permits = new Function('github', 'startsWith', `return ${job.if};`);
        const startsWith = (value: string, prefix: string) => value.startsWith(prefix);
        for (const github of [{ event_name: 'workflow_dispatch', ref: 'refs/heads/main' }, { event_name: 'workflow_dispatch', ref: 'refs/tags/v4.2.0' },
            { event_name: 'push', ref: 'refs/heads/main' }, { event_name: 'pull_request', ref: 'refs/tags/v4.2.0' }]) assert.equal(permits(github, startsWith), false);
        assert.equal(permits({ event_name: 'push', ref: 'refs/tags/v4.2.0' }, startsWith), true);
        assert.deepEqual(job.needs, store === 'chrome' ? ['verify', 'chrome-upload', 'chrome-metadata'] : store === 'chrome-metadata' ? ['verify', 'chrome-upload'] : ['verify']);
    }
    assert.equal(workflow.jobs.prepare!.permissions['id-token'], undefined);
    assert.equal(workflow.jobs.prepare!.environment, undefined);
});

test('four independent browser jobs execute frozen archives without rebuilding or serial current pairs', () => {
    assert.equal(workflow.on.workflow_dispatch.inputs.ci_run!.required, true);
    assert.equal(workflow.on.workflow_dispatch.inputs.repetitions!.default, '3');
    assert.deepEqual(workflow.on.workflow_dispatch.inputs.repetitions!.options, ['1', '3', '5']);
    const matrix = workflow.jobs.compatibility!;
    assert.equal(matrix.if, "github.event_name == 'workflow_dispatch'");
    assert.deepEqual(matrix.needs, 'prepare');
    assert.deepEqual(matrix.strategy.matrix.include.map(item => [item.browser, item.version, item.runner]), [
        ['chrome', 'current', 'macos-15-intel'], ['firefox', 'current', 'macos-15-intel'],
        ['chrome', '128', 'ubuntu-24.04'], ['firefox', '152.0', 'ubuntu-24.04'],
    ]);
    assert.equal(matrix.env.BPB_VERIFY_REPETITIONS, '${{ inputs.repetitions }}');
    assert.ok(matrix.steps.some(step => step.run?.includes('--browser "$BROWSER"')));
    assert.doesNotMatch(JSON.stringify(workflow), /npm (test|run (build|lint|test:scale|package))|actions\/verify-package/);
    const acquire = workflow.jobs.prepare!.steps.find(step => step.id === 'candidate')!;
    assert.equal(acquire.env?.BPB_CI_RUN, '${{ inputs.ci_run }}');
    assert.equal(acquire.run, 'node scripts/release-evidence.mts "$BPB_MODE"');
});

test('the join rejects failed, cancelled or unexpectedly skipped browser coverage', () => {
    const verify = workflow.jobs.verify!;
    assert.deepEqual(verify.needs, ['prepare', 'compatibility']);
    const expression = verify.if!.slice(3, -2);
    const permits = new Function('always', 'needs', 'github', `return ${expression};`);
    for (const event of ['push', 'workflow_dispatch']) for (const prepare of ['success', 'failure', 'cancelled', 'skipped']) for (const compatibility of ['success', 'failure', 'cancelled', 'skipped']) {
        assert.equal(permits(() => true, { prepare: { result: prepare }, compatibility: { result: compatibility } }, { event_name: event }),
            prepare === 'success' && (compatibility === 'success' || event === 'push' && compatibility === 'skipped'));
    }
});

test('promotion keeps metadata, ancestry, audit, history and complete policy gates', () => {
    const steps = workflow.jobs.prepare!.steps;
    for (const command of ['release:readiness', '--metadata-only', 'release:metadata:firefox', 'release:check-history', 'audit:ci', '--base d7bc366311ccb384d9460eb17d68872e986d6a35']) assert.ok(steps.some(step => step.run?.includes(command)), command);
    assert.equal(steps.find(step => step.run?.includes('--require-protected-main'))!.if, "github.event_name == 'push'");
    const acquire = steps.findIndex(step => step.id === 'candidate');
    assert.ok(acquire > steps.findIndex(step => step.run?.includes('audit:ci')));
    for (const name of ['compatibility', 'verify']) {
        const download = workflow.jobs[name]!.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))!;
        assert.equal(download.with!['artifact-ids'], '${{ needs.prepare.outputs.artifact-id }}');
        assert.ok(workflow.jobs[name]!.steps.some(step => step.run?.includes('release-package-identity.mts verify') && step.run.includes('\"$EXPECTED_IDENTITY\"')));
        assert.equal(workflow.jobs[name]!.env.EXPECTED_IDENTITY, '${{ needs.prepare.outputs.identity-sha256 }}');
    }
    const firefox = workflow.jobs.firefox!.steps;
    assert.ok(firefox.findIndex(step => step.run?.includes('--require-unused')) < firefox.findIndex(step => step.run?.includes('npm run release:sign:firefox')));
});

test('every tag and store recovery shares a lock while rehearsals remain independent', async () => {
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    const group = new Function('github', 'format', `return ${workflow.concurrency.group.slice(3, -2)};`);
    const format = (template: string, value: unknown) => template.replace('{0}', String(value));
    assert.equal(group({ event_name: 'push', run_id: 1 }, format), group({ event_name: 'push', run_id: 2 }, format));
    assert.notEqual(group({ event_name: 'workflow_dispatch', run_id: 1 }, format), group({ event_name: 'push', run_id: 2 }, format));
    assert.notEqual(group({ event_name: 'workflow_dispatch', run_id: 1 }, format), group({ event_name: 'workflow_dispatch', run_id: 2 }, format));
    assert.equal((await load('retry-firefox-release.yml')).concurrency.group, group({ event_name: 'push' }, format));
});

test('ordinary CI retains packages only after production package and capture gates', async () => {
    const ordinary = await load('test.yml'), steps = ordinary.jobs.chrome!.steps;
    const execute = steps.findIndex(step => step.uses === './.github/actions/verify-package');
    const identity = steps.findIndex(step => step.name === 'Record exact CI package identity');
    const upload = steps.findIndex(step => step.name === 'Preserve exact tested packages');
    assert.ok(execute >= 0 && identity > execute && upload > identity);
    assert.equal(steps[upload]!.with!.name, 'ci-packages-${{ github.sha }}-${{ github.run_attempt }}');
    assert.equal(steps[upload]!.if, undefined);
});

test('Firefox recovery still resolves preserved source identity without invoking Chrome', async () => {
    const steps = (await load('retry-firefox-release.yml')).jobs.firefox!.steps;
    const source = steps.find(step => step.id === 'recovery')!;
    assert.match(source.run!, /gh api --paginate --slurp/);
    assert.match(source.run!, /node scripts\/select-release-artifact\.mjs "\$TARGET_TAG" "\$attempt"/);
    assert.match(source.run!, /\.event.*push/); assert.match(source.run!, /\.head_sha.*tag_commit/);
    assert.doesNotMatch(JSON.stringify(steps), /publish-chrome/);
});

test('Chrome pauses after upload in a protected credential-free metadata checkpoint', () => {
    const upload = workflow.jobs['chrome-upload']!, gate = workflow.jobs['chrome-metadata']!, publish = workflow.jobs.chrome!;
    assert.equal(upload.environment, 'browser-stores'); assert.equal(publish.environment, 'browser-stores');
    assert.deepEqual(gate.environment, { name: 'chrome-metadata-review', url: 'https://chrome.google.com/webstore/devconsole' });
    assert.deepEqual(gate.permissions, { actions: 'read' });
    assert.doesNotMatch(JSON.stringify(gate), /secrets\.|id-token|google-auth|CHROME_WEBSTORE_TOKEN|publish-chrome/);
    assert.ok(upload.steps.some(step => step.run?.includes('publish-chrome.mts upload ')));
    assert.ok(publish.steps.some(step => step.run?.includes('publish-chrome.mts publish ') && step.run.includes('--metadata-reviewed')));
    assert.equal(upload.steps.some(step => step.run?.includes('publish-chrome.mts publish ')), false);
    assert.equal(publish.steps.some(step => step.run?.includes('publish-chrome.mts upload ')), false);
    for (const job of [gate, publish]) {
        const receipt = job.steps.find(step => step.name === 'Download pinned upload receipt')!;
        assert.equal(receipt.with!['artifact-ids'], '${{ needs.chrome-upload.outputs.receipt-id }}');
        assert.ok(job.steps.some(step => step.run?.includes('sha256sum --check --strict')));
    }
    for (const job of [upload, publish, workflow.jobs.firefox!]) {
        assert.ok(job.steps.some(step => step.run?.includes('release-evidence.mts revalidate') && step.run.includes('npm run audit:ci')),
            'approval waits must not authorize stale verification or stale advisories');
        assert.equal(job.env.EXPECTED_IDENTITY, '${{ needs.verify.outputs.identity-sha256 }}');
    }
});
