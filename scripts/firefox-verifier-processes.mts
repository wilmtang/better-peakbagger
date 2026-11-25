// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { waitForCondition } from './browser-verification-fixtures.mts';
import { quitWebDriver } from './resource-stack.mts';

export interface FirefoxQuittableDriver {
    quit(): Promise<void>;
}

export interface QuitFirefoxDriverOptions {
    readOwnedPids?: (profileRoot: string) => number[];
    timeoutMs?: number;
}

function errorProperty(error: unknown, key: 'message' | 'code'): unknown {
    return error && typeof error === 'object' && key in error
        ? (error as Record<'message' | 'code', unknown>)[key]
        : undefined;
}

export function ownedFirefoxPids(processList: string | null | undefined, profileRoot: string): number[] {
    const profileMarker = `-profile ${profileRoot}${path.sep}`;
    return String(processList || '')
        .split('\n')
        .flatMap(line => {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            if (!match || !match[2].includes(profileMarker)) return [];
            return [Number(match[1])];
        });
}

export const isRetryableFirefoxStartup = (error: unknown): boolean =>
    /unexpectedly closed with status 0/i.test(String(errorProperty(error, 'message') || ''));

function readOwnedFirefoxPids(profileRoot: string): number[] {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Could not inspect verifier Firefox processes: ${result.stderr.trim() || `ps exited ${result.status}`}`);
    }
    return ownedFirefoxPids(result.stdout, profileRoot);
}

export async function stopOwnedFirefoxProcesses(profileRoot: string): Promise<void> {
    const pids = readOwnedFirefoxPids(profileRoot);
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch (error) {
            if (errorProperty(error, 'code') !== 'ESRCH') throw error;
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

export async function quitFirefoxDriver(
    driver: FirefoxQuittableDriver | null | undefined,
    profileRoot: string,
    {
        readOwnedPids = readOwnedFirefoxPids,
        timeoutMs = 5_000,
    }: QuitFirefoxDriverOptions = {},
): Promise<void> {
    let lostResponse = false;
    try {
        await quitWebDriver(driver);
    } catch (error) {
        // Firefox can exit before Marionette returns the QUIT response. Selenium
        // still kills geckodriver in its finally handler. Accept only this exact
        // teardown error, and only after the owned browser processes are gone.
        // Errors from assertions or other protocol commands retain
        // their original failure; a live browser still fails this bounded wait.
        if (errorProperty(error, 'message') !== 'Failed to decode response from marionette') throw error;
        lostResponse = true;
    }
    // A successful protocol response is not proof of process exit either.
    await waitForCondition(() => readOwnedPids(profileRoot).length === 0, {
        description: `Firefox processes owned by ${profileRoot} to exit after QUIT`,
        intervalMs: 50,
        timeoutMs,
    });
    if (lostResponse) console.warn('Firefox QUIT response was lost; confirmed all verifier-owned browser processes exited.');
}
