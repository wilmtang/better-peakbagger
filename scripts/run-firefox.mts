import { spawn } from 'node:child_process';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
    type rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createFirefoxManifest, type ExtensionManifest } from './build-firefox-package.mts';
import { publishBuildTree, RELOAD_SIGNAL, type PublishBuildTreeOptions } from './build-publication.mts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, '..');
const defaultDistDir = path.join(defaultProjectRoot, 'dist');

export interface FirefoxSource {
    sourceDir: string;
    cleanup: () => Promise<void>;
}

export interface ValidateFirefoxSourceOptions {
    distDir?: string;
    reloadToken?: number;
}

export interface SyncFirefoxSourceOptions {
    distDir?: string;
    sourceDir: string;
    reloadToken?: number;
    copyTree?: (
        sourceDir: string,
        destinationDir: string,
        options?: { preserve?: Set<string> },
    ) => Promise<void>;
    readText?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
    writeText?: (filePath: string, contents: string) => Promise<void>;
    validateTree?: (
        candidateDir: string,
        options?: ValidateFirefoxSourceOptions,
    ) => Promise<void>;
    publishTree?: (options: PublishBuildTreeOptions) => Promise<void>;
    renameTree?: typeof rename;
    removeTree?: typeof rm;
}

export async function createFirefoxSource(
    { temporaryRoot = tmpdir() }: { temporaryRoot?: string } = {},
): Promise<FirefoxSource> {
    const sourceDir = await mkdtemp(
        path.join(temporaryRoot, 'better-peakbagger-firefox-'),
    );
    return {
        sourceDir,
        cleanup: () => rm(sourceDir, { recursive: true, force: true }),
    };
}

async function mirrorDirectory(
    sourceDir: string,
    destinationDir: string,
    { preserve = new Set<string>() }: { preserve?: Set<string> } = {},
): Promise<void> {
    await mkdir(destinationDir, { recursive: true });
    const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
    const sourceNames = new Set(sourceEntries.map(entry => entry.name));
    for (const destinationEntry of await readdir(destinationDir, { withFileTypes: true })) {
        if (!sourceNames.has(destinationEntry.name) && !preserve.has(destinationEntry.name)) {
            await rm(path.join(destinationDir, destinationEntry.name), {
                recursive: true,
                force: true,
            });
        }
    }
    for (const entry of sourceEntries) {
        if (preserve.has(entry.name)) continue;
        const source = path.join(sourceDir, entry.name);
        const destination = path.join(destinationDir, entry.name);
        if (entry.isDirectory()) {
            await mirrorDirectory(source, destination);
        } else {
            await copyFile(source, destination);
        }
    }
}

const relativeFiles = async (directory: string, prefix = ''): Promise<string[]> => {
    const files: string[] = [];
    for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) files.push(...await relativeFiles(directory, relative));
        else files.push(relative);
    }
    return files.sort();
};

export async function validateFirefoxSource(
    candidateDir: string,
    {
        distDir = defaultDistDir,
        reloadToken,
    }: ValidateFirefoxSourceOptions = {},
): Promise<void> {
    const expectedFiles = (await relativeFiles(distDir))
        .filter(relative => relative !== RELOAD_SIGNAL);
    if (reloadToken !== undefined) expectedFiles.push(RELOAD_SIGNAL);
    expectedFiles.sort();
    const actualFiles = await relativeFiles(candidateDir);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error('Firefox development source does not match the completed build tree.');
    }
    for (const relative of expectedFiles) {
        if (relative === 'manifest.json' || relative === RELOAD_SIGNAL) continue;
        const [source, candidate] = await Promise.all([
            readFile(path.join(distDir, relative)),
            readFile(path.join(candidateDir, relative)),
        ]);
        if (!source.equals(candidate)) {
            throw new Error(`Firefox development source differs from dist: ${relative}`);
        }
    }

    const sourceManifest = JSON.parse(
        await readFile(path.join(distDir, 'manifest.json'), 'utf8'),
    ) as ExtensionManifest;
    const candidateManifest = JSON.parse(
        await readFile(path.join(candidateDir, 'manifest.json'), 'utf8'),
    ) as ExtensionManifest;
    if (JSON.stringify(candidateManifest) !== JSON.stringify(createFirefoxManifest(sourceManifest))) {
        throw new Error('Firefox development manifest does not match its source generation.');
    }
    if (reloadToken !== undefined) {
        const token = await readFile(path.join(candidateDir, RELOAD_SIGNAL), 'utf8');
        if (token !== `${reloadToken}\n`) {
            throw new Error('Firefox development reload token does not match its source generation.');
        }
    }
}

// Firefox needs its own manifest for inline Preferences and background scripts.
export async function prepareFirefoxGeneration({
    distDir = defaultDistDir,
    sourceDir,
    reloadToken,
    copyTree = mirrorDirectory,
    readText = readFile,
    writeText = writeFile,
    validateTree = validateFirefoxSource,
    removeTree = rm,
}: SyncFirefoxSourceOptions): Promise<FirefoxSource> {
    if (!sourceDir) throw new Error('Firefox development source directory is required.');
    const stagingRoot = await mkdtemp(
        path.join(path.dirname(sourceDir), '.better-peakbagger-firefox-generation-'),
    );
    const candidateDir = path.join(stagingRoot, 'generation');
    const cleanup = () => removeTree(stagingRoot, { recursive: true, force: true });
    try {
        await mkdir(candidateDir, { recursive: true });
        await copyTree(distDir, candidateDir, {
            preserve: new Set([RELOAD_SIGNAL]),
        });
        const manifest = createFirefoxManifest(
            JSON.parse(await readText(path.join(distDir, 'manifest.json'), 'utf8')) as ExtensionManifest,
        );
        await writeText(
            path.join(candidateDir, 'manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`,
        );
        if (reloadToken !== undefined) {
            await writeText(path.join(candidateDir, RELOAD_SIGNAL), `${reloadToken}\n`);
        }
        await validateTree(candidateDir, { distDir, reloadToken });
        return { sourceDir: candidateDir, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

export async function syncFirefoxSource(options: SyncFirefoxSourceOptions): Promise<void> {
    const { sourceDir, publishTree = publishBuildTree, renameTree } = options;
    const candidate = await prepareFirefoxGeneration(options);
    try {
        await publishTree({ candidateDir: candidate.sourceDir, targetDir: sourceDir, renameTree });
    } finally {
        await candidate.cleanup();
    }
}

// The Firefox dev source is the built extension (dist/) with only its manifest
// overridden with Firefox-specific fields. Run `npm run build` first.
export async function prepareFirefoxSource({
    distDir = defaultDistDir,
    temporaryRoot = tmpdir(),
}: { distDir?: string; temporaryRoot?: string } = {}): Promise<FirefoxSource> {
    const prepared = await createFirefoxSource({ temporaryRoot });

    try {
        await syncFirefoxSource({ distDir, sourceDir: prepared.sourceDir });
    } catch (error) {
        await prepared.cleanup();
        throw error;
    }

    return prepared;
}

async function main(): Promise<void> {
    const { sourceDir, cleanup } = await prepareFirefoxSource();
    const executable = process.platform === 'win32' ? 'web-ext.cmd' : 'web-ext';
    const child = spawn(
        executable,
        ['run', '--source-dir', sourceDir, ...process.argv.slice(2)],
        { cwd: defaultProjectRoot, stdio: 'inherit' },
    );

    const forwardSignal = (signal: NodeJS.Signals) => {
        if (!child.killed) child.kill(signal);
    };
    const forwardInterrupt = () => forwardSignal('SIGINT');
    const forwardTerminate = () => forwardSignal('SIGTERM');
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTerminate);

    try {
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        if (result.signal) {
            process.exitCode = 1;
        } else {
            process.exitCode = result.code ?? 1;
        }
    } finally {
        process.off('SIGINT', forwardInterrupt);
        process.off('SIGTERM', forwardTerminate);
        await cleanup();
    }
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
