// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global document, location, innerWidth, innerHeight */

import assert from 'node:assert/strict';

// Run in both browsers against the packaged options page. jsdom has no layout
// or native fragment scrolling, so it cannot detect an escaping app frame.
const readFrame = () => {
    const rect = element => {
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
    };
    const content = document.querySelector('.content');
    return {
        viewport: { width: innerWidth, height: innerHeight },
        rootScroll: document.scrollingElement.scrollTop,
        bodyScroll: document.body.scrollTop,
        nav: rect(document.querySelector('.side-nav')),
        content: rect(content),
        scrollTop: content.scrollTop,
        scrollMax: content.scrollHeight - content.clientHeight,
        target: rect(document.querySelector(location.hash || '#general')),
        hash: location.hash,
        current: document.querySelector('.side-nav [aria-current]')?.getAttribute('href'),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
};

const aboutLanded = () => {
    const content = document.querySelector('.content');
    return location.hash === '#about'
        && document.querySelector('.side-nav a[href="#about"]')?.hasAttribute('aria-current')
        && content.style.scrollBehavior === ''
        && content.dataset.verificationScrolling !== 'true'
        && content.scrollTop + content.clientHeight >= content.scrollHeight - 2;
};

const generalLanded = () => {
    const content = document.querySelector('.content');
    return location.hash === '#general'
        && document.querySelector('.side-nav a[href="#general"]')?.hasAttribute('aria-current')
        && content.style.scrollBehavior === ''
        && content.dataset.verificationScrolling !== 'true'
        && content.scrollTop <= 10;
};

export async function verifySettingsNavigation({ navigate, evaluate, resize, click, back, forward, wait, screenshot }) {
    const landing = async (condition, label) => {
        try {
            await wait(condition);
        } catch (error) {
            throw new Error(`${label} did not land: ${JSON.stringify(await evaluate(readFrame))}`, { cause: error });
        }
    };
    const checkFrame = async (before, label) => {
        const state = await evaluate(readFrame);
        const detail = `${label}: ${JSON.stringify({ before, state })}`;
        assert.equal(state.rootScroll, 0, `document escaped the viewport; ${detail}`);
        assert.equal(state.bodyScroll, 0, `body escaped the viewport; ${detail}`);
        assert.equal(state.horizontalOverflow, false, `page overflowed horizontally; ${detail}`);
        for (const pane of ['nav', 'content']) {
            for (const edge of ['top', 'bottom', 'left', 'right']) {
                assert.ok(Math.abs(state[pane][edge] - before[pane][edge]) <= 1,
                    `${pane} moved after navigation; ${detail}`);
            }
        }
        assert.ok(state.nav.top >= 0 && state.nav.bottom <= state.viewport.height + 1,
            `navigation left the viewport; ${detail}`);
        assert.ok(Math.abs(state.content.bottom - state.viewport.height) <= 1,
            `content pane no longer fills the viewport; ${detail}`);
        assert.ok(state.target.top >= state.content.top - 1
            && state.target.top < state.content.bottom && state.target.bottom > state.content.top,
        `target is outside its content pane; ${detail}`);
        if (state.hash === '#about') {
            assert.ok(state.target.bottom <= state.content.bottom + 1,
                `About links are clipped; ${detail}`);
        }
        await screenshot?.(label);
    };

    for (const [width, height] of [[1982, 1000], [1000, 760], [1000, 420], [480, 760]]) {
        await resize(width, height);
        for (const theme of ['light', 'dark']) {
            const label = `${theme}-${width}-${height}`;
            await navigate('');
            await evaluate(() => {
                const content = document.querySelector('.content');
                // History uses native smooth scrolling. Reaching within two
                // pixels of the target can precede its last animation tick;
                // don't send the next history action until scrollend.
                content.addEventListener('scroll', () => { content.dataset.verificationScrolling = 'true'; });
                content.addEventListener('scrollend', () => { content.dataset.verificationScrolling = 'false'; });
            });
            await evaluate(theme === 'dark'
                ? () => { document.documentElement.dataset.bpbTheme = 'dark'; }
                : () => { document.documentElement.dataset.bpbTheme = 'light'; });
            const before = await evaluate(readFrame);
            await click('.side-nav a[href="#about"]');
            await landing(aboutLanded, `${label}-click`);
            await checkFrame(before, `${label}-click`);
            await click('.side-nav a[href="#general"]');
            await landing(generalLanded, `${label}-return`);
            await checkFrame(before, `${label}-return`);
            await back();
            await landing(aboutLanded, `${label}-back`);
            await checkFrame(before, `${label}-back`);
            await forward();
            await landing(generalLanded, `${label}-forward`);
            await checkFrame(before, `${label}-forward`);
            await navigate('#about');
            await evaluate(theme === 'dark'
                ? () => { document.documentElement.dataset.bpbTheme = 'dark'; }
                : () => { document.documentElement.dataset.bpbTheme = 'light'; });
            await landing(aboutLanded, `${label}-deep-link`);
            await checkFrame(before, `${label}-deep-link`);
        }
    }
}
