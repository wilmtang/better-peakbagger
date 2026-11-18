// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { assertChromeLaunchAllowed } from '../../scripts/chrome-launch-guard.mjs';

test('Chrome preflight refuses macOS Seatbelt before starting a browser', () => {
    assert.throws(() => assertChromeLaunchAllowed({ platform: 'darwin', environment: { CODEX_SANDBOX: 'seatbelt' } }),
        (error: Error & { code?: string }) => error.code === 'BPB_CHROME_SANDBOX' && /outside that sandbox/.test(error.message));
    for (const [platform, environment] of [['darwin', {}], ['linux', { CODEX_SANDBOX: 'seatbelt' }], ['win32', {}]] as const) {
        assert.doesNotThrow(() => assertChromeLaunchAllowed({ platform, environment }));
    }
});

test('direct fixture Chrome launches isolate profiles and avoid the login keychain', async () => {
    const directory = new URL('../../scripts/', import.meta.url);
    let checked = 0;
    for (const name of await readdir(directory)) {
        if (!name.endsWith('.mjs')) continue;
        const source = await readFile(new URL(name, directory), 'utf8');
        for (const match of source.matchAll(/(?:spawn\(chromePath,|run\(chrome,)\s*\[([\s\S]*?)\n\s*\]/g)) {
            assert.ok(match[1].includes('--use-mock-keychain'), `${name} must avoid macOS keychain prompts`);
            assert.ok(match[1].includes('--password-store=basic'), `${name} must use disposable password storage`);
            assert.ok(match[1].includes('--user-data-dir='), `${name} must isolate its browser profile`);
            checked++;
        }
    }
    assert.ok(checked > 0, 'no direct Chrome launch was checked');
});

test('every repository Chrome launcher runs the shared preflight before launching', async () => {
    const directory = new URL('../../scripts/', import.meta.url);
    const launch = /(?:chromium|engine|browserType)\.launch(?:PersistentContext)?\(|spawn\(chromePath,|run\(chrome,/g;
    let direct = 0, shared = 0;
    for (const name of await readdir(directory)) {
        if (!/\.m[jt]s$/.test(name)) continue;
        const source = await readFile(new URL(name, directory), 'utf8');
        const sites = [...source.matchAll(launch)];
        // The shared launcher owns the preflight; its own test pins that.
        if (/launchVerificationChrome\(/.test(source)) shared++;
        if (!sites.length) continue;
        const imports = source.slice(0, source.search(/^(?:const|let|function|async function|export)\b/m));
        assert.match(imports, /import \{ assertChromeLaunchAllowed \} from '\.\/chrome-launch-guard\.mjs';/, name);
        for (const site of sites) {
            assert.match(source.slice(Math.max(0, site.index - 180), site.index), /assertChromeLaunchAllowed\(\);/,
                `${name} must check each launch, including additional browser passes`);
        }
        direct++;
    }
    // Floors at today's counts, so losing a launcher or a whole file is noticed.
    assert.ok(direct >= 14, `expected the direct Chrome launchers, found ${direct}`);
    assert.ok(shared >= 44, `expected the shared-launcher verifiers, found ${shared}`);
});
