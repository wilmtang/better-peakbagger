// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// M5: Svelte compiles, checks and lints through the existing tooling. These
// tests use test-only fixtures; no shipped bundle imports Svelte yet.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, context, type Metafile } from 'esbuild';
import { ESLint } from 'eslint';
import { RELOAD_SIGNAL, esbuildOptions, watchAll } from '../../scripts/build.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('Svelte components and rune modules in runtime roots lint as TypeScript', async () => {
    const eslint = new ESLint({ cwd: root });
    const lint = async (file: string, text: string) => (await eslint.lintText(text, { filePath: path.join(root, file) }))[0]!
        .messages.map(message => `${message.ruleId}:${message.line}`);
    assert.deepEqual(await lint('src/ui/probe.svelte',
        '<script lang="ts">\n    const unused: number = 1;\n    let count: number = $state(0);\n</script>\n\n<button onclick={() => count++}>{count}</button>\n'),
    ['@typescript-eslint/no-unused-vars:2']);
    assert.deepEqual(await lint('options/probe.svelte', '<script>\n    let count = $state(0);\n</script>\n\n<button onclick={() => count++}>{count}</button>\n'),
        ['svelte/block-lang:1'], 'component scripts must be TypeScript');
    assert.deepEqual(await lint('src/ui/probe.svelte.ts',
        'export function make(): { value: number } {\n    const value = $state({ value: 1 });\n    const unused = 2;\n    return value;\n}\n'),
    ['@typescript-eslint/no-unused-vars:3']);
    assert.deepEqual(await lint('options/probe-controller.ts', "import Panel from './Panel.svelte';\nimport { tally } from '../src/ui/tally.svelte.ts';\nexport default [Panel, tally];\n"),
        ['no-restricted-imports:1', 'no-restricted-imports:2'], 'controllers reach components only through the island adapter');
    assert.deepEqual(await lint('src/ui/svelte-island.ts', "import { createIslandProps } from './svelte-island-props.svelte.ts';\nexport default createIslandProps;\n"), []);
    const sveltePluginRules = (await eslint.calculateConfigForFile(path.join(root, 'scripts/example.mts'))).rules;
    assert.equal(Object.keys(sveltePluginRules ?? {}).some(rule => rule.startsWith('svelte/')), false, 'Svelte rules stay on Svelte files');
    assert.deepEqual(await lint('src/ui/probe-any.svelte',
        '<script lang="ts">\n    export const value: any = 1;\n</script>\n'), ['@typescript-eslint/no-explicit-any:2']);
});

const fixtureEntry = { out: 'svelte-fixture/island.js', sources: ['../test/fixtures/svelte/valid/island-entry.ts'] };
const relativeInputs = (metafile: Metafile) => Object.keys(metafile.inputs).map(file => path.relative(root, path.resolve(root, file)).split(path.sep).join('/'));

test('a component and its rune module compile through the normal, minified and incremental build options', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-svelte-build-'));
    try {
        const outputs = new Map<string, string>();
        for (const minify of [false, true]) {
            const outputDir = path.join(directory, minify ? 'minified' : 'normal');
            const result = await build(esbuildOptions(fixtureEntry, { minify, outputDir }));
            assert.deepEqual(result.errors, []);
            assert.deepEqual(result.warnings.map(warning => warning.text), [], 'Svelte compiles without warnings');
            assert.deepEqual(Object.keys(result.metafile.outputs).map(file => path.basename(file)).sort(),
                minify ? ['island.js'] : ['island.js', 'island.js.map'], 'one bundle, no CSS or split chunks');
            const inputs = relativeInputs(result.metafile);
            for (const expected of ['test/fixtures/svelte/valid/UnitsIsland.svelte', 'test/fixtures/svelte/valid/units-draft.svelte.ts',
                'src/ui/svelte-island.ts', 'src/ui/svelte-island-props.svelte.ts', 'options/unit-settings-contract.ts']) {
                assert.ok(inputs.includes(expected), `${expected} is compiled into the bundle`);
            }
            assert.ok(inputs.some(file => file.startsWith('node_modules/svelte/src/internal/client/')), 'the client runtime is bundled');
            // An allowlist: anything else from node_modules, such as the compiler
            // or its parser dependencies, fails here by name.
            const runtime = /^node_modules\/(?:svelte\/src\/(?:internal\/(?:client|shared|flags)\/.+|internal\/disclose-version\.js|(?:attachments|reactivity|store|legacy)\/.+|[^/]+\.js)|esm-env\/(?:index|true|false)\.js|clsx\/dist\/.+)$/;
            assert.deepEqual(inputs.filter(file => file.startsWith('node_modules/') && !runtime.test(file)), [],
                'only the Svelte client runtime and its two small dependencies ship');
            assert.ok(inputs.includes('node_modules/esm-env/false.js') && !inputs.includes('node_modules/esm-env/dev-fallback.js'),
                'the runtime\'s DEV flag is pinned to production');
            const code = await readFile(path.join(outputDir, 'svelte-fixture', 'island.js'), 'utf8');
            assert.doesNotMatch(code, /\bnew Function\s*\(|\beval\s*\(|\bimportScripts\s*\(|\bimport\s*\(/, 'no runtime code generation or loading');
            // Exactly these, none loadable: XML namespace identifiers and
            // Svelte's error-reference and issue-report text, plus the custom
            // overlay relay identifier the shared settings schema validates.
            const origins = [...new Set([...code.matchAll(/https?:\/\/[\w.-]+/g)].map(match => match[0]))].sort();
            assert.deepEqual(origins, ['http://www.w3.org', 'https://github.com', 'https://relay.bpb.example', 'https://svelte.dev']);
            assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket/, 'the fixture bundle makes no network request');
            assert.doesNotMatch(code, /globalThis\.process/, 'no environment probe decides development behavior at runtime');
            assert.match(code, /bpb-units-island/, 'component styles are injected from the bundle');
            assert.equal(/sourceMappingURL=/.test(code), !minify);
            outputs.set(minify ? 'minified' : 'normal', code);
        }
        assert.ok(outputs.get('minified')!.length < outputs.get('normal')!.length);
        // Builds are reproducible from any working directory: scoped class
        // names hash the CSS rather than a cwd-relative file name.
        const elsewhere = path.join(directory, 'elsewhere');
        const previous = process.cwd();
        try {
            process.chdir(directory);
            await build(esbuildOptions(fixtureEntry, { minify: true, outputDir: elsewhere }));
        } finally { process.chdir(previous); }
        assert.equal(await readFile(path.join(elsewhere, 'svelte-fixture', 'island.js'), 'utf8'), outputs.get('minified'));
        const incremental = await context(esbuildOptions(fixtureEntry, { minify: false, outputDir: path.join(directory, 'incremental') }));
        try {
            for (let round = 0; round < 2; round++) {
                const result = await incremental.rebuild();
                assert.deepEqual(result.errors, []);
            }
        } finally { await incremental.dispose(); }
        const rebuilt = await readFile(path.join(directory, 'incremental', 'svelte-fixture', 'island.js'), 'utf8');
        assert.equal(rebuilt.replace(/\/\/# sourceMappingURL=.*$/m, ''), outputs.get('normal')!.replace(/\/\/# sourceMappingURL=.*$/m, ''),
            'incremental rebuilds produce the normal build');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

const svelteCheck = (project: string) => spawnSync(process.execPath,
    [path.join(root, 'node_modules/svelte-check/bin/svelte-check'), '--tsconfig', project, '--output', 'machine', '--fail-on-warnings'],
    { cwd: root, encoding: 'utf8', timeout: 120_000 });

test('svelte-check accepts the valid fixture and rejects invalid props and missing template names', () => {
    const valid = svelteCheck('./test/fixtures/svelte/valid.check.json');
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.match(valid.stdout, /COMPLETED \d+ FILES 0 ERRORS 0 WARNINGS/);
    const invalid = svelteCheck('./test/fixtures/svelte/invalid.check.json');
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    const errors = invalid.stdout.split('\n').filter(line => / ERROR /.test(line))
        .map(line => line.replace(/^\d+ ERROR /, '').replace(/\\n[\s\S]*$/, '"'));
    // Exact messages on purpose: a checker release that stops reporting one of
    // these, or reports it differently, must be reviewed rather than auto-merged.
    assert.deepEqual(errors.sort(), [
        '"test/fixtures/svelte/invalid/BadChild.svelte" 6:14 "Type \'string\' is not assignable to type \'UnitSettings\'."',
        '"test/fixtures/svelte/invalid/MissingName.svelte" 6:34 "Cannot find name \'coutn\'. Did you mean \'count\'?"',
        '"test/fixtures/svelte/invalid/bad-island.ts" 5:75 "Type \'string\' is not assignable to type \'UnitSettings\'."',
        '"test/fixtures/svelte/invalid/bad-island.ts" 6:17 "Type \'number\' is not assignable to type \'UnitSettings\'."',
        '"test/fixtures/svelte/invalid/bad-props.ts" 5:54 "Type \'number\' is not assignable to type \'UnitSettings\'."',
    ]);
});

async function pollUntil<T>(probe: () => Promise<{ ok: boolean; value: T; live: unknown }>, description: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const result = await probe();
        if (result.ok) return result.value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}; live state: ${JSON.stringify(result.live)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

test('watch mode publishes transitive component and rune edits, keeps the last generation on a component syntax error, and recovers', async () => {
    const temporaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-svelte-watch-')));
    const distDir = path.join(temporaryRoot, 'dist'), reloadFile = path.join(distDir, RELOAD_SIGNAL);
    const bundleFile = path.join(distDir, 'content', 'island.js');
    const componentFile = path.join(temporaryRoot, 'src', 'island', 'Panel.svelte');
    const childFile = path.join(temporaryRoot, 'src', 'island', 'Label.svelte');
    const runeFile = path.join(temporaryRoot, 'src', 'island', 'tally.svelte.ts');
    const component = (marker: string) => `<script lang="ts">\n    import Label from './Label.svelte';\n    import { createTally } from './tally.svelte.ts';\n    const tally = createTally();\n</script>\n\n<button onclick={() => tally.add()}>${marker} {tally.count}</button>\n<Label />\n`;
    const child = (marker: string) => `<p>${marker}</p>\n`;
    const rune = (marker: string) => `export function createTally() {\n    let count = $state(0);\n    return { get count() { return \`${marker}:\${count}\`; }, add() { count++; } };\n}\n`;
    await mkdir(path.dirname(componentFile), { recursive: true });
    // The disposable checkout resolves svelte from this repository's install.
    await symlink(path.join(root, 'node_modules'), path.join(temporaryRoot, 'node_modules'), 'dir');
    await writeFile(componentFile, component('component-v1'));
    await writeFile(childFile, child('child-v1'));
    await writeFile(runeFile, rune('rune-v1'));
    await writeFile(path.join(temporaryRoot, 'src', 'island', 'entry.ts'), "import Panel from './Panel.svelte';\nconsole.log(Panel);\n");
    await writeFile(path.join(temporaryRoot, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'svelte-watch' }) + '\n');
    const errors: string[] = [];
    const log = console.log, error = console.error;
    console.log = () => {};
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    const live = async () => ({
        token: (await readFile(reloadFile, 'utf8').catch(() => '')).trim(),
        bundle: await readFile(bundleFile, 'utf8').catch(() => ''),
    });
    const published = (after: { token: string }, ...markers: string[]) => pollUntil(async () => {
        const state = await live();
        return { ok: Number(state.token) > Number(after.token) && markers.every(marker => state.bundle.includes(marker)), value: state, live: { token: state.token, errors } };
    }, `${markers.join(', ')} to publish`);
    let watcher: Awaited<ReturnType<typeof watchAll>> | null = null;
    try {
        watcher = await watchAll({
            projectRoot: temporaryRoot, distDir, reloadFile, authoredSourceRoots: ['src'],
            entries: [{ out: 'content/island.js', sources: ['island/entry.ts'] }],
            copyFiles: [['manifest.json', 'manifest.json']], copyDirs: [], vendorCopy: [], debounceMs: 20,
        });
        const initial = await live();
        assert.equal(initial.token, '1');
        for (const marker of ['component-v1', 'child-v1', 'rune-v1']) assert.match(initial.bundle, new RegExp(marker));
        assert.doesNotMatch(initial.bundle, /let count = \$state\(0\)/, 'the rune module is compiled, not copied');

        await writeFile(runeFile, rune('rune-v2'));
        const afterRune = await published(initial, 'rune-v2', 'component-v1');
        await writeFile(childFile, child('child-v2'));
        const afterChild = await published(afterRune, 'child-v2', 'rune-v2');

        const errorCount = errors.length;
        await writeFile(componentFile, component('component-v2').replace('{tally.count}', '{tally.count'));
        await pollUntil(async () => ({ ok: errors.length > errorCount, value: true, live: errors }), 'the component syntax error to fail the rebuild');
        const failed = await live();
        assert.equal(failed.token, afterChild.token, 'a failed component generation does not advance the reload token');
        assert.equal(failed.bundle, afterChild.bundle, 'a failed component generation keeps the published bundle');
        assert.ok(errors.slice(errorCount).some(line => /Panel\.svelte/.test(line)), 'the failure names the component');

        await writeFile(componentFile, component('component-v3'));
        await published(afterChild, 'component-v3', 'child-v2', 'rune-v2');
    } finally {
        console.log = log;
        console.error = error;
        await watcher?.close();
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});
