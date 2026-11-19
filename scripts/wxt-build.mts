// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import type { Plugin } from 'vite';
import type { UserManifest, WxtUnimportOptions } from 'wxt';
import { ENTRIES, entrySources, root, type BundleEntry } from './build-config.mts';

const worker = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
// The pinned WXT built-in passes these options to the Unimport Vite plugin.
// That plugin takes autoImport separately from WXT's core import options.
const importOptions: WxtUnimportOptions & { autoImport: false } = { autoImport: false, dirs: [], eslintrc: { enabled: false } };

export interface WxtBundleOptions {
    outputDir: string;
    entries?: readonly BundleEntry[];
    projectRoot?: string;
    minify?: boolean;
    manifestPath?: string | null;
}

export interface WxtBuildResult {
    inputPaths: string[];
    diagnostics: string;
}

// WXT has one module-global build instance and loads environment files from
// process.cwd(). Keep each generation in its own process and working directory,
// including builds requested by tests or a running multi-browser watcher.
export async function buildWxtBundles({ outputDir, projectRoot = root, entries = ENTRIES,
    minify = false, manifestPath = path.join(projectRoot, 'manifest.json') }: WxtBundleOptions): Promise<WxtBuildResult> {
    const output = path.resolve(outputDir);
    await mkdir(path.dirname(output), { recursive: true });
    const workspace = await mkdtemp(path.join(path.dirname(output), 'wxt-'));
    try {
        const request = path.join(workspace, 'build.json');
        await writeFile(request, JSON.stringify({ output, projectRoot: path.resolve(projectRoot), entries, minify,
            manifestPath: manifestPath && path.resolve(manifestPath) }));
        const { stderr } = await execute(process.execPath, [worker, request], { cwd: workspace, maxBuffer: 4 * 1024 * 1024 });
        const inputPaths = JSON.parse(await readFile(path.join(workspace, 'inputs.json'), 'utf8')) as string[];
        return { inputPaths, diagnostics: stderr.trim() };
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

interface BuildRequest {
    output: string;
    projectRoot: string;
    entries: BundleEntry[];
    minify: boolean;
    manifestPath: string | null;
}

async function compile(workspace: string, { output, projectRoot, entries, minify, manifestPath }: BuildRequest) {
    const [{ build }, { parseSync, transformSync }, { compile: compileComponent, compileModule }, svelte, { patchJsZipCsp }] = await Promise.all([
        import('wxt'), import('rolldown/utils'), import('svelte/compiler'), import('./svelte-build.mts'), import('./jszip-csp-patch.mts'),
    ]);
    const manifestText = manifestPath ? await readFile(manifestPath, 'utf8') : null;
    const sourceManifest = manifestText === null ? { name: 'Better Peakbagger build fixture', version: '0.0.0' }
        : JSON.parse(manifestText) as UserManifest & { manifest_version?: number };
    const configManifest = { ...structuredClone(sourceManifest) };
    delete configManifest.manifest_version;
    if (projectRoot !== root) configManifest.version ??= '0.0.0';
    const inputs = new Set<string>();
    const patched = new Set<string>();
    const definitions = new Map<string, { entry: BundleEntry; input: string }>();
    const entryDirectory = path.join(workspace, 'entrypoints');
    const runtimeDirectory = path.join(workspace, 'runtime');
    await Promise.all([
        mkdir(entryDirectory), mkdir(runtimeDirectory),
        symlink(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'), 'junction'),
    ]);
    assert.equal(new Set(entries.map(({ out }) => path.posix.normalize(out).toLowerCase())).size, entries.length,
        'WXT bundle output paths must be distinct');
    for (const [index, entry] of entries.entries()) {
        const name = `bundle_${index}`;
        const input = path.join(runtimeDirectory, `${name}.ts`);
        definitions.set(name, { entry, input });
        // WXT imports metadata during discovery. Connect the ordered browser
        // modules only after discovery, when Vite bundles the entry.
        await writeFile(path.join(entryDirectory, `${name}.ts`), 'export default { main() {} };\n');
        await writeFile(input, entrySources(entry, projectRoot)
            .map(source => `import ${JSON.stringify(source.split(path.sep).join('/'))};\n`).join(''));
    }

    function plugin(entry: BundleEntry): Plugin {
        return {
            name: 'better-peakbagger-bundle',
            enforce: 'pre',
            resolveId(id) {
                const imports = entry.browserImports ?? {};
                return Object.hasOwn(imports, id) ? { id: imports[id], external: true } : null;
            },
            async load(id) {
                if (!entry.patchJsZip || !/[/\\]jszip[/\\]dist[/\\]jszip\.min\.js$/.test(id)) return null;
                assert.ok(!patched.has(entry.out), `Repeated JSZip patch in ${entry.out}`);
                patched.add(entry.out);
                const pkg = JSON.parse(await readFile(path.resolve(path.dirname(id), '../package.json'), 'utf8')) as { version: string };
                return patchJsZipCsp(await readFile(id, 'utf8'), pkg.version);
            },
            transform(source, id) {
                if (!id.endsWith('.svelte') && !id.endsWith('.svelte.ts')) return null;
                const stripped = id.endsWith('.svelte.ts') ? transformSync(id, source) : null;
                if (stripped?.errors.length) throw new AggregateError(stripped.errors, `Unable to compile ${id}`);
                for (const warning of stripped?.warnings ?? []) this.warn(warning);
                const result = stripped
                    ? compileModule(stripped.code, { ...svelte.SVELTE_MODULE_COMPILER_OPTIONS, filename: id })
                    : compileComponent(source, { ...svelte.SVELTE_COMPILER_OPTIONS, filename: id });
                for (const warning of result.warnings) this.warn({ message: `${path.relative(projectRoot, id)} ${warning.code}: ${warning.message}`, id,
                    loc: warning.start && { file: id, line: warning.start.line, column: warning.start.column } });
                return { code: result.js.code, map: result.js.map };
            },
            moduleParsed({ id }) {
                const file = id.split('?')[0];
                if (!path.isAbsolute(file)) return;
                assert.doesNotMatch(file, /[/\\]node_modules[/\\](?:wxt|@wxt-dev|vite|rolldown)[/\\]/,
                    `Build tooling entered ${entry.out}: ${file}`);
                inputs.add(file);
            },
        };
    }

    await build({
        root: workspace,
        configFile: false,
        manifestVersion: 3,
        browser: 'chrome',
        manifest: configManifest,
        outDir: path.dirname(output),
        outDirTemplate: path.basename(output),
        imports: importOptions,
        vite: () => ({
            cacheDir: path.join(workspace, 'vite-cache'),
            resolve: { alias: { 'esm-env/development': svelte.SVELTE_DEV_FLAG_MODULE } },
            build: { target: ['chrome128', 'firefox152'], sourcemap: !minify, minify },
        }),
        hooks: {
            'vite:build:extendConfig': ([discovered], config) => {
                const definition = definitions.get(discovered.name);
                assert.ok(definition, `Unexpected WXT entry ${discovered.name}`);
                const { entry, input } = definition;
                config.plugins = [...(config.plugins ?? []), plugin(entry)];
                assert.ok(config.build, `WXT omitted build settings for ${entry.out}`);
                config.build.lib = { entry: input, formats: [entry.format === 'esm' ? 'es' : 'iife'], name: discovered.name };
                // Chromium rejects Unicode noncharacters in content scripts.
                config.build.rolldownOptions = { output: { entryFileNames: entry.out, strict: false, charset: 'ascii', comments: false } };
            },
        },
    });

    assert.deepEqual([...patched].sort(), entries.filter(({ patchJsZip }) => patchJsZip).map(({ out }) => out).sort());
    const manifest = path.join(output, 'manifest.json');
    if (manifestText !== null && projectRoot === root) {
        assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), sourceManifest, 'WXT changed the extension manifest');
    }
    // Publish the same canonical bytes the compiler read, even if the source
    // manifest was edited while this generation was compiling.
    if (manifestText === null) await rm(manifest);
    else await writeFile(manifest, manifestText);
    const emitted = (await readdir(output, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
        .map(entry => path.relative(output, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
    const expected = entries.flatMap(({ out }) => minify ? [out] : [out, `${out}.map`]);
    if (manifestText !== null) expected.push('manifest.json');
    assert.deepEqual(emitted, expected.sort());
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    for (const entry of entries) {
        const code = utf8.decode(await readFile(path.join(output, entry.out)));
        assert.ok(!/\p{Noncharacter_Code_Point}/u.test(code), `Invalid extension script character in ${entry.out}`);
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
    await writeFile(path.join(workspace, 'inputs.json'), JSON.stringify([...inputs].sort()));
}

if (process.argv[1] === worker && process.argv[2]) {
    await compile(process.cwd(), JSON.parse(await readFile(process.argv[2], 'utf8')) as BuildRequest);
}
