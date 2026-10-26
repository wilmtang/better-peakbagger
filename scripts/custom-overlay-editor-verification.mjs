// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, innerWidth, innerHeight, scrollY, getComputedStyle */
import assert from 'node:assert/strict';

export function readEditorGeometry() {
    const rect = selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, box[key]]));
    };
    return { heading: rect('h1'), advanced: rect('#advanced summary'), help: rect('.help summary'),
        save: rect('#save'), check: rect('#test'), close: rect('#cancel'),
        scroll: scrollY, height: document.documentElement.scrollHeight };
}

function stable(before, after, state) {
    for (const key of ['heading', 'advanced', 'help', 'save', 'check', 'close']) {
        for (const property of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(before[key][property] - after[key][property]) <= 1, `${state}: ${key} ${property} stays anchored`);
        }
    }
    assert.equal(after.scroll, before.scroll, `${state}: reading position stays anchored`);
    assert.equal(after.height, before.height, `${state}: status does not resize the document`);
}

function holdEditorSave() {
    const api = window.browser || window.chrome, original = api.runtime.sendMessage.bind(api.runtime);
    window.editorSaveCount = 0;
    api.runtime.sendMessage = message => {
        if (message.type !== 'CUSTOM_OVERLAYS_SAVE') return original(message);
        window.editorSaveCount++;
        return new Promise(resolve => { window.releaseEditorSave = error => { api.runtime.sendMessage = original; resolve(error ? { ok: false, error } : { ok: true }); }; });
    };
    document.getElementById('save').focus();
}

// Drives the packaged editor in its real Options iframe. Only the delayed Save
// reply is stubbed; TileJSON is read from the verifier's HTTPS/CORS provider.
export async function verifyCustomEditor({ evaluate, click, press, hover, fill, select, wait, viewport, screenshot, providerOrigin }) {
    assert.ok(providerOrigin, 'editor verification needs its explicit fixture provider');
    let cases = 0; const frames = [];
    assert.equal(await evaluate(() => document.querySelectorAll('#attribution, #attribution-url, #attribution-label, #attribution-url-label').length), 0,
        'Attribution and Attribution link controls must be removed from Settings');
    assert.deepEqual(await evaluate(() => ['minimum', 'maximum'].map(id => document.getElementById(id).value)), ['0', '18'], 'new raw templates use the unchecked default');
    assert.equal(await evaluate(() => document.getElementById('source-values').hidden), true, 'raw templates cannot discover provider zoom limits');
    for (const [width, theme] of [[1000, 'light'], [375, 'dark']]) {
        await viewport(width);
        frames.push(await evaluate(() => ({ width: innerWidth, height: innerHeight })));
        await evaluate(theme => { document.documentElement.dataset.theme = theme; document.getElementById('advanced').open = false; }, theme);
        const gap = await evaluate(() => document.querySelector('.help').getBoundingClientRect().top - document.getElementById('advanced').getBoundingClientRect().bottom);
        assert.ok(gap <= 24, `Collapsed Advanced leaves ${gap}px of blank space before troubleshooting`);
        assert.equal(await evaluate(() => document.getElementById('notice').hidden), true);
        await hover('#format-label .info');
        await wait(() => evaluate(() => !document.getElementById('format-help').hidden), 'help opens on hover');
        await hover('#format-help');
        assert.equal(await evaluate(() => document.getElementById('format-help').hidden), false, 'pointer can enter the tooltip');
        await press('#format-label .info', 'Escape');
        await click('#advanced summary');
        for (const id of ['kind', 'format', 'minimum', 'scheme', 'tile-size', 'bounds']) {
            const selector = `#${id}-label .info`;
            await evaluate(selector => document.querySelector(selector).focus(), selector);
            await wait(() => evaluate(id => !document.getElementById(`${id}-help`).hidden, id), `${id} help opens on focus`);
            const before = await evaluate(readEditorGeometry);
            await press(selector, 'Space');
            const tip = await evaluate(id => {
                const element = document.getElementById(`${id}-help`), box = element.getBoundingClientRect();
                return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight,
                    fits: element.scrollWidth <= element.clientWidth, text: element.textContent };
            }, id);
            assert.ok(tip.text.length > 30 && tip.fits && tip.left >= 0 && tip.right <= tip.width && tip.top >= 0 && tip.bottom <= tip.height,
                `${id} tooltip fits ${width}px ${theme}: ${JSON.stringify(tip)}`);
            stable(before, await evaluate(readEditorGeometry), `${id} help`);
            if (id === 'bounds') await screenshot?.(`${theme}-bounds-help`);
            await press(selector, 'Escape');
            assert.equal(await evaluate(id => document.getElementById(`${id}-help`).hidden, id), true);
            assert.equal(await evaluate(() => document.getElementById('form') != null), true, 'Escape dismisses help without closing the editor');
            cases++;
        }
        await click('#advanced summary');
        await fill('#name', 'Editor verification'); await fill('#url', `${providerOrigin}/metadata.json`); await select('#format', 'tilejson');
        assert.equal(await evaluate(() => document.getElementById('source-values').hidden), false, 'TileJSON can restore metadata values');
        await click('#test');
        await wait(() => evaluate(() => document.getElementById('feedback').textContent.startsWith('Source values loaded.')), 'TileJSON resolution completes');
        assert.deepEqual(await evaluate(() => ['minimum', 'maximum', 'scheme'].map(id => document.getElementById(id).value)), ['2', '14', 'tms']);
        await click('#dismiss-feedback');
        // Deliberate manual overrides survive another read of provider metadata.
        await click('#advanced summary'); await fill('#maximum', '12'); await click('#advanced summary');
        await click('#test');
        await wait(() => evaluate(() => document.getElementById('feedback').textContent.startsWith('Source values loaded.')), 'metadata preserves manual zoom');
        assert.equal(await evaluate(() => document.getElementById('maximum').value), '12');
        await click('#dismiss-feedback');
        await click('#advanced summary');
        await evaluate(() => document.getElementById('source-values').scrollIntoView({ block: 'center' }));
        await click('#source-values');
        await wait(() => evaluate(() => document.getElementById('maximum').value === '14' && document.getElementById('save').getAttribute('aria-disabled') === 'false'), 'Use source values restores provider zoom');
        await click('#dismiss-feedback'); await click('#advanced summary');

        await evaluate(holdEditorSave);
        const before = await evaluate(readEditorGeometry);
        await press('#save', 'Space');
        await wait(() => evaluate(() => document.getElementById('feedback').textContent === 'Saving…'), 'slow save publishes pending status');
        stable(before, await evaluate(readEditorGeometry), 'pending Save');
        assert.equal(await evaluate(() => document.activeElement.id), 'save', 'busy Save retains keyboard focus');
        await press('#save', 'Space');
        assert.equal(await evaluate(() => window.editorSaveCount), 1, 'busy keyboard activation cannot repeat Save');
        await evaluate(() => window.releaseEditorSave('The source could not be saved. Check the provider settings and try again. '.repeat(8)));
        await wait(() => evaluate(() => document.getElementById('save').getAttribute('aria-disabled') === 'false'), 'failed Save recovers');
        stable(before, await evaluate(readEditorGeometry), 'long error');
        assert.equal(await evaluate(() => {
            const text = document.getElementById('feedback'), style = getComputedStyle(text);
            return text.scrollWidth <= text.clientWidth && (text.scrollHeight <= text.clientHeight || style.overflowY === 'auto');
        }), true, 'long feedback wraps and remains scrollable');
        const scrolls = await evaluate(() => { const text = document.getElementById('feedback'); return text.scrollHeight > text.clientHeight; });
        if (scrolls) {
            assert.equal(await evaluate(() => document.getElementById('feedback').tabIndex), 0, 'overflowing feedback is keyboard reachable');
            await evaluate(() => document.getElementById('feedback').focus({ preventScroll: true }));
            await press('#feedback', 'ArrowDown');
            await wait(() => evaluate(() => document.getElementById('feedback').scrollTop > 0), 'long error is readable with the keyboard');
            stable(before, await evaluate(readEditorGeometry), 'keyboard error scrolling');
        }
        await screenshot?.(`${theme}-status-error`);
        await click('#dismiss-feedback');
        assert.equal(await evaluate(() => document.activeElement.id), 'save', 'dismissing a Save result returns focus to Save');
        stable(before, await evaluate(readEditorGeometry), 'dismissed error');
        assert.equal(await evaluate(() => document.getElementById('notice').hidden), true, 'dismissed notice is unpainted');
        await evaluate(holdEditorSave);
        const retryBefore = await evaluate(readEditorGeometry);
        await press('#save', 'Space');
        await wait(() => evaluate(() => document.getElementById('feedback').textContent === 'Saving…'), 'retry enters pending');
        stable(retryBefore, await evaluate(readEditorGeometry), 'retry pending');
        await evaluate(() => window.releaseEditorSave(''));
        await wait(() => evaluate(() => document.getElementById('feedback').textContent === 'Saved on this device.' && document.getElementById('save').getAttribute('aria-disabled') === 'false'), 'retry succeeds');
        stable(retryBefore, await evaluate(readEditorGeometry), 'retry success');
        await click('#dismiss-feedback');
        await screenshot?.(`${theme}-compact`);
        await evaluate(() => { document.getElementById('maximum').dataset.origin = 'default'; });
        cases++;
    }
    await viewport(1000);
    assert.equal(cases, 14, 'editor verifier must execute all six tooltip and one status case at both sizes');
    return { cases, requestedViewports: [1000, 375], frames, themes: ['light', 'dark'], compact: true, tooltips: true, statusAnchored: true, metadataZoom: true };
}
