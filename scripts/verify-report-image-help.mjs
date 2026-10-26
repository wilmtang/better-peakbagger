// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, requestAnimationFrame, getComputedStyle */
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

const INFO = '.bpb-re-image-info';
const TIP = '.bpb-re-image-tooltip';
const INPUT = '.bpb-re-imagebox input';

function startProbe() {
    const selectors = ['h1', '.bpb-re-imagebox', '.bpb-re-image-hosting:last-of-type',
        '.bpb-re-image-info', '.bpb-re-imagebox .bpb-re-linkapply',
        '.bpb-re-toolbar', '.bpb-re-surface', '#GPXUpload'];
    const read = () => ({
        scroll: { x: window.scrollX, y: window.scrollY },
        ...Object.fromEntries(selectors.map(selector => {
            const node = document.querySelector(selector);
            if (!node) throw new Error(`Missing geometry target: ${selector}`);
            const { x, y, width, height } = node.getBoundingClientRect();
            return [selector, { x, y, width, height }];
        })),
    });
    const probe = window.__bpbImageHelpProbe = { samples: [read()], running: true };
    const frame = () => {
        if (!probe.running) return;
        probe.samples.push(read());
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

export async function verifyReportImageHelp({ kind, version, evaluate, navigate, viewport,
    patch, click, hover, press, screenshot, screenshots, origin }) {
    let cases = 0;
    for (const width of [1280, 375]) for (const theme of ['light', 'dark']) for (const enlarged of [false, true]) {
        await viewport({ width, height: 900 });
        await patch({ theme, reportEditorMode: 'rich', loadInstagramAutomatically: false });
        await navigate(`${origin}/climber/ascentedit.aspx?aid=7654321`);
        await waitForCondition(() => evaluate(() => !!document.querySelector('.bpb-re-surface[contenteditable]')),
            { description: 'image-help Rich editor' });
        if (enlarged) await evaluate(() => {
            const style = document.createElement('style');
            style.textContent = '.bpb-re {font-size:22px!important}.bpb-re-image-hosting,.bpb-re-image-tooltip {font-size:16px!important}';
            document.head.append(style);
        });
        if (enlarged) assert.equal(await evaluate(() => getComputedStyle(
            document.querySelector('.bpb-re-image-tooltip')).fontSize), '16px', 'enlarged help must actually render larger');
        await click('[aria-label="Insert image"]');
        await evaluate(() => document.querySelector('.bpb-re-imagebox').scrollIntoView({ block: 'center' }));
        await hover(INPUT);
        await evaluate(() => document.querySelector('.bpb-re-imagebox input').focus());
        if (screenshots) await screenshot(path.join(screenshots,
            `image-help-${kind}-${width}-${theme}-${enlarged ? 'large' : 'normal'}-closed.png`));
        await evaluate(startProbe);
        const shown = () => evaluate(() => !document.querySelector('.bpb-re-image-tooltip').hidden);
        const waitShown = visible => waitForCondition(shown, {
            description: `image tooltip ${visible ? 'open' : 'closed'}`, isReady: value => value === visible,
        });
        await hover(INFO);
        await waitShown(true);
        await hover(TIP);
        assert(await shown(), 'the tooltip must remain readable when hovered');
        const tip = await evaluate(() => {
            const node = document.querySelector('.bpb-re-image-tooltip');
            const { x, y, right, bottom } = node.getBoundingClientRect();
            return { x, y, right, bottom, viewport: window.innerWidth, text: node.textContent,
                height: window.innerHeight, overflow: node.scrollWidth > node.clientWidth,
                hidden: getComputedStyle(node).display === 'none' };
        });
        assert(!tip.hidden && !tip.overflow && tip.x >= 0 && tip.y >= 0
            && tip.right <= tip.viewport && tip.bottom <= tip.height, JSON.stringify(tip));
        assert.match(tip.text, /not in the image URL field/);
        assert.match(tip.text, /only visible with Better Peakbagger installed; other readers see a link/);
        if (screenshots) await screenshot(path.join(screenshots,
            `image-help-${kind}-${width}-${theme}-${enlarged ? 'large' : 'normal'}.png`));
        // The tooltip can intentionally cover the URL row. Move onto a visible
        // control, rather than asking automation to scroll a covered field into
        // view (or hover the tooltip again at that field's coordinates).
        await hover('.bpb-re-format');
        await waitShown(false);
        await hover(INFO);
        await waitShown(true);
        await press('Escape');
        await waitShown(false);
        assert(await evaluate(() => !document.querySelector('.bpb-re-imagebox').hidden),
            'Escape must also dismiss hover-only help without closing insertion');
        await evaluate(() => [...document.querySelectorAll('.bpb-re-image-hosting:last-of-type a')].at(-1).focus());
        await press('Tab');
        await waitShown(true);
        assert(await evaluate(() => document.activeElement?.classList.contains('bpb-re-image-info')));
        await press('Escape');
        await waitShown(false);
        assert(await evaluate(() => !document.querySelector('.bpb-re-imagebox').hidden
            && document.activeElement?.classList.contains('bpb-re-image-info')),
        'Escape must dismiss help while preserving the insertion panel and focus');
        await press('Enter');
        await waitShown(true);
        await press('Enter');
        await waitShown(false);
        await press('Space');
        await waitShown(true);
        await press('Tab');
        await waitShown(false);
        const samples = await evaluate(async () => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const probe = window.__bpbImageHelpProbe;
            probe.running = false;
            return probe.samples;
        });
        assert(samples.length > 2, 'no rendered tooltip transitions were sampled');
        const before = samples[0];
        for (const sample of samples.slice(1)) for (const [name, rect] of Object.entries(before)) {
            for (const [axis, value] of Object.entries(rect)) assert(Math.abs(sample[name][axis] - value) <= 1,
                `image help moved ${name}.${axis}: ${JSON.stringify({ before, sample })}`);
        }
        assert.equal(await evaluate(() => document.getElementById('JournalText').value), '');
        cases++;
    }
    assert.equal(cases, 8, 'image-help matrix must execute every case');
    console.log(JSON.stringify({ kind, version, hidden: true, imageHelpCases: cases,
        viewports: ['1280x900', '375x900'], themes: ['light', 'dark'], text: ['normal', '22px / 16px help'],
        interactions: ['hover', 'focus', 'Enter', 'Space', 'Escape', 'Tab'], stableGeometry: true }));
}
