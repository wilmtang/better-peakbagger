// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real editor bundles and the masked native form; storage and image bytes are
// fixture-owned. No uploads, live Peakbagger requests, or form submissions.
/* global document, window, getSelection, requestAnimationFrame */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './browser-verification-fixtures.mjs';
import type { Page, Route } from 'playwright';

/* eslint-disable @typescript-eslint/no-shadow -- page-world callbacks take the outer value as their serialized argument under its own name. */
// Fixture types. Node strips these annotations in place, so each page-world
// callback's source is unchanged when Playwright serializes it.
type FixtureElement = HTMLInputElement & HTMLDetailsElement & HTMLImageElement;
type FixtureMessage = { type?: string; [field: string]: unknown };
declare global {
    interface Window { __captionGeometry: { samples: unknown[]; running: boolean } }
}
type LayoutVariant = { name: string; theme: string; [field: string]: unknown };

function readGeometry() {
    const rect = (selector: string) => {
        const element = document.querySelector<FixtureElement>(selector);
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
    };
    return {
        pageX: window.scrollX, pageY: window.scrollY,
        editorScroll: document.querySelector<FixtureElement>('.bpb-re-surface')!.scrollTop,
        panel: rect('#bpb-report-editor'), surface: rect('.bpb-re-surface'),
        heading: rect('h1'), footer: rect('.bpb-re-foot'), native: rect('#GPXUpload'),
        photo: rect('.bpb-re-image-resize img'),
        caption: rect('.bpb-re-surface figcaption') || rect('.bpb-re-caption-placeholder'),
        following: rect('.bpb-re-surface > p:last-child:not(:has(.bpb-re-image-resize))'),
    };
}

async function stableTransition(page: Page, label: string, action: () => Promise<unknown>, ready: () => boolean | undefined) {
    await page.evaluate((read: string) => {
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
    }) as Record<string, Record<string, number> | number | null>[];
    const before = samples[0];
    for (const sample of samples.slice(1)) {
        for (const [name, expected] of Object.entries(before)) {
            if (name === 'following' && !expected) continue;
            const actual = sample[name];
            const values = typeof expected === 'number' ? { value: expected } : expected;
            const current = typeof actual === 'number' ? { value: actual } : actual;
            assert.ok(current, `${label}: missing ${name}`);
            for (const [key, value] of Object.entries(values!)) {
                assert.ok(Math.abs((current as Record<string, number>)[key] - (value as number)) <= 1,
                    `${label}: ${name}.${key} moved ${(current as Record<string, number>)[key] - (value as number)}px; ${JSON.stringify({ before, sample })}`);
            }
        }
    }
}

export async function verifyReportCaptionStability(page: Page, origin: string, variant: LayoutVariant, { asset, capture }: { asset: (file: string) => Promise<Buffer>; capture: (page: Page, label: string, reference?: boolean) => Promise<unknown> }) {
    const html = (await readFile(`${projectRoot}/test/fixtures/pages/climber-ascentedit.html`, 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('**/climber/ascentedit.aspx**', (route: Route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/caption-ridge.svg', (route: Route) => route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#adcddf"/><path d="M0 500L350 50L800 500" fill="#526c78"/></svg>' }));
    // The native fixture contains external decoration; never fetch live pages.
    await page.route((url: URL) => url.origin !== origin, (route: Route) => route.abort());
    await page.addInitScript(({ theme }: { theme: string }) => {
        const area = { get: async () => ({ bpbSettings: { theme } }), set: async () => {}, remove: async () => {} };
        const local: Record<string, unknown> = {};
        let writes = 0;
        const localArea = {
            get: async (keys: string[]) => structuredClone(Object.fromEntries(
                (Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(local))
                    .map(key => [key, local[key]]))),
            set: async (values: object) => Object.assign(local, structuredClone(values)),
            remove: async (keys: string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key]; },
        };
        window.chrome = { runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.0' }),
            getURL: (file: string) => new URL(`/dist/${file}`, location.origin).href, onMessage: { addListener() {}, removeListener() {} },
            sendMessage: async (message: FixtureMessage) => {
                if (message.type === 'REPORT_DRAFT_WRITE') {
                    const record = { ...structuredClone(message.record as object), storageGeneration: `${Date.now()}:${++writes}:caption-fixture` };
                    await localArea.set({ [message.draftKey as string]: record });
                    return { ok: true, draftKey: message.draftKey, written: true, record };
                }
                return { ok: true };
            } },
        storage: { sync: area, local: localArea, onChanged: { addListener() {}, removeListener() {} } } } as unknown as typeof chrome;
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
    }, variant);

    let executed = 0;
    for (const textScale of [1, 1.5]) for (const shape of ['scrolling', 'compact', 'last']) {
        await page.goto(`${origin}/climber/ascentedit.aspx?cid=900001`);
        await page.evaluate(({ origin, shape }: { origin: string; shape: string }) => {
            const image = `[img src="${origin}/caption-ridge.svg" width="240" height="150"]`;
            const paragraphs = (name: string, count: number) => Array.from({ length: count }, (_, i) => `${name} paragraph ${i}`).join('\n\n');
            (document.getElementById('JournalText') as FixtureElement)!.value = shape === 'scrolling'
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
        await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-re-image-resize img')?.naturalWidth === 800);
        await placeholder.scrollIntoViewIfNeeded();
        if (shape === 'scrolling') assert.ok(await surface.evaluate((element: FixtureElement) => element.scrollTop > 0),
            'the long-report case must exercise an already scrolled editor');
        const label = `${variant.name} caption ${shape} text ${textScale}`;
        const editing = () => document.querySelector<FixtureElement>('.bpb-re-surface figcaption')?.classList.contains('bpb-re-caption-editing')
            && document.querySelector<FixtureElement>('figcaption')!.contains(getSelection()!.anchorNode);
        await stableTransition(page, `${label} click`, () => placeholder.click(), editing);
        await stableTransition(page, `${label} typing`, () => page.keyboard.type('North ridge'),
            () => document.querySelector<FixtureElement>('figcaption')?.textContent === 'North ridge');
        await stableTransition(page, `${label} autosave`, async () => {},
            () => document.querySelector<FixtureElement>('.bpb-re-status')?.textContent.startsWith('Draft saved on this device')
                || !document.querySelector<FixtureElement>('.bpb-re-save-recovery')!.hidden);
        assert.match((await page.locator('.bpb-re-status').textContent())!, /^Draft saved on this device/,
            `${label}: the fixture must acknowledge the autosave`);
        await stableTransition(page, `${label} select photo`, () => page.locator('.bpb-re-image-resize img').click(),
            () => document.querySelector<FixtureElement>('figure')?.classList.contains('ProseMirror-selectednode'));
        for (let index = 0; index < 2; index++) {
            await stableTransition(page, `${label} edit ${index}`, () => caption.click(), editing);
        }
        // Clearing maps the caret back into the image's paragraph. Keep that
        // whole paragraph visible so necessary caret scrolling at a clipped
        // editor edge is not confused with a change in caption geometry.
        await caption.evaluate((element: FixtureElement) => element.scrollIntoView({ block: 'center' }));
        await caption.fill('x');
        await stableTransition(page, `${label} clear`, () => page.keyboard.press('Backspace'),
            () => !document.querySelector<FixtureElement>('figcaption') && !!document.querySelector<FixtureElement>('.bpb-re-caption-placeholder'));
        await placeholder.focus();
        await stableTransition(page, `${label} keyboard entry`, () => page.keyboard.press('Enter'), editing);
        await stableTransition(page, `${label} keyboard typing`, () => page.keyboard.type('North ridge'),
            () => document.querySelector<FixtureElement>('figcaption')?.textContent === 'North ridge');
        const handles = await page.locator('.bpb-re-image-resize').evaluate((element: FixtureElement) => {
            const photo = element.querySelector<FixtureElement>('img')!.getBoundingClientRect();
            const handle = element.querySelector<FixtureElement>('[data-resize-handle]')!.getBoundingClientRect();
            const caption = element.closest<FixtureElement>('figure')!.querySelector<FixtureElement>('figcaption')!.getBoundingClientRect();
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
        assert.ok(wrapped!.height > 40 && Math.abs(wrapped!.width - handles.photoWidth) <= 1, `${label}: readable wrapping`);
        const afterWrap = await page.evaluate(readGeometry);
        for (const key of ['x', 'y', 'width'] as const) assert.ok(Math.abs(afterWrap.panel![key] - beforeWrap.panel![key]) <= 1,
            `${label}: wrapping moved the editor's ${key}`);
        await capture(page, `${variant.name}-caption-${shape}-wrapped-text${textScale}`);
        executed++;
    }
    assert.equal(executed, 6, 'caption verifier must execute every layout and text scale');
    await verifyFormatPainter(page, origin, variant, { asset, capture });
}

// Real pointer and keyboard gestures, because the editor reads a drag's selection
// from the browser and the fixture DOM cannot stand in for that.
async function verifyFormatPainter(page: Page, origin: string, variant: LayoutVariant, { asset, capture }: { asset: (file: string) => Promise<Buffer>; capture: (page: Page, label: string, reference?: boolean) => Promise<unknown> }) {
    await page.goto(`${origin}/climber/ascentedit.aspx?cid=900001`);
    await page.evaluate((origin: string) => {
        (document.getElementById('JournalText') as FixtureElement)!.value = [
            '[b][i]Source[/i][/b] then alpha beta gamma delta',
            'Keyboard epsilon',
            'A whole paragraph to paint',
            `[figure][img src="${origin}/caption-ridge.svg" width="240" height="150"][figcaption]Caption words here[/figcaption][/figure]`,
            'After the photo',
        ].join('\n\n');
    }, origin);
    await page.addStyleTag({ content: (await asset('css/report-editor.css')).toString() });
    for (const file of ['vendor/marked.umd.js', 'content/ascent-editor.js']) {
        await page.addScriptTag({ content: (await asset(file)).toString() });
    }
    await page.locator('.bpb-re-surface').waitFor();
    await page.waitForFunction(() => document.querySelector<FixtureElement>('.bpb-re-image-resize img')?.naturalWidth === 800);
    const painter = page.getByRole('button', { name: /^Format painter/ });
    const box = page.locator('.bpb-re-painterbox');
    const wordBox = (word: string) => page.evaluate((word: string) => {
        const walker = document.createTreeWalker(document.querySelector('.bpb-re-surface')!, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = node.nodeValue!.indexOf(word);
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + word.length);
            const { left, right, top, height } = range.getBoundingClientRect();
            return { left, right, y: top + height / 2 };
        }
        throw new Error(`Missing word: ${word}`);
    }, word);
    // The editor re-syncs the browser selection in a task after each mouse-up, and
    // a press arriving first would be reverted. No person clicks that quickly.
    const settled = () => page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => setTimeout(() => requestAnimationFrame(resolve), 0))));
    const dragOver = async (word: string) => {
        const { left, right, y } = await wordBox(word);
        await page.mouse.move(left + 1, y);
        await page.mouse.down();
        await page.mouse.move(right - 1, y, { steps: 4 });
        await page.mouse.move(right + 1, y);
        await page.mouse.up();
        await settled();
    };
    const pressed = (value: string) => page.waitForFunction((value: string) =>
        document.querySelector('[aria-label^="Format painter"]')!.getAttribute('aria-pressed') === value, value);
    const formatted = (word: string) => page.waitForFunction((word: string) =>
        [...document.querySelectorAll('.bpb-re-surface strong em, .bpb-re-surface em strong')].some(node => node.textContent!.includes(word)), word);
    const anchors = ['.bpb-re-bar', '.bpb-re-surface', '.bpb-re-foot', '[aria-label^="Format painter"]'];
    const measure = () => page.evaluate((anchors: string[]) => anchors.map(selector => {
        const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
        return { selector, x, y, width, height };
    }), anchors);
    const expectStable = async (before: unknown, label: string) => assert.deepEqual(await measure(), before, `${variant.name} painter ${label} moved the layout`);

    // Single use, from a drag: the armed state and its release move nothing.
    await dragOver('Source');
    const idle = await measure();
    await painter.click();
    await pressed('true');
    assert.ok(await box.isVisible());
    const hover = await wordBox('alpha');
    await page.mouse.move(hover.left, hover.y);
    assert.notEqual(await page.locator('.bpb-re-surface').evaluate((element: FixtureElement) => getComputedStyle(element).cursor), 'text');
    await expectStable(idle, 'arming');
    const contrast = await box.evaluate((element: FixtureElement) => {
        const channels = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
            const unit = channel / 255;
            return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
        });
        const luminance = (value: string) => { const [r, g, b] = channels(value); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const [light, dark] = [luminance(getComputedStyle(element.querySelector('.bpb-re-painter-status')!).color),
            luminance(getComputedStyle(element).backgroundColor)].sort((a, b) => b - a);
        return (light + 0.05) / (dark + 0.05);
    });
    assert.ok(contrast >= 4.5, `${variant.name}: painter hint contrast ${contrast}`);
    await capture(page, `${variant.name}-format-painter-armed`);
    await dragOver('alpha');
    await formatted('alpha');
    await pressed('false');
    assert.ok(await box.isHidden());
    await expectStable(idle, 'applying');

    // A double-click stays armed through several selections and Escape ends it.
    await dragOver('Source');
    await painter.dblclick();
    await page.locator('.bpb-re-tool-locked').waitFor();
    await dragOver('beta');
    await formatted('beta');
    await dragOver('gamma');
    await formatted('gamma');
    await pressed('true');
    await capture(page, `${variant.name}-format-painter-locked`);
    await page.keyboard.press('Escape');
    await pressed('false');
    await expectStable(idle, 'Escape');
    await dragOver('delta');
    assert.equal(await page.locator('.bpb-re-surface strong em', { hasText: 'delta' }).count(), 0, 'a cancelled painter must not apply');

    // A triple-click paints the paragraph, not the word its second press selected.
    await dragOver('Source');
    await painter.click();
    const paragraph = await wordBox('paragraph');
    await page.mouse.click(paragraph.left + 2, paragraph.y, { clickCount: 3, delay: 20 });
    await formatted('A whole paragraph to paint');
    await pressed('false');

    // Keyboard only: copy, extend the selection, then apply on request.
    await dragOver('Source');
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+Alt+C`);
    await pressed('true');
    const epsilon = await wordBox('epsilon');
    await page.mouse.click(epsilon.left, epsilon.y);
    // This click selects nothing: it must move the caret and leave the painter armed.
    await page.waitForFunction(() => getSelection()!.isCollapsed && getSelection()!.anchorNode?.nodeValue === 'Keyboard epsilon');
    await settled();
    await pressed('true');
    assert.equal(await page.evaluate(() => getSelection()!.anchorNode?.nodeValue), 'Keyboard epsilon', 'the click must keep its caret');
    for (let index = 0; index < 'epsilon'.length; index++) await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.locator('.bpb-re-surface strong em', { hasText: 'epsilon' }).count(), 0, 'a keyboard selection must not apply by itself');
    await page.keyboard.press(`${modifier}+Alt+V`);
    await formatted('epsilon');
    await pressed('false');

    // Captions take the format through the same gesture and keep the photo steady.
    await dragOver('Source');
    await painter.click();
    // Centered, because a drag held near the window's edge scrolls the page under the pointer.
    await page.locator('.bpb-re-surface figcaption').evaluate((element: FixtureElement) => element.scrollIntoView({ block: 'center' }));
    const caption = await page.locator('.bpb-re-surface figcaption').boundingBox();
    await dragOver('words');
    await formatted('words');
    const after = await page.locator('.bpb-re-surface figcaption').boundingBox();
    assert.deepEqual({ x: after!.x, width: after!.width }, { x: caption!.x, width: caption!.width });
    await capture(page, `${variant.name}-format-painter-caption`);
    await page.locator('.bpb-re-surface figcaption strong').click();
    assert.equal(await page.getByRole('button', { name: /^Bold/ }).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: 'Insert image' }).isDisabled(), true);
    await capture(page, `${variant.name}-format-painter-caption-tools`);
    await page.locator('.bpb-re-mode', { hasText: 'Plain' }).click();
    assert.match(await page.locator('#JournalText').inputValue(), /\[figcaption\]Caption \[b\]\[i\]words\[\/i\]\[\/b\] here\[\/figcaption\]/);
}
