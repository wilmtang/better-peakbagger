// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import yaml from 'js-yaml';

const workflow = yaml.load(await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));

test('manual rehearsals never authorize store jobs, including a dispatch on a release tag', () => {
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    for (const store of ['chrome', 'firefox']) {
        const job = workflow.jobs[store];
        assert.equal(job.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
        const permits = new Function('github', 'startsWith', `return ${job.if};`);
        const startsWith = (value, prefix) => value.startsWith(prefix);
        for (const github of [
            { event_name: 'workflow_dispatch', ref: 'refs/heads/main' },
            { event_name: 'workflow_dispatch', ref: 'refs/tags/v3.8.0' },
            { event_name: 'push', ref: 'refs/heads/main' },
            { event_name: 'pull_request', ref: 'refs/tags/v3.8.0' },
        ]) assert.equal(permits(github, startsWith), false);
        assert.equal(permits({ event_name: 'push', ref: 'refs/tags/v3.8.0' }, startsWith), true);
        assert.deepEqual(job.needs, ['verify', 'compatibility']);
    }
    assert.equal(workflow.jobs.verify.permissions['id-token'], undefined);
    assert.equal(workflow.jobs.verify.environment, undefined);
});

test('rehearsal validates metadata early and keeps the full tag gate on publication', () => {
    const steps = workflow.jobs.verify.steps;
    const metadata = steps.findIndex(step => step.id === 'metadata');
    const tests = steps.findIndex(step => step.run === 'npm test');
    assert.ok(metadata > 0 && metadata < tests);
    assert.match(steps[metadata].run, /release:check.*--metadata-only/);
    assert.match(steps[metadata].run, /release:metadata:firefox/);
    const ancestry = steps.find(step => step.run?.includes('--require-protected-main'));
    assert.equal(ancestry.if, "github.event_name == 'push'");
    assert.match(ancestry.run, /"\$GITHUB_REF_NAME"/);
});

test('exact-package verification launches the current Firefox installed by its setup step', () => {
    const steps = workflow.jobs.verify.steps;
    const install = steps.find(step => step.uses?.startsWith('browser-actions/setup-firefox@'));
    assert.equal(install.with['firefox-version'], 'latest');
    assert.ok(install.id, 'the installed current browser must have an output reference');
    const execute = steps.find(step => step.run?.includes('npm run verify:packages'));
    assert.equal(execute.env?.FIREFOX_BIN, '${{ steps.' + install.id + '.outputs.firefox-path }}',
        'Selenium must receive the installed binary instead of discovering a preinstalled Firefox');
});

test('floor and store jobs verify the same immutable archive identity before using it', () => {
    assert.match(workflow.jobs.verify.outputs['artifact-name'], /steps\.metadata\.outputs\.artifact-name/);
    const verify = workflow.jobs.verify.steps;
    assert.ok(verify.findIndex(step => step.name === 'Record verified package identity')
        > verify.findIndex(step => step.name === 'Execute store packages in both browsers'));
    for (const name of ['compatibility', 'chrome', 'firefox']) {
        const steps = workflow.jobs[name].steps;
        const download = steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
        assert.equal(download.with.name, '${{ needs.verify.outputs.artifact-name }}');
        const identity = steps.findIndex(step => step.run?.includes('release-package-identity.mjs verify'));
        const use = steps.findIndex(step => /Execute the packaged|Submit .* package/.test(step.name));
        assert.ok(identity >= 0 && identity < use, name);
    }
    const steps = workflow.jobs.firefox.steps;
    assert.ok(steps.findIndex(step => step.run?.includes('--require-unused'))
        < steps.findIndex(step => step.run === 'npm run release:sign:firefox'));
});

test('Firefox recovery resolves the preserved attempt and verifies its tagged source identity', async () => {
    const recovery = yaml.load(await readFile(new URL('../../.github/workflows/retry-firefox-release.yml', import.meta.url), 'utf8'));
    const steps = recovery.jobs.firefox.steps;
    const source = steps.find(step => step.id === 'recovery');
    assert.equal(source.shell, 'bash', 'artifact lookup failures must propagate through the selector pipeline');
    assert.match(source.run, /gh api --paginate --slurp/);
    assert.match(source.run, /node scripts\/select-release-artifact\.mjs "\$TARGET_TAG" "\$attempt"/);
    assert.match(source.run, /\.event.*push/);
    assert.match(source.run, /\.head_sha.*tag_commit/);
    const download = steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with.name, '${{ steps.recovery.outputs.artifact-name }}');
    const identity = steps.find(step => step.name === 'Verify preserved package identity');
    assert.match(identity.run, /steps\.recovery\.outputs\.tag-commit/);
    assert.match(identity.if, /format\('browser-extension-\{0\}', inputs\.tag\)/);
    assert.doesNotMatch(JSON.stringify(steps), /publish-chrome/);
});
