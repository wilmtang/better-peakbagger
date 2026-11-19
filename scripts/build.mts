// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — Vite build and transactional publication.
//
// The extension source lives as ES modules under src/. Browsers cannot load an
// ES module as a classic content script, so manifest entry points are bundled
// into self-contained IIFEs. The extension-owned terrain page is the deliberate
// exception: its frame entry stays ESM so it can import MapLibre directly.
// dist/ is the unpacked extension: it is what you load, what the release
// packagers zip, and what the real-extension checks exercise.
//
// The bundle composition and asset list live in scripts/build-config.mts (the
// single source of truth, shared with the test suite). Vite compiles the
// bundles while this file stages assets and publishes complete generations.
//
// Usage:
//   node scripts/build.mts            one-off development build (sourcemaps)
//   node scripts/build.mts --minify   production build (minified, no sourcemap)
//   node scripts/build.mts --watch    rebuild on source/asset change

import { patchMapLibreTerrainLod } from './maplibre-terrain-lod-patch.mts';
import {
    access,
    copyFile,
    mkdir,
    readFile,
    readdir,
    realpath,
    mkdtemp,
    rename,
    rm,
    stat,
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
    root,
    type BundleEntry,
} from './build-config.mts';
import { writeThirdPartyNotices } from './third-party-notices.mts';
import { buildBundles } from './vite-build.mts';
import { publishBuildTree, RELOAD_SIGNAL } from './build-publication.mts';
import { prepareFirefoxGeneration } from './run-firefox.mts';

export { publishBuildTree, RELOAD_SIGNAL } from './build-publication.mts';

const args = new Set(process.argv.slice(2));
const MINIFY = args.has('--minify');
const WATCH = args.has('--watch');

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

export async function copyAssets(outputDir: string, {
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

export async function buildOnce({ minify = MINIFY }: { minify?: boolean } = {}) {
    const stagingRoot = newBuildTreePath();
    const candidateDir = path.join(stagingRoot, 'generation');
    await cleanupAbandonedBuildTrees({ keep: stagingRoot });
    try {
        const { inputPaths, diagnostics } = await buildBundles({ minify, outputDir: candidateDir });
        if (diagnostics) console.warn(diagnostics);
        await writeThirdPartyNotices({ inputPaths, outputDir: candidateDir });
        await copyAssets(candidateDir, { copyFiles: COPY_FILES.filter(([, to]) => to !== 'manifest.json') });
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
    firefoxSourceDir?: string;
    beforePublish?: (info: { candidateDir: string; sequence: number }) => Promise<void> | void;
    debounceMs?: number;
    watch?: typeof fsWatch;
}

export interface WatchHandle {
    reloadFile: string;
    close(): Promise<void>;
}

const STARTUP_CHECK_DELAYS_MS = [250, 1000, 3000];
async function sourceSnapshot(layout: BuildLayout): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    const record = async (file: string) => {
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) snapshot.set(file, `${info.mtimeMs}:${info.ctimeMs}:${info.size}`);
    };
    for (const directory of watchDirectories(layout)) {
        const names = await readdir(directory, { recursive: true }).catch(() => [] as string[]);
        await Promise.all(names.map(name => record(path.join(directory, name))));
    }
    await Promise.all((layout.copyFiles || []).map(([file]) => record(path.resolve(layout.projectRoot || root, file))));
    return snapshot;
}
const sameSnapshot = (left: Map<string, string>, right: Map<string, string>) => left.size === right.size
    && [...left].every(([file, signature]) => right.get(file) === signature);

// Watch mode rebuilds every bundle as one transaction. A shared module can
// feed several bundles. Reloading after an individual bundle finishes
// would expose a mixed runtime tree. The signal file is therefore
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
    firefoxSourceDir,
    beforePublish,
    debounceMs = 80,
    watch = fsWatch,
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
    const signalPath = path.resolve(reloadFile);
    const internalSignal = path.resolve(targetDistDir, RELOAD_SIGNAL);
    if (signalPath !== internalSignal && [targetDistDir, firefoxSourceDir].some(directory =>
        directory && (signalPath === path.resolve(directory) || signalPath.startsWith(path.resolve(directory) + path.sep)),
    )) {
        throw new Error('The development reload signal must be outside the published trees.');
    }
    const stagingRoot = newBuildTreePath(projectRoot);
    const outputDir = path.join(stagingRoot, 'working');
    await cleanupAbandonedBuildTrees({ directory: projectRoot, keep: stagingRoot });
    const manifestSource = copyFiles.find(([, to]) => to === 'manifest.json')?.[0];
    const watchers: FSWatcher[] = [];
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let building: Promise<void> | null = null;
    let pending = false;
    let closed = false;

    // An edit made during the first build, or before the OS has armed the watchers,
    // produces no event. Until they have had time to arm, compare the sources with
    // what the last build started from.
    let publishedSnapshot: Map<string, string> | null = null;
    let checkingStartup = true;
    const startupChecks: ReturnType<typeof setTimeout>[] = [];
    const checkStartupEdits = async (last: boolean) => {
        if (closed || !checkingStartup) return;
        const baseline = publishedSnapshot, current = await sourceSnapshot(layout);
        if (last) checkingStartup = false;
        // A rebuild that re-baselined meanwhile has already covered this comparison.
        if (!closed && baseline && baseline === publishedSnapshot && !sameSnapshot(baseline, current)) requestRebuild();
    };

    const rebuild = async () => {
        const nextSequence = sequence + 1;
        const baseline = await sourceSnapshot(layout);
        if (publishedSnapshot && sameSnapshot(publishedSnapshot, baseline)) return;
        await rm(outputDir, { recursive: true, force: true });
        const { inputPaths, diagnostics } = await buildBundles({ outputDir, entries, projectRoot,
            manifestPath: manifestSource ? path.resolve(projectRoot, manifestSource) : null });
        if (diagnostics) console.warn(diagnostics);
        await writeThirdPartyNotices({ inputPaths, outputDir });
        await copyAssets(outputDir, { ...layout, copyFiles: copyFiles.filter(([, to]) => to !== 'manifest.json') });
        await validateBuildTree(outputDir, { minify: false, ...layout });
        await writeFile(path.join(outputDir, RELOAD_SIGNAL), `${nextSequence}\n`);

        const firefox = firefoxSourceDir && await prepareFirefoxGeneration({
            distDir: outputDir,
            sourceDir: firefoxSourceDir,
            reloadToken: nextSequence,
        });
        let signalStaging: string | undefined;
        try {
            let commitSignal: (() => Promise<void>) | undefined;
            if (signalPath !== internalSignal) {
                signalStaging = await mkdtemp(path.join(path.dirname(signalPath), '.bpb-reload-'));
                const nextSignal = path.join(signalStaging, 'generation');
                await writeFile(nextSignal, `${nextSequence}\n`);
                commitSignal = () => rename(nextSignal, signalPath);
            }
            await beforePublish?.({ candidateDir: outputDir, sequence: nextSequence });
            if (!sameSnapshot(baseline, await sourceSnapshot(layout)) || pending) {
                pending = true;
                return;
            }

            // The stable watched path advances only after both complete trees
            // are installed. A failure before that point rolls both trees back.
            await publishBuildTree({
                candidateDir: outputDir,
                targetDir: targetDistDir,
                afterSwap: firefox && firefoxSourceDir
                    ? () => publishBuildTree({
                        candidateDir: firefox.sourceDir,
                        targetDir: firefoxSourceDir,
                        afterSwap: commitSignal,
                    })
                    : commitSignal,
            });
            publishedSnapshot = baseline;
        } finally {
            await Promise.all([
                firefox && firefox.cleanup(),
                signalStaging && rm(signalStaging, { recursive: true, force: true }),
            ]).catch(error => console.warn('Could not clean development generation staging:', error));
        }
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
                    console.error('Rebuild failed:', error);
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
        do {
            pending = false;
            await rebuild();
        } while (pending);

        for (const directory of watchDirectories(layout)) {
            watchers.push(watch(directory, { recursive: true }, requestRebuild));
        }
        const resolvedRoot = path.resolve(projectRoot);
        const rootFiles = new Set(
            copyFiles
                .map(([file]) => path.resolve(projectRoot, file))
                .filter(file => path.dirname(file) === resolvedRoot)
                .map(file => path.basename(file)),
        );
        if (rootFiles.size > 0) {
            watchers.push(watch(resolvedRoot, (_event, filename) => {
                if (filename && rootFiles.has(filename.toString())) requestRebuild();
            }));
        }
    } catch (error) {
        for (const watcher of watchers) watcher.close();
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
    }

    STARTUP_CHECK_DELAYS_MS.forEach((delay, index, delays) => {
        startupChecks.push(setTimeout(() => void checkStartupEdits(index === delays.length - 1), delay));
    });

    console.log('Watching for changes… (Ctrl+C to stop)');

    return {
        reloadFile,
        async close() {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            startupChecks.forEach(clearTimeout);
            for (const watcher of watchers) watcher.close();
            if (building) await building;
            await rm(stagingRoot, { recursive: true, force: true });
        },
    };
}

const argvEntry = process.argv[1] && path.resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
const isCli = argvEntry && (argvEntry === modulePath || await realpath(argvEntry).catch(() => null) === modulePath);

if (isCli) {
    if (process.argv.length > 3 || [...args].some(arg => arg !== '--minify' && arg !== '--watch')) {
        throw new Error('Usage: node scripts/build.mts [--minify|--watch]');
    }
    const run = WATCH ? () => watchAll() : () => buildOnce();
    run().catch(err => { console.error(err); process.exit(1); });
}
