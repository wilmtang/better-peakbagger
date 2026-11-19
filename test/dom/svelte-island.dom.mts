/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// M5: a compiled Svelte island mounts, updates, suspends, resumes, disposes and
// re-mounts through src/ui/svelte-island.ts beside legacy DOM, in real Chromium
// and Firefox. The bundle is test-only, built with the production (minified)
// WXT backend; nothing here ships. Run with
// `npm run verify -- dom`.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWxtBundles } from '../../scripts/wxt-build.mts';
import { defineDomSuite, type DomContext } from '../../scripts/dom-tier.mts';
import type { IslandFixture } from '../fixtures/svelte/valid/island-entry.ts';

let bundle: Promise<string> | null = null;
const islandBundle = () => bundle ??= (async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'bpb-svelte-island-'));
    try {
        const entry = { out: 'island.js', sources: ['../test/fixtures/svelte/valid/island-entry.ts'] };
        await buildWxtBundles({ entries: [entry], minify: true, outputDir, manifestPath: null });
        return await readFile(path.join(outputDir, 'island.js'), 'utf8');
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
})();

// Legacy markup owned by a plain controller. Its listener and node identity
// must survive the island's whole lifetime.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Island fixture</title></head><body>
<main id="settings">
  <section id="legacy-before"><button id="legacy-button" type="button">Legacy action</button></section>
  <div id="host"><p id="legacy-sibling">Legacy row after the island</p></div>
</main>
<script>
  window.__legacyClicks = 0;
  document.getElementById('legacy-button').addEventListener('click', () => { window.__legacyClicks++; });
  document.getElementById('legacy-sibling').dataset.identity = 'original';
</script>
<script src="/fixture/island.js"></script>
</body></html>`;

type FixtureWindow = { __bpbIslandFixture: IslandFixture; __legacyClicks: number };

const openIsland = async (context: DomContext) => {
    await context.route('/fixture/island.js', await islandBundle(), 'text/javascript');
    await context.route('/fixture/settings.html', PAGE);
    await context.open('/fixture/settings.html');
    await context.page.waitForFunction(() => '__bpbIslandFixture' in globalThis);
};

// Calls the page's fixture API (test/fixtures/svelte/valid/island-entry.ts).
const call = (page: DomContext['page'], expression: string) => page.evaluate(`globalThis.__bpbIslandFixture.${expression}`);
const islandState = (page: DomContext['page']) => call(page, 'state');

const legacyIntact = async (page: DomContext['page']) => {
    const before = await page.evaluate(() => (globalThis as unknown as FixtureWindow).__legacyClicks);
    await page.locator('#legacy-button').click();
    return page.evaluate(expected => ({
        clicked: (globalThis as unknown as FixtureWindow).__legacyClicks === expected,
        sibling: document.getElementById('legacy-sibling')?.dataset.identity === 'original',
        order: [...document.getElementById('host')!.children].map(node => node.id || node.classList[0]),
    }), before + 1);
};

export default defineDomSuite({
    name: 'svelte island',
    cases: [{
        name: 'mounts beside legacy DOM, saves allowlisted plain patches from $state, and survives suspend, resume, removal and re-enable',
        async run(context) {
            await openIsland(context);
            const { page } = context;
            await call(page, 'mount(\'#host\', { units: \'metric\', windUnits: \'imperial\', theme: \'dark\' }, \'#legacy-sibling\')');
            const island = page.locator('#host .bpb-units-island');
            await island.waitFor();
            assert.equal(await island.locator('select').inputValue(), 'metric');
            assert.equal(await island.locator('output').textContent(), '1 custom');
            assert.equal(await island.evaluate(node => getComputedStyle(node).display), 'flex', 'the component injected its scoped styles');
            assert.deepEqual(await legacyIntact(page), { clicked: true, sibling: true, order: ['bpb-units-island', 'legacy-sibling'] },
                'the island sits before the legacy row and legacy behavior is untouched');

            // A trusted edit inside the compiled component saves through the M4 patch builder.
            await island.locator('select').selectOption('imperial');
            await page.waitForFunction(() => (globalThis as unknown as FixtureWindow).__bpbIslandFixture.saves.length === 1);
            const [save] = await call(page, 'saves') as IslandFixture['saves'];
            // The component hands its whole draft (nested $state, including an
            // unapproved `history` object) to the M4 builder.
            const expected = { units: 'imperial', distanceUnits: 'default', elevationUnits: 'default',
                temperatureUnits: 'default', precipitationUnits: 'default', windUnits: 'imperial' };
            assert.deepEqual(save, { patch: expected, frozen: true, plainPrototype: true, cloned: expected, draftCloneError: 'DataCloneError' },
                'the $state draft itself cannot be cloned, but the patch built from it is frozen plain data with only allowlisted keys');

            // Controller-driven updates re-render the island.
            await call(page, 'update({ units: \'auto\', windUnits: \'metric\', precipitationUnits: \'imperial\' })');
            assert.equal(await island.locator('select').inputValue(), 'auto');
            assert.equal(await island.locator('output').textContent(), '2 custom');

            // A persisted pagehide (BFCache) suspends: updates are held until pageshow.
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
            assert.equal(await islandState(page), 'suspended');
            await call(page, 'update({ units: \'metric\', windUnits: \'default\', precipitationUnits: \'default\' })');
            assert.equal(await island.locator('select').inputValue(), 'auto', 'a suspended island does not render');
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
            assert.equal(await islandState(page), 'active');
            assert.equal(await island.locator('select').inputValue(), 'metric', 'resumption applies the held update');
            assert.equal(await island.locator('output').textContent(), '0 custom');

            // A final pagehide disposes: only the island's DOM is removed, and later updates are ignored.
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
            assert.equal(await islandState(page), 'disposed');
            await page.waitForFunction(() => !document.querySelector('#host .bpb-units-island'));
            await call(page, 'update({ units: \'imperial\' })');
            assert.equal(await page.locator('.bpb-units-island').count(), 0);
            const afterDispose = await legacyIntact(page);
            assert.deepEqual(afterDispose, { clicked: true, sibling: true, order: ['legacy-sibling'] });

            // Re-enabling the feature mounts a fresh island in the same host.
            await call(page, 'mount(\'#host\', { units: \'imperial\' })');
            await page.locator('#host .bpb-units-island').waitFor();
            assert.equal(await page.locator('.bpb-units-island').count(), 1);
            await page.locator('#host .bpb-units-island select').selectOption('metric');
            await page.waitForFunction(() => (globalThis as unknown as FixtureWindow).__bpbIslandFixture.saves.length === 2);
            assert.equal((await call(page, 'saves') as IslandFixture['saves'])[1]!.patch.units, 'metric');
            assert.equal(await islandState(page), 'active');
            assert.deepEqual(await legacyIntact(page), { clicked: true, sibling: true, order: ['legacy-sibling', 'bpb-units-island'] });

            // Disabling the feature disposes directly, without a page transition.
            await call(page, 'dispose()');
            assert.equal(await islandState(page), 'disposed');
            await page.waitForFunction(() => !document.querySelector('#host .bpb-units-island'));
            assert.deepEqual(await legacyIntact(page), { clicked: true, sibling: true, order: ['legacy-sibling'] });

            // A component whose first effect throws leaves nothing behind: the
            // caller gets the error and the half-mounted DOM is removed.
            assert.equal(await call(page, 'mountFailing(\'#host\')'), 'fixture effect failed');
            await page.waitForFunction(() => !document.querySelector('.bpb-failing-island'));
            assert.deepEqual(await legacyIntact(page), { clicked: true, sibling: true, order: ['legacy-sibling'] });

            // The runtime recovers: a later island mounts and updates normally.
            await call(page, 'mount(\'#host\', { units: \'metric\' })');
            await page.locator('#host .bpb-units-island').waitFor();
            await call(page, 'update({ units: \'imperial\' })');
            assert.equal(await page.locator('#host .bpb-units-island select').inputValue(), 'imperial');
            assert.equal(await islandState(page), 'active');
        },
    }],
});
