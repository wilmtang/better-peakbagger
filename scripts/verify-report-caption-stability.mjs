// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real editor bundles and the masked native form; storage and image bytes are
// fixture-owned. No uploads, live Peakbagger requests, or form submissions.
/* global document, window, getSelection, requestAnimationFrame */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './browser-verification-fixtures.mjs';

function readGeometry() {
    const rect = selector => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
    };
    return {
        pageX: window.scrollX, pageY: window.scrollY,
        editorScroll: document.querySelector('.bpb-re-surface').scrollTop,
        panel: rect('#bpb-report-editor'), surface: rect('.bpb-re-surface'),
        heading: rect('h1'), footer: rect('.bpb-re-foot'), native: rect('#GPXUpload'),
        photo: rect('.bpb-re-image-resize img'),
        caption: rect('.bpb-re-surface figcaption') || rect('.bpb-re-caption-placeholder'),
        following: rect('.bpb-re-surface > p:last-child:not(:has(.bpb-re-image-resize))'),
    };
}

async function stableTransition(page, label, action, ready) {
    await page.evaluate(read => {
        const measure = new Function(`return (${read})`)();
        const probe = { samples: [measure()], running: true };
        window.__captionGeometry = probe;
        const frame = () => {
            if (!probe.running) return;
            probe.samples.push(measure());
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }, readGeometry.toString());
    await action();
    await page.waitForFunction(ready);
    // Observe painted intermediate states and two frames after the visible
    // postcondition, rather than sleeping and checking only the final layout.
    const samples = await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__captionGeometry.running = false;
        return window.__captionGeometry.samples;
    });
    const before = samples[0];
    for (const sample of samples.slice(1)) {
        for (const [name, expected] of Object.entries(before)) {
            if (name === 'following' && !expected) continue;
            const actual = sample[name];
            const values = typeof expected === 'number' ? { value: expected } : expected;
            const current = typeof actual === 'number' ? { value: actual } : actual;
            assert.ok(current, `${label}: missing ${name}`);
            for (const [key, value] of Object.entries(values)) {
                assert.ok(Math.abs(current[key] - value) <= 1,
                    `${label}: ${name}.${key} moved ${current[key] - value}px; ${JSON.stringify({ before, sample })}`);
            }
        }
    }
}

export async function verifyReportCaptionStability(page, origin, variant, { asset, capture }) {
    const html = (await readFile(`${projectRoot}/test/fixtures/pages/climber-ascentedit.html`, 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('**/climber/ascentedit.aspx**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/caption-ridge.svg', route => route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#adcddf"/><path d="M0 500L350 50L800 500" fill="#526c78"/></svg>' }));
    // The native fixture contains external decoration; never fetch live pages.
    await page.route(url => url.origin !== origin, route => route.abort());
    await page.addInitScript(({ theme }) => {
        const area = { get: async () => ({ bpbSettings: { theme } }), set: async () => {}, remove: async () => {} };
        window.chrome = { runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.0' }),
            getURL: file => `/dist/${file}`, onMessage: { addListener() {}, removeListener() {} },
            sendMessage: async () => ({ ok: true }) },
        storage: { sync: area, local: area, onChanged: { addListener() {}, removeListener() {} } } };
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
    }, variant);

    let executed = 0;
    for (const textScale of [1, 1.5]) for (const shape of ['scrolling', 'compact', 'last']) {
        await page.goto(`${origin}/climber/ascentedit.aspx?cid=900001`);
        await page.evaluate(({ origin, shape }) => {
            const image = `[img src="${origin}/caption-ridge.svg" width="240" height="150"]`;
            const paragraphs = (name, count) => Array.from({ length: count }, (_, i) => `${name} paragraph ${i}`).join('\n\n');
            document.getElementById('JournalText').value = shape === 'scrolling'
                ? `${paragraphs('Before', 16)}\n\n${image}\n\n${paragraphs('After', 14)}`
                : shape === 'compact' ? `Before\n\n${image}\n\nAfter` : image;
        }, { origin, shape });
        await page.addStyleTag({ content: (await asset('css/report-editor.css')).toString() });
        await page.addStyleTag({ content: `.bpb-re-surface { font-size: ${13 * textScale}px; }` });
        for (const file of ['vendor/marked.umd.js', 'content/ascent-editor.js']) {
            await page.addScriptTag({ content: (await asset(file)).toString() });
        }
        const surface = page.locator('.bpb-re-surface');
        const caption = page.locator('.bpb-re-surface figcaption');
        const placeholder = page.getByRole('button', { name: 'Write a caption', exact: true });
        await surface.waitFor();
        await page.waitForFunction(() => document.querySelector('.bpb-re-image-resize img')?.naturalWidth === 800);
        await placeholder.scrollIntoViewIfNeeded();
        if (shape === 'scrolling') assert.ok(await surface.evaluate(element => element.scrollTop > 0),
            'the long-report case must exercise an already scrolled editor');
        const label = `${variant.name} caption ${shape} text ${textScale}`;
        const editing = () => document.querySelector('.bpb-re-surface figcaption')?.classList.contains('bpb-re-caption-editing')
            && document.querySelector('figcaption').contains(getSelection()?.anchorNode);
        await stableTransition(page, `${label} click`, () => placeholder.click(), editing);
        await stableTransition(page, `${label} typing`, () => page.keyboard.type('North ridge'),
            () => document.querySelector('figcaption')?.textContent === 'North ridge');
        await stableTransition(page, `${label} select photo`, () => page.locator('.bpb-re-image-resize img').click(),
            () => document.querySelector('figure')?.classList.contains('ProseMirror-selectednode'));
        for (let index = 0; index < 2; index++) {
            await stableTransition(page, `${label} edit ${index}`, () => caption.click(), editing);
        }
        // Clearing maps the caret back into the image's paragraph. Keep that
        // whole paragraph visible so necessary caret scrolling at a clipped
        // editor edge is not confused with a change in caption geometry.
        await caption.evaluate(element => element.scrollIntoView({ block: 'center' }));
        await caption.fill('x');
        await stableTransition(page, `${label} clear`, () => page.keyboard.press('Backspace'),
            () => !document.querySelector('figcaption') && !!document.querySelector('.bpb-re-caption-placeholder'));
        await placeholder.focus();
        await stableTransition(page, `${label} keyboard entry`, () => page.keyboard.press('Enter'), editing);
        await stableTransition(page, `${label} keyboard typing`, () => page.keyboard.type('North ridge'),
            () => document.querySelector('figcaption')?.textContent === 'North ridge');
        const handles = await page.locator('.bpb-re-image-resize').evaluate(element => {
            const photo = element.querySelector('img').getBoundingClientRect();
            const handle = element.querySelector('[data-resize-handle]').getBoundingClientRect();
            const caption = element.closest('figure').querySelector('figcaption').getBoundingClientRect();
            return { width: handle.width, height: handle.height, belowPhoto: handle.top >= photo.bottom - 1,
                aboveCaption: handle.bottom <= caption.top + 1, captionWidth: caption.width, photoWidth: photo.width };
        });
        assert.ok(handles.width >= 44 && handles.height >= 44 && handles.belowPhoto && handles.aboveCaption,
            `${label}: resize target must keep its usable space: ${JSON.stringify(handles)}`);
        assert.ok(Math.abs(handles.captionWidth - handles.photoWidth) <= 1, `${label}: caption width`);
        if (shape === 'compact') await capture(page, `${variant.name}-caption-text${textScale}`);
        // Wrapping is an intentional expansion. The editor's heading/toolbar
        // must stay anchored and the caption must stay within the photo width.
        const beforeWrap = await page.evaluate(readGeometry);
        await caption.fill('A long caption with enough words to wrap below the photo. '.repeat(3));
        const wrapped = await caption.boundingBox();
        assert.ok(wrapped.height > 40 && Math.abs(wrapped.width - handles.photoWidth) <= 1, `${label}: readable wrapping`);
        const afterWrap = await page.evaluate(readGeometry);
        for (const key of ['x', 'y', 'width']) assert.ok(Math.abs(afterWrap.panel[key] - beforeWrap.panel[key]) <= 1,
            `${label}: wrapping moved the editor's ${key}`);
        await capture(page, `${variant.name}-caption-${shape}-wrapped-text${textScale}`);
        executed++;
    }
    assert.equal(executed, 6, 'caption verifier must execute every layout and text scale');
}
