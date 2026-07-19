// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — esbuild bundler.
//
// The extension source lives as ES modules under src/. Browsers cannot load an
// ES module as a classic content script, so every manifest entry point is
// bundled here into a single self-contained IIFE file under dist/. dist/ is the
// unpacked extension: it is what you load, what the release packagers zip, and
// what the real-extension checks exercise.
//
// The bundle composition and asset list live in scripts/build-config.mjs (the
// single source of truth, shared with the test suite). This file only turns
// that config into esbuild calls and copies.
//
// Usage:
//   node scripts/build.mjs            one-off development build (sourcemaps)
//   node scripts/build.mjs --minify   production build (minified, no sourcemap)
//   node scripts/build.mjs --watch    rebuild on source/asset change

import { build, context } from 'esbuild';
import { readdir, mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { existsSync, watch as fsWatch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ENTRIES, COPY_FILES, COPY_DIRS, VENDOR_COPY, VENDOR_TZ, nodeModule, entrySources, root, distDir } from './build-config.mjs';

const args = new Set(process.argv.slice(2));
const MINIFY = args.has('--minify');
const WATCH = args.has('--watch');

export const RELOAD_SIGNAL = '.better-peakbagger-reload';

export function formatReloadLog(sequence, date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    const timestamp = [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    return `[${timestamp}] Rebuilt ${ENTRIES.length} bundles (development reload ${sequence})`;
}

async function copyDir(from, to) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name);
        const d = path.join(to, entry.name);
        if (entry.isDirectory()) await copyDir(s, d);
        else await copyFile(s, d);
    }
}

async function copyAssets() {
    for (const [from, to] of COPY_FILES) {
        const dest = path.join(distDir, to);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(path.join(root, from), dest);
    }
    for (const [from, to] of COPY_DIRS) {
        const source = path.join(root, from);
        if (existsSync(source)) await copyDir(source, path.join(distDir, to));
    }
    // Vendor browser builds come from npm (node_modules), not a committed dir.
    for (const [from, to] of VENDOR_COPY) {
        const dest = path.join(distDir, to);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(nodeModule(from), dest);
    }
    await build({
        entryPoints: [nodeModule(VENDOR_TZ.entry)],
        outfile: path.join(distDir, VENDOR_TZ.out),
        bundle: true,
        format: 'iife',
        globalName: VENDOR_TZ.globalName,
        minify: true,
        legalComments: 'none',
        logLevel: 'warning',
    });
}

// esbuild takes one entry file per output. For a multi-module bundle we feed it
// a generated stub that imports each source in order.
function esbuildOptions(entry, { minify = MINIFY } = {}) {
    const imports = entrySources(entry).map(f => `import ${JSON.stringify(f)};`).join('\n');
    return {
        stdin: {
            contents: imports + '\n',
            resolveDir: root,
            sourcefile: path.join('build-entry', entry.out),
            loader: 'js',
        },
        outfile: path.join(distDir, entry.out),
        bundle: true,
        format: 'iife',
        target: ['chrome110', 'firefox115'],
        platform: 'browser',
        legalComments: 'none',
        minify,
        sourcemap: minify ? false : 'linked',
        logLevel: 'warning',
    };
}

export async function buildOnce({ minify = MINIFY } = {}) {
    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    await Promise.all(ENTRIES.map(e => build(esbuildOptions(e, { minify }))));
    await copyAssets();
    console.log(`Built ${ENTRIES.length} bundles into dist/${minify ? ' (minified)' : ''}`);
}

function watchDirectories() {
    const directories = new Set([
        ...ENTRIES.flatMap(entry => entrySources(entry).map(file => path.dirname(file))),
        ...COPY_FILES
            .map(([file]) => path.dirname(path.join(root, file)))
            .filter(directory => directory !== root),
        ...COPY_DIRS.map(([directory]) => path.join(root, directory)),
    ]);
    return [...directories].filter(existsSync);
}

// Watch mode rebuilds every bundle as one transaction. A shared module can
// feed several independent esbuild contexts; reloading after the first context
// finishes would expose a mixed runtime tree. The signal file is therefore
// written only after every bundle and copied asset has completed successfully.
export async function watchAll({
    reloadFile = path.join(distDir, RELOAD_SIGNAL),
    afterBuild = async () => {},
    debounceMs = 80,
} = {}) {
    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    const contexts = await Promise.all(ENTRIES.map(e => context(esbuildOptions(e, { minify: false }))));
    const watchers = [];
    let sequence = 0;
    let timer = null;
    let building = null;
    let pending = false;
    let closed = false;

    const rebuild = async () => {
        const nextSequence = sequence + 1;
        await Promise.all(contexts.map(buildContext => buildContext.rebuild()));
        await copyAssets();
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

        for (const directory of watchDirectories()) {
            watchers.push(fsWatch(directory, { recursive: true }, requestRebuild));
        }
        const rootFiles = new Set(
            COPY_FILES
                .map(([file]) => path.join(root, file))
                .filter(file => path.dirname(file) === root)
                .map(file => path.basename(file)),
        );
        watchers.push(fsWatch(root, (_event, filename) => {
            if (filename && rootFiles.has(filename)) requestRebuild();
        }));
    } catch (error) {
        await Promise.all(contexts.map(buildContext => buildContext.dispose()));
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
        },
    };
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    const run = WATCH ? watchAll : buildOnce;
    run().catch(err => { console.error(err); process.exit(1); });
}
