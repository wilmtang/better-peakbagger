// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import FirefoxProfile from 'firefox-profile';
import { installExtension } from '../../node_modules/web-ext/lib/firefox/index.js';

// Exercise the installed tool, not a copy of its implementation. The accepted
// adm-zip flaw is in firefox-profile's extractor, which web-ext must not use.
test('web-ext installs XPIs and proxy directories without firefox-profile extraction', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bpb-web-ext-install-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const method of ['addExtension', 'addExtensions', '_installExtension']) {
        t.mock.method(FirefoxProfile.prototype, method, () => {
            assert.fail(`web-ext reached the unaccepted extraction API: ${method}`);
        });
    }
    const profile = Object.create(FirefoxProfile.prototype);
    profile.extensionsDir = path.join(root, 'extensions');
    const extensionPath = path.join(root, 'fixture.xpi');
    // Opaque bytes ensure the installer copies the file without ZIP parsing.
    const content = Buffer.from('opaque test XPI');
    await writeFile(extensionPath, content);
    const manifestData = { browser_specific_settings: { gecko: { id: 'fixture@example.test' } } };
    await installExtension({ manifestData, profile, extensionPath });
    assert.deepEqual(await readFile(path.join(profile.extensionsDir, 'fixture@example.test.xpi')), content);

    const sourceDir = path.join(root, 'source');
    await mkdir(sourceDir);
    await installExtension({ manifestData, profile, extensionPath: sourceDir, asProxy: true });
    assert.equal(await readFile(path.join(profile.extensionsDir, 'fixture@example.test'), 'utf8'), sourceDir);
});
