// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../helpers/load-page.mjs';
import { loadEditor, editorReady, editors, modeButton, videoMarkup, youtubeMarkup, EDITOR_URL } from '../helpers/report-editor-helpers.mjs';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';

test('the image popover validates the source and inserts alt text', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    ui.querySelector('[aria-label="Insert image"]').click();
    assert.equal(ui.querySelector('.bpb-re-imagebox').hidden, false);
    const src = ui.querySelector('[aria-label="Image URL (HTTPS)"]');
    const alt = ui.querySelector('[aria-label="Image description"]');
    const hostingHint = ui.querySelectorAll('.bpb-re-image-hosting')[1];
    // One way in. Two buttons read as two features when they are one page with
    // two tabs, and neither name said the library is this browser's own record.
    assert.deepEqual(
        [...ui.querySelectorAll('.bpb-re-photo-launch')].map(button => button.textContent),
        ['Upload a photo…']
    );
    assert.match(ui.querySelector('.bpb-re-image-divider').textContent,
        /paste a link to an image/i);
    // The two ways a pasted link fails are named, because the most common
    // attempt fails both and does so silently in the saved report.
    assert.match(hostingHint.textContent, /point at the image file itself/);
    assert.match(hostingHint.textContent, /Google Photos, Drive, iCloud, and Dropbox links do not/);
    assert.match(hostingHint.textContent,
        /To resize, select the image and drag its lower-right handle\./);
    assert.deepEqual([...hostingHint.querySelectorAll('a')].map(link => ({
        label: link.textContent,
        href: link.href,
        target: link.target,
        rel: link.rel
    })), [
        {
            label: 'Peakbagger Photos',
            href: 'https://www.peakbagger.com/climber/photo.aspx',
            target: '_blank',
            rel: 'noopener noreferrer'
        },
        {
            label: 'Imgur',
            href: 'https://imgur.com/upload',
            target: '_blank',
            rel: 'noopener noreferrer'
        }
    ]);
    const guideLink = ui.querySelectorAll('.bpb-re-image-hosting')[0].querySelector('a');
    assert.equal(guideLink.textContent, 'How it works');
    assert.match(guideLink.getAttribute('href'), /photos\/guide\.html$/);

    src.value = 'javascript:alert(1)';
    ui.querySelector('.bpb-re-imagebox .bpb-re-linkapply').click();
    assert.ok(src.classList.contains('bpb-re-invalid'), 'an unsafe URL must be rejected');
    assert.equal(doc.getElementById('JournalText').value, '');

    src.value = 'https://example.com/topo.jpg';
    alt.value = 'Topo';
    ui.querySelector('.bpb-re-imagebox .bpb-re-linkapply').click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[img'));
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://example.com/topo.jpg" alt="Topo"]');
});

// The popover layer floats over the ascent form, so an open popover sits on
// top of Peakbagger's own controls — the date calendar most visibly. Every way
// out must work without hunting for the toolbar button that opened it.
test('an open popover is dismissible by control, Escape, and a press on the form it covers', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const imageTool = ui.querySelector('[aria-label="Insert image"]');
    const imageBox = ui.querySelector('.bpb-re-imagebox');
    const tableBar = ui.querySelector('.bpb-re-tablebar');
    const press = node => node.dispatchEvent(
        new dom.window.Event('pointerdown', { bubbles: true }));
    const escape = node => node.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    for (const box of ['.bpb-re-linkbox', '.bpb-re-imagebox', '.bpb-re-videobox', '.bpb-re-morebox']) {
        assert.equal(ui.querySelector(`${box} .bpb-re-boxclose`)?.getAttribute('aria-label'),
            'Close (Esc)', `${box} needs a visible dismiss control`);
    }
    assert.equal(tableBar.querySelector('.bpb-re-boxclose'), null,
        'the caret-driven table bar is not manually opened, so it has nothing to dismiss');

    imageTool.click();
    assert.equal(imageBox.hidden, false);
    imageBox.querySelector('.bpb-re-boxclose').click();
    assert.equal(imageBox.hidden, true, 'the dismiss control closes the popover');

    // Escape from a popover button, not only from its text fields.
    imageTool.click();
    escape(ui.querySelector('.bpb-re-image-actions .bpb-re-photo-launch'));
    assert.equal(imageBox.hidden, true, 'Escape closes the popover from anywhere in the editor');

    // A press on the covered ascent-date field dismisses instead of being
    // swallowed, so the field is one further click away.
    imageTool.click();
    assert.equal(imageBox.hidden, false);
    press(doc.getElementById('DateText'));
    assert.equal(imageBox.hidden, true, 'a press outside the editor closes the popover');

    // A press inside the popover keeps it open.
    imageTool.click();
    press(ui.querySelector('[aria-label="Image URL (HTTPS)"]'));
    assert.equal(imageBox.hidden, false, 'a press inside the popover must not close it');
});

test('the image popover launches editor and library modes with the report identity', async () => {
    const messages = [];
    let release;
    const dom = await loadEditor({
        url: `${EDITOR_URL}&aid=1234&pid=2296`,
        prepare: d => {
            d.chrome.runtime.sendMessage = message => {
                if (message?.type !== 'PHOTO_EDITOR_OPEN') return Promise.resolve(undefined);
                messages.push(message);
                return new Promise(resolve => { release = resolve; });
            };
        }
    });
    const ui = await editorReady(dom);
    ui.querySelector('[aria-label="Insert image"]').click();
    const launcher = ui.querySelector('.bpb-re-photo-launch');

    launcher.click();
    await waitFor(dom, () => launcher.disabled);
    assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), {
        type: 'PHOTO_EDITOR_OPEN',
        mode: 'edit',
        identity: { cid: '900001', aid: '1234', pid: '2296' }
    });
    release({ ok: true, tabId: 44 });
    await waitFor(dom, () => !launcher.disabled);

    launcher.click();
    await waitFor(dom, () => messages.length === 2);
    assert.equal(messages[1].mode, 'edit');
    release(null);
    await waitFor(dom, () => !launcher.disabled);
    assert.match(ui.querySelector('.bpb-re-image-status').textContent,
        /Couldn’t open the photo editor/);
});

test('a validated photo result is inserted only while the rich editor is available', async () => {
    const listeners = [];
    const dom = await loadEditor({
        prepare: d => {
            d.chrome.runtime.onMessage = {
                addListener: listener => listeners.push(listener),
                removeListener: listener => {
                    const index = listeners.indexOf(listener);
                    if (index >= 0) listeners.splice(index, 1);
                }
            };
        }
    });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    let response;
    const message = {
        type: 'PHOTO_INSERT_RESULT',
        localPhotoId: 'photo:123',
        url: 'https://i.ibb.co/example/topo.jpg',
        alt: 'North ridge route'
    };
    for (const listener of listeners) {
        listener(message, { id: 'test-extension' }, value => { response = value; });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true });
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://i.ibb.co/example/topo.jpg" alt="North ridge route"]');
    assert.equal(ui.querySelector('.bpb-re-status').textContent, 'Photo inserted');

    modeButton(doc, 'Markdown').click();
    response = null;
    for (const listener of listeners) {
        listener({ ...message, localPhotoId: 'photo:456' },
            { id: 'test-extension' }, value => { response = value; });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(response)),
        { ok: false, error: { code: 'editor-unavailable' } });
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://i.ibb.co/example/topo.jpg" alt="North ridge route"]');
});

// The photo page accepts a description up to photoLibrary.ALT_LIMIT and the
// worker clamps the returned result to the same bound, so a shorter bound here
// silently drops characters the user already saw stored beside their photo.
test('an inserted photo keeps the full description the library allows', async () => {
    const listeners = [];
    const dom = await loadEditor({
        prepare: d => {
            d.chrome.runtime.onMessage = {
                addListener: listener => listeners.push(listener),
                removeListener: () => {}
            };
        }
    });
    await editorReady(dom);
    const doc = dom.window.document;
    const insert = alt => {
        let response;
        for (const listener of listeners) {
            listener({
                type: 'PHOTO_INSERT_RESULT',
                localPhotoId: 'photo:123',
                url: 'https://i.ibb.co/example/topo.jpg',
                alt
            }, { id: 'test-extension' }, value => { response = value; });
        }
        return response;
    };

    const longest = 'r'.repeat(Library.ALT_LIMIT);
    assert.deepEqual(JSON.parse(JSON.stringify(insert(longest))), { ok: true });
    assert.equal(doc.getElementById('JournalText').value,
        `[img src="https://i.ibb.co/example/topo.jpg" alt="${longest}"]`);

    insert('o'.repeat(Library.ALT_LIMIT + 40));
    const clamped = doc.getElementById('JournalText').value.match(/alt="(o+)"/)?.[1];
    assert.equal(clamped?.length, Library.ALT_LIMIT,
        'anything longer is clamped to the same bound, not a smaller one');
});

test('link and media popovers toggle closed, share the toolbar layer, and insert safe video', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const layer = ui.querySelector('.bpb-re-contextual');
    const linkTool = ui.querySelector('[aria-label="Link (Ctrl/Cmd+K)"]');
    const imageTool = ui.querySelector('[aria-label="Insert image"]');
    const videoTool = ui.querySelector('[aria-label="Insert video"]');
    const imageBox = ui.querySelector('.bpb-re-imagebox');
    const videoBox = ui.querySelector('.bpb-re-videobox');

    linkTool.click();
    assert.equal(ui.querySelector('.bpb-re-linkbox').hidden, false);
    linkTool.click();
    assert.equal(ui.querySelector('.bpb-re-linkbox').hidden, true,
        'clicking Link again should dismiss its panel');

    imageTool.click();
    assert.equal(imageBox.hidden, false);
    assert.equal(imageBox.parentElement, layer);
    imageTool.click();
    assert.equal(imageBox.hidden, true, 'clicking Image again should dismiss its panel');

    videoTool.click();
    assert.equal(videoBox.hidden, false);
    assert.equal(videoBox.parentElement, layer);
    const videoSrc = ui.querySelector('[aria-label="Video file or YouTube URL"]');
    videoSrc.value = 'http://example.com/clip.mp4';
    ui.querySelector('.bpb-re-videobox .bpb-re-linkapply').click();
    assert.ok(videoSrc.classList.contains('bpb-re-invalid'), 'mixed-content video URLs must be rejected');

    videoSrc.value = 'https://media.example.com/clip.mp4';
    ui.querySelector('.bpb-re-videobox .bpb-re-linkapply').click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[video src='));
    assert.equal(doc.getElementById('JournalText').value,
        videoMarkup('https://media.example.com/clip.mp4'));
    assert.equal(ui.querySelector('.bpb-re-surface video')?.getAttribute('controls'), '');
});

test('the video tool inserts a canonical, resizable YouTube iframe', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const videoTool = ui.querySelector('[aria-label="Insert video"]');
    const videoSrc = ui.querySelector('[aria-label="Video file or YouTube URL"]');

    videoTool.click();
    assert.match(ui.querySelector('.bpb-re-video-hint').textContent,
        /direct HTTPS video file URL or a YouTube watch\/share URL/i);
    videoSrc.value = 'https://youtu.be/aqz-KE-bpKQ?si=share-token';
    ui.querySelector('.bpb-re-videobox .bpb-re-linkapply').click();

    const source = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="640" height="360"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === source);
    const iframe = ui.querySelector('.bpb-re-youtube-resize iframe');
    assert.equal(iframe?.getAttribute('src'), 'https://www.youtube.com/embed/aqz-KE-bpKQ');
    assert.equal(iframe?.getAttribute('title'), 'YouTube video');
    assert.equal(iframe?.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
    assert.equal(iframe?.getAttribute('allowfullscreen'), '');
    assert.equal(ui.querySelector('[aria-label="Resize YouTube video"]')?.tagName, 'BUTTON');
});

test('a Rich video resize stays proportional and persists its dimensions', async () => {
    const source = videoMarkup('https://media.example.com/summit.mp4', ' width="800" height="450"');
    const dom = await loadEditor({ report: source });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const video = ui.querySelector('.bpb-re-video-resize video');
    const handle = ui.querySelector('[aria-label="Resize video"]');

    assert.ok(video, 'Rich videos should use the resizable node view');
    assert.equal(handle?.tagName, 'BUTTON');
    assert.equal(handle?.type, 'button', 'the resize handle must never submit the ascent form');
    assert.equal(handle?.getAttribute('aria-keyshortcuts'), 'ArrowLeft ArrowRight');

    Object.defineProperties(video, {
        offsetWidth: { configurable: true, get: () => Number.parseFloat(video.style.width) || 800 },
        offsetHeight: { configurable: true, get: () => Number.parseFloat(video.style.height) || 450 }
    });

    handle.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true, clientX: 800, clientY: 450, button: 0
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mousemove', {
        bubbles: true, clientX: 600, clientY: 338, buttons: 1
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true, clientX: 600, clientY: 338, button: 0
    }));

    const resized = videoMarkup('https://media.example.com/summit.mp4', ' width="600" height="338"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(video.style.width, '600px');
    assert.equal(video.style.height, '338px');

    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowLeft', shiftKey: true
    }));
    const keyboardResized = videoMarkup('https://media.example.com/summit.mp4',
        ' width="550" height="310"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === keyboardResized);

    editors(dom).rich.chain().focus().undo().run();
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value, source,
        'the grouped video resize interaction should be undoable');
});

test('a Rich YouTube iframe resize stays proportional and persists its dimensions', async () => {
    const source = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="800" height="450"');
    const dom = await loadEditor({ report: source });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const iframe = ui.querySelector('.bpb-re-youtube-resize iframe');
    const handle = ui.querySelector('[aria-label="Resize YouTube video"]');

    assert.ok(iframe, 'Rich YouTube embeds should use the resizable node view');
    assert.equal(handle?.tagName, 'BUTTON');
    assert.equal(handle?.type, 'button', 'the resize handle must never submit the ascent form');
    assert.equal(handle?.getAttribute('aria-keyshortcuts'), 'ArrowLeft ArrowRight');

    Object.defineProperties(iframe, {
        offsetWidth: { configurable: true, get: () => Number.parseFloat(iframe.style.width) || 800 },
        offsetHeight: { configurable: true, get: () => Number.parseFloat(iframe.style.height) || 450 }
    });

    handle.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true, clientX: 800, clientY: 450, button: 0
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mousemove', {
        bubbles: true, clientX: 600, clientY: 338, buttons: 1
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true, clientX: 600, clientY: 338, button: 0
    }));

    const resized = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="600" height="338"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(iframe.style.width, '600px');
    assert.equal(iframe.style.height, '338px');

    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowLeft', shiftKey: true
    }));
    const keyboardResized = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="550" height="310"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === keyboardResized);
});

test('a Rich image resize stays proportional and persists its dimensions', async () => {
    const source = '[img src="https://example.com/topo.jpg" alt="Topo" width="800" height="600"]';
    const dom = await loadEditor({ report: source });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const image = ui.querySelector('.bpb-re-image-resize img');
    const handle = ui.querySelector('[aria-label="Resize image"]');

    assert.ok(image, 'Rich images should use the resizable node view');
    assert.equal(handle?.tagName, 'BUTTON');
    assert.equal(handle?.type, 'button', 'the resize handle must never submit the ascent form');
    assert.equal(handle?.getAttribute('aria-keyshortcuts'), 'ArrowLeft ArrowRight');

    Object.defineProperties(image, {
        offsetWidth: { configurable: true, get: () => Number.parseFloat(image.style.width) || 800 },
        offsetHeight: { configurable: true, get: () => Number.parseFloat(image.style.height) || 600 }
    });

    handle.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true, clientX: 800, clientY: 600, button: 0
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mousemove', {
        bubbles: true, clientX: 600, clientY: 450, buttons: 1
    }));
    doc.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true, clientX: 600, clientY: 450, button: 0
    }));

    const resized = '[img src="https://example.com/topo.jpg" alt="Topo" width="600" height="450"]';
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(image.style.width, '600px');
    assert.equal(image.style.height, '450px');

    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowLeft', shiftKey: true
    }));
    const keyboardResized = '[img src="https://example.com/topo.jpg" alt="Topo" width="550" height="413"]';
    await waitFor(dom, () => doc.getElementById('JournalText').value === keyboardResized);

    editors(dom).rich.chain().focus().undo().run();
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value, source,
        'the grouped resize interaction should be undoable');
    assert.equal(image.style.width, '800px', 'the node view should repaint dimensions after undo');
    assert.equal(image.style.height, '600px');
});

test('keyboard image resizing stops at the serialized dimension ceiling', async () => {
    const source = '[img src="https://example.com/panorama.jpg" alt="Panorama" width="1590" height="954"]';
    const dom = await loadEditor({ report: source });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const image = ui.querySelector('.bpb-re-image-resize img');
    const handle = ui.querySelector('[aria-label="Resize image"]');

    Object.defineProperties(image, {
        offsetWidth: { configurable: true, get: () => Number.parseFloat(image.style.width) || 1590 },
        offsetHeight: { configurable: true, get: () => Number.parseFloat(image.style.height) || 954 }
    });
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowRight', shiftKey: true
    }));

    await waitFor(dom, () => /width="1600" height="960"/.test(doc.getElementById('JournalText').value));
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true, key: 'ArrowRight', shiftKey: true
    }));
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://example.com/panorama.jpg" alt="Panorama" width="1600" height="960"]');
});

test('plain mode is the untouched native textarea, hints restored', async () => {
    const dom = await loadEditor({ report: 'raw [whatever] text' });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const plainHint = ui.querySelector('.bpb-re-plain-hint');

    assert.equal(plainHint.hidden, true);
    assert.equal(plainHint.parentElement, ui.querySelector('.bpb-re-bar'),
        'the Plain hint should reuse the shared toolbar row');

    modeButton(doc, 'Plain').click();
    const textarea = doc.getElementById('JournalText');
    assert.equal(textarea.classList.contains('bpb-re-hidden'), false);
    assert.equal(textarea.value, 'raw [whatever] text');
    assert.equal(plainHint.hidden, false);
    assert.equal(plainHint.textContent,
        'Peakbagger’s original text editor — use Peakbagger’s [bracket] syntax.');
    const hints = [...doc.querySelectorAll('span')].find(s => /Hints:/.test(s.textContent));
    assert.equal(hints.classList.contains('bpb-re-hidden'), false);

    modeButton(doc, 'Rich text').click();
    assert.equal(plainHint.hidden, true);
});

test('editing Plain invalidates the exact Markdown sidecar', async () => {
    const dom = await loadEditor({ report: 'Original [b]report[/b].' });
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'Original **report**.');

    modeButton(doc, 'Plain').click();
    const textarea = doc.getElementById('JournalText');
    textarea.value = 'Replacement [i]source[/i].';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'Replacement *source*.');
});

test('visiting Markdown mode does not rewrite an untouched server report', async () => {
    const report = '[iframe src="https://example.com"][/iframe]';
    const dom = await loadEditor({ report });
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    modeButton(doc, 'Plain').click();
    assert.equal(doc.getElementById('JournalText').value, report);
});

test('editing in rich mode neutralizes unsupported embed markup before submission', async () => {
    const dom = await loadEditor({ report: '[iframe src="https://example.com"][/iframe]' });
    await editorReady(dom);
    const doc = dom.window.document;

    editors(dom).rich.chain().focus('end').insertContent(' edited').run();
    await waitFor(dom, () => /edited/.test(doc.getElementById('JournalText').value));
    const submitted = doc.getElementById('JournalText').value;
    assert.doesNotMatch(submitted, /\[iframe\b/i);
    assert.match(submitted, /&#91;iframe/);
});
