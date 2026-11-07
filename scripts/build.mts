// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — esbuild bundler.
//
// The extension source lives as ES modules under src/. Browsers cannot load an
// ES module as a classic content script, so manifest entry points are bundled
// into self-contained IIFEs. The extension-owned terrain page is the deliberate
// exception: its frame entry stays ESM so it can import MapLibre directly.
// dist/ is the unpacked extension: it is what you load, what the release
// packagers zip, and what the real-extension checks exercise.
//
// The bundle composition and asset list live in scripts/build-config.mts (the
// single source of truth, shared with the test suite). This file only turns
// that config into esbuild calls and copies.
//
// Usage:
//   node scripts/build.mts            one-off development build (sourcemaps)
//   node scripts/build.mts --minify   production build (minified, no sourcemap)
//   node scripts/build.mts --watch    rebuild on source/asset change

import { build, context, type BuildOptions, type Plugin } from 'esbuild';
import { jsZipCspPlugin } from './jszip-csp-patch.mjs';
import { patchMapLibreTerrainLod } from './maplibre-terrain-lod-patch.mts';
import {
    access,
    copyFile,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    AUTHORED_SOURCE_ROOTS,
    ENTRIES,
    COPY_FILES,
    COPY_DIRS,
    VENDOR_COPY,
    nodeModule,
    entrySources,
    root,
    distDir,
    type BundleEntry,
} from './build-config.mts';
import { writeThirdPartyNotices } from './third-party-notices.mjs';

const args = new Set(process.argv.slice(2));
const MINIFY = args.has('--minify');
const WATCH = args.has('--watch');

export const RELOAD_SIGNAL = '.better-peakbagger-reload';
export const BUILD_TREE_PREFIX = '.better-peakbagger-build-';

export function formatReloadLog(sequence: number, date = new Date()) {
    const pad = (value: number) => String(value).padStart(2, '0');
    const timestamp = [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    return `[${timestamp}] Rebuilt ${ENTRIES.length} bundles (development reload ${sequence})`;
}

async function copyDir(from: string, to: string) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name);
        const d = path.join(to, entry.name);
        if (entry.isDirectory()) await copyDir(s, d);
        else await copyFile(s, d);
    }
}

export interface BuildLayout {
    projectRoot?: string;
    distDir?: string;
    entries?: readonly BundleEntry[];
    authoredSourceRoots?: readonly string[];
    copyFiles?: readonly (readonly string[])[];
    copyDirs?: readonly (readonly string[])[];
    vendorCopy?: readonly (readonly string[])[];
}

async function copyAssets(outputDir: string, {
    projectRoot = root,
    copyFiles = COPY_FILES,
    copyDirs = COPY_DIRS,
    vendorCopy = VENDOR_COPY,
}: BuildLayout = {}) {
    for (const [from, to] of copyFiles) {
        const dest = path.join(outputDir, to);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(path.join(projectRoot, from), dest);
    }
    for (const [from, to] of copyDirs) {
        const source = path.join(projectRoot, from);
        if (existsSync(source)) await copyDir(source, path.join(outputDir, to));
    }
    // Vendor browser builds come from npm (node_modules), not a committed dir.
    for (const [from, to] of vendorCopy) {
        const dest = path.join(outputDir, to);
        await mkdir(path.dirname(dest), { recursive: true });
        if (from === 'maplibre-gl/dist/maplibre-gl.mjs') {
            const source = await readFile(nodeModule(from), 'utf8');
            const { version } = JSON.parse(await readFile(nodeModule('maplibre-gl/package.json'), 'utf8')) as { version: string };
            await writeFile(dest, patchMapLibreTerrainLod(source, version));
        } else await copyFile(nodeModule(from), dest);
    }
}

// esbuild takes one entry file per output. For a multi-module bundle we feed it
// a generated stub that imports each source in order.
function browserImportPlugins(imports: Record<string, string> = {}): Plugin[] {
    if (Object.keys(imports).length === 0) return [];
    return [{
        name: 'extension-browser-imports',
        setup(buildContext) {
            buildContext.onResolve({ filter: /.*/ }, resolveArgs => {
                if (!Object.hasOwn(imports, resolveArgs.path)) return undefined;
                return { path: imports[resolveArgs.path], external: true };
            });
        },
    }];
}

function esbuildOptions(entry: BundleEntry, {
    minify = MINIFY,
    outputDir = distDir,
    projectRoot = root,
}: { minify?: boolean; outputDir?: string; projectRoot?: string } = {}): BuildOptions & { metafile: true } {
    const imports = entrySources(entry, projectRoot).map(f => `import ${JSON.stringify(f)};`).join('\n');
    return {
        stdin: {
            contents: imports + '\n',
            resolveDir: projectRoot,
            sourcefile: path.join('build-entry', entry.out),
            loader: 'js',
        },
        outfile: path.join(outputDir, entry.out),
        bundle: true,
        format: (entry.format as 'iife' | 'esm' | 'cjs' | undefined) || 'iife',
        target: ['chrome128', 'firefox152'],
        platform: 'browser',
        legalComments: 'none',
        metafile: true,
        minify,
        sourcemap: minify ? false : 'linked',
        logLevel: 'warning',
        plugins: [...browserImportPlugins(entry.browserImports), ...(entry.patchJsZip ? [jsZipCspPlugin() as Plugin] : [])],
    };
}

function newBuildTreePath(projectRoot = root) {
    return path.join(projectRoot,
        `${BUILD_TREE_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function processIsAlive(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
    }
}

export interface CleanupBuildTreesOptions {
    directory?: string;
    keep?: string | null;
}

export async function cleanupAbandonedBuildTrees({ directory = root, keep = null }: CleanupBuildTreesOptions = {}) {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries
        .filter(entry => entry.isDirectory() && entry.name.startsWith(BUILD_TREE_PREFIX))
        .map(async entry => {
            const candidate = path.join(directory, entry.name);
            if (candidate === keep) return;
            const pid = Number(entry.name.slice(BUILD_TREE_PREFIX.length).split('-')[0]);
            if (processIsAlive(pid)) return;
            await rm(candidate, { recursive: true, force: true });
        }));
}

export async function validateBuildTree(outputDir: string, {
    minify = MINIFY,
    entries = ENTRIES,
    copyFiles = COPY_FILES,
    copyDirs = COPY_DIRS,
    vendorCopy = VENDOR_COPY,
}: { minify?: boolean } & BuildLayout = {}) {
    const required = [
        ...entries.flatMap(entry => [entry.out, ...(!minify ? [`${entry.out}.map`] : [])]),
        ...copyFiles.map(([, to]) => to),
        ...copyDirs.map(([, to]) => to),
        ...vendorCopy.map(([, to]) => to),
        'THIRD_PARTY_NOTICES.txt',
    ];
    for (const relative of required) await access(path.join(outputDir, relative));
}

export interface PublishBuildTreeOptions {
    candidateDir?: string;
    targetDir?: string;
    renameTree?: typeof rename;
}

export async function publishBuildTree({
    candidateDir,
    targetDir = distDir,
    renameTree = rename,
}: PublishBuildTreeOptions = {}) {
    if (!candidateDir || path.resolve(candidateDir) === path.resolve(targetDir)) {
        throw new Error('Build publication requires a distinct candidate tree.');
    }
    const previousDir = `${targetDir}.previous-${process.pid}-${Date.now()}`;
    await rm(previousDir, { recursive: true, force: true });
    const hadPrevious = existsSync(targetDir);
    if (hadPrevious) await renameTree(targetDir, previousDir);
    try {
        await renameTree(candidateDir, targetDir);
    } catch (publishError) {
        if (hadPrevious) {
            try {
                await renameTree(previousDir, targetDir);
            } catch (rollbackError) {
                // A transient Windows handle can make the first restore rename
                // fail even after the publishing rename has already failed.
                // Retry once while the complete previous tree is still parked
                // beside the target; a recovered rollback still rejects the
                // generation, but keeps the live source byte-for-byte old.
                try {
                    await renameTree(previousDir, targetDir);
                } catch (retryError) {
                    throw new AggregateError([publishError, rollbackError, retryError],
                        'Build publication and rollback both failed.');
                }
                const message = publishError instanceof Error ? publishError.message : String(publishError);
                throw new AggregateError([publishError, rollbackError],
                    `Build publication failed (${message}); rollback recovered after retry.`);
            }
        }
        throw publishError;
    }
    await rm(previousDir, { recursive: true, force: true });
}

export async function buildOnce({ minify = MINIFY }: { minify?: boolean } = {}) {
    const stagingRoot = newBuildTreePath();
    const candidateDir = path.join(stagingRoot, 'generation');
    await cleanupAbandonedBuildTrees({ keep: stagingRoot });
    await mkdir(candidateDir, { recursive: true });
    try {
        const results = await Promise.all(ENTRIES.map(e => build(esbuildOptions(e, {
            minify,
            outputDir: candidateDir,
        }))));
        await writeThirdPartyNotices({
            metafiles: results.map(({ metafile }) => metafile),
            outputDir: candidateDir,
        });
        await copyAssets(candidateDir);
        await validateBuildTree(candidateDir, { minify });
        await publishBuildTree({ candidateDir });
        console.log(`Built ${ENTRIES.length} bundles into dist/${minify ? ' (minified)' : ''}`);
    } finally {
        await rm(stagingRoot, { recursive: true, force: true });
    }
}

// Watch mode recursively watches every existing directory in AUTHORED_SOURCE_ROOTS
// alongside the copied asset directories and root files, deduplicating
// overlapping child directories under already-watched parents. Creating new
// nested subdirectories or files inside an already-watched root works live.
// Restart the watcher after adding a new top-level root, creating a configured
// top-level directory that did not exist at startup, or changing entry/compiler
// configuration (scripts/build-config.mts, scripts/build.mts, tsconfig*.json)
// or installed dependencies (package.json, package-lock.json, node_modules/).
export function watchDirectories({
    projectRoot = root,
    authoredSourceRoots = AUTHORED_SOURCE_ROOTS,
    copyFiles = COPY_FILES,
    copyDirs = COPY_DIRS,
}: BuildLayout = {}) {
    const resolvedRoot = path.resolve(projectRoot);
    const candidates = new Set([
        ...authoredSourceRoots.map(directory => path.resolve(resolvedRoot, directory)),
        ...copyFiles
            .map(([file]) => path.dirname(path.resolve(resolvedRoot, file)))
            .filter(directory => directory !== resolvedRoot),
        ...copyDirs
            .map(([directory]) => path.resolve(resolvedRoot, directory))
            .filter(directory => directory !== resolvedRoot),
    ]);
    const sorted = [...candidates]
        .filter(existsSync)
        .sort((left, right) => left.length - right.length || left.localeCompare(right));
    const deduplicated: string[] = [];
    for (const directory of sorted) {
        if (deduplicated.some(parent => directory === parent || directory.startsWith(parent + path.sep))) {
            continue;
        }
        deduplicated.push(directory);
    }
    return deduplicated;
}

export interface WatchAllOptions extends BuildLayout {
    reloadFile?: string;
    afterBuild?: (info: { sequence: number }) => Promise<void> | void;
    debounceMs?: number;
}

export interface WatchHandle {
    reloadFile: string;
    close(): Promise<void>;
}

// Watch mode rebuilds every bundle as one transaction. A shared module can
// feed several independent esbuild contexts; reloading after the first context
// finishes would expose a mixed runtime tree. The signal file is therefore
// written only after every bundle and copied asset has completed successfully.
export async function watchAll({
    projectRoot = root,
    distDir: targetDistDir = path.join(projectRoot, 'dist'),
    entries = ENTRIES,
    authoredSourceRoots = AUTHORED_SOURCE_ROOTS,
    copyFiles = COPY_FILES,
    copyDirs = COPY_DIRS,
    vendorCopy = VENDOR_COPY,
    reloadFile = path.join(targetDistDir, RELOAD_SIGNAL),
    afterBuild = async () => {},
    debounceMs = 80,
}: WatchAllOptions = {}): Promise<WatchHandle> {
    const layout: BuildLayout = {
        projectRoot,
        distDir: targetDistDir,
        entries,
        authoredSourceRoots,
        copyFiles,
        copyDirs,
        vendorCopy,
    };
    const stagingRoot = newBuildTreePath(projectRoot);
    const outputDir = path.join(stagingRoot, 'working');
    await cleanupAbandonedBuildTrees({ directory: projectRoot, keep: stagingRoot });
    await mkdir(outputDir, { recursive: true });
    const contexts = await Promise.all(entries.map(e => context(esbuildOptions(e, {
        minify: false,
        outputDir,
        projectRoot,
    }))));
    const watchers: FSWatcher[] = [];
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let building: Promise<void> | null = null;
    let pending = false;
    let closed = false;

    const rebuild = async () => {
        const nextSequence = sequence + 1;
        await rm(outputDir, { recursive: true, force: true });
        await mkdir(outputDir, { recursive: true });
        const results = await Promise.all(contexts.map(buildContext => buildContext.rebuild()));
        await writeThirdPartyNotices({
            metafiles: results.map(({ metafile }) => metafile),
            outputDir,
        });
        await copyAssets(outputDir, layout);
        await validateBuildTree(outputDir, { minify: false, ...layout });

        // Preserve the prior token through the tree publication. The new token
        // is written only after the complete generation is visible at dist/.
        try {
            await writeFile(path.join(outputDir, RELOAD_SIGNAL), await readFile(reloadFile));
        } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const candidateDir = path.join(stagingRoot, `generation-${nextSequence}`);
        await rm(candidateDir, { recursive: true, force: true });
        await rename(outputDir, candidateDir);
        await publishBuildTree({ candidateDir, targetDir: targetDistDir });
        await afterBuild({ sequence: nextSequence });
        await writeFile(reloadFile, `${nextSequence}\n`);
        sequence = nextSequence;
        console.log(formatReloadLog(sequence));
    };

    const drain = async () => {
        if (building || closed) return building;
        building = (async () => {
            do {
                pending = false;
                try {
                    await rebuild();
                } catch (error) {
                    console.error('Rebuild failed; keeping the currently loaded extension:', error);
                }
            } while (pending && !closed);
        })().finally(() => {
            building = null;
        });
        return building;
    };

    const requestRebuild = () => {
        if (closed) return;
        pending = true;
        clearTimeout(timer);
        timer = setTimeout(() => void drain(), debounceMs);
    };

    try {
        // Fail startup rather than launching a browser with a partial build.
        await rebuild();

        for (const directory of watchDirectories(layout)) {
            watchers.push(fsWatch(directory, { recursive: true }, requestRebuild));
        }
        const resolvedRoot = path.resolve(projectRoot);
        const rootFiles = new Set(
            copyFiles
                .map(([file]) => path.resolve(projectRoot, file))
                .filter(file => path.dirname(file) === resolvedRoot)
                .map(file => path.basename(file)),
        );
        if (rootFiles.size > 0) {
            watchers.push(fsWatch(resolvedRoot, (_event, filename) => {
                if (filename && rootFiles.has(filename.toString())) requestRebuild();
            }));
        }
    } catch (error) {
        for (const watcher of watchers) watcher.close();
        await Promise.all(contexts.map(buildContext => buildContext.dispose()));
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
    }

    console.log('Watching for changes… (Ctrl+C to stop)');

    return {
        reloadFile,
        async close() {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            for (const watcher of watchers) watcher.close();
            if (building) await building;
            await Promise.all(contexts.map(buildContext => buildContext.dispose()));
            await rm(stagingRoot, { recursive: true, force: true });
        },
    };
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    const run = WATCH ? () => watchAll() : () => buildOnce();
    run().catch(err => { console.error(err); process.exit(1); });
}
