// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    ENTRIES,
    entrySources,
    VENDOR_COPY,
} from '../../scripts/build-config.mjs';

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
const packageJson = JSON.parse(await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
));
const packageLock = JSON.parse(await readFile(
    new URL('../../package-lock.json', import.meta.url),
    'utf8',
));

const stepIndex = name => workflow.indexOf(`- name: ${name}`);

const groupPatterns = name => {
    const match = dependabotConfig.match(new RegExp(
        `^      ${name}:\\n        patterns:\\n((?:          - .+\\n)+)`,
        'm',
    ));
    assert.ok(match, `missing Dependabot group ${name}`);
    return match[1].trim().split('\n').map(line =>
        line.replace(/^\s*-\s*/, '').replace(/^"|"$/g, ''));
};

const matchesPattern = (packageName, pattern) => pattern.endsWith('/*')
    ? packageName.startsWith(pattern.slice(0, -1))
    : packageName === pattern;

const npmPackageName = specifier => specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];

const browserPackageImports = async () => {
    const pending = [...new Set(ENTRIES.flatMap(entrySources))];
    const visited = new Set();
    const packages = new Set();
    while (pending.length) {
        const sourcePath = pending.pop();
        if (visited.has(sourcePath)) continue;
        visited.add(sourcePath);
        const source = await readFile(sourcePath, 'utf8');
        for (const match of source.matchAll(
            /^\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["'];?/gm,
        )) {
            const specifier = match[1];
            if (!specifier.startsWith('.')) {
                packages.add(npmPackageName(specifier));
                continue;
            }
            const resolved = path.resolve(path.dirname(sourcePath), specifier);
            pending.push(path.extname(resolved) ? resolved : `${resolved}.js`);
        }
    }
    return packages;
};

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
    assert.match(workflow,
        /if: steps\.metadata\.outputs\.package-ecosystem == 'npm_and_yarn'/,
        'fetch-metadata reports npm updates with the npm_and_yarn ecosystem identifier');
    assert.doesNotMatch(workflow,
        /if: steps\.metadata\.outputs\.package-ecosystem == 'npm'/,
        'the dependabot.yml ecosystem name is not a fetch-metadata output value');
    assert.match(workflow,
        /gh pr merge --auto --merge --match-head-commit "\$HEAD_SHA" "\$PR_URL"/);
});

test('npm groups preserve release paths and catch otherwise separate updates', () => {
    assert.match(dependabotConfig, /^    versioning-strategy: increase$/m,
        'already-satisfied family members must still receive raised manifest ranges');
    assert.match(dependabotConfig, /^      bundled-runtime:\s*$/m);
    assert.match(dependabotConfig, /^      copied-runtime:\s*$/m);
    assert.match(dependabotConfig, /^      tooling:\s*$/m);
    assert.match(dependabotConfig,
        /^      remaining-npm:\n        applies-to: version-updates\n        patterns:\n          - "\*"\s*$/m);
    assert.match(dependabotConfig,
        /^      security-fixes:\n        applies-to: security-updates\n        patterns:\n          - "\*"\s*$/m);
    assert.doesNotMatch(dependabotConfig, /^      editor:\s*$/m);
    assert.doesNotMatch(dependabotConfig, /^      vendored:\s*$/m);

    const tooling = dependabotConfig.indexOf('      tooling:');
    const remaining = dependabotConfig.indexOf('      remaining-npm:');
    assert.ok(tooling >= 0 && tooling < remaining,
        'the version-update wildcard must stay after the named release-path groups');

    assert.match(developmentGuide, /Both runtime groups are third-party code vendored/);
    assert.match(developmentGuide, /`bundled-runtime` modules[\s\S]*`copied-runtime` packages/);
    assert.match(developmentGuide, /first matching group[\s\S]*otherwise unmatched direct and transitive/);
    assert.match(developmentGuide, /security updates[\s\S]*does not combine with ordinary version updates/);
    assert.doesNotMatch(developmentGuide, /\| `(?:editor|vendored)` \|/);
    assert.match(developmentGuide,
        /versioning-strategy: increase[\s\S]*already-satisfied TipTap siblings/);
});

test('the declared and locked TipTap family moves as one version', () => {
    const declared = Object.entries(packageJson.devDependencies)
        .filter(([name]) => name.startsWith('@tiptap/'));
    assert.ok(declared.length > 1, 'the project must exercise a real TipTap family');
    assert.equal(new Set(declared.map(([_name, range]) => range)).size, 1,
        'all direct TipTap requirements must have the same range');

    const locked = Object.entries(packageLock.packages)
        .filter(([packagePath]) => packagePath.startsWith('node_modules/@tiptap/'))
        .map(([_packagePath, metadata]) => metadata.version);
    assert.ok(locked.length >= declared.length);
    assert.equal(new Set(locked).size, 1,
        'all direct and transitive TipTap packages must resolve to one lockstep version');
});

test('runtime dependency groups match how the build graph ships each package', async () => {
    const bundledPatterns = groupPatterns('bundled-runtime');
    const copiedPatterns = groupPatterns('copied-runtime');
    const copiedPackages = new Set(VENDOR_COPY
        .filter(([source, output]) => output.startsWith('vendor/')
            && !/license/i.test(source)
            && !/license/i.test(output))
        .map(([source]) => npmPackageName(source)));
    for (const entry of ENTRIES) {
        for (const packageName of Object.keys(entry.browserImports || {})) {
            copiedPackages.add(packageName);
        }
    }

    const importedPackages = await browserPackageImports();
    const bundledPackages = [...importedPackages]
        .filter(packageName => !copiedPackages.has(packageName));
    for (const packageName of bundledPackages) {
        assert.ok(bundledPatterns.some(pattern => matchesPattern(packageName, pattern)),
            `${packageName} is bundled by the build graph but absent from bundled-runtime`);
        assert.equal(copiedPatterns.some(pattern => matchesPattern(packageName, pattern)), false,
            `${packageName} is bundled but also matches copied-runtime`);
    }
    for (const packageName of copiedPackages) {
        assert.ok(copiedPatterns.some(pattern => matchesPattern(packageName, pattern)),
            `${packageName} is copied by the build graph but absent from copied-runtime`);
        assert.equal(bundledPatterns.some(pattern => matchesPattern(packageName, pattern)), false,
            `${packageName} is copied but also matches bundled-runtime`);
    }
    assert.ok(bundledPackages.includes('tz-lookup'));
    assert.ok(bundledPackages.includes('suncalc'));
});
