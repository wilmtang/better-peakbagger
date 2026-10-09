// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack, manageChildProcess } from './resource-stack.mjs';

export function verificationRepetitions(value = process.env.BPB_VERIFY_REPETITIONS ?? '1') {
    if (!/^[1-5]$/.test(String(value))) throw new Error('Verification repetitions must be an integer from 1 to 5');
    return Number(value);
}

export async function repeatVerification(verify, count = verificationRepetitions()) {
    verificationRepetitions(count);
    for (let attempt = 1; attempt <= count; attempt++) {
        console.log(`Verification repetition ${attempt}/${count} started.`);
        await verify(attempt);
        console.log(`Verification repetition ${attempt}/${count} passed, including teardown.`);
    }
}

async function main() {
    const browser = process.argv[2];
    if (process.argv.length !== 3 || !['chrome', 'firefox'].includes(browser)) {
        throw new Error('Usage: verification-repetitions.mjs chrome|firefox');
    }
    if (browser === 'chrome') assertChromeLaunchAllowed();
    const script = browser === 'chrome' ? 'verify-extension.mjs' : 'verify-firefox-extension.mjs';
    await repeatVerification(async () => {
        const resources = createResourceStack();
        const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), script)], {
            stdio: 'inherit', env: process.env,
        });
        manageChildProcess(resources, child, 'repeated browser verifier');
        await resources.guard(new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => code === 0 && !signal
                ? resolve() : reject(new Error(`${script} failed (${signal || `exit ${code}`})`)));
        }));
        await resources.dispose();
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
