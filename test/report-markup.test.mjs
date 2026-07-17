// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The trip-report conversions all pass through one AST, and the saved value
// is Peakbagger's own square-bracket dialect: [b]/[i]/[u]/[a href] inline,
// blank line = paragraph, single newline = line break, never [p] or [br].
// These tests pin that output contract, the conservative import behavior
// (unknown or unsafe markup stays literal), and the DOM serializer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const Markup = require('../src/report-markup.js');

// ---- markdown → bracket ----------------------------------------------------

test('markdown converts to Peakbagger bracket markup', () => {
    const markdown = [
        '# Mount Baker via Easton Glacier',
        '',
        'We started **before dawn** and the crevasses were *barely* bridged.',
        'Second line of the same paragraph.',
        '',
        '- ice axe',
        '- crampons',
        '',
        '1. park at Schreibers Meadow',
        '2. camp at the railroad grade',
        '',
        'Photos: [album](https://example.com/album) and https://example.com/map.'
    ].join('\n');

    assert.equal(Markup.markdownToBracket(markdown), [
        '[b]Mount Baker via Easton Glacier[/b]',
        '',
        'We started [b]before dawn[/b] and the crevasses were [i]barely[/i] bridged.',
        'Second line of the same paragraph.',
        '',
        '- ice axe',
        '- crampons',
        '',
        '1. park at Schreibers Meadow',
        '2. camp at the railroad grade',
        '',
        'Photos: [a href="https://example.com/album"]album[/a] and [a href="https://example.com/map"]https://example.com/map[/a].'
    ].join('\n'));
});

test('the output never contains [p] or [br], the tags Peakbagger warns against', () => {
    const markdown = 'one\n\n\n\ntwo\nthree\n\n\nfour';
    const bracket = Markup.markdownToBracket(markdown);
    assert.doesNotMatch(bracket, /\[\/?(?:p|br)\s*\]/i);
    assert.equal(bracket, 'one\n\ntwo\nthree\n\nfour');
});

test('markdown link targets are sanitized, with https assumed for bare domains', () => {
    assert.equal(Markup.markdownToBracket('[x](example.com/a)'),
        '[a href="https://example.com/a"]x[/a]');
    // javascript: never becomes a link — the text stays literal.
    assert.equal(Markup.markdownToBracket('[x](javascript:alert(1))'),
        '[x](javascript:alert(1))');
    assert.equal(Markup.markdownToBracket('mail me: [me](mailto:a@b.example)'),
        'mail me: [a href="mailto:a@b.example"]me[/a]');
});

test('autolinked URLs shed trailing sentence punctuation but keep balanced parens', () => {
    assert.equal(Markup.markdownToBracket('see https://example.com/a.'),
        'see [a href="https://example.com/a"]https://example.com/a[/a].');
    assert.equal(Markup.markdownToBracket('see https://en.example.org/wiki/Baker_(mountain)'),
        'see [a href="https://en.example.org/wiki/Baker_(mountain)"]https://en.example.org/wiki/Baker_(mountain)[/a]');
});

test('underscores inside words never become emphasis', () => {
    assert.equal(Markup.markdownToBracket('the file peak_list_final.gpx'),
        'the file peak_list_final.gpx');
    assert.equal(Markup.markdownToBracket('_lead_ measured'), '[i]lead[/i] measured');
});

// ---- bracket import ---------------------------------------------------------

test('existing bracket reports parse and re-serialize unchanged (idempotent)', () => {
    const report = [
        'Day one was [b]long[/b] but [i]scenic[/i], with [u]new snow[/u].',
        'We used [a href="https://example.com/topo"]this topo[/a].',
        '',
        '- water at the second switchback',
        '- camp on the col'
    ].join('\n');
    assert.equal(Markup.astToBracket(Markup.parseBracket(report)), report);
});

test('angle-bracket forms are accepted on import and normalized to brackets', () => {
    assert.equal(Markup.astToBracket(Markup.parseBracket('a <b>bold</b> move')),
        'a [b]bold[/b] move');
    assert.equal(Markup.astToBracket(Markup.parseBracket('<strong>x</strong> and <em>y</em>')),
        '[b]x[/b] and [i]y[/i]');
    assert.equal(Markup.astToBracket(Markup.parseBracket('[a href=\'https://example.com\']x[/a]')),
        '[a href="https://example.com"]x[/a]');
});

test('unknown tags, unclosed tags, and unsafe links stay literal text', () => {
    for (const literal of [
        'reached the ridge at [13:45] sharp',
        'an [unknown]tag[/unknown] here',
        'an unclosed [b]bold run',
        '[a href="javascript:alert(1)"]click[/a]',
        'math like 3 < 4 and a > b'
    ]) {
        assert.equal(Markup.astToBracket(Markup.parseBracket(literal)), literal,
            `should stay literal: ${literal}`);
    }
});

test('editor HTML escapes text content so imports cannot inject markup', () => {
    const html = Markup.bracketToEditorHtml('x <script>alert(1)</script> y');
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /&lt;script&gt;/);

    const link = Markup.bracketToEditorHtml('[a href="https://example.com/?q=\"onmouseover=\"x"]t[/a]');
    assert.doesNotMatch(link, /onmouseover=/);
});

test('bracket reports render to editor HTML with paragraphs and lists', () => {
    const html = Markup.bracketToEditorHtml('one\ntwo\n\n- a\n- b\n\n1. c');
    assert.equal(html, '<p>one<br>two</p><ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>');
    assert.equal(Markup.bracketToEditorHtml(''), '<p><br></p>');
});

test('bracket ↔ markdown mode switching round-trips the supported formatting', () => {
    const bracket = [
        '[b]Summit day[/b]',
        '',
        'Went [b]up[/b] the [i]north[/i] side with [u]screws[/u], see [a href="https://example.com"]beta[/a].',
        '',
        '- rope',
        '- pickets'
    ].join('\n');
    const markdown = Markup.bracketToMarkdown(bracket);
    assert.equal(markdown, [
        '**Summit day**',
        '',
        'Went **up** the *north* side with [u]screws[/u], see [beta](https://example.com).',
        '',
        '- rope',
        '- pickets'
    ].join('\n'));
    assert.equal(Markup.markdownToBracket(markdown), bracket);
});

// ---- editor DOM → bracket ----------------------------------------------------

const body = html => {
    const dom = new JSDOM(`<div id="root">${html}</div>`);
    return dom.window.document.getElementById('root');
};

test('contenteditable DOM serializes to bracket markup', () => {
    const root = body(
        '<p>First <b>bold</b> and <i>italic</i> and <u>under</u>.</p>'
        + '<p>Line one<br>line two</p>'
        + '<ul><li>alpha</li><li>beta</li></ul>'
        + '<ol><li>uno</li></ol>'
        + '<p><a href="https://example.com/a">link</a></p>'
    );
    assert.equal(Markup.domToBracket(root), [
        'First [b]bold[/b] and [i]italic[/i] and [u]under[/u].',
        '',
        'Line one\nline two',
        '',
        '- alpha',
        '- beta',
        '',
        '1. uno',
        '',
        '[a href="https://example.com/a"]link[/a]'
    ].join('\n'));
});

test('style-based formatting from paste (span font-weight etc.) is recognized', () => {
    const root = body(
        '<div><span style="font-weight:700">heavy</span> and '
        + '<span style="font-style:italic">slanted</span> and '
        + '<span style="text-decoration:underline">lined</span></div>'
    );
    assert.equal(Markup.domToBracket(root), '[b]heavy[/b] and [i]slanted[/i] and [u]lined[/u]');
});

test('unsafe or unknown DOM is flattened to its text', () => {
    const root = body(
        '<p><a href="javascript:alert(1)">not a link</a></p>'
        + '<p><script>alert(1)</script>plain</p>'
        + '<table><tr><td>cell one</td></tr></table>'
    );
    assert.equal(Markup.domToBracket(root), 'not a link\n\nplain\n\ncell one');
});

test('empty editor states serialize to an empty report', () => {
    assert.equal(Markup.domToBracket(body('<p><br></p>')), '');
    assert.equal(Markup.domToBracket(body('')), '');
    assert.equal(Markup.domToBracket(body('<div><br></div><div><br></div>')), '');
});

test('nbsp from the editor becomes a plain space in the saved report', () => {
    assert.equal(Markup.domToBracket(body('<p>a&nbsp;b</p>')), 'a b');
});

test('editor round-trip: bracket → editor HTML → DOM → bracket is stable', () => {
    const bracket = [
        '[b]Header[/b]',
        '',
        'Some [i]notes[/i] with a [a href="https://example.com"]link[/a].',
        'Second line.',
        '',
        '- one',
        '- two'
    ].join('\n');
    const root = body(Markup.bracketToEditorHtml(bracket));
    assert.equal(Markup.domToBracket(root), bracket);
});
