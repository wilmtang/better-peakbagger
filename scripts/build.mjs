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
import { readdir, mkdir, rm, copyFile } from 'node:fs/promises';
import { existsSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { ENTRIES, COPY_FILES, COPY_DIRS, VENDOR_COPY, VENDOR_TZ, nodeModule, entrySources, root, distDir } from './build-config.mjs';

const args = new Set(process.argv.slice(2));
const MINIFY = args.has('--minify');
const WATCH = args.has('--watch');

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
function esbuildOptions(entry) {
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
        minify: MINIFY,
        sourcemap: MINIFY ? false : 'linked',
        logLevel: 'warning',
    };
}

async function buildOnce() {
    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    await Promise.all(ENTRIES.map(e => build(esbuildOptions(e))));
    await copyAssets();
    console.log(`Built ${ENTRIES.length} bundles into dist/${MINIFY ? ' (minified)' : ''}`);
}

async function watchAll() {
    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    const contexts = await Promise.all(ENTRIES.map(e => context(esbuildOptions(e))));
    await Promise.all(contexts.map(c => c.watch()));
    await copyAssets();
    let queued = null;
    const recopy = () => { clearTimeout(queued); queued = setTimeout(() => copyAssets().catch(console.error), 80); };
    for (const dir of ['icons', 'vendor', 'terrain', 'options', 'popup']) {
        if (existsSync(path.join(root, dir))) fsWatch(path.join(root, dir), { recursive: true }, recopy);
    }
    fsWatch(root, (_e, f) => { if (f === 'manifest.json') recopy(); });
    console.log('Watching for changes… (Ctrl+C to stop)');
}

const run = WATCH ? watchAll : buildOnce;
run().catch(err => { console.error(err); process.exit(1); });
