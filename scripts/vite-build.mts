// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The production compiler: one Vite library build per bundle in ENTRIES.
// manifest.json stays the source of truth for script order and execution
// worlds, so every bundle is a self-contained IIFE (or ESM for the frames)
// whose ordered roots come from scripts/build-config.mts. Builds run
// concurrently; each is an independent Vite instance with no config file,
// environment file or public directory.

import assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Script } from 'node:vm';
import { parseSync, transformSync } from 'rolldown/utils';
import { compile as compileComponent, compileModule } from 'svelte/compiler';
import { build, createLogger, type Plugin } from 'vite';
import { ENTRIES, entrySources, root, type BundleEntry } from './build-config.mts';
import { patchJsZipCsp } from './jszip-csp-patch.mts';
import { SVELTE_COMPILER_OPTIONS, SVELTE_DEV_FLAG_MODULE, SVELTE_MODULE_COMPILER_OPTIONS } from './svelte-build.mts';

export const BROWSER_TARGETS = ['chrome128', 'firefox152'];
const ENTRY_PREFIX = '\0bpb-entry:';
// Vite resolves a library entry against the root before plugins see it.
const entryRequest = (entry: BundleEntry, projectRoot: string) => path.join(projectRoot, 'bpb-entry', entry.out);

export interface BundleBuildOptions {
    outputDir: string;
    entries?: readonly BundleEntry[];
    projectRoot?: string;
    minify?: boolean;
    // Copied verbatim into the output; null for a bundle-only build.
    manifestPath?: string | null;
    concurrency?: number;
}

export interface BundleBuildResult {
    // Every absolute module path that entered a bundle, for license notices.
    inputPaths: string[];
    diagnostics: string;
}

function bundlePlugin(entry: BundleEntry, projectRoot: string, inputs: Set<string>, patched: Set<string>): Plugin {
    const entryId = ENTRY_PREFIX + entry.out, entryPath = entryRequest(entry, projectRoot);
    return {
        name: 'better-peakbagger-bundle',
        enforce: 'pre',
        resolveId(id) {
            if (id === entryPath || id === entryId) return entryId;
            const imports = entry.browserImports ?? {};
            return Object.hasOwn(imports, id) ? { id: imports[id], external: true } : null;
        },
        load(id) {
            // The ordered roots become one synthetic entry module, so sibling
            // side effects evaluate in their configured order.
            if (id === entryId) return entrySources(entry, projectRoot)
                .map(source => `import ${JSON.stringify(source.split(path.sep).join('/'))};\n`).join('');
            if (!entry.patchJsZip || !/[/\\]jszip[/\\]dist[/\\]jszip\.min\.js$/.test(id)) return null;
            return (async () => {
                assert.ok(!patched.has(entry.out), `Repeated JSZip patch in ${entry.out}`);
                patched.add(entry.out);
                const pkg = JSON.parse(await readFile(path.resolve(path.dirname(id), '../package.json'), 'utf8')) as { version: string };
                return patchJsZipCsp(await readFile(id, 'utf8'), pkg.version);
            })();
        },
        transform(source, id) {
            if (!id.endsWith('.svelte') && !id.endsWith('.svelte.ts')) return null;
            const stripped = id.endsWith('.svelte.ts') ? transformSync(id, source) : null;
            if (stripped?.errors.length) throw new AggregateError(stripped.errors, `Unable to compile ${id}`);
            for (const warning of stripped?.warnings ?? []) this.warn(warning);
            const result = stripped
                ? compileModule(stripped.code, { ...SVELTE_MODULE_COMPILER_OPTIONS, filename: id })
                : compileComponent(source, { ...SVELTE_COMPILER_OPTIONS, filename: id });
            for (const warning of result.warnings) this.warn({ message: `${path.relative(projectRoot, id)} ${warning.code}: ${warning.message}`, id,
                loc: warning.start && { file: id, line: warning.start.line, column: warning.start.column } });
            return { code: result.js.code, map: result.js.map };
        },
        moduleParsed({ id }) {
            const file = id.split('?')[0]!;
            if (!path.isAbsolute(file)) return;
            assert.doesNotMatch(file, /[/\\]node_modules[/\\](?:vite|rolldown)[/\\]/, `Build tooling entered ${entry.out}: ${file}`);
            inputs.add(file);
        },
    };
}

// Rolldown warnings that leave a bundle broken at load in an extension page.
const FATAL_WARNINGS = new Set(['MISSING_GLOBAL_NAME', 'EMPTY_IMPORT_META']);

async function buildEntry(entry: BundleEntry, output: string, projectRoot: string, minify: boolean,
    inputs: Set<string>, patched: Set<string>, warnings: string[]) {
    // Vite's own logger reports deprecations and plugin warnings; keep them as
    // this generation's diagnostics instead of printing from many builds.
    const logger = createLogger('warn', { allowClearScreen: false });
    const record = (message: string) => { warnings.push(stripVTControlCharacters(message)); };
    logger.warn = record;
    logger.warnOnce = record;
    await build({
        configFile: false,
        envDir: false,
        publicDir: false,
        root: projectRoot,
        logLevel: 'warn',
        customLogger: logger,
        plugins: [bundlePlugin(entry, projectRoot, inputs, patched)],
        resolve: { alias: { 'esm-env/development': SVELTE_DEV_FLAG_MODULE } },
        // Library mode leaves process.env in place; bundled dependencies
        // must take their production paths in every generation.
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        build: {
            outDir: output,
            emptyOutDir: false,
            copyPublicDir: false,
            reportCompressedSize: false,
            target: BROWSER_TARGETS,
            sourcemap: !minify,
            minify,
            lib: { entry: entryRequest(entry, projectRoot), formats: [entry.format === 'esm' ? 'es' : 'iife'], name: 'bundle' },
            rolldownOptions: {
                // Module region comments are relative to this directory.
                cwd: projectRoot,
                // Vite's default handler fails the build on an unresolved
                // import; a classic bundle would otherwise ship a global
                // reference that throws when the page loads it.
                onwarn(warning, defaultHandler) {
                    if (warning.code && FATAL_WARNINGS.has(warning.code)) {
                        throw new Error(`${entry.out}: ${warning.code}: ${stripVTControlCharacters(warning.message)}`);
                    }
                    defaultHandler(warning);
                },
                // Chromium rejects Unicode noncharacters in content scripts.
                output: { entryFileNames: entry.out, strict: false, charset: 'ascii', comments: false },
            },
        },
    });
}

// Each bundle is checked as the browser will load it: valid UTF-8 without
// noncharacters, classic scripts that compile as scripts, and module frames
// whose only imports are their declared browser imports.
async function checkOutput(output: string, entries: readonly BundleEntry[], minify: boolean, manifest: boolean, projectRoot: string) {
    const emitted = (await readdir(output, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
        .map(entry => path.relative(output, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
    const expected = entries.flatMap(({ out }) => minify ? [out] : [out, `${out}.map`]);
    if (manifest) expected.push('manifest.json');
    assert.deepEqual(emitted, expected.sort());
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    for (const entry of entries) {
        const code = utf8.decode(await readFile(path.join(output, entry.out)));
        assert.ok(!/\p{Noncharacter_Code_Point}/u.test(code), `Invalid extension script character in ${entry.out}`);
        // Release code must not disclose where or by whom it was built.
        // Development generations may name modules linked from outside the
        // project, such as a fixture's symlinked node_modules.
        for (const local of minify ? new Set([projectRoot, homedir()].filter(value => value.split(/[/\\]/).filter(Boolean).length > 1)) : []) {
            assert.ok(!code.includes(local), `${entry.out} contains the local path ${local}`);
        }
        const module = entry.format === 'esm';
        if (!module) new Script(code, { filename: entry.out });
        if (!module && !/(?:-head|theme-early)\.js$/.test(entry.out)) continue;
        const syntax = parseSync(entry.out, code, { sourceType: module ? 'module' : 'script' });
        assert.deepEqual(syntax.errors.map(({ message }) => message), [], `Invalid script ${entry.out}`);
        assert.deepEqual(syntax.module.staticImports.map(({ moduleRequest }) => moduleRequest.value),
            Object.values(entry.browserImports ?? {}), `Static imports changed in ${entry.out}`);
        assert.ok(syntax.module.staticExports.every(declaration => declaration.entries.every(item => !item.moduleRequest)),
            `External re-export in ${entry.out}`);
        assert.equal(syntax.module.dynamicImports.length, 0, `Dynamic import in ${entry.out}`);
    }
}

// One generation at a time per process: Vite sets NODE_ENV while it builds,
// and overlapping generations would restore each other's value.
let generations: Promise<unknown> = Promise.resolve();

export function buildBundles(options: BundleBuildOptions): Promise<BundleBuildResult> {
    const generation = generations.then(() => buildGeneration(options));
    generations = generation.catch(() => {});
    return generation;
}

async function buildGeneration({ outputDir, projectRoot = root, entries = ENTRIES, minify = false,
    manifestPath = path.join(projectRoot, 'manifest.json'),
    concurrency = Math.min(8, availableParallelism()) }: BundleBuildOptions): Promise<BundleBuildResult> {
    const output = path.resolve(outputDir);
    const resolvedRoot = await realpath(path.resolve(projectRoot));
    assert.equal(new Set(entries.map(({ out }) => path.posix.normalize(out).toLowerCase())).size, entries.length,
        'Bundle output paths must be distinct');
    // Read the manifest before compiling so a generation publishes the bytes
    // it started from, even if the source is edited meanwhile.
    const manifestText = manifestPath ? await readFile(manifestPath, 'utf8') : null;
    const inputs = new Set<string>(), patched = new Set<string>(), warnings: string[] = [];
    // Vite defaults NODE_ENV for a production build; keep the caller's value.
    const nodeEnv = Object.hasOwn(process.env, 'NODE_ENV') ? process.env.NODE_ENV : undefined;
    const queue = [...entries];
    // On the first failure, stop taking entries and let in-flight builds
    // finish, so nothing writes into the output after this call returns.
    const workers = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
        for (let entry = queue.shift(); entry; entry = queue.shift()) {
            try {
                await buildEntry(entry, output, resolvedRoot, minify, inputs, patched, warnings);
            } catch (error) {
                queue.length = 0;
                throw error;
            }
        }
    }));
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    const failure = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    assert.deepEqual([...patched].sort(), entries.filter(({ patchJsZip }) => patchJsZip).map(({ out }) => out).sort());
    if (manifestText !== null) await writeFile(path.join(output, 'manifest.json'), manifestText);
    await checkOutput(output, entries, minify, manifestText !== null, resolvedRoot);
    return { inputPaths: [...inputs].sort(), diagnostics: warnings.join('\n') };
}
