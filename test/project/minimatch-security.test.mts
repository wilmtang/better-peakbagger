// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { satisfies } = require('semver') as { satisfies(version: string, range: string): boolean };
interface Matcher {
    match(file: string): boolean;
}
interface MinimatchModule {
    Minimatch: new (pattern: string, options?: { dot?: boolean; optimizationLevel?: number }) => Matcher;
}

test('lint owners resolve patched minimatch without replacing the legacy glob implementation', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.overrides['minimatch@^10.0.0'], '11.0.1');
    assert.deepEqual(pkg.overrides['minimatch@^3.0.0'], { 'brace-expansion': '1.1.21' });
    for (const owner of ['eslint', '@eslint/config-array', '@typescript-eslint/typescript-estree']) {
        const ownerRequire = createRequire(require.resolve(owner));
        const resolved = JSON.parse(readFileSync(ownerRequire.resolve('minimatch/package.json'), 'utf8'));
        assert.ok(satisfies(resolved.version, '^11.0.1'), `${owner} resolves vulnerable minimatch ${resolved.version}`);
        const { Minimatch } = ownerRequire('minimatch') as MinimatchModule;
        const typed = new Minimatch('**/*.{ts,mts}', { dot: true });
        assert.equal(typed.match('src/maps/map-layer-control.ts'), true, owner);
        assert.equal(typed.match('test/project/example.test.mts'), true, owner);
        assert.equal(typed.match('.hidden/example.mts'), true, owner);
        assert.equal(typed.match('test/project/legacy.test.mjs'), false, owner);
        const optimized = new Minimatch('src/**/../maps/*.ts', { optimizationLevel: 2 });
        assert.equal(optimized.match('src/maps/map-layer-control.ts'), true, owner);
    }
});
