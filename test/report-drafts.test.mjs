// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { reportDrafts as Drafts } from '../src/report-drafts.js';

test('draft keys round-trip for existing, peak-targeted, and new ascents', () => {
    const cases = [
        [{ cid: '77', aid: '123' }, { cid: '77', kind: 'ascent', id: '123' }],
        [{ cid: '77', pid: '456' }, { cid: '77', kind: 'peak', id: '456' }],
        [{ cid: '77' }, { cid: '77', kind: 'new', id: null }],
        [{ pid: '456' }, { cid: '0', kind: 'peak', id: '456' }]
    ];

    for (const [identity, parsed] of cases) {
        assert.deepEqual(Drafts.parseKey(Drafts.keyFor(identity)), parsed);
    }
});

test('draft key parsing rejects unrelated and malformed storage entries', () => {
    for (const key of [
        null,
        '',
        'other:77:a123',
        'bpbReportDraft::a123',
        'bpbReportDraft:77:x123',
        'bpbReportDraft:77:a',
        'bpbReportDraft:77:a12x',
        'bpbReportDraft:owner:a123',
        'bpbReportDraft:77:new:extra'
    ]) {
        assert.equal(Drafts.parseKey(key), null, String(key));
    }
});

test('edit URLs preserve the draft target and omit the unknown climber id', () => {
    assert.equal(Drafts.editUrl(Drafts.parseKey('bpbReportDraft:77:a123')),
        'https://peakbagger.com/climber/ascentedit.aspx?aid=123&cid=77');
    assert.equal(Drafts.editUrl(Drafts.parseKey('bpbReportDraft:77:p456')),
        'https://peakbagger.com/climber/ascentedit.aspx?pid=456&cid=77');
    assert.equal(Drafts.editUrl(Drafts.parseKey('bpbReportDraft:77:new')),
        'https://peakbagger.com/climber/ascentedit.aspx?cid=77');
    assert.equal(Drafts.editUrl(Drafts.parseKey('bpbReportDraft:0:p456')),
        'https://peakbagger.com/climber/ascentedit.aspx?pid=456');
    assert.equal(Drafts.editUrl(Drafts.parseKey('bpbReportDraft:0:new')),
        'https://peakbagger.com/climber/ascentedit.aspx');
});

test('fallback titles distinguish the draft targets', () => {
    assert.equal(Drafts.fallbackTitle(null), 'TR draft');
    assert.equal(Drafts.fallbackTitle(Drafts.parseKey('bpbReportDraft:77:a123')), 'Ascent #123');
    assert.equal(Drafts.fallbackTitle(Drafts.parseKey('bpbReportDraft:77:p456')), 'New ascent · peak #456');
    assert.equal(Drafts.fallbackTitle(Drafts.parseKey('bpbReportDraft:77:new')), 'New ascent');
});

test('record validation and remaining lifetime are deterministic', () => {
    const record = { text: '[b]Draft[/b]', savedAt: 1_000 };
    assert.equal(Drafts.validRecord(record), true);
    assert.equal(Drafts.validRecord({ text: 'Draft', savedAt: Number.NaN }), false);
    assert.equal(Drafts.validRecord({ text: 'Draft', savedAt: '1000' }), false);
    assert.equal(Drafts.validRecord([]), false);
    assert.equal(Drafts.remainingMs(record, 4_000), Drafts.TTL_MS - 3_000);
});
