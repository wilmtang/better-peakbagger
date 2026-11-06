// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { projectRoot } from './browser-verification-fixtures.mjs';

// Native table/host CSS and shipped bundle; storage and icon images are stubbed.
// No live Peakbagger requests, accounts, manifest or worker are exercised here.
export async function verifyAscentFilters(page, origin, variant, { asset, capture }) {
    const fixture = new JSDOM(await readFile(path.join(projectRoot,
        'test/fixtures/peakascents/1039-default-full-columns.html'), 'utf8'));
    const doc = fixture.window.document;
    doc.querySelectorAll('script').forEach(script => script.remove());
    const rows = [...doc.querySelector('table.gray').rows].filter(row => row.cells.length > 1 && row.cells[0].tagName === 'TD');
    const cid = row => Number(new URL(row.cells[0].querySelector('a').href, origin).searchParams.get('cid'));
    const favorite = cid(rows[0]), ignored = cid(rows.find(row => cid(row) !== favorite));
    // A long, filtered-out climber makes content-dependent column shrinkage
    // deterministic without replacing the surrounding native page structure.
    rows.find(row => ![favorite, ignored].includes(cid(row))).cells[0].querySelector('a').textContent = 'A climber with a considerably longer family name';
    doc.querySelector('table.gray').insertAdjacentHTML('afterend', '<p id="filter-following">Following native content</p>');
    const html = fixture.serialize();
    fixture.window.close();
    await page.route('**/*', route => new URL(route.request().url()).pathname === '/climber/PeakAscents.aspx'
        ? route.fulfill({ contentType: 'text/html', body: html })
        : route.request().resourceType() === 'image' ? route.fulfill({ contentType: 'image/svg+xml',
            body: /(?:mewallp|banner|header)/i.test(route.request().url())
                ? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
                : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M2 14 8 2 14 14Z" fill="none" stroke="green"/></svg>' }) : route.abort());
    await page.addInitScript(({ theme, favorite, ignored }) => {
        const entry = cid => ({ cid, name: 'Fixture climber', addedAt: 1, source: 'manual' });
        const data = { bpbFavoriteClimbers: { schemaVersion: 1, entries: [entry(favorite)] },
            bpbIgnoredClimbers: { schemaVersion: 1, revision: 1, entries: [entry(ignored)] } };
        const listeners = new Set();
        globalThis.__clearIgnores = () => {
            data.bpbIgnoredClimbers = { schemaVersion: 1, revision: 2, entries: [] };
            listeners.forEach(listener => listener({ bpbIgnoredClimbers: { newValue: data.bpbIgnoredClimbers } }, 'local'));
        };
        globalThis.chrome = { storage: {
            local: { get: async () => data, set: async values => Object.assign(data, values) },
            sync: { get: async () => ({ bpbSettings: { theme, favoritesSource: 'custom' } }) },
            onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
        }, runtime: { getURL: file => `https://extension.invalid/${file}`, sendMessage: async () => ({ ok: true }) } };
    }, { ...variant, favorite, ignored });
    await page.goto(`${origin}/climber/PeakAscents.aspx?pid=1039`);
    await page.evaluate(theme => { document.documentElement.dataset.bpbTheme = theme; }, variant.theme);
    await page.addScriptTag({ content: (await asset('content/theme.js')).toString() });
    await page.addScriptTag({ content: (await asset('content/ascent-filter.js')).toString() });
    await page.waitForFunction(() => document.querySelector('#pbaf-bar .pbaf-chip[aria-pressed="false"]')
        && document.querySelector('table.gray').style.visibility !== 'hidden');
    // Start at the top: a short filtered list may be smaller than the viewport,
    // where native scroll-range clamping would obscure the toolbar defect.
    const snapshot = () => page.evaluate(() => {
        const box = element => {
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const table = document.querySelector('table.gray');
        const header = [...table.rows].find(row => row.cells[0]?.tagName === 'TH');
        return { bar: box(document.getElementById('pbaf-bar')), heading: box(document.querySelector('h1')),
            chips: [...document.querySelectorAll('.pbaf-chip')].map(box), columns: [...header.cells].map(box),
            table: box(table), following: box(document.getElementById('filter-following')),
            scrollY: window.scrollY, scrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth };
    });
    const stable = async (before, label) => {
        const after = await snapshot();
        for (const [name, previous, current] of [
            ['toolbar', [before.bar], [after.bar]], ['heading', [before.heading], [after.heading]],
            ['filter', before.chips, after.chips], ['column', before.columns, after.columns],
        ]) for (let i = 0; i < previous.length; i++) for (const key of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(previous[i][key] - current[i][key]) <= 1,
                `${label}: ${name} ${i} ${key} jumped ${current[i][key] - previous[i][key]}px`);
        }
        assert.equal(after.scrollY, before.scrollY, `${label}: reading position moved`);
        assert.ok(after.scrollWidth <= Math.max(before.scrollWidth, after.viewport) + 1,
            `${label}: filtering added horizontal overflow to the legacy page`);
        // Filtering deliberately changes list length; following content must
        // follow that height change exactly, with no extra toolbar displacement.
        assert.ok(Math.abs((after.following.y - before.following.y) - (after.table.height - before.table.height)) <= 1,
            `${label}: following native content moved beyond the intended list-height change`);
    };
    await capture(page, `${variant.name}-ascent-filters-idle`);
    const before = await snapshot();
    for (const key of ['fav', 'gps', 'link', 'beta']) {
        const chip = page.locator(`.pbaf-chip[data-filter-key="${key}"]`);
        await chip.evaluate(button => button.focus({ preventScroll: true }));
        for (let cycle = 0; cycle < 2; cycle++) {
            await page.keyboard.press('Enter');
            await page.waitForFunction(key => document.querySelector(`.pbaf-chip[data-filter-key="${key}"]`).getAttribute('aria-pressed') === 'true', key);
            await stable(before, `${key} enabled`);
            assert.equal(await chip.evaluate(button => document.activeElement === button), true, 'filter keeps keyboard focus');
            if (key === 'fav' && cycle === 0) {
                await page.waitForFunction(() => getComputedStyle(document.querySelector('.pbaf-chip[data-filter-key="fav"]')).backgroundColor === 'rgb(47, 107, 63)');
                await capture(page, `${variant.name}-ascent-filters-selected`);
            }
            await page.keyboard.press('Space');
            await page.waitForFunction(key => document.querySelector(`.pbaf-chip[data-filter-key="${key}"]`).getAttribute('aria-pressed') === 'false', key);
            await stable(before, `${key} disabled`);
        }
    }
    const reset = page.locator('.pbaf-reset');
    assert.equal(await reset.isVisible(), false, 'inactive reset must be unpainted');
    assert.equal(await reset.evaluate(button => button.getClientRects().length), 0, 'inactive reset must have no focusable box');
    const note = page.locator('.bpb-report-reveal');
    await note.evaluate(button => button.focus({ preventScroll: true }));
    for (const pressed of ['true', 'false']) {
        await page.keyboard.press('Enter');
        await page.waitForFunction(pressed => document.querySelector('.bpb-report-reveal').getAttribute('aria-pressed') === pressed, pressed);
        await stable(before, `ignored reveal ${pressed}`);
    }
    if (variant.width === 1280 && variant.zoom === 1) {
        await page.setViewportSize({ width: 2048, height: 900 });
        const wide = await snapshot();
        const target = wide.chips[0];
        // Click the same physical point twice: selection must not move the
        // active pointer target, including on the user's wider screenshot size.
        for (const pressed of ['true', 'false']) {
            await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
            await page.waitForFunction(pressed => document.querySelector('.pbaf-chip[data-filter-key="fav"]').getAttribute('aria-pressed') === pressed, pressed);
            await stable(wide, `wide favorite ${pressed}`);
            await capture(page, `${variant.name}-ascent-filters-wide-${pressed}`);
        }
        await page.setViewportSize({ width: variant.width, height: 900 });
    }
    await page.evaluate(() => globalThis.__clearIgnores());
    await page.waitForFunction(() => document.querySelector('.bpb-report-reveal').hidden);
    const noIgnores = await snapshot();
    const favoriteChip = page.locator('.pbaf-chip[data-filter-key="fav"]');
    await favoriteChip.evaluate(button => button.focus({ preventScroll: true }));
    await page.keyboard.press('Enter');
    await stable(noIgnores, 'favorite enabled without ignores');
    await reset.evaluate(button => button.focus({ preventScroll: true }));
    await page.keyboard.press('Enter');
    await stable(noIgnores, 'clear filters without ignores');
    assert.equal(await page.locator('table.gray').evaluate(table => getComputedStyle(table).tableLayout), 'auto',
        'preserve native content-driven table layout');
    if (variant.zoom > 1) {
        // Frame the whole toolbar for visual review at enlarged sizes. This
        // deliberate test-runner scroll occurs after every scroll assertion.
        await favoriteChip.evaluate(button => button.click());
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.pbaf-chip[data-filter-key="fav"]')).backgroundColor === 'rgb(47, 107, 63)');
        await page.locator('#pbaf-bar').evaluate(bar => bar.scrollIntoView({ block: 'start' }));
        await capture(page, `${variant.name}-ascent-filters-enlarged`);
    }
}
