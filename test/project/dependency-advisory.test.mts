// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    DEVELOPMENT_TOOLS,
    evaluateAudit,
    shippedPackagePaths,
    type AuditReport,
    type Lockfile,
    type PackageManifest,
} from '../../scripts/check-npm-audit.mts';
import { runtimeSources } from '../helpers/runtime-sources.mts';

const read = (file: string) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
const lockfile = JSON.parse(await read('package-lock.json')) as Lockfile & { packages: Record<string, PackageManifest> };
const packageJson = JSON.parse(await read('package.json')) as PackageManifest & { scripts: Record<string, string> };
const graph = { lockfile, packageJson };
const auditOf = (...nodes: string[]): AuditReport => ({
    metadata: { vulnerabilities: { total: nodes.length } },
    vulnerabilities: Object.fromEntries(nodes.map(node => [node.split('node_modules/').at(-1)!, { severity: 'critical', nodes: [node] }])),
});

test('advisories confined to development tooling pass at any severity and stay reported', () => {
    assert.deepEqual(evaluateAudit(auditOf('node_modules/deepmerge', 'node_modules/addons-linter', 'node_modules/web-ext'), graph),
        { status: 'development-only', names: ['addons-linter', 'deepmerge', 'web-ext'] });
});

test('advisories in shipped libraries fail even though npm files them under devDependencies', () => {
    for (const node of ['node_modules/maplibre-gl', 'node_modules/@tiptap/core', 'node_modules/marked', 'node_modules/suncalc']) {
        assert.ok(packageJson.devDependencies?.[node.slice('node_modules/'.length)] || packageJson.dependencies?.[node.slice('node_modules/'.length)]);
        assert.throws(() => evaluateAudit(auditOf(node), graph), /Unowned npm audit findings/, node);
    }
});

test('advisories in transitive dependencies of shipped libraries fail', () => {
    const transitive = lockfile.packages['node_modules/@tiptap/pm'].dependencies ?? {};
    const name = Object.keys(transitive)[0];
    assert.ok(name);
    assert.throws(() => evaluateAudit(auditOf(`node_modules/${name}`), graph), /Unowned/);
});

test('a tooling package that shipped code also depends on counts as shipped', () => {
    const shared = structuredClone(lockfile);
    shared.packages['node_modules/maplibre-gl'].dependencies = { deepmerge: '4.3.1' };
    assert.throws(() => evaluateAudit(auditOf('node_modules/deepmerge'), { lockfile: shared, packageJson }), /Unowned/);
});

test('one shipped copy fails a finding even when another copy is tooling', () => {
    const audit = auditOf('node_modules/deepmerge');
    audit.vulnerabilities!.deepmerge.nodes!.push('node_modules/maplibre-gl');
    assert.throws(() => evaluateAudit(audit, graph), /Unowned/);
});

test('nested installs resolve to the copy their parent actually loads', () => {
    const nested = structuredClone(lockfile);
    nested.packages['node_modules/maplibre-gl'].dependencies = { deepmerge: '1.0.0' };
    nested.packages['node_modules/maplibre-gl/node_modules/deepmerge'] = {};
    const shipped = shippedPackagePaths({ lockfile: nested, packageJson })!;
    assert.ok(shipped.has('node_modules/maplibre-gl/node_modules/deepmerge'));
    assert.ok(!shipped.has('node_modules/deepmerge'));
});

test('a new direct dependency counts as shipped until it is named as a tool', () => {
    const added = structuredClone(lockfile);
    added.packages['node_modules/brand-new'] = {};
    const manifest = { ...packageJson, devDependencies: { ...packageJson.devDependencies, 'brand-new': '1.0.0' } };
    assert.throws(() => evaluateAudit(auditOf('node_modules/brand-new'), { lockfile: added, packageJson: manifest }), /Unowned/);
});

test('findings that cannot be located fail closed', () => {
    const report = (finding: object): AuditReport => ({ metadata: { vulnerabilities: { total: 1 } }, vulnerabilities: { deepmerge: finding } });
    for (const finding of [{}, { nodes: [] }, { nodes: ['node_modules/not-installed'] }]) {
        assert.throws(() => evaluateAudit(report(finding), graph), /Unowned/);
    }
    assert.throws(() => evaluateAudit(auditOf('node_modules/deepmerge')), /Unowned/);
    assert.throws(() => evaluateAudit(auditOf('node_modules/deepmerge'), { lockfile }), /Unowned/);
    assert.throws(() => evaluateAudit({ metadata: { vulnerabilities: { total: 2 } }, vulnerabilities: {} }, graph), /missing vulnerability detail/);
});

test('clean output stays clean', () => {
    assert.deepEqual(evaluateAudit({ metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} }, graph), { status: 'clean' });
});

test('every named tool is a real direct dependency that runtime source never imports', async () => {
    const direct = { ...packageJson.dependencies, ...packageJson.devDependencies };
    for (const tool of DEVELOPMENT_TOOLS) assert.ok(direct[tool], `${tool} is no longer a direct dependency`);
    for (const { file, text } of await runtimeSources()) {
        for (const tool of DEVELOPMENT_TOOLS) {
            assert.ok(!text.includes(`from '${tool}'`) && !text.includes(`from '${tool}/`), `${file} imports ${tool}`);
        }
    }
});

test('CI and releases run one gate with no exception flags', async () => {
    assert.equal(packageJson.scripts['audit:ci'], 'node scripts/check-npm-audit.mts');
    for (const file of ['.github/workflows/test.yml', '.github/workflows/release.yml']) {
        const workflow = await read(file);
        assert.match(workflow, /- name: Check dependency advisories\n(?:\s+#.*\n)*\s+run: npm run audit:ci\n/, file);
    }
});
