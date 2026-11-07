// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR_URL, loadEditor, editorReady, editors, modeButton, typeMarkdown } from '../helpers/report-editor-helpers.mjs';
import { reportPhoto as Pending } from '../../src/photos/report-photo.js';

const image = '[img src="https://example.com/ridge.jpg" alt="Rocky ridge" width="320" height="200"]';
const figure = (caption: string) => `[figure]${image}[figcaption]${caption}[/figcaption][/figure]`;
const PLAIN = figure('North ridge');

interface EditorLike {
    state: { doc: { descendants(visit: (node: { type: { name: string } }, pos: number) => void): void }; selection: { node?: unknown } };
    commands: { setTextSelection(range: { from: number; to: number } | number): boolean; setNodeSelection(pos: number): boolean; undo(): boolean };
}
const captionStart = (editor: EditorLike) => {
    let start = -1;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'reportCaption') start = pos + 1; });
    return start;
};
const selectCaption = (editor: EditorLike, from = 0, to = 'North'.length) => {
    const start = captionStart(editor);
    editor.commands.setTextSelection({ from: start + from, to: start + to });
};
const control = (ui: Element, label: string) => ui.querySelector<HTMLButtonElement>(`.bpb-re-tools [aria-label^="${label}"]`)!;
const saved = (dom: { window: Window }) => {
    modeButton(dom.window.document, 'Plain').click();
    return (dom.window.document.getElementById('JournalText') as HTMLTextAreaElement).value;
};

test('toolbar formatting applies to selected caption text and saves as nested markup', async () => {
    const dom = await loadEditor({ report: PLAIN });
    try {
        const ui: Element = await editorReady(dom);
        const editor = editors(dom).rich;
        selectCaption(editor);
        control(ui, 'Bold').click();
        assert.equal(ui.querySelector('figcaption strong')?.textContent, 'North');
        assert.equal(control(ui, 'Bold').getAttribute('aria-pressed'), 'true');
        assert.equal(saved(dom), figure('[b]North[/b] ridge'));
    } finally { dom.window.close(); }
});

test('only inline tools are available in a caption, and none while the photo itself is selected', async () => {
    const dom = await loadEditor({ report: PLAIN });
    try {
        const ui: Element = await editorReady(dom);
        const editor = editors(dom).rich;
        selectCaption(editor);
        for (const label of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'More formats', 'Link']) {
            assert.equal(control(ui, label).disabled, false, label);
        }
        for (const label of ['Insert image', 'Insert video', 'Insert table', 'Bulleted list', 'Numbered list', 'Horizontal rule']) {
            assert.equal(control(ui, label).disabled, true, label);
        }
        assert.equal(ui.querySelector<HTMLSelectElement>('.bpb-re-format')!.disabled, true);
        let figurePos = -1;
        editor.state.doc.descendants((node: { type: { name: string } }, pos: number) => { if (node.type.name === 'reportFigure') figurePos = pos; });
        editor.commands.setNodeSelection(figurePos);
        assert.equal(control(ui, 'Bold').disabled, true);
        assert.equal(control(ui, 'Link').disabled, true);
    } finally { dom.window.close(); }
});

test('the More formats palette and color swatches format a caption', async () => {
    const dom = await loadEditor({ report: PLAIN });
    try {
        const ui: Element = await editorReady(dom);
        selectCaption(editors(dom).rich);
        control(ui, 'More formats').click();
        ui.querySelector<HTMLButtonElement>('.bpb-re-morebox [aria-label^="Highlight"]')!.click();
        ui.querySelector<HTMLButtonElement>('.bpb-re-morebox [data-color]')!.click();
        const color = ui.querySelector<HTMLElement>('figcaption [data-bpb-report-color]')!.dataset.bpbReportColor;
        const output = saved(dom);
        assert.match(output, /\[figcaption\].*\[mark\]North\[\/mark\].* ridge\[\/figcaption\]/);
        assert.ok(output.includes(`color:${color}`));
    } finally { dom.window.close(); }
});

test('a link can be added to caption text from the toolbar', async () => {
    const dom = await loadEditor({ report: PLAIN });
    try {
        const ui: Element = await editorReady(dom);
        selectCaption(editors(dom).rich);
        control(ui, 'Link').click();
        const box = ui.querySelector('.bpb-re-linkbox')!;
        assert.equal((box as HTMLElement).hidden, false);
        const input = box.querySelector('input')!;
        input.value = 'https://example.com/route';
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        assert.equal(saved(dom), figure('[a href="https://example.com/route" target="_blank"]North[/a] ridge'));
    } finally { dom.window.close(); }
});

test('formatted captions survive Markdown, Plain and Rich mode switches and render in preview', async () => {
    const caption = '[b]North[/b] [i]ridge[/i] [span style="color:#b03a2e"]today[/span]';
    const dom = await loadEditor({ report: figure(caption) });
    try {
        const ui: Element = await editorReady(dom);
        const { document } = dom.window;
        assert.equal(ui.querySelector('figcaption strong')?.textContent, 'North');
        assert.equal(ui.querySelector('figcaption em')?.textContent, 'ridge');
        modeButton(document, 'Markdown').click();
        assert.match(editors(dom).markdown.getValue(), /<figcaption><b>North<\/b> <i>ridge<\/i> <span style="color:#b03a2e">today<\/span><\/figcaption>/);
        assert.equal(ui.querySelector('.bpb-re-preview figcaption b')?.textContent, 'North');
        typeMarkdown(dom, `${editors(dom).markdown.getValue()}\n\nAfter`);
        modeButton(document, 'Rich text').click();
        assert.equal(ui.querySelector('figcaption strong')?.textContent, 'North');
        assert.equal(saved(dom), `${figure(caption)}\n\nAfter`);
    } finally { dom.window.close(); }
});

test('a caption typed inside active formatting keeps it, and leaving starts unformatted prose', async () => {
    const dom = await loadEditor({ report: image });
    try {
        const ui: Element = await editorReady(dom);
        const editor = editors(dom).rich;
        ui.querySelector<HTMLButtonElement>('.bpb-re-caption-placeholder')!.click();
        control(ui, 'Bold').click();
        const { from } = editor.state.selection;
        editor.view.dispatch(editor.state.tr.insertText('Bold', from, from));
        assert.equal(ui.querySelector('figcaption strong')?.textContent, 'Bold');
        editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        assert.equal(editor.state.selection.$from.parent.type.name, 'paragraph');
        assert.equal(control(ui, 'Bold').getAttribute('aria-pressed'), 'false');
        assert.equal(saved(dom), figure('[b]Bold[/b]'));
    } finally { dom.window.close(); }
});

test('removing a formatted caption and undoing restores its formatting', async () => {
    const dom = await loadEditor({ report: figure('[b]North[/b] ridge') });
    try {
        const ui: Element = await editorReady(dom);
        const editor = editors(dom).rich;
        selectCaption(editor);
        [...ui.querySelectorAll<HTMLButtonElement>('.bpb-re-captionbar button')].find(button => button.textContent === 'Remove caption')!.click();
        assert.equal(ui.querySelector('figcaption'), null);
        editor.commands.undo();
        assert.equal(ui.querySelector('figcaption strong')?.textContent, 'North');
    } finally { dom.window.close(); }
});

test('a local photo return keeps formatting when its caption text is unchanged and replaces it when edited', async () => {
    const listeners: ((message: object, sender: object, respond: (value: unknown) => void) => void)[] = [];
    const photo = (letter: string) => `${letter.repeat(8)}-0000-4000-8000-000000000000`;
    const source = Pending.url(photo('a'));
    const dom = await loadEditor({
        report: `[figure][img src="${source}" alt="Ridge"][figcaption][b]North[/b] ridge[/figcaption][/figure]`,
        prepare: ((d: { chrome: { runtime: { onMessage: { addListener(listener: typeof listeners[number]): void }; sendMessage(message: { type: string }): Promise<unknown> } } }) => {
            d.chrome.runtime.onMessage.addListener = listener => listeners.push(listener);
            d.chrome.runtime.sendMessage = async message => (message.type === 'PHOTO_REPORT_READ' ? { ok: true, dataUrl: 'data:image/png;base64,AA==' } : null);
        }) as never,
    });
    try {
        const ui: Element = await editorReady(dom);
        const deliver = (from: string, to: string, caption: string) => {
            for (const listener of listeners) listener({ type: 'PHOTO_LOCAL_RESULT', returnToken: `return-${to}`, expectedIdentity: { cid: 900001, aid: null, pid: null }, expectedUrl: EDITOR_URL, replacesLocalPhotoId: photo(from), url: Pending.url(photo(to)), alt: 'Ridge', caption }, { id: 'test-extension' }, () => {});
        };
        const shownSource = () => editors(dom).rich.state.doc.firstChild.firstChild.firstChild.attrs.src;
        deliver('a', 'b', 'North ridge');
        assert.equal(shownSource(), Pending.url(photo('b')));
        assert.equal(ui.querySelector('figcaption strong')?.textContent, 'North');
        deliver('b', 'c', 'South col');
        assert.equal(ui.querySelector('figcaption')?.textContent, 'South col');
        assert.equal(ui.querySelector('figcaption strong'), null);
    } finally { dom.window.close(); }
});
