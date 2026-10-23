// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ownerClimberId } from '../../src/profile/profile-backup-core.js';

const url = 'https://www.peakbagger.com/Peak.aspx?pid=2296';
const nav = body => `<div>Logged in: Test Climber | ${body}</div>`;
const home = href => `<a href="${href}">My Home Page</a>`;
test('account readers reject off-site, invalid and conflicting identities', () => {
    for (const html of [
        nav(home('https://example.invalid/climber/climber.aspx?cid=17')),
        nav(home('/climber/climber.aspx?cid=0')),
        nav(home('/climber/climber.aspx?cid=17&cid=29')),
        nav(home('/climber/climber.aspx?cid=17') + '<a href="/climber/ClimbListC.aspx?cid=29">My Ascents</a>'),
        `<h1>Trip report</h1>${nav(home('/climber/climber.aspx?cid=17'))}`,
    ]) {
        const dom = new JSDOM(html, { url });
        try { assert.equal(ownerClimberId(dom.window.document), null, html); }
        finally { dom.window.close(); }
    }
});

test('DOM and worker HTML account adapters agree on native navigation and malformed evidence', async () => {
    const { peakbaggerAccount: account } = await import('../../src/peakbagger/peakbagger-account.js');
    const fixtures = [
        [nav(home('/climber/climber.aspx?cid=17')), 'signed-in', '17'],
        [nav(home('https://peakbagger.com/climber/climber.aspx?cid=17')), 'signed-in', '17'],
        [nav('<a href="/climber/ClimberEdit.aspx?mode=profile&amp;cid=17">Edit Account</a>'), 'signed-in', '17'],
        [nav(home('/climber/climber.aspx?cid=17')) + '<a href="/Climber/Login.aspx">Log In</a>', 'signed-in', '17'],
        [nav(home('/wrong.aspx?cid=17')), 'unverified', null],
        [nav(home('/climber/climber.aspx?cid=-17')), 'unverified', null],
        [nav(home('/climber/climber.aspx?cid=9007199254740993')), 'unverified', null],
        [nav(home('/climber/climber.aspx?cid=17&cid=29')), 'unverified', null],
        [nav(home('http://www.peakbagger.com/climber/climber.aspx?cid=17')), 'unverified', null],
        [nav(home('https://example.invalid/climber/climber.aspx?cid=17')), 'unverified', null],
        [nav(home('/climber/climber.aspx?cid=17#other')), 'unverified', null],
        [nav(home('/climber/climber.aspx?cid=17') + '<a href="/climber/ClimbListC.aspx?cid=29">My Ascents</a>'), 'unverified', null],
        [`<h1>Report</h1>${nav(home('/climber/climber.aspx?cid=17'))}`, 'unverified', null],
        ['<a href="/Climber/Login.aspx">Log In</a>', 'unverified', null],
        ['<form><input id="PasswordText"></form>', 'signed-out', null],
        ['', 'unverified', null],
    ];
    for (const [html, status, cid] of fixtures) {
        const dom = new JSDOM(html, { url });
        try {
            assert.deepEqual(account.fromDocument(dom.window.document), { status, cid }, html);
            assert.deepEqual(account.fromHtml(html, url), { status, cid }, html);
        } finally { dom.window.close(); }
    }
});

test('real masked native navigation remains readable in DOM and worker adapters', async () => {
    const { readFile } = await import('node:fs/promises');
    const { peakbaggerAccount: account } = await import('../../src/peakbagger/peakbagger-account.js');
    for (const name of ['home-default', 'peak-rainier', 'climber-ascents', 'climber-ascentedit', 'report-buddy-list', 'climber-buddy-form']) {
        const html = await readFile(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8');
        const dom = new JSDOM(html, { url });
        try {
            assert.deepEqual(account.fromDocument(dom.window.document), { status: 'signed-in', cid: '900001' }, name);
            assert.deepEqual(account.fromHtml(html, url), { status: 'signed-in', cid: '900001' }, name);
        } finally { dom.window.close(); }
    }
});
