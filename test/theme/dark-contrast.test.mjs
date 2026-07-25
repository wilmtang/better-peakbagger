// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Accessibility guard for the site-wide dark theme.
//
// The colors come straight out of the shipped stylesheet (src/theme/site-dark-css.js
// is parsed here — it is the single source of truth), so editing a color in the
// theme re-runs it through these WCAG checks automatically. Each pair mirrors
// how a color actually lands in the page: a foreground the theme sets, over the
// background it sits on. The pairings are "grounded" by a separate test that
// asserts the target selectors match real elements in the captured fixtures, so
// we are not contrast-checking dead CSS.
//
// Standard: WCAG 2.1 AA — 4.5:1 for normal text, 3:1 for large text (headings).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadPageWithBar } from '../helpers/load-page.mjs';
import { darkCss } from '../../src/theme/site-dark-css.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// --- WCAG 2.1 relative luminance + contrast ratio ---
const channel = c => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = hex => {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

// --- Parse the shipped dark stylesheet into { exact selector -> declarations } ---
const CSS = darkCss.replace(/\/\*[\s\S]*?\*\//g, '');   // strip comments

const RULES = new Map();
for (const [, selText, declText] of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = {};
    for (const d of declText.split(';')) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        decls[d.slice(0, i).trim()] = d.slice(i + 1).replace(/!important/g, '').trim();
    }
    for (const sel of selText.split(',').map(s => s.trim()).filter(Boolean)) {
        RULES.set(sel, { ...(RULES.get(sel) || {}), ...decls });
    }
}

const P = 'html[data-bpb-theme="dark"]';
const fg = sel => {
    const d = RULES.get(`${P} ${sel}`);
    assert.ok(d && d.color, `theme declares no color for: ${sel}`);
    return d.color;
};
const bg = sel => {
    const d = RULES.get(`${P} ${sel}`);
    assert.ok(d, `theme has no rule for background selector: ${sel}`);
    const v = d['background-color'] || d.background;
    assert.ok(v, `theme declares no background for: ${sel}`);
    return v.split(/\s+/)[0];      // first token of a `background` shorthand
};

// --- The Ascent Beta Filter bar owns its own complete theme ------------------
//
// Its light values and their dark counterparts both live in the STYLE block of
// src/ascent/ascent-filter.js, as --pbaf-* tokens reassigned under the dark
// scope. Resolving them here means the numbers checked below are the ones the
// browser computes, from the one file that declares them.
const filterSource = await readFile(path.join(root, 'src/ascent/ascent-filter.js'), 'utf8');
const BAR_CSS = filterSource
    .match(/const STYLE = `([\s\S]*?)\n`;/)[1]
    .replace(/\/\*[\s\S]*?\*\//g, '');

const parseRules = css => {
    const map = new Map();
    for (const [, selText, declText] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const decls = {};
        for (const d of declText.split(';')) {
            const i = d.indexOf(':');
            if (i < 0) continue;
            decls[d.slice(0, i).trim()] = d.slice(i + 1).replace(/!important/g, '').trim();
        }
        for (const sel of selText.split(',').map(s => s.trim()).filter(Boolean)) {
            map.set(sel, { ...(map.get(sel) || {}), ...decls });
        }
    }
    return map;
};

const BAR_RULES = parseRules(BAR_CSS);
const barTokens = scope => Object.fromEntries(Object.entries(BAR_RULES.get(scope) || {})
    .filter(([key]) => key.startsWith('--pbaf-')));
const LIGHT_TOKENS = barTokens(':root');
const DARK_TOKENS = barTokens(P);

const resolveToken = (value, tokens) => {
    const match = /^var\((--pbaf-[a-z-]+)\)$/.exec((value || '').trim());
    if (!match) return value;
    const resolved = tokens[match[1]];
    assert.ok(resolved, `no dark value for token ${match[1]}`);
    return resolved;
};
const barFg = (sel, tokens = DARK_TOKENS) => {
    const d = BAR_RULES.get(sel);
    assert.ok(d && d.color, `the filter bar declares no color for: ${sel}`);
    return resolveToken(d.color, tokens);
};
const barBg = (sel, tokens = DARK_TOKENS) => {
    const d = BAR_RULES.get(sel);
    assert.ok(d, `the filter bar has no rule for background selector: ${sel}`);
    const v = d['background-color'] || d.background;
    assert.ok(v, `the filter bar declares no background for: ${sel}`);
    return resolveToken(v.split(/\s+/)[0], tokens);
};

const NORMAL = 4.5;
const LARGE = 3.0;   // >= 18pt, or >= 14pt bold — headings

// name, foreground, background, threshold
const PAIRS = [
    ['body text',            fg('body'),                                    bg('body'),                                    NORMAL],
    ['link',                 fg('a:link'),                                  bg('body'),                                    NORMAL],
    ['visited link',         fg('a:visited'),                               bg('body'),                                    NORMAL],
    ['hover link',           fg('a:hover'),                                 bg('body'),                                    NORMAL],
    ['legacy navy text',     fg('[style^="color:navy" i]'),                bg('body'),                                    NORMAL],
    ['legacy maroon text',   fg('[style^="color:maroon" i]'),              bg('body'),                                    NORMAL],
    ['h1',                   fg('h1'),                                      bg('body'),                                    LARGE],
    ['h2',                   fg('h2'),                                      bg('body'),                                    LARGE],
    ['h3',                   fg('h3'),                                      bg('body'),                                    LARGE],
    ['table th',             fg('th'),                                      bg('table.gray'),                              NORMAL],
    ['legacy bgcolor cell',  fg('[bgcolor="#FFFFFF"]'),                     bg('[bgcolor="#FFFFFF"]'),                     NORMAL],
    ['input text',           fg('input:not(.pbaf-control)'),                bg('input:not(.pbaf-control)'),                NORMAL],
    ['input placeholder',    fg('input::placeholder'),                      bg('input:not(.pbaf-control)'),                NORMAL],
    ['filter bar text',      barFg('#pbaf-bar'),                            barBg('#pbaf-bar'),                            NORMAL],
    ['filter label',         barFg('.pbaf-label'),                          barBg('#pbaf-bar'),                            NORMAL],
    ['chip text',            barFg('.pbaf-chip'),                           barBg('.pbaf-chip'),                           NORMAL],
    ['chip hover text',      barFg('.pbaf-chip:hover'),                     barBg('.pbaf-chip'),                           NORMAL],
    ['chip disabled text',   barFg('.pbaf-chip:disabled'),                  barBg('.pbaf-chip'),                           NORMAL],
    ['chip pressed text',    barFg('.pbaf-chip[aria-pressed="true"]'),      barBg('.pbaf-chip[aria-pressed="true"]'),      NORMAL],
    ['chip count',           barFg('.pbaf-chip .pbaf-count'),               barBg('.pbaf-chip'),                           NORMAL],
    ['chip count pressed',   barFg('.pbaf-chip[aria-pressed="true"] .pbaf-count'), barBg('.pbaf-chip[aria-pressed="true"]'), NORMAL],
    ['filter words',         barFg('.pbaf-words'),                          barBg('#pbaf-bar'),                            NORMAL],
    ['filter words input',   barFg('.pbaf-words input'),                    barBg('.pbaf-words input'),                    NORMAL],
    ['filter status',        barFg('.pbaf-status'),                         barBg('#pbaf-bar'),                            NORMAL],
    ['filter status bold',   barFg('.pbaf-status b'),                       barBg('#pbaf-bar'),                            NORMAL],
    ['filter reset',         barFg('.pbaf-reset'),                          barBg('#pbaf-bar'),                            NORMAL],
    ['filter reset hover',   barFg('.pbaf-reset:hover'),                    barBg('#pbaf-bar'),                            NORMAL],
    ['filter note',          barFg('.pbaf-note'),                           barBg('#pbaf-bar'),                            NORMAL],
    ['filter note link',     barFg('#pbaf-bar .pbaf-note a'),               barBg('#pbaf-bar'),                            NORMAL],
    // Every column control, not just the date one: the others used to fall
    // through to the site sheet's blanket button rule and render as grey boxes.
    ['sort control',         barFg('.pbaf-table-sort'),                     bg('table.gray'),                              NORMAL],
    ['sort control hover',   barFg('.pbaf-table-sort:hover'),               bg('table.gray'),                              NORMAL],
];

// The same pairs must also hold in light mode, since one file now declares both.
const LIGHT_PAIRS = [
    ['light filter bar text', barFg('#pbaf-bar', LIGHT_TOKENS),             barBg('#pbaf-bar', LIGHT_TOKENS),              NORMAL],
    ['light chip text',       barFg('.pbaf-chip', LIGHT_TOKENS),            barBg('.pbaf-chip', LIGHT_TOKENS),             NORMAL],
    ['light chip pressed',    barFg('.pbaf-chip[aria-pressed="true"]', LIGHT_TOKENS), barBg('.pbaf-chip[aria-pressed="true"]', LIGHT_TOKENS), NORMAL],
    ['light filter status',   barFg('.pbaf-status', LIGHT_TOKENS),          barBg('#pbaf-bar', LIGHT_TOKENS),              NORMAL],
    ['light filter reset',    barFg('.pbaf-reset', LIGHT_TOKENS),           barBg('#pbaf-bar', LIGHT_TOKENS),              NORMAL],
];

test('every dark-theme text/background pair meets WCAG AA', () => {
    for (const [name, f, b, min] of [...PAIRS, ...LIGHT_PAIRS]) {
        const ratio = contrast(f, b);
        assert.ok(
            ratio >= min,
            `${name}: ${f} on ${b} = ${ratio.toFixed(2)}:1 (need ${min}:1)`
        );
    }
});

// WCAG 2.1 SC 1.4.11 Non-text Contrast: focus indicators and other UI component
// boundaries need 3:1. The text table above cannot see these — an `outline` is
// not a `color` — which is how a 2.38:1 focus ring shipped.
const NON_TEXT = 3.0;
const outline = (sel, tokens = DARK_TOKENS) => {
    const d = BAR_RULES.get(sel);
    assert.ok(d && d.outline, `the filter bar declares no outline for: ${sel}`);
    return resolveToken(d.outline.trim().split(/\s+/).pop(), tokens);
};

// A ring is drawn outside its control, so it is checked against the surface
// behind it: the bar for the bar's own controls, the dark table for the column
// controls that live in the ascent table's header.
const FOCUS_PAIRS = [
    ['chip focus ring',        outline('.pbaf-chip:focus-visible'),        barBg('#pbaf-bar')],
    ['reset focus ring',       outline('.pbaf-reset:focus-visible'),       barBg('#pbaf-bar')],
    ['words input focus ring', outline('.pbaf-words input:focus-visible'), barBg('#pbaf-bar')],
    ['sort control focus ring', outline('.pbaf-table-sort:focus-visible'), bg('table.gray')],
    ['light chip focus ring',  outline('.pbaf-chip:focus-visible', LIGHT_TOKENS),  barBg('#pbaf-bar', LIGHT_TOKENS)],
    ['light reset focus ring', outline('.pbaf-reset:focus-visible', LIGHT_TOKENS), barBg('#pbaf-bar', LIGHT_TOKENS)],
    ['light words focus ring', outline('.pbaf-words input:focus-visible', LIGHT_TOKENS), barBg('#pbaf-bar', LIGHT_TOKENS)],
    ['light sort focus ring',  outline('.pbaf-table-sort:focus-visible', LIGHT_TOKENS), '#ffffff'],
];

test('every focus indicator meets WCAG 2.1 non-text contrast', () => {
    for (const [name, ring, surface] of FOCUS_PAIRS) {
        const ratio = contrast(ring, surface);
        assert.ok(
            ratio >= NON_TEXT,
            `${name}: ${ring} on ${surface} = ${ratio.toFixed(2)}:1 (need ${NON_TEXT}:1)`
        );
    }

    // Every focus-visible rule the bar declares must be covered above, so a new
    // control cannot add an unchecked ring.
    const declared = [...BAR_RULES.keys()].filter(sel => sel.includes(':focus-visible'));
    assert.ok(declared.length >= 4, 'expected the bar to declare focus rings');
    for (const selector of declared) {
        assert.ok(FOCUS_PAIRS.some(([, ring]) => ring === outline(selector)),
            `${selector} declares a focus ring that no pair above checks`);
    }
});

test('every filter-bar theme token has a dark counterpart', () => {
    // The invariant that retires F13's failure class: the bar's theme has one
    // owner, so a control cannot ship with a light value and no dark one.
    assert.ok(Object.keys(LIGHT_TOKENS).length >= 20, 'the bar palette should be tokenised');
    for (const name of Object.keys(LIGHT_TOKENS)) {
        assert.ok(DARK_TOKENS[name], `${name} has no dark value`);
    }
    for (const name of Object.keys(DARK_TOKENS)) {
        assert.ok(LIGHT_TOKENS[name], `${name} has a dark value but no light one`);
    }

    // ...and every colour the bar paints goes through a token, so none can be
    // hardcoded past the dark reassignment.
    for (const [selector, declarations] of BAR_RULES) {
        if (selector === ':root' || selector === P) continue;
        for (const property of ['color', 'background', 'background-color', 'border-color']) {
            const value = declarations[property];
            if (!value || value === 'transparent' || value === 'none') continue;
            assert.match(value, /var\(--pbaf-/,
                `${selector} { ${property} } must use a --pbaf-* token, not ${value}`);
        }
    }

    // The site-wide sheet must not take the bar's theme back over.
    assert.doesNotMatch(CSS, /\.pbaf-(?!control)/,
        'src/theme/site-dark-css.js must not declare filter-bar rules again');
});

test('the backup control light preference overrides every dark semantic color', async () => {
    const css = await readFile(path.join(root, 'src/ascent/ascent-backup.css'), 'utf8');
    const lightSelectors = new Set(Array.from(
        css.matchAll(/:root\[data-bpb-theme="light"\]\s+([^,{]+)\s*\{/g),
        match => match[1].trim()
    ));
    for (const selector of [
        '.bpb-gh-control', '.bpb-gh-ok', '.bpb-gh-err', '.bpb-gh-link',
        '.bpb-gh-btn', '.bpb-gh-btn:hover', '.bpb-gh-btn:focus-visible'
    ]) {
        assert.ok(lightSelectors.has(selector), `${selector} must override OS-dark colors when the extension theme is light`);
    }

    assert.ok(contrast('#2f6b3f', '#ffffff') >= NORMAL, 'light success/link text must meet AA');
    assert.ok(contrast('#b42318', '#ffffff') >= NORMAL, 'light error text must meet AA');
});

test('popup explicit light and dark themes keep their text contrast', async () => {
    const css = (await readFile(path.join(root, 'popup/popup.css'), 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = new Map();
    for (const [, selectorText, declarationText] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const declarations = {};
        for (const declaration of declarationText.split(';')) {
            const separator = declaration.indexOf(':');
            if (separator < 0) continue;
            declarations[declaration.slice(0, separator).trim()] = declaration.slice(separator + 1).trim();
        }
        for (const selector of selectorText.split(',').map(value => value.trim())) {
            rules.set(selector, { ...(rules.get(selector) || {}), ...declarations });
        }
    }
    const color = selector => rules.get(selector)?.color;
    const background = selector => rules.get(selector)?.background;
    const pairs = [
        ['popup dark body', ':root[data-bpb-theme="dark"]', ':root[data-bpb-theme="dark"] body', NORMAL],
        ['popup dark detail', ':root[data-bpb-theme="dark"] .state-detail', ':root[data-bpb-theme="dark"] .state-card', NORMAL],
        ['popup dark button', ':root[data-bpb-theme="dark"] button', ':root[data-bpb-theme="dark"] button', NORMAL],
        ['popup dark empty cue', ':root[data-bpb-theme="dark"] .state-card.empty .state-title::before', ':root[data-bpb-theme="dark"] .state-card.empty .state-title::before', NORMAL],
        ['popup light body', ':root[data-bpb-theme="light"]', ':root[data-bpb-theme="light"] body', NORMAL],
        ['popup light detail', ':root[data-bpb-theme="light"] .state-detail', ':root[data-bpb-theme="light"] .state-card', NORMAL],
        ['popup light button', ':root[data-bpb-theme="light"] button', ':root[data-bpb-theme="light"] button', NORMAL],
        ['popup light empty cue', ':root[data-bpb-theme="light"] .state-card.empty .state-title::before', ':root[data-bpb-theme="light"] .state-card.empty .state-title::before', NORMAL],
    ];
    for (const [name, foregroundSelector, backgroundSelector, minimum] of pairs) {
        const foreground = color(foregroundSelector);
        const surface = background(backgroundSelector);
        assert.ok(foreground && surface, `${name} must declare both colors explicitly`);
        const ratio = contrast(foreground, surface);
        assert.ok(ratio >= minimum, `${name}: ${foreground} on ${surface} = ${ratio.toFixed(2)}:1`);
    }
});

test('dark theme preserves the native mountain motif behind page content', () => {
    const body = RULES.get(`${P} body`);
    const motif = RULES.get(`${P} body::before`);

    assert.equal(body['background-image'], 'none', 'the opaque native tile must not paint directly');
    assert.equal(body.position, 'relative', 'the body must contain the decorative layer');
    assert.equal(body['z-index'], '0', 'the body must isolate the negative decorative layer');
    assert.equal(motif['background-image'], 'url("/image/mewallp.gif")');
    assert.equal(motif['background-repeat'], 'repeat');
    assert.match(motif.filter, /invert\(1\).*brightness\(4\)/);
    assert.equal(motif['mix-blend-mode'], 'screen');
    assert.ok(Number(motif.opacity) <= 0.1, 'the motif must remain subordinate to text');
    assert.equal(motif['z-index'], '-1', 'the motif must paint behind page content');
    assert.equal(motif['pointer-events'], 'none', 'the motif must never intercept input');
});

// The header banner sits on the untouched, light header.jpg photo. Its links
// must stay dark, not the light-on-dark link color used elsewhere (which washed
// out over the photo — the bug this guards against). A solid contrast target is
// undefined over a photo, so we require the text to read against white as a
// proxy for the light image.
test('header banner links stay dark enough for the light header.jpg photo', () => {
    const bannerLinks = [
        '.mainbanner a:link', '.mainbanner a:visited', '.mainbanner a:hover',
        '.mainmenu a:link', '.mainmenu a:visited', '.mainmenu a:hover'
    ];
    for (const sel of bannerLinks) {
        const color = fg(sel);
        assert.notEqual(
            color.toLowerCase(), fg('a:link').toLowerCase(),
            `${sel} must not use the body link color over the light banner photo`
        );
        const ratio = contrast(color, '#ffffff');
        assert.ok(
            ratio >= NORMAL,
            `${sel}: ${color} vs white (light photo proxy) = ${ratio.toFixed(2)}:1 (need ${NORMAL}:1)`
        );
    }
});

test('legacy inline navy text is fixed without flattening other inline colors', () => {
    const dom = new JSDOM(`<!doctype html>
        <html data-bpb-theme="dark">
        <head><style>${darkCss}</style></head>
        <body>
            <span id="start-spaced" style="color: Navy">Help</span>
            <span id="start-tight" style="color:navy">Help</span>
            <span id="middle-spaced" style="font-size:small; color:Navy">Hint</span>
            <span id="middle-tight" style="font-size:small;color:navy">Hint</span>
            <span id="navy-background" style="background-color:navy;color:white">Label</span>
            <span id="error" style="color:Red">Error</span>
            <span id="with-link" style="color: Navy"><a href="#help">Help link</a></span>
        </body>
        </html>`, { url: 'https://www.peakbagger.com/climber/ascentedit.aspx' });

    const color = id => dom.window.getComputedStyle(dom.window.document.getElementById(id)).color;
    for (const id of ['start-spaced', 'start-tight', 'middle-spaced', 'middle-tight', 'with-link']) {
        assert.equal(color(id), 'rgb(148, 173, 197)', `${id} should use the muted help color`);
    }
    assert.notEqual(color('start-spaced'), color('navy-background'), 'help text keeps its own hierarchy');
    assert.notEqual(
        color('start-spaced'),
        dom.window.getComputedStyle(dom.window.document.body).color,
        'help text must remain visually distinct from body text'
    );
    assert.equal(color('navy-background'), 'rgb(255, 255, 255)', 'a navy background is not navy text');
    assert.equal(color('error'), 'rgb(255, 0, 0)', 'status/error colors remain intentional');
    assert.equal(
        dom.window.getComputedStyle(dom.window.document.querySelector('#with-link a')).color,
        'rgb(122, 182, 255)',
        'nested links retain the dark-theme link color'
    );
});

test('generic dark form styling preserves report-editor color samples', () => {
    const dom = new JSDOM(`<!doctype html>
        <html data-bpb-theme="dark">
        <head><style>${darkCss}</style></head>
        <body>
            <button id="generic">Save</button>
            <button id="swatch" class="bpb-re-swatch" style="background:firebrick"></button>
        </body>
        </html>`);
    const style = id => dom.window.getComputedStyle(dom.window.document.getElementById(id));

    assert.equal(style('generic').backgroundColor, 'rgb(43, 47, 52)');
    assert.equal(style('swatch').backgroundColor, 'rgb(178, 34, 34)');
});

test('legacy inline maroon labels use the dark-theme semantic red', () => {
    const dom = new JSDOM(`<!doctype html>
        <html data-bpb-theme="dark">
        <head><style>${darkCss}</style></head>
        <body>
            <span id="start" style="color:maroon">Highest Priority Lists</span>
            <span id="middle" style="font-size:small; color: maroon; font-weight:bold">Most Complete Lists</span>
            <span id="background" style="background-color:maroon;color:white">Label</span>
            <span id="with-link" style="color: maroon"><a href="#metric">P-Index:</a></span>
        </body>
        </html>`, { url: 'https://www.peakbagger.com/climber/climber.aspx' });

    const color = id => dom.window.getComputedStyle(dom.window.document.getElementById(id)).color;
    assert.equal(color('start'), 'rgb(231, 154, 154)');
    assert.equal(color('middle'), 'rgb(231, 154, 154)');
    assert.equal(color('background'), 'rgb(255, 255, 255)', 'a maroon background is not maroon text');
    assert.equal(
        dom.window.getComputedStyle(dom.window.document.querySelector('#with-link a')).color,
        'rgb(122, 182, 255)',
        'nested links retain the dark-theme link color'
    );
});

// Guard against contrast-checking dead CSS: every selector the pairs target
// must match a real element in the captured fixtures.
test('contrast pairs are grounded in real fixtures', async () => {
    const home = new JSDOM(
        await readFile(path.join(root, 'test/fixtures/pages/home-default.html'), 'utf8')
    ).window.document;
    const climber = new JSDOM(
        await readFile(path.join(root, 'test/fixtures/pages/climber-home.html'), 'utf8')
    ).window.document;
    const peak = (await loadPageWithBar('2296-rainier-default-recent-year.html', {
        url: 'https://www.peakbagger.com/climber/PeakAscents.aspx?pid=2296'
    })).window.document;

    const matches = (doc, sel) => doc.querySelector(sel) !== null;
    const anywhere = sel => matches(home, sel) || matches(climber, sel) || matches(peak, sel);

    // Shared site chrome + content, across either capture.
    for (const sel of [
        '.mainbanner a', '.mainmenu a', 'a', 'table.gray', 'h1', 'h2', 'th', 'input',
        '[style*="; color: maroon" i]'
    ]) {
        assert.ok(anywhere(sel), `no fixture element matches "${sel}"`);
    }
    // Filter bar is injected by ascent-filter.js onto the PeakAscents page.
    // `.pbaf-note` is omitted here: it renders only on the condensed
    // "Most Recent Year" view (ascent-filter's compact-notice branch), which no
    // current capture exercises — its colors are still contrast-checked above.
    for (const sel of [
        '#pbaf-bar', '.pbaf-chip', '.pbaf-label', '.pbaf-count', '.pbaf-status', '.pbaf-reset',
        '.pbaf-date-sort', '.pbaf-table-sort', '.pbaf-control'
    ]) {
        assert.ok(matches(peak, sel), `filter bar element missing from fixture: "${sel}"`);
    }

    // Nothing in the bar's stylesheet may target an element the code no longer
    // creates: a `.pbaf-divider` rule outlived its element and shipped for
    // months without anything catching it.
    const RENDERED_ONLY_ON_COMPACT_VIEW = new Set(['.pbaf-note']);
    const styled = new Set();
    for (const selector of BAR_RULES.keys()) {
        for (const [, className] of selector.matchAll(/\.(pbaf-[a-z-]+)/g)) styled.add(`.${className}`);
    }
    assert.ok(styled.size >= 10, 'expected the bar stylesheet to name several classes');
    for (const selector of styled) {
        if (RENDERED_ONLY_ON_COMPACT_VIEW.has(selector)) continue;
        assert.ok(matches(peak, selector),
            `the filter-bar stylesheet styles "${selector}", which no fixture element matches`);
    }
});
