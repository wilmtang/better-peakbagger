// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
    new URL('../../.github/workflows/dependabot-auto-merge.yml', import.meta.url),
    'utf8',
);
const dependabotConfig = await readFile(
    new URL('../../.github/dependabot.yml', import.meta.url),
    'utf8',
);
const developmentGuide = await readFile(
    new URL('../../docs/development.md', import.meta.url),
    'utf8',
);

const stepIndex = name => workflow.indexOf(`- name: ${name}`);

test('the privileged merge decision runs only from trusted base-branch code', () => {
    assert.match(workflow, /^  pull_request_target:\s*$/m);
    assert.doesNotMatch(workflow, /^  pull_request:\s*$/m);
    assert.doesNotMatch(workflow, /uses:\s*actions\/checkout@/,
        'the privileged workflow must never check out pull-request content');
    assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.(?:ref|repo\.clone_url)/,
        'the privileged workflow must not fetch the pull-request branch');
});

test('every new Dependabot head clears stale auto-merge before full provenance verification', () => {
    assert.match(workflow, /^\s+- synchronize\s*$/m);
    assert.match(workflow, /gh pr merge --disable-auto "\$PR_URL"/);
    assert.match(workflow, /length == 1/,
        'Dependabot branches must stay single-commit changes');
    assert.match(workflow, /\.\[0\]\.sha == \$head/,
        'the verified commit must be the head named by the event');
    assert.match(workflow, /\.\[0\]\.author\.login == "dependabot\[bot\]"/);
    assert.match(workflow, /\.\[0\]\.commit\.verification\.verified == true/);

    const reset = stepIndex('Reset any previously queued merge');
    const verify = stepIndex('Verify the complete Dependabot branch');
    const metadata = stepIndex('Read Dependabot metadata');
    const queue = stepIndex('Queue the npm merge once required checks pass');
    assert.ok(reset >= 0 && reset < verify && verify < metadata && metadata < queue,
        'reset, complete verification, metadata parsing, and queueing must remain ordered');
});

test('only npm updates auto-merge and queueing is bound to the verified head', () => {
    assert.match(workflow, /if: steps\.metadata\.outputs\.package-ecosystem == 'npm'/);
    assert.match(workflow,
        /gh pr merge --auto --merge --match-head-commit "\$HEAD_SHA" "\$PR_URL"/);
});

test('npm group names describe how shipped dependencies enter dist', () => {
    assert.match(dependabotConfig, /^      bundled-runtime:\s*$/m);
    assert.match(dependabotConfig, /^      copied-runtime:\s*$/m);
    assert.match(dependabotConfig, /^      tooling:\s*$/m);
    assert.doesNotMatch(dependabotConfig, /^      editor:\s*$/m);
    assert.doesNotMatch(dependabotConfig, /^      vendored:\s*$/m);
    assert.match(developmentGuide, /Both runtime groups are third-party code vendored/);
    assert.match(developmentGuide, /`bundled-runtime` modules[\s\S]*`copied-runtime` packages/);
    assert.doesNotMatch(developmentGuide, /\| `(?:editor|vendored)` \|/);
});
