// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEditor, editorReady, editors, modeButton, waitFor } from '../helpers/report-editor-helpers.mjs';

const image = '[img src="https://example.com/ridge.jpg" alt="Ridge" width="320" height="200"]';

// The positions of a word within the document, found through its text so each
// test reads as the words it paints.
const findText = (editor: { state: { doc: { descendants(visit: (node: { isText: boolean; text?: string }, pos: number) => void): void } } }, word: string) => {
    let found: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
        const at = node.isText ? node.text!.indexOf(word) : -1;
        if (at >= 0 && !found) found = { from: pos + at, to: pos + at + word.length };
    });
    assert.ok(found, word);
    return found as unknown as { from: number; to: number };
};

const open = async (report: string) => {
    const dom = await loadEditor({ report });
    const ui: Element = await editorReady(dom);
    const editor = editors(dom).rich;
    const painter = ui.querySelector('[aria-label^="Format painter"]') as HTMLButtonElement;
    const box = ui.querySelector('.bpb-re-painterbox') as HTMLElement;
    const select = (word: string) => editor.commands.setTextSelection(findText(editor, word));
    const click = (detail = 1, shiftKey = false) => painter.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail, shiftKey }));
    // A finished pointer selection, as a drag leaves it.
    const drag = async (word: string, detail = 1) => {
        const surface = ui.querySelector('.bpb-re-surface')!;
        surface.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, detail }));
        select(word);
        surface.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, detail }));
        await new Promise(resolve => dom.window.setTimeout(resolve, 5));
    };
    const key = (init: KeyboardEventInit) => editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    const saved = () => {
        modeButton(dom.window.document, 'Plain').click();
        return (dom.window.document.getElementById('JournalText') as HTMLTextAreaElement).value;
    };
    return { dom, ui, editor, painter, box, select, click, drag, key, saved };
};

test('one click copies the format, the next pointer selection receives it, and the painter ends', async () => {
    const t = await open('[b][i]Source[/i][/b] then target words');
    try {
        t.select('Source');
        t.click();
        assert.equal(t.painter.getAttribute('aria-pressed'), 'true');
        assert.equal(t.box.hidden, false);
        assert.match(t.box.textContent!, /Select text/);
        assert.ok(t.ui.classList.contains('bpb-re-painting'));
        await t.drag('target');
        assert.equal(t.painter.getAttribute('aria-pressed'), 'false');
        assert.equal(t.box.hidden, true);
        assert.equal(t.ui.classList.contains('bpb-re-painting'), false);
        await t.drag('words');
        assert.equal(t.saved(), '[b][i]Source[/i][/b] then [b][i]target[/i][/b] words');
    } finally { t.dom.window.close(); }
});

test('painting replaces the target formatting exactly and keeps its link', async () => {
    const t = await open('[i]Source[/i] [b]bold[/b] [a href="https://example.com/x"]link[/a]');
    try {
        t.select('Source'); t.click();
        await t.drag('bold');
        t.select('Source'); t.click();
        await t.drag('link');
        assert.equal(t.saved(), '[i]Source[/i] [i]bold[/i] [a href="https://example.com/x" target="_blank"][i]link[/i][/a]');
    } finally { t.dom.window.close(); }
});

test('a double-click stays armed until a press, Escape or the close control ends it', async () => {
    const t = await open('[u]Source[/u] one two three four');
    try {
        t.select('Source');
        t.click(1); t.click(2);
        assert.ok(t.painter.classList.contains('bpb-re-tool-locked'));
        await t.drag('one');
        await t.drag('two');
        assert.equal(t.painter.getAttribute('aria-pressed'), 'true');
        t.click();
        assert.equal(t.painter.getAttribute('aria-pressed'), 'false');
        assert.equal(t.painter.classList.contains('bpb-re-tool-locked'), false);
        await t.drag('three');

        t.select('Source');
        t.click(1, true);
        assert.ok(t.painter.classList.contains('bpb-re-tool-locked'), 'Shift+activation is the keyboard route');
        t.key({ key: 'Escape' });
        assert.equal(t.box.hidden, true);
        await t.drag('four');

        t.select('Source');
        t.click();
        (t.box.querySelector('.bpb-re-boxclose') as HTMLButtonElement).click();
        assert.equal(t.painter.getAttribute('aria-pressed'), 'false');
        assert.equal(t.saved(), '[u]Source[/u] [u]one[/u] [u]two[/u] three four');
    } finally { t.dom.window.close(); }
});

test('the keyboard copies and applies without painting a selection still being extended', async () => {
    const t = await open('[b]Source[/b] target');
    try {
        t.select('Source');
        t.key({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true, metaKey: true, altKey: true });
        if (t.painter.getAttribute('aria-pressed') !== 'true') {
            t.key({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true, altKey: true });
        }
        assert.equal(t.painter.getAttribute('aria-pressed'), 'true');
        t.select('target');
        assert.equal(t.ui.querySelectorAll('.bpb-re-surface strong').length, 1, 'selection alone must not apply');
        t.key({ key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true, altKey: true });
        if (t.painter.getAttribute('aria-pressed') === 'true') t.key({ key: 'v', code: 'KeyV', keyCode: 86, metaKey: true, altKey: true });
        assert.equal(t.painter.getAttribute('aria-pressed'), 'false');
        assert.equal(t.saved(), '[b]Source[/b] [b]target[/b]');
    } finally { t.dom.window.close(); }
});

test('a keyboard press on the button returns focus to the text', async () => {
    const t = await open('[b]Source[/b] target');
    try {
        t.select('Source');
        t.painter.focus();
        t.click(0);
        assert.equal(t.painter.getAttribute('aria-pressed'), 'true');
        // TipTap focuses on the next frame.
        await waitFor(t.dom, () => t.dom.window.document.activeElement === t.editor.view.dom);
        assert.ok(t.dom.window.document.activeElement === t.editor.view.dom);
    } finally { t.dom.window.close(); }
});

test('a stray click leaves the painter armed, and typing cancels it', async () => {
    const t = await open('[b]Source[/b] target');
    try {
        t.select('Source'); t.click();
        const surface = t.ui.querySelector('.bpb-re-surface')!;
        surface.dispatchEvent(new t.dom.window.MouseEvent('mousedown', { bubbles: true }));
        t.editor.commands.setTextSelection(findText(t.editor, 'target').from);
        surface.dispatchEvent(new t.dom.window.MouseEvent('mouseup', { bubbles: true }));
        await new Promise(resolve => t.dom.window.setTimeout(resolve, 5));
        assert.equal(t.painter.getAttribute('aria-pressed'), 'true');
        t.editor.commands.insertContent('x');
        assert.equal(t.painter.getAttribute('aria-pressed'), 'false');
    } finally { t.dom.window.close(); }
});

test('a double-click waits for a possible third press before painting', async () => {
    const t = await open('[b]Source[/b] target words');
    try {
        t.select('Source'); t.click();
        await t.drag('target', 2);
        assert.equal(t.painter.getAttribute('aria-pressed'), 'true', 'word selection may still become a paragraph');
        await t.drag('target words', 3);
        assert.equal(t.painter.getAttribute('aria-pressed'), 'false');
        assert.equal(t.saved(), '[b]Source[/b] [b]target words[/b]');
    } finally { t.dom.window.close(); }
});

test('a block style follows a whole-block selection and only then', async () => {
    const t = await open('[h2]Heading[/h2]\n\nWhole paragraph\n\nPartial paragraph');
    try {
        t.select('Heading'); t.click(1, true);
        await t.drag('Whole paragraph');
        await t.drag('Partial');
        t.click();
        assert.equal(t.saved(), '[h2]Heading[/h2]\n\n[h2]Whole paragraph[/h2]\n\nPartial paragraph');
    } finally { t.dom.window.close(); }
});

test('undo reverses one painted selection as a single step', async () => {
    const t = await open('[h2][i]Source[/i][/h2]\n\nTarget');
    try {
        t.select('Source'); t.click();
        await t.drag('Target');
        assert.equal(t.ui.querySelectorAll('.bpb-re-surface h2')[1]?.querySelector('em')?.textContent, 'Target');
        t.editor.commands.undo();
        assert.equal(t.ui.querySelectorAll('.bpb-re-surface h2').length, 1);
        assert.equal(t.ui.querySelectorAll('.bpb-re-surface em').length, 1);
        assert.equal(t.saved(), '[h2][i]Source[/i][/h2]\n\nTarget');
    } finally { t.dom.window.close(); }
});

test('undo during a locked run keeps the painter armed', async () => {
    const t = await open('[b]Source[/b] one');
    try {
        t.select('Source'); t.click(1, true);
        await t.drag('one');
        t.editor.commands.undo();
        assert.equal(t.painter.getAttribute('aria-pressed'), 'true');
    } finally { t.dom.window.close(); }
});

test('captions can be the source or the target, and never take a block style', async () => {
    const caption = `[figure]${image}[figcaption][i]North[/i] ridge[/figcaption][/figure]`;
    const t = await open(`[h3][b]Heading[/b][/h3]\n\n${caption}\n\nProse words`);
    try {
        t.select('Heading'); t.click();
        await t.drag('ridge');
        assert.equal(t.ui.querySelector('figcaption strong')?.textContent, 'ridge');
        assert.equal(t.ui.querySelector('figure h3'), null);
        t.select('North'); t.click();
        await t.drag('Prose words');
        assert.equal(t.saved(), `[h3][b]Heading[/b][/h3]\n\n[figure]${image}[figcaption][i]North[/i] [b]ridge[/b][/figcaption][/figure]\n\n[i]Prose words[/i]`);
    } finally { t.dom.window.close(); }
});

test('a selected photo has nothing to copy, and painting skips a selected photo', async () => {
    const t = await open(`[b]Source[/b]\n\n[figure]${image}[figcaption]North[/figcaption][/figure]`);
    try {
        let figure = -1;
        t.editor.state.doc.descendants((node: { type: { name: string } }, pos: number) => { if (node.type.name === 'reportFigure') figure = pos; });
        t.editor.commands.setNodeSelection(figure);
        assert.equal(t.painter.disabled, true);
        t.select('Source'); t.click();
        const surface = t.ui.querySelector('.bpb-re-surface')!;
        surface.dispatchEvent(new t.dom.window.MouseEvent('mousedown', { bubbles: true }));
        t.editor.commands.setNodeSelection(figure);
        surface.dispatchEvent(new t.dom.window.MouseEvent('mouseup', { bubbles: true }));
        await new Promise(resolve => t.dom.window.setTimeout(resolve, 5));
        assert.equal(t.painter.getAttribute('aria-pressed'), 'true');
        assert.equal(t.painter.disabled, false, 'an armed painter can always be ended from its button');
        assert.equal(t.ui.querySelector('figcaption strong'), null);
    } finally { t.dom.window.close(); }
});

test('switching modes or opening another popover cancels the painter', async () => {
    const t = await open('[b]Source[/b] target');
    try {
        t.select('Source'); t.click();
        (t.ui.querySelector('[aria-label="More formats"]') as HTMLButtonElement).click();
        assert.equal(t.painter.getAttribute('aria-pressed'), 'false');
        assert.equal(t.box.hidden, true);
        t.select('Source'); t.click();
        modeButton(t.dom.window.document, 'Markdown').click();
        assert.equal(t.box.hidden, true);
        modeButton(t.dom.window.document, 'Rich text').click();
        assert.equal(t.ui.querySelector('[aria-label^="Format painter"]')?.getAttribute('aria-pressed'), 'false');
    } finally { t.dom.window.close(); }
});
