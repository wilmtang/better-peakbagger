// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { profileBackupCore as Core } from '../src/profile-backup-core.js';

const fixture = await readFile(new URL('./fixtures/pages/climber-ascents.html', import.meta.url), 'utf8');

test('parses an owned ClimbListC fixture into stable ascent work records', () => {
    const dom = new JSDOM(fixture, { url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999' });
    const parsed = Core.parseAscentList(dom.window.document);

    assert.equal(parsed.isOwner, true);
    assert.equal(parsed.climberId, 900001);
    assert.equal(parsed.ascents.length, 38);
    assert.deepEqual(parsed.ascents[0], {
        aid: 9100001,
        pid: 990001,
        peakName: 'Sample Peak 1',
        date: '2020-01-01',
        hasGpx: false,
        trWords: 8,
        ascentUrl: 'https://www.peakbagger.com/climber/ascent.aspx?aid=9100001',
        editUrl: 'https://www.peakbagger.com/climber/AscentEdit.aspx?aid=9100002',
    });
});

test('requires the signed-in owner identity and per-row edit affordance', () => {
    const publicDom = new JSDOM(fixture, { url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=123' });
    assert.deepEqual(Core.parseAscentList(publicDom.window.document), {
        isOwner: false, climberId: null, ascents: [],
    });

    const ownedDom = new JSDOM(fixture, { url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001' });
    ownedDom.window.document.querySelector('a[href*="AscentEdit.aspx?aid="]').remove();
    assert.equal(Core.parseAscentList(ownedDom.window.document).isOwner, false);
});

test('detects GPS markers independent of table column order', () => {
    const html = fixture.replace(
        '<a href="https://www.peakbagger.com/climber/AscentEdit.aspx?aid=9100002">Edit</a>',
        '<a href="https://www.peakbagger.com/climber/AscentEdit.aspx?aid=9100002">Edit</a><img src="/image/GPS.gif" title="Ascent has GPS track">',
    );
    const dom = new JSDOM(html, { url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001' });
    assert.equal(Core.parseAscentList(dom.window.document).ascents[0].hasGpx, true);
});

test('work-list diff skips exact existing ascent ids and refresh-all keeps all', () => {
    const ascents = [{ aid: 12 }, { aid: 123 }, { aid: 123 }, { aid: null }];
    const folders = ['2026-01-01-one-a12', '2026-01-02-other-a999'];
    assert.deepEqual(Core.buildWorkList(ascents, folders).work.map(a => a.aid), [123]);
    assert.deepEqual(Core.buildWorkList(ascents, folders).skipped.map(a => a.aid), [12]);
    assert.deepEqual(Core.buildWorkList(ascents, folders, { refreshAll: true }).work.map(a => a.aid), [12, 123]);
});

test('full-list URL preserves climber and units while forcing complete coverage', () => {
    const url = new URL(Core.fullListUrl('https://peakbagger.com/climber/ClimbListC.aspx?cid=9&u=m'));
    assert.equal(url.searchParams.get('cid'), '9');
    assert.equal(url.searchParams.get('u'), 'm');
    assert.equal(url.searchParams.get('j'), '-1');
    assert.equal(url.searchParams.get('y'), '9999');
    assert.equal(url.searchParams.get('sort'), 'AscentDate');
});
