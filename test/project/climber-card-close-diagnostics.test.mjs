// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { installClimberCardCloseProbe } from '../../scripts/climber-card-close-diagnostics.mjs';

test('isolated close diagnostics preserve setter behavior, record the calling frame, and restore on navigation', t => {
    const dom = new JSDOM('<a id="hover-climber" href="/climber/climber.aspx?cid=900002">Morgan</a><button></button><div id="bpb-climber-card"></div>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const { window } = dom;
    const native = window.Element.prototype.setAttribute;
    const anchor = window.document.getElementById('hover-climber');
    anchor.getBoundingClientRect = () => ({ toJSON: () => ({ top: -100, bottom: -83 }) });
    anchor.getClientRects = () => [{}];
    assert.equal(window.eval(`(${installClimberCardCloseProbe.toString()})()`), true);
    const trigger = anchor.nextElementSibling;
    const card = window.document.getElementById('bpb-climber-card');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('data-unrelated', 'kept');
    assert.equal(card.hasAttribute('data-bpb-verifier-close-trace'), false);
    window.eval('function closeForFixture() { document.querySelector("button").setAttribute("aria-expanded", "false"); } closeForFixture();');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(trigger.getAttribute('data-unrelated'), 'kept');
    const [event] = JSON.parse(card.getAttribute('data-bpb-verifier-close-trace'));
    assert.deepEqual(event.anchor, { top: -100, bottom: -83 });
    assert.equal(event.rects, 1);
    assert.match(event.stack, /closeForFixture/);
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(window.Element.prototype.setAttribute, native);
});
