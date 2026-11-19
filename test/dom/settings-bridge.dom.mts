// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite, type DomContext } from '../../scripts/dom-tier.mts';
import type { SettingsData } from '../../src/settings/settings.ts';
import { openSourceModule } from './source-module.mts';

interface BridgeReply {
    __bpb: true;
    dir: 'toPage';
    kind?: 'setResult' | 'push';
    requestId?: number | null;
    ok?: boolean;
    message?: string;
    settings?: SettingsData;
    snapshotRevision?: number;
    throughRequestId?: number;
}

declare global {
    interface Window {
        __bpbBridgeReplies: BridgeReply[];
    }
}

async function loadBridge(context: DomContext, { failSet = false, holdUntilPush = false } = {}) {
    const modulePath = await openSourceModule(context, {
        source: new URL('../../src/settings/settings.ts', import.meta.url),
        pagePath: '/climber/ascent.aspx',
        html: '<!doctype html><title>Ascent settings bridge</title>',
    });
    await context.page.evaluate(async ({ url, fail, hold }) => {
        const { createSettingsStore, STORAGE_KEY } = await import(url) as typeof import('../../src/settings/settings.ts');
        await chrome.storage.sync.remove(STORAGE_KEY);
        if (fail) Object.assign(chrome.storage.sync, {
            async set() { throw new Error('sync storage unavailable'); },
        });
        const store = createSettingsStore({ sendMessage: null });
        let releaseWrite: (() => void) | undefined;
        const changedUnitsPush = hold ? new Promise<void>(resolve => { releaseWrite = resolve; }) : undefined;

        window.__bpbBridgeReplies = [];
        window.addEventListener('message', (event: MessageEvent<BridgeReply>) => {
            const data = event.data;
            if (event.source !== window || event.origin !== location.origin || data?.__bpb !== true || data.dir !== 'toPage') return;
            window.__bpbBridgeReplies.push(data);
            if (data.kind === 'push' && data.settings?.distanceUnits === 'imperial') releaseWrite?.();
        });
        Object.assign(chrome.runtime, {
            async sendMessage(message: { type?: string; patch?: unknown; onlyIfUnset?: boolean }) {
                if (message?.type !== 'SETTINGS_PATCH') throw new Error('Unexpected settings worker request');
                const settings = await store.applyPatch(message.patch, { onlyIfUnset: message.onlyIfUnset === true });
                // The ordering case delivers a storage event before its worker acknowledgement.
                if (changedUnitsPush) await changedUnitsPush;
                return { ok: true, settings };
            },
        });
    }, { url: modulePath, fail: failSet, hold: holdUntilPush });
    await context.inject('content/ascent-bridge.js');
}

type Page = DomContext['page'];

const readSettings = (page: Page) => page.evaluate(async () => {
    const { bpbSettings } = await chrome.storage.sync.get('bpbSettings');
    return bpbSettings as Record<string, unknown> | undefined;
});

async function sendPatch(page: Page, patch: Record<string, unknown>, requestId = 1) {
    await page.evaluate(args => window.postMessage({ __bpb: true, dir: 'toCS', kind: 'set', ...args }, location.origin),
        { patch, requestId });
    const result = await page.waitForFunction(id =>
        window.__bpbBridgeReplies.find(message => message.kind === 'setResult' && message.requestId === id), requestId);
    try {
        const reply = await result.jsonValue();
        assert.ok(reply);
        return reply;
    } finally {
        await result.dispose();
    }
}

export default defineDomSuite({
    name: 'ascent settings bridge',
    cases: [{
        name: 'writes only analyzer-owned settings keys',
        async run(context) {
            await loadBridge(context);
            const { page } = context;
            await sendPatch(page, {
                units: 'metric',
                mapRouteColor: '#123abc',
                enable3dMap: true,
                showSnotel: false,
                theme: 'dark',
                retainWaypoints: false,
                removeGpxTimestamps: true,
                fillAscentDetails: false,
            });
            const stored = await readSettings(page);
            assert.ok(stored);
            assert.equal(stored.units, 'auto', 'the chart shortcut cannot change the global default');
            assert.equal(stored.distanceUnits, 'metric');
            assert.equal(stored.elevationUnits, 'metric');
            assert.equal(stored.mapRouteColor, '#123abc');
            assert.equal(stored.enable3dMap, false, 'page-world writes must not flip extension feature gates');
            assert.equal(stored.showSnotel, true, 'page-world writes cannot change the SNOTEL gate');
            assert.equal(stored.theme, 'system', 'page-world writes must not change the theme');
            assert.equal(stored.removeGpxTimestamps, false, 'page-world writes cannot change timestamp privacy');
            assert.equal(stored.retainWaypoints, true, 'page-world writes cannot change capture privacy options');
            assert.equal(stored.fillAscentDetails, true, 'page-world writes cannot change capture autofill options');
        },
    }, {
        name: 'chart units cannot write defaults, weather overrides or arbitrary nested settings',
        async run(context) {
            await loadBridge(context);
            const { page } = context;
            await page.evaluate(() => chrome.storage.sync.set({ bpbSettings: {
                units: 'metric', temperatureUnits: 'imperial', precipitationUnits: 'metric', windUnits: 'metric',
            } }));
            await sendPatch(page, { units: 'imperial', temperatureUnits: 'metric', precipitationUnits: 'imperial', windUnits: 'imperial' });
            const stored = await readSettings(page);
            assert.ok(stored);
            assert.equal(stored.distanceUnits, 'imperial');
            assert.equal(stored.units, 'metric');
            assert.equal(stored.temperatureUnits, 'imperial');
            assert.equal(stored.precipitationUnits, 'metric');
            assert.equal(stored.windUnits, 'metric');
            const before = JSON.stringify(stored);
            const reply = await sendPatch(page, { units: { temperatureUnits: 'metric', units: 'imperial' } }, 2);
            assert.equal(reply.ok, false);
            assert.equal(JSON.stringify(await readSettings(page)), before);
        },
    }, {
        name: 'snapshots carry transport-only monotonic ordering metadata',
        async run(context) {
            await loadBridge(context, { holdUntilPush: true });
            const { page } = context;
            const acknowledgement = await sendPatch(page, { units: 'imperial' }, 11);
            const push = await page.evaluate(() => window.__bpbBridgeReplies.find(message =>
                message.kind === 'push' && message.settings?.distanceUnits === 'imperial'));
            assert.ok(typeof push?.snapshotRevision === 'number' && typeof acknowledgement.snapshotRevision === 'number');
            assert.ok(push.snapshotRevision > acknowledgement.snapshotRevision,
                'the storage push observed during the write is newer than its delayed acknowledgement');
            assert.equal(push.throughRequestId, 0,
                'a storage event must not claim it includes an unrelated pending page write');
            assert.equal(acknowledgement.throughRequestId, 11);
            const stored = await readSettings(page);
            assert.ok(stored);
            assert.equal('snapshotRevision' in stored, false, 'transport metadata must never enter the settings record');
            assert.equal('throughRequestId' in stored, false);
        },
    }, {
        name: 'a patch containing no writable keys is refused with a reply',
        async run(context) {
            await loadBridge(context);
            const { page } = context;
            const result = await sendPatch(page, { enable3dMap: true, fillAscentDetails: false, fillTripInfo: false }, 7);
            assert.equal(await readSettings(page), undefined, 'nothing reached storage');
            assert.equal(result.requestId, 7);
            assert.equal(result.ok, false);
            assert.ok(result.message && !/try again/i.test(result.message),
                'a refusal does not invite a retry that would be refused identically');
        },
    }, {
        name: 'a failed settings write tells the page to roll back its optimistic patch',
        async run(context) {
            await loadBridge(context, { failSet: true });
            const { page } = context;
            const result = await sendPatch(page, { units: 'metric' }, 17);
            assert.deepEqual(result, {
                __bpb: true,
                dir: 'toPage',
                kind: 'setResult',
                requestId: 17,
                ok: false,
                message: 'Settings couldn’t be saved. Try again.',
            });
            assert.equal(await readSettings(page), undefined);
        },
    }],
});
