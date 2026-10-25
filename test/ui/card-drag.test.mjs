// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCardDrag } from '../../src/ui/card-drag.js';
import { pointerEvent } from '../helpers/pointer-event.mjs';
import { registerCardDragContract } from '../helpers/card-drag-contract.mjs';

function setup() {
    const dom = new JSDOM('<div id="left"></div><div id="right"><section id="card"><header><h2>Weather</h2><button id="handle" type="button">Move</button><button id="date" type="button">Previous day</button></header><span id="status"></span></section></div>', { pretendToBeVisual: true });
    const doc = dom.window.document, card = doc.getElementById('card'), handle = doc.getElementById('handle');
    const left = doc.getElementById('left'), right = doc.getElementById('right'), moves = [];
    let position = 'right', active = true, targetList;
    left.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 700, width: 300, height: 700 });
    right.getBoundingClientRect = () => ({ left: 320, right: 620, top: 0, bottom: 700, width: 300, height: 700 });
    card.getBoundingClientRect = () => ({ left: position === 'left' ? 0 : 320, top: 100, width: 300, height: 300 });
    card.scrollIntoView = () => {};
    targetList = [{ id: 'left', element: left, label: 'below trip report' }, { id: 'right', element: right, label: 'below summary' }];
    const controller = createCardDrag({ card, handle, surface: card.querySelector('header'), status: doc.getElementById('status'), name: 'Weather',
        getTargets: () => targetList, getPosition: () => position, enabled: () => active,
        onMove: next => { moves.push(next); position = next; doc.getElementById(next).append(card); },
    });
    const pointer = (type, x, target = dom.window, extra = {}) => target.dispatchEvent(pointerEvent(dom, type, { clientX: x, clientY: 150, button: 0, ...extra }));
    return { dom, doc, card, handle, moves, controller, pointer,
        disable: () => { active = false; controller.refresh(); },
        removeTargets: () => { targetList = []; controller.refresh(); },
        close: () => { controller.dispose(); dom.window.close(); } };
}

registerCardDragContract(test, 'ascent drag adapter', async () => {
    const env = setup(), win = env.dom.window;
    return { position: () => env.card.parentElement.id, active: () => env.card.hasAttribute('data-bpb-card-dragging'),
        start: () => env.pointer('pointerdown', 500, env.handle), smallMove: () => env.pointer('pointermove', 502),
        move: pointerId => env.pointer('pointermove', 150, win, { pointerId }),
        finish: pointerId => env.pointer('pointerup', 150, win, { pointerId }),
        interrupt: reason => reason === 'Escape' ? env.handle.dispatchEvent(new win.KeyboardEvent('keydown', { key: reason, bubbles: true }))
            : ['blur', 'resize'].includes(reason) ? win.dispatchEvent(new win.Event(reason))
                : env.pointer(reason, 150, reason === 'lostpointercapture' ? env.handle : win),
        close: env.close };
});

test('a card follows a thresholded pointer gesture and moves only on a valid drop', () => {
    const env = setup();
    try {
        env.pointer('pointerdown', 400, env.handle);
        env.pointer('pointermove', 396);
        assert.equal(env.card.hasAttribute('data-bpb-card-dragging'), false);
        env.pointer('pointermove', 150);
        assert.equal(env.card.hasAttribute('data-bpb-card-dragging'), true);
        assert.equal(env.card.style.getPropertyValue('--bpb-card-drag-x'), '-250px');
        assert.equal(env.card.parentElement.id, 'right'); assert.deepEqual(env.moves, []);
        assert.equal(env.doc.querySelector('.bpb-card-drop-preview').hidden, false);
        env.handle.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        env.handle.click(); assert.deepEqual(env.moves, [], 'keyboard or clicks cannot commit during a pointer gesture');
        env.pointer('pointerup', 150);
        assert.equal(env.card.parentElement.id, 'left'); assert.deepEqual(env.moves, ['left']);
        assert.equal(env.doc.activeElement, env.handle);
        assert.equal(env.card.hasAttribute('data-bpb-card-dragging'), false);
        assert.equal(env.doc.querySelector('.bpb-card-drop-preview').hidden, true);
        env.handle.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        assert.deepEqual(env.moves, ['left'], 'release click cannot immediately move the card back');
    } finally { env.close(); }
});

test('Escape, blur, pointer cancellation, capture loss and resizing never commit a move', () => {
    for (const cancel of ['escape', 'blur', 'pointercancel', 'lostpointercapture', 'resize']) {
        const env = setup();
        try {
            env.pointer('pointerdown', 400, env.handle); env.pointer('pointermove', 150);
            if (cancel === 'escape') env.dom.window.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            else if (cancel === 'pointercancel') env.pointer(cancel, 150);
            else if (cancel === 'lostpointercapture') env.pointer(cancel, 150, env.handle);
            else env.dom.window.dispatchEvent(new env.dom.window.Event(cancel));
            env.pointer('pointerup', 150);
            assert.deepEqual(env.moves, [], cancel);
            assert.equal(env.card.parentElement.id, 'right');
            assert.equal(env.card.style.getPropertyValue('--bpb-card-drag-x'), '');
            assert.equal(env.doc.documentElement.classList.contains('bpb-card-drag-active'), false);
        } finally { env.close(); }
    }
});

test('interactive header controls and unrelated pointers remain independent of card dragging', () => {
    const env = setup();
    try {
        env.pointer('pointerdown', 400, env.doc.getElementById('date')); env.pointer('pointermove', 150); env.pointer('pointerup', 150);
        assert.deepEqual(env.moves, []);
        env.pointer('pointerdown', 400, env.handle); env.pointer('pointermove', 150, env.dom.window, { pointerId: 2 });
        assert.equal(env.card.hasAttribute('data-bpb-card-dragging'), false);
        env.pointer('pointermove', 150); env.pointer('pointerup', 150, env.dom.window, { pointerId: 2 });
        assert.equal(env.card.hasAttribute('data-bpb-card-dragging'), true);
        env.pointer('pointerup', 150); assert.deepEqual(env.moves, ['left']);
    } finally { env.close(); }
});

test('keyboard and click movement use the same destinations without requiring pointer dragging', () => {
    const env = setup();
    try {
        env.handle.focus();
        env.handle.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        assert.equal(env.card.parentElement.id, 'left');
        assert.equal(env.doc.getElementById('status').textContent, 'Weather moved below trip report.');
        assert.match(env.handle.getAttribute('aria-label'), /below summary/);
        env.handle.click(); assert.deepEqual(env.moves, ['left', 'right']);
    } finally { env.close(); }
});

test('invalid drops, disabling, missing targets and disposal leave the card in its original column', () => {
    for (const action of ['outside', 'disable', 'missing', 'dispose']) {
        const env = setup();
        try {
            env.pointer('pointerdown', 400, env.handle); env.pointer('pointermove', 150);
            if (action === 'disable') env.disable();
            else if (action === 'missing') env.removeTargets();
            else if (action === 'dispose') env.controller.dispose();
            env.pointer('pointerup', action === 'outside' ? 800 : 150);
            assert.deepEqual(env.moves, [], action); assert.equal(env.card.parentElement.id, 'right');
            if (action !== 'outside') { assert.equal(env.handle.hidden, true); env.handle.click(); assert.deepEqual(env.moves, []); }
        } finally { env.close(); }
    }
});
