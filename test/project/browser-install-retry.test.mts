// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../.github/actions/setup-verification/install-playwright-browser.sh', import.meta.url));

// Runs the real script against recording stubs. `npx` fails until `succeedOn`.
async function run({ succeedOn, runnerOs = 'Linux' }: { succeedOn: number; runnerOs?: string }) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bpb-browser-install-'));
    const calls = path.join(directory, 'calls');
    try {
        const stub = async (name: string, body: string) => {
            await writeFile(path.join(directory, name), `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
            await chmod(path.join(directory, name), 0o755);
        };
        await stub('npx', `count=$(grep -c '^npx ' "${calls}"); [ "$count" -ge ${succeedOn} ]`);
        await stub('sudo', 'exit 0');
        const result = spawnSync('bash', [script, 'firefox'], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, RUNNER_OS: runnerOs },
        });
        return { status: result.status, stdout: result.stdout,
            calls: (await readFile(calls, 'utf8')).trim().split('\n') };
    } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a healthy mirror installs once and leaves apt alone', async () => {
    const { status, calls } = await run({ succeedOn: 1 });
    assert.equal(status, 0);
    assert.deepEqual(calls, ['npx playwright install --with-deps firefox']);
});

test('a stalled install recovers apt and retries once', async () => {
    const { status, calls, stdout } = await run({ succeedOn: 2 });
    assert.equal(status, 0);
    assert.equal(calls.filter(call => call.startsWith('npx ')).length, 2);
    assert.ok(calls.includes('sudo dpkg --configure -a'));
    assert.match(stdout, /::warning title=Browser install retried/);
});

test('a second failure fails the step', async () => {
    const { status, calls } = await run({ succeedOn: 99 });
    assert.notEqual(status, 0);
    assert.equal(calls.filter(call => call.startsWith('npx ')).length, 2);
});

test('other runner systems do not touch apt', async () => {
    const { status, calls } = await run({ succeedOn: 99, runnerOs: 'macOS' });
    assert.notEqual(status, 0);
    assert.deepEqual(calls, ['npx playwright install --with-deps firefox']);
});

test('every browser install in the shared action goes through the retry', async () => {
    const action = await readFile(new URL('../../.github/actions/setup-verification/action.yml', import.meta.url), 'utf8');
    assert.doesNotMatch(action, /npx playwright install/);
    assert.match(action, /install-playwright-browser\.sh" "\$engine"/);
});
