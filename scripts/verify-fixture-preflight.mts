// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildProcess } from './resource-stack.mts';

export type PreflightExecutor = (
    command: string,
    args: readonly string[],
    options: { cwd: string },
) => Promise<unknown>;

const root = fileURLToPath(new URL('../', import.meta.url));
export function fixturePreflightCommands(args: readonly string[]): string[][] {
    assert.ok(
        args.length === 1 && ['--chrome-only', '--firefox-only'].includes(args[0]),
        'Usage: fixture-preflight --chrome-only|--firefox-only',
    );
    return [
        ['--test', 'test/project/formatting-locale-verification.test.mts', 'test/project/browser-verification-evidence.test.mts'],
        ['--test', '--test-name-pattern=capture controls reject|privileged extension routes reject', 'test/background/background-capture.test.mts'],
        ['scripts/verify-layout-stability.mts', args[0], '--preflight'],
    ];
}

export async function runFixturePreflight(
    args: readonly string[],
    execute: PreflightExecutor = runChildProcess,
): Promise<void> {
    for (const command of fixturePreflightCommands(args)) await execute(process.execPath, command, { cwd: root });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runFixturePreflight(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
