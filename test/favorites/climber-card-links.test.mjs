// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { climberProfileLists } from '../../src/favorites/climber-card-state.js';
import { loadPage, PAGE_FIXTURES, waitFor, fireTrustedEvent } from '../helpers/load-page.mjs';

const origin = 'https://www.peakbagger.com', profileUrl = `${origin}/climber/climber.aspx?cid=900002`;
const social = (reports = ['b', 'rb']) => '<h4>Social Networking</h4><p>Reports showing a climber\'s buddies and other climbers.</p><ul>'
    + (!reports.includes('b') ? '<li>No Buddy list created yet.</li>' : '')
    + reports.map(report => `<li><a href="/report/report.aspx?r=${report}&amp;cid=900002">${report === 'b' ? 'Buddy List' : 'Reverse Buddy List'}</a></li>`).join('')
    + '<li><a href="/climber/Compare.aspx?cid=900002">Compare Climbers</a>: Compare the ascents of up to 5 climbers</li></ul>';
const profile = reports => `<span id="ListLabel">${social(reports)}</span>`;
const inspect = (t, html, url = profileUrl, cid = 900002) => {
    const dom = new JSDOM(html); t.after(() => dom.window.close());
    return climberProfileLists(dom.window.document, url, cid);
};

test('existing profile social links distinguish available, absent, and unknown lists by climber identity', t => {
    assert.deepEqual(inspect(t, profile(['b', 'rb'])), { buddy: true, reverse: true });
    assert.deepEqual(inspect(t, profile(['rb'])), { buddy: false, reverse: true });
    assert.deepEqual(inspect(t, profile(['b'])), { buddy: true, reverse: false });
    assert.deepEqual(inspect(t, profile([])), { buddy: false, reverse: false });
    for (const html of ['', '<span id="ListLabel"><a>Ascent List</a></span>',
        '<h4>Social Networking</h4><ul><li>No Buddy list created yet.</li></ul>',
        '<span id="ListLabel"><h4>Social Networking</h4><h4>Other</h4><ul><li>No Buddy list created yet.</li></ul></span>']) {
        assert.deepEqual(inspect(t, html), { buddy: null, reverse: null });
    }
    for (const url of [profileUrl.replace('900002', '900003'), `${profileUrl}&cid=900003`,
        `${origin}/climber/PeakAscents.aspx?cid=900002`, profileUrl.replace(origin, 'https://example.com')]) {
        assert.deepEqual(inspect(t, profile([]), url), { buddy: null, reverse: null });
    }
    assert.deepEqual(inspect(t, '<span id="ListLabel"><h4>Social Networking</h4><ul><li>No Buddy list created yet.</li></ul></span>'),
        { buddy: false, reverse: null }, 'an incomplete section cannot establish reverse-list absence');
});

test('profile list evidence rejects foreign, wrong-climber and ambiguous links', t => {
    for (const change of [html => html.replaceAll('/report/report.aspx', 'https://example.com/report/report.aspx'),
        html => html.replaceAll('cid=900002', 'cid=900003'),
        html => html.replaceAll('r=b&', 'r=b&amp;r=rb&').replaceAll('r=rb&', 'r=rb&amp;r=b&')]) {
        const html = change(profile(['b', 'rb'])).replace(/<li><a href="\/climber\/Compare[\s\S]*?<\/li>/, '');
        assert.deepEqual(inspect(t, html), { buddy: null, reverse: null });
    }
});

const load = async (t, html = '') => {
    const dom = await loadPage('climber-other.html', { fixtures: PAGE_FIXTURES, url: profileUrl,
        bundles: ['content/climber-hover-card.js'], settings: { favoritesSource: 'custom' }, prepare: dom => {
            dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
            dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, right: 140, top: 20, bottom: 44, width: 130, height: 24 });
            dom.window.document.getElementById('ListLabel').innerHTML = html;
            dom.window.document.querySelector('main').insertAdjacentHTML('beforeend',
                '<a id="target" href="/climber/climber.aspx?cid=900002">Casey Alpine</a>'
                + '<a id="other" href="/climber/climber.aspx?cid=900003">Morgan Summit</a>');
        } });
    t.after(() => dom.window.close());
    await waitFor(dom, () => dom.window.document.querySelector('#target + button'));
    const card = dom.window.document.getElementById('bpb-climber-card');
    if (typeof card.showPopover !== 'function') card.removeAttribute('popover');
    return dom;
};
const open = (dom, id = 'target') => {
    fireTrustedEvent(dom.window.document.querySelector(`#${id} + button`), 'click');
    return dom.window.document.getElementById('bpb-climber-card');
};

test('card offers all-year ascents and unknown social lists without fetching, and never reuses another climber identity', async t => {
    const dom = await load(t, social(['rb']));
    let requests = 0;
    dom.window.fetch = async () => { requests++; throw new Error('Opening the card must not fetch'); };
    const card = open(dom);
    const links = [...card.querySelectorAll('.bpb-climber-card-links a')];
    assert.deepEqual(links.map(link => link.textContent), ['View profile ↗', 'All ascents ↗', 'Buddy list ↗', 'Reverse buddy list ↗']);
    const ascent = new URL(links[1].href);
    assert.equal(ascent.pathname, '/climber/ClimbListC.aspx');
    assert.deepEqual(Object.fromEntries(ascent.searchParams), { cid: '900002', sort: 'ascentdated', j: '-1', y: '9999' });
    assert.equal(links[2].hidden, true);
    assert.equal(links[3].hidden, false);
    fireTrustedEvent(card.querySelector('.bpb-climber-card-close'), 'click');
    open(dom, 'other');
    for (const link of links) assert.equal(new URL(link.href).searchParams.get('cid'), '900003');
    assert.equal(links[2].hidden, false, 'unknown buddy availability must not be presented as absent');
    assert.equal(links[3].hidden, false);
    assert.equal(requests, 0);
});

test('buddy confirmation reuses its existing profile read on the next opening without moving current links', async t => {
    const dom = await load(t);
    const form = await readFile(new URL('../fixtures/pages/climber-buddy-form.html', import.meta.url), 'utf8');
    let included = false, gets = 0, posts = 0;
    dom.window.fetch = async (url, init) => {
        if (init.method === 'POST') { included = true; posts++; } else gets++;
        const body = (included ? form.replace('Add this Climber as a Buddy', 'This Climber is one of your buddies.')
            .replaceAll('AddBuddy', 'RemoveBuddy').replace('Add to your Buddy List', 'Remove from your Buddy List') : form)
            .replace('</main>', `${profile(['rb'])}</main>`);
        return { status: 200, headers: {}, url: String(url), text: async () => body };
    };
    const card = open(dom), buddy = card.querySelector('#bpb-climber-card-buddy');
    const list = card.querySelector('.bpb-climber-card-links a:nth-child(3)');
    assert.equal(list.hidden, false);
    await waitFor(dom, () => !buddy.disabled);
    fireTrustedEvent(buddy, 'click');
    await waitFor(dom, () => buddy.textContent === 'Remove climbing buddy' && !buddy.disabled);
    assert.equal(list.hidden, false, 'new profile evidence must not reflow an open card');
    fireTrustedEvent(card.querySelector('.bpb-climber-card-close'), 'click');
    open(dom);
    assert.equal(list.hidden, true, 'the existing confirmation response establishes the absent Buddy List');
    assert.equal(gets, 2);
    assert.equal(posts, 1);
});
