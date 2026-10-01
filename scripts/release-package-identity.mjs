// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function packageIdentity(directory, version, commit) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error('Package identity requires an exact release version');
    }
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Package identity requires a full commit SHA');
    const archives = {};
    for (const suffix of ['', '-firefox']) {
        const name = `better_peakbagger-${version}${suffix}.zip`;
        archives[name] = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex');
    }
    return { version, commit, archives };
}

export async function writePackageIdentity(directory, version, commit) {
    const identity = await packageIdentity(directory, version, commit);
    await writeFile(path.join(directory, 'package-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
}

export async function verifyPackageIdentity(directory, version, commit) {
    const actual = await packageIdentity(directory, version, commit);
    const recorded = JSON.parse(await readFile(path.join(directory, 'package-identity.json'), 'utf8'));
    if (recorded.version !== actual.version || recorded.commit !== actual.commit
        || Object.keys(recorded.archives || {}).length !== 2
        || Object.entries(actual.archives).some(([name, hash]) => recorded.archives[name] !== hash)) {
        throw new Error('Package identity does not match the verified version, commit, and archive bytes');
    }
    return actual;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [mode, directory, version, commit, ...extra] = process.argv.slice(2);
    try {
        if (!directory || extra.length || !['write', 'verify'].includes(mode)) {
            throw new Error('Usage: node scripts/release-package-identity.mjs write|verify DIRECTORY VERSION COMMIT');
        }
        await (mode === 'write' ? writePackageIdentity : verifyPackageIdentity)(directory, version, commit);
        console.log(`Package identity ${mode === 'write' ? 'recorded' : 'verified'} for ${version} at ${commit}.`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
