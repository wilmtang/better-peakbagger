import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import JSZip from 'jszip';

import {
    buildFirefoxPackage,
    createFirefoxManifest,
    requirePackagePaths,
} from '../../scripts/build-firefox-package.mjs';
import { buildAmoMetadata } from '../../scripts/create-amo-metadata.mjs';
import {
    dependencyVersionsFromLock,
    validateReviewedDependencyMetadata,
} from '../../scripts/dependency-metadata.mjs';
import { WEB_EXT_WARNING_BASELINE } from '../../scripts/check-web-ext-lint.mjs';
import {
    ChromeWebStoreRequestError,
    publishChrome,
} from '../../scripts/publish-chrome.mjs';
import {
    assertReleasedSectionsUnchanged,
    releaseSection,
    stampUnreleased,
} from '../../scripts/release-changelog.mjs';
import {
    exactReleaseTags,
    requireCompleteHistory,
} from '../../scripts/check-changelog-history.mjs';
import {
    validateRelease,
    validateProtectedMainAncestry,
    validateTagAtHead,
} from '../../scripts/release-check.mjs';
import {
    atomicReleasePushArgs,
    resolveReleaseDate,
    validateReleasePreflight,
} from '../../scripts/release-bump.mjs';
import { validatePackageNoticeMetadata } from '../../scripts/third-party-notices.mjs';
import {
    isRetryableFirefoxStartup,
    ownedFirefoxPids,
} from '../../scripts/firefox-verifier-processes.mjs';
import { prepareFirefoxSource } from '../../scripts/run-firefox.mjs';
import { TERRAIN_FRAME_KEEP_ALIVE_MS } from '../../src/terrain/terrain-lifecycle.js';
import {
    AUTHORED_SOURCE_ROOTS,
    ENTRIES,
    entrySources,
    root,
} from '../../scripts/build-config.mjs';
import {
    expectedReleaseFiles,
    requireArchiveArguments,
    validateArchiveEntries,
    verifyReleaseArchive,
} from '../../scripts/verify-release-archive.mjs';

function releaseState(overrides = {}) {
    return {
        tag: 'v1.4.0',
        manifest: {
            version: '1.4.0',
            browser_specific_settings: { gecko: { id: 'better-peakbagger@example.test' } },
        },
        packageJson: { version: '1.4.0' },
        packageLock: { version: '1.4.0', packages: { '': { version: '1.4.0' } } },
        changelog: '# Changelog\n\n## 1.4.0 — 2026-07-13\n',
        ...overrides,
    };
}

function runGit(cwd, args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

test('release metadata requires an exact tag and synchronized versions', () => {
    assert.equal(validateRelease(releaseState()), '1.4.0');
    assert.throws(
        () => validateRelease(releaseState({ tag: 'release-1.4.0' })),
        /exact vMAJOR\.MINOR\.PATCH/,
    );
    assert.throws(
        () => validateRelease(releaseState({ packageJson: { version: '1.3.0' } })),
        /package\.json version/,
    );
    assert.throws(
        () => validateRelease(releaseState({ changelog: '# Changelog\n' })),
        /no release heading/,
    );
});

test('release changelog stamping preserves history and opens the next Unreleased section', () => {
    const changelog = '# Changelog\n\n## Unreleased\n\n- New work.\n\n'
        + '## 1.4.0 — 2026-07-13\n\n- Released work.\n\n'
        + '## 1.3.0 — 2026-07-01\n\n- Older work.\n';
    const stamped = stampUnreleased(changelog, '1.5.0', '2026-08-08');

    assert.match(stamped, /^## Unreleased\n\n## 1\.5\.0 — 2026-08-08\n\n- New work\./m);
    assert.equal(releaseSection(stamped, '1.4.0'), releaseSection(changelog, '1.4.0'));
    assert.equal(releaseSection(stamped, '1.3.0'), releaseSection(changelog, '1.3.0'));
    assert.throws(
        () => stampUnreleased(stamped, '1.5.0', '2026-08-08'),
        /already has a release heading/,
    );
    assert.throws(
        () => stampUnreleased('# Changelog\n', '1.5.0', '2026-08-08'),
        /no '## Unreleased'/,
    );
    assert.throws(
        () => stampUnreleased('# Changelog\n\n## Unreleased\n\n## 1.4.0\n', '1.5.0', '2026-08-08'),
        /section is empty/,
    );
    assert.throws(
        () => stampUnreleased('# Changelog\n\n## Unreleased\n\n- One\n\n## Unreleased\n\n- Two\n', '1.5.0', '2026-08-08'),
        /more than one/,
    );
});

test('released changelog sections must remain byte-faithful to their tags', () => {
    const tagged = '# Changelog\n\n## 1.4.0 — 2026-07-13\n\n- Released work.\n';
    const current = '# Changelog\n\n## Unreleased\n\n- New work.\n\n'
        + '## 1.4.0 — 2026-07-13\n\n- Released work.\n';

    assert.doesNotThrow(() => assertReleasedSectionsUnchanged(current, {
        '1.4.0': tagged,
    }));
    assert.throws(
        () => assertReleasedSectionsUnchanged(current.replace('Released work.', 'Rewritten.'), {
            '1.4.0': tagged,
        }),
        /differs from tag/,
    );
    assert.throws(
        () => assertReleasedSectionsUnchanged(current, {
            '1.4.0': '# Changelog\n',
        }),
        /has no changelog section/,
    );
    assert.throws(
        () => assertReleasedSectionsUnchanged('# Changelog\n\n## Unreleased\n', {
            '1.4.0': tagged,
        }),
        /Current changelog has no section/,
    );
});

test('release history authority is the complete exact-semver tag inventory', () => {
    assert.deepEqual(exactReleaseTags([
        'v1.0.0',
        'v1.2.3-rc.1',
        'release-2.0.0',
        'v2.0.0',
        'v01.0.0',
        '',
    ].join('\n')), ['v1.0.0', 'v2.0.0']);
    assert.doesNotThrow(() => requireCompleteHistory('false\n'));
    assert.throws(() => requireCompleteHistory('true\n'), /shallow repository/);
});

test('release history checker rejects a deleted tagged section and shallow history', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'better-peakbagger-history-'));
    const shallowRoot = `${fixtureRoot}-shallow`;
    const script = new URL('../../scripts/check-changelog-history.mjs', import.meta.url).pathname;
    try {
        runGit(fixtureRoot, ['init', '--initial-branch=main']);
        runGit(fixtureRoot, ['config', 'user.name', 'Release Test']);
        runGit(fixtureRoot, ['config', 'user.email', 'release@example.test']);
        await writeFile(
            path.join(fixtureRoot, 'CHANGELOG.md'),
            '# Changelog\n\n## 1.0.0 — 2026-08-01\n\n- First.\n',
        );
        runGit(fixtureRoot, ['add', 'CHANGELOG.md']);
        runGit(fixtureRoot, ['commit', '-m', 'release 1.0.0']);
        runGit(fixtureRoot, ['tag', 'v1.0.0']);

        await writeFile(
            path.join(fixtureRoot, 'CHANGELOG.md'),
            '# Changelog\n\n## Unreleased\n\n- Next.\n',
        );
        const deleted = spawnSync(process.execPath, [script], {
            cwd: fixtureRoot,
            encoding: 'utf8',
        });
        assert.equal(deleted.status, 1);
        assert.match(deleted.stderr, /Current changelog has no section for tagged release 1\.0\.0/);

        runGit(fixtureRoot, ['checkout', '--', 'CHANGELOG.md']);
        await writeFile(
            path.join(fixtureRoot, 'CHANGELOG.md'),
            '# Changelog\n\n## Unreleased\n\n- Next.\n\n## 1.0.0 — 2026-08-01\n\n- First.\n',
        );
        runGit(fixtureRoot, ['add', 'CHANGELOG.md']);
        runGit(fixtureRoot, ['commit', '-m', 'open unreleased']);
        runGit(tmpdir(), ['clone', '--depth', '1', `file://${fixtureRoot}`, shallowRoot]);

        const shallow = spawnSync(process.execPath, [script], {
            cwd: shallowRoot,
            encoding: 'utf8',
        });
        assert.equal(shallow.status, 1);
        assert.match(shallow.stderr, /cannot be verified in a shallow repository/);
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
        await rm(shallowRoot, { recursive: true, force: true });
    }
});

test('release validation requires the proposed tag to resolve to HEAD', () => {
    assert.doesNotThrow(() => validateTagAtHead({
        tag: 'v1.4.0',
        tagCommit: 'abc123',
        headCommit: 'abc123',
    }));
    assert.throws(() => validateTagAtHead({
        tag: 'v1.4.0',
        tagCommit: 'abc123',
        headCommit: 'def456',
    }), /release tag v1\.4\.0 commit/);
    assert.doesNotThrow(() => validateProtectedMainAncestry({
        tag: 'v1.4.0',
        isAncestor: true,
    }));
    assert.throws(() => validateProtectedMainAncestry({
        tag: 'v1.4.0',
        isAncestor: false,
    }), /not integrated into protected origin\/main/);
});

test('release preflight requires a clean synchronized main and unused exact tag', () => {
    const valid = {
        branch: 'main',
        status: '',
        headCommit: 'abc123',
        originMainCommit: 'abc123',
        localTagExists: false,
        remoteTagExists: false,
        tag: 'v1.5.0',
    };
    assert.doesNotThrow(() => validateReleasePreflight(valid));
    assert.throws(
        () => validateReleasePreflight({ ...valid, branch: 'feature' }),
        /must be stamped on main/,
    );
    assert.throws(
        () => validateReleasePreflight({ ...valid, branch: '' }),
        /detached HEAD/,
    );
    assert.throws(
        () => validateReleasePreflight({ ...valid, status: 'M  CHANGELOG.md' }),
        /clean worktree and index/,
    );
    assert.throws(
        () => validateReleasePreflight({ ...valid, headCommit: 'ahead' }),
        /exactly match.*origin\/main/,
    );
    assert.throws(
        () => validateReleasePreflight({ ...valid, localTagExists: true }),
        /already exists locally/,
    );
    assert.throws(
        () => validateReleasePreflight({ ...valid, remoteTagExists: true }),
        /already exists on origin/,
    );
    assert.deepEqual(atomicReleasePushArgs('v1.5.0'), [
        'push', '--atomic', 'origin', 'main', 'refs/tags/v1.5.0',
    ]);
});

test('release dates default explicitly to UTC and accept an owner-supplied date', () => {
    assert.equal(
        resolveReleaseDate(undefined, new Date('2026-08-09T00:30:00Z')),
        '2026-08-09',
    );
    assert.equal(resolveReleaseDate('2026-08-08'), '2026-08-08');
    assert.throws(() => resolveReleaseDate('08/08/2026'), /ISO calendar date/);
    assert.throws(() => resolveReleaseDate('2026-02-31'), /ISO calendar date/);
});

test('release bump dry-run validates without writing or tagging', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'better-peakbagger-release-'));
    const remoteRoot = `${fixtureRoot}-origin`;
    const files = {
        'manifest.json': {
            version: '1.4.0',
            description: 'Fixture',
            browser_specific_settings: { gecko: { id: 'fixture@example.test' } },
        },
        'package.json': { version: '1.4.0', description: 'Fixture' },
        'package-lock.json': {
            version: '1.4.0',
            packages: { '': { version: '1.4.0' } },
        },
    };
    try {
        await Promise.all([
            ...Object.entries(files).map(([name, value]) => writeFile(
                path.join(fixtureRoot, name),
                `${JSON.stringify(value, null, 2)}\n`,
            )),
            writeFile(
                path.join(fixtureRoot, 'CHANGELOG.md'),
                '# Changelog\n\n## Unreleased\n\n- Ready.\n\n## 1.4.0\n\n- Old.\n',
            ),
        ]);
        runGit(fixtureRoot, ['init', '--initial-branch=main']);
        runGit(fixtureRoot, ['config', 'user.name', 'Release Test']);
        runGit(fixtureRoot, ['config', 'user.email', 'release@example.test']);
        runGit(fixtureRoot, ['add', '.']);
        runGit(fixtureRoot, ['commit', '-m', 'fixture release']);
        runGit(tmpdir(), ['init', '--bare', remoteRoot]);
        runGit(fixtureRoot, ['remote', 'add', 'origin', remoteRoot]);
        runGit(fixtureRoot, ['push', '--set-upstream', 'origin', 'main']);
        const before = await Promise.all([
            ...Object.keys(files).map((name) => readFile(path.join(fixtureRoot, name), 'utf8')),
            readFile(path.join(fixtureRoot, 'CHANGELOG.md'), 'utf8'),
        ]);
        const result = spawnSync(
            process.execPath,
            [
                new URL('../../scripts/release-bump.mjs', import.meta.url).pathname,
                '1.5.0',
                '--dry-run',
                '--date',
                '2026-08-08',
            ],
            { cwd: fixtureRoot, encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /ready to stamp/);
        const after = await Promise.all([
            ...Object.keys(files).map((name) => readFile(path.join(fixtureRoot, name), 'utf8')),
            readFile(path.join(fixtureRoot, 'CHANGELOG.md'), 'utf8'),
        ]);
        assert.deepEqual(after, before);
        assert.equal(runGit(fixtureRoot, ['tag', '--list']), '');
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
        await rm(remoteRoot, { recursive: true, force: true });
    }
});

test("Firefox metadata preserves the project's or-later license grant", async () => {
    const packageLock = JSON.parse(await readFile(
        new URL('../../package-lock.json', import.meta.url),
        'utf8',
    ));
    const dependencyVersions = dependencyVersionsFromLock(packageLock);
    const metadata = buildAmoMetadata({
        licenseText: 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3',
        description: 'Better Peakbagger streamlines trip planning.\n\ncoordinate corridor boxes\nWaypoint coordinates and names are included by default',
        dependencyVersions,
    });
    assert.throws(() => buildAmoMetadata({
        licenseText: 'license',
        description: 'description',
        dependencyVersions: {},
    }), /Resolved dependency versions/);
    assert.deepEqual(metadata.categories, ['other']);
    assert.deepEqual(metadata.version.compatibility, ['firefox']);
    assert.match(metadata.version.custom_license.name['en-US'], /or later/);
    assert.match(metadata.version.custom_license.text['en-US'], /at your option/);
    assert.match(metadata.version.custom_license.text['en-US'], /GNU AFFERO/);
    for (const [label, key] of [
        ['esbuild', 'esbuild'],
        ['Chart.js', 'chart'],
        ['Marked', 'marked'],
        ['MapLibre GL JS', 'maplibre'],
        ['tz-lookup', 'tzLookup'],
    ]) {
        assert.ok(metadata.version.approval_notes.includes(`${label} ${dependencyVersions[key]}`),
            `approval notes must name locked ${label} ${dependencyVersions[key]}`);
    }
    assert.match(metadata.version.approval_notes, /maplibre-gl\.mjs/);
    assert.match(metadata.version.approval_notes, /maplibre-gl-worker\.mjs/);
    assert.match(metadata.version.approval_notes, /imported directly by the native terrain-frame module/);
    assert.match(metadata.version.approval_notes, /THIRD_PARTY_NOTICES\.txt/);
    assert.match(metadata.version.approval_notes,
        /Runtime source under options\/, photos\/, popup\/, src\//,
        'reviewer notes must derive every authored runtime root from the build graph');
    assert.match(metadata.version.approval_notes, /CodeMirror\/Lezer/);
    assert.match(metadata.version.approval_notes, /TipTap\/ProseMirror/);
    assert.match(metadata.version.approval_notes, /TipTap core 3\.29\.2/);
    assert.match(metadata.version.approval_notes, /ProseMirror view 1\.42\.1/);
    assert.doesNotMatch(metadata.version.approval_notes, /build-free|@photostructure/);
    assert.match(metadata.version.approval_notes, /tiles\.mapterhorn\.com/);
    assert.match(metadata.version.approval_notes,
        new RegExp(`parks a loaded renderer idle and non-interactive for up to ${
            TERRAIN_FRAME_KEEP_ALIVE_MS / 60_000} minutes`));
    assert.match(metadata.version.approval_notes, /the renderer is destroyed/);
    assert.doesNotMatch(metadata.version.approval_notes, /Returning to 2D destroys the renderer/);
    assert.match(metadata.description['en-US'], /coordinate corridor boxes/);
    assert.match(metadata.description['en-US'], /Waypoint coordinates and names are included by default/);
});

test('every bundle entry belongs to an AMO-declared authored source root', () => {
    assert.deepEqual(AUTHORED_SOURCE_ROOTS, ['options', 'photos', 'popup', 'src']);
    for (const entry of ENTRIES) {
        for (const source of entrySources(entry)) {
            const relative = path.relative(root, source);
            assert.ok(!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
                `${entry.out} source must stay inside the repository: ${source}`);
            assert.ok(AUTHORED_SOURCE_ROOTS.includes(relative.split(path.sep)[0]),
                `${entry.out} source root must be declared for AMO reviewers: ${relative}`);
        }
    }
});

async function makeReleaseZip(extraFiles = {}, omittedFiles = []) {
    const zip = new JSZip();
    const omitted = new Set(omittedFiles);
    const expectedFiles = await expectedReleaseFiles();
    const files = {
        ...Object.fromEntries(expectedFiles.map((out) => [out, `runtime:${out}`])),
        'manifest.json': JSON.stringify({
            version: '1.4.0',
            options_ui: {
                page: 'options/options.html',
                open_in_tab: true,
            },
        }),
        ...extraFiles,
    };
    for (const [name, contents] of Object.entries(files)) {
        if (!omitted.has(name)) {
            zip.file(name, contents);
        }
    }
    return zip.generateAsync({ type: 'uint8array' });
}

test('release and browser development commands use the dist build', async () => {
    const [packageJson, workflow, releaseBump] = await Promise.all([
        readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
        readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
        readFile(new URL('../../scripts/release-bump.mjs', import.meta.url), 'utf8'),
    ]);

    assert.match(packageJson.scripts.package, /build:release.*--source-dir dist/);
    assert.equal(packageJson.scripts.start, 'node scripts/run-development.mjs');
    assert.match(packageJson.scripts.test, /^npm run build && node --test /);
    assert.match(packageJson.scripts['test:scale'], /^npm run build && node --test /);
    assert.match(
        workflow,
        /- name: Build store packages[\s\S]*?npm run package[\s\S]*?chrome_archive=/,
    );
    assert.match(
        workflow,
        /verify:\s*\n\s+name: Verify release[\s\S]{0,400}runs-on: macos-15-intel/,
        'current-Chrome package verification must not run on hosted Linux',
    );
    assert.match(workflow, /- name: Run scale tests\s+run: npm run test:scale/);
    assert.match(
        workflow,
        /- name: Check out tagged source\s+uses: [^\n]+\s+with:\s+fetch-depth: 0/,
    );
    assert.match(workflow, /git fetch --no-tags origin \+refs\/heads\/main:/);
    assert.match(
        workflow,
        /release:check -- "\$GITHUB_REF_NAME" --require-protected-main/,
    );
    assert.match(packageJson.scripts.lint, /^eslint .*npm run build.*check-web-ext-lint/);
    assert.match(workflow, /run: npm run lint\n/);
    assert.doesNotMatch(releaseBump, /exec(?:File)?Sync\([^\n]*git[^\n]*tag/);
    assert.doesNotMatch(releaseBump, /push origin main --tags/);
});

test('bare web-ext commands use only the dist build', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(packageJson.webExt.sourceDir, 'dist');
    assert.equal('ignoreFiles' in packageJson.webExt, false);
});

test('CI tests, lints, and exercises both real browser extensions', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
    // The single public lint command runs both source ESLint and built-package
    // web-ext lint; keeping that composition in package.json prevents CI and
    // release callers from accidentally selecting only one half.
    assert.match(workflow, /node:\s*\n[\s\S]*?run: npm run audit:ci[\s\S]*?run: npm test[\s\S]*?run: npm run lint\n/);
    assert.match(workflow, /scale:\s*\n[\s\S]*?run: npm run test:scale/);
    assert.match(workflow, /chrome:\s*\n[\s\S]*?run: npm run verify:chrome/);
    assert.match(
        workflow,
        /chrome:\s*\n\s+name: Chrome extension smoke[\s\S]{0,500}runs-on: macos-15-intel/,
        'current Chrome must use the standard Intel macOS runner',
    );
    assert.match(workflow, /firefox:\s*\n[\s\S]*?run: npm run verify:firefox/);
    assert.match(workflow, /chrome-floor:\s*\n[\s\S]*?chrome-version: 128/);
    assert.match(workflow, /firefox:\s*\n[\s\S]*?"152\.0"[\s\S]*?- latest/);
    assert.match(workflow, /CHROME_BIN: \$\{\{ steps\.chrome-floor\.outputs\.chrome-path \}\}/);
    assert.match(workflow, /FIREFOX_BIN: \$\{\{ steps\.firefox\.outputs\.firefox-path \}\}/);
    assert.equal(workflow.match(/run: npm ci/g)?.length, 5);
    assert.match(workflow, /permissions:\s*\n\s+contents: read/);
    assert.match(workflow, /fetch-depth: 0[\s\S]*?run: npm run release:check-history/);
    await assert.rejects(
        lstat(new URL('../../.github/workflows/ci.yml', import.meta.url)),
        { code: 'ENOENT' },
    );
});

test('release publication waits for packaged declared-browser-floor verification', async () => {
    const workflow = await readFile(
        new URL('../../.github/workflows/release.yml', import.meta.url),
        'utf8',
    );
    assert.match(workflow, /compatibility:\s*\n[\s\S]*?browser: chrome\s+version: "128"/);
    assert.match(workflow, /browser: firefox\s+version: "152\.0"/);
    assert.match(workflow, /BPB_VERIFY_EXTENSION_SOURCE=floor-extension node scripts\/verify-extension\.mjs/);
    assert.match(workflow, /node scripts\/verify-firefox-extension\.mjs/);
    assert.equal(workflow.match(/needs: \[verify, compatibility\]/g)?.length, 2);
});

test('Chrome verifier accepts an exact externally installed floor binary', async () => {
    const verifier = await readFile(
        new URL('../../scripts/verify-extension.mjs', import.meta.url),
        'utf8',
    );
    assert.match(verifier, /process\.env\.CHROME_BIN/);
    assert.match(verifier, /chromeBinary \? \{ executablePath: chromeBinary \}/);
    assert.match(verifier, /const backgroundShortcut = process\.platform === 'darwin' \? 'Meta\+Enter' : 'Control\+Enter'/,
        'background-tab disposition must use a real modified keyboard activation in hidden Chrome');
    assert.match(verifier, /keyboard\.press\('Shift\+Enter'\)/,
        'new-window disposition must use a real modified keyboard activation in hidden Chrome');
    const analyzerStart = verifier.indexOf('const openAscent =');
    assert.ok(analyzerStart > verifier.indexOf("locator('#units').selectOption('imperial')"),
        'the Chrome verifier must pin imperial units before asserting the exact Capitol signature');
});

test('Firefox verification waits for rendered postconditions instead of fixed frames', async () => {
    const verifier = await readFile(
        new URL('../../scripts/verify-firefox-extension.mjs', import.meta.url),
        'utf8',
    );
    const start = verifier.indexOf('const surfaceState =');
    const end = verifier.indexOf('const terrainToggle =', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const analyzerProbe = verifier.slice(start, end);

    assert.match(analyzerProbe, /await waitForScript\(driver,/);
    assert.match(analyzerProbe, /ready: state\.analyzer/);
    assert.ok(analyzerProbe.includes('Interactive Stats: 17\\\\.53 miles'),
        'the Firefox verifier must wait for the exact Capitol metric signature');
    assert.match(analyzerProbe,
        /state\.chart\?\.pointCounts\?\.join\("\|"\) === "971\|971"/);
    assert.match(analyzerProbe,
        /state\.chart\?\.breakCounts\?\.join\("\|"\) === "0\|0"/);
    assert.match(analyzerProbe, /state => state\?\.ready/);
    assert.doesNotMatch(analyzerProbe, /until\.elementLocated/);

    const terrainStart = verifier.indexOf('const activeTerrainState =');
    const terrainEnd = verifier.indexOf('const ascentFrameOrigin =', terrainStart);
    assert.notEqual(terrainStart, -1);
    assert.notEqual(terrainEnd, -1);
    const terrainProbe = verifier.slice(terrainStart, terrainEnd);
    assert.match(terrainProbe, /await waitForScript\(driver,/);
    assert.match(terrainProbe, /frames\.length === 1 && origin\.startsWith\('moz-extension:\/\/'\)/);
    assert.doesNotMatch(terrainProbe, /until\.elementLocated/);

    const navigationStart = verifier.indexOf('const longDistanceAfter =');
    const navigationEnd = verifier.indexOf('const longDistanceNavigation =', navigationStart);
    assert.notEqual(navigationStart, -1);
    assert.notEqual(navigationEnd, -1);
    const navigationProbe = verifier.slice(navigationStart, navigationEnd);

    assert.match(navigationProbe, /await waitForScript\(driver,/);
    assert.match(navigationProbe, /ready: Math\.abs\(state\.distance\) <= 2/);
    assert.match(navigationProbe, /state => state\?\.ready/);
    assert.doesNotMatch(navigationProbe, /requestAnimationFrame/);
});

test('Firefox topo actions re-center overlay and controls before interaction', async () => {
    const verifier = await readFile(
        new URL('../../scripts/verify-firefox-extension.mjs', import.meta.url),
        'utf8',
    );
    const helperStart = verifier.indexOf('const clickOverlay =');
    const helperEnd = verifier.indexOf("await driver.findElement(By.css('[data-tool=\"route\"]'))", helperStart);
    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);
    const pointerHelper = verifier.slice(helperStart, helperEnd);

    const scrollIndex = pointerHelper.indexOf('scrollIntoView');
    const moveIndex = pointerHelper.indexOf('.move({ origin: overlay, x, y })');
    assert.notEqual(scrollIndex, -1);
    assert.notEqual(moveIndex, -1);
    assert.ok(scrollIndex < moveIndex);
    assert.match(pointerHelper, /block: 'center'/);
    assert.match(pointerHelper, /const clickEditorControl = async element/);
    assert.match(verifier,
        /clickEditorControl\(await driver\.findElement\(By\.css\('\[data-tool="anchor"\]'\)\)\)/);
});

test('Firefox startup retry targets only a clean exit and verifier-owned profiles', async () => {
    assert.equal(isRetryableFirefoxStartup({
        message: 'Process (pid=123) unexpectedly closed with status 0',
    }), true);
    assert.equal(isRetryableFirefoxStartup({
        message: 'Process (pid=123) unexpectedly closed with status 1',
    }), false);
    assert.equal(isRetryableFirefoxStartup(new Error('Timed out waiting for Firefox')), false);

    const processList = `
  100 /Applications/Firefox.app/Contents/MacOS/firefox -profile /Users/test/default
  200 /Applications/Firefox.app/Contents/MacOS/firefox -profile /tmp/better-peakbagger-firefox-verify-owned/rust_mozprofileA
  201 /Applications/Firefox.app/Contents/MacOS/plugin-container -profile /tmp/better-peakbagger-firefox-verify-owned/rust_mozprofileA
  300 /Applications/Firefox.app/Contents/MacOS/firefox -profile /tmp/better-peakbagger-firefox-verify-other/rust_mozprofileB
`;
    assert.deepEqual(
        ownedFirefoxPids(processList, '/tmp/better-peakbagger-firefox-verify-owned'),
        [200, 201],
    );

    const verifier = await readFile(
        new URL('../../scripts/verify-firefox-extension.mjs', import.meta.url),
        'utf8',
    );
    assert.match(verifier, /`--profile-root=\$\{profileRoot\}`/);
    assert.match(verifier, /catch \(error\) \{\s+await stopOwnedFirefoxProcesses\(profileRoot\)/);
    const finalCleanup = verifier.lastIndexOf('await stopOwnedFirefoxProcesses(temporaryRoot)');
    const temporaryRemoval = verifier.lastIndexOf('await rm(temporaryRoot');
    assert.notEqual(finalCleanup, -1);
    assert.ok(finalCleanup < temporaryRemoval,
        'verifier-owned Firefox must stop before its temporary profile is removed');
});

test('release archive rejects development and internal files', async () => {
    await assert.doesNotReject(
        verifyReleaseArchive(await makeReleaseZip(), '1.4.0'),
    );
    await assert.rejects(
        verifyReleaseArchive(await makeReleaseZip({ 'test/private-fixture.html': 'no' }), '1.4.0'),
        /unexpected (?:file|directory): test\//,
    );
    await assert.rejects(
        verifyReleaseArchive(await makeReleaseZip(), '1.4.1'),
        /does not match/,
    );
});

test('release archive rejects extra files under every shipped directory', async () => {
    const directories = new Set(
        (await expectedReleaseFiles())
            .map((file) => path.posix.dirname(file))
            .filter((directory) => directory !== '.'),
    );
    for (const directory of directories) {
        const extra = `${directory}/private-source.map`;
        await assert.rejects(
            verifyReleaseArchive(await makeReleaseZip({ [extra]: 'source map' }), '1.4.0'),
            new RegExp(`unexpected file: ${extra.replaceAll('.', '\\.').replaceAll('/', '\\/')}`),
        );
    }
});

test('release archive rejects non-canonical, duplicate, and conflicting paths', () => {
    assert.throws(
        () => validateArchiveEntries([{ name: 'content\\private.js', directory: false }], []),
        /non-canonical path/,
    );
    assert.throws(
        () => validateArchiveEntries([{ name: 'content/../private.js', directory: false }], []),
        /non-canonical path/,
    );
    assert.throws(
        () => validateArchiveEntries([
            { name: 'content/runtime.js', directory: false },
            { name: 'content/runtime.js', directory: false },
        ], ['content/runtime.js']),
        /duplicate path/,
    );
    assert.throws(
        () => validateArchiveEntries([
            { name: 'content', directory: false },
            { name: 'content/runtime.js', directory: false },
        ], ['content/runtime.js']),
        /file\/directory conflict/,
    );
    assert.throws(
        () => validateArchiveEntries([{ name: '__MACOSX/._manifest.json', directory: false }], []),
        /platform metadata/,
    );
});

test('Firefox package embeds options without changing its canonical Chrome package', async () => {
    const sourceBytes = await makeReleaseZip();
    const firefoxBytes = await buildFirefoxPackage(sourceBytes);
    const [sourceArchive, firefoxArchive] = await Promise.all([
        JSZip.loadAsync(sourceBytes),
        JSZip.loadAsync(firefoxBytes),
    ]);
    const [sourceManifest, firefoxManifest] = await Promise.all([
        sourceArchive.file('manifest.json').async('string').then(JSON.parse),
        firefoxArchive.file('manifest.json').async('string').then(JSON.parse),
    ]);

    assert.deepEqual(Object.keys(firefoxArchive.files), Object.keys(sourceArchive.files));
    for (const [name, sourceEntry] of Object.entries(sourceArchive.files)) {
        if (name === 'manifest.json' || sourceEntry.dir) continue;
        assert.deepEqual(
            await firefoxArchive.file(name).async('uint8array'),
            await sourceEntry.async('uint8array'),
            `${name} must be unchanged in the Firefox package`,
        );
    }
    assert.equal(sourceManifest.options_ui.open_in_tab, true);
    assert.equal(firefoxManifest.options_ui.open_in_tab, false);
    await assert.doesNotReject(
        verifyReleaseArchive(sourceBytes, '1.4.0', 'chrome'),
    );
    await assert.doesNotReject(
        verifyReleaseArchive(firefoxBytes, '1.4.0', 'firefox'),
    );
    await assert.rejects(
        verifyReleaseArchive(sourceBytes, '1.4.0', 'firefox'),
        /firefox release options must open in the add-on manager/,
    );
});

test('Firefox package builder rejects a non-canonical source package', async () => {
    const sourceBytes = await makeReleaseZip({
        'manifest.json': JSON.stringify({
            version: '1.4.0',
            options_ui: {
                page: 'options/options.html',
                open_in_tab: false,
            },
        }),
    });
    await assert.rejects(
        buildFirefoxPackage(sourceBytes),
        /Canonical manifest must declare a full-tab options_ui page/,
    );
});

test('Firefox development source copies runtime files while overriding only the manifest', async () => {
    const prepared = await prepareFirefoxSource();
    try {
        const manifest = JSON.parse(
            await readFile(path.join(prepared.sourceDir, 'manifest.json'), 'utf8'),
        );
        const canonicalManifest = JSON.parse(
            await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'),
        );
        assert.deepEqual(manifest, createFirefoxManifest(canonicalManifest));
        for (const directory of ['content', 'css', 'icons', 'options', 'popup', 'terrain', 'vendor']) {
            assert.equal(
                (await lstat(path.join(prepared.sourceDir, directory))).isDirectory(),
                true,
            );
        }
    } finally {
        await prepared.cleanup();
    }
});

test('release archive requires third-party acknowledgements', async () => {
    await assert.rejects(
        verifyReleaseArchive(
            await makeReleaseZip({}, ['ACKNOWLEDGEMENTS.md']),
            '1.4.0',
        ),
        /missing required file: ACKNOWLEDGEMENTS\.md/,
    );
});

test('release archive requires the generated third-party notice inventory', async () => {
    await assert.rejects(
        verifyReleaseArchive(
            await makeReleaseZip({}, ['THIRD_PARTY_NOTICES.txt']),
            '1.4.0',
        ),
        /missing required file: THIRD_PARTY_NOTICES\.txt/,
    );
});

test('generated notices cover the real editor and copied runtime graph', async () => {
    const [notices, packageLock, acknowledgements, reportEditorDocs, licenseText, description] =
        await Promise.all([
            readFile(new URL('../../dist/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8'),
            readFile(new URL('../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
            readFile(new URL('../../ACKNOWLEDGEMENTS.md', import.meta.url), 'utf8'),
            readFile(new URL('../../docs/trip-report-editor.md', import.meta.url), 'utf8'),
            readFile(new URL('../../LICENSE', import.meta.url), 'utf8'),
            readFile(new URL('../../store-assets/description.md', import.meta.url), 'utf8'),
        ]);
    const components = [...notices.matchAll(/^Component: (.+)$/gm)].map((match) => match[1]);
    const packageRoots = [...notices.matchAll(/^Package root: (.+)$/gm)].map((match) => match[1]);
    const hashes = [...notices.matchAll(/^Notice SHA-256: ([a-f0-9]{64})$/gm)]
        .map((match) => match[1]);

    assert.ok(components.length > 40, 'the shipped editor graph must not collapse to top-level packages');
    assert.equal(packageRoots.length, components.length);
    assert.equal(new Set(packageRoots).size, packageRoots.length);
    assert.equal(hashes.length, components.length);
    for (const required of [
        '@codemirror/view',
        '@lezer/markdown',
        '@tiptap/core',
        'prosemirror-state',
        'chart.js',
        'maplibre-gl',
        'marked',
        'tz-lookup',
        'BetaCreator symbol geometry',
    ]) {
        assert.ok(components.includes(required), `missing notice for ${required}`);
    }

    const approvalNotes = buildAmoMetadata({
        licenseText,
        description,
        dependencyVersions: dependencyVersionsFromLock(packageLock),
    }).version.approval_notes;
    assert.doesNotThrow(() => validateReviewedDependencyMetadata({
        packageLock,
        approvalNotes,
        acknowledgements,
        reportEditorDocs,
        warningBaseline: WEB_EXT_WARNING_BASELINE,
        noticeInventory: notices,
    }));

    const driftedLock = structuredClone(packageLock);
    driftedLock.packages['node_modules/marked'].version = '18.1.0';
    assert.throws(() => validateReviewedDependencyMetadata({
        packageLock: driftedLock,
        approvalNotes,
        acknowledgements,
        reportEditorDocs,
        warningBaseline: WEB_EXT_WARNING_BASELINE,
        noticeInventory: notices,
    }), /AMO approval notes must name only Marked 18\.1\.0/);
});

test('notice generation fails closed for missing package metadata or notice text', () => {
    const complete = {
        key: 'node_modules/example',
        name: 'example',
        version: '1.0.0',
        license: 'MIT',
        licenseSource: 'node_modules/example/package.json',
        notices: [{ name: 'LICENSE', text: 'Permission is granted.' }],
    };
    assert.equal(validatePackageNoticeMetadata(complete), complete);
    assert.throws(
        () => validatePackageNoticeMetadata({ ...complete, license: '' }),
        /incomplete name, version, license, or license-source metadata/,
    );
    assert.throws(
        () => validatePackageNoticeMetadata({ ...complete, notices: [] }),
        /no resolved license or notice file/,
    );
    assert.throws(
        () => validatePackageNoticeMetadata({
            ...complete,
            notices: [{ name: 'LICENSE', text: '' }],
        }),
        /empty license or notice file/,
    );
});

test('release archive requires every MapLibre main and module-worker artifact', async () => {
    for (const required of [
        'vendor/maplibre-gl.mjs',
        'vendor/maplibre-gl-worker.mjs',
        'vendor/maplibre-gl-shared.mjs'
    ]) {
        await assert.rejects(
            verifyReleaseArchive(await makeReleaseZip({}, [required]), '1.4.0'),
            new RegExp(`missing required file: ${required.replaceAll('.', '\\.').replaceAll('/', '\\/')}`),
        );
    }
});

test('release archive verification requires an explicit browser', () => {
    assert.deepEqual(requireArchiveArguments(['release.zip', 'firefox']), {
        archivePath: 'release.zip',
        browser: 'firefox',
    });
    assert.throws(() => requireArchiveArguments(['release.zip']), /Usage:/);
    assert.throws(
        () => requireArchiveArguments(['release.zip', 'safari']),
        /Usage:/,
    );
});

test('Firefox package builder requires distinct input and output paths', () => {
    assert.deepEqual(requirePackagePaths(['source.zip', 'firefox.zip']), {
        sourcePath: 'source.zip',
        firefoxPath: 'firefox.zip',
    });
    assert.throws(() => requirePackagePaths(['source.zip']), /Usage:/);
    assert.throws(
        () => requirePackagePaths(['source.zip', './source.zip']),
        /must differ/,
    );
});

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function submittedStatus(version = '1.4.0', state = 'PENDING_REVIEW') {
    return {
        submittedItemRevisionStatus: {
            state,
            distributionChannels: [{ crxVersion: version }],
        },
    };
}

function chromeArguments(overrides = {}) {
    return {
        token: 'test-token',
        publisherId: 'publisher-123',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        packageBytes: new Uint8Array([1, 2, 3]),
        expectedVersion: '1.4.0',
        pollIntervalMs: 0,
        ...overrides,
    };
}

test('Chrome publisher waits for upload processing before publishing', async () => {
    const calls = [];
    const responses = [
        jsonResponse({}),
        jsonResponse({ uploadState: 'IN_PROGRESS' }),
        jsonResponse({ lastAsyncUploadState: 'SUCCEEDED' }),
        jsonResponse({ state: 'PENDING_REVIEW' }),
        jsonResponse(submittedStatus()),
    ];
    const result = await publishChrome(chromeArguments({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
    }));

    assert.equal(result.uploadedVersion, '1.4.0');
    assert.equal(calls.length, 5);
    assert.match(calls[0].url, /:fetchStatus$/);
    assert.match(calls[1].url, /\/upload\/v2\/publishers\/publisher-123\/items\//);
    assert.match(calls[2].url, /:fetchStatus$/);
    assert.match(calls[3].url, /:publish$/);
    assert.match(calls[4].url, /:fetchStatus$/);
    assert.deepEqual(JSON.parse(calls[3].options.body), {
        publishType: 'DEFAULT_PUBLISH',
        blockOnWarnings: true,
    });
});

test('Chrome publisher fails closed and never publishes a failed upload', async () => {
    const calls = [];
    await assert.rejects(
        publishChrome(chromeArguments({
            fetchImpl: async (url) => {
                calls.push(url);
                return calls.length === 1
                    ? jsonResponse({})
                    : jsonResponse({ uploadState: 'FAILED' });
            },
        })),
        /upload did not succeed/,
    );
    assert.equal(calls.length, 2);
});

test('Chrome publisher rejects an invalid configured extension ID', async () => {
    await assert.rejects(
        publishChrome(chromeArguments({ extensionId: 'not-an-extension-id' })),
        /32-character Chrome extension ID/,
    );
});

test('Chrome publisher treats store warnings as a failed release', async () => {
    const responses = [
        jsonResponse({}),
        jsonResponse({ uploadState: 'SUCCEEDED', crxVersion: '1.4.0' }),
        jsonResponse({
            state: 'PENDING_REVIEW',
            warningInfo: { warnings: [{ description: 'Listing needs attention' }] },
        }),
    ];
    await assert.rejects(
        publishChrome(chromeArguments({ fetchImpl: async () => responses.shift() })),
        /Listing needs attention/,
    );
});

test('Chrome publisher checks for a consumed or ambiguous version before upload', async () => {
    for (const [status, message] of [
        [{
            publishedItemRevisionStatus: {
                distributionChannels: [{ crxVersion: '1.4.0' }],
            },
        }, /already published/],
        [submittedStatus('1.3.0'), /already has submitted version/],
        [{
            submittedItemRevisionStatus: {
                state: 'PENDING_REVIEW',
                distributionChannels: [],
            },
        }, /without distribution-channel version evidence/],
        [{ lastAsyncUploadState: 'UPLOAD_SUCCEEDED' }, /Inspect its version/],
    ]) {
        const calls = [];
        await assert.rejects(
            publishChrome(chromeArguments({
                fetchImpl: async (url) => {
                    calls.push(url);
                    return jsonResponse(status);
                },
            })),
            message,
        );
        assert.equal(calls.length, 1);
        assert.match(calls[0], /:fetchStatus$/);
    }
});

test('Chrome publisher treats an already reconciled expected submission as success', async () => {
    const calls = [];
    const result = await publishChrome(chromeArguments({
        fetchImpl: async (url) => {
            calls.push(url);
            return jsonResponse(submittedStatus());
        },
    }));

    assert.equal(result.uploadedVersion, '1.4.0');
    assert.equal(result.publishState, 'PENDING_REVIEW');
    assert.equal(result.reconciled, true);
    assert.equal(calls.length, 1);
});

test('Chrome publisher requires the expected remote submitted revision', async () => {
    for (const [status, message] of [
        [submittedStatus('1.3.0'), /submitted version\(s\) 1\.3\.0; expected 1\.4\.0/],
        [{
            submittedItemRevisionStatus: {
                state: 'PENDING_REVIEW',
                distributionChannels: [],
            },
        }, /no distribution-channel version/],
        [{ lastAsyncUploadState: 'UPLOAD_SUCCEEDED' }, /no submitted revision was visible/],
        [submittedStatus('1.4.0', 'REJECTED'), /unexpected state REJECTED/],
    ]) {
        const responses = [
            jsonResponse({}),
            jsonResponse({ uploadState: 'SUCCEEDED' }),
            jsonResponse({ state: 'PENDING_REVIEW' }),
            jsonResponse(status),
        ];
        await assert.rejects(
            publishChrome(chromeArguments({
                fetchImpl: async () => responses.shift(),
                maxPolls: 1,
            })),
            message,
        );
        assert.equal(responses.length, 0);
    }
});

test('Chrome publisher bounds headers, bodies, and malformed responses', async () => {
    await assert.rejects(
        publishChrome(chromeArguments({
            fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
            requestTimeoutMs: 5,
        })),
        error => error instanceof ChromeWebStoreRequestError
            && error.code === 'deadline-exceeded'
            && error.phase === 'preflight'
            && /:fetchStatus$/.test(error.endpoint),
    );

    await assert.rejects(
        publishChrome(chromeArguments({
            fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
            requestTimeoutMs: 5,
        })),
        error => error instanceof ChromeWebStoreRequestError
            && error.code === 'deadline-exceeded'
            && error.phase === 'preflight',
    );

    await assert.rejects(
        publishChrome(chromeArguments({
            fetchImpl: async () => new Response('x'.repeat(65), {
                status: 500,
                headers: { 'Content-Length': '65' },
            }),
            maxResponseBytes: 64,
        })),
        error => error instanceof ChromeWebStoreRequestError
            && error.code === 'response-too-large'
            && error.status === 500,
    );

    await assert.rejects(
        publishChrome(chromeArguments({
            fetchImpl: async () => new Response('{not json'),
        })),
        error => error instanceof ChromeWebStoreRequestError
            && error.code === 'malformed-json'
            && error.phase === 'preflight',
    );
});

test('Chrome publisher clears every request deadline', async () => {
    let scheduled = 0;
    let cleared = 0;
    const responses = [jsonResponse({}), jsonResponse({ uploadState: 'FAILED' })];
    await assert.rejects(
        publishChrome(chromeArguments({
            fetchImpl: async () => responses.shift(),
            setTimeoutImpl: () => {
                scheduled += 1;
                return scheduled;
            },
            clearTimeoutImpl: () => { cleared += 1; },
        })),
        /upload did not succeed/,
    );
    assert.equal(scheduled, 2);
    assert.equal(cleared, scheduled);
});

test('Chrome publisher reconciles an upload timeout without replaying the mutation', async () => {
    const calls = [];
    const result = await publishChrome(chromeArguments({
        fetchImpl: async (url, { signal } = {}) => {
            calls.push(url);
            if (calls.length === 1) return jsonResponse({});
            if (calls.length === 2) {
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }
            return jsonResponse(submittedStatus());
        },
        requestTimeoutMs: 5,
    }));

    assert.equal(result.uploadedVersion, '1.4.0');
    assert.equal(result.reconciled, true);
    assert.equal(calls.filter(url => url.includes(':upload')).length, 1);
    assert.equal(calls.filter(url => url.includes(':publish')).length, 0);
});

test('Chrome publisher reconciles a publish timeout without replaying the mutation', async () => {
    const calls = [];
    const result = await publishChrome(chromeArguments({
        fetchImpl: async (url, { signal } = {}) => {
            calls.push(url);
            if (calls.length === 1) return jsonResponse({});
            if (calls.length === 2) {
                return jsonResponse({ uploadState: 'SUCCEEDED', crxVersion: '1.4.0' });
            }
            if (calls.length === 3) {
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }
            return jsonResponse(submittedStatus());
        },
        requestTimeoutMs: 5,
    }));

    assert.equal(result.uploadedVersion, '1.4.0');
    assert.equal(result.publishState, 'PENDING_REVIEW');
    assert.equal(calls.filter(url => url.includes(':publish')).length, 1);
});

test('Chrome publisher stops after an unreconciled mutation timeout', async () => {
    const calls = [];
    await assert.rejects(
        publishChrome(chromeArguments({
            fetchImpl: async (url, { signal } = {}) => {
                calls.push(url);
                if (calls.length === 1) return jsonResponse({});
                if (calls.length === 2) {
                    return new Promise((resolve, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                    });
                }
                return jsonResponse({ lastAsyncUploadState: 'UPLOAD_SUCCEEDED' });
            },
            requestTimeoutMs: 5,
        })),
        /outcome is unknown.*not replayed/,
    );
    assert.equal(calls.filter(url => url.includes(':upload')).length, 1);
    assert.equal(calls.filter(url => url.includes(':publish')).length, 0);
});
