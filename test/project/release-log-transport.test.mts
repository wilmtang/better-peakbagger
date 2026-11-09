// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the actual process boundary without a token or network. The raw API
// endpoint fails as modern gh does; only the job-specific log command succeeds.
test('release evidence reads host-pinned job logs through the supported CLI and preserves proof parsing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bpb-release-log-test-'));
    try {
        const argsFile = path.join(root, 'args');
        const gh = path.join(root, 'gh');
        await writeFile(gh, `#!/bin/sh
printf '%s\\n' "$@" > "$BPB_LOG_ARGS"
if [ "$1" = api ]; then
  printf '%s\\n' 'the response contains terminal escape sequences' >&2
  exit 1
fi
if [ "$BPB_LOG_FAILURE" = yes ]; then exit 17; fi
printf 'packaged chrome\\tExecute\\t2026-11-09T00:00:00Z \\033[36mRun verifier\\033[0m\\n'
for n in 1 2 3; do
  printf 'packaged chrome\\tExecute\\t2026-11-09T00:00:00Z Verification repetition %s/3 started.\\n' "$n"
  printf 'packaged chrome\\tExecute\\t2026-11-09T00:00:01Z Verification repetition %s/3 passed, including teardown.\\n' "$n"
done
`);
        await chmod(gh, 0o755);
        const evidence = new URL('../../scripts/release-evidence.mts', import.meta.url).href;
        const preflight = new URL('../../scripts/release-preflight.mts', import.meta.url).href;
        const code = `import {evidenceDependencies} from ${JSON.stringify(evidence)}; import {validateConsecutivePasses} from ${JSON.stringify(preflight)}; const log=await evidenceDependencies.log(123); console.log(validateConsecutivePasses(log,'packaged chrome'));`;
        const run = (failure = '') => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            encoding: 'utf8', timeout: 10_000,
            env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', PATH: `${root}:${process.env.PATH}`, BPB_LOG_ARGS: argsFile, BPB_LOG_FAILURE: failure },
        });
        const success = run(); assert.equal(success.status, 0, success.stderr); assert.equal(success.stdout.trim(), '3');
        assert.deepEqual((await readFile(argsFile, 'utf8')).trim().split('\n'),
            ['run', 'view', '--job', '123', '--repo', 'github.com/wilmtang/better-peakbagger', '--log']);
        const failed = run('yes'); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /Command failed/);
        // Job identity cannot become another CLI flag, even at this direct API.
        const invalid = spawnSync(process.execPath, ['--input-type=module', '-e',
            `import {evidenceDependencies} from ${JSON.stringify(evidence)}; await evidenceDependencies.log('--repo');`],
        { encoding: 'utf8', timeout: 10_000, env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', PATH: `${root}:${process.env.PATH}` } });
        assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /positive run\/artifact ID/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
