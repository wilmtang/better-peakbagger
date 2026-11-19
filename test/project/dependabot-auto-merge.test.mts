// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error js-yaml ships no declarations; parsed workflows are typed below.
import yaml from 'js-yaml';

import { buildBundles } from '../../scripts/vite-build.mts';
import {
    ENTRIES,
    VENDOR_COPY,
    root,
    type BundleEntry,
} from '../../scripts/build-config.mts';

interface LockPackage {
    readonly version?: string;
}

interface PackageManifest {
    readonly devDependencies?: Readonly<Record<string, string>>;
}

interface PackageLock {
    readonly packages: Readonly<Record<string, LockPackage>>;
}

interface DependabotGroup {
    readonly patterns?: readonly string[];
}

interface DependabotUpdate {
    readonly 'package-ecosystem'?: string;
    readonly schedule?: Record<string, unknown>;
    readonly groups?: Readonly<Record<string, DependabotGroup>>;
    readonly 'open-pull-requests-limit'?: number;
    readonly cooldown?: Record<string, unknown>;
}

interface DependabotConfig {
    readonly updates: readonly DependabotUpdate[];
}

const workflow = await readFile(
    new URL('../../.github/workflows/dependabot-auto-merge.yml', import.meta.url),
    'utf8',
);
const testWorkflow = await readFile(
    new URL('../../.github/workflows/test.yml', import.meta.url),
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
)) as PackageManifest;
const packageLock = JSON.parse(await readFile(
    new URL('../../package-lock.json', import.meta.url),
    'utf8',
)) as PackageLock;

const stepIndex = (name: string): number => workflow.indexOf(`- name: ${name}`);

const groupPatterns = (name: string): string[] => {
    const match = dependabotConfig.match(new RegExp(
        `^      ${name}:\\n        patterns:\\n((?:          - .+\\n)+)`,
        'm',
    ));
    assert.ok(match, `missing Dependabot group ${name}`);
    return match[1].trim().split('\n').map(line =>
        line.replace(/^\s*-\s*/, '').replace(/^"|"$/g, ''));
};

const matchesPattern = (packageName: string, pattern: string): boolean => pattern.endsWith('/*')
    ? packageName.startsWith(pattern.slice(0, -1))
    : packageName === pattern;

const npmPackageName = (specifier: string): string => specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];

const bundledInputPackages = (inputs: readonly string[]): Set<string> => {
    const packages = new Set<string>();
    for (const input of inputs) {
        const normalized = input.replaceAll(path.sep, '/');
        if (!/(?:^|\/)node_modules\//.test(normalized)) continue;
        const inner = normalized.split(/(?:^|\/)node_modules\//).pop();
        if (inner) packages.add(npmPackageName(inner));
    }
    return packages;
};

const bundledPackagesForEntries = async (
    entries: readonly BundleEntry[],
    projectRoot?: string,
): Promise<Set<string>> => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-runtime-graph-'));
    try {
        const { inputPaths } = await buildBundles({ entries, projectRoot, outputDir: path.join(directory, 'bundles'), minify: true,
            manifestPath: entries === ENTRIES ? undefined : null });
        return bundledInputPackages(inputPaths);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
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

test('manual-only Actions updates are monthly while npm keeps its fortnightly cadence', () => {
    const updates = (yaml.load(dependabotConfig) as DependabotConfig).updates;
    assert.equal(updates.length, 2);
    const npm = updates.find(update => update['package-ecosystem'] === 'npm');
    const actions = updates.find(update => update['package-ecosystem'] === 'github-actions');
    assert.ok(npm && actions);
    assert.deepEqual(npm.schedule, {
        interval: 'cron', cronjob: '0 9 * * mon%2', timezone: 'Etc/UTC',
    });
    assert.deepEqual(actions.schedule, {
        interval: 'monthly', time: '09:00', timezone: 'Etc/UTC',
    });
    assert.deepEqual(actions.groups, { actions: { patterns: ['*'] } });
    assert.equal(actions['open-pull-requests-limit'], 1);
    assert.deepEqual(actions.cooldown, {
        'semver-patch-days': 7, 'semver-minor-days': 14, 'semver-major-days': 30,
    });
});

test('the declared and locked TipTap family moves as one version', () => {
    const declared = Object.entries(packageJson.devDependencies ?? {})
        .filter(([name]) => name.startsWith('@tiptap/'));
    assert.ok(declared.length > 1, 'the project must exercise a real TipTap family');
    assert.equal(new Set(declared.map(([, range]) => range)).size, 1,
        'all direct TipTap requirements must have the same range');
    const version = declared[0][1];
    assert.match(version, /^\d+\.\d+\.\d+$/,
        'exact TipTap requirements prevent untouched siblings resolving past the grouped release');

    const locked = Object.entries(packageLock.packages)
        .filter(([packagePath]) => /(?:^|\/)node_modules\/@tiptap\//.test(packagePath))
        .map(([, metadata]) => metadata.version);
    assert.ok(locked.length >= declared.length);
    assert.equal(new Set(locked).size, 1,
        'all direct and transitive TipTap packages must resolve to one lockstep version');
    assert.equal(locked[0], version,
        'nested and top-level TipTap resolutions must match the exact manifest version');
});

test('copied runtime updates add hardware GPU gates to stable required checks', () => {
    const impactJob = testWorkflow.slice(
        testWorkflow.indexOf('  dependency-impact:'), testWorkflow.indexOf('  node:'),
    );
    assert.match(impactJob, /^    outputs:\n      copied-runtime:/m);
    assert.match(impactJob,
        /uses: actions\/setup-node@[a-f\d]{40}[^\n]*\n\s+with:\n\s+node-version: 24\n[\s\S]*?node scripts\/copied-runtime-impact\.mts "\$BASE_REVISION"/);
    assert.match(testWorkflow,
        /^  chrome-terrain:\n[\s\S]*?if: needs\.dependency-impact\.outputs\.copied-runtime == 'true'[\s\S]*?runs-on: macos-15[\s\S]*?npm run verify -- terrain chrome/m);
    assert.match(testWorkflow,
        /^  chrome-required:\n[\s\S]*?name: Chrome extension smoke[\s\S]*?if: always\(\)[\s\S]*?test "\$CHROME_RESULT" = success[\s\S]*?test "\$GPU_RESULT" = success/m);
    const chromeRequired = testWorkflow.slice(
        testWorkflow.indexOf('  chrome-required:'), testWorkflow.indexOf('  firefox-terrain:'),
    );
    assert.match(chromeRequired, /^      - chrome-floor$/m,
        'the stable required check must await the minimum supported Chrome');
    assert.match(chromeRequired, /CHROME_FLOOR_RESULT: \$\{\{ needs\.chrome-floor\.result \}\}/);
    assert.match(chromeRequired, /test "\$CHROME_FLOOR_RESULT" = success/,
        'a failed or skipped Chrome floor must block merging');
    assert.match(testWorkflow,
        /^  firefox-terrain:\n[\s\S]*?if: needs\.dependency-impact\.outputs\.copied-runtime == 'true'[\s\S]*?runs-on: macos-15\n[\s\S]*?npm run verify -- terrain firefox/m);
    assert.match(testWorkflow,
        /^  firefox-required:\n[\s\S]*?name: Firefox extension smoke[\s\S]*?if: always\(\)[\s\S]*?test "\$FIREFOX_RESULT" = success[\s\S]*?test "\$GPU_RESULT" = success/m);
});

const SVELTE_RUNTIME_PACKAGES = new Set(['svelte', 'esm-env', 'clsx']);
const BUILD_TOOLS = ['vite', 'rolldown', 'svelte-check', 'eslint-plugin-svelte', 'svelte-eslint-parser'] as const;

const checkBundledGroups = (
    bundledPackages: readonly string[],
    bundledPatterns: readonly string[],
    copiedPatterns: readonly string[],
    sveltePatterns: readonly string[],
): void => {
    for (const packageName of bundledPackages) {
        const expectedPatterns = SVELTE_RUNTIME_PACKAGES.has(packageName) ? sveltePatterns : bundledPatterns;
        assert.ok(expectedPatterns.some(pattern => matchesPattern(packageName, pattern)),
            `${packageName} is bundled by the build graph but absent from its Dependabot runtime group`);
        assert.equal(copiedPatterns.some(pattern => matchesPattern(packageName, pattern)), false,
            `${packageName} is bundled but also matches copied-runtime`);
    }
};

test('runtime dependency groups match the production Vite input graph', async () => {
    const bundledPatterns = groupPatterns('bundled-runtime');
    const copiedPatterns = groupPatterns('copied-runtime');
    const sveltePatterns = groupPatterns('svelte');
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

    const importedPackages = await bundledPackagesForEntries(ENTRIES);
    const bundledPackages = [...importedPackages]
        .filter(packageName => !copiedPackages.has(packageName));
    checkBundledGroups(bundledPackages, bundledPatterns, copiedPatterns, sveltePatterns);
    for (const packageName of copiedPackages) {
        assert.ok(copiedPatterns.some(pattern => matchesPattern(packageName, pattern)),
            `${packageName} is copied by the build graph but absent from copied-runtime`);
        assert.equal(bundledPatterns.some(pattern => matchesPattern(packageName, pattern)), false,
            `${packageName} is copied but also matches bundled-runtime`);
    }
    assert.ok(bundledPackages.includes('tz-lookup'));
    assert.ok(bundledPackages.includes('suncalc'));
    for (const expected of SVELTE_RUNTIME_PACKAGES) {
        assert.ok(bundledPackages.includes(expected),
            `shipped Svelte runtime package ${expected} must be discovered in production inputs`);
        assert.throws(
            () => checkBundledGroups(
                bundledPackages,
                bundledPatterns,
                copiedPatterns,
                sveltePatterns.filter(pattern => pattern !== expected),
            ),
            new RegExp(`${expected} is bundled`),
            `removing ${expected} from the Dependabot svelte group must fail the guard`,
        );
    }
    for (const compilerTool of BUILD_TOOLS) {
        assert.equal(bundledPackages.includes(compilerTool), false,
            `compiler tool ${compilerTool} must never ship into production bundles`);
    }
});

test('the Vite input graph captures Svelte runtime packages and ignores erased type-only imports', async () => {
    const compiledPackages = await bundledPackagesForEntries([
        { out: 'svelte-fixture/island.js', sources: ['../test/fixtures/svelte/valid/island-entry.ts'] },
    ]);
    for (const expected of ['svelte', 'esm-env', 'clsx']) {
        assert.ok(compiledPackages.has(expected), `compiled fixture must report ${expected}`);
    }
    for (const compilerTool of BUILD_TOOLS) {
        assert.equal(compiledPackages.has(compilerTool), false,
            `compiler tooling ${compilerTool} must not appear in bundled inputs`);
    }

    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bpb-metafile-types-'));
    try {
        await mkdir(path.join(tempRoot, 'src'), { recursive: true });
        await symlink(path.join(root, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
        await writeFile(path.join(tempRoot, 'src', 'type-only.ts'),
            "import type { ClassValue } from 'clsx';\nexport const keep: ClassValue = 'ok';\n");
        const typeOnlyPackages = await bundledPackagesForEntries(
            [{ out: 'type-only.js', sources: ['type-only.ts'] }],
            tempRoot,
        );
        assert.deepEqual([...typeOnlyPackages], [],
            'erased type-only imports must not be treated as bundled dependencies');
        await writeFile(path.join(tempRoot, 'src', 'runtime-import.ts'),
            "import { clsx } from 'clsx';\nexport const className: string = clsx('a', 'b');\n");
        const runtimePackages = await bundledPackagesForEntries(
            [{ out: 'runtime-import.js', sources: ['runtime-import.ts'] }],
            tempRoot,
        );
        assert.ok(runtimePackages.has('clsx'),
            'fixture resolves node_modules when an import is retained at runtime');
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});
