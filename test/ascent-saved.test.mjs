// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The save-success route from ascentedit.aspx to the saved ascent. These tests
// evaluate the dependency-free source against synthetic Add/Edit success DOM,
// including the automatic-backup handoff to the ascent.aspx runner.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await fs.readFile(new URL('../src/ascent-saved.js', import.meta.url), 'utf8');
const editorFixture = await fs.readFile(
    new URL('./fixtures/pages/climber-ascentedit.html', import.meta.url), 'utf8');

const EDITOR_URL = 'https://peakbagger.com/climber/ascentedit.aspx?pid=12&cid=900001';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

// A minimal reproduction of the async-postback success view: #SubTitle inside
// #UpdatePanelAE, the native "Go Back to Referring Page" anchor followed by the
// "add a new ascent" text, and the photo link that alone carries the new aid.
const successHtml = ({ subtitle = 'Ascent Added/Saved Successfully!', photo = true } = {}) => `<!doctype html><body>
  <div id="UpdatePanelAE">
    <h1><span id="PageTitle">New Ascent by Alex Doe</span></h1>
    <h2><span id="SubTitle">${subtitle}</span></h2>
    <p>
      <a href="climber/ascentlist.aspx?cid=900001">Go Back to Referring Page</a>, or, add a new ascent on this page.
      ${photo ? '<a href="Photo.aspx?aid=778899&amp;pid=12&amp;cid=900001">Add Photos</a>' : ''}
    </p>
  </div>
</body>`;

const load = (html, { url = EDITOR_URL, status = null, navigations = null } = {}) => {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    dom.window.chrome = {
        runtime: {
            lastError: null,
            sendMessage: async message => {
                const response = message.type === 'GITHUB_BACKUP_STATUS' ? status : null;
                return response;
            },
        },
    };
    if (navigations) {
        dom.window.document.addEventListener('click', event => {
            if (event.target?.id !== 'bpb-view-new-ascent') return;
            event.preventDefault();
            navigations.push(event.target.getAttribute('href'));
        });
    }
    dom.window.eval(source);
    return dom;
};

const links = dom => [...dom.window.document.querySelectorAll('#bpb-view-new-ascent')];

test('an Add success links the photo aid to the saved ascent runner', () => {
    const dom = load(successHtml());
    const inserted = links(dom);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].getAttribute('href'), 'ascent.aspx?aid=778899');
    assert.equal(inserted[0].textContent, 'View the Saved Ascent');

    const back = [...dom.window.document.querySelectorAll('a')]
        .find(a => /go back to referring page/i.test(a.textContent));
    // Reads: "Go Back to Referring Page, View the Saved Ascent, or, add a new ascent…"
    assert.equal(back.nextSibling.textContent, ', ');
    assert.equal(back.nextSibling.nextSibling, inserted[0]);
    dom.window.close();
});

test('an Edit success uses the stable URL aid even without a photo link', () => {
    const dom = load(successHtml({ subtitle: 'Ascent Saved Successfully!', photo: false }), {
        url: 'https://peakbagger.com/climber/ascentedit.aspx?aid=445566&cid=900001',
    });
    assert.equal(links(dom).length, 1);
    assert.equal(links(dom)[0].getAttribute('href'), 'ascent.aspx?aid=445566');
    dom.window.close();
});

test('automatic backup follows the saved-ascent route after Add or Edit success', async () => {
    for (const scenario of [
        { html: successHtml(), url: EDITOR_URL, href: 'ascent.aspx?aid=778899' },
        {
            html: successHtml({ subtitle: 'Ascent Saved Successfully!', photo: false }),
            url: 'https://peakbagger.com/climber/ascentedit.aspx?aid=445566&cid=900001',
            href: 'ascent.aspx?aid=445566',
        },
    ]) {
        const navigations = [];
        const dom = load(scenario.html, {
            url: scenario.url,
            status: { enabled: true, connected: true, auto: true },
            navigations,
        });
        await tick();
        assert.deepEqual(navigations, [scenario.href]);
        dom.window.close();
    }
});

test('manual or disconnected backup leaves navigation to the user', async () => {
    for (const status of [
        { enabled: true, connected: true, auto: false },
        { enabled: true, connected: false, auto: true },
    ]) {
        const navigations = [];
        const dom = load(successHtml(), { status, navigations });
        await tick();
        assert.deepEqual(navigations, []);
        assert.equal(links(dom).length, 1);
        dom.window.close();
    }
});

test('re-running the module never duplicates the link', () => {
    const dom = load(successHtml());
    dom.window.eval(source);
    assert.equal(links(dom).length, 1);
    dom.window.close();
});

test('an observer refire after the link exists does not duplicate it', async () => {
    const dom = load(successHtml());
    assert.equal(links(dom).length, 1);
    // Mutate the observed subtree to fire the MutationObserver again.
    dom.window.document.getElementById('UpdatePanelAE').append(
        dom.window.document.createElement('span'));
    await tick();
    assert.equal(links(dom).length, 1);
    dom.window.close();
});

test('inserts nothing until the success view arrives, then reacts to the postback', async () => {
    const dom = load(successHtml({ subtitle: '' }));
    assert.equal(links(dom).length, 0, 'no success text yet → no link');

    // Simulate the async partial postback swapping in the success view.
    dom.window.document.getElementById('SubTitle').textContent = 'Ascent Added/Saved Successfully!';
    dom.window.document.getElementById('UpdatePanelAE').append(
        dom.window.document.createElement('span'));
    await tick();
    assert.equal(links(dom).length, 1);
    dom.window.close();
});

test('does not insert on an Add success page that carries no photo link (no aid)', () => {
    const dom = load(successHtml({ photo: false }));
    assert.equal(links(dom).length, 0);
    dom.window.close();
});

test('leaves the ordinary editor form untouched (no success confirmation)', () => {
    const dom = load(editorFixture, { url: EDITOR_URL });
    assert.equal(links(dom).length, 0);
    dom.window.close();
});
