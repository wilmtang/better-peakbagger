// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../helpers/load-page.mjs';
import { loadEditor, editorReady, editors, typeRich, typeMarkdown, modeButton, videoMarkup } from '../helpers/report-editor-helpers.mjs';

test('markdown mode converts to bracket markup and the live preview shows the final rendering', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    assert.equal(doc.querySelector('.bpb-re-mdsplit').hidden, false,
        'the split pane should be visible in markdown mode');

    typeMarkdown(dom, '# Day 1\n\nWe went **up**.\n\n- tent\n- stove');
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[h1]Day 1[/h1]'));
    assert.equal(doc.getElementById('JournalText').value,
        '[h1]Day 1[/h1]\n\nWe went [b]up[/b].\n\n[ul][li]tent[/li][li]stove[/li][/ul]');

    const imageSizeHint = doc.querySelector('.bpb-re-markdown-hint');
    assert.equal(imageSizeHint.parentElement, doc.querySelector('.bpb-re-bar'),
        'Markdown help should use the toolbar hint area rather than a clipped footer');
    assert.equal(imageSizeHint.hidden, false);
    assert.match(imageSizeHint.textContent, /!\[Photo\|500\]\(url\) or !\[Photo\|500x600\]\(url\)/);
    assert.match(imageSizeHint.textContent, /YouTube: !\[YouTube\|560x315\]\(url\)/);

    // No tab to click: the preview pane re-renders beside the source.
    const preview = doc.querySelector('.bpb-re-preview');
    assert.match(preview.innerHTML, /<h1>Day 1<\/h1>/);
    assert.match(preview.innerHTML, /<li>tent<\/li>/);

    // The chosen mode is remembered for next time.
    assert.equal(dom.chrome._store.bpbSettings.reportEditorMode, 'markdown');
});

test('the live Markdown preview keeps adversarial raw HTML inert at the render boundary', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    typeMarkdown(dom, '<img src=x onerror="window.__bpbInjected=true"><script>window.__bpbInjected=true</script>');

    const preview = doc.querySelector('.bpb-re-preview');
    await waitFor(dom, () => /&lt;img|<img/.test(preview.innerHTML));
    assert.equal(preview.querySelector('script'), null);
    assert.equal(preview.querySelector('img'), null);
    assert.equal(dom.window.__bpbInjected, undefined);
    assert.match(preview.textContent, /<img src=x onerror=/);
    assert.match(preview.textContent, /<script>/);
});

test('the editor reports a mode-preference persistence failure', async () => {
    const dom = await loadEditor({
        prepare: d => {
            d.chrome.storage.sync.set = async () => { throw new Error('sync write failed'); };
        },
    });
    const ui = await editorReady(dom);

    modeButton(dom.window.document, 'Markdown').click();
    await waitFor(dom, () => /preference couldn’t be saved/i.test(
        ui.querySelector('.bpb-re-status').textContent));

    assert.equal(ui.dataset.mode, 'markdown', 'the current editing session remains usable');
    assert.notEqual(dom.chrome._store.bpbSettings.reportEditorMode, 'markdown');
});

test('Markdown direct video links save as video markup and render native controls', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    typeMarkdown(dom, 'Summit video:\n\n![](https://media.example.com/summit.mp4)');
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[video src='));
    assert.equal(doc.getElementById('JournalText').value,
        `Summit video:\n\n${videoMarkup('https://media.example.com/summit.mp4')}`);
    const video = doc.querySelector('.bpb-re-preview video');
    assert.equal(video?.getAttribute('src'), 'https://media.example.com/summit.mp4');
    assert.equal(video?.hasAttribute('controls'), true);
    assert.equal(video?.hasAttribute('autoplay'), false);
});

test('switching rich → markdown → rich keeps the content through the canonical form', async () => {
    const dom = await loadEditor({ report: 'A [b]bold[/b] start.' });
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'A **bold** start.');

    modeButton(doc, 'Rich text').click();
    assert.equal(editors(dom).rich.getHTML(), '<p>A <strong>bold</strong> start.</p>');
    assert.equal(doc.getElementById('JournalText').value, 'A [b]bold[/b] start.');
});

test('typing at a link boundary starts plain text while URL autolinking remains available', async t => {
    const report = 'See [a href="https://example.com/route" target="_blank"]route[/a]';
    const linkedTextRange = rich => {
        let range = null;
        rich.state.doc.descendants((node, pos) => {
            if (!range && node.isText && node.marks.some(mark => mark.type.name === 'link')) {
                range = { from: pos, to: pos + node.nodeSize };
            }
            return !range;
        });
        assert.ok(range, 'the fixture should contain linked text');
        return range;
    };

    for (const suffix of [' next', ', next', 'X']) {
        await t.test(`plain suffix ${JSON.stringify(suffix)}`, async () => {
            const dom = await loadEditor({ report });
            await editorReady(dom);
            const doc = dom.window.document;
            const rich = editors(dom).rich;
            const { to: linkEnd } = linkedTextRange(rich);

            rich.chain().focus().setTextSelection(linkEnd).insertContent(suffix).run();

            await waitFor(dom, () => doc.getElementById('JournalText').value.endsWith(suffix));
            assert.equal(doc.getElementById('JournalText').value, `${report}${suffix}`);
        });
    }

    await t.test('typing inside the link keeps the link', async () => {
        const dom = await loadEditor({ report });
        await editorReady(dom);
        const doc = dom.window.document;
        const rich = editors(dom).rich;
        const { from: linkStart } = linkedTextRange(rich);

        rich.chain().focus().setTextSelection(linkStart + 2).insertContent('X').run();

        await waitFor(dom, () => doc.getElementById('JournalText').value.includes('roXute'));
        assert.equal(doc.getElementById('JournalText').value,
            'See [a href="https://example.com/route" target="_blank"]roXute[/a]');
    });

    await t.test('a typed URL is still linked without its terminating space', async () => {
        const dom = await loadEditor();
        await editorReady(dom);
        const rich = editors(dom).rich;

        rich.chain().focus().insertContent('https://example.com ').run();

        const linkRuns = Array.from(rich.getJSON().content[0].content, node => [
            node.text,
            Boolean(node.marks?.some(mark => mark.type === 'link'))
        ].join(':'));
        assert.deepEqual(linkRuns, [
            'https://example.com:true',
            ' :false'
        ]);
    });
});

test('undo cannot cross a mode switch and resurrect the pre-switch document', async () => {
    const dom = await loadEditor({ report: 'first version' });
    await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<p>second version</p>');
    await waitFor(dom, () => doc.getElementById('JournalText').value === 'second version');

    modeButton(doc, 'Markdown').click();
    modeButton(doc, 'Rich text').click();
    const rich = editors(dom).rich;
    assert.equal(rich.can().undo(), false, 're-entering rich mode must start a fresh history');
    rich.chain().focus().undo().run();
    doc.getElementById('GPXPreview').click();   // flush anything a rogue undo produced
    assert.equal(doc.getElementById('JournalText').value, 'second version');
});

test('expanded rich DOM syncs headings, quotes, tables, code, rules, and images', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<h2>Route</h2><blockquote><p>Windy <s>retreat</s></p></blockquote>'
        + '<table><thead><tr><th>Peak</th></tr></thead><tbody><tr><td>Baker</td></tr></tbody></table>'
        + '<pre><code>two   spaces\nnew line</code></pre><hr>'
        + '<p><img src="https://example.com/map.jpg" alt="Topo" width="120"></p>');
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[table'));
    assert.equal(doc.getElementById('JournalText').value, [
        '[h2]Route[/h2]',
        '',
        '[blockquote]Windy [s]retreat[/s][/blockquote]',
        '',
        '[table border="1"][tr][th]Peak[/th][/tr][tr][td]Baker[/td][/tr][/table]',
        '',
        '[pre]two   spaces\nnew line[/pre]',
        '',
        '[hr]',
        '',
        '[img src="https://example.com/map.jpg" alt="Topo" width="120"]'
    ].join('\n'));
});

test('pasted rich media dimensions are bounded before node views apply them', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<p><img src="https://example.com/map.jpg" alt="Topo" width="999999" height="888888">'
        + '<video src="https://media.example.com/summit.mp4" width="999999" height="888888"></video></p>');

    const image = ui.querySelector('.bpb-re-image-resize img');
    const video = ui.querySelector('.bpb-re-video-resize video');
    assert.deepEqual([image?.style.width, image?.style.height], ['', '']);
    assert.deepEqual([video?.style.width, video?.style.height], ['', ''],
        'untrusted dimensions must not become enormous inline styles before save');

    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[video src='));
    assert.equal(doc.getElementById('JournalText').value,
        `[img src="https://example.com/map.jpg" alt="Topo"]${videoMarkup(
            'https://media.example.com/summit.mp4')}`);
});

test('the toolbar reflects the caret: active marks, block style, and table controls', async () => {
    const dom = await loadEditor({ report: '[h2]Route[/h2]\n\n[b]bold text[/b]' });
    const ui = await editorReady(dom);
    const rich = editors(dom).rich;

    const posOf = needle => {
        let hit = null;
        rich.state.doc.descendants((node, pos) => {
            if (hit === null && node.isText && node.text.includes(needle)) hit = pos + 1;
            return hit === null;
        });
        return hit;
    };

    rich.chain().focus().setTextSelection(posOf('Route')).run();
    assert.equal(ui.querySelector('.bpb-re-format').value, 'h2');
    assert.equal(ui.querySelector('[aria-label="Bold (Ctrl/Cmd+B)"]').getAttribute('aria-pressed'), 'false');

    rich.chain().focus().setTextSelection(posOf('bold text')).run();
    assert.equal(ui.querySelector('.bpb-re-format').value, 'p');
    assert.equal(ui.querySelector('[aria-label="Bold (Ctrl/Cmd+B)"]').getAttribute('aria-pressed'), 'true');

    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, true);
    ui.querySelector('[aria-label="Insert table"]').click();
    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, false,
        'table controls should appear while the caret is inside a table');

    ui.querySelector('[aria-label="Insert image"]').click();
    assert.equal(ui.querySelector('.bpb-re-imagebox').hidden, false);
    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, true,
        'the automatic table row must not open behind another contextual panel');
    ui.querySelector('[aria-label="Insert image"]').click();
    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, false,
        'dismissing a contextual panel should restore the applicable table row');

    ui.querySelector('[aria-label="More formats"]').click();
    ui.querySelector('[aria-label="More formats"]').click();
    assert.equal(ui.querySelector('.bpb-re-tablebar').hidden, false,
        'toggling More closed should restore the applicable table row');
    await waitFor(dom, () => dom.window.document.getElementById('JournalText').value.includes('[table border="1"]'));
});

test('more formats and named text colors serialize through the allowlist', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<p>peak</p>');
    editors(dom).rich.chain().focus().selectAll().run();

    ui.querySelector('[aria-label="More formats"]').click();
    assert.equal(ui.querySelector('.bpb-re-morebox').hidden, false);
    ui.querySelector('[aria-label="Highlight (Ctrl/Cmd+Shift+H)"]').click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[mark]'));

    editors(dom).rich.chain().focus().selectAll().run();
    ui.querySelector('[aria-label="More formats"]').click();
    ui.querySelector('[aria-label="Text color: Blue"]').click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('color:steelblue'));
    assert.equal(doc.getElementById('JournalText').value,
        '[span style="color:steelblue"][mark]peak[/mark][/span]');
});

test('an unrelated rich edit preserves an existing hex text color', async () => {
    const source = 'Under [span style="color:#2471a3"]blue[/span] skies.';
    const dom = await loadEditor({ report: source });
    await editorReady(dom);
    const rich = editors(dom).rich;
    const colored = rich.view.dom.querySelector('span[style]');
    assert.equal(colored?.getAttribute('data-bpb-report-color'), '#2471a3');

    rich.chain().focus('end').insertContent(' Clear weather.').run();
    await waitFor(dom, () => dom.window.document.getElementById('JournalText').value.endsWith('Clear weather.'));
    assert.equal(dom.window.document.getElementById('JournalText').value,
        `${source} Clear weather.`);
});

test('an unrelated Markdown edit preserves hex color in source, form, and preview', async () => {
    const bracket = 'Under [span style="color:#2471a3"]blue[/span] skies.';
    const markdown = 'Under <span style="color:#2471a3">blue</span> skies.';
    const dom = await loadEditor({ report: bracket });
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), markdown);
    typeMarkdown(dom, `${markdown} Clear weather.`);
    await waitFor(dom, () => doc.getElementById('JournalText').value.endsWith('Clear weather.'));
    assert.equal(doc.getElementById('JournalText').value, `${bracket} Clear weather.`);
    assert.equal(ui.querySelector('.bpb-re-preview span')?.getAttribute('style'), 'color:#2471a3');
});
