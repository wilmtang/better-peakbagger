// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadPage, PAGE_FIXTURES, waitFor, fireTrustedEvent, accelerateTimeout } from '../helpers/load-page.mjs';

const favoritesKey = 'bpbFavoriteClimbers', ignoredKey = 'bpbIgnoredClimbers';
const buddies = await readFile(new URL('../fixtures/pages/report-buddy-list.html', import.meta.url), 'utf8');
const buddyForm = await readFile(new URL('../fixtures/pages/climber-buddy-form.html', import.meta.url), 'utf8');
const buddyDocument = entries => buddies.replace(/(<table[^>]*id="RGridView"[^>]*>)[\s\S]*?(<\/table>)/i,
    `$1<tr><th>Climber</th></tr>${entries.map(cid => `<tr><td><a href="/climber/climber.aspx?cid=${cid}">Casey Alpine</a></td></tr>`).join('')}$2`);
const load = async ({ settings = { favoritesSource: 'custom' }, local = {}, prepare } = {}) => {
    const dom = await loadPage('climber-other.html', { fixtures: PAGE_FIXTURES,
        url: 'https://www.peakbagger.com/climber/climber.aspx?cid=900002',
        bundles: ['content/climber-hover-card.js'], settings, local,
        prepare: dom => {
            dom.window.HTMLElement.prototype.getClientRects = function () {
                return this.closest('[hidden]') ? [] : [{ left: 10, right: 140, top: 20, bottom: 44, width: 130, height: 24 }];
            };
            dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, right: 140,
                top: 20, bottom: 44, width: 130, height: 24 });
            const list = dom.window.document.createElement('section'); list.id = 'names';
            list.innerHTML = '<a id="casey" href="/climber/climber.aspx?cid=900002">Casey Alpine</a> '
                + '<a id="morgan" href="/climber/Climber.aspx?cid=900003">Morgan Summit</a> '
                + '<a id="owner" href="/climber/climber.aspx?cid=900001">Alex Doe</a>';
            dom.window.document.querySelector('main').append(list);
            prepare?.(dom);
        } });
    await waitFor(dom, () => dom.window.document.querySelector('.bpb-climber-actions-trigger'));
    // jsdom has popover UA styles but no popover API. Exercise the fixed-position
    // fallback without leaving the card permanently display:none for focus checks.
    const card = dom.window.document.getElementById('bpb-climber-card');
    if (typeof card.showPopover !== 'function') card.removeAttribute('popover');
    return dom;
};
const open = async (dom, id = 'casey') => {
    const trigger = dom.window.document.getElementById(id).nextElementSibling;
    fireTrustedEvent(trigger, 'click');
    await waitFor(dom, () => !dom.window.document.getElementById('bpb-climber-card').hidden);
    return dom.window.document.getElementById('bpb-climber-card');
};
const pointer = (dom, node, type, relatedTarget = null) => {
    const event = new dom.window.Event(type, { bubbles: true });
    Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    node.dispatchEvent(event);
};

test('negative visual viewport offsets preserve visible cards while panning and offscreen dismissal remain valid', async t => {
    const viewport = { offsetTop: -1510.9832763671875, offsetLeft: 0, width: 988, height: 760 };
    const rect = { left: 24, right: 330.3833312988281, top: 639.5, bottom: 656.5, width: 306.3833312988281, height: 17 };
    const dom = await load({ prepare: page => {
        const visual = Object.assign(new page.window.EventTarget(), viewport);
        Object.defineProperty(page.window, 'visualViewport', { value: visual, configurable: true });
        Object.assign(page.window, { innerWidth: 1000, innerHeight: 760 });
        const anchor = page.window.document.getElementById('casey');
        anchor.getBoundingClientRect = () => ({ ...rect });
        anchor.getClientRects = () => [{ ...rect }];
    } });
    t.after(() => dom.window.close());
    const visual = dom.window.visualViewport;
    const card = dom.window.document.getElementById('bpb-climber-card');
    const trigger = dom.window.document.getElementById('casey').nextElementSibling;
    fireTrustedEvent(trigger, 'click');
    assert.equal(card.hidden, false, 'captured Firefox resize geometry must not dismiss an onscreen anchor');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(card.contains(dom.window.document.activeElement), true);
    visual.offsetLeft = -1200;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    assert.ok(parseFloat(card.style.left) >= 12);
    assert.equal(card.hidden, false);
    fireTrustedEvent(card, 'keydown', { key: 'Escape', bubbles: true });
    Object.assign(visual, { offsetTop: 200, offsetLeft: 100, width: 800, height: 400 });
    Object.assign(rect, { left: 125, right: 255, top: 250, bottom: 267, width: 130 });
    fireTrustedEvent(trigger, 'click');
    assert.equal(card.hidden, false, 'positive viewport panning remains supported');
    assert.ok(parseFloat(card.style.left) >= 112);
    Object.assign(rect, { top: 50, bottom: 67 });
    dom.window.document.dispatchEvent(new dom.window.Event('scroll'));
    await waitFor(dom, () => card.hidden);
    Object.assign(visual, { offsetTop: -1510.9832763671875, offsetLeft: 0, width: 988, height: 760 });
    Object.assign(rect, { top: 1000, bottom: 1017 });
    fireTrustedEvent(trigger, 'click');
    assert.equal(card.hidden, true, 'a genuinely offscreen anchor must still dismiss');
});

test('large climber lists measure visibility before inserting any action wrappers', async t => {
    const firstReads = new Map();
    const dom = await load({ prepare: page => {
        const section = page.window.document.createElement('section');
        section.innerHTML = Array.from({ length: 100 }, (_, index) =>
            `<a data-batch="${index}" href="/climber/climber.aspx?cid=${900100 + index}">Example ${index}</a>`).join(' ');
        page.window.document.querySelector('main').append(section);
        const native = page.window.HTMLElement.prototype.getClientRects;
        page.window.HTMLElement.prototype.getClientRects = function () {
            if (this.matches('a[data-batch]') && !firstReads.has(this)) {
                firstReads.set(this, section.querySelectorAll('a[data-batch] + .bpb-climber-actions-trigger').length);
            }
            return native.call(this);
        };
    } });
    t.after(() => dom.window.close());
    assert.equal(firstReads.size, 100);
    assert.deepEqual([...firstReads.values()], Array(100).fill(0),
        'visibility reads after wrapper writes force one table layout per climber');
    assert.equal(dom.window.document.querySelectorAll('a[data-batch] + .bpb-climber-actions-trigger').length, 100);
});

test('own profile links stay undecorated in headings, lists, report rows, and late content', async t => {
    const dom = await load({ prepare: dom => {
        dom.window.document.querySelector('main').insertAdjacentHTML('beforeend',
            '<h3>List Created by <a data-self href="/climber/climber.aspx?cid=900001">Alex Doe</a>.</h3>'
            + '<h2>Showing <a data-self href="/climber/Climber.aspx?cid=900001">Alex Doe</a>\'s most recent ascent dates</h2>'
            + '<table><tr><td><a data-self href="https://www.peakbagger.com/climber/climber.aspx?cid=900001">Alex Doe</a></td></tr></table>'
            + '<p><a id="same-name" href="/climber/climber.aspx?cid=900004">Alex Doe</a></p>');
        accelerateTimeout(dom, 1000); accelerateTimeout(dom, 350);
    } });
    t.after(() => dom.window.close());
    const doc = dom.window.document, card = doc.getElementById('bpb-climber-card');
    const assertBare = link => {
        assert.equal(link.closest('.bpb-climber-link'), null, `own link was wrapped: ${link.outerHTML}`);
        assert.equal(link.nextElementSibling?.matches('.bpb-climber-actions-trigger') || false, false);
        assert.equal(link.tabIndex, 0);
    };
    for (const link of [doc.getElementById('owner'), ...doc.querySelectorAll('[data-self]')]) assertBare(link);
    assert.equal(doc.getElementById('same-name').nextElementSibling.matches('.bpb-climber-actions-trigger'), true,
        'identity comes from the climber ID, not the displayed name');
    doc.querySelector('main').insertAdjacentHTML('beforeend',
        '<p id="late-person"><a href="/climber/climber.aspx?cid=900001">Alex Doe</a></p>');
    await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    const late = doc.querySelector('#late-person a');
    assertBare(late);
    pointer(dom, late, 'pointerover'); late.focus();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.hidden, true, 'hover and keyboard focus must not open a self card');
    const changed = doc.getElementById('casey');
    await open(dom);
    changed.href = '/climber/climber.aspx?cid=900001';
    await waitFor(dom, () => card.hidden && !changed.closest('.bpb-climber-link'));
    assertBare(changed);
    changed.href = '/climber/climber.aspx?cid=900002';
    await waitFor(dom, () => changed.nextElementSibling?.matches('.bpb-climber-actions-trigger'));
});

test('card keeps name links intact and exposes only eligible, visible people', async t => {
    const dom = await load({ prepare: dom => {
        dom.window.document.querySelector('main').insertAdjacentHTML('beforeend',
            '<a id="ambiguous" href="/climber/climber.aspx?cid=900002&cid=900003">No</a>'
            + '<div hidden><a id="hidden-person" href="/climber/climber.aspx?cid=900002">Hidden</a></div>'
            + '<nav><a id="navigation" href="/climber/climber.aspx?cid=900002">Casey</a></nav>');
    } }); t.after(() => dom.window.close());
    const link = dom.window.document.getElementById('casey');
    assert.equal(link.getAttribute('href'), '/climber/climber.aspx?cid=900002');
    for (const id of ['ambiguous', 'hidden-person', 'navigation', 'owner']) {
        assert.equal(dom.window.document.getElementById(id).nextElementSibling?.classList.contains('bpb-climber-actions-trigger') || false, false);
    }
    const activation = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.addEventListener('click', event => event.preventDefault(), { once: true });
    // Observe before the fixture's navigation suppression.
    let preventedByCard;
    dom.window.document.addEventListener('click', event => { preventedByCard = event.defaultPrevented; }, { capture: true, once: true });
    link.dispatchEvent(activation);
    assert.equal(preventedByCard, false);
});

test('without a signed-in identity, profile links still offer climber actions', async t => {
    const dom = await load({ prepare: dom => {
        [...dom.window.document.querySelectorAll('a')].find(link => link.textContent === 'My Home Page').remove();
    } });
    t.after(() => dom.window.close());
    assert.equal(dom.window.document.getElementById('owner').nextElementSibling.matches('.bpb-climber-actions-trigger'), true);
    const card = await open(dom, 'owner');
    assert.equal(card.querySelector('.bpb-climber-card-buddy').hidden, true);
    assert.equal(card.querySelector('a.bpb-climber-card-buddy').hidden, false);
});

test('one-second hover dwell cancels on departure; Escape suppresses the same session and explicit opening focuses actions', async t => {
    let opens;
    const dom = await load({ prepare: dom => { opens = accelerateTimeout(dom, 1000); accelerateTimeout(dom, 200); } });
    t.after(() => dom.window.close());
    const name = dom.window.document.getElementById('casey');
    const card = dom.window.document.getElementById('bpb-climber-card');
    pointer(dom, name, 'pointerover'); pointer(dom, name, 'pointerout');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.hidden, true);
    pointer(dom, name, 'pointerover');
    await waitFor(dom, () => !card.hidden);
    assert.ok(opens.length >= 2);
    const trigger = name.nextElementSibling;
    fireTrustedEvent(trigger, 'click');
    assert.equal(dom.window.document.activeElement.id, 'bpb-climber-card-buddy');
    fireTrustedEvent(card, 'keydown', { key: 'Escape', bubbles: true });
    assert.equal(card.hidden, true);
    assert.equal(dom.window.document.activeElement, trigger);
    pointer(dom, name, 'pointerover');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.hidden, true);
    await open(dom);
    assert.equal(card.getAttribute('role'), 'dialog');
    assert.equal(card.hasAttribute('aria-modal'), false);
});

test('favorite and Ignore changes use operation APIs and confirmed reverse actions', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    dom.window.fetch = async () => ({ status: 200, headers: {}, text: async () => buddyDocument([]) });
    const card = await open(dom);
    const favorite = card.querySelector('#bpb-climber-card-favorite'), ignore = card.querySelector('#bpb-climber-card-ignore');
    await waitFor(dom, () => !favorite.disabled);
    favorite.click(); assert.equal(dom.chrome._favoriteMutations.length, 0, 'synthetic page clicks cannot write');
    fireTrustedEvent(favorite, 'click');
    assert.equal(favorite.textContent, 'Saving…');
    await waitFor(dom, () => favorite.textContent === 'Remove favorite climber');
    assert.equal(ignore.disabled, true);
    assert.equal(dom.chrome._favoriteMutations[0].kind, 'add');
    fireTrustedEvent(favorite, 'click');
    await waitFor(dom, () => !ignore.disabled);
    fireTrustedEvent(ignore, 'click');
    await waitFor(dom, () => ignore.textContent === 'Unignore climber');
    assert.equal(favorite.disabled, true);
    assert.equal(dom.chrome._localStore[ignoredKey].entries[0].cid, 900002);
    fireTrustedEvent(ignore, 'click');
    await waitFor(dom, () => ignore.textContent === 'Ignore climber' && !ignore.disabled);
    assert.deepEqual(dom.chrome._localStore[ignoredKey].entries, []);
});
test('card recovery is disabled while work is pending and full error details stay explicit', async t => {
    let finish;
    const dom = await load({ prepare(page) {
        const send = page.chrome.runtime.sendMessage.bind(page.chrome.runtime);
        Object.defineProperty(page.chrome.runtime, 'sendMessage', { value: message => message.type === 'FAVORITES_MUTATE'
            ? new Promise(resolve => { finish = resolve; }) : send(message) });
    } }); t.after(() => dom.window.close());
    const card = await open(dom), favorite = card.querySelector('#bpb-climber-card-favorite');
    await waitFor(dom, () => !favorite.disabled);
    fireTrustedEvent(favorite, 'click');
    finish({ ok: false, error: { message: 'Full failure '.repeat(40) } });
    const retry = card.querySelector('.bpb-climber-card-retry');
    await waitFor(dom, () => !retry.hidden);
    assert.equal(retry.textContent, 'Check lists', 'recovery reads state; it does not pretend to repeat the failed write');
    const details = card.querySelector('details');
    assert.equal(details.open, false);
    assert.match(card.querySelector('.bpb-climber-card-feedback-summary').textContent, /Couldn't finish/);
    assert.equal(details.querySelector('p').textContent.length, 520);
    details.open = true;
    fireTrustedEvent(favorite, 'click');
    assert.match(details.querySelector('p').textContent, /^Previous message:/, 'kept-open details cannot masquerade as the current result');
    assert.equal(retry.hidden, false); assert.equal(retry.disabled, true);
    finish({ ok: false, error: { message: 'Retry failure' } });
    await waitFor(dom, () => !retry.disabled);
    assert.equal(details.querySelector('p').textContent, 'Retry failure');
});

test('Buddy action is inline; source mode never silently creates ineffective custom favorites', async t => {
    const dom = await load({ settings: { favoritesSource: 'buddies' } }); t.after(() => dom.window.close());
    const card = await open(dom);
    await waitFor(dom, () => !card.querySelector('.bpb-climber-card-source').hidden);
    assert.equal(card.querySelector('#bpb-climber-card-favorite').hidden, true);
    assert.equal(card.querySelector('.bpb-climber-card-buddy').textContent, 'Add climbing buddy');
    assert.equal(card.querySelector('.bpb-climber-card-buddy').tagName, 'BUTTON');
    await dom.chrome.storage.sync.set({ bpbSettings: { favoritesSource: 'custom' } });
    await waitFor(dom, () => !card.querySelector('#bpb-climber-card-favorite').hidden);
    assert.equal(card.querySelector('.bpb-climber-card-source').hidden, true);
});

test('inline Buddy saves wait for confirmation, reject synthetic activation and offer status-only recovery', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    let included = false, posts = 0, failedConfirmation = false, gets = 0;
    const form = () => included ? buddyForm.replace('Add this Climber as a Buddy', 'This Climber is one of your buddies.')
        .replaceAll('AddBuddy', 'RemoveBuddy').replace('Add to your Buddy List', 'Remove from your Buddy List') : buddyForm;
    dom.window.fetch = async (url, init) => {
        if (init.method === 'POST') { posts++; included = new URLSearchParams(init.body).has('AddBuddy'); }
        else if (++gets === 2 && failedConfirmation) throw new Error('offline');
        return { status: 200, headers: {}, url: String(url), text: async () => form() };
    };
    const card = await open(dom), buddy = card.querySelector('#bpb-climber-card-buddy');
    await waitFor(dom, () => !buddy.disabled);
    buddy.click(); assert.equal(posts, 0);
    failedConfirmation = true;
    fireTrustedEvent(buddy, 'click');
    assert.equal(buddy.textContent, 'Adding…');
    await waitFor(dom, () => buddy.textContent === 'Check buddy status' && !buddy.disabled);
    assert.equal(card.querySelector('#bpb-climber-card-ignore').disabled, true);
    assert.match(card.querySelector('.bpb-climber-card-feedback').textContent, /not confirmed/);
    fireTrustedEvent(buddy, 'click');
    await waitFor(dom, () => buddy.textContent === 'Remove climbing buddy' && !buddy.disabled);
    assert.equal(posts, 1, 'checking uncertain state cannot send another POST');
    assert.equal(card.querySelector('#bpb-climber-card-favorite').textContent, 'Remove favorite climber');
    fireTrustedEvent(buddy, 'click');
    await waitFor(dom, () => buddy.textContent === 'Add climbing buddy' && !buddy.disabled);
    assert.equal(posts, 2);
});

test('Ignore rechecks live Buddy membership and never treats a failed read as empty', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    const card = await open(dom);
    const ignore = card.querySelector('#bpb-climber-card-ignore');
    await waitFor(dom, () => !ignore.disabled);
    dom.window.fetch = async () => { throw new Error('offline'); };
    fireTrustedEvent(ignore, 'click');
    await waitFor(dom, () => !card.querySelector('.bpb-climber-card-retry').hidden);
    assert.equal(dom.chrome._localStore[ignoredKey], undefined);
    dom.window.fetch = async () => ({ status: 200, headers: {}, text: async () => buddyDocument([900002]) });
    fireTrustedEvent(ignore, 'click');
    await waitFor(dom, () => card.querySelector('.bpb-climber-card-feedback').textContent.includes('Remove from your Buddy List'));
    assert.equal(dom.chrome._localStore[ignoredKey], undefined);
    assert.equal(ignore.disabled, true);
});

test('closing during a save cannot repaint another climber, and dynamic links remain eligible', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    const nativeSet = dom.chrome.storage.local.set;
    let release;
    dom.chrome.storage.local.set = async value => {
        if (value[favoritesKey]) await new Promise(resolve => { release = resolve; });
        return nativeSet(value);
    };
    const card = await open(dom);
    const favorite = card.querySelector('#bpb-climber-card-favorite');
    await waitFor(dom, () => !favorite.disabled);
    fireTrustedEvent(favorite, 'click');
    await waitFor(dom, () => release);
    fireTrustedEvent(card.querySelector('.bpb-climber-card-close'), 'click');
    fireTrustedEvent(dom.window.document.getElementById('morgan').nextElementSibling, 'click');
    assert.equal(card.hidden, true, 'another climber must not take over the pending card');
    release();
    await waitFor(dom, () => dom.window.document.getElementById('bpb-climber-card-announcement').textContent.includes('Casey Alpine added'));
    await open(dom, 'morgan');
    assert.equal(card.querySelector('.bpb-climber-card-name').textContent, 'Morgan Summit');
    assert.equal(favorite.textContent, 'Add favorite climber');
    dom.window.document.getElementById('names').insertAdjacentHTML('beforeend',
        '<a id="late" href="/climber/climber.aspx?cid=900004">Later Climber</a>');
    await waitFor(dom, () => dom.window.document.getElementById('late').nextElementSibling?.classList.contains('bpb-climber-actions-trigger'));
    await open(dom, 'late');
    assert.equal(card.querySelector('.bpb-climber-card-name').textContent, 'Later Climber');
});

test('BFCache suspends the card and refreshes current lists on restoration', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    const card = await open(dom);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    assert.equal(card.hidden, true);
    await dom.chrome.storage.local.set({ [ignoredKey]: { schemaVersion: 1, revision: 1,
        entries: [{ cid: 900002, name: 'Casey Alpine', addedAt: 1 }] } });
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await open(dom);
    await waitFor(dom, () => card.querySelector('#bpb-climber-card-ignore').textContent === 'Unignore climber');
    assert.equal(card.querySelector('#bpb-climber-card-favorite').disabled, true);
});

test('changed identities close the card; hiding its report returns focus to the next row', async t => {
    const dom = await load({ prepare: dom => {
        const list = dom.window.document.getElementById('names');
        const first = dom.window.document.createElement('article');
        const second = dom.window.document.createElement('article');
        first.append(list.querySelector('#casey'));
        second.append(list.querySelector('#morgan'));
        list.append(first, second);
    } }); t.after(() => dom.window.close());
    const card = await open(dom);
    const anchor = dom.window.document.getElementById('casey');
    anchor.href = '/climber/climber.aspx?cid=900004';
    await waitFor(dom, () => card.hidden);
    assert.equal(dom.window.document.activeElement, anchor.nextElementSibling,
        'changing a live identity preserves owned focus without reopening its card');
    await open(dom);
    card.querySelector('.bpb-climber-card-close').focus();
    anchor.closest('article').hidden = true;
    await waitFor(dom, () => card.hidden);
    assert.equal(dom.window.document.activeElement, dom.window.document.getElementById('morgan'));
    const moved = dom.window.document.getElementById('morgan');
    dom.window.document.querySelector('main').append(moved);
    await waitFor(dom, () => moved.nextElementSibling?.classList.contains('bpb-climber-actions-trigger'));
    assert.equal(moved.closest('article'), null, 'cleanup must not move a relocated site link back');
});

test('disappearing card focus skips hidden rows, follows replacements, and uses previous or stable controls', async () => {
    for (const action of ['hide-two', 'replace', 'remove', 'last', 'all-hidden', 'external', 'trigger']) {
        const dom = await load({ prepare: dom => {
            const doc = dom.window.document, list = doc.getElementById('names');
            // The last focus target must be another climber with an actions menu.
            doc.getElementById('owner').href = '/climber/climber.aspx?cid=900004';
            for (const id of ['casey', 'morgan', 'owner']) {
                const row = doc.createElement('article'); row.id = `${id}-row`;
                row.append(doc.getElementById(id)); list.append(row);
            }
            const stable = doc.createElement('button'); stable.id = 'stable-control'; stable.textContent = 'Show all'; list.append(stable);
        } });
        try {
            const doc = dom.window.document;
            const card = action === 'trigger' ? doc.getElementById('bpb-climber-card') : await open(dom, action === 'last' ? 'owner' : 'casey');
            if (action === 'trigger') doc.getElementById('casey').nextElementSibling.focus();
            else card.querySelector('.bpb-climber-card-close').focus();
            if (action === 'external') doc.getElementById('stable-control').focus();
            let expected = doc.getElementById('morgan');
            if (action === 'replace') {
                const row = doc.createElement('article');
                row.innerHTML = '<a id="replacement" href="/climber/climber.aspx?cid=900002">Casey Alpine</a>';
                doc.getElementById('casey-row').replaceWith(row); expected = row.firstElementChild;
            } else if (action === 'remove') doc.getElementById('casey-row').remove();
            else if (action === 'last') {
                doc.getElementById('stable-control').remove(); doc.getElementById('owner-row').remove();
            } else {
                doc.getElementById('casey-row').hidden = true;
                if (action === 'hide-two') { doc.getElementById('morgan-row').hidden = true; expected = doc.getElementById('owner'); }
                if (action === 'all-hidden') {
                    doc.getElementById('morgan-row').hidden = true; doc.getElementById('owner-row').hidden = true;
                    expected = doc.getElementById('stable-control');
                }
                if (action === 'external') expected = doc.getElementById('stable-control');
            }
            await waitFor(dom, () => card.hidden && doc.activeElement === expected);
        } finally { dom.window.close(); }
    }
});

test('failed settings refresh cannot retain an obsolete writable favorite source', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    const card = await open(dom);
    const favorite = card.querySelector('#bpb-climber-card-favorite');
    await waitFor(dom, () => !favorite.disabled);
    const localGet = dom.chrome.storage.local.get, settingsGet = dom.chrome.storage.sync.get;
    dom.chrome.storage.local.get = async () => { throw new Error('unavailable'); };
    await dom.chrome.storage.local.set({ [ignoredKey]: { schemaVersion: 1, revision: 1, entries: [] } });
    const retry = card.querySelector('.bpb-climber-card-retry');
    await waitFor(dom, () => !retry.hidden);
    dom.chrome.storage.sync.get = async () => { throw new Error('unavailable'); };
    fireTrustedEvent(retry, 'click');
    await waitFor(dom, () => card.querySelector('.bpb-climber-card-feedback').textContent.includes("Couldn't load your settings"));
    dom.chrome.storage.local.get = localGet;
    await dom.chrome.storage.local.set({ [ignoredKey]: { schemaVersion: 1, revision: 2, entries: [] } });
    await waitFor(dom, () => !card.querySelector('#bpb-climber-card-ignore').disabled);
    assert.equal(favorite.hidden, true);
    dom.chrome.storage.sync.get = settingsGet;
    fireTrustedEvent(retry, 'click');
    await waitFor(dom, () => !favorite.hidden && !favorite.disabled);
});

test('an account change during Buddy verification cannot authorize Ignore or save its cache', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    let finish;
    dom.window.fetch = async () => new Promise(resolve => { finish = () => resolve({
        status: 200, headers: {}, text: async () => buddyDocument([]),
    }); });
    const card = await open(dom);
    const ignore = card.querySelector('#bpb-climber-card-ignore');
    await waitFor(dom, () => !ignore.disabled);
    fireTrustedEvent(ignore, 'click');
    await waitFor(dom, () => finish);
    const home = [...dom.window.document.querySelectorAll('a')].find(link => link.textContent === 'My Home Page');
    home.href = '/climber/climber.aspx?cid=900009';
    finish();
    await waitFor(dom, () => !card.querySelector('.bpb-climber-card-retry').hidden);
    assert.equal(dom.chrome._localStore[ignoredKey], undefined);
    assert.equal(dom.chrome._localStore.bpbBuddyCache, undefined);
});

test('Ignore shows a Peakbagger limit without saving an unverified absence', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    const card = await open(dom), ignore = card.querySelector('#bpb-climber-card-ignore');
    await waitFor(dom, () => !ignore.disabled);
    dom.window.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '60' } });
    fireTrustedEvent(ignore, 'click');
    await waitFor(dom, () => card.querySelector('.bpb-climber-card-feedback').textContent.includes('Peakbagger request limit reached'));
    assert.equal(dom.chrome._localStore[ignoredKey], undefined);
    assert.match(card.querySelector('.bpb-climber-card-feedback').textContent, /Try again after/);
});
