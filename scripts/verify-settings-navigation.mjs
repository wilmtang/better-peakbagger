// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global document, window, location, innerWidth, innerHeight, requestAnimationFrame, getComputedStyle */

import assert from 'node:assert/strict';

export const readSettingsHierarchy = () => {
    const type = node => {
        const style = getComputedStyle(node);
        return { text: node.textContent.trim(), size: parseFloat(style.fontSize), color: style.color,
            lineHeight: parseFloat(style.lineHeight) };
    };
    const content = document.querySelector('.content');
    const body = getComputedStyle(document.body);
    return {
        body: { size: parseFloat(body.fontSize), color: body.color },
        sections: [...document.querySelectorAll('.settings-section > .section-title')].map(type),
        groups: [...document.querySelectorAll('.subsection-title')].filter(node => node.getClientRects().length).map(type),
        labels: [...document.querySelectorAll('.settings-section .title')].filter(node => node.getClientRects().length).map(type),
        overflow: content.scrollWidth > content.clientWidth + 1,
        overflowingElements: [...content.querySelectorAll('*')].filter(node => {
            const rect = node.getBoundingClientRect();
            return rect.width && rect.right > content.getBoundingClientRect().right + 1;
        }).slice(0, 10).map(node => ({ tag: node.tagName, id: node.id, className: node.className })),
        overflowingRows: [...document.querySelectorAll('.row')].filter(node => node.clientWidth && node.scrollWidth > node.clientWidth + 1)
            .map(node => node.querySelector('.title')?.textContent || node.id),
    };
};

export function assertSettingsHierarchy(state) {
    assert(state.sections.length && state.groups.length && state.labels.length, 'The settings typography check must inspect rendered content');
    const maxContent = Math.max(state.body.size, ...state.labels.map(label => label.size));
    for (const heading of state.groups) {
        assert(heading.size > maxContent, `Subsection heading must be larger than its content: ${JSON.stringify({ heading, maxContent })}`);
        assert.equal(heading.color, state.body.color, `Subsection headings must use primary text: ${heading.text}`);
        assert(heading.lineHeight >= heading.size * 1.25, `Heading lines need room to wrap: ${heading.text}`);
    }
    for (const heading of state.sections) assert(heading.size > Math.max(...state.groups.map(group => group.size)),
        `Section headings must lead their subsections: ${heading.text}`);
    assert.equal(state.overflow, false, `Settings content must wrap within its pane: ${JSON.stringify({ rows: state.overflowingRows, elements: state.overflowingElements })}`);
    assert.deepEqual(state.overflowingRows, [], 'Settings cards must not clip overflowing row content');
}

const readFeatureLayout = () => {
    const input = document.getElementById(window.bpbSettingsFeatureCheck.id);
    const rect = node => {
        const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
    };
    return { input: rect(input), row: rect(input.closest('.row')), panel: rect(document.getElementById('general-features')),
        heading: rect(document.getElementById('general-features-heading')), following: rect(document.getElementById('general-units')),
        scroll: { root: document.scrollingElement.scrollTop, content: document.querySelector('.content').scrollTop } };
};
const featureSaved = async () => {
    const { id, key, target } = window.bpbSettingsFeatureCheck;
    const api = globalThis.browser || globalThis.chrome;
    const { bpbSettings } = await api.storage.sync.get('bpbSettings');
    return bpbSettings[key] === target && document.getElementById(id).checked === target;
};

async function verifyFeatureSwitches({ evaluate, wait, toggle }) {
    for (const [id, key] of [['enable-garmin-inbox', 'enableGarminInbox'], ['show-sun-moon', 'showSunMoon'],
        ['show-weather', 'showWeather'], ['show-summit-cloud', 'showSummitCloud'], ['show-snotel', 'showSnotel'], ['enable-3d-map', 'enable3dMap']]) {
        await evaluate(({ id, key }) => {
            const input = document.getElementById(id);
            if (input.closest('.subsection')?.id !== 'general-features') throw new Error(`Ungrouped feature: ${id}`);
            input.closest('.row').scrollIntoView({ block: 'center', behavior: 'instant' });
            input.focus({ preventScroll: true });
            window.bpbSettingsFeatureCheck = { id, key, target: !input.checked };
        }, { id, key });
        const before = await evaluate(readFeatureLayout);
        for (let pass = 0; pass < 2; pass++) {
            await toggle(`#${id}`); await wait(featureSaved);
            const after = await evaluate(readFeatureLayout);
            for (const part of Object.keys(before)) for (const dimension of Object.keys(before[part])) {
                assert(Math.abs(before[part][dimension] - after[part][dimension]) <= 1,
                    `Feature switch moved ${id}/${part}.${dimension}: ${JSON.stringify({ before, after })}`);
            }
            assert.equal(await evaluate(() => document.activeElement.id), id);
            await evaluate(() => { window.bpbSettingsFeatureCheck.target = !window.bpbSettingsFeatureCheck.target; });
        }
    }
}

export const readDisconnectedGithubControls = () => {
    const favorites = document.getElementById('favorites-auto-backup');
    const ignored = document.getElementById('ignored-sync-enable');
    const state = {
        favorites: { checked: favorites.checked, disabled: favorites.disabled },
        ignored: { checked: ignored.checked, disabled: ignored.disabled },
        settingsHidden: document.getElementById('settings-backup-github-actions').hidden,
        photosHidden: document.getElementById('photos-github-actions').hidden,
        favoritesStatus: document.getElementById('favorites-github-status').textContent,
        ignoredStatus: document.getElementById('ignored-github-status').textContent,
    };
    return { ...state, ready: !state.favorites.checked && state.favorites.disabled
        && !state.ignored.checked && state.ignored.disabled && state.settingsHidden && state.photosHidden
        && /Connect GitHub/.test(state.favoritesStatus) && /Connect GitHub/.test(state.ignoredStatus) };
};

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
        scrollBehavior: content.style.scrollBehavior,
        verificationScrolling: content.dataset.verificationScrolling,
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

const garminLanded = () => {
    const content = document.querySelector('.content');
    const target = document.getElementById('capture-garmin');
    return location.hash === '#capture-garmin'
        && document.querySelector('.side-nav a[href="#capture-garmin"]')?.hasAttribute('aria-current')
        && document.querySelector('.nav-parent-active')?.getAttribute('href') === '#capture'
        && !!document.getElementById('garmin-key')
        && target.getBoundingClientRect().top >= content.getBoundingClientRect().top - 1
        && target.getBoundingClientRect().top < content.getBoundingClientRect().bottom
        && content.style.scrollBehavior === ''
        && content.dataset.verificationScrolling !== 'true';
};

export async function verifySettingsNavigation({ navigate, evaluate, resize, click, toggle, back, forward, wait, screenshot }) {
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
                // Reaching the target can precede the final animation tick.
                // Chrome 128 can omit scrollend after fragment/history jumps,
                // so wait for two rendered frames without another scroll event.
                let scrollRevision = 0;
                content.addEventListener('scroll', () => {
                    content.dataset.verificationScrolling = 'true';
                    const revision = ++scrollRevision;
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        if (revision === scrollRevision) content.dataset.verificationScrolling = 'false';
                    }));
                });
            });
            // Persist the theme through the real control: saving the inbox
            // switch re-applies settings and would undo a dataset-only override.
            await wait(() => document.getElementById('enable-garmin-inbox').checked);
            await evaluate(theme === 'dark'
                ? () => { const control = document.getElementById('theme'); control.value = 'dark'; control.dispatchEvent(new Event('change')); }
                : () => { const control = document.getElementById('theme'); control.value = 'light'; control.dispatchEvent(new Event('change')); });
            await wait(theme === 'dark'
                ? () => document.documentElement.dataset.bpbTheme === 'dark'
                : () => document.documentElement.dataset.bpbTheme === 'light');
            assertSettingsHierarchy(await evaluate(readSettingsHierarchy));
            await navigate('#general-features');
            await landing(() => {
                const target = document.getElementById('general-features'), content = document.querySelector('.content');
                const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
                return document.querySelector('.side-nav [aria-current]')?.getAttribute('href') === '#general-features'
                    && content.style.scrollBehavior === '' && content.dataset.verificationScrolling !== 'true'
                    && Math.abs(target.getBoundingClientRect().top - content.getBoundingClientRect().top - margin) <= 1;
            }, `${label}-features-deep-link`);
            await screenshot?.(`${label}-features`);
            // Each switch uses the same native control. Exercise every write
            // once per browser; repeating all twelve writes at every size can
            // exhaust Chrome sync storage's per-minute quota later in the run.
            if (width === 1000 && height === 760 && theme === 'light') await verifyFeatureSwitches({ evaluate, wait, toggle });
            await navigate('#general');
            await landing(generalLanded, `${label}-features-return`);
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
            // The established narrow layout exposes parent chips only.
            if (width > 720) {
                await click('.side-nav a[href="#capture-garmin"]');
                await landing(garminLanded, `${label}-garmin-click`);
                await checkFrame(before, `${label}-garmin-click`);
                await back();
                await landing(aboutLanded, `${label}-garmin-back`);
                await forward();
                await landing(garminLanded, `${label}-garmin-forward`);
            }
            await navigate('#ignored-github');
            await landing(() => {
                const content = document.querySelector('.content'), target = document.getElementById('ignored-github').getBoundingClientRect();
                const pane = content.getBoundingClientRect();
                return document.querySelector('.side-nav [aria-current]')?.getAttribute('href') === '#github-favorites-backup'
                    && content.style.scrollBehavior === '' && content.dataset.verificationScrolling !== 'true'
                    && target.top >= pane.top - 1 && target.top < pane.bottom && target.bottom > pane.top;
            }, `${label}-ignored-deep-link`);
            await checkFrame(before, `${label}-ignored-deep-link`);
            await navigate('#capture-garmin');
            await evaluate(theme === 'dark'
                ? () => { document.documentElement.dataset.bpbTheme = 'dark'; }
                : () => { document.documentElement.dataset.bpbTheme = 'light'; });
            await landing(garminLanded, `${label}-garmin-deep-link`);
            await checkFrame(before, `${label}-garmin-deep-link`);
            await navigate('#general');
            await landing(generalLanded, `${label}-garmin-switch`);
            await wait(() => document.getElementById('enable-garmin-inbox').checked);
            const readSwitch = () => {
                const rect = document.getElementById('enable-garmin-inbox').getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scroll: document.querySelector('.content').scrollTop };
            };
            const toggleBefore = await evaluate(readSwitch);
            await click('#enable-garmin-inbox');
            await wait(() => document.getElementById('capture-garmin').hidden
                && document.querySelector('a[href="#capture-garmin"]').closest('li').hidden);
            const toggleAfter = await evaluate(readSwitch);
            for (const key of Object.keys(toggleBefore)) assert(Math.abs(toggleAfter[key] - toggleBefore[key]) <= 1, `Garmin switch moved: ${key} ${toggleBefore[key]} → ${toggleAfter[key]}`);
            assert.equal(await evaluate(() => document.documentElement.dataset.bpbTheme), theme);
            await screenshot?.(`${label}-garmin-disabled`);
            await navigate('#capture-garmin');
            await landing(generalLanded, `${label}-disabled-deep-link`);
            assert.equal(await evaluate(() => document.getElementById('enable-garmin-inbox').checked), false);
            await click('#enable-garmin-inbox');
            await wait(() => !document.getElementById('capture-garmin').hidden
                && !document.querySelector('a[href="#capture-garmin"]').closest('li').hidden);

        }
    }
}
