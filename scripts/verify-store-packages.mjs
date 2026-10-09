// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFirefoxPackage } from './build-firefox-package.mjs';
import { verifyReleaseArchive } from './verify-release-archive.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack, manageChildProcess } from './resource-stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function run(command, args) {
    const resources = createResourceStack();
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    manageChildProcess(resources, child, command);
    await resources.guard(new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 && !signal
            ? resolve() : reject(new Error(`${command} failed (${signal || `exit ${code}`})`)));
    }));
    await resources.dispose();
}

export async function verifyStorePackages(version, {
    execute = run, read = readFile, write = writeFile,
    deriveFirefox = buildFirefoxPackage, verify = verifyReleaseArchive,
} = {}) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected an exact package version');
    const chrome = `web-ext-artifacts/better_peakbagger-${version}.zip`;
    const firefox = `web-ext-artifacts/better_peakbagger-${version}-firefox.zip`;
    await execute('npm', ['run', 'package']);
    const chromeBytes = await read(chrome);
    await verify(chromeBytes, version, 'chrome');
    const firefoxBytes = await deriveFirefox(chromeBytes);
    await verify(firefoxBytes, version, 'firefox');
    await write(firefox, firefoxBytes);
    await execute(process.execPath, ['scripts/verify-packaged-extensions.mjs', chrome, firefox]);
    return { chrome, firefox };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assertChromeLaunchAllowed();
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    await verifyStorePackages(manifest.version);
}
