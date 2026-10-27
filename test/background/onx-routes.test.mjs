// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOnxRoutes } from '../../src/background/onx-routes.js';
import { ONX_IMPORT_URL, ONX_PERMISSION, ONX_ATTEMPTS_KEY, probeOnxImporter } from '../../src/onx/onx-import.js';

const sender = { tab: { id: 7, windowId: 9 }, documentId: 'source-document',
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=42' };
let sequence = 0;
const message = (options = {}) => ({ type: 'ONX_IMPORT_PREPARE', sourceUrl: sender.url,
    filename: 'peakbagger-42.gpx', gpx: '<gpx><wpt lat="1" lon="2"/></gpx>',
    generation: '1', grantToken: 'grant', attemptId: `attempt-${++sequence}`, expiresAt: Date.now() + 1000, ...options });
const harness = () => {
    const records = {};
    const tabs = new Map([[7, { ...sender.tab, url: sender.url }]]);
    const created = [], injections = [], focused = [], consumed = [];
    let nextId = 20;
    const ext = {
        storage: { session: {
            get: async key => ({ [key]: structuredClone(records[key] || {}) }),
            set: async values => { Object.assign(records, structuredClone(values)); },
        } },
        permissions: { request: async p => { assert.deepEqual(p, ONX_PERMISSION); return true; }, contains: async () => true },
        runtime: { getURL: path => `moz-extension://test/${path}` },
        tabs: { create: async details => { created.push(details); const tab = { id: nextId++, windowId: 9, url: details.url, status: 'loading' };
            tabs.set(tab.id, tab); return { ...tab }; },
        get: async id => { if (!tabs.has(id)) throw new Error('closed'); return { ...tabs.get(id) }; },
        update: async (id, patch) => { focused.push([id, patch]); } },
        windows: { update: async () => {} },
        scripting: { executeScript: async details => {
            injections.push(details);
            const args = details.args[0];
            return [{ documentId: 'target-document', result: details.func === probeOnxImporter
                ? { ok: true, code: 'ready', supplied: false, attemptId: args.attemptId, documentNonce: 'nonce' }
                : { ok: true, code: 'prepared', supplied: true, attemptId: args.attemptId, documentNonce: args.documentNonce } }];
        } },
    };
    const options = { ext, isPeakbaggerSender: value => value?.url?.startsWith('https://www.peakbagger.com/'), action: 'onx-import',
        trustedActions: { consumeGrant: async (...args) => { consumed.push(args); return true; }, consumeCapability: async () => true } };
    const restart = () => createOnxRoutes(options);
    return { ext, records, tabs, created, injections, focused, consumed, restart, routes: restart() };
};
const until = async predicate => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
    assert.fail('Expected transaction phase was not reached');
};

test('onX probes immediately without GPX, binds delivery to the ready document and never focuses automatically', async () => {
    const h = harness(), input = message();
    const result = await h.routes.handlers.ONX_IMPORT_PREPARE(input, sender);
    assert.equal(result.ok, true);
    assert.equal(result.targetTabId, 20);
    assert.deepEqual(h.created, [{ url: ONX_IMPORT_URL, active: false, windowId: 9 }]);
    assert.equal(h.injections.length, 2);
    assert.equal(h.injections[0].injectImmediately, true);
    assert.equal(h.injections[0].args[0].gpx, undefined);
    assert.deepEqual(h.injections[1].target, { tabId: 20, documentIds: ['target-document'] });
    assert.equal(h.injections[1].args[0].gpx, input.gpx);
    assert.equal(h.consumed[0][3].oneUse, true);
    assert.deepEqual(h.focused, []);
    assert.ok(!JSON.stringify(h.records).includes(input.gpx), 'GPX never enters session storage');
});

test('onX permission fallback retains its extension-owned setup page', async () => {
    const h = harness(); h.ext.permissions.request = async () => { throw new Error('gesture'); };
    h.ext.permissions.contains = async () => false;
    const result = await h.routes.handlers.ONX_PERMISSION_REQUEST({}, sender);
    assert.equal(result.code, 'permission-setup-opened');
    assert.equal(h.created[0].url, 'moz-extension://test/onx/access.html');
});

test('hidden login URLs become actionable, while a silent redirect can return within the budget', async () => {
    for (const returns of [false, true]) {
        const h = harness(), original = h.ext.tabs.get;
        let reads = 0;
        h.ext.tabs.get = async id => id === 7 ? original(id) : ++reads < (returns ? 3 : Infinity)
            ? { id, windowId: 9, status: 'complete' } : original(id);
        const result = await h.routes.handlers.ONX_IMPORT_PREPARE(message({ expiresAt: Date.now() + (returns ? 600 : 250) }), sender);
        assert.equal(result.ok, returns);
        if (!returns) {
            assert.equal(result.code, 'needs-attention');
            assert.equal(result.canContinue, true);
            assert.equal(h.injections.length, 0);
        }
        assert.deepEqual(h.focused, []);
    }
});

test('provisional blank documents never receive GPX', async () => {
    const h = harness(), original = h.ext.tabs.get; let reads = 0;
    h.ext.tabs.get = async id => id === 7 ? original(id) : ++reads === 1
        ? { id, url: 'about:blank', status: 'complete' } : original(id);
    assert.equal((await h.routes.handlers.ONX_IMPORT_PREPARE(message(), sender)).ok, true);
    assert.equal(reads, 2);
    assert.equal(h.injections.length, 2);
});

test('a hung delivery expires, stays uncertain across restart, and rejects late success', async () => {
    const h = harness(); let finish;
    const execute = h.ext.scripting.executeScript;
    h.ext.scripting.executeScript = details => details.func === probeOnxImporter ? execute(details)
        : new Promise(resolve => { finish = resolve; });
    const input = message({ expiresAt: Date.now() + 200 });
    const pending = h.routes.handlers.ONX_IMPORT_PREPARE(input, sender);
    await until(() => finish);
    assert.equal(h.records[ONX_ATTEMPTS_KEY][input.attemptId].state, 'dispatching');
    const result = await pending;
    assert.equal(result.code, 'handoff-unconfirmed');
    assert.equal(result.canContinue, false);
    finish([{ result: { ok: true, supplied: true, attemptId: input.attemptId, documentNonce: 'nonce' } }]);
    const restarted = h.restart();
    const status = await restarted.handlers.ONX_IMPORT_STATUS(input, sender);
    assert.equal(status.code, 'handoff-unconfirmed');
    assert.equal(h.created.length, 1);
    assert.equal((await restarted.handlers.ONX_IMPORT_PREPARE(message({ resumeAttemptId: input.attemptId }), sender)).supplied, true);
    assert.equal(h.created.length, 1, 'uncertain continuation never opens or injects another tab');
});

test('a queued delivery error never retries with weaker tab targeting', async () => {
    const h = harness(), execute = h.ext.scripting.executeScript;
    h.ext.scripting.executeScript = async details => {
        if (details.func === probeOnxImporter) return execute(details);
        h.injections.push(details); throw new Error('Unsupported or lost acknowledgement');
    };
    const result = await h.routes.handlers.ONX_IMPORT_PREPARE(message(), sender);
    assert.equal(result.code, 'handoff-unconfirmed');
    assert.equal(h.injections.length, 2);
});

test('explicit continuation reuses only an owned untouched importer and rereads fresh payload', async () => {
    const h = harness(), execute = h.ext.scripting.executeScript;
    let available = false;
    h.ext.scripting.executeScript = async details => !available ? [{ result: { attemptId: details.args[0].attemptId,
        ok: false, supplied: false, code: 'not-ready' } }] : execute(details);
    const first = message({ expiresAt: Date.now() + 150 });
    assert.equal((await h.routes.handlers.ONX_IMPORT_PREPARE(first, sender)).canContinue, true);
    available = true;
    const second = message({ resumeAttemptId: first.attemptId, gpx: '<gpx><wpt lat="3" lon="4"/></gpx>' });
    assert.equal((await h.routes.handlers.ONX_IMPORT_PREPARE(second, sender)).ok, true);
    assert.equal(h.created.length, 1);
    assert.equal(h.injections.at(-1).args[0].gpx, second.gpx);
});

test('unknown recovery metadata and mismatched sources fail closed', async () => {
    const h = harness();
    assert.equal((await h.routes.handlers.ONX_IMPORT_PREPARE(message({ filename: 'peakbagger-43.gpx' }), sender)).code, 'forbidden');
    assert.equal(h.consumed.length, 0);
    assert.equal((await h.routes.handlers.ONX_IMPORT_PREPARE(message({ resumeAttemptId: 'missing-attempt' }), sender)).code, 'recovery-unavailable');
    assert.equal(h.created.length, 0);
});

test('source navigation cancels preflight and Open is a separate authorized action', async () => {
    const h = harness(); let release;
    h.ext.scripting.executeScript = () => new Promise(resolve => { release = resolve; });
    const input = message();
    const pending = h.routes.handlers.ONX_IMPORT_PREPARE(input, sender);
    await until(() => release);
    await h.routes.forgetSource(7);
    release([{ result: { ok: true, attemptId: input.attemptId, documentNonce: 'nonce' } }]);
    assert.equal((await pending).supplied, false);
    assert.equal(h.records[ONX_ATTEMPTS_KEY][input.attemptId].result.canContinue, false);
    await h.routes.handlers.ONX_IMPORT_OPEN(input, sender);
    assert.deepEqual(h.focused, [[20, { active: true }]]);
});

test('a navigation race during GPX-free preflight can recover without retrying delivery', async () => {
    const h = harness(), execute = h.ext.scripting.executeScript;
    let probes = 0;
    h.ext.scripting.executeScript = async details => {
        if (details.func === probeOnxImporter && ++probes === 1) throw new Error('Navigation removed host access');
        return execute(details);
    };
    assert.equal((await h.routes.handlers.ONX_IMPORT_PREPARE(message(), sender)).ok, true);
    assert.equal(probes, 2);
    assert.equal(h.injections.filter(item => item.func !== probeOnxImporter).length, 1);
});

test('late tab creation records inspection identity without reviving expired work', async () => {
    const h = harness(), create = h.ext.tabs.create;
    let release;
    h.ext.tabs.create = details => new Promise(resolve => { release = async () => resolve(await create(details)); });
    const input = message({ expiresAt: Date.now() + 150 });
    const result = await h.routes.handlers.ONX_IMPORT_PREPARE(input, sender);
    assert.equal(result.supplied, false);
    await release();
    await until(() => h.records[ONX_ATTEMPTS_KEY][input.attemptId].targetTabId === 20);
    assert.equal(h.injections.length, 0);
    assert.equal(h.records[ONX_ATTEMPTS_KEY][input.attemptId].result.canContinue, false);
});
