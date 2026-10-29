// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, innerWidth, innerHeight, getComputedStyle */
import assert from 'node:assert/strict';

export function readEditorGeometry() {
    const rect = selector => {
        const element = document.querySelector(selector), box = element?.getBoundingClientRect();
        if (!box?.width || !box.height) throw new Error(`Expected visible geometry for ${selector}`);
        return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, box[key]]));
    };
    return { heading: rect('h1'), advanced: rect('#advanced summary'), help: rect('#advanced + .help summary'),
        save: rect('#save'), check: rect('#test'), close: rect('#cancel'),
        scroll: document.getElementById('editor-fields').scrollTop, height: document.getElementById('editor-fields').scrollHeight };
}

export function readEditorFit() {
    const fields = document.getElementById('editor-fields').getBoundingClientRect();
    const overflow = [...document.querySelectorAll('input,select,button,p,summary,legend,label')].filter(element => {
        const box = element.getBoundingClientRect();
        return box.width && box.height && (box.left < -1 || box.right > innerWidth + 1);
    }).map(element => element.id || element.tagName);
    return { fits: fields.left >= 0 && fields.right <= innerWidth && overflow.length === 0,
        viewport: { width: innerWidth, height: innerHeight }, fields: { left: fields.left, right: fields.right }, overflow };
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
        window.editorSavedSource = message.source;
        return new Promise(resolve => { window.releaseEditorSave = error => { api.runtime.sendMessage = original; resolve(error ? { ok: false, error } : { ok: true }); }; });
    };
    document.getElementById('save').focus();
}

// Drives the packaged editor in its real Options iframe. Only the delayed Save
// reply is stubbed; TileJSON is read from the verifier's HTTPS/CORS provider.
export async function verifyCustomEditor({ evaluate, click, press, hover, fill, wait, viewport, screenshot, providerOrigin, holdSource, pendingSource }) {
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
        const gap = await evaluate(() => document.querySelector('#advanced + .help').getBoundingClientRect().top - document.getElementById('advanced').getBoundingClientRect().bottom);
        assert.ok(gap <= 24, `Collapsed Advanced leaves ${gap}px of blank space before troubleshooting`);
        assert.equal(await evaluate(() => document.getElementById('notice').hidden), true);
        if (width === 1000) {
            await evaluate(() => { document.querySelector('#advanced + .help').hidden = true; });
            try { await assert.rejects(evaluate(readEditorGeometry), /Expected visible geometry/, 'hidden geometry must fail'); }
            finally { await evaluate(() => { document.querySelector('#advanced + .help').hidden = false; }); }
            await evaluate(() => { document.getElementById('name').style.width = '3000px'; });
            try { assert.equal((await evaluate(readEditorFit)).fits, false, 'real overflowing controls must fail'); }
            finally { await evaluate(() => { document.getElementById('name').style.width = ''; }); }
            assert.equal((await evaluate(readEditorFit)).fits, true, 'intentional in-bounds field margins are supported');
        }
        await click('#advanced summary');
        await hover('#format-label .info');
        await wait(() => evaluate(() => !document.getElementById('format-help').hidden), 'help opens on hover');
        await hover('#format-help');
        assert.equal(await evaluate(() => document.getElementById('format-help').hidden), false, 'pointer can enter the tooltip');
        await press('#format-label .info', 'Escape');
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
        await fill('#name', 'Editor verification'); await fill('#url', `${providerOrigin}/metadata.json`);
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
    await fill('#url', `${providerOrigin}/detect-slow.json`);
    for (const fail of [true, false]) {
        holdSource(true);await evaluate(() => document.getElementById('test').focus({ preventScroll: true }));const before = await evaluate(readEditorGeometry);
        await press('#test', 'Space');
        await wait(() => evaluate(() => document.getElementById('test').getAttribute('aria-disabled') === 'true'), 'source detection is pending');
        await wait(pendingSource, 'provider response is held during source detection');
        stable(before, await evaluate(readEditorGeometry), 'pending source detection');
        await press('#test', 'Space');
        holdSource(false, fail);
        await wait(() => evaluate(() => document.getElementById('test').getAttribute('aria-disabled') === 'false'), 'source detection settles');
        assert.equal(await evaluate(() => document.activeElement.id), 'test');
        assert.equal(await evaluate(() => document.getElementById('advanced').open), false);
        assert.equal(await evaluate(() => document.getElementById('feedback').textContent.startsWith('Source values loaded.')), !fail);
        stable(before, await evaluate(readEditorGeometry), fail ? 'source detection error' : 'source detection retry success');
        await screenshot?.(fail ? 'detect-error' : 'detect-success');await click('#dismiss-feedback');
    }
    cases++;
    for (const [endpoint, kind] of [['metadata', 'raster'], ['detect-vector', 'mvt'], ['detect-geo', 'geojson']]) {
        await fill('#url', `${providerOrigin}/${endpoint}.json`);
        assert.equal(await evaluate(() => document.getElementById('advanced').open), false);
        await evaluate(holdEditorSave);const before = await evaluate(readEditorGeometry);
        await press('#save', 'Space');
        await wait(() => evaluate(() => window.editorSaveCount === 1), `${kind} detected from only name and URL`);
        assert.equal(await evaluate(() => window.editorSavedSource.kind), kind);
        stable(before, await evaluate(readEditorGeometry), `${kind} auto-fill pending Save`);
        await evaluate(() => window.releaseEditorSave(''));
        await wait(() => evaluate(() => document.getElementById('save').getAttribute('aria-disabled') === 'false'), `${kind} save completes`);
        stable(before, await evaluate(readEditorGeometry), `${kind} auto-fill success`);
        await click('#dismiss-feedback');await screenshot?.(`auto-${kind}`);cases++;
    }
    await viewport(1000);
    assert.equal(cases, 18, 'editor verifier must execute the tooltip/status matrix, detection retry and three auto-detected formats');
    return { cases, requestedViewports: [1000, 375], frames, themes: ['light', 'dark'], compact: true, tooltips: true, statusAnchored: true, metadataZoom: true, automaticSourceTypes: true };
}

// Kept separate so focus/zoom acceptance is reachable even when an independent
// provider or editor-write check fails earlier in the larger matrix.
export async function verifyCustomHelp({ evaluate, press, wait, viewport, zoom, screenshot }) {
    const frames = []; let cases = 0;
    const chromeGeometry = () => {
        const rect = element => { const box = element.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; };
        return [rect(document.querySelector('h1')), rect(document.querySelector('footer')), window.scrollX, window.scrollY];
    };
    for (const width of [1000, 375]) for (const factor of [1, 2]) {
        await zoom(1); await viewport(width); const actual = await zoom(factor);
        assert.ok(Math.abs(actual.width - width / factor) <= 1, `actual content viewport matches ${width}px at ${factor * 100}%: ${JSON.stringify(actual)}`);
        await evaluate(theme => { document.documentElement.dataset.theme = theme; document.getElementById('advanced').open = true; }, width === 375 ? 'dark' : 'light');
        frames.push(await evaluate(() => ({ width: innerWidth, height: innerHeight })));
        for (const id of ['kind', 'format', 'minimum', 'scheme', 'tile-size', 'bounds']) {
            await evaluate(() => { const summary = document.querySelector('#advanced summary'); summary.scrollIntoView({ block: 'center' }); summary.focus(); });
            const before = await evaluate(chromeGeometry);
            let found = false;
            for (let n = 0; n < 40; n++) {
                await press(n === 0 ? '#advanced summary' : ':focus', 'Tab');
                if (await evaluate(id => document.activeElement === document.querySelector(`#${id}-label .info`), id)) { found = true; break; }
            }
            assert.ok(found, `${id} is reachable through real Tab order; active=${await evaluate(() => document.activeElement?.outerHTML.slice(0, 200))}`);
            const inspect = () => evaluate(id => {
                const button = document.activeElement, tip = document.getElementById(`${id}-help`), clip = document.getElementById('editor-fields').getBoundingClientRect();
                const box = button.getBoundingClientRect(), text = tip.getBoundingClientRect(), style = getComputedStyle(tip);
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return { visible: box.top >= clip.top && box.bottom <= clip.bottom && button.contains(hit), hidden: tip.hidden,
                    readable: tip.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) >= parseFloat(style.lineHeight) - 1,
                    fits: text.left >= 0 && text.right <= innerWidth && text.top >= 0 && text.bottom <= innerHeight,
                    overflow: tip.scrollHeight > tip.clientHeight, scroll: tip.scrollTop, maximum: tip.scrollHeight - tip.clientHeight,
                    fieldScroll: document.getElementById('editor-fields').scrollTop,
                    trigger: { top: box.top, bottom: box.bottom }, clip: { top: clip.top, bottom: clip.bottom },
                    help: { top: text.top, bottom: text.bottom, height: text.height, content: tip.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), line: style.lineHeight } };
            }, id);
            const visible = await wait(async () => {
                const value = await inspect(); return value.visible && !value.hidden && value.readable && value.fits ? value : false;
            }, `${id} focused trigger and readable help at ${width}/${factor}`).catch(async error => {
                await screenshot?.(`failure-${id}-${width}-${factor}`);
                throw new Error(`${id} help state: ${JSON.stringify(await inspect())}`, { cause: error });
            });
            if (visible.overflow) {
                await press(':focus', 'End');
                const end = await wait(async () => { const value = await inspect(); return Math.abs(value.maximum - value.scroll) <= 1 ? value : false; }, `${id} final help lines are keyboard readable at ${width}/${factor}`).catch(async error => {
                    await screenshot?.(`failure-end-${id}-${width}-${factor}`);
                    throw new Error(`${id} help scroll state: ${JSON.stringify(await inspect())}`, { cause: error });
                });
                assert.equal(end.fieldScroll, visible.fieldScroll, 'help scrolling keeps its trigger anchored');
                await press(':focus', 'Home'); await wait(async () => (await inspect()).scroll === 0, `${id} help returns to its first line`);
                assert.equal(await evaluate(id => {
                    const button = document.querySelector(`#${id}-label .info`), tip = document.getElementById(`${id}-help`), before = tip.scrollTop;
                    return ['ctrlKey', 'altKey', 'metaKey'].every(modifier => {
                        const event = new window.KeyboardEvent('keydown', { key: 'End', [modifier]: true, bubbles: true, cancelable: true });
                        button.dispatchEvent(event); return !event.defaultPrevented && tip.scrollTop === before;
                    });
                }, id), true, 'help preserves modified browser/platform shortcuts');
                await press(':focus', 'ArrowDown'); await wait(async () => (await inspect()).scroll > 0, `${id} help advances by keyboard`);
            }
            const after = await evaluate(chromeGeometry);
            for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) assert.ok(Math.abs(before[i][j] - after[i][j]) <= 1, 'help keeps title/actions anchored');
            assert.deepEqual(after.slice(2), before.slice(2), 'help keeps document position anchored');
            if (id === 'kind') await screenshot?.(`help-${width}-${factor}`);
            await press(':focus', 'Escape'); assert.equal(await evaluate(id => document.getElementById(`${id}-help`).hidden, id), true);
            await press(':focus', 'Shift+Tab');
            assert.equal(await evaluate(id => document.activeElement === document.querySelector(`#${id}-label .info`), id), false, 'reverse Tab remains available');
            cases++;
        }
        assert.equal(await evaluate(async () => {
            document.getElementById('name').focus(); document.querySelector('#kind-label .info').focus();
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
            return document.getElementById('kind-help').hidden;
        }), true, 'Escape cancels a pending focus correction without reopening help');
    }
    await zoom(1);
    assert.equal(cases, 24);
    return { cases, frames, realTab: true, keyboardHelpScrolling: true, titleAndActionsAnchored: true };
}
