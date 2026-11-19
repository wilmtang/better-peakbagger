// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mts';
import { runChildProcess } from './resource-stack.mts';

export function verificationRepetitions(value: string | number = process.env.BPB_VERIFY_REPETITIONS ?? '1'): number {
    if (!/^[1-5]$/.test(String(value))) throw new Error('Verification repetitions must be an integer from 1 to 5');
    return Number(value);
}

export async function repeatVerification(
    verify: (attempt: number) => unknown | Promise<unknown>,
    count: number = verificationRepetitions(),
): Promise<void> {
    verificationRepetitions(count);
    for (let attempt = 1; attempt <= count; attempt++) {
        console.log(`Verification repetition ${attempt}/${count} started.`);
        await verify(attempt);
        console.log(`Verification repetition ${attempt}/${count} passed, including teardown.`);
    }
}

async function main(): Promise<void> {
    const browser = process.argv[2];
    if (process.argv.length !== 3 || (browser !== 'chrome' && browser !== 'firefox')) {
        throw new Error('Usage: verification-repetitions.mts chrome|firefox');
    }
    if (browser === 'chrome') assertChromeLaunchAllowed();
    const script = browser === 'chrome' ? 'verify-extension.mts' : 'verify-firefox-extension.mts';
    await repeatVerification(() => runChildProcess(process.execPath,
        [path.join(path.dirname(fileURLToPath(import.meta.url)), script)], { label: script }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
