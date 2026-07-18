// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Accessibility guard for the site-wide dark theme.
//
// The colors come straight out of the shipped stylesheet (src/site-dark-css.js
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
import { loadPageWithBar } from './helpers/load-page.mjs';
import { darkCss } from '../src/site-dark-css.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    ['input text',           fg('input'),                                   bg('input'),                                   NORMAL],
    ['input placeholder',    fg('input::placeholder'),                      bg('input'),                                   NORMAL],
    ['filter bar text',      fg('#pbaf-bar'),                               bg('#pbaf-bar'),                               NORMAL],
    ['filter label',         fg('.pbaf-label'),                             bg('#pbaf-bar'),                               NORMAL],
    ['chip text',            fg('.pbaf-chip'),                              bg('.pbaf-chip'),                              NORMAL],
    ['chip hover text',      fg('.pbaf-chip:hover'),                        bg('.pbaf-chip'),                              NORMAL],
    ['chip pressed text',    fg('.pbaf-chip[aria-pressed="true"]'),         bg('.pbaf-chip[aria-pressed="true"]'),         NORMAL],
    ['chip count',           fg('.pbaf-chip .pbaf-count'),                  bg('.pbaf-chip'),                              NORMAL],
    ['chip count pressed',   fg('.pbaf-chip[aria-pressed="true"] .pbaf-count'), bg('.pbaf-chip[aria-pressed="true"]'),     NORMAL],
    ['filter words',         fg('.pbaf-words'),                             bg('#pbaf-bar'),                               NORMAL],
    ['filter status',        fg('.pbaf-status'),                            bg('#pbaf-bar'),                               NORMAL],
    ['filter status bold',   fg('.pbaf-status b'),                          bg('#pbaf-bar'),                               NORMAL],
    ['filter reset',         fg('.pbaf-reset'),                             bg('#pbaf-bar'),                               NORMAL],
    ['filter note',          fg('.pbaf-note'),                              bg('#pbaf-bar'),                               NORMAL],
    ['filter note link',     fg('.pbaf-note a'),                            bg('#pbaf-bar'),                               NORMAL],
    ['date sort control',    fg('button.pbaf-date-sort'),                   bg('table.gray'),                              NORMAL],
];

test('every dark-theme text/background pair meets WCAG AA', () => {
    for (const [name, f, b, min] of PAIRS) {
        const ratio = contrast(f, b);
        assert.ok(
            ratio >= min,
            `${name}: ${f} on ${b} = ${ratio.toFixed(2)}:1 (need ${min}:1)`
        );
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
        '.pbaf-date-sort'
    ]) {
        assert.ok(matches(peak, sel), `filter bar element missing from fixture: "${sel}"`);
    }
});
