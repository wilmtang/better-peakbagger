// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, innerWidth, SubmitEvent, getComputedStyle */
import assert from 'node:assert/strict';

// Both real manifests must guard native Buddy actions as well as our own
// buttons. The fixture's request count proves that a blocked click never
// reaches Peakbagger; jsdom alone cannot prove the execution-world ordering.
export async function verifyClimberMembership({ evaluate, wait, click, key, resize, screenshot, mutations }) {
    const capture = async name => {
        for (const [width, height] of [[1000, 760], [480, 760]]) {
            await resize(width, height);
            for (const theme of ['light', 'dark']) {
                await evaluate(theme === 'dark'
                    ? () => { document.documentElement.dataset.bpbTheme = 'dark'; }
                    : () => { document.documentElement.dataset.bpbTheme = 'light'; });
                const geometry = await evaluate(() => {
                    const note = document.getElementById('bpb-climber-membership-note');
                    const rect = note.getBoundingClientRect();
                    const button = document.getElementById('bpb-climber-ignore');
                    const buttonRect = button.getBoundingClientRect();
                    return { text: note.textContent, hidden: note.hidden, width: innerWidth, left: rect.left, right: rect.right,
                        height: rect.height, scroll: note.scrollWidth, client: note.clientWidth,
                        button: { left: buttonRect.left, right: buttonRect.right, height: buttonRect.height,
                            disabled: button.disabled, opacity: getComputedStyle(button).opacity } };
                });
                assert.ok(geometry.button.height > 0 && geometry.button.left >= 0
                    && geometry.button.right <= geometry.width, `Ignore is clipped: ${JSON.stringify(geometry)}`);
                if (name === 'ignored') {
                    assert.ok(!geometry.hidden && geometry.text && geometry.height > 0 && geometry.left >= 0
                        && geometry.right <= geometry.width && geometry.scroll <= geometry.client + 1,
                    `membership guidance is clipped: ${JSON.stringify(geometry)}`);
                } else {
                    assert.equal(geometry.text, '', 'protected climber shows redundant membership guidance');
                    assert.equal(geometry.hidden, true, 'empty membership note occupies space');
                    assert.equal(geometry.button.disabled, true, 'protected climber can be ignored');
                    assert.equal(geometry.button.opacity, '0.5', 'disabled Ignore is not dimmed');
                }
                await screenshot?.(`${name}-${theme}-${width}`);
            }
        }
    };
    await wait(() => document.getElementById('bpb-climber-favorite')?.disabled === false
        && document.getElementById('bpb-climber-ignore')?.disabled === false);
    await click('#bpb-climber-favorite');
    await wait(() => document.getElementById('bpb-climber-favorite')?.textContent === '★'
        && document.getElementById('bpb-climber-ignore')?.disabled === true
        && document.getElementById('bpb-climber-membership-note')?.hidden === true);
    await capture('favorite');
    await click('#bpb-climber-favorite');
    await wait(() => document.getElementById('bpb-climber-ignore')?.disabled === false);
    await click('#bpb-climber-ignore');
    await wait(() => document.getElementById('bpb-climber-ignore')?.textContent === 'Unignore'
        && document.getElementById('bpb-climber-ignore')?.disabled === false
        && document.getElementById('bpb-climber-favorite')?.disabled === true
        && document.getElementById('BuddyButton')?.getAttribute('aria-disabled') === 'true');
    const baseline = mutations();
    await click('#BuddyButton');
    await key('#BuddyButton');
    // Submit-path protection must work even when a native form uses a
    // different control type than this fixture's Ajax button.
    const prevented = await evaluate(() => {
        const control = document.getElementById('BuddyButton');
        const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: control });
        control.form.dispatchEvent(event);
        return event.defaultPrevented;
    });
    assert.equal(prevented, true, 'ignored climber native Buddy form was not blocked');
    assert.equal(mutations(), baseline, 'blocked native Buddy action sent a request');
    assert.equal(await evaluate(() => document.getElementById('BuddyButton').value), 'Add to My Buddy List');
    await capture('ignored');
    await click('#bpb-climber-ignore');
    await wait(() => document.getElementById('bpb-climber-favorite')?.disabled === false
        && document.getElementById('bpb-climber-ignore')?.disabled === false
        && document.getElementById('BuddyButton')?.getAttribute('aria-disabled') !== 'true');
    await click('#BuddyButton');
    await wait(() => /^Remove\b/.test(document.getElementById('BuddyButton')?.value || '')
        && document.getElementById('bpb-climber-ignore')?.disabled === true
        && document.getElementById('bpb-climber-membership-note')?.hidden === true);
    await capture('buddy');
    await click('#BuddyButton');
    await wait(() => /^Add\b/.test(document.getElementById('BuddyButton')?.value || '')
        && document.getElementById('bpb-climber-favorite')?.textContent === '☆'
        && document.getElementById('bpb-climber-ignore')?.disabled === false);
}
