// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildProcess } from './resource-stack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function fixturePreflightCommands(args) {
    assert.ok(args.length === 1 && ['--chrome-only', '--firefox-only'].includes(args[0]),
        'Usage: fixture-preflight --chrome-only|--firefox-only');
    return [
        ['--test', 'test/project/formatting-locale-verification.test.mjs', 'test/project/browser-verification-evidence.test.mjs'],
        ['--test', '--test-name-pattern=capture controls reject|privileged extension routes reject', 'test/background/background-capture.test.mjs'],
        ['scripts/verify-layout-stability.mjs', args[0], '--preflight'],
    ];
}

export async function runFixturePreflight(args, execute = runChildProcess) {
    for (const command of fixturePreflightCommands(args)) await execute(process.execPath, command, { cwd: root });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runFixturePreflight(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
