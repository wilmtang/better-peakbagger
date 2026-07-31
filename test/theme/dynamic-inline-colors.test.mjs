// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
    INLINE_BACKGROUND_ATTRIBUTE,
    INLINE_BACKGROUND_PROPERTY,
    INLINE_COLOR_ATTRIBUTE,
    INLINE_COLOR_PROPERTY,
    contrastRatio,
    createDynamicInlineColorApplier,
    parseColor,
    transformBackground,
    transformForeground,
} from '../../src/theme/dynamic-inline-colors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DARK_SURFACE = { r: 32, g: 34, b: 36, a: 1 };

test('dynamic foreground mapping makes arbitrary legacy colors readable without flattening hue', () => {
    const sources = ['black', 'navy', 'maroon', 'red', 'brown', '#102030', '#ffffff'];
    const transformed = new Map();
    for (const source of sources) {
        const color = transformForeground(parseColor(source));
        transformed.set(source, color);
        assert.ok(
            contrastRatio(color, DARK_SURFACE) >= 4.5,
            `${source} did not reach WCAG AA against the dark table surface`
        );
    }

    assert.ok(transformed.get('navy').b > transformed.get('navy').r,
        'navy should remain recognizably blue');
    assert.ok(transformed.get('maroon').r > transformed.get('maroon').b,
        'maroon should remain recognizably red');
    assert.notDeepEqual(transformed.get('navy'), transformed.get('maroon'),
        'different semantic colors must not collapse to one body-text color');
});

test('dynamic background mapping darkens both attribute and inline light surfaces', () => {
    for (const source of ['white', 'lightgrey', '#ffffcc', 'rgb(247, 247, 247)']) {
        const background = transformBackground(parseColor(source));
        assert.ok(
            contrastRatio({ r: 199, g: 193, b: 184, a: 1 }, background) >= 4.5,
            `${source} stayed too light for inherited dark-theme body text`
        );
    }
});

test('the saved climber-page caption is transformed while header-photo text stays black', async () => {
    const dom = new JSDOM(
        await readFile(path.join(root, 'test/fixtures/pages/climber-home.html'), 'utf8'),
        { url: 'https://www.peakbagger.com/climber/climber.aspx?cid=40786' }
    );
    const { document } = dom.window;
    const applier = createDynamicInlineColorApplier({
        document,
        // The fixture uses CSS2 named colors, all handled without a canvas.
        normalizeColor: () => null,
    });
    applier.setTheme('dark');

    const caption = document.querySelector('span[style*="color: black" i]');
    assert.ok(caption?.textContent.includes('(Updated every 24 hours)'));
    assert.equal(caption.style.color, 'black', 'the source declaration stays intact');
    assert.ok(caption.hasAttribute(INLINE_COLOR_ATTRIBUTE));
    const transformedCaption = parseColor(caption.style.getPropertyValue(INLINE_COLOR_PROPERTY));
    assert.ok(contrastRatio(transformedCaption, DARK_SURFACE) >= 4.5);

    const maroonLabel = document.querySelector('span[style*="color: maroon" i]');
    assert.ok(maroonLabel.hasAttribute(INLINE_COLOR_ATTRIBUTE));
    const transformedMaroon = parseColor(maroonLabel.style.getPropertyValue(INLINE_COLOR_PROPERTY));
    assert.ok(transformedMaroon.r > transformedMaroon.b, 'the section label remains red');

    const headerLink = document.querySelector('.mainbanner a');
    assert.equal(headerLink.style.color, 'black');
    assert.equal(headerLink.hasAttribute(INLINE_COLOR_ATTRIBUTE), false,
        'the known light photographic header is a site-specific dynamic-theme exception');

    applier.disconnect();
    dom.window.close();
});

test('later inline color changes and inserted legacy backgrounds are watched', async () => {
    const dom = new JSDOM('<!doctype html><html><body><span id="status" style="color:#102030">Status</span></body></html>', {
        url: 'https://www.peakbagger.com/',
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const applier = createDynamicInlineColorApplier({ document, normalizeColor: () => null });
    applier.setTheme('dark');

    const status = document.getElementById('status');
    const first = status.style.getPropertyValue(INLINE_COLOR_PROPERTY);
    status.style.color = '#8b4513';
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.notEqual(status.style.getPropertyValue(INLINE_COLOR_PROPERTY), first);

    const cell = document.createElement('td');
    cell.setAttribute('bgcolor', '#ffffcc');
    cell.setAttribute('color', '#000000');
    document.body.append(cell);
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.ok(cell.hasAttribute(INLINE_BACKGROUND_ATTRIBUTE));
    assert.ok(cell.style.getPropertyValue(INLINE_BACKGROUND_PROPERTY));
    assert.ok(cell.hasAttribute(INLINE_COLOR_ATTRIBUTE));

    const overrideBeforeLight = status.style.getPropertyValue(INLINE_COLOR_PROPERTY);
    applier.setTheme('light');
    status.style.color = '#001122';
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.equal(status.style.getPropertyValue(INLINE_COLOR_PROPERTY), overrideBeforeLight,
        'light mode stops the watcher and leaves its inactive override untouched');

    status.removeAttribute(INLINE_COLOR_ATTRIBUTE);
    status.style.removeProperty(INLINE_COLOR_PROPERTY);
    applier.setTheme('dark');
    assert.ok(status.hasAttribute(INLINE_COLOR_ATTRIBUTE),
        'a dark reactivation restores an override the page removed in light mode');
    assert.notEqual(status.style.getPropertyValue(INLINE_COLOR_PROPERTY), overrideBeforeLight,
        'the restored override follows the newest source declaration');

    applier.disconnect();
    dom.window.close();
});
