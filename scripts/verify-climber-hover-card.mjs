// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, innerWidth, innerHeight, getComputedStyle */
import assert from 'node:assert/strict';

export function climberCardPlacementReady() {
    const card = document.getElementById('bpb-climber-card');
    const rect = card?.getBoundingClientRect();
    const anchor = document.getElementById('hover-climber').getBoundingClientRect();
    return rect?.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        // Firefox can differ by 1/32768px at a shared edge. Permit at most
        // one CSS pixel of layout rounding while retaining the overlap check.
        && (rect.bottom <= anchor.top + 1 || rect.top >= anchor.bottom - 1)
        && getComputedStyle(card).opacity === '1'
        && card.getAnimations().every(animation => animation.playState === 'finished');
}

export async function prepareClimberCardViewport({ evaluate, resize, key, wait }, width, height) {
    // Resizing and recentering can legitimately move an open card's anchor
    // offscreen. Establish each geometry sample before explicitly reopening;
    // hover travel and keyboard ownership are tested separately below.
    if (!await evaluate(() => document.getElementById('bpb-climber-card').hidden)) {
        await key('.bpb-climber-card-close', 'Escape');
        await wait(() => document.getElementById('bpb-climber-card').hidden);
    }
    await resize(width, height);
    await evaluate(() => document.getElementById('hover-climber').scrollIntoView({ block: 'center' }));
    await wait(() => {
        const anchor = document.getElementById('hover-climber').getBoundingClientRect();
        return anchor.top >= 0 && anchor.bottom <= innerHeight;
    });
    await key('#hover-climber + .bpb-climber-actions-trigger', 'Enter');
    await wait(() => {
        const card = document.getElementById('bpb-climber-card');
        return !card.hidden && card.contains(document.activeElement)
            && !card.querySelector('[aria-busy="true"]');
    });
}

// Drive the actual isolated-world bundle through native input, shared by the
// full Chrome/Firefox manifest verifiers. No mock runtime or optimistic writes.
export async function verifyClimberHoverCard({ evaluate, wait, click, hover, key, resize, screenshot }) {
    const capture = async name => {
        for (const [width, height] of [[1000, 760], [480, 760], [360, 760], [320, 760]]) {
            await prepareClimberCardViewport({ evaluate, resize, key, wait }, width, height);
            for (const theme of ['light', 'dark']) {
                await evaluate(theme === 'dark'
                    ? () => { document.documentElement.dataset.bpbTheme = 'dark'; }
                    : () => { document.documentElement.dataset.bpbTheme = 'light'; });
                await wait(climberCardPlacementReady).catch(async error => {
                    const state = await evaluate(() => {
                        const card = document.getElementById('bpb-climber-card');
                        const bounds = node => node?.getBoundingClientRect().toJSON();
                        return { hidden: card?.hidden, card: bounds(card),
                            anchor: bounds(document.getElementById('hover-climber')),
                            heading: bounds(card?.querySelector('.bpb-climber-card-heading')),
                            feedback: bounds(card?.querySelector('.bpb-climber-card-feedback')),
                            main: bounds(card?.querySelector('.bpb-climber-card-main')),
                            viewport: { width: innerWidth, height: innerHeight },
                            opacity: card && getComputedStyle(card).opacity,
                            animations: card?.getAnimations().map(animation => animation.playState) };
                    });
                    throw new Error(`Climber card ${name}/${theme}/${width} did not settle: ${JSON.stringify(state)}`, { cause: error });
                });
                const geometry = await evaluate(() => {
                    const card = document.getElementById('bpb-climber-card');
                    const rect = card.getBoundingClientRect();
                    const controls = [...card.querySelectorAll('a, button')].filter(node => node.getClientRects().length)
                        .map(node => ({ text: node.textContent, left: node.getBoundingClientRect().left,
                            right: node.getBoundingClientRect().right, height: node.getBoundingClientRect().height,
                            scroll: node.scrollWidth, client: node.clientWidth }));
                    return { width: innerWidth, topLayer: card.matches(':popover-open'),
                        card: { left: rect.left, right: rect.right, bottom: rect.bottom }, controls,
                        horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
                        secondaryActions: ['bpb-climber-card-favorite', 'bpb-climber-card-ignore'].map(id => {
                            const button = document.getElementById(id), style = getComputedStyle(button);
                            const bounds = button.getBoundingClientRect();
                            return { width: bounds.width, height: bounds.height, background: style.backgroundColor,
                                border: style.borderTopWidth, borderStyle: style.borderTopStyle, borderColor: style.borderTopColor,
                                radius: style.borderRadius, color: style.color, padding: style.padding,
                                weight: style.fontWeight, textAlign: style.textAlign };
                        }),
                        triggerBackground: getComputedStyle(document.querySelector('#hover-climber + button')).backgroundColor,
                        color: getComputedStyle(card).color, background: getComputedStyle(card).backgroundColor };
                });
                assert.equal(geometry.topLayer, true, 'card is not in the browser top layer');
                assert.equal(geometry.width, width, 'browser did not apply the requested content viewport');
                assert.equal(geometry.horizontalOverflow, false, JSON.stringify(geometry));
                assert.deepEqual(geometry.secondaryActions[1], geometry.secondaryActions[0],
                    `Ignore must match the favorite button: ${JSON.stringify(geometry)}`);
                assert.equal(geometry.secondaryActions[1].border, '1px', JSON.stringify(geometry));
                assert.ok(geometry.secondaryActions[1].height >= 42, JSON.stringify(geometry));
                assert.equal(geometry.triggerBackground, 'rgba(0, 0, 0, 0)', JSON.stringify(geometry));
                assert.ok(geometry.controls.every(control => control.height > 0 && control.left >= geometry.card.left
                    && control.right <= geometry.card.right + 1
                    // Firefox gives inline links no client box; their rect is the boundary.
                    && (control.client === 0 || control.scroll <= control.client + 1)), JSON.stringify(geometry));
                await screenshot?.(`${name}-${theme}-${width}`);
            }
        }
    };
    await wait(() => document.querySelector('#hover-climber + .bpb-climber-actions-trigger'));
    const normalLink = await evaluate(() => ({ href: document.getElementById('hover-climber').getAttribute('href'),
        tabIndex: document.getElementById('hover-climber').tabIndex }));
    assert.deepEqual(normalLink, { href: '/climber/climber.aspx?cid=900002', tabIndex: 0 });
    await evaluate(() => document.getElementById('hover-climber').scrollIntoView({ block: 'center' }));
    await wait(() => {
        const rect = document.getElementById('hover-climber').getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
    });
    await hover('#hover-climber');
    await wait(() => !document.getElementById('bpb-climber-card').hidden);
    assert.equal(await evaluate(() => document.getElementById('bpb-climber-card').contains(document.activeElement)), false,
        'hover must not move keyboard focus');
    await hover('#bpb-climber-card-favorite');
    await wait(() => document.getElementById('bpb-climber-card-favorite').matches(':hover'));
    assert.equal(await evaluate(() => document.getElementById('bpb-climber-card').hidden), false,
        'card must survive pointer travel from the name');
    await key('#hover-climber', 'Tab');
    await wait(() => document.activeElement?.matches('#hover-climber + .bpb-climber-actions-trigger'));
    await key('#hover-climber + .bpb-climber-actions-trigger', 'Enter');
    await wait(() => !document.getElementById('bpb-climber-card').hidden
        && document.getElementById('bpb-climber-card-favorite')?.disabled === false);
    assert.equal(await evaluate(() => document.querySelector('.bpb-climber-card-buddy').textContent), 'Add climbing buddy');
    assert.equal(await evaluate(() => document.activeElement?.matches('.bpb-climber-card-buddy')), true,
        'explicit keyboard opening must focus the first action');
    await capture('available');
    await click('#bpb-climber-card-favorite');
    await wait(() => document.getElementById('bpb-climber-card-favorite')?.textContent === 'Remove favorite climber'
        && document.getElementById('bpb-climber-card-ignore')?.disabled === true);
    await capture('favorite');
    await click('#bpb-climber-card-favorite');
    await wait(() => document.getElementById('bpb-climber-card-ignore')?.disabled === false);
    await click('#bpb-climber-card-ignore');
    await wait(() => document.getElementById('bpb-climber-card-ignore')?.textContent === 'Unignore climber'
        && document.getElementById('bpb-climber-card-favorite')?.disabled === true);
    await capture('ignored');
    await key('#bpb-climber-card-ignore', 'Escape');
    await wait(() => document.getElementById('bpb-climber-card').hidden);
    assert.equal(await evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Climber actions for Morgan Longlastname');
    await key('#hover-climber + .bpb-climber-actions-trigger', 'Enter');
    await wait(() => !document.getElementById('bpb-climber-card').hidden);
    await click('#bpb-climber-card-ignore');
    await wait(() => document.getElementById('bpb-climber-card-ignore')?.textContent === 'Ignore climber'
        && document.getElementById('bpb-climber-card-favorite')?.disabled === false);
    await evaluate(() => { document.getElementById('hover-climber').textContent = 'Morgan Longlastname of the Eastern Cascades'; });
    await wait(() => document.getElementById('bpb-climber-card-name')?.textContent === 'Morgan Longlastname of the Eastern Cascades');
    await capture('long-name');
    await key('#bpb-climber-card-ignore', 'Escape');
    await wait(() => document.getElementById('bpb-climber-card').hidden);
    await click('#hover-self + .bpb-climber-actions-trigger');
    await wait(() => document.getElementById('bpb-climber-card-name')?.textContent === 'Alex Doe');
    assert.equal(await evaluate(() => document.getElementById('bpb-climber-card-favorite').hidden), true);
    await click('.bpb-climber-card-close');
    const focusCases = [
        { expected: 'focus-first-trigger', alter: () => {
            const link = document.getElementById('focus-first');
            link.nextElementSibling.id = 'focus-first-trigger';
            link.href = '/climber/climber.aspx?cid=900010';
        } },
        { expected: 'focus-third', alter: () => {
            document.getElementById('focus-first-row').hidden = true;
            document.getElementById('focus-second-row').hidden = true;
        } },
        { expected: 'focus-replacement', alter: () => {
            const row = document.createElement('article');
            row.innerHTML = '<a id="focus-replacement" href="/climber/climber.aspx?cid=900002">Morgan Longlastname</a>';
            document.getElementById('focus-first-row').replaceWith(row);
        } },
        { expected: 'focus-second', alter: () => document.getElementById('focus-first-row').remove() },
        { start: 'third', expected: 'focus-second', alter: () => {
            document.getElementById('focus-stable').remove();
            document.getElementById('focus-third-row').remove();
        } },
        { expected: 'focus-stable', alter: () => {
            document.getElementById('focus-first-row').hidden = true;
            document.getElementById('focus-second-row').hidden = true;
            document.getElementById('focus-third-row').hidden = true;
        } },
        { expected: 'focus-stable', alter: () => {
            document.getElementById('focus-stable').focus();
            document.getElementById('focus-first-row').remove();
        } },
    ];
    for (const { expected, alter, start = 'first' } of focusCases) {
        await evaluate(() => {
            document.getElementById('focus-probe')?.remove();
            const section = document.createElement('section'); section.id = 'focus-probe';
            section.innerHTML = ['first', 'second', 'third'].map((name, index) =>
                `<article id="focus-${name}-row"><a id="focus-${name}" href="/climber/climber.aspx?cid=${900002 + index}">Example ${name}</a></article>`).join('')
                + '<button id="focus-stable">Show all</button>';
            (document.querySelector('main') || document.body).append(section);
            section.scrollIntoView({ block: 'center' });
        });
        await wait(() => document.querySelector('#focus-first + .bpb-climber-actions-trigger'));
        await click(`#focus-${start} + .bpb-climber-actions-trigger`);
        await wait(() => document.getElementById('bpb-climber-card').contains(document.activeElement));
        await evaluate(alter);
        await wait(() => document.getElementById('bpb-climber-card')?.hidden
            && document.activeElement?.id?.startsWith('focus-'));
        assert.equal(await evaluate(() => document.activeElement.id), expected);
    }
    await evaluate(() => document.getElementById('focus-probe').remove());
}
