import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';

import {
    COPY_DIRS,
    COPY_FILES,
    ENTRIES,
    GENERATED_FILES,
    VENDOR_COPY,
    root,
} from './build-config.mjs';

const OPTIONS_PRESENTATION = {
    firefox: false,
    chrome: true,
};

async function copiedDirectoryFiles(sourceDirectory, targetDirectory) {
    const files = [];
    const visit = async (source, target) => {
        for (const entry of await readdir(source, { withFileTypes: true })) {
            const sourcePath = path.join(source, entry.name);
            const targetPath = path.posix.join(target, entry.name);
            if (entry.isDirectory()) await visit(sourcePath, targetPath);
            else files.push(targetPath);
        }
    };
    await visit(path.join(root, sourceDirectory), targetDirectory);
    return files;
}

export async function expectedReleaseFiles() {
    const copiedDirectories = await Promise.all(
        COPY_DIRS.map(([source, target]) => copiedDirectoryFiles(source, target)),
    );
    return [...new Set([
        ...ENTRIES.map(({ out }) => out),
        ...COPY_FILES.map(([, to]) => to),
        ...VENDOR_COPY.map(([, to]) => to),
        ...GENERATED_FILES,
        ...copiedDirectories.flat(),
    ])].sort();
}

function decodeZipName(bytes) {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function readRawArchiveEntries(archiveBytes) {
    const bytes = Buffer.from(archiveBytes);
    const minimumOffset = Math.max(0, bytes.length - 65_557);
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
        if (
            bytes.readUInt32LE(offset) === 0x06054b50
            && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
        ) {
            endOffset = offset;
            break;
        }
    }
    if (endOffset === -1) throw new Error('Release archive has no ZIP central directory.');

    if (bytes.readUInt16LE(endOffset + 4) !== 0 || bytes.readUInt16LE(endOffset + 6) !== 0) {
        throw new Error('Multi-disk release archives are not supported.');
    }
    const diskEntryCount = bytes.readUInt16LE(endOffset + 8);
    const entryCount = bytes.readUInt16LE(endOffset + 10);
    if (entryCount === 0xffff || diskEntryCount === 0xffff) {
        throw new Error('ZIP64 release archives are not supported.');
    }
    if (diskEntryCount !== entryCount) {
        throw new Error('Release archive central-directory entry counts disagree.');
    }
    const centralSize = bytes.readUInt32LE(endOffset + 12);
    const centralOffset = bytes.readUInt32LE(endOffset + 16);
    if (centralOffset + centralSize !== endOffset) {
        throw new Error('Release archive central-directory bounds are invalid.');
    }
    let offset = centralOffset;
    const entries = [];
    const localOffsets = new Set();
    for (let index = 0; index < entryCount; index += 1) {
        if (bytes.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error(`Release archive has an invalid central-directory entry at index ${index}.`);
        }
        const nameLength = bytes.readUInt16LE(offset + 28);
        const extraLength = bytes.readUInt16LE(offset + 30);
        const commentLength = bytes.readUInt16LE(offset + 32);
        const externalAttributes = bytes.readUInt32LE(offset + 38);
        const localOffset = bytes.readUInt32LE(offset + 42);
        const name = decodeZipName(bytes.subarray(offset + 46, offset + 46 + nameLength));

        if (localOffsets.has(localOffset)) {
            throw new Error(`Release archive reuses a local ZIP header at ${name}.`);
        }
        localOffsets.add(localOffset);
        if (bytes.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(`Release archive has an invalid local ZIP header for ${name}.`);
        }
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localName = decodeZipName(bytes.subarray(
            localOffset + 30,
            localOffset + 30 + localNameLength,
        ));
        if (localName !== name) {
            throw new Error(`Release archive has conflicting local and central paths for ${name}.`);
        }
        const unixMode = (externalAttributes >>> 16) & 0o170000;
        const dosDirectory = (externalAttributes & 0x10) !== 0;
        const directory = name.endsWith('/') || unixMode === 0o040000 || dosDirectory;
        if (directory && !name.endsWith('/')) {
            throw new Error(`Release archive has a non-canonical directory entry: ${name}`);
        }
        entries.push({ name, directory });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    if (offset !== centralOffset + centralSize) {
        throw new Error('Release archive central-directory size is inconsistent.');
    }
    return entries;
}

function canonicalArchivePath(name, directory) {
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/')) {
        throw new Error(`Release archive contains a non-canonical path: ${name}`);
    }
    const withoutSlash = directory ? name.slice(0, -1) : name;
    const normalized = path.posix.normalize(withoutSlash);
    if (
        normalized !== withoutSlash
        || normalized === '.'
        || normalized === '..'
        || normalized.startsWith('../')
    ) {
        throw new Error(`Release archive contains a non-canonical path: ${name}`);
    }
    if (
        normalized === '.DS_Store'
        || normalized.includes('/.DS_Store')
        || normalized === '__MACOSX'
        || normalized.startsWith('__MACOSX/')
    ) {
        throw new Error(`Release archive contains platform metadata: ${name}`);
    }
    return normalized;
}

export function validateArchiveEntries(entries, expectedFiles) {
    const expected = new Set(expectedFiles);
    const expectedDirectories = new Set();
    for (const file of expected) {
        let parent = path.posix.dirname(file);
        while (parent !== '.') {
            expectedDirectories.add(parent);
            parent = path.posix.dirname(parent);
        }
    }

    const seenEntries = new Set();
    const files = new Set();
    const directories = new Set();
    for (const entry of entries) {
        const normalized = canonicalArchivePath(entry.name, entry.directory);
        const entryKey = `${entry.directory ? 'directory' : 'file'}:${normalized}`;
        if (seenEntries.has(entryKey)) {
            throw new Error(`Release archive contains a duplicate path: ${entry.name}`);
        }
        seenEntries.add(entryKey);
        if (entry.directory) directories.add(normalized);
        else files.add(normalized);
    }

    for (const directory of directories) {
        if (files.has(directory)) {
            throw new Error(`Release archive contains a file/directory conflict: ${directory}`);
        }
        if (!expectedDirectories.has(directory)) {
            throw new Error(`Release archive contains an unexpected directory: ${directory}/`);
        }
    }
    for (const file of files) {
        let parent = path.posix.dirname(file);
        while (parent !== '.') {
            if (files.has(parent)) {
                throw new Error(`Release archive contains a file/directory conflict: ${parent}`);
            }
            parent = path.posix.dirname(parent);
        }
    }
    for (const file of files) {
        if (!expected.has(file)) {
            throw new Error(`Release archive contains unexpected file: ${file}`);
        }
    }
    for (const required of expected) {
        if (!files.has(required)) {
            throw new Error(`Release archive is missing required file: ${required}`);
        }
    }
    return [...files].sort();
}

export async function verifyReleaseArchive(archiveBytes, expectedVersion, browser) {
    const expectedFiles = await expectedReleaseFiles();
    const rawEntries = readRawArchiveEntries(archiveBytes);
    const entries = validateArchiveEntries(rawEntries, expectedFiles);
    const archive = await JSZip.loadAsync(archiveBytes);

    const archivedManifest = JSON.parse(
        await archive.file('manifest.json').async('string'),
    );
    if (archivedManifest.version !== expectedVersion) {
        throw new Error(
            `Archived manifest version ${JSON.stringify(archivedManifest.version)} does not match ${JSON.stringify(expectedVersion)}`,
        );
    }

    if (browser !== undefined) {
        if (!Object.hasOwn(OPTIONS_PRESENTATION, browser)) {
            throw new Error(`Unknown release browser: ${browser}`);
        }
        const expectedOpenInTab = OPTIONS_PRESENTATION[browser];
        if (archivedManifest.options_ui?.open_in_tab !== expectedOpenInTab) {
            const presentation = expectedOpenInTab ? 'a full tab' : 'the add-on manager';
            throw new Error(
                `${browser} release options must open in ${presentation}`,
            );
        }
    }

    return entries;
}

export function requireArchiveArguments(args) {
    if (
        args.length !== 2
    || !Object.hasOwn(OPTIONS_PRESENTATION, args[1])
    ) {
        throw new Error(
            'Usage: node scripts/verify-release-archive.mjs ARCHIVE_PATH firefox|chrome',
        );
    }
    return { archivePath: args[0], browser: args[1] };
}

async function main() {
    const { archivePath, browser } = requireArchiveArguments(process.argv.slice(2));

    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    const entries = await verifyReleaseArchive(
        await readFile(archivePath),
        packageJson.version,
        browser,
    );
    console.log(`Verified ${browser} package ${archivePath} (${entries.length} archive entries).`);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
