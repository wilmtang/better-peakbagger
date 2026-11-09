/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { JSDOM } from '../helpers/test-dom.mts';
import { installTerrainFrameCreation, readTerrainFrameCreation, stopTerrainFrameCreation,
    observeTerrainFrameCreation } from '../../scripts/terrain-frame-creation.mts';

const frameUrl = 'chrome-extension://fixture-id/terrain/terrain.html';
function fixture() {
    const dom = new JSDOM('<div id="bpb-map-viewport"></div><div id="other"></div>',
        { url: 'https://www.peakbagger.com/map/BigMap.aspx', runScripts: 'outside-only' });
    const win = dom.window;
    const invoke = (fn: { toString(): string }, ...args: unknown[]) => win.eval(`(${fn.toString()})(...${JSON.stringify(args)})`);
    const add = (url = frameUrl, parent = win.document.getElementById('bpb-map-viewport')!, tag = 'iframe') => {
        const node = win.document.createElement(tag);
        node.id = 'bpb-terrain-frame'; node.setAttribute('src', url); parent.append(node);
        return node;
    };
    invoke(installTerrainFrameCreation, frameUrl);
    return { dom, win, add, invoke, read: () => invoke(readTerrainFrameCreation) };
}
const mutations = () => new Promise<void>(resolve => setImmediate(resolve));

test('prearmed creation observation survives insertion and removal before the later selector check', async () => {
    const env = fixture();
    try {
        env.add().remove();
        await mutations();
        assert.equal(env.win.document.querySelector('#bpb-terrain-frame'), null,
            'the historical late selector has no attached frame to observe');
        assert.equal(env.read(), true, 'actual bridge insertion remains recorded after removal');
    } finally { env.dom.window.close(); }
});

test('init without a frame, wrong origins/paths, wrong nodes and other mounts cannot satisfy bridge creation', async () => {
    for (const insert of [
        (env: ReturnType<typeof fixture>) => env.win.postMessage({ __bpbTerrain: true, type: 'init' }, '*'),
        (env: ReturnType<typeof fixture>) => env.add('https://fixture-id/terrain/terrain.html'),
        (env: ReturnType<typeof fixture>) => env.add('chrome-extension://another-id/terrain/terrain.html'),
        (env: ReturnType<typeof fixture>) => env.add(`${frameUrl}?forged=1`),
        (env: ReturnType<typeof fixture>) => env.add(frameUrl, env.win.document.getElementById('other')!),
        (env: ReturnType<typeof fixture>) => env.add(frameUrl, undefined, 'div'),
        (env: ReturnType<typeof fixture>) => {
            const mount = env.win.document.getElementById('bpb-map-viewport')!;
            mount.remove(); env.add(frameUrl, mount);
        },
    ]) {
        const env = fixture();
        try { insert(env); await mutations(); assert.equal(env.read(), false); }
        finally { env.dom.window.close(); }
    }
});

test('cleanup failure preserves an action error and fails an otherwise successful observation', async () => {
    for (const actionFails of [false, true]) {
        const page = {
            evaluate: async (fn: { name: string }) => {
                if (fn.name === 'stopTerrainFrameCreation') throw new Error('fixture cleanup failed');
            },
            waitForFunction: async () => true,
        } as unknown as Page;
        await assert.rejects(observeTerrainFrameCreation(page, frameUrl, async () => {
            if (actionFails) throw new Error('original gesture failed'); return 'init';
        }), (error: unknown) => {
            if (actionFails) {
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(error.errors.map((item: Error) => item.message), ['original gesture failed', 'fixture cleanup failed']);
            } else assert.match((error as Error).message, /fixture cleanup failed/);
            return true;
        });
    }
});

test('stopping observation removes the fixture state and prevents later insertion from satisfying it', async () => {
    const env = fixture();
    try {
        env.invoke(stopTerrainFrameCreation);
        env.add(); await mutations();
        assert.equal(env.read(), false);
        assert.equal(env.win.__bpbTerrainFrameCreation, undefined);
    } finally { env.dom.window.close(); }
});

test('wrapper arms before action, preserves the three-second bound and always stops on timeout or action failure', async () => {
    for (const failure of ['timeout', 'action']) {
        const calls: string[] = [];
        const page = {
            evaluate: async (fn: { name: string }) => { calls.push(fn.name); },
            waitForFunction: async (_fn: unknown, _argument: unknown, options: { timeout: number }) => {
                calls.push('wait'); assert.equal(options.timeout, 3000); throw new Error('fixture timeout');
            },
        } as unknown as Page;
        const operation = observeTerrainFrameCreation(page, frameUrl, async () => {
            calls.push('action'); if (failure === 'action') throw new Error('gesture failed'); return 'init';
        });
        if (failure === 'action') await assert.rejects(operation, /gesture failed/);
        else assert.deepEqual(await operation, { value: 'init', created: false });
        assert.deepEqual(calls, ['installTerrainFrameCreation', 'action',
            ...(failure === 'timeout' ? ['wait'] : []), 'stopTerrainFrameCreation']);
    }
});
