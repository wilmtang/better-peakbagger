// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Showcase fixtures run in real pages with the production bundles they load.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { createSettingsStore } from '../../src/settings/settings.ts';
import { createPageSettingsClient } from '../../src/settings/page-settings-client.ts';
import { instrumentTerrainFrameHtml } from '../../scripts/terrain-frame-instrumentation.mts';
import type { CreateSettingsStoreOptions } from '../../src/settings/settings.ts';

type Area = NonNullable<CreateSettingsStoreOptions['area']>;
// The chrome stub the showcase and terrain fixtures install on their pages.
interface Fixture { storage: { sync: { get(): Promise<{ bpbSettings: { mapViewportWidth: number } }> } & Area; local: Area } }

const gpxShowcase = await readFile(new URL('../../scripts/showcase/gpx.html', import.meta.url), 'utf8');
const terrainShowcase = await readFile(new URL('../../scripts/showcase/terrain.html', import.meta.url), 'utf8');

test('analyzer showcases deliver settings and writes through the production revisioned bridge', { timeout: 5000 }, async t => {
    const bridge = await readFile(new URL('../../dist/content/ascent-bridge.js', import.meta.url), 'utf8');
    const activation = await readFile(new URL('../../scripts/showcase/terrain-activation-fixture.js', import.meta.url), 'utf8');
    for (const [name, source, expected] of [
        ['terrain', terrainShowcase, { theme: 'dark', mapViewportWidth: 800 }],
        ['gpx', gpxShowcase, { theme: 'light' }],
    ] as [string, string, Record<string, unknown>][]) {
        assert.match(source, /src="\/dist\/content\/ascent-bridge\.js"/);
        assert.doesNotMatch(source, /dir:\s*'toPage'/, 'fixtures must not duplicate the settings protocol');
        const dom = new FixtureDom(source, { url: 'https://www.peakbagger.com/climber/ascent.aspx?theme=dark&map=wide' });
        t.after(() => dom.window.close());
        const { window } = dom;
        // In production the settings client runs in the page, so its messages
        // carry the page as their source; post through a page-realm function.
        window.postMessage = window.eval('(post => (data, origin) => post.call(window, data, origin))(window.postMessage)') as typeof window.postMessage;
        window.eval(window.document.querySelector('script:not([src])').textContent);
        if (name === 'terrain') window.eval(activation);
        window.eval(bridge);
        const client = createPageSettingsClient({ ownerWindow: window, ownerLocation: window.location });
        t.after(() => client.dispose());
        const settings = await client.init();
        for (const [key, value] of Object.entries(expected)) assert.equal((settings as Record<string, unknown>)[key], value, `${name}: ${key}`);
        const reconciled = new Promise<void>(resolve => window.addEventListener('message', event => {
            if (event.data.kind === 'setResult' && event.data.ok) resolve();
        }));
        client.set({ mapViewportWidth: 620 });
        await reconciled;
        assert.equal((await (window.chrome as Fixture).storage.sync.get()).bpbSettings.mapViewportWidth, 620);
        const failures: unknown[] = [];
        client.onWriteFailed(message => failures.push(message));
        client.set({ theme: 'system' });
        // The bridge answers through a real, asynchronous postMessage.
        for (let turn = 0; turn < 200 && !failures.length; turn++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(client.get().theme, expected.theme, 'production allowlist still owns theme writes');
        assert.equal(failures.length, 1);
    }
});

test('terrain fixture supplies both storage areas for the strict frame feature gate', async () => {
    const dom = new FixtureDom(instrumentTerrainFrameHtml('<html><head></head><body></body></html>'), {
        url: 'https://www.peakbagger.com/dist/terrain/terrain.html', runScripts: 'dangerously' });
    try {
        const api = dom.window.chrome as Fixture;
        const store = createSettingsStore({ area: api.storage.sync, localArea: api.storage.local, sendMessage: null });
        assert.equal((await store.requireCurrent()).enable3dMap, true);
        const missingLocal = createSettingsStore({ area: api.storage.sync, localArea: null, sendMessage: null });
        await assert.rejects(missingLocal.requireCurrent(), /could not|unavailable/i);
    } finally { dom.window.close(); }
});
