// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The trip-report conversions all pass through one allowlisted AST, and the
// saved value is Peakbagger's own square-bracket dialect. These tests pin the
// expanded semantic output, newline convention, legacy imports, unsafe-markup
// neutralization, and the DOM serializer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { reportMarkup as Markup } from '../src/report-markup.js';

const browserDom = new JSDOM('');
globalThis.DOMParser = browserDom.window.DOMParser;
const markedContext = vm.createContext({});
vm.runInContext(await readFile(new URL('../node_modules/marked/lib/marked.umd.js', import.meta.url), 'utf8'), markedContext);
globalThis.marked = markedContext.marked;

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
        '[h1]Mount Baker via Easton Glacier[/h1]',
        '',
        'We started [b]before dawn[/b] and the crevasses were [i]barely[/i] bridged.',
        'Second line of the same paragraph.',
        '',
        '[ul][li]ice axe[/li][li]crampons[/li][/ul]',
        '',
        '[ol][li]park at Schreibers Meadow[/li][li]camp at the railroad grade[/li][/ol]',
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
        '&#91;x&#93;(javascript:alert(1))');
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

test('GFM blocks and inline syntax map to server-confirmed Peakbagger tags', () => {
    const markdown = [
        '## Route notes',
        '',
        '> Wind on the ridge with **spindrift**.',
        '',
        '- axe',
        '  - leash',
        '- rope',
        '',
        '| Peak | Elev |',
        '| --- | ---: |',
        '| Baker | 10781 |',
        '',
        '~~retreat~~ and `inline_code()`',
        '',
        '![Topo](https://example.com/map.jpg)',
        '',
        '```',
        'two   spaces',
        'new line',
        '```',
        '',
        '---'
    ].join('\n');
    const bracket = Markup.markdownToBracket(markdown);

    assert.match(bracket, /^\[h2\]Route notes\[\/h2\]/);
    assert.match(bracket, /\[blockquote\]Wind on the ridge with \[b\]spindrift\[\/b\]\.\[\/blockquote\]/);
    assert.match(bracket, /\[ul\]\[li\]axe\[ul\]\[li\]leash\[\/li\]\[\/ul\]\[\/li\]\[li\]rope\[\/li\]\[\/ul\]/);
    assert.match(bracket, /\[table border="1"\]\[tr\]\[th\]Peak\[\/th\]\[th\]Elev\[\/th\]\[\/tr\]/);
    assert.match(bracket, /\[s\]retreat\[\/s\] and \[code\]inline_code\(\)\[\/code\]/);
    assert.match(bracket, /\[img src="https:\/\/example\.com\/map\.jpg" alt="Topo"\]/);
    assert.match(bracket, /\[pre\]two   spaces\nnew line\[\/pre\]/);
    assert.match(bracket, /\[hr\]$/);
});

test('safe bracket extensions cover Markdown features without standard syntax', () => {
    const markdown = '[u]under[/u] [mark]marked[/mark] H[sub]2[/sub]O x[sup]2[/sup] '
        + '[small]aside[/small] [q]quoted[/q] [span style="color:red"]red[/span]';
    assert.equal(Markup.markdownToBracket(markdown), markdown);
});

test('images require HTTPS and raw Markdown HTML stays inert', () => {
    assert.equal(Markup.markdownToBracket('![safe](https://example.com/a.jpg)'),
        '[img src="https://example.com/a.jpg" alt="safe"]');
    assert.doesNotMatch(Markup.markdownToBracket('![mixed](http://example.com/a.jpg)'), /\[img /);
    assert.doesNotMatch(Markup.markdownToBracket('![data](data:image/png;base64,AAAA)'), /\[img /);

    const raw = '<iframe src="https://example.com"></iframe>\n\n<script>alert(1)</script>';
    const bracket = Markup.markdownToBracket(raw);
    const preview = Markup.markdownToPreviewHtml(raw);
    assert.doesNotMatch(bracket, /\[(?:iframe|script)\b/i);
    assert.doesNotMatch(preview, /<(?:iframe|script)\b/i);
    assert.match(preview, /&lt;iframe/);
});

test('direct Markdown video links render with native controls and preserve the safe bracket form', () => {
    const source = '![](https://media.example.com/summit.mp4)';
    const bracket = '[video src="https://media.example.com/summit.mp4"][/video]';
    const preview = Markup.markdownToPreviewHtml(source);

    assert.equal(Markup.markdownToBracket(source), bracket);
    assert.match(preview,
        /<video src="https:\/\/media\.example\.com\/summit\.mp4" controls preload="metadata" playsinline referrerpolicy="no-referrer"><\/video>/);
    assert.doesNotMatch(preview, /autoplay/i);
    assert.equal(Markup.bracketToMarkdown(bracket), '![Video](https://media.example.com/summit.mp4)');
    assert.equal(Markup.markdownToBracket(Markup.bracketToMarkdown(bracket)), bracket);

    // `[video]` is also accepted as the explicit Markdown extension, which
    // handles direct media URLs that do not end in a recognizable suffix.
    const signed = '[video src="https://cdn.example.com/download?id=9"][/video]';
    assert.equal(Markup.markdownToBracket(signed), signed);
    assert.doesNotMatch(Markup.markdownToPreviewHtml('![](http://example.com/clip.mp4)'), /<video\b/i);
});

test('Obsidian-style image size suffixes become bounded dimensions, not alt text', () => {
    const widthOnly = '![Topo|500](https://example.com/topo.jpg)';
    const widthAndHeight = '![Route photo|500x600](https://example.com/route.jpg)';

    assert.equal(Markup.markdownToBracket(widthOnly),
        '[img src="https://example.com/topo.jpg" alt="Topo" width="500"]');
    assert.equal(Markup.markdownToBracket(widthAndHeight),
        '[img src="https://example.com/route.jpg" alt="Route photo" width="500" height="600"]');
    assert.match(Markup.markdownToPreviewHtml(widthOnly),
        /<img src="https:\/\/example\.com\/topo\.jpg" alt="Topo" width="500"/);

    const bracket = '[img src="https://example.com/route.jpg" alt="Route photo" width="500" height="600"]';
    assert.equal(Markup.bracketToMarkdown(bracket), widthAndHeight,
        'Rich-sized images should use the same syntax when converted to Markdown');
    assert.equal(Markup.markdownToBracket(Markup.bracketToMarkdown(bracket)), bracket);

    assert.equal(Markup.markdownToBracket('![Literal|1601](https://example.com/a.jpg)'),
        '[img src="https://example.com/a.jpg" alt="Literal|1601"]',
        'an out-of-bounds suffix must remain ordinary alt text');
});

// ---- bracket import ---------------------------------------------------------

test('legacy plain-text lists import and normalize to real Peakbagger lists', () => {
    const report = [
        'Day one was [b]long[/b] but [i]scenic[/i], with [u]new snow[/u].',
        'We used [a href="https://example.com/topo"]this topo[/a].',
        '',
        '- water at the second switchback',
        '- camp on the col'
    ].join('\n');
    assert.equal(Markup.astToBracket(Markup.parseBracket(report)), [
        'Day one was [b]long[/b] but [i]scenic[/i], with [u]new snow[/u].',
        'We used [a href="https://example.com/topo"]this topo[/a].',
        '',
        '[ul][li]water at the second switchback[/li][li]camp on the col[/li][/ul]'
    ].join('\n'));
});

test('angle-bracket forms are accepted on import and normalized to brackets', () => {
    assert.equal(Markup.astToBracket(Markup.parseBracket('a <b>bold</b> move')),
        'a [b]bold[/b] move');
    assert.equal(Markup.astToBracket(Markup.parseBracket('<strong>x</strong> and <em>y</em>')),
        '[b]x[/b] and [i]y[/i]');
    assert.equal(Markup.astToBracket(Markup.parseBracket('[a href=\'https://example.com\']x[/a]')),
        '[a href="https://example.com"]x[/a]');
});

test('server-confirmed inline aliases normalize without losing semantics', () => {
    const source = '[strong]strong[/strong] [em]emphasis[/em] [strike]old[/strike] '
        + '[del]gone[/del] [small]small[/small] [mark]mark[/mark] H[sub]2[/sub]O '
        + 'x[sup]2[/sup] [code]x()[/code] [q]quote[/q] [font color="green"]green[/font]';
    assert.equal(Markup.astToBracket(Markup.parseBracket(source)),
        '[b]strong[/b] [i]emphasis[/i] [s]old[/s] [s]gone[/s] [small]small[/small] '
        + '[mark]mark[/mark] H[sub]2[/sub]O x[sup]2[/sup] [code]x()[/code] '
        + '[q]quote[/q] [span style="color:green"]green[/span]');
});

test('hex colors survive every bracket, Markdown, editor, and preview conversion path', () => {
    for (const color of ['#abc', '#2471a3']) {
        const source = `[span style="color:${color}"]blue[/span]`;
        assert.equal(Markup.astToBracket(Markup.parseBracket(source)), source);
        assert.equal(Markup.bracketToMarkdown(source), source);
        assert.equal(Markup.markdownToBracket(source), source);
        assert.equal(Markup.domToBracket(body(Markup.bracketToEditorHtml(source))), source);
        assert.ok(Markup.bracketToPreviewHtml(source)
            .includes(`<span style="color:${color}">blue</span>`));
    }
    assert.equal(Markup.astToBracket(Markup.parseBracket('[font color="#ABC"]blue[/font]')),
        '[span style="color:#abc"]blue[/span]');
});

test('headings, quotes, tables, preformatted text, rules, and images round-trip', () => {
    const source = [
        '[h2]Heading[/h2]',
        '',
        '[blockquote]Block [q]quote[/q].[/blockquote]',
        '',
        '[table border="1"][tr][th]Peak[/th][th]Elev[/th][/tr][tr][td]Baker[/td][td]10781[/td][/tr][/table]',
        '',
        '[pre]two   spaces\nnew line[/pre]',
        '',
        '[hr]',
        '',
        '[img src="https://example.com/a.jpg" alt="Topo" width="120"]'
    ].join('\n');
    const ast = Markup.parseBracket(source);
    assert.equal(Markup.astToBracket(ast), source);
    const html = Markup.astToHtml(ast);
    assert.match(html, /<h2>Heading<\/h2>/);
    assert.match(html, /<blockquote><p>Block <q>quote<\/q>\.<\/p><\/blockquote>/);
    assert.match(html, /<table>.*<th>Peak<\/th>.*<td>Baker<\/td>.*<\/table>/);
    assert.match(html, /<pre><code>two   spaces\nnew line<\/code><\/pre>/);
    assert.match(html, /<hr>/);
    assert.match(html, /<img [^>]*width="120"/);
});

test('unknown, unclosed, and unsafe tags become visible inert text', () => {
    const cases = new Map([
        ['reached the ridge at [13:45] sharp', 'reached the ridge at [13:45] sharp'],
        ['an [unknown]tag[/unknown] here', 'an &#91;unknown&#93;tag&#91;/unknown&#93; here'],
        ['an unclosed [b]bold run', 'an unclosed &#91;b&#93;bold run'],
        ['[a href="javascript:alert(1)"]click[/a]',
            '&#91;a href="javascript:alert(1)"&#93;click&#91;/a&#93;'],
        ['math like 3 < 4 and a > b', 'math like 3 &lt; 4 and a &gt; b']
    ]);
    for (const [source, expected] of cases) {
        assert.equal(Markup.astToBracket(Markup.parseBracket(source)), expected);
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
    assert.equal(Markup.bracketToEditorHtml(''), '<p></p>');
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
    assert.equal(Markup.markdownToBracket(markdown), [
        '[b]Summit day[/b]',
        '',
        'Went [b]up[/b] the [i]north[/i] side with [u]screws[/u], see [a href="https://example.com"]beta[/a].',
        '',
        '[ul][li]rope[/li][li]pickets[/li][/ul]'
    ].join('\n'));
});

test('table cell line breaks stay inside one Markdown row', () => {
    const bracket = '[table border="1"][tr][th]Peak[/th][th]Notes[/th][/tr]'
        + '[tr][td]Baker[/td][td]snow[br]ice[/td][/tr][/table]';
    const markdown = [
        '| Peak | Notes |',
        '| --- | --- |',
        '| Baker | snow[br]ice |'
    ].join('\n');

    assert.equal(Markup.bracketToMarkdown(bracket), markdown);
    const normalizedBracket = Markup.markdownToBracket(markdown);
    assert.equal(normalizedBracket,
        '[table border="1"][tr][th]Peak[/th][th]Notes[/th][/tr]'
        + '[tr][td]Baker[/td][td]snow\nice[/td][/tr][/table]');
    assert.equal(Markup.bracketToMarkdown(normalizedBracket), markdown);
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
        '[ul][li]alpha[/li][li]beta[/li][/ul]',
        '',
        '[ol][li]uno[/li][/ol]',
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

test('pasted color reads only the last raw declaration and fails closed', () => {
    assert.equal(Markup.domToBracket(body(
        '<p><span style="background:gold; color:#ABC; font-weight:700">safe</span></p>'
    )), '[b][span style="color:#abc"]safe[/span][/b]');
    assert.equal(Markup.domToBracket(body(
        '<p><span style="color:red; color:#2471A3">last</span></p>'
    )), '[span style="color:#2471a3"]last[/span]');

    for (const style of [
        'color:red;color:#12345',
        'color:red;color:rgb(1, 2, 3)',
        'color:hsl(0, 100%, 50%)',
        'color:var(--trip-color)',
        'color:url(https://example.com/color)',
        'color:"red"',
        'background-color:#abc'
    ]) {
        const root = body('<p><span>plain</span></p>');
        root.querySelector('span').setAttribute('style', style);
        assert.equal(Markup.domToBracket(root), 'plain', `style should stay inert: ${style}`);
    }
});

test('Rich serialization revalidates the preserved token instead of CSSOM rgb', () => {
    assert.equal(Markup.domToBracket(body(
        '<p><span style="color:rgb(36, 113, 163)" data-bpb-report-color="#2471a3">blue</span></p>'
    )), '[span style="color:#2471a3"]blue[/span]');
    assert.equal(Markup.domToBracket(body(
        '<p><span style="color:red" data-bpb-report-color="rgb(255, 0, 0)">plain</span></p>'
    )), 'plain');
});

test('unsupported hex lengths stay inert in bracket and Markdown input', () => {
    for (const color of ['#abcd', '#12345', '#1234567', '#2471a380']) {
        const source = `[span style="color:${color}"]plain[/span]`;
        assert.doesNotMatch(Markup.astToBracket(Markup.parseBracket(source)), /\[span\b/);
        assert.doesNotMatch(Markup.markdownToBracket(source), /\[span\b/);
    }
});

test('unsafe DOM is dropped while supported table structure is retained', () => {
    const root = body(
        '<p><a href="javascript:alert(1)">not a link</a></p>'
        + '<p><script>alert(1)</script>plain</p>'
        + '<table><tr><td>cell one</td></tr></table>'
    );
    assert.equal(Markup.domToBracket(root),
        'not a link\n\nplain\n\n[table border="1"][tr][td]cell one[/td][/tr][/table]');
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
    assert.equal(Markup.domToBracket(root), [
        '[b]Header[/b]',
        '',
        'Some [i]notes[/i] with a [a href="https://example.com"]link[/a].',
        'Second line.',
        '',
        '[ul][li]one[/li][li]two[/li][/ul]'
    ].join('\n'));
});
