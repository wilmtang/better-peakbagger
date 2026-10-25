// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared privacy scanner for fixture tests and repository-local commit hooks.
// Identifiers are salted and hashed so the guard does not publish the
// values it is intended to block.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SALT = 'bpb-privacy-v1';
const TOKEN_PATTERN = /[a-z0-9]+/g;
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;

const hashToken = token =>
    createHash('sha256').update(`${SALT}:${token}`).digest('hex');

// Salted hashes of identifiers unique to the real account: name parts, the
// real climber id, local account names, social handles/ids, and the account's
// own ascent ids. To add an identifier, hash its lower-case alphanumeric token
// with the salt above; never store the plaintext here.
const FIXTURE_BANNED_HASHES = new Set([
    '78d003142abce7051585a991a3acdb87e1dec55937b0b25da13bc6b0b1d1a7d7',
    '5f6b569748331a97dc61d2e980f542adfaf5e79962d66e2fe8344209665c7eab',
    'a6d7a40e1ab361c0ae89d5db64dd766877237bb4467c3f77a52606e036594c43',
    '185059837f13f25091909a431d3e061070f3b25ca172a88e3ac91dc00fad7c0b',
    'edb535d0f4c1a8084395ad443fb5a39e82913b52a02373469e41e116f0517ca2',
    '72bde7b7ce8e4e44bf6625ad102f7bd49cd06af0f443b50ff4d3295af344c0ca',
    '046a89c3581897311e5986721cac8dc72bc2797d0994b7a75bb21fd83e7b7047',
    '10c027b3a245d4bf0c3044d032dfbe6641eb493a5c37c383ce66722e878a59da',
    '18833e56f98704d888a92abdd0d098e6a92c9b2b115fa5a934c6329ea7f7eac1',
    '8ed47ae6ca5fb9c0cb9cbb86b9044c23f113cdd49249ec755c11b4c784023cc5'
]);

// This narrower list is safe to enforce across every staged file. The broader
// fixture list includes identity values that legitimately appear elsewhere in
// repository metadata, so using it here would block unrelated commits.
const COMMIT_BANNED_HASHES = new Set([
    '8ed47ae6ca5fb9c0cb9cbb86b9044c23f113cdd49249ec755c11b4c784023cc5'
]);

// Whole host identifiers, not their common words or individual IP octets.
// Keys bound the candidate lengths; only salted digests belong in this table.
const STRUCTURED_BANNED_HASHES = new Map([
    [7, new Set(['1108891fe52ef7bdf7341279dece54659f809fcf76c905256413ca85a0a5c726'])],
    [12, new Set(['a477ee117ffaa28ab59a87febd7f2acef51f9c9cdcaf2682c30f405e4eb776b4'])],
]);

export const containsHashedStructuredIdentifier = (input, denylist = STRUCTURED_BANNED_HASHES) => {
    const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
    const seen = new Set();
    for (const [chunk] of text.toLowerCase().matchAll(/[a-z0-9]+(?:[.-][a-z0-9]+)+/g)) {
        for (const boundary of chunk.matchAll(/(?:^|[.-])(?=[a-z0-9])/g)) {
            const start = boundary.index + boundary[0].length;
            for (const [length, hashes] of denylist) {
                const end = start + length;
                if (end > chunk.length || /[a-z0-9]/.test(chunk[end] ?? '')) continue;
                const candidate = chunk.slice(start, end);
                if (!/[a-z0-9]$/.test(candidate) || seen.has(candidate)) continue;
                seen.add(candidate);
                if (hashes.has(hashToken(candidate))) return true;
            }
        }
    }
    return false;
};

const containsHashedIdentifier = (input, denylist) => {
    const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
    const tokens = new Set(text.toLowerCase().match(TOKEN_PATTERN) ?? []);
    return [...tokens].some(token => denylist.has(hashToken(token)))
        || containsHashedStructuredIdentifier(text);
};

export const containsFixtureBannedIdentifier = input =>
    containsHashedIdentifier(input, FIXTURE_BANNED_HASHES);

export const containsCommitBannedIdentifier = input =>
    containsHashedIdentifier(input, COMMIT_BANNED_HASHES);

const runGit = (args, cwd) => {
    const result = spawnSync('git', args, {
        cwd,
        encoding: null,
        maxBuffer: MAX_GIT_OUTPUT,
    });
    if (result.error || result.status !== 0) {
        throw new Error('Git privacy scan failed');
    }
    return result.stdout;
};

const stagedPaths = cwd =>
    runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], cwd)
        .toString('utf8')
        .split('\0')
        .filter(Boolean);

const stagedEntry = (pathname, cwd) => {
    const records = runGit([
        '--literal-pathspecs',
        'ls-files',
        '--stage',
        '-z',
        '--',
        pathname
    ], cwd).toString('utf8').split('\0');

    for (const record of records) {
        const separator = record.indexOf('\t');
        if (separator < 0 || record.slice(separator + 1) !== pathname) continue;
        const [mode, oid, stage] = record.slice(0, separator).split(' ');
        if (stage === '0') return { mode, oid };
    }
    throw new Error('Git privacy scan could not read the staged entry');
};

export const findStagedPrivacyLeaks = ({ cwd, isBanned = containsCommitBannedIdentifier } = {}) => {
    const leaks = [];
    for (const pathname of stagedPaths(cwd)) {
        if (isBanned(pathname)) {
            leaks.push({ kind: 'path' });
            continue;
        }

        const { mode, oid } = stagedEntry(pathname, cwd);
        if (mode === '160000') continue;
        if (isBanned(runGit(['cat-file', 'blob', oid], cwd))) {
            leaks.push({ kind: 'content', pathname });
        }
    }
    return leaks;
};

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    try {
        const args = process.argv.slice(2);
        if (args.length) {
            if (args.length !== 2 || args[0] !== '--message-file') throw new Error('Invalid guard arguments');
            if (containsCommitBannedIdentifier(readFileSync(args[1]))) {
                console.error('Commit blocked: message matches the private identifier denylist.');
                process.exitCode = 1;
            }
        } else {
            const leaks = findStagedPrivacyLeaks();
            if (leaks.length > 0) {
                console.error('Commit blocked: staged data matches the private identifier denylist.');
                for (const leak of leaks) {
                    if (leak.kind === 'path') {
                        console.error('- A staged path contains a blocked identifier.');
                    } else {
                        console.error(`- ${JSON.stringify(leak.pathname)} contains a blocked identifier.`);
                    }
                }
                process.exitCode = 1;
            }
        }
    } catch {
        console.error('Commit blocked: the privacy scan could not complete.');
        process.exitCode = 1;
    }
}
