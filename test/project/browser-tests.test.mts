// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { projectRoot } from '../../scripts/browser-verification-fixtures.mts';
import { bundleBrowserTest, findBrowserTests } from '../../scripts/browser-tests.mts';

const scratch = async (t: test.TestContext) => {
    // Inside the checkout so bundling resolves the same runtimes and imports.
    const directory = await mkdtemp(path.join(projectRoot, 'test', '.browser-tests-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
};
const relative = (file: string) => path.relative(projectRoot, file).split(path.sep).join('/');

test('browser tests are discovered by suffix with their declared fixture origin', async t => {
    const directory = await scratch(t);
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'nested', 'a.browser.mts'), '// @browser-origin https://www.strava.com\n');
    await writeFile(path.join(directory, 'b.browser.mts'), '');
    await writeFile(path.join(directory, 'c.test.mts'), '');
    await writeFile(path.join(directory, 'd.scale.browser.mts'), '');
    assert.deepEqual(await findBrowserTests(directory), [
        { file: relative(path.join(directory, 'b.browser.mts')), origin: 'https://www.peakbagger.com' },
        { file: relative(path.join(directory, 'nested', 'a.browser.mts')), origin: 'https://www.strava.com' },
    ], 'production-scale files stay out of the default run');
    assert.deepEqual(await findBrowserTests(directory, { scale: true }), [
        { file: relative(path.join(directory, 'd.scale.browser.mts')), origin: 'https://www.peakbagger.com' },
    ]);
});

test('bundling maps the node: modules browser tests use and refuses others and jsdom', async t => {
    const directory = await scratch(t);
    const good = path.join(directory, 'good.browser.mts');
    await writeFile(good, "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
        + "import { readFile } from 'node:fs/promises';\nimport path from 'node:path';\n"
        + "test('x', async () => { assert.equal(path.basename(import.meta.url), 'good.browser.mts'); await readFile('/x'); });\n");
    const script = await bundleBrowserTest(relative(good));
    assert.match(script, /__bpbRunBrowserTests/);
    assert.match(script, /good\.browser\.mts/, 'import.meta.url names the test file');
    for (const [name, source] of [['jsdom', "import { JSDOM } from 'jsdom';\nvoid JSDOM;\n"],
        ['child-process', "import { spawn } from 'node:child_process';\nvoid spawn;\n"]]) {
        const file = path.join(directory, `${name}.browser.mts`);
        await writeFile(file, source!);
        await assert.rejects(bundleBrowserTest(relative(file)), /not available to browser tests/);
    }
});
