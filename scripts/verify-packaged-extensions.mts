// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';
import { repeatVerification, verificationRepetitions } from './verification-repetitions.mjs';
import { createResourceStack, runChildProcess } from './resource-stack.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export type PackageBrowser = 'chrome' | 'firefox';
type ArchiveReader = (file: string) => Promise<string | Uint8Array>;
type PreparedChrome = { source: string; dispose: () => Promise<void> };
type PackageVerifier = (script: string, extensionSource: string) => Promise<unknown>;
export type PackageVerificationOptions = {
    chromeArchive: string;
    firefoxArchive: string;
    // Existing callers may supply their extraction location. Its parent can host
    // our disposable roots, but caller-owned contents are never removed or reused.
    chromeSource?: string;
    browser?: PackageBrowser;
    count?: number;
    execute?: PackageVerifier;
    read?: ArchiveReader;
    original?: string[];
    prepareChrome?: () => Promise<PreparedChrome>;
};

export function packageArguments(args: string[]) {
    const [chrome, firefox, flag, browser] = args;
    if (![2, 4].includes(args.length) || !chrome || !firefox
        || chrome.startsWith('--') || firefox.startsWith('--')
        || (args.length === 4 && (flag !== '--browser' || !['chrome', 'firefox'].includes(browser!)))) {
        throw new Error('Usage: node scripts/verify-packaged-extensions.mts CHROME.zip FIREFOX.zip [--browser chrome|firefox]');
    }
    return { chromeArchive: path.resolve(chrome), firefoxArchive: path.resolve(firefox),
        ...(browser ? { browser: browser as PackageBrowser } : {}) };
}

export async function extractArchive(archivePath: string, destination: string) {
    const archive = await JSZip.loadAsync(await readFile(archivePath));
    for (const entry of Object.values(archive.files)) {
        // JSZip sanitizes traversal in entry.name. Inspect its original spelling
        // too, otherwise an unsafe entry could silently become a trusted path.
        const original = entry.unsafeOriginalName ?? entry.name;
        const normalized = path.posix.normalize(original);
        if (original.includes('\\') || normalized === '..' || normalized.startsWith('../')
            || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) {
            throw new Error(`Package contains an unsafe path: ${original}`);
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

export async function prepareChromeArchive(archivePath: string, chromeSource?: string): Promise<PreparedChrome> {
    const parent = chromeSource ? path.dirname(path.resolve(chromeSource)) : tmpdir();
    const root = await mkdtemp(path.join(parent, 'better-peakbagger-packages-'));
    try {
        const source = path.join(root, 'chrome');
        await mkdir(source);
        await extractArchive(archivePath, source);
        return { source, dispose: () => rm(root, { recursive: true, force: true }) };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

async function runVerifier(script: string, extensionSource: string) {
    const options = { cwd: projectRoot,
        env: { ...process.env, BPB_VERIFY_EXTENSION_SOURCE: extensionSource }, label: script };
    await runChildProcess(process.execPath, [path.join(projectRoot, 'scripts', script)], options);
}

const fingerprints = (files: string[], read: ArchiveReader = readFile) => Promise.all(files.map(async file =>
    createHash('sha256').update(await read(file)).digest('hex')));

export async function verifyPackageRepetitions({ chromeArchive, firefoxArchive, chromeSource, browser,
    count = verificationRepetitions(), execute = runVerifier, read = readFile, original,
    prepareChrome = () => prepareChromeArchive(chromeArchive, chromeSource) }: PackageVerificationOptions) {
    verificationRepetitions(String(count));
    if (browser !== undefined && !['chrome', 'firefox'].includes(browser)) throw new Error('Unknown package browser');
    original ??= await fingerprints([chromeArchive, firefoxArchive], read);
    if (original.length !== 2 || original.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid package fingerprints');
    const requireUnchanged = async () => {
        const current = await fingerprints([chromeArchive, firefoxArchive], read);
        if (current.some((hash, index) => hash !== original[index])) {
            throw new Error('Canonical package bytes changed during repeated verification');
        }
    };
    await repeatVerification(async () => {
        await requireUnchanged();
        if (browser !== 'firefox') {
            const prepared = await prepareChrome();
            const resources = createResourceStack();
            resources.defer('Chrome package extraction', prepared.dispose);
            await resources.guard(async () => {
                await requireUnchanged();
                await execute('verify-extension.mts', prepared.source);
                await requireUnchanged();
            });
            await resources.dispose();
        }
        if (browser !== 'chrome') {
            // Firefox's temporary-install endpoint consumes the exact ZIP.
            await requireUnchanged();
            await execute('verify-firefox-extension.mts', firefoxArchive);
            await requireUnchanged();
        }
    }, count);
}

async function main() {
    const options = packageArguments(process.argv.slice(2));
    await verifyPackageRepetitions(options);
    console.log(`Packaged ${options.browser ?? 'Chrome and Firefox'} extension verification passed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}
