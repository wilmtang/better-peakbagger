// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { waitForCondition } from './browser-verification-fixtures.mjs';

export function ownedFirefoxPids(processList, profileRoot) {
    const profileMarker = `-profile ${profileRoot}${path.sep}`;
    return String(processList || '')
        .split('\n')
        .flatMap(line => {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            if (!match || !match[2].includes(profileMarker)) return [];
            return [Number(match[1])];
        });
}

export const isRetryableFirefoxStartup = error =>
    /unexpectedly closed with status 0/i.test(String(error?.message || ''));

function readOwnedFirefoxPids(profileRoot) {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Could not inspect verifier Firefox processes: ${result.stderr.trim() || `ps exited ${result.status}`}`);
    }
    return ownedFirefoxPids(result.stdout, profileRoot);
}

export async function stopOwnedFirefoxProcesses(profileRoot) {
    const pids = readOwnedFirefoxPids(profileRoot);
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch (error) {
            if (error.code !== 'ESRCH') throw error;
        }
    }
    if (!pids.length) return;
    await waitForCondition(
        () => readOwnedFirefoxPids(profileRoot).length === 0,
        {
            description: `Firefox processes owned by ${profileRoot} to stop`,
            intervalMs: 50,
            timeoutMs: 5_000,
        },
    );
}
