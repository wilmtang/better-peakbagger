// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFirefoxPackage } from './build-firefox-package.mts';
import { verifyReleaseArchive, type ReleaseBrowser } from './verify-release-archive.mts';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mts';
import { runChildProcess } from './resource-stack.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface VerifyStorePackagesOptions<TBytes = Uint8Array> {
    execute?: (command: string, args: string[]) => Promise<unknown>;
    read?: (filePath: string) => Promise<TBytes>;
    write?: (filePath: string, bytes: TBytes) => Promise<unknown>;
    deriveFirefox?: (sourceBytes: TBytes) => Promise<TBytes>;
    verify?: (archiveBytes: TBytes, expectedVersion: string, browser: ReleaseBrowser) => Promise<unknown>;
}

export async function verifyStorePackages<TBytes = Uint8Array>(
    version: string,
    {
        execute = (command, args) => runChildProcess(command, args, { cwd: root }),
        read = readFile as unknown as (filePath: string) => Promise<TBytes>,
        write = writeFile as unknown as (filePath: string, bytes: TBytes) => Promise<unknown>,
        deriveFirefox = buildFirefoxPackage as unknown as (sourceBytes: TBytes) => Promise<TBytes>,
        verify = verifyReleaseArchive as unknown as (
            archiveBytes: TBytes,
            expectedVersion: string,
            browser: ReleaseBrowser,
        ) => Promise<unknown>,
    }: VerifyStorePackagesOptions<TBytes> = {},
): Promise<{ chrome: string; firefox: string }> {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected an exact package version');
    const chrome = `web-ext-artifacts/better_peakbagger-${version}.zip`;
    const firefox = `web-ext-artifacts/better_peakbagger-${version}-firefox.zip`;
    await execute('npm', ['run', 'package']);
    const chromeBytes = await read(chrome);
    await verify(chromeBytes, version, 'chrome');
    const firefoxBytes = await deriveFirefox(chromeBytes);
    await verify(firefoxBytes, version, 'firefox');
    await write(firefox, firefoxBytes);
    await execute(process.execPath, ['scripts/verify-packaged-extensions.mts', chrome, firefox]);
    return { chrome, firefox };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assertChromeLaunchAllowed();
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as { version: string };
    await verifyStorePackages(manifest.version);
}
