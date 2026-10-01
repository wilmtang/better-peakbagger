// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writePackageIdentity, verifyPackageIdentity } from '../../scripts/release-package-identity.mjs';

const commit = 'a'.repeat(40);
test('package downloads must retain both verified archives and their source identity', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-package-identity-'));
    const chrome = path.join(directory, 'better_peakbagger-3.8.0.zip');
    const firefox = path.join(directory, 'better_peakbagger-3.8.0-firefox.zip');
    try {
        await writeFile(chrome, 'verified Chrome bytes');
        await writeFile(firefox, 'verified Firefox bytes');
        await writePackageIdentity(directory, '3.8.0', commit);
        await verifyPackageIdentity(directory, '3.8.0', commit);
        await assert.rejects(verifyPackageIdentity(directory, '3.8.0', 'b'.repeat(40)), /does not match/);
        await assert.rejects(verifyPackageIdentity(directory, '../private', commit), /exact release version/);
        await assert.rejects(verifyPackageIdentity(directory, '3.8.0', 'main'), /full commit SHA/);
        await writeFile(firefox, 'modified Firefox bytes');
        await assert.rejects(verifyPackageIdentity(directory, '3.8.0', commit), /does not match/);
        await writeFile(firefox, 'verified Firefox bytes');
        const identityPath = path.join(directory, 'package-identity.json');
        const identity = JSON.parse(await readFile(identityPath, 'utf8'));
        identity.version = '3.7.0';
        await writeFile(identityPath, JSON.stringify(identity));
        await assert.rejects(verifyPackageIdentity(directory, '3.8.0', commit), /does not match/);
        await writePackageIdentity(directory, '3.8.0', commit);
        await rm(chrome);
        await assert.rejects(verifyPackageIdentity(directory, '3.8.0', commit), { code: 'ENOENT' });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
