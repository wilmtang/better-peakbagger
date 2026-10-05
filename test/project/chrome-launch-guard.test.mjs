// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { assertChromeLaunchAllowed } from '../../scripts/chrome-launch-guard.mjs';

test('Chrome preflight refuses macOS Seatbelt before starting a browser', () => {
    assert.throws(() => assertChromeLaunchAllowed({ platform: 'darwin', environment: { CODEX_SANDBOX: 'seatbelt' } }),
        error => error.code === 'BPB_CHROME_SANDBOX' && /outside that sandbox/.test(error.message));
    for (const [platform, environment] of [['darwin', {}], ['linux', { CODEX_SANDBOX: 'seatbelt' }], ['win32', {}]]) {
        assert.doesNotThrow(() => assertChromeLaunchAllowed({ platform, environment }));
    }
});

test('every repository Chrome launcher runs the shared preflight before launching', async () => {
    const directory = new URL('../../scripts/', import.meta.url);
    const launch = /(?:chromium|engine|browserType)\.launch(?:PersistentContext)?\(|spawn\(chromePath,|run\(chrome,/g;
    let checked = 0;
    for (const name of await readdir(directory)) {
        if (!name.endsWith('.mjs')) continue;
        const source = await readFile(new URL(name, directory), 'utf8');
        const sites = [...source.matchAll(launch)];
        if (!sites.length) continue;
        const imports = source.slice(0, source.search(/^(?:const|let|function|async function|export)\b/m));
        assert.match(imports, /import \{ assertChromeLaunchAllowed \} from '\.\/chrome-launch-guard\.mjs';/, name);
        for (const site of sites) {
            assert.match(source.slice(Math.max(0, site.index - 180), site.index), /assertChromeLaunchAllowed\(\);/,
                `${name} must check each launch, including additional browser passes`);
        }
        checked++;
    }
    assert.ok(checked >= 16, `expected all Chrome launchers, found ${checked}`);
});
