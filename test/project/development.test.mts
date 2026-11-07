import assert from 'node:assert/strict';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ESLint } from 'eslint';

import {
    BUILD_TREE_PREFIX,
    cleanupAbandonedBuildTrees,
    formatReloadLog,
    publishBuildTree as publishBuildTreeJS,
    RELOAD_SIGNAL,
    watchAll,
    watchDirectories,
} from '../../scripts/build.mts';
import { AUTHORED_SOURCE_ROOTS, ENTRIES, entrySources, root as projectRoot } from '../../scripts/build-config.mts';
import { webExtArguments } from '../../scripts/run-development.mjs';
import {
    createFirefoxSource,
    syncFirefoxSource as syncFirefoxSourceJS,
} from '../../scripts/run-firefox.mjs';

import { isRuntimeSource, runtimeSourceFiles } from '../helpers/runtime-sources.mts';

interface PublishOptions {candidateDir: string; targetDir?: string; renameTree?: typeof rename}
const publishBuildTree = publishBuildTreeJS as (options: PublishOptions) => Promise<void>;
interface SyncOptions {
    distDir?: string; sourceDir: string; reloadToken: number;
    copyTree?: (source: string, candidate: string, options?: {preserve?: Set<string>}) => Promise<void>;
    writeText?: (destination: string, contents: string) => Promise<void>;
    validateTree?: (options: {distDir: string}) => Promise<void>;
    publishTree?: (options: PublishOptions) => Promise<void>; renameTree?: typeof rename;
}
const syncFirefoxSource = syncFirefoxSourceJS as (options: SyncOptions) => Promise<void>;
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

test('source and tests stay organized by owning domain', async () => {
    const sourceEntries = await readdir(path.join(projectRoot, 'src'), { withFileTypes: true });
    const sourceFiles = sourceEntries
        .filter(entry => entry.isFile() && (isRuntimeSource(entry.name) || entry.name.endsWith('.css')))
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
        .filter(entry => entry.isFile() && /\.(?:test|scale)\.m[jt]s$/.test(entry.name))
        .map(entry => entry.name);
    assert.deepEqual(ungroupedTests, [], 'test files must live in a domain directory');

    const scaleEntries = await readdir(path.join(projectRoot, 'test', 'scale'), { withFileTypes: true });
    const ungroupedScaleTests = scaleEntries
        .filter(entry => entry.isFile() && /\.scale\.m[jt]s$/.test(entry.name))
        .map(entry => entry.name);
    assert.deepEqual(ungroupedScaleTests, [], 'scale tests must live in a domain directory');
});

// A page-local bundle root lives outside src/, so nothing in the src/ glob
// covers it. photos/photos.js shipped unlinted for exactly that reason: the
// lint script and the ESLint browser-globals block both enumerate directories
// by hand, and a new page surface is easy to add to neither.
test('every page-local bundle source is linted like shared source', async () => {
    const pageLocalFiles = (await runtimeSourceFiles()).filter(file => !file.startsWith(path.join(projectRoot,'src') + path.sep));
    assert.ok(pageLocalFiles.length > 0, 'expected page-local bundle sources to exist');

    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const lintTargets = packageJson.scripts.lint.split(/\s+/).slice(1);
    const unlintedDirectories = [...new Set(pageLocalFiles
        .map(file => path.relative(projectRoot, file).split(path.sep)[0])
        .filter(directory => !lintTargets.includes(directory)))].sort();
    assert.deepEqual(unlintedDirectories, [],
        'lint:js must pass every page-local bundle directory to ESLint');

    const eslint = new ESLint({ cwd: projectRoot });
    const typedProbes = AUTHORED_SOURCE_ROOTS.filter(directory => directory !== 'src').map(directory => path.join(projectRoot,directory,'coverage-probe.ts'));
    for (const file of [...pageLocalFiles,...typedProbes]) {
        const config = await eslint.calculateConfigForFile(file);
        const relative = path.relative(projectRoot, file);
        assert.ok(config, `${relative} must have lint configuration`);
        if (/\.[cm]?tsx?$/.test(file)) {
            assert.equal(config.rules?.['no-undef']?.[0], 0, `${relative} delegates undeclared names to TypeScript`);
            assert.equal(config.rules?.['@typescript-eslint/no-unused-vars']?.[0], 2, `${relative} must use typed lint rules`);
        } else assert.equal(config.rules?.['no-undef']?.[0], 2, `${relative} must be checked for undeclared names`);
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

test('the default test command caps local concurrency and leaves CI at the Node default', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.match(
        packageJson.scripts.test,
        /^npm run build && node --test --test-concurrency=3 \$\{CI:\+--test-concurrency=\$\(node -p 'os\.availableParallelism\(\)-1'\)\} "/,
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
            renameTree: async (...args: Parameters<typeof rename>) => {
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
        await assert.rejects(readFile(path.join(targetDir, 'stale.js')), missing);
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
            missing,
        );
    } finally {
        await prepared.cleanup();
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test('failed Firefox generations preserve the complete prior tree and token', async t => {
    interface CasePaths {distDir: string; sourceDir: string}
    const cases: {name: string; prepare?: (paths: CasePaths) => Promise<unknown>; options: (paths: CasePaths) => Partial<SyncOptions>; pattern: RegExp}[] = [
        {
            name: 'nested copy',
            options: () => ({
                copyTree: async (source, candidate) => {
                    await mkdir(path.join(candidate, 'content'), { recursive: true });
                    await copyFile(
                        path.join(source, 'content', 'theme.js'),
                        path.join(candidate, 'content', 'theme.js'),
                    );
                    throw new Error('COPY_FAILURE_SENTINEL');
                },
            }),
            pattern: /COPY_FAILURE_SENTINEL/,
        },
        {
            name: 'manifest parse',
            prepare: ({ distDir }) => writeFile(path.join(distDir, 'manifest.json'), '{broken'),
            options: () => ({}),
            pattern: /JSON/,
        },
        {
            name: 'manifest write',
            options: () => ({
                writeText: async (destination, contents) => {
                    if (path.basename(destination) === 'manifest.json') {
                        throw new Error('MANIFEST_WRITE_FAILURE_SENTINEL');
                    }
                    return writeFile(destination, contents);
                },
            }),
            pattern: /MANIFEST_WRITE_FAILURE_SENTINEL/,
        },
        {
            name: 'token write',
            options: () => ({
                writeText: async (destination, contents) => {
                    if (path.basename(destination) === RELOAD_SIGNAL) {
                        throw new Error('TOKEN_WRITE_FAILURE_SENTINEL');
                    }
                    return writeFile(destination, contents);
                },
            }),
            pattern: /TOKEN_WRITE_FAILURE_SENTINEL/,
        },
        {
            name: 'validation',
            options: () => ({
                validateTree: async () => { throw new Error('VALIDATION_FAILURE_SENTINEL'); },
            }),
            pattern: /VALIDATION_FAILURE_SENTINEL/,
        },
        {
            name: 'publication',
            options: () => ({
                publishTree: async () => { throw new Error('PUBLICATION_FAILURE_SENTINEL'); },
            }),
            pattern: /PUBLICATION_FAILURE_SENTINEL/,
        },
        {
            name: 'publication with transient rollback failure',
            options: () => {
                let renames = 0;
                return {
                    renameTree: async (...args: Parameters<typeof rename>) => {
                        renames++;
                        if (renames === 2) throw new Error('PUBLISH_RENAME_FAILURE_SENTINEL');
                        if (renames === 3) throw new Error('ROLLBACK_RENAME_FAILURE_SENTINEL');
                        return rename(...args);
                    },
                };
            },
            pattern: /rollback recovered after retry/,
        },
    ];

    for (const failureCase of cases) {
        await t.test(failureCase.name, async () => {
            const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-firefox-atomic-test-'));
            const distDir = path.join(temporaryRoot, 'dist');
            await mkdir(path.join(distDir, 'content'), { recursive: true });
            await writeFile(path.join(distDir, 'content', 'theme.js'), 'old theme\n');
            await writeFile(path.join(distDir, 'old-only.js'), 'old only\n');
            await writeFile(path.join(distDir, 'manifest.json'), JSON.stringify({
                manifest_version: 3,
                name: 'old',
                options_ui: { page: 'options/options.html', open_in_tab: true },
            }));
            const prepared = await createFirefoxSource({ temporaryRoot });

            try {
                await syncFirefoxSource({
                    distDir,
                    sourceDir: prepared.sourceDir,
                    reloadToken: 1,
                });
                const oldManifest = await readFile(
                    path.join(prepared.sourceDir, 'manifest.json'), 'utf8');

                await writeFile(path.join(distDir, 'content', 'theme.js'), 'new theme\n');
                await rm(path.join(distDir, 'old-only.js'));
                await mkdir(path.join(distDir, 'nested'), { recursive: true });
                await writeFile(path.join(distDir, 'nested', 'new.js'), 'new nested\n');
                await writeFile(path.join(distDir, 'manifest.json'), JSON.stringify({
                    manifest_version: 3,
                    name: 'new',
                    options_ui: { page: 'options/options.html', open_in_tab: true },
                }));
                await failureCase.prepare?.({ distDir, sourceDir: prepared.sourceDir });

                await assert.rejects(syncFirefoxSource({
                    distDir,
                    sourceDir: prepared.sourceDir,
                    reloadToken: 2,
                    ...failureCase.options({ distDir, sourceDir: prepared.sourceDir }),
                }), failureCase.pattern);

                assert.equal(
                    await readFile(path.join(prepared.sourceDir, 'content', 'theme.js'), 'utf8'),
                    'old theme\n',
                );
                assert.equal(
                    await readFile(path.join(prepared.sourceDir, 'old-only.js'), 'utf8'),
                    'old only\n',
                );
                assert.equal(
                    await readFile(path.join(prepared.sourceDir, 'manifest.json'), 'utf8'),
                    oldManifest,
                );
                assert.equal(
                    await readFile(path.join(prepared.sourceDir, RELOAD_SIGNAL), 'utf8'),
                    '1\n',
                );
                await assert.rejects(
                    readFile(path.join(prepared.sourceDir, 'nested', 'new.js')),
                    missing,
                );
                const leftovers = (await readdir(temporaryRoot))
                    .filter(name => name.startsWith('.better-peakbagger-firefox-generation-')
                        || name.includes('.previous-'));
                assert.deepEqual(leftovers, [], 'failed candidates and swap backups must be disposable');
            } finally {
                await prepared.cleanup();
                await rm(temporaryRoot, { recursive: true, force: true });
            }
        });
    }
});

async function pollUntil<T>(
    probe: () => Promise<{ ok: boolean; value: T; live: unknown }>,
    description: string,
    timeoutMs = 15_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastLive: unknown;
    while (Date.now() < deadline) {
        const result = await probe();
        if (result.ok) return result.value;
        lastLive = result.live;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const finalResult = await probe();
    if (finalResult.ok) return finalResult.value;
    throw new Error(`Timed out waiting for ${description}; live state: ${JSON.stringify(finalResult.live ?? lastLive)}`);
}

test('watchDirectories covers all authored source roots and copied asset roots without overlapping watches', () => {
    const entryDerivedDirectories = new Set(
        ENTRIES.flatMap(entrySources).map(file => path.dirname(file)),
    );
    assert.equal(
        entryDerivedDirectories.has(path.join(projectRoot, 'src', 'storage')),
        false,
        'entry-derived directory lists omit imported non-entry domains such as src/storage/',
    );

    const watched = watchDirectories();
    const covers = (target: string) => watched.some(
        directory => target === directory || target.startsWith(directory + path.sep),
    );
    for (const rootName of AUTHORED_SOURCE_ROOTS) {
        assert.ok(covers(path.join(projectRoot, rootName)), `${rootName}/ must be watched recursively`);
    }
    assert.ok(covers(path.join(projectRoot, 'src', 'storage')), 'src/storage/ must be covered by recursive watch');
    for (const assetRoot of ['icons', 'terrain', 'third_party']) {
        assert.ok(covers(path.join(projectRoot, assetRoot)), `${assetRoot}/ must be watched recursively`);
    }
    const overlapping = watched.filter(directory =>
        watched.some(other => other !== directory && directory.startsWith(other + path.sep)));
    assert.deepEqual(overlapping, [], 'recursive directory watches must not overlap');

    assert.deepEqual(
        entrySources({ sources: ['ui/units.js', 'popup-main.js'], page: true }, '/fixture-root'),
        ['/fixture-root/src/ui/units.js', '/fixture-root/popup/popup.ts'],
        'entrySources resolves both shared src/ and page-local roots relative to projectRoot',
    );
});

test('watchAll rebuilds imported src/storage/, new nested domains and page-local roots, syncs Firefox reload state, preserves dist/ on syntax error, recovers and cleans up when closed mid-rebuild', async () => {
    const temporaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'bpb-watch-fixture-')));
    const targetDistDir = path.join(temporaryRoot, 'dist');
    const reloadFile = path.join(targetDistDir, RELOAD_SIGNAL);
    const appOutFile = path.join(targetDistDir, 'content', 'app.js');
    const popupOutFile = path.join(targetDistDir, 'popup', 'popup.js');
    const entryFile = path.join(temporaryRoot, 'src', 'app', 'entry.ts');
    const storageFile = path.join(temporaryRoot, 'src', 'storage', 'storage-value.ts');
    const nestedFile = path.join(temporaryRoot, 'src', 'nested', 'deep', 'feature.ts');
    const popupFile = path.join(temporaryRoot, 'popup', 'popup.ts');
    const firefoxPrepared = await createFirefoxSource({ temporaryRoot });
    const firefoxReloadFile = path.join(firefoxPrepared.sourceDir, RELOAD_SIGNAL);
    const firefoxAppOutFile = path.join(firefoxPrepared.sourceDir, 'content', 'app.js');

    await mkdir(path.dirname(entryFile), { recursive: true });
    await mkdir(path.dirname(storageFile), { recursive: true });
    await mkdir(path.dirname(popupFile), { recursive: true });
    await mkdir(path.join(temporaryRoot, 'terrain'), { recursive: true });
    await mkdir(path.join(temporaryRoot, 'icons'), { recursive: true });
    await writeFile(storageFile, 'export function readStorageValue(): string { return \'storage-v1\'; }\n');
    await writeFile(entryFile, [
        'import { readStorageValue } from \'../storage/storage-value.ts\';',
        'console.log(readStorageValue());',
        '',
    ].join('\n'));
    await writeFile(popupFile, 'console.log(\'popup-v1\');\n');
    await writeFile(path.join(temporaryRoot, 'src', 'app', 'panel.css'), 'body { color: #111; }\n');
    await writeFile(path.join(temporaryRoot, 'terrain', 'terrain.html'), '<!doctype html><title>v1</title>\n');
    await writeFile(path.join(temporaryRoot, 'icons', 'icon.svg'), '<svg>v1</svg>\n');
    await writeFile(path.join(temporaryRoot, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: 'watch-fixture',
        options_ui: { page: 'options/options.html', open_in_tab: true },
    }) + '\n');

    let holdGate: { started: () => void; release: Promise<void> } | null = null;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
    };

    const readLiveState = async () => {
        const token = await readFile(reloadFile, 'utf8').catch(() => null);
        const firefoxToken = await readFile(firefoxReloadFile, 'utf8').catch(() => null);
        const bundle = await readFile(appOutFile, 'utf8').catch(() => null);
        const firefoxBundle = await readFile(firefoxAppOutFile, 'utf8').catch(() => null);
        const popupBundle = await readFile(popupOutFile, 'utf8').catch(() => null);
        return {
            token: token?.trim() ?? null,
            firefoxToken: firefoxToken?.trim() ?? null,
            bundle,
            firefoxBundle,
            popupBundle,
        };
    };

    let watcher: Awaited<ReturnType<typeof watchAll>> | null = null;
    try {
        watcher = await watchAll({
            projectRoot: temporaryRoot,
            distDir: targetDistDir,
            reloadFile,
            authoredSourceRoots: ['src', 'popup'],
            entries: [
                { out: 'content/app.js', sources: ['app/entry.ts'] },
                { out: 'popup/popup.js', sources: ['popup-main.js'], page: true },
            ],
            copyFiles: [
                ['src/app/panel.css', 'css/panel.css'],
                ['terrain/terrain.html', 'terrain/terrain.html'],
                ['manifest.json', 'manifest.json'],
            ],
            copyDirs: [['icons', 'icons']],
            vendorCopy: [],
            debounceMs: 20,
            afterBuild: async ({ sequence }) => {
                await syncFirefoxSource({
                    distDir: targetDistDir,
                    sourceDir: firefoxPrepared.sourceDir,
                    reloadToken: sequence,
                });
                if (holdGate) {
                    const currentGate = holdGate;
                    holdGate = null;
                    currentGate.started();
                    await currentGate.release;
                }
            },
        });

        const initial = await readLiveState();
        assert.equal(initial.token, '1');
        assert.equal(initial.firefoxToken, '1');
        assert.match(initial.bundle ?? '', /storage-v1/);
        assert.match(initial.firefoxBundle ?? '', /storage-v1/);
        assert.match(initial.popupBundle ?? '', /popup-v1/);

        // Edit the imported TS file under src/storage/ (not listed in entries).
        await writeFile(storageFile, 'export function readStorageValue(): string { return \'storage-v2\'; }\n');
        await pollUntil(async () => {
            const live = await readLiveState();
            return {
                ok: live.token !== null
                    && Number(live.token) >= 2
                    && live.firefoxToken === live.token
                    && Boolean(live.bundle?.includes('storage-v2'))
                    && Boolean(live.firefoxBundle?.includes('storage-v2')),
                value: live,
                live,
            };
        }, 'src/storage/ edit to publish storage-v2');

        // Add an imported TS file in a new nested domain and then edit that nested file directly.
        await mkdir(path.dirname(nestedFile), { recursive: true });
        await writeFile(nestedFile, 'export function readNestedFeature(): string { return \'nested-v1\'; }\n');
        await writeFile(entryFile, [
            'import { readStorageValue } from \'../storage/storage-value.ts\';',
            'import { readNestedFeature } from \'../nested/deep/feature.ts\';',
            'console.log(readStorageValue(), readNestedFeature());',
            '',
        ].join('\n'));
        await pollUntil(async () => {
            const live = await readLiveState();
            return {
                ok: Boolean(live.bundle?.includes('nested-v1'))
                    && Boolean(live.firefoxBundle?.includes('nested-v1')),
                value: live,
                live,
            };
        }, 'new nested domain import to publish nested-v1');

        const beforeNestedEdit = await readLiveState();
        await writeFile(nestedFile, 'export function readNestedFeature(): string { return \'nested-v2\'; }\n');
        const afterNestedEdit = await pollUntil(async () => {
            const live = await readLiveState();
            return {
                ok: Number(live.token) > Number(beforeNestedEdit.token)
                    && live.firefoxToken === live.token
                    && Boolean(live.bundle?.includes('nested-v2'))
                    && Boolean(live.firefoxBundle?.includes('nested-v2')),
                value: live,
                live,
            };
        }, 'nested domain file edit to publish nested-v2');

        // Edit a page-local entry root under popup/ resolved via entrySources.
        await writeFile(popupFile, 'console.log(\'popup-v2\');\n');
        const afterPopupEdit = await pollUntil(async () => {
            const live = await readLiveState();
            return {
                ok: Number(live.token) > Number(afterNestedEdit.token)
                    && live.firefoxToken === live.token
                    && Boolean(live.popupBundle?.includes('popup-v2')),
                value: live,
                live,
            };
        }, 'popup/ page-local edit to publish popup-v2');

        // Introduce a syntax error; verify previous dist/ and Firefox trees and reload tokens are preserved.
        const errorCountBefore = errors.length;
        await writeFile(storageFile, 'export function readStorageValue(: string {\n');
        await pollUntil(async () => ({
            ok: errors.length > errorCountBefore
                && errors.slice(errorCountBefore).some(line => line.includes('Rebuild failed; keeping the currently loaded extension:')),
            value: true,
            live: { errors: errors.slice(errorCountBefore), state: await readLiveState() },
        }), 'syntax error rebuild failure to be logged');
        const duringFailure = await readLiveState();
        assert.equal(duringFailure.token, afterPopupEdit.token, 'failed rebuild must not advance the reload token');
        assert.equal(duringFailure.firefoxToken, afterPopupEdit.firefoxToken, 'failed rebuild must not advance the Firefox reload token');
        assert.equal(duringFailure.bundle, afterPopupEdit.bundle, 'failed rebuild must preserve the published bundle');
        assert.equal(duringFailure.firefoxBundle, afterPopupEdit.firefoxBundle, 'failed rebuild must preserve the Firefox bundle');

        // Correct the syntax error and verify watch mode recovers and advances both tokens.
        await writeFile(storageFile, 'export function readStorageValue(): string { return \'storage-v3-recovered\'; }\n');
        const recovered = await pollUntil(async () => {
            const live = await readLiveState();
            return {
                ok: Number(live.token) > Number(afterPopupEdit.token)
                    && live.firefoxToken === live.token
                    && Boolean(live.bundle?.includes('storage-v3-recovered'))
                    && Boolean(live.firefoxBundle?.includes('storage-v3-recovered'))
                    && Boolean(live.bundle?.includes('nested-v2')),
                value: live,
                live,
            };
        }, 'syntax error correction to publish storage-v3-recovered');

        // Edit a copied root file and verify it publishes a new generation to dist/ and Firefox sourceDir.
        await writeFile(path.join(temporaryRoot, 'manifest.json'), JSON.stringify({
            manifest_version: 3,
            name: 'watch-fixture-v2',
            options_ui: { page: 'options/options.html', open_in_tab: true },
        }) + '\n');
        const afterRootEdit = await pollUntil(async () => {
            const live = await readLiveState();
            const manifest = await readFile(path.join(targetDistDir, 'manifest.json'), 'utf8').catch(() => '');
            const firefoxManifest = await readFile(path.join(firefoxPrepared.sourceDir, 'manifest.json'), 'utf8').catch(() => '');
            return {
                ok: Number(live.token) > Number(recovered.token)
                    && live.firefoxToken === live.token
                    && manifest.includes('watch-fixture-v2')
                    && firefoxManifest.includes('watch-fixture-v2')
                    && firefoxManifest.includes('"open_in_tab": false'),
                value: live,
                live: { ...live, manifest, firefoxManifest },
            };
        }, 'root file edit to publish updated manifest.json');

        // Close while a rebuild is in flight; verify close() waits for the rebuild and removes staging trees.
        let markRebuildStarted!: () => void;
        let releaseRebuild!: () => void;
        const rebuildStarted = new Promise<void>(resolve => { markRebuildStarted = resolve; });
        const releasePromise = new Promise<void>(resolve => { releaseRebuild = resolve; });
        holdGate = { started: markRebuildStarted, release: releasePromise };

        await writeFile(storageFile, 'export function readStorageValue(): string { return \'storage-v4-closing\'; }\n');
        await pollUntil(async () => {
            let started = false;
            await Promise.race([rebuildStarted.then(() => { started = true; }), new Promise(resolve => setTimeout(resolve, 10))]);
            return { ok: started, value: true, live: await readLiveState() };
        }, 'in-flight rebuild to enter afterBuild');

        const closePromise = watcher.close();
        watcher = null;
        releaseRebuild();
        await closePromise;

        const afterClose = await readLiveState();
        assert.ok(Number(afterClose.token) > Number(afterRootEdit.token), 'in-flight rebuild finishes before close() resolves');
        assert.equal(afterClose.firefoxToken, afterClose.token, 'in-flight Firefox sync finishes before close() resolves');
        assert.match(afterClose.bundle ?? '', /storage-v4-closing/);

        const remainingStaging = (await readdir(temporaryRoot))
            .filter(name => name.startsWith(BUILD_TREE_PREFIX) || name.includes('.previous-'));
        assert.deepEqual(remainingStaging, [], 'close() must remove all build staging trees');

        // Subsequent edits after close() must not trigger further rebuilds.
        const tokenAtClose = afterClose.token;
        await writeFile(storageFile, 'export function readStorageValue(): string { return \'storage-v5-after-close\'; }\n');
        await new Promise(resolve => setTimeout(resolve, 80));
        const finalState = await readLiveState();
        assert.equal(finalState.token, tokenAtClose, 'closed watcher must ignore subsequent file changes');
    } finally {
        console.error = originalError;
        await watcher?.close();
        await firefoxPrepared.cleanup();
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});
