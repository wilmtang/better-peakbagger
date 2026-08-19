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

const source = await fs.readFile(new URL('../../src/ascent/ascent-saved.js', import.meta.url), 'utf8');
const editorFixture = await fs.readFile(
    new URL('../fixtures/pages/climber-ascentedit.html', import.meta.url), 'utf8');

const EDITOR_URL = 'https://peakbagger.com/climber/ascentedit.aspx?pid=12&cid=900001';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

// A minimal reproduction of the async-postback success view: #SubTitle inside
// #UpdatePanelAE, the native "Go Back to Referring Page" anchor followed by the
// "add a new ascent" text, and the photo link that alone carries the new aid.
const successHtml = ({
    subtitle = 'Ascent Added/Saved Successfully!',
    photo = true,
    photoAid = '778899',
    photoText = 'Add Photos',
} = {}) => `<!doctype html><body>
  <div id="UpdatePanelAE">
    <h1><span id="PageTitle">New Ascent by Alex Doe</span></h1>
    <h2><span id="SubTitle">${subtitle}</span></h2>
    <p>
      <a href="climber/ascentlist.aspx?cid=900001">Go Back to Referring Page</a>, or, add a new ascent on this page.
      ${photo ? `<a href="Photo.aspx?aid=${photoAid}&amp;pid=12&amp;cid=900001">${photoText}</a>` : ''}
    </p>
  </div>
</body>`;

const load = (html, {
    url = EDITOR_URL,
    status = null,
    navigations = null,
    messages = null,
    draftConfirmation = null,
    draftEvents = null,
} = {}) => {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    if (draftEvents) {
        dom.window.document.addEventListener('bpb:report-draft-saved', event => {
            draftEvents.push(event.detail);
        });
    }
    dom.window.chrome = {
        runtime: {
            lastError: null,
            sendMessage: async message => {
                if (messages) messages.push(structuredClone(message));
                if (message.type === 'GITHUB_BACKUP_STATUS') return status;
                if (message.type === 'REPORT_DRAFT_SAVE_CONFIRMED') return draftConfirmation;
                return null;
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

test('an Add success ignores unrelated photo links outside the success panel', () => {
    const html = successHtml().replace(
        '<div id="UpdatePanelAE">',
        '<a href="Photo.aspx?aid=1">Old report photo</a><div id="UpdatePanelAE">',
    );
    const dom = load(html);
    assert.equal(links(dom).length, 1);
    assert.equal(links(dom)[0].getAttribute('href'), 'ascent.aspx?aid=778899');
    dom.window.close();
});

test('an Add success ignores non-action photo links inside the success panel', () => {
    const html = successHtml().replace(
        '<h1><span id="PageTitle">',
        '<a href="Photo.aspx?aid=1">Old report photo</a><h1><span id="PageTitle">',
    );
    const dom = load(html);
    assert.equal(links(dom)[0].getAttribute('href'), 'ascent.aspx?aid=778899');
    dom.window.close();
});

test('an Add success rejects the live aid=1 photo action', async () => {
    const messages = [];
    const navigations = [];
    const dom = load(successHtml({
        photoAid: '1',
        photoText: 'Click here to add a photo for this ascent.',
    }), {
        status: { enabled: true, connected: true, auto: true },
        messages,
        navigations,
    });
    await tick();

    assert.equal(links(dom).length, 0);
    assert.equal(messages.some(message => message.type === 'REPORT_DRAFT_SAVE_CONFIRMED'), false);
    assert.deepEqual(navigations, []);
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

test('an Edit success preserves the historical aid=1 URL identity', () => {
    const dom = load(successHtml({ subtitle: 'Ascent Saved Successfully!', photo: false }), {
        url: 'https://peakbagger.com/climber/ascentedit.aspx?aid=1&cid=900001',
    });
    assert.equal(links(dom).length, 1);
    assert.equal(links(dom)[0].getAttribute('href'), 'ascent.aspx?aid=1');
    dom.window.close();
});

test('confirmed Add and Edit success notify the worker and editor exactly once', async () => {
    for (const scenario of [
        { html: successHtml(), url: EDITOR_URL, aid: '778899', key: 'bpbReportDraft:900001:p12' },
        {
            html: successHtml({ subtitle: 'Ascent Saved Successfully!', photo: false }),
            url: 'https://peakbagger.com/climber/ascentedit.aspx?aid=445566&cid=900001',
            aid: '445566',
            key: 'bpbReportDraft:900001:a445566',
        },
    ]) {
        const messages = [];
        const draftEvents = [];
        const dom = load(scenario.html, {
            url: scenario.url,
            messages,
            draftEvents,
            draftConfirmation: { ok: true, draftKey: scenario.key, removed: true },
        });
        await tick();
        dom.window.document.getElementById('UpdatePanelAE').append(dom.window.document.createElement('span'));
        await tick();

        assert.deepEqual(
            messages.filter(message => message.type === 'REPORT_DRAFT_SAVE_CONFIRMED'),
            [{ type: 'REPORT_DRAFT_SAVE_CONFIRMED', aid: scenario.aid }],
        );
        assert.deepEqual(JSON.parse(JSON.stringify(draftEvents)), [{ draftKey: scenario.key }]);
        dom.window.close();
    }
});

test('a newer retained draft does not make the old editor terminal', async () => {
    const messages = [];
    const draftEvents = [];
    const dom = load(successHtml(), {
        messages,
        draftEvents,
        draftConfirmation: {
            ok: true,
            draftKey: 'bpbReportDraft:900001:p12',
            removed: false,
        },
    });
    await tick();

    assert.equal(messages.some(message => message.type === 'REPORT_DRAFT_SAVE_CONFIRMED'), true);
    assert.deepEqual(draftEvents, []);
    dom.window.close();
});

test('conflicting URL and success-panel identities fail closed', async () => {
    const navigations = [];
    const messages = [];
    const dom = load(successHtml(), {
        url: 'https://peakbagger.com/climber/ascentedit.aspx?aid=445566&cid=900001',
        status: { enabled: true, connected: true, auto: true },
        navigations,
        messages,
    });
    await tick();
    assert.equal(links(dom).length, 0);
    assert.deepEqual(navigations, []);
    assert.equal(messages.some(message => message.type === 'REPORT_DRAFT_SAVE_CONFIRMED'), false);
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
