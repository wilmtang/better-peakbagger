// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { fireTrustedEvent, waitFor } from '../helpers/load-page.mjs';
import { loadEditor, editorReady, editors, modeButton, videoMarkup, youtubeMarkup, EDITOR_URL, DRAFT_KEY } from '../helpers/report-editor-helpers.mjs';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';

const pointerEvent = (dom, type, {
    pointerId = 1,
    pointerType = 'mouse',
    ...init
} = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: pointerType },
    });
    return event;
};

const returnContext = (url = EDITOR_URL) => {
    const parsed = new URL(url);
    parsed.hash = '';
    const identity = {};
    for (const key of ['cid', 'aid', 'pid']) {
        const value = parsed.searchParams.get(key);
        identity[key] = value == null ? null : Number(value);
    }
    return { expectedIdentity: identity, expectedUrl: parsed.toString() };
};

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

test('popover URL errors are specific, announced, repeatable, and cleared on recovery', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const input = (field, value) => {
        field.value = value;
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    const assertError = (field, pattern) => {
        const id = field.getAttribute('aria-errormessage');
        const error = id && doc.getElementById(id);
        assert.equal(field.getAttribute('aria-invalid'), 'true');
        assert.equal(doc.activeElement, field);
        assert.equal(error?.getAttribute('role'), 'alert');
        assert.equal(error?.hidden, false);
        assert.match(error?.textContent || '', pattern);
        return error;
    };
    const assertClear = field => {
        assert.equal(field.hasAttribute('aria-invalid'), false);
        assert.equal(field.hasAttribute('aria-errormessage'), false);
        assert.equal(field.classList.contains('bpb-re-invalid'), false);
    };

    ui.querySelector('[aria-label="Link (Ctrl/Cmd+K)"]').click();
    const link = ui.querySelector('[aria-label="Link URL"]');
    const linkApply = ui.querySelector('.bpb-re-linkbox .bpb-re-linkapply');
    linkApply.click();
    const repeatedError = assertError(link, /^Enter a link\.$/);
    linkApply.click();
    assert.equal(assertError(link, /^Enter a link\.$/), repeatedError,
        'repeated invalid actions reuse and re-expose the associated alert');
    input(link, 'javascript:alert(1)');
    assertClear(link);
    link.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assertError(link, /link type isn’t allowed/);
    input(link, 'not a url');
    link.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assertError(link, /complete web address/);
    input(link, 'example.com/route');
    link.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('https://example.com/route'));
    assertClear(link);

    ui.querySelector('[aria-label="Insert image"]').click();
    const image = ui.querySelector('[aria-label="Image URL (HTTPS)"]');
    const imageApply = ui.querySelector('.bpb-re-imagebox .bpb-re-linkapply');
    imageApply.click();
    assertError(image, /^Enter an image URL\.$/);
    input(image, 'http://example.com/photo.jpg');
    imageApply.click();
    assertError(image, /Use an HTTPS image URL/);
    input(image, 'https://images.example.com/signed/resource?token=abc');
    imageApply.click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('signed/resource'));
    assertClear(image);

    ui.querySelector('[aria-label="Insert video"]').click();
    const video = ui.querySelector('[aria-label="Video file or YouTube URL"]');
    const videoApply = ui.querySelector('.bpb-re-videobox .bpb-re-linkapply');
    videoApply.click();
    assertError(video, /^Enter a video URL\.$/);
    input(video, 'http://media.example.com/clip.mp4');
    videoApply.click();
    assertError(video, /Use an HTTPS video file/);
    input(video, 'https://vimeo.com/123456');
    video.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assertError(video, /video page or embed isn’t supported/);
    input(video, 'https://youtu.be/not-video');
    videoApply.click();
    assertError(video, /video page or embed isn’t supported/);
    input(video, 'https://media.example.com/signed/stream?token=abc');
    videoApply.click();
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('signed/stream'));
    assertClear(video);

    ui.querySelector('[aria-label="Insert video"]').click();
    assertClear(video);
    assert.equal(doc.getElementById('bpb-re-video-error').hidden, true,
        'reopening a popover must not retain a stale failure');
    video.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(ui.querySelector('.bpb-re-videobox').hidden, true);
    assertClear(video);
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
                if (message?.type === 'TRUSTED_ACTION_ISSUE') {
                    messages.push(message);
                    return Promise.resolve({ ok: true, token: 'photo-token' });
                }
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
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.deepEqual(messages, [], 'a synthetic host-page click must not open an editor');
    fireTrustedEvent(launcher, 'click');
    await waitFor(dom, () => launcher.disabled);
    assert.equal(messages[0].type, 'TRUSTED_ACTION_ISSUE');
    assert.equal(messages[0].action, 'photo-editor');
    assert.deepEqual(JSON.parse(JSON.stringify(messages[1])), {
        type: 'PHOTO_EDITOR_OPEN',
        mode: 'edit',
        generation: messages[0].generation,
        activationToken: 'photo-token',
        identity: { cid: '900001', aid: '1234', pid: '2296' }
    });
    release({ ok: true, tabId: 44 });
    await waitFor(dom, () => !launcher.disabled);

    fireTrustedEvent(launcher, 'click');
    await waitFor(dom, () => messages.length === 4);
    assert.equal(messages[3].mode, 'edit');
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
        ...returnContext(),
        returnToken: 'return-123',
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

    response = null;
    for (const listener of listeners) {
        listener(message, { id: 'test-extension' }, value => { response = value; });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true });
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://i.ibb.co/example/topo.jpg" alt="North ridge route"]',
        'an ambiguous delivery retry must acknowledge without inserting twice');

    modeButton(doc, 'Markdown').click();
    response = null;
    for (const listener of listeners) {
        listener({ ...message, returnToken: 'return-456', localPhotoId: 'photo:456' },
            { id: 'test-extension' }, value => { response = value; });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(response)),
        { ok: false, error: { code: 'editor-unavailable' } });
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://i.ibb.co/example/topo.jpg" alt="North ridge route"]');
});

test('a photo result carries a bounded display width without fixing its height', async () => {
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
    const insert = displayWidth => {
        let response;
        for (const listener of listeners) {
            listener({
                type: 'PHOTO_INSERT_RESULT',
                ...returnContext(),
                localPhotoId: 'photo:123',
                url: 'https://i.ibb.co/example/topo.jpg',
                alt: 'North ridge route',
                displayWidth,
            }, { id: 'test-extension' }, value => { response = value; });
        }
        return response;
    };

    assert.deepEqual(JSON.parse(JSON.stringify(insert(640))), { ok: true });
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://i.ibb.co/example/topo.jpg" alt="North ridge route" width="640"]');

    insert(4032);
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://i.ibb.co/example/topo.jpg" alt="North ridge route" width="640"]'
        + '[img src="https://i.ibb.co/example/topo.jpg" alt="North ridge route"]',
        'invalid optional sizing must not reject the image or leak into saved markup');
});

test('a photo result cannot cross into a different report document', async () => {
    const listeners = [];
    const dom = await loadEditor({
        prepare: d => {
            d.chrome.runtime.onMessage = {
                addListener: listener => listeners.push(listener),
                removeListener: () => {},
            };
        },
    });
    await editorReady(dom);
    const base = {
        type: 'PHOTO_INSERT_RESULT',
        ...returnContext(),
        localPhotoId: 'photo:123',
        url: 'https://i.ibb.co/example/topo.jpg',
        alt: 'North ridge route',
    };
    const deliver = message => {
        let response;
        for (const listener of listeners) {
            listener(message, { id: 'test-extension' }, value => { response = value; });
        }
        return response;
    };

    assert.deepEqual(JSON.parse(JSON.stringify(deliver({
        ...base,
        expectedIdentity: { cid: 900001, aid: 456, pid: null },
    }))), { ok: false, error: { code: 'wrong-report' } });
    assert.deepEqual(JSON.parse(JSON.stringify(deliver({
        ...base,
        expectedUrl: 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900002',
    }))), { ok: false, error: { code: 'wrong-report' } });
    assert.equal(dom.window.document.getElementById('JournalText').value, '');
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
                ...returnContext(),
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

// The description is optional on the photo page, so a result can legitimately
// arrive with none. It must still insert — as a plain image, not a video, since
// the alt-plus-media-suffix form is what the writer reads as one.
test('an inserted photo without a description is still accepted', async () => {
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
    let response;
    for (const listener of listeners) {
        listener({
            type: 'PHOTO_INSERT_RESULT',
            ...returnContext(),
            localPhotoId: 'photo:123',
            url: 'https://i.ibb.co/example/topo.jpg',
            alt: '   '
        }, { id: 'test-extension' }, value => { response = value; });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true });
    assert.equal(doc.getElementById('JournalText').value,
        '[img src="https://i.ibb.co/example/topo.jpg"]');
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

    handle.dispatchEvent(pointerEvent(dom, 'pointerdown', {
        clientX: 800, clientY: 450, button: 0
    }));
    doc.dispatchEvent(pointerEvent(dom, 'pointermove', {
        clientX: 600, clientY: 338, buttons: 1
    }));
    doc.dispatchEvent(pointerEvent(dom, 'pointerup', {
        clientX: 600, clientY: 338, button: 0
    }));

    const resized = videoMarkup('https://media.example.com/summit.mp4', ' width="600" height="338"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(video.style.width, '600px');
    assert.equal(video.style.height, '338px');
    assert.equal(handle.closest('[data-resize-container]').dataset.resizeState, 'false');

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

    handle.dispatchEvent(pointerEvent(dom, 'pointerdown', {
        clientX: 800, clientY: 450, button: 0
    }));
    doc.dispatchEvent(pointerEvent(dom, 'pointermove', {
        clientX: 600, clientY: 338, buttons: 1
    }));
    doc.dispatchEvent(pointerEvent(dom, 'pointerup', {
        clientX: 600, clientY: 338, button: 0
    }));

    const resized = youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ',
        ' width="600" height="338"');
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(iframe.style.width, '600px');
    assert.equal(iframe.style.height, '338px');
    assert.equal(handle.closest('[data-resize-container]').dataset.resizeState, 'false');

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

    handle.dispatchEvent(pointerEvent(dom, 'pointerdown', {
        clientX: 800, clientY: 600, button: 0
    }));
    doc.dispatchEvent(pointerEvent(dom, 'pointermove', {
        clientX: 600, clientY: 450, buttons: 1
    }));
    doc.dispatchEvent(pointerEvent(dom, 'pointerup', {
        clientX: 600, clientY: 450, button: 0
    }));

    const resized = '[img src="https://example.com/topo.jpg" alt="Topo" width="600" height="450"]';
    await waitFor(dom, () => doc.getElementById('JournalText').value === resized);
    assert.equal(image.style.width, '600px');
    assert.equal(image.style.height, '450px');
    assert.equal(handle.closest('[data-resize-container]').dataset.resizeState, 'false');

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

for (const mediaCase of [
    {
        name: 'image',
        source: '[img src="https://example.com/topo.jpg" alt="Topo" width="800" height="600"]',
        selector: '.bpb-re-image-resize img',
        label: 'Resize image',
        startHeight: 600,
        endHeight: 450,
        resized: '[img src="https://example.com/topo.jpg" alt="Topo" width="600" height="450"]',
        completion: 'pointercancel',
    },
    {
        name: 'video',
        source: videoMarkup('https://media.example.com/summit.mp4', ' width="800" height="450"'),
        selector: '.bpb-re-video-resize video',
        label: 'Resize video',
        startHeight: 450,
        endHeight: 338,
        resized: videoMarkup('https://media.example.com/summit.mp4', ' width="600" height="338"'),
        completion: 'lostpointercapture',
    },
    {
        name: 'YouTube iframe',
        source: youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ', ' width="800" height="450"'),
        selector: '.bpb-re-youtube-resize iframe',
        label: 'Resize YouTube video',
        startHeight: 450,
        endHeight: 338,
        resized: youtubeMarkup('https://www.youtube.com/embed/aqz-KE-bpKQ', ' width="600" height="338"'),
        completion: 'pointercancel',
    },
]) {
    test(`a touch ${mediaCase.name} resize commits once on ${mediaCase.completion} and autosaves`, async () => {
        const dom = await loadEditor({
            report: mediaCase.source,
            accelerateAutosave: true,
        });
        const ui = await editorReady(dom);
        const doc = dom.window.document;
        const media = ui.querySelector(mediaCase.selector);
        const handle = ui.querySelector(`[aria-label="${mediaCase.label}"]`);
        const container = handle.closest('[data-resize-container]');
        Object.defineProperties(media, {
            offsetWidth: { configurable: true, get: () => Number.parseFloat(media.style.width) || 800 },
            offsetHeight: { configurable: true, get: () => Number.parseFloat(media.style.height) || mediaCase.startHeight },
        });

        let documentTransactions = 0;
        editors(dom).rich.on('transaction', ({ transaction }) => {
            if (transaction.docChanged) documentTransactions++;
        });
        const touch = { pointerId: 7, pointerType: 'touch' };
        handle.dispatchEvent(pointerEvent(dom, 'pointerdown', {
            ...touch, clientX: 800, clientY: mediaCase.startHeight, button: 0,
        }));
        assert.equal(container.dataset.resizeState, 'true');
        doc.dispatchEvent(pointerEvent(dom, 'pointermove', {
            ...touch, clientX: 600, clientY: mediaCase.endHeight, buttons: 1,
        }));
        const completionTarget = mediaCase.completion === 'lostpointercapture' ? handle : doc;
        completionTarget.dispatchEvent(pointerEvent(dom, mediaCase.completion, {
            ...touch, clientX: 600, clientY: mediaCase.endHeight,
        }));
        // Browsers may report capture loss after pointer completion. A second
        // terminal event must not create another document transaction.
        handle.dispatchEvent(pointerEvent(dom, 'lostpointercapture', touch));
        doc.dispatchEvent(pointerEvent(dom, 'pointerup', touch));

        await waitFor(dom, () => doc.getElementById('JournalText').value === mediaCase.resized);
        assert.equal(documentTransactions, 1, 'one gesture produces one history transaction');
        assert.equal(container.dataset.resizeState, 'false');
        assert.equal(container.classList.contains('bpb-re-image-resizing')
            || container.classList.contains('bpb-re-video-resizing')
            || container.classList.contains('bpb-re-youtube-resizing'), false);
        await waitFor(dom, () => dom.chrome._localStore[DRAFT_KEY]?.text === mediaCase.resized);

        editors(dom).rich.chain().focus().undo().run();
        doc.getElementById('GPXPreview').click();
        assert.equal(doc.getElementById('JournalText').value, mediaCase.source,
            'one Undo restores the pre-gesture document');
    });
}

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
    const dom = await loadEditor({ report: 'raw [b]supported[/b] text' });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const plainHint = ui.querySelector('.bpb-re-plain-hint');

    assert.equal(plainHint.hidden, true);
    assert.equal(plainHint.parentElement, ui.querySelector('.bpb-re-bar'),
        'the Plain hint should reuse the shared toolbar row');

    modeButton(doc, 'Plain').click();
    const textarea = doc.getElementById('JournalText');
    assert.equal(textarea.classList.contains('bpb-re-hidden'), false);
    assert.equal(textarea.value, 'raw [b]supported[/b] text');
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
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    assert.equal(ui.dataset.mode, 'plain');
    assert.equal(ui.querySelector('.bpb-re-conversion').hidden, false);
    assert.match(ui.querySelector('.bpb-re-conversion-text').textContent, /\[iframe\] source or attributes/);
    modeButton(doc, 'Markdown').click();
    assert.equal(ui.dataset.mode, 'plain', 'a mode click cannot bypass explicit conversion');
    assert.equal(doc.activeElement, ui.querySelector('.bpb-re-convert'));
    assert.equal(doc.getElementById('JournalText').value, report);
});

test('Convert anyway intentionally enters Rich mode before unsupported markup can change', async () => {
    const dom = await loadEditor({ report: '[iframe src="https://example.com"][/iframe]' });
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Rich text').click();
    ui.querySelector('.bpb-re-convert').click();
    assert.equal(ui.dataset.mode, 'rich');
    assert.equal(ui.querySelector('.bpb-re-conversion').hidden, true);
    assert.equal(doc.getElementById('JournalText').value, '[iframe src="https://example.com"][/iframe]',
        'conversion remains non-destructive until the user edits');
    const rich = editors(dom).rich;
    rich.chain().focus('end').insertContent(' edited').run();
    await waitFor(dom, () => /edited/.test(doc.getElementById('JournalText').value));
    const submitted = doc.getElementById('JournalText').value;
    assert.doesNotMatch(submitted, /\[iframe\b/i);
    assert.match(submitted, /&#91;iframe/);

    rich.chain().focus().undo().run();
    doc.getElementById('GPXPreview').click();
    assert.doesNotMatch(doc.getElementById('JournalText').value, /edited/);
    assert.match(doc.getElementById('JournalText').value, /&#91;iframe/,
        'undo reverses the edit, not the conversion the user already accepted');
});

test('lossy diagnostics name unsupported tags, attributes, and nesting concisely', async () => {
    const report = '[unknown]x[/unknown] [b onclick="run()"]bold[/b] [li]orphan[/li]';
    const dom = await loadEditor({ report });
    const ui = await editorReady(dom);
    const copy = ui.querySelector('.bpb-re-conversion-text').textContent;

    assert.equal(ui.dataset.mode, 'plain');
    assert.match(copy, /\[unknown\]/);
    assert.match(copy, /onclick on \[b\]/);
    assert.match(copy, /\[li\] nesting/);
    assert.equal(ui.querySelectorAll('.bpb-re-conversion button').length, 1);
    assert.equal(ui.querySelector('.bpb-re-convert').textContent, 'Convert anyway');
});

test('safe aliases and whitespace normalization do not trigger the conversion guard', async () => {
    const dom = await loadEditor({ report: '  [strong]safe[/strong]\r\n\r\n- one\n- two  ' });
    const ui = await editorReady(dom);

    assert.equal(ui.dataset.mode, 'rich');
    assert.equal(ui.querySelector('.bpb-re-conversion').hidden, true);
});
