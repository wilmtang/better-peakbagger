// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ascent-editor upload conveniences, exercised against the captured
// ascentedit fixture through the built content bundle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES } from './helpers/load-page.mjs';

const FIXTURE = 'climber-ascentedit.html';
const URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=2296&cid=900001';
const BUNDLES = ['vendor/marked.umd.js', 'content/ascent-editor.js'];

const loadEditor = ({ prepare = null, url = URL } = {}) => loadPage(FIXTURE, {
    url,
    bundles: BUNDLES,
    fixtures: PAGE_FIXTURES,
    prepare
});

const localToday = () => {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

test('an empty Ascent Date on a fresh form is filled with the local today', async () => {
    const events = [];
    const dom = await loadEditor({
        prepare: d => {
            const field = d.window.document.getElementById('DateText');
            field.addEventListener('input', () => events.push('input'));
            field.addEventListener('change', () => events.push('change'));
        }
    });
    assert.equal(dom.window.document.getElementById('DateText').value, localToday());
    assert.deepEqual(events, ['input', 'change'],
        'the fill must announce itself the way setTextField does');
});

test('a populated date — an existing ascent being edited — is never touched', async () => {
    const dom = await loadEditor({
        prepare: d => { d.window.document.getElementById('DateText').value = '2019-08-14'; }
    });
    assert.equal(dom.window.document.getElementById('DateText').value, '2019-08-14');
});

test('whitespace-only counts as empty; a page without the field is left alone', async () => {
    const dom = await loadEditor({
        prepare: d => { d.window.document.getElementById('DateText').value = '   '; }
    });
    assert.equal(dom.window.document.getElementById('DateText').value, localToday());

    const bare = await loadEditor({
        prepare: d => { d.window.document.getElementById('DateText').remove(); }
    });
    assert.equal(bare.window.document.getElementById('DateText'), null);
});
