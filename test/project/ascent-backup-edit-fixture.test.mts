// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { prepareAscentBackupEditFixture } from '../../scripts/browser-verification-fixtures.mts';

const editForm = await readFile(new URL('../fixtures/pages/climber-ascentedit.html', import.meta.url), 'utf8');

test('ascent backup edit fixtures preserve each verifier’s elevation with either line ending', () => {
    for (const lineEnding of ['\n', '\r\n']) {
        const source = editForm.replace(/\r?\n/g, lineEnding);
        const lifecycle = prepareAscentBackupEditFixture(source);
        assert.match(lifecycle, /<option value="2296" selected>Mount Rainier<\/option>/);
        assert.match(lifecycle, /id="DateText"[^>]+value="2026-07-12"/);
        assert.match(lifecycle, /id="PointFt"[^>]+value="0"/);
        const layout = prepareAscentBackupEditFixture(source, { elevationFeet: 14411 });
        assert.equal(layout, lifecycle.replace(/(?<prefix>id="PointFt"[^>]+value=")0"/, '$<prefix>14411"'));
    }
});

test('ascent backup edit fixtures reject missing and duplicate fields', () => {
    assert.throws(() => prepareAscentBackupEditFixture(editForm.replace('id="DateText"', 'id="MissingDate"')), /DateText/);
    assert.throws(() => prepareAscentBackupEditFixture(editForm + editForm), /PeakListBox/);
});
