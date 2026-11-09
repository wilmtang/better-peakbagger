// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function packageIdentity(directory: string, version: string, commit: string) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error('Package identity requires an exact release version');
    }
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Package identity requires a full commit SHA');
    const archives: Record<string, string> = {};
    for (const suffix of ['', '-firefox']) {
        const name = `better_peakbagger-${version}${suffix}.zip`;
        archives[name] = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex');
    }
    return { version, commit, archives };
}

export async function writePackageIdentity(directory: string, version: string, commit: string) {
    const identity = await packageIdentity(directory, version, commit);
    await writeFile(path.join(directory, 'package-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
}

export async function verifyPackageIdentity(directory: string, version: string, commit: string, expectedDigest?: string) {
    const actual = await packageIdentity(directory, version, commit);
    const recorded = JSON.parse(await readFile(path.join(directory, 'package-identity.json'), 'utf8'));
    if (recorded.version !== actual.version || recorded.commit !== actual.commit
        || Object.keys(recorded.archives || {}).length !== 2
        || Object.entries(actual.archives).some(([name, hash]) => recorded.archives[name] !== hash)) {
        throw new Error('Package identity does not match the verified version, commit, and archive bytes');
    }
    if (expectedDigest !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(expectedDigest) || packageIdentityDigest(actual) !== expectedDigest) {
            throw new Error('Package identity differs from the independently pinned expected digest');
        }
    }
    return actual;
}

export const packageIdentityDigest = (identity: unknown) => createHash('sha256').update(JSON.stringify(identity)).digest('hex');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [mode, directory, version, commit, expectedDigest, ...extra] = process.argv.slice(2);
    try {
        if (!directory || !version || !commit || extra.length || !['write', 'verify'].includes(mode!) || (mode === 'write' && expectedDigest !== undefined)) {
            throw new Error('Usage: node scripts/release-package-identity.mts write|verify DIRECTORY VERSION COMMIT [EXPECTED_IDENTITY_SHA256]');
        }
        if (mode === 'write') await writePackageIdentity(directory, version, commit);
        else await verifyPackageIdentity(directory, version, commit, expectedDigest);
        console.log(`Package identity ${mode === 'write' ? 'recorded' : 'verified'} for ${version} at ${commit}.`);
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
}
