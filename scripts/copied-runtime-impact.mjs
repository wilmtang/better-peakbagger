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
        || copiedRuntimeChanged(packageLockAtRevision(baseRevision), current);
    const versions = copiedRuntimeVersions(current);
    console.log(`Copied runtime ${changed ? 'changed' : 'unchanged'}: ${JSON.stringify(versions)}`);

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
