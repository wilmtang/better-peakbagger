// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEditor, editorReady, editors, modeButton, typeMarkdown } from '../helpers/report-editor-helpers.mjs';

const image = '[img src="https://example.com/ridge.jpg" alt="Rocky ridge" width="320" height="200"]';
const figure = `[figure]${image}[figcaption]North ridge[/figcaption][/figure]`;
const selectImage = (editor, occurrence = 0) => {
    const positions = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') positions.push(pos);
    });
    editor.commands.setNodeSelection(positions[occurrence]);
};
const pressKey = (dom, editor, key) => editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const captionButton = (ui, label) => [...ui.querySelectorAll('.bpb-re-captionbar button')]
    .find(button => button.textContent === label);
const saved = dom => {
    modeButton(dom.window.document, 'Plain').click();
    return dom.window.document.getElementById('JournalText').value;
};

test('deleting the image through a selection transaction removes its entire captioned figure', async () => {
    const dom = await loadEditor({ report: `${figure}\n\nAfter` });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        selectImage(editor);
        editor.commands.deleteSelection();
        assert.equal(ui.querySelector('figure'), null);
        assert.equal(saved(dom), 'After');
    } finally { dom.window.close(); }
});

test('clearing caption text unwraps the image immediately and undo restores the caption', async () => {
    const dom = await loadEditor({ report: figure });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        let start;
        editor.state.doc.descendants((node, pos) => { if (node.type.name === 'reportCaption') start = pos + 1; });
        editor.view.dispatch(editor.state.tr.delete(start, start + 'North ridge'.length));
        assert.equal(ui.querySelector('figure'), null);
        assert.ok(ui.querySelector('.bpb-re-image-resize img'));
        editor.commands.undo();
        assert.equal(ui.querySelector('figcaption')?.textContent, 'North ridge');
    } finally { dom.window.close(); }
});

test('every uncaptioned image offers a direct placeholder without changing saved text', async () => {
    const dom = await loadEditor({ report: image });
    try {
        const ui = await editorReady(dom);
        const placeholder = ui.querySelector('.bpb-re-caption-placeholder');
        assert.equal(placeholder.getAttribute('aria-label'), 'Write a caption');
        assert.equal(saved(dom), image);
        modeButton(dom.window.document, 'Rich text').click();
        ui.querySelector('.bpb-re-caption-placeholder').click();
        const editor = editors(dom).rich;
        assert.equal(editor.state.selection.$from.parent.type.name, 'reportCaption');
        editor.commands.insertContent('North ridge');
        assert.equal(saved(dom), figure);
    } finally { dom.window.close(); }
});

for (const source of [image, figure]) {
    test(`arrow keys reach ordinary text on both sides of ${source === image ? 'an image' : 'a captioned figure'}`, async () => {
        const dom = await loadEditor({ report: source });
        try {
            const ui = await editorReady(dom);
            const editor = editors(dom).rich;
            assert.equal(captionButton(ui, 'Text before image'), undefined);
            assert.equal(captionButton(ui, 'Text after image'), undefined);
            selectImage(editor);
            pressKey(dom, editor, 'ArrowUp');
            assert.equal(editor.state.selection.$from.parent.type.name, 'paragraph');
            editor.commands.insertContent('Before');
            selectImage(editor);
            pressKey(dom, editor, 'ArrowDown');
            assert.equal(editor.state.selection.$from.parent.type.name, 'paragraph');
            editor.commands.insertContent('After');
            const childCount = editor.state.doc.childCount;
            selectImage(editor);
            pressKey(dom, editor, 'ArrowLeft');
            assert.equal(editor.state.selection.$from.parent.textContent, 'Before');
            pressKey(dom, editor, 'ArrowRight');
            assert.equal(editor.state.selection.node?.type.name, source === image ? 'image' : 'reportFigure');
            pressKey(dom, editor, 'ArrowRight');
            assert.equal(editor.state.selection.$from.parent.textContent, 'After');
            assert.equal(editor.state.selection.$from.parentOffset, 0);
            pressKey(dom, editor, 'ArrowLeft');
            assert.equal(editor.state.selection.node?.type.name, source === image ? 'image' : 'reportFigure');
            pressKey(dom, editor, 'ArrowLeft');
            assert.equal(editor.state.selection.$from.parent.textContent, 'Before');
            assert.equal(editor.state.doc.childCount, childCount);
            assert.equal(saved(dom), `Before\n\n${source}\n\nAfter`);
        } finally { dom.window.close(); }
    });
}

test('typing Markdown delimiters in captions preserves literal text', async () => {
    const dom = await loadEditor({ report: image });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        selectImage(editor);
        captionButton(ui, 'Add caption').click();
        const literal = '*asterisks* **bold** _underscores_ `code` ~~strike~~ [brackets] | pipe';
        for (const character of literal) {
            const { from, to } = editor.state.selection;
            const handled = editor.view.someProp('handleTextInput', handler =>
                handler(editor.view, from, to, character));
            if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
        }
        assert.equal(ui.querySelector('figcaption').textContent, literal);
        captionButton(ui, 'Remove caption').click();
        editor.commands.undo();
        assert.equal(ui.querySelector('figcaption')?.textContent, literal);
        modeButton(dom.window.document, 'Markdown').click();
        modeButton(dom.window.document, 'Rich text').click();
        assert.equal(ui.querySelector('figcaption').textContent, literal);
        assert.equal(ui.querySelector('img').getAttribute('alt'), 'Rocky ridge');
    } finally { dom.window.close(); }
});

test('adding, typing, undoing and removing a caption preserves the photo and surrounding prose', async () => {
    const dom = await loadEditor({ report: `[b]Before[/b] ${image} [i]After[/i]` });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        selectImage(editor);
        assert.equal(ui.querySelector('.bpb-re-captionbar').hidden, false);
        captionButton(ui, 'Add caption').click();
        assert.equal(editor.state.selection.$from.parent.type.name, 'reportCaption');
        assert.equal(captionButton(ui, 'Edit caption').getAttribute('aria-label'), 'Edit caption');
        editor.commands.insertContent('North ridge');
        assert.equal(ui.querySelector('figcaption').textContent, 'North ridge');
        assert.equal(ui.querySelector('img').getAttribute('alt'), 'Rocky ridge');
        assert.equal(saved(dom), `[b]Before[/b]\n\n${figure}\n\n[i]After[/i]`);
        modeButton(dom.window.document, 'Rich text').click();
        selectImage(editors(dom).rich);
        captionButton(ui, 'Remove caption').click();
        assert.equal(ui.querySelector('figure'), null);
        assert.ok(ui.querySelector('.bpb-re-image-resize img'));
        editors(dom).rich.commands.undo();
        assert.equal(ui.querySelector('figcaption').textContent, 'North ridge');
        editors(dom).rich.commands.redo();
        assert.equal(ui.querySelector('figure'), null);
    } finally { dom.window.close(); }
});

test('caption editing works inside lists and table cells and preserves an image link', async () => {
    for (const source of [
        `[ul][li]${image}[/li][/ul]`,
        `[table border="1"][tr][th]Photo[/th][/tr][tr][td]${image}[/td][/tr][/table]`,
        `[a href="https://example.com/album"]${image}[/a]`,
    ]) {
        const dom = await loadEditor({ report: source });
        try {
            const ui = await editorReady(dom);
            selectImage(editors(dom).rich);
            captionButton(ui, 'Add caption').click();
            assert.equal(editors(dom).rich.state.selection.$from.parent.type.name, 'reportCaption', source);
            editors(dom).rich.commands.insertContent('North ridge');
            const output = saved(dom);
            assert.match(output, /\[figure\].*\[figcaption\]North ridge/);
            if (source.includes('[a ')) assert.match(output, /\[figure\]\[a href="https:\/\/example.com\/album"(?: target="_blank")?\]/);
            if (source.includes('[ul]')) assert.match(output, /^\[ul\]\[li\]/);
            if (source.includes('[table')) assert.match(output, /^\[table/);
        } finally { dom.window.close(); }
    }
});

test('captions survive mode edits, serialization and reopening with exact occurrence identity', async () => {
    const dom = await loadEditor({ report: `${figure}\n\n${figure.replace('North ridge', 'South ridge')}` });
    let output;
    try {
        const ui = await editorReady(dom);
        assert.equal(ui.querySelectorAll('figure').length, 2);
        modeButton(dom.window.document, 'Markdown').click();
        const markdown = editors(dom).markdown.getValue();
        assert.match(markdown, /<figcaption>North ridge<\/figcaption>/);
        typeMarkdown(dom, markdown.replace('South ridge', 'West ridge'));
        modeButton(dom.window.document, 'Rich text').click();
        assert.deepEqual([...ui.querySelectorAll('.bpb-re-surface figcaption')].map(node => node.textContent), ['North ridge', 'West ridge']);
        selectImage(editors(dom).rich, 1);
        captionButton(ui, 'Edit caption').click();
        editors(dom).rich.commands.insertContent('Looking at ');
        output = saved(dom);
        assert.match(output, /Looking at West ridge/);
    } finally { dom.window.close(); }
    const reopened = await loadEditor({ report: output });
    try {
        const ui = await editorReady(reopened);
        assert.deepEqual([...ui.querySelectorAll('.bpb-re-surface figcaption')].map(node => node.textContent), ['North ridge', 'Looking at West ridge']);
    } finally { reopened.window.close(); }
});

test('caption keyboard boundaries allow exit without deleting the photo', async () => {
    const dom = await loadEditor({ report: figure });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        selectImage(editor);
        captionButton(ui, 'Edit caption').click();
        editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
        assert.equal(editor.state.selection.node.type.name, 'reportFigure');
        assert.equal(ui.querySelector('figcaption').textContent, 'North ridge');
        captionButton(ui, 'Edit caption').click();
        editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        assert.equal(editor.state.selection.$from.parent.type.name, 'paragraph');
        editor.commands.insertContent('Next paragraph');
        assert.equal(saved(dom), `${figure}\n\nNext paragraph`);
    } finally { dom.window.close(); }
});

test('an empty caption does not save placeholder text or rewrite an untouched report', async () => {
    const dom = await loadEditor({ report: image });
    try {
        const ui = await editorReady(dom);
        selectImage(editors(dom).rich);
        captionButton(ui, 'Add caption').click();
        assert.equal(saved(dom), image);
    } finally { dom.window.close(); }
});

test('formatting and deleting caption text cannot discard its image', async () => {
    const dom = await loadEditor({ report: figure });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        selectImage(editor);
        captionButton(ui, 'Edit caption').click();
        editor.commands.toggleHeading({ level: 1 });
        editor.commands.toggleBulletList();
        assert.ok(ui.querySelector('.bpb-re-surface figure img'));
        const positions = [];
        editor.state.doc.descendants((node, pos) => { if (node.type.name === 'reportCaption') positions.push([pos, node.nodeSize]); });
        const [pos, size] = positions[0];
        editor.commands.setTextSelection({ from: pos + 1, to: pos + size - 1 });
        editor.commands.deleteSelection();
        assert.ok(ui.querySelector('.bpb-re-surface img'));
        assert.equal(!!ui.querySelector('figure'), false);
        assert.doesNotMatch(saved(dom), /figcaption|Write a caption/);
    } finally { dom.window.close(); }
});

test('deleting a selected figure image removes the pair and undo restores both', async () => {
    const dom = await loadEditor({ report: figure });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        selectImage(editor);
        editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
        assert.equal(ui.querySelector('.bpb-re-surface figure'), null);
        editor.commands.undo();
        assert.equal(ui.querySelector('.bpb-re-surface figcaption').textContent, 'North ridge');
    } finally { dom.window.close(); }
});

test('resizing a captioned image updates only its dimensions and undo keeps the caption', async () => {
    const dom = await loadEditor({ report: figure });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        selectImage(editor);
        ui.querySelector('[aria-label="Resize image"]').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true, cancelable: true,
        }));
        assert.equal(ui.querySelector('.bpb-re-image-resize img').style.width, '330px');
        assert.equal(ui.querySelector('.bpb-re-surface figcaption').textContent, 'North ridge');
        editor.commands.undo();
        assert.equal(ui.querySelector('.bpb-re-image-resize img').style.width, '320px');
        assert.equal(ui.querySelector('.bpb-re-surface figcaption').textContent, 'North ridge');
    } finally { dom.window.close(); }
});

test('copying the selected photo carries its caption through the clipboard HTML parser', async () => {
    const dom = await loadEditor({ report: figure });
    try {
        const ui = await editorReady(dom);
        const editor = editors(dom).rich;
        ui.querySelector('.bpb-re-image-resize img').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.equal(editor.state.selection.node.type.name, 'reportFigure');
        const clipboard = editor.view.serializeForClipboard(editor.state.selection.content());
        assert.equal(clipboard.dom.querySelector('figcaption').textContent, 'North ridge');
        editor.commands.setContent(clipboard.dom.innerHTML, { emitUpdate: true });
        assert.equal(saved(dom), figure);
    } finally { dom.window.close(); }
});
