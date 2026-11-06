// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { AUTHORED_SOURCE_ROOTS } from '../../scripts/build-config.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const compiler = path.join(root, 'node_modules/typescript/bin/tsc');

test('strict browser checking covers the authored roots without changing build configuration', async () => {
    const config = JSON.parse(await readFile(path.join(root, 'tsconfig.check.json'), 'utf8'));
    assert.deepEqual([...config.include].sort(), [...AUTHORED_SOURCE_ROOTS].sort());
    assert.equal(config.compilerOptions.checkJs, false);
    assert.equal(config.compilerOptions.strict, true);
    assert.equal(config.compilerOptions.erasableSyntaxOnly, true);
    await assert.rejects(readFile(path.join(root, 'tsconfig.json')), { code: 'ENOENT' });
});

test('the actual compiler accepts mixed imports and rejects type errors and undeclared names', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-typescript-check-'));
    try {
        const file = path.join(directory, 'feature.ts');
        const config = path.join(directory, 'tsconfig.json');
        await writeFile(config, JSON.stringify({
            extends: path.join(root, 'tsconfig.check.json'),
            compilerOptions: { typeRoots: [path.join(root, 'node_modules/@types')] },
            include: [file],
        }));
        await writeFile(file, `import { units } from ${JSON.stringify(path.join(root, 'src/ui/units.js'))};
export const distance: string = units.formatDistance(1000, 'metric');
export const page: Document = document;
export const api: typeof chrome = browser;
`);
        const valid = spawnSync(process.execPath, [compiler, '--project', config, '--pretty', 'false'],
            { encoding: 'utf8', timeout: 30_000 });
        assert.equal(valid.status, 0, valid.stdout + valid.stderr);

        await writeFile(file, 'export const distance: number = "wrong";\nnotDeclared();\n');
        const invalid = spawnSync(process.execPath, [compiler, '--project', config, '--pretty', 'false'],
            { encoding: 'utf8', timeout: 30_000 });
        assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
        assert.match(invalid.stdout, /TS2322/);
        assert.match(invalid.stdout, /TS2304/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('TypeScript lint covers every runtime root and Node tooling with typed rules', async () => {
    const eslint = new ESLint({ cwd: root });
    for (const directory of [...AUTHORED_SOURCE_ROOTS, 'scripts', 'test/project']) {
        const file = path.join(root, directory, directory === 'scripts' ? 'example.mts' : 'example.ts');
        const config = await eslint.calculateConfigForFile(file);
        assert.ok(config, file);
        assert.equal(config.rules['no-undef'][0], 0, file);
        assert.equal(config.rules['@typescript-eslint/no-unused-vars'][0], 2, file);
        assert.equal(config.rules['@typescript-eslint/no-shadow'][0], 2, file);
    }
    const [result] = await eslint.lintText('const unused: number = 1;\nexport {};\n',
        { filePath: path.join(root, 'src/ui/example.ts') });
    assert.ok(result.messages.some(message => message.ruleId === '@typescript-eslint/no-unused-vars'));
});

test('CI and release enforce both checking projects and the default test command includes TypeScript', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.test, /test\/\*\*\/\*\.test\.mts/);
    assert.match(pkg.scripts.typecheck, /--project tsconfig\.check\.json/);
    assert.match(pkg.scripts.typecheck, /--project tsconfig\.node\.check\.json/);
    for (const file of ['test.yml', 'release.yml']) {
        const workflow = await readFile(path.join(root, '.github/workflows', file), 'utf8');
        assert.match(workflow, /run: npm run typecheck/);
    }
    const updates = await readFile(path.join(root, '.github/dependabot.yml'), 'utf8');
    assert.match(updates, /dependency-name: typescript\n\s+update-types: \[version-update:semver-major\]/);
});
