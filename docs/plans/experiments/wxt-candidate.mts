// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import type { Metafile } from 'esbuild';
import { compile, compileModule } from 'svelte/compiler';
import { copyAssets, publishBuildTree, RELOAD_SIGNAL } from '../../../scripts/build.mts';
import { COPY_FILES, ENTRIES, entrySources, root, type BundleEntry } from '../../../scripts/build-config.mts';
import { patchJsZipCsp } from '../../../scripts/jszip-csp-patch.mts';
import { createFirefoxSource, syncFirefoxSource, validateFirefoxSource } from '../../../scripts/run-firefox.mts';
import {
    SVELTE_COMPILER_OPTIONS, SVELTE_DEV_FLAG_MODULE, SVELTE_MODULE_COMPILER_OPTIONS,
} from '../../../scripts/svelte-build.mts';
import { writeThirdPartyNotices } from '../../../scripts/third-party-notices.mts';
import { expectedReleaseFiles } from '../../../scripts/verify-release-archive.mts';

const WXT_VERSION = '0.21.5';
const VITE_VERSION = '8.3.8';
const MAX_BUILD_JOBS = 6;
const usage = 'Usage: node docs/plans/experiments/wxt-candidate.mts TOOLCHAIN_DIRECTORY release|development|rollback';
const sourceManifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;

// Only the isolated toolchain installs WXT and Vite. Describe the slice of their
// pinned build-hook interface used here so the repository can check this file independently.
interface ViteBuildStep {
    plugins?: unknown[];
    build: {
        lib: { entry: string; formats: ['es' | 'iife']; name: string };
        rollupOptions: {
            output: { entryFileNames: string; strict: false; charset: 'ascii' };
        };
    };
}

type WxtEntrypoint = { name: string };
type WxtGroup = WxtEntrypoint | WxtEntrypoint[];

interface WxtToolchain {
    version: string;
    build(config: {
        root: string;
        configFile: false;
        manifestVersion: 3;
        browser: 'chrome';
        manifest: Record<string, unknown>;
        outDirTemplate: string;
        imports: { autoImport: false; dirs: [] };
        vite: () => object;
        hooks: {
            'entrypoints:grouped'?: (
                wxt: { builder: { build(group: WxtGroup): Promise<unknown> } }, groups: WxtGroup[],
            ) => void;
            'vite:build:extendConfig': (
                entries: readonly WxtEntrypoint[], config: ViteBuildStep,
            ) => void;
        };
    }): Promise<unknown>;
}

// Read the module summary without converting Rolldown's native AST to JS.
type ParseScript = (filename: string, code: string, options: { sourceType: 'module' | 'script' }) => {
    errors: readonly { message: string }[];
    module: {
        staticImports: readonly { moduleRequest: { value: string } }[];
        dynamicImports: readonly unknown[];
    };
};

interface CandidateTools {
    directory: string;
    wxt: WxtToolchain;
    parseSync: ParseScript;
}

// WXT consumes group results in discovery order. Each candidate group writes
// its own bundle and source map into the disposable tree. Wait for all active
// writes before returning a result so a failure cannot race tree cleanup.
export function scheduleBuildGroups<Group, Output>(
    groups: readonly Group[],
    jobs: number,
    build: (group: Group) => Promise<Output>,
): (group: Group) => Promise<Output> {
    const results = new Map<Group, PromiseSettledResult<Output>>();
    let next = 0;
    let failed = false;
    let completion: Promise<void[]> | undefined;
    const work = async () => {
        while (!failed && next < groups.length) {
            const group = groups[next++];
            try {
                results.set(group, { status: 'fulfilled', value: await build(group) });
            } catch (reason) {
                failed = true;
                results.set(group, { status: 'rejected', reason });
            }
        }
    };
    return async group => {
        completion ??= Promise.all(Array.from({ length: Math.min(groups.length, jobs) }, work));
        await completion;
        const result = results.get(group);
        assert.ok(result, 'WXT requested a group outside the completed build sequence');
        if (result.status === 'rejected') throw result.reason;
        return result.value;
    };
}

function runtimePlugin(entry: BundleEntry, inputs: Metafile['inputs'], patched: Set<string>) {
    return {
        name: 'better-peakbagger-candidate',
        enforce: 'pre',
        resolveId(id: string) {
            const external = entry.browserImports?.[id];
            return external ? { id: external, external: true } : null;
        },
        async load(id: string) {
            if (entry.patchJsZip && /[/\\]jszip[/\\]dist[/\\]jszip\.min\.js$/.test(id)) {
                assert.ok(!patched.has(entry.out), `Repeated JSZip patch in ${entry.out}`);
                patched.add(entry.out);
                const metadata = JSON.parse(await readFile(path.resolve(path.dirname(id), '../package.json'), 'utf8')) as { version: string };
                return patchJsZipCsp(await readFile(id, 'utf8'), metadata.version);
            }
            return null;
        },
        transform(source: string, id: string) {
            if (id.endsWith('.svelte')) {
                const result = compile(source, { ...SVELTE_COMPILER_OPTIONS, filename: id });
                return { code: result.js.code, map: result.js.map };
            }
            if (id.endsWith('.svelte.ts')) {
                const result = compileModule(stripTypeScriptTypes(source), { ...SVELTE_MODULE_COMPILER_OPTIONS, filename: id });
                return { code: result.js.code, map: result.js.map };
            }
            return null;
        },
        moduleParsed({ id }: { id: string }) {
            // Count loaded npm modules, including inputs the bundler tree-shakes.
            // The notice collector only reads these keys.
            if (path.isAbsolute(id) && id.split(path.sep).includes('node_modules')) {
                assert.ok(id.startsWith(path.join(root, 'node_modules') + path.sep),
                    `Candidate pulled a toolchain dependency into ${entry.out}: ${id}`);
                inputs[id.split('?')[0]] = { bytes: 0, imports: [] };
            }
        },
    };
}

function verifyScriptFormat(entry: BundleEntry, code: string, parseSync: ParseScript) {
    if (entry.format !== 'esm') new Script(code, { filename: entry.out });
    if (entry.format !== 'esm' && !/(?:-head|theme-early)\.js$/.test(entry.out)) return;

    const { errors, module: syntax } = parseSync(entry.out, code, {
        sourceType: entry.format === 'esm' ? 'module' : 'script',
    });
    assert.deepEqual(errors.map(({ message }) => message), [], `Invalid script ${entry.out}`);
    const imports = syntax.staticImports.map(({ moduleRequest }) => moduleRequest.value);
    assert.deepEqual(imports, Object.values(entry.browserImports ?? {}), `Static imports changed in ${entry.out}`);
    assert.equal(syntax.dynamicImports.length, 0, `Dynamic import in ${entry.out}`);
}

async function inventory(directory: string) {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile())
        .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
        .sort();
}

async function buildCandidate(
    { directory, wxt, parseSync }: CandidateTools,
    workspace: string,
    { minify, jobs, fault = false, revision = 0 }: { minify: boolean; jobs: number; fault?: boolean; revision?: number },
) {
    const bundlePaths = new Set(ENTRIES.map(({ out }) => path.posix.normalize(out).toLowerCase()));
    assert.equal(bundlePaths.size, ENTRIES.length, 'Candidate entries must have distinct output paths');
    const generation = await mkdtemp(path.join(workspace, 'generation-'));
    const entryDirectory = path.join(generation, 'entrypoints');
    const runtimeDirectory = path.join(generation, 'runtime');
    const publicDirectory = path.join(generation, 'public');
    const inputs: Metafile['inputs'] = {};
    const patched = new Set<string>();
    await symlink(path.join(directory, 'node_modules'), path.join(generation, 'node_modules'), 'junction');
    await mkdir(entryDirectory);
    await mkdir(runtimeDirectory);
    await copyAssets(publicDirectory, {
        copyFiles: COPY_FILES.filter(([, destination]) => destination !== 'manifest.json'),
    });

    const definitions = new Map<string, { entry: BundleEntry; input: string }>();
    for (const [index, entry] of ENTRIES.entries()) {
        const name = `bundle_${index}`;
        const input = path.join(runtimeDirectory, `${name}.ts`);
        definitions.set(name, { entry, input });
        // Discovery executes this metadata module in Node. Browser-side roots
        // are only wired into the later Vite build step.
        await writeFile(path.join(entryDirectory, `${name}.ts`), 'export default { main() {} };\n');
        let imports = entrySources(entry).map(source => `import ${JSON.stringify(source)};\n`).join('');
        if (index === 0 && fault) imports += 'const = ;\n';
        if (index === 0 && revision > 0) imports += `console.debug('Candidate generation ${revision}');\n`;
        await writeFile(input, imports);
    }
    await wxt.build({
        root: generation,
        configFile: false,
        manifestVersion: 3,
        browser: 'chrome',
        manifest: structuredClone(sourceManifest),
        outDirTemplate: 'candidate',
        imports: { autoImport: false, dirs: [] },
        vite: () => ({
            cacheDir: path.join(generation, 'vite-cache'),
            resolve: { alias: { 'esm-env/development': SVELTE_DEV_FLAG_MODULE } },
            build: { target: ['chrome128', 'firefox152'], sourcemap: !minify, minify },
        }),
        hooks: {
            ...(jobs > 1 ? {
                'entrypoints:grouped': ({ builder }, groups) => {
                    builder.build = scheduleBuildGroups(groups, jobs, builder.build.bind(builder));
                },
            } : {}),
            'vite:build:extendConfig': ([resolved], config) => {
                const definition = definitions.get(resolved.name);
                assert.ok(definition, `Unexpected WXT entrypoint ${resolved.name}`);
                const { entry, input } = definition;
                config.plugins = [...(config.plugins ?? []), runtimePlugin(entry, inputs, patched)];
                config.build.lib = { entry: input, formats: [entry.format === 'esm' ? 'es' : 'iife'], name: resolved.name };
                // Chromium rejects Unicode noncharacters in registered content
                // scripts, even when their UTF-8 byte sequence is well formed.
                config.build.rollupOptions = { output: { entryFileNames: entry.out, strict: false, charset: 'ascii' } };
            },
        },
    });
    const candidate = path.join(generation, '.output', 'candidate');
    assert.deepEqual([...patched].sort(), ENTRIES.filter(({ patchJsZip }) => patchJsZip).map(({ out }) => out).sort());
    assert.deepEqual(JSON.parse(await readFile(path.join(candidate, 'manifest.json'), 'utf8')), sourceManifest);
    await writeThirdPartyNotices({ metafiles: [{ inputs, outputs: {} }], outputDir: candidate });
    const expected = await expectedReleaseFiles();
    if (!minify) expected.push(...ENTRIES.map(({ out }) => `${out}.map`));
    assert.deepEqual(await inventory(candidate), expected.sort());
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    for (const entry of ENTRIES) {
        const code = utf8.decode(await readFile(path.join(candidate, entry.out)));
        assert.ok(!/\p{Noncharacter_Code_Point}/u.test(code), `Invalid extension script character in ${entry.out}`);
        verifyScriptFormat(entry, code, parseSync);
    }
    for (const asset of await inventory(publicDirectory)) {
        const [source, emitted] = await Promise.all([publicDirectory, candidate].map(dir => readFile(path.join(dir, asset))));
        assert.ok(source.equals(emitted), `Candidate changed copied asset ${asset}`);
    }
    return candidate;
}

async function fingerprint(directory: string) {
    const hash = createHash('sha256');
    for (const file of await inventory(directory)) {
        hash.update(file);
        hash.update('\0');
        hash.update(await readFile(path.join(directory, file)));
        hash.update('\0');
    }
    return hash.digest('hex');
}

async function verifyRollback(tools: CandidateTools, workspace: string, jobs: number) {
    const live = path.join(workspace, 'chromium');
    const firefox = await createFirefoxSource({ temporaryRoot: workspace });
    const publish = async (candidateDir: string, sequence: number, renameTree?: typeof rename) => {
        if (sequence > 1) await copyFile(path.join(live, RELOAD_SIGNAL), path.join(candidateDir, RELOAD_SIGNAL));
        await publishBuildTree({ candidateDir, targetDir: live, renameTree });
        await syncFirefoxSource({ distDir: live, sourceDir: firefox.sourceDir, reloadToken: sequence });
        await writeFile(path.join(live, RELOAD_SIGNAL), `${sequence}\n`);
        await validateFirefoxSource(firefox.sourceDir, { distDir: live, reloadToken: sequence });
        for (const directory of [live, firefox.sourceDir]) {
            assert.equal(await readFile(path.join(directory, RELOAD_SIGNAL), 'utf8'), `${sequence}\n`);
            const generated = await readFile(path.join(directory, ENTRIES[0].out), 'utf8');
            assert.match(generated, new RegExp(`Candidate generation ${sequence}`));
        }
    };
    const current = () => Promise.all([fingerprint(live), fingerprint(firefox.sourceDir)]);

    await publish(await buildCandidate(tools, workspace, { minify: false, jobs, revision: 1 }), 1);
    const first = await current();
    await assert.rejects(buildCandidate(tools, workspace, { minify: false, jobs, fault: true }), error => {
        assert.ok(error instanceof Error && error.cause instanceof Error);
        assert.match(error.message, /Failed to build bundle_0/);
        assert.match(error.cause.message, /Unexpected token/);
        assert.match(error.cause.message, /runtime\/bundle_0\.ts/);
        return true;
    });
    assert.deepEqual(await current(), first, 'A failed build changed a published candidate');
    const next = await buildCandidate(tools, workspace, { minify: false, jobs, revision: 2 });
    await assert.rejects(publish(next, 2, async (from, to) => {
        if (from === next && to === live) throw new Error('Injected candidate publication failure');
        await rename(from, to);
    }), /Injected candidate publication failure/);
    assert.deepEqual(await current(), first, 'A failed directory swap changed a published candidate');
    await publish(next, 2);
}

async function main() {
    const [toolchainPath, mode, extra] = process.argv.slice(2);
    if (!toolchainPath || extra !== undefined || !['release', 'development', 'rollback'].includes(mode)) {
        throw new Error(usage);
    }
    const jobs = Number(process.env.BPB_WXT_JOBS ?? Math.min(MAX_BUILD_JOBS, availableParallelism()));
    assert.ok(Number.isInteger(jobs) && jobs >= 1 && jobs <= MAX_BUILD_JOBS,
        `BPB_WXT_JOBS must be an integer from 1 to ${MAX_BUILD_JOBS}`);
    const directory = path.resolve(toolchainPath);
    const requireTool = createRequire(path.join(directory, 'package.json'));
    const wxtEntry = requireTool.resolve('wxt');
    const wxt = await import(pathToFileURL(wxtEntry).href) as WxtToolchain;
    const requireVite = createRequire(wxtEntry);
    const vite = requireVite('vite/package.json') as { version: string };
    assert.equal(wxt.version, WXT_VERSION);
    assert.equal(vite.version, VITE_VERSION);
    const rolldownUtils = createRequire(requireVite.resolve('vite/package.json')).resolve('rolldown/utils');
    const { parseSync } = await import(pathToFileURL(rolldownUtils).href) as { parseSync: ParseScript };
    const tools = { directory, wxt, parseSync };
    const workspace = await mkdtemp(path.join(tmpdir(), 'bpb-wxt-candidate-'));
    const previousDirectory = process.cwd();
    const start = performance.now();
    let keep = false;
    try {
        process.chdir(workspace);
        if (mode === 'rollback') {
            await verifyRollback(tools, workspace, jobs);
            console.log('Verified two complete generations and preserved both reload tokens on compile and Chromium directory-swap failures.');
        } else {
            const candidate = await buildCandidate(tools, workspace, { minify: mode === 'release', jobs });
            keep = true;
            console.log(JSON.stringify({ candidate, workspace, bundles: ENTRIES.length, elapsedMs: Math.round(performance.now() - start) }));
        }
    } finally {
        process.chdir(previousDirectory);
        if (!keep) await rm(workspace, { recursive: true, force: true });
    }
}

if (process.argv[1]) {
    const entry = path.resolve(process.argv[1]);
    const modulePath = fileURLToPath(import.meta.url);
    if (entry === modulePath || (await realpath(entry).catch(() => null)) === modulePath) await main();
}
