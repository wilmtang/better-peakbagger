// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
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
        await writeFile(file, `import { units } from ${JSON.stringify(path.join(root, 'src/ui/units.ts'))};
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

test('CI checks both projects and release inherits the exact checked CI packages', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.test, /test\/\*\*\/\*\.test\.mts/);
    assert.match(pkg.scripts.typecheck, /--project tsconfig\.check\.json/);
    assert.match(pkg.scripts.typecheck, /node scripts\/typecheck-node\.mts/);
    const ci = await readFile(path.join(root, '.github/workflows/test.yml'), 'utf8');
    assert.match(ci, /run: npm run typecheck/);
    const release = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
    assert.match(release, /node scripts\/release-evidence\.mts/);
    assert.match(release, /check:typescript-policy -- --base d7bc366311ccb384d9460eb17d68872e986d6a35/);
    const updates = await readFile(path.join(root, '.github/dependabot.yml'), 'utf8');
    assert.match(updates, /dependency-name: typescript\n\s+update-types: \[version-update:semver-major\]/);
});

test('the Node typecheck gives DOM types only to files that reach extension source or a DOM lib reference', async () => {
    const { domRootFiles, parseProject } = await import('../../scripts/typecheck-node.mts');
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-typecheck-split-'));
    try {
        const files: Record<string, string> = {
            'helper.mjs': "export { default as page } from './extension.mts';\n",
            'through-js.mts': "import { page } from './helper.mjs';\nexport default page;\n",
            'browser-callback.mts': '/// <reference lib="dom" />\nexport const title = (): string => document.title;\n',
            'extension.mts': "import { units } from './src/units.ts';\nexport default units;\n",
            'src/units.ts': 'export const units = 1;\n',
            'cycle-a.mts': "import './cycle-b.mts';\nimport type { units } from './src/units.ts';\nexport type W = typeof units;\n",
            'cycle-b.mts': "import './cycle-a.mts';\nexport const b = 1;\n",
            'pure.mts': "import { readFile } from 'node:fs/promises';\nexport const read = readFile;\n",
        };
        for (const [name, text] of Object.entries(files)) {
            await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
            await writeFile(path.join(directory, name), text);
        }
        const { options } = parseProject(path.join(root, 'tsconfig.node.check.json'));
        const roots = Object.keys(files).filter(name => name.endsWith('.mts')).map(name => path.join(directory, name));
        const marked = domRootFiles(roots, options, directory).map(file => path.relative(directory, file)).sort();
        assert.deepEqual(marked, ['browser-callback.mts', 'cycle-a.mts', 'cycle-b.mts', 'extension.mts', 'through-js.mts']);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('the Node program is rejected when a dependency pulls DOM declarations into it', async () => {
    const { domLibraryFiles, parseProject } = await import('../../scripts/typecheck-node.mts');
    const directory = await mkdtemp(path.join(tmpdir(), 'bpb-typecheck-leak-'));
    try {
        await mkdir(path.join(directory, 'node_modules', 'leaky'), { recursive: true });
        await writeFile(path.join(directory, 'node_modules', 'leaky', 'package.json'), JSON.stringify({ name: 'leaky', types: 'index.d.ts' }));
        await writeFile(path.join(directory, 'node_modules', 'leaky', 'index.d.ts'), '/// <reference lib="dom" />\nexport declare const leak: number;\n');
        await writeFile(path.join(directory, 'pure.mts'), "import { leak } from 'leaky';\nexport default leak;\n");
        await writeFile(path.join(directory, 'clean.mts'), 'export const clean = 1;\n');
        const { options } = parseProject(path.join(root, 'tsconfig.node.check.json'));
        const program = (files: string[]) => ts.createProgram({ rootNames: files.map(file => path.join(directory, file)), options });
        assert.deepEqual(domLibraryFiles(program(['clean.mts'])), []);
        assert.ok(domLibraryFiles(program(['pure.mts'])).some(file => path.basename(file) === 'lib.dom.d.ts'));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('the DOM project only adds the DOM library, and nothing depends on jsdom', async () => {
    const { parseProject } = await import('../../scripts/typecheck-node.mts');
    const dom = JSON.parse(await readFile(path.join(root, 'tsconfig.dom.check.json'), 'utf8'));
    assert.deepEqual(dom.compilerOptions.lib, ['ES2023', 'DOM', 'DOM.Iterable']);
    assert.equal(dom.extends, './tsconfig.node.check.json');
    const node = JSON.parse(await readFile(path.join(root, 'tsconfig.node.check.json'), 'utf8'));
    assert.deepEqual(node.compilerOptions.lib, ['ES2023'], 'the Node project itself has no DOM globals');
    // DOM behavior is tested in real browsers (M7.5); jsdom is not a stand-in.
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    for (const name of ['jsdom', '@types/jsdom']) {
        assert.equal(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name], undefined, `${name} is not a dependency`);
    }
    const offenders: string[] = [];
    // This file names the forbidden module in its own patterns.
    const self = fileURLToPath(import.meta.url);
    for (const file of parseProject(path.join(root, 'tsconfig.node.check.json')).fileNames.filter(name => path.resolve(name) !== self)) {
        if (/^\s*(?:import|export)\b[^;]*['"]jsdom(?:\/[^'"]*)?['"]|\bimport\(\s*['"]jsdom|\brequire\(\s*['"]jsdom/m.test(await readFile(file, 'utf8'))) {
            offenders.push(path.relative(root, file));
        }
    }
    assert.deepEqual(offenders, []);
});
