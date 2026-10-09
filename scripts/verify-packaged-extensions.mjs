// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';
import { repeatVerification, verificationRepetitions } from './verification-repetitions.mjs';
import { createResourceStack, manageChildProcess } from './resource-stack.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function packagePaths(args) {
    if (args.length !== 2) {
        throw new Error(
            'Usage: node scripts/verify-packaged-extensions.mjs CHROME.zip FIREFOX.zip',
        );
    }
    return args.map(value => path.resolve(value));
}

async function extractArchive(archivePath, destination) {
    const archive = await JSZip.loadAsync(await readFile(archivePath));
    for (const entry of Object.values(archive.files)) {
        const normalized = path.posix.normalize(entry.name);
        if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
            throw new Error(`Package contains an unsafe path: ${entry.name}`);
        }
        const outputPath = path.join(destination, ...normalized.split('/'));
        if (entry.dir) {
            await mkdir(outputPath, { recursive: true });
            continue;
        }
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, await entry.async('nodebuffer'));
    }
}

async function runVerifier(script, extensionSource) {
    const resources = createResourceStack();
    const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', script)], {
        cwd: projectRoot,
        env: { ...process.env, BPB_VERIFY_EXTENSION_SOURCE: extensionSource },
        stdio: 'inherit',
    });
    manageChildProcess(resources, child, 'package verifier');
    await resources.guard(new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0 && !signal) resolve();
            else reject(new Error(`${script} failed (${signal || `exit ${code}`})`));
        });
    }));
    await resources.dispose();
}

const fingerprints = (files, read = readFile) => Promise.all(files.map(async file =>
    createHash('sha256').update(await read(file)).digest('hex')));

export async function verifyPackageRepetitions({ chromeArchive, firefoxArchive, chromeSource,
    count = verificationRepetitions(), execute = runVerifier, read = readFile, original }) {
    verificationRepetitions(count);
    original ??= await fingerprints([chromeArchive, firefoxArchive], read);
    const requireUnchanged = async () => {
        const current = await fingerprints([chromeArchive, firefoxArchive], read);
        if (current.some((hash, index) => hash !== original[index])) {
            throw new Error('Canonical package bytes changed during repeated verification');
        }
    };
    await repeatVerification(async () => {
        await requireUnchanged();
        await execute('verify-extension.mjs', chromeSource);
        await requireUnchanged();
        await execute('verify-firefox-extension.mjs', firefoxArchive);
        await requireUnchanged();
    }, count);
}

async function main() {
    const [chromeArchive, firefoxArchive] = packagePaths(process.argv.slice(2));
    const count = verificationRepetitions();
    const original = await fingerprints([chromeArchive, firefoxArchive]);
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'better-peakbagger-packages-'));
    const chromeSource = path.join(temporaryRoot, 'chrome');
    try {
        await mkdir(chromeSource);
        await extractArchive(chromeArchive, chromeSource);
        // Firefox's temporary-install endpoint accepts the generated ZIP bytes
        // directly, so this runs the exact archive that will be submitted to AMO.
        await verifyPackageRepetitions({ chromeArchive, firefoxArchive, chromeSource, count, original });
        console.log('Packaged browser extension verification passed:');
        console.log(`  - Chrome archive: ${chromeArchive}`);
        console.log(`  - Firefox archive: ${firefoxArchive}`);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}
