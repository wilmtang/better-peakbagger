// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CLASSIFICATIONS, matchLabel, matchTone } from '../../src/capture/match-confidence.js';

test('every classification has a name and a tone', () => {
    assert.deepEqual(CLASSIFICATIONS, ['strong', 'probable', 'possible', 'weak']);
    assert.deepEqual(CLASSIFICATIONS.map(matchLabel),
        ['Strong', 'Probable', 'Off track', 'Off track']);
    assert.deepEqual(CLASSIFICATIONS.map(matchTone),
        ['strong', 'probable', 'off', 'off']);
});

// A below-bar classification only reaches a renderer through the bound-peak
// closest-approach fallback, so the two surfaces that can show it must agree.
// Naming a 41%-confidence brush past a summit "Probable" is the specific
// failure this owner exists to prevent.
test('a below-bar match is never named as a confident one', () => {
    for (const classification of ['possible', 'weak']) {
        assert.notEqual(matchLabel(classification), 'Probable');
        assert.notEqual(matchLabel(classification), 'Strong');
    }
});

// Unknown input resolves to the cautious end, never the confident one, and
// always to a tone with a stylesheet rule.
test('an unrecognized classification degrades to the below-bar name and tone', () => {
    for (const value of [undefined, null, '', 'STRONG', 'certain', 0, {}]) {
        assert.equal(matchLabel(value), 'Off track');
        assert.equal(matchTone(value), 'off');
    }
});

// Structural guard, in the shape test/settings/settings-schema.test.mjs uses
// for shared settings literals: capture-core is the producer, and a fifth
// classification added there must not reach a surface unnamed.
test('the classification list covers every value capture-core assigns', async () => {
    const source = await readFile(
        new URL('../../src/capture/capture-core.js', import.meta.url), 'utf8');
    const assigned = new Set([...source.matchAll(/classification\s*=\s*'([a-z-]+)'/g)]
        .map(match => match[1]));
    assert.ok(assigned.size >= 4, `capture-core assigned only ${assigned.size} classifications`);
    for (const classification of assigned) {
        assert.ok(CLASSIFICATIONS.includes(classification),
            `capture-core can assign '${classification}', which match-confidence.js does not list`);
    }
});

// Both surfaces resolve through this module rather than re-deriving the name,
// which is how the picker and the banner disagreed about the same peak.
test('the draft banner and summit picker resolve names through this module', async () => {
    for (const file of ['../../src/ascent/ascent-draft.js', '../../src/ascent/ascent-upload.js']) {
        const source = await readFile(new URL(file, import.meta.url), 'utf8');
        assert.match(source, /matchLabel\(/, `${file} must name matches through matchLabel()`);
        assert.match(source, /matchTone\(/, `${file} must tone matches through matchTone()`);
        assert.doesNotMatch(source, /'strong'\s*\?\s*'Strong'/,
            `${file} must not re-derive the confidence label`);
    }
});

// Every tone the module can return needs a stylesheet rule in each theme
// block, or the banner falls back to the block's own light-mode defaults —
// which is how an "Off track" banner rendered light amber on a dark page.
test('each banner tone is styled in every theme block', async () => {
    const css = await readFile(
        new URL('../../src/reports/report-editor.css', import.meta.url), 'utf8');
    const blocks = [
        { name: 'base', pattern: tone => new RegExp(`^\\.bpb-draft-banner-${tone} \\{`, 'm') },
        { name: 'prefers-dark', pattern: tone => new RegExp(`^ {4}\\.bpb-draft-banner-${tone} \\{`, 'm') },
        { name: 'data-theme dark', pattern: tone => new RegExp(`\\[data-bpb-theme="dark"\\] \\.bpb-draft-banner-${tone} \\{`) },
        { name: 'data-theme light', pattern: tone => new RegExp(`\\[data-bpb-theme="light"\\] \\.bpb-draft-banner-${tone} \\{`) },
    ];
    for (const tone of new Set(CLASSIFICATIONS.map(matchTone))) {
        for (const block of blocks) {
            assert.match(css, block.pattern(tone),
                `.bpb-draft-banner-${tone} is unstyled in the ${block.name} block`);
        }
    }
});
