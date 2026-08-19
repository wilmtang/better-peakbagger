import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

import {
    BUILD_TREE_PREFIX,
    cleanupAbandonedBuildTrees,
    formatReloadLog,
    publishBuildTree,
    RELOAD_SIGNAL,
} from '../../scripts/build.mjs';
import { ENTRIES, resolvePageSource, root } from '../../scripts/build-config.mjs';
import { webExtArguments } from '../../scripts/run-development.mjs';
import {
    createFirefoxSource,
    syncFirefoxSource,
} from '../../scripts/run-firefox.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('source and tests stay organized by owning domain', async () => {
    const sourceEntries = await readdir(path.join(projectRoot, 'src'), { withFileTypes: true });
    const sourceFiles = sourceEntries
        .filter(entry => entry.isFile() && /\.(?:js|css)$/.test(entry.name))
        .map(entry => entry.name);
    assert.deepEqual(sourceFiles, [], 'src/ must not contain loose runtime source files');

    const sourceDomains = sourceEntries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
    const testEntries = await readdir(path.join(projectRoot, 'test'), { withFileTypes: true });
    const testDomains = new Set(testEntries.filter(entry => entry.isDirectory()).map(entry => entry.name));
    assert.deepEqual(
        sourceDomains.filter(domain => !testDomains.has(domain)),
        [],
        'every source domain must have a matching test directory',
    );

    const ungroupedTests = testEntries
        .filter(entry => entry.isFile() && /\.(?:test|scale)\.mjs$/.test(entry.name))
        .map(entry => entry.name);
    assert.deepEqual(ungroupedTests, [], 'test files must live in a domain directory');

    const scaleEntries = await readdir(path.join(projectRoot, 'test', 'scale'), { withFileTypes: true });
    const ungroupedScaleTests = scaleEntries
        .filter(entry => entry.isFile() && entry.name.endsWith('.scale.mjs'))
        .map(entry => entry.name);
    assert.deepEqual(ungroupedScaleTests, [], 'scale tests must live in a domain directory');
});

// A page-local bundle root lives outside src/, so nothing in the src/ glob
// covers it. photos/photos.js shipped unlinted for exactly that reason: the
// lint script and the ESLint browser-globals block both enumerate directories
// by hand, and a new page surface is easy to add to neither.
test('every page-local bundle source is linted like shared source', async () => {
    const pageLocalFiles = [...new Set(
        ENTRIES.flatMap(entry => entry.sources)
            .map(name => resolvePageSource(name))
            .filter(file => !file.startsWith(path.join(root, 'src') + path.sep)),
    )].sort();
    assert.ok(pageLocalFiles.length > 0, 'expected page-local bundle sources to exist');

    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const lintTargets = packageJson.scripts.lint.split(/\s+/).slice(1);
    const unlintedDirectories = [...new Set(pageLocalFiles
        .map(file => path.relative(root, file).split(path.sep)[0])
        .filter(directory => !lintTargets.includes(directory)))].sort();
    assert.deepEqual(unlintedDirectories, [],
        'lint:js must pass every page-local bundle directory to ESLint');

    const eslint = new ESLint({ cwd: projectRoot });
    for (const file of pageLocalFiles) {
        const config = await eslint.calculateConfigForFile(file);
        const relative = path.relative(root, file);
        assert.equal(config.rules?.['no-undef']?.[0], 2, `${relative} must be checked for undeclared names`);
        assert.equal(config.rules?.eqeqeq?.[0], 2, `${relative} must be checked for loose equality`);
        assert.equal(config.languageOptions?.globals?.window, false,
            `${relative} must resolve browser globals`);
        assert.equal(config.languageOptions?.globals?.chrome, false,
            `${relative} must resolve extension globals`);
    }
});

test('every npm command is described in the development guide', async () => {
    const [packageJson, developmentGuide] = await Promise.all([
        readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
        readFile(path.join(projectRoot, 'docs', 'development.md'), 'utf8'),
    ]);
    const documentedCommands = [];
    for (const match of developmentGuide.matchAll(/^\| `npm (test|run ([^\s`]+)(?: [^`]*)?)` \|/gm)) {
        documentedCommands.push(match[1] === 'test' ? 'test' : match[2]);
    }
    assert.deepEqual(
        documentedCommands.sort(),
        Object.keys(packageJson.scripts).sort(),
        'docs/development.md must describe every package.json script exactly once',
    );
});

test('development reload logs include a local timestamp', () => {
    const localTime = new Date(2026, 6, 19, 13, 4, 5);
    assert.match(
        formatReloadLog(3, localTime),
        /^\[2026-07-19 13:04:05\] Rebuilt \d+ bundles \(development reload 3\)$/,
    );
});

test('a failed build-tree publication restores the complete prior generation', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-build-publish-test-'));
    const targetDir = path.join(temporaryRoot, 'dist');
    const candidateDir = path.join(temporaryRoot, 'candidate');
    await mkdir(targetDir, { recursive: true });
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(targetDir, 'generation.txt'), 'last-good\n');
    await writeFile(path.join(targetDir, 'last-good-only.txt'), 'preserved\n');
    await writeFile(path.join(candidateDir, 'generation.txt'), 'new\n');
    let renames = 0;

    try {
        await assert.rejects(publishBuildTree({
            candidateDir,
            targetDir,
            renameTree: async (...args) => {
                renames++;
                if (renames === 2) throw new Error('PUBLISH_FAILURE_SENTINEL');
                return rename(...args);
            },
        }), /PUBLISH_FAILURE_SENTINEL/);
        assert.equal(await readFile(path.join(targetDir, 'generation.txt'), 'utf8'), 'last-good\n');
        assert.equal(await readFile(path.join(targetDir, 'last-good-only.txt'), 'utf8'), 'preserved\n');
        assert.equal(await readFile(path.join(candidateDir, 'generation.txt'), 'utf8'), 'new\n');
        assert.deepEqual((await readdir(temporaryRoot)).sort(), ['candidate', 'dist']);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test('publishing a complete build tree removes stale outputs as one generation', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-build-swap-test-'));
    const targetDir = path.join(temporaryRoot, 'dist');
    const candidateDir = path.join(temporaryRoot, 'candidate');
    await mkdir(targetDir, { recursive: true });
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(targetDir, 'stale.js'), 'old\n');
    await writeFile(path.join(candidateDir, 'generation.txt'), 'complete\n');

    try {
        await publishBuildTree({ candidateDir, targetDir });
        assert.equal(await readFile(path.join(targetDir, 'generation.txt'), 'utf8'), 'complete\n');
        await assert.rejects(readFile(path.join(targetDir, 'stale.js')), error => error.code === 'ENOENT');
        assert.deepEqual(await readdir(temporaryRoot), ['dist']);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test('build startup removes only abandoned staging trees', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-build-cleanup-test-'));
    const alive = path.join(temporaryRoot, `${BUILD_TREE_PREFIX}${process.pid}-alive`);
    const abandoned = path.join(temporaryRoot, `${BUILD_TREE_PREFIX}99999999-abandoned`);
    await mkdir(alive);
    await mkdir(abandoned);

    try {
        await cleanupAbandonedBuildTrees({ directory: temporaryRoot });
        assert.deepEqual(await readdir(temporaryRoot), [path.basename(alive)]);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test('development browsers reload only from the completed-build signal', () => {
    const chromiumSource = path.resolve('dist');
    assert.deepEqual(
        webExtArguments('chromium', chromiumSource, ['--chromium-binary', '/test/chrome']),
        [
            'run',
            '--source-dir',
            chromiumSource,
            '--target',
            'chromium',
            '--watch-file',
            path.join(chromiumSource, RELOAD_SIGNAL),
            '--chromium-binary',
            '/test/chrome',
        ],
    );

    const firefoxSource = path.resolve('firefox-source');
    assert.deepEqual(webExtArguments('firefox', firefoxSource), [
        'run',
        '--source-dir',
        firefoxSource,
        '--watch-file',
        path.join(firefoxSource, RELOAD_SIGNAL),
    ]);
    assert.throws(() => webExtArguments('safari', chromiumSource), /chromium\|firefox/);
});

test('Firefox mirrors a completed build before exposing its reload signal', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-development-test-'));
    const distDir = path.join(temporaryRoot, 'dist');
    await mkdir(path.join(distDir, 'content'), { recursive: true });
    await writeFile(path.join(distDir, 'content', 'theme.js'), 'first build\n');
    await writeFile(path.join(distDir, RELOAD_SIGNAL), 'do-not-copy\n');
    await writeFile(path.join(distDir, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        options_ui: {
            page: 'options/options.html',
            open_in_tab: true,
        },
    }));

    const prepared = await createFirefoxSource({ temporaryRoot });
    try {
        await syncFirefoxSource({
            distDir,
            sourceDir: prepared.sourceDir,
            reloadToken: 1,
        });
        assert.equal(
            await readFile(path.join(prepared.sourceDir, 'content', 'theme.js'), 'utf8'),
            'first build\n',
        );
        assert.equal(
            JSON.parse(await readFile(path.join(prepared.sourceDir, 'manifest.json'), 'utf8'))
                .options_ui.open_in_tab,
            false,
        );
        assert.equal(
            await readFile(path.join(prepared.sourceDir, RELOAD_SIGNAL), 'utf8'),
            '1\n',
        );

        await writeFile(path.join(distDir, 'content', 'theme.js'), 'second build\n');
        await writeFile(path.join(prepared.sourceDir, 'content', 'stale.js'), 'stale\n');
        await syncFirefoxSource({
            distDir,
            sourceDir: prepared.sourceDir,
            reloadToken: 2,
        });
        assert.equal(
            await readFile(path.join(prepared.sourceDir, 'content', 'theme.js'), 'utf8'),
            'second build\n',
        );
        assert.equal(
            await readFile(path.join(prepared.sourceDir, RELOAD_SIGNAL), 'utf8'),
            '2\n',
        );
        await assert.rejects(
            readFile(path.join(prepared.sourceDir, 'content', 'stale.js')),
            error => error.code === 'ENOENT',
        );
    } finally {
        await prepared.cleanup();
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});
