// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { satisfies } from 'semver';

import {
    evaluateAudit,
} from '../../scripts/check-npm-audit.mjs';

const auditWith = (vulnerabilities, counts = {}) => ({
    metadata: {
        vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: Object.keys(vulnerabilities).length,
            critical: 0,
            total: Object.keys(vulnerabilities).length,
            ...counts,
        },
    },
    vulnerabilities,
});

test('the npm audit gate passes a clean tree', () => {
    assert.deepEqual(evaluateAudit(auditWith({})), { status: 'clean' });
});

test('the npm audit gate rejects every finding, including the former exception', () => {
    for (const name of ['image-size', 'some-dev-tool']) {
        assert.throws(() => evaluateAudit(auditWith({ [name]: { severity: 'high' } })),
            /Unowned npm audit findings/);
    }
    assert.throws(() => evaluateAudit(auditWith({}, { total: 3 })), /missing vulnerability detail/);
    assert.throws(() => evaluateAudit(auditWith({ unexpected: {} }, { total: 0 })), /unexpected/);
});

test('the npm audit gate fails closed on unusable audit output', () => {
    for (const audit of [null, {}, { metadata: {} }, { metadata: { vulnerabilities: {} } },
        auditWith({}, { total: -1 }), auditWith({}, { total: NaN })]) {
        assert.throws(() => evaluateAudit(audit), /no usable vulnerability metadata/);
    }
});

// The override that removed the last accepted advisory. Scoped to minimatch@^3
// so it cannot reach the brace-expansion 5.x that eslint resolves; dropping it
// would silently reintroduce a vulnerable dev-only install path.
test('the vulnerable dev-only brace-expansion path stays pinned to a patched release', async () => {
    const [packageJson, lockfile] = await Promise.all([
        readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
        readFile(new URL('../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    assert.deepEqual(packageJson.overrides['minimatch@^3.0.0'], { 'brace-expansion': '1.1.21' });

    const entry = lockfile.packages['node_modules/brace-expansion'];
    assert.equal(entry.version, '1.1.21');
    assert.equal(entry.dev, true, 'brace-expansion must never become a production dependency');
    const patchedRange = '^1.1.21 || ^5.0.12';
    for (const [packagePath, resolved] of Object.entries(lockfile.packages)) {
        if (!packagePath.endsWith('node_modules/brace-expansion')) continue;
        assert.equal(resolved.dev, true, `${packagePath} must stay development-only`);
        assert.ok(satisfies(resolved.version, patchedRange),
            `${packagePath} resolves ${resolved.version}, not a reviewed patched version`);
    }
});

// Floors prevent known regressions; compatible patched releases must not need
// a test edit. The separate live audit still rejects newly disclosed advisories.
const patchedTools = {
    'web-ext': '^10.7.0', 'addons-linter': '^10.13.0', 'image-size': '^2.0.4',
    'adm-zip': '^0.6.1', 'js-yaml': '^4.3.2', 'fast-uri': '^3.1.8',
    'shell-quote': '^1.12.0',
};
const checkPatchedTools = lockfile => {
    for (const [name, range] of Object.entries(patchedTools)) {
        const entries = Object.entries(lockfile.packages)
            .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
        assert.ok(entries.length, `${name} is missing from the development toolchain`);
        for (const [key, entry] of entries) {
            assert.equal(entry.dev, true, `${key} must stay development-only`);
            assert.ok(satisfies(entry.version, range), `${key}@${entry.version} is outside reviewed range ${range}`);
        }
    }
};

test('patched lint dependencies stay dev-only within reviewed release lines', async () => {
    const [packageJson, lockfile] = await Promise.all([
        readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
        readFile(new URL('../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    assert.equal(packageJson.overrides['firefox-profile'], undefined,
        'firefox-profile must resolve patched adm-zip releases through its maintained range');
    assert.ok(satisfies(lockfile.packages['node_modules/web-ext'].version, packageJson.devDependencies['web-ext']));
    checkPatchedTools(lockfile);
    const patched = structuredClone(lockfile);
    patched.packages['node_modules/image-size'].version = '2.0.5';
    patched.packages['node_modules/adm-zip'].version = '0.6.2';
    assert.doesNotThrow(() => checkPatchedTools(patched));
    for (const version of ['2.0.3', '3.0.0', '2.0.5-beta.1']) {
        patched.packages['node_modules/image-size'].version = version;
        assert.throws(() => checkPatchedTools(patched), /outside reviewed range/);
    }
});

test('maintained release guidance requires zero advisories', async () => {
    for (const relative of ['../../.github/workflows/release.yml', '../../docs/architecture.md',
        '../../docs/development.md', '../../docs/releasing.md']) {
        const source = await readFile(new URL(relative, import.meta.url), 'utf8');
        assert.match(source, /zero advisories/i, relative);
        assert.doesNotMatch(source, /2026-09-21|permits two exact high|accepts two exact high/i);
    }
});

test('the Firefox runner resolves patched quoting and preserves ordinary command arguments', () => {
    const require = createRequire(import.meta.url);
    const runnerRequire = createRequire(require.resolve('fx-runner/package.json'));
    const { parse, quote } = runnerRequire('shell-quote');
    assert.deepEqual(parse('firefox --profile "/tmp/profile with spaces" --headless'),
        ['firefox', '--profile', '/tmp/profile with spaces', '--headless']);
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
        assert.throws(() => quote(['echo', 'ok', { comment: 'x' }, `a${terminator}id;#`]),
            TypeError, 'tokens after comments must not escape into shell input');
    }
});
