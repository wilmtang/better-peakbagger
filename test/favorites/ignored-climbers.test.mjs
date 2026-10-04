// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../../src/favorites/ignored-climbers.js';
const entry = (cid, name = `Climber ${cid}`) => ({ cid, name, addedAt: cid });

test('ignored storage distinguishes missing, valid empty, and malformed data', () => {
    assert.deepEqual(I.readList(undefined), I.emptyList());
    for (const value of [null, {}, { schemaVersion: 2, revision: 0, entries: [] },
        { schemaVersion: 1, revision: -1, entries: [] },
        { schemaVersion: 1, revision: 0, entries: [entry(1), entry(1)] }]) {
        assert.equal(I.readList(value), null);
    }
    assert.equal(I.readList(I.emptyList()).entries.length, 0);
    assert.equal(I.validateEntries(Array.from({ length: 1500 }, (_, i) => entry(i + 1))).length, 1500);
    assert.equal(I.validateEntries(Array.from({ length: 1501 }, (_, i) => entry(i + 1))), null);
});
test('profile ids require exact secure origin, path, and a unique safe positive id', () => {
    assert.equal(I.profileId('/climber/Climber.aspx?cid=900002', 'https://peakbagger.com'), 900002);
    for (const url of ['http://peakbagger.com/climber/climber.aspx?cid=1',
        'https://evil.com/climber/climber.aspx?cid=1',
        'https://peakbagger.com/climber/ascent.aspx?cid=1',
        'https://peakbagger.com/climber/climber.aspx?cid=1&cid=2',
        'https://peakbagger.com/climber/climber.aspx?cid=9007199254740992']) {
        assert.equal(I.profileId(url), null);
    }
});
test('strict UTF-8 backup parsing and allowlisted serialization preserve names as data', () => {
    const values = [entry(1, '<img onerror=alert(1)> 山')];
    const text = I.serializeBackup([{ ...values[0], token: 'secret' }]);
    assert.deepEqual(I.parseBackup(text), values);
    assert.equal(text.includes('secret'), false);
    assert.deepEqual(I.parseBackup(I.serializeBackup([])), []);
    for (const patch of [{ kind: 'other' }, { schemaVersion: 2 }, { entries: [entry(1), entry(1)] },
        { entries: [entry(0)] }, { entries: [entry(1, 'x'.repeat(201))] },
        { entries: [{ ...entry(1), addedAt: -1 }] }]) {
        assert.equal(I.parseBackup(JSON.stringify({ ...JSON.parse(text), ...patch })), null);
    }
    assert.equal(I.parseBackup('山'.repeat(I.MAX_BYTES / 2)), null);
    assert.equal(I.signature(values), I.signature(I.parseBackup(text)));
});
test('one visibility predicate counts overlap once and keeps unknown authors visible', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({ climberId: i + 1, favorite: i < 4 }));
    const ignored = new Set([1, 5, 6]);
    for (const [fav, reveal, shown, ih, oh] of [[false,false,9,3,0], [true,false,3,3,6],
        [true,true,4,0,8], [false,true,12,0,0]]) {
        const result = I.visibility(records, ignored, r => !fav || r.favorite, reveal);
        assert.equal(result.visible.length, shown);
        assert.equal(result.ignoreHidden, ih);
        assert.equal(result.otherHidden, oh);
        assert.equal(result.totalHidden, 12 - shown);
    }
    assert.equal(I.visibility([{ climberId: null }], ignored).visible.length, 1);
});
test('three-way merge propagates deletions, combines independent ids, and requires conflict choices', () => {
    const base = [entry(1), entry(2)];
    const result = I.mergeLists(base, [entry(2), entry(3)], [...base, entry(4)]);
    assert.deepEqual(result.entries.map(e => e.cid), [2,3,4]);
    assert.equal(result.conflicts.length, 0);
    const conflicted = I.mergeLists(base, [entry(2)], [entry(1, 'renamed'), entry(2)]);
    assert.equal(conflicted.conflicts[0].cid, 1);
    assert.deepEqual(I.mergeLists(base, [entry(2)], [entry(1, 'renamed'), entry(2)],
        { 1: 'device' }).entries, [entry(2)]);
    assert.deepEqual(I.mergeLists(base, base, []).entries, []);
    assert.equal(I.mergeLists([], [entry(1)], [entry(1, 'different')]).conflicts.length, 1);
});
