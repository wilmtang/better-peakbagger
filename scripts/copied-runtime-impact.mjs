// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COPIED_RUNTIME_PACKAGES = Object.freeze([
    'chart.js',
    'maplibre-gl',
    'marked',
]);

export function copiedRuntimeVersions(packageLock) {
    if (!packageLock || typeof packageLock.packages !== 'object') {
        throw new Error('package-lock.json has no packages inventory');
    }
    return Object.fromEntries(COPIED_RUNTIME_PACKAGES.map((packageName) => [
        packageName,
        packageLock.packages[`node_modules/${packageName}`]?.version || null,
    ]));
}

export function copiedRuntimeChanged(basePackageLock, currentPackageLock) {
    const base = copiedRuntimeVersions(basePackageLock);
    const current = copiedRuntimeVersions(currentPackageLock);
    return COPIED_RUNTIME_PACKAGES.some(packageName => base[packageName] !== current[packageName]);
}

// Keep the existing workflow output stable, but also validate the harness and
// browser that prove copied-runtime safety. Otherwise a broken fixture can sit
// unnoticed until the next MapLibre update is blocked by its first GPU run.
export function terrainVerificationRequired(basePackageLock, currentPackageLock, changedPaths = []) {
    if (copiedRuntimeChanged(basePackageLock, currentPackageLock)) return true;
    if (['playwright', 'playwright-core'].some(name =>
        basePackageLock.packages[`node_modules/${name}`]?.version
        !== currentPackageLock.packages[`node_modules/${name}`]?.version)) return true;
    return changedPaths.some(file => file.startsWith('src/') || file.startsWith('scripts/')
        || file === 'manifest.json' || file === '.github/workflows/test.yml');
}

function pathsChangedSince(revision) {
    const result = spawnSync('git', ['diff', '--name-only', '-z', revision, 'HEAD', '--'], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`could not compare verification inputs: ${result.stderr.trim()}`);
    return result.stdout.split('\0').filter(Boolean);
}

function packageLockAtRevision(revision) {
    const result = spawnSync('git', ['show', `${revision}:package-lock.json`], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `could not read package-lock.json at ${revision}: ${result.stderr.trim() || `exit ${result.status}`}`,
        );
    }
    return JSON.parse(result.stdout);
}

async function main() {
    const baseRevision = process.argv[2];
    if (!baseRevision) {
        throw new Error('Usage: node scripts/copied-runtime-impact.mjs BASE_REVISION');
    }
    const current = JSON.parse(await readFile('package-lock.json', 'utf8'));
    const isInitialRevision = /^0+$/.test(baseRevision);
    const changed = isInitialRevision
        || terrainVerificationRequired(packageLockAtRevision(baseRevision), current, pathsChangedSince(baseRevision));
    const versions = copiedRuntimeVersions(current);
    console.log(`Terrain verification ${changed ? 'required' : 'not required'}; copied runtime: ${JSON.stringify(versions)}`);

    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
    await appendFile(outputPath, `copied-runtime=${changed}\n`);
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
