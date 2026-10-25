// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
    containsCommitBannedIdentifier,
    containsHashedStructuredIdentifier,
    findStagedPrivacyLeaks,
} from '../../scripts/privacy-guard.mjs';

const guard = fileURLToPath(new URL('../../scripts/privacy-guard.mjs', import.meta.url));
const root = path.dirname(path.dirname(guard));
// Public documentation examples, never the operator's private identifiers.
const host = 'private-build.example.test';
const ip = '203.0.113.42';
const hash = value => createHash('sha256').update(`bpb-privacy-v1:${value}`).digest('hex');
const hashes = new Map([host, ip].map(value => [value.length, new Set([hash(value)])]));
const isBanned = value => containsHashedStructuredIdentifier(value, hashes);

test('structured identifiers match whole values in URLs, paths and compound resource names', () => {
    for (const value of [host, ip]) {
        for (const text of [value, value.toUpperCase(), `ssh://operator@${value}:22/work`,
            `https://${value}/tiles`, `prefix-${value}-tiles.json`, `name=${value}/24`]) {
            assert.equal(isBanned(text), true, text);
            assert.equal(isBanned(Buffer.from(text)), true, text);
        }
    }
});

test('individual words, IP octets and larger lookalikes are not banned', () => {
    for (const text of ['private build example test', '203 0 113 42',
        `x${host}`, `${host}x`, `x${ip}`, `${ip}0`, 'build-host', '203.0.113.43']) {
        assert.equal(isBanned(text), false, text);
    }
    assert.equal(containsCommitBannedIdentifier('build-host 203.0.113.42'), false);
    assert.equal(isBanned('part.'.repeat(4000)), false);
});

test('staged contents are inspected even after the working file has been cleaned', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hashed-privacy-'));
    try {
        execFileSync('git', ['init', '--quiet', directory]);
        const file = path.join(directory, 'operator.txt');
        await writeFile(file, `server=${host}\naddress=${ip}\n`);
        execFileSync('git', ['add', '--', 'operator.txt'], { cwd: directory });
        await writeFile(file, 'server=build-host\n');
        assert.deepEqual(findStagedPrivacyLeaks({ cwd: directory, isBanned }),
            [{ kind: 'content', pathname: 'operator.txt' }]);
        execFileSync('git', ['add', '--', 'operator.txt'], { cwd: directory });
        assert.deepEqual(findStagedPrivacyLeaks({ cwd: directory, isBanned }), []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('sensitive staged paths are rejected without returning the private filename', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hashed-privacy-path-'));
    try {
        execFileSync('git', ['init', '--quiet', directory]);
        const filename = `coverage-${host}.json`;
        await writeFile(path.join(directory, filename), '{}');
        execFileSync('git', ['add', '--', filename], { cwd: directory });
        assert.deepEqual(findStagedPrivacyLeaks({ cwd: directory, isBanned }), [{ kind: 'path' }]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('message scanning fails closed on missing files and unknown options', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hashed-privacy-message-'));
    try {
        const message = path.join(directory, 'message.txt');
        await writeFile(message, 'docs: describe the public build-host example\n');
        assert.equal(spawnSync(process.execPath, [guard, '--message-file', message]).status, 0);
        const missing = spawnSync(process.execPath, [guard, '--message-file', message+'-missing']);
        assert.equal(missing.status, 1);
        assert.match(missing.stderr.toString(), /could not complete/);
        assert.equal(spawnSync(process.execPath, [guard, '--skip']).status, 1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('commit-message hook invokes the same hashed privacy guard', async () => {
    const hook = await readFile(path.join(root, '.githooks/commit-msg'), 'utf8');
    assert.match(hook, /scripts\/privacy-guard\.mjs/);
    assert.match(hook, /--message-file "\$1"/);
    execFileSync('test', ['-x', path.join(root, '.githooks/commit-msg')]);
});
