// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    COPIED_RUNTIME_PACKAGES,
    copiedRuntimeChanged,
    copiedRuntimeVersions,
} from '../../scripts/copied-runtime-impact.mjs';

const lock = (overrides = {}) => ({
    packages: Object.fromEntries(COPIED_RUNTIME_PACKAGES.map((packageName) => [
        `node_modules/${packageName}`,
        { version: overrides[packageName] || '1.0.0' },
    ])),
});

test('copied runtime impact compares only resolved shipped versions', () => {
    assert.equal(copiedRuntimeChanged(lock(), lock()), false);
    for (const packageName of COPIED_RUNTIME_PACKAGES) {
        assert.equal(copiedRuntimeChanged(lock(), lock({ [packageName]: '1.0.1' })), true,
            `${packageName} changes must trigger GPU checks`);
    }

    const unrelated = lock();
    unrelated.packages['node_modules/eslint'] = { version: '99.0.0' };
    assert.equal(copiedRuntimeChanged(lock(), unrelated), false);
});

test('adding or removing a copied runtime is treated as a runtime change', () => {
    const removed = lock();
    delete removed.packages['node_modules/marked'];
    assert.equal(copiedRuntimeChanged(lock(), removed), true);
    assert.equal(copiedRuntimeVersions(removed).marked, null);
    assert.throws(() => copiedRuntimeVersions({}), /no packages inventory/);
});

test('Firefox GPU bearing checks settle before the separate pitch gesture', async () => {
    const verifier = await readFile(
        new URL('../../scripts/verify-firefox-terrain.mjs', import.meta.url),
        'utf8',
    );
    const analyzerBearing = verifier.indexOf('const bearingBefore =');
    const analyzerPitch = verifier.indexOf('const pitchBefore =');
    assert.ok(analyzerBearing >= 0 && analyzerBearing < analyzerPitch,
        'the horizontal drag must not follow the vertical drag at the iframe boundary');
    assert.equal(verifier.match(/mouse\.down\(\{ button: 'right' \}\)/g)?.length, 3,
        'Analyzer bearing, Analyzer pitch, and Peak bearing each own one right drag');
    assert.doesNotMatch(verifier, /\.setBearing\(/,
        'the GPU verifier must exercise camera interaction instead of mutating MapLibre directly');
    assert.match(verifier,
        /if \(await peakSunToggle\.getAttribute\('aria-expanded'\) !== 'true'\)/,
        'the verifier must establish the Peak disclosure state instead of blindly toggling it');
    assert.equal(verifier.match(/const normalizedNorth =/g)?.length, 2,
        'both 2D reset checks must accept CSS angles equivalent to zero modulo 360');
});
