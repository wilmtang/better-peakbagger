// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Peakbagger serves ascent forms on both hosts, but local GPX processing makes
// its account and summit requests through the page helper, which serves only
// the canonical www origin. A bare-host form must say so up front.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../../dist/background.js', import.meta.url), 'utf8');
type Listener = (message: Record<string, unknown>, sender: Record<string, unknown>, respond: (value: unknown) => void) => unknown;

const bootWorker = () => {
    let listener: Listener | null = null;
    const session: Record<string, unknown> = {};
    const context = vm.createContext({
        console, Math, Date, URL, URLSearchParams, structuredClone, btoa, setTimeout, clearTimeout, AbortController,
        fetch: async () => ({ ok: true, text: async () => '' }),
    }) as Record<string, unknown>;
    context.globalThis = context;
    context.self = context;
    context.chrome = {
        storage: {
            sync: { get: async () => ({}) },
            session: {
                get: async (key: string | null) => key === null ? structuredClone(session) : { [key]: structuredClone(session[key]) },
                set: async (patch: Record<string, unknown>) => { Object.assign(session, structuredClone(patch)); },
                remove: async () => {},
            },
            local: { get: async () => ({}), set: async () => {} },
            onChanged: { addListener: () => {} },
        },
        runtime: { id: 'test-extension', getURL: (resource: string) => `chrome-extension://test-extension/${resource}`,
            onMessage: { addListener: (callback: Listener) => { listener = callback; } } },
        tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onActivated: { addListener: () => {} } },
        scripting: { executeScript: async () => [] },
        action: {},
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    };
    vm.runInContext(bundle, context, { filename: 'dist/background.js' });
    return (message: Record<string, unknown>, sender: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => {
        const value = listener!(message, sender, response => resolve(response as Record<string, unknown>));
        if (value !== true && value !== undefined) void Promise.resolve(value).then(response => resolve(response as Record<string, unknown>));
    });
};

const selection = { pageSessionId: 'page-session-1', selectionGeneration: 1, selectionNonce: 'selection-1' };
const senderFor = (origin: string) => ({ id: 'test-extension', frameId: 0, tab: { id: 5, windowId: 9 },
    url: `${origin}/climber/ascentedit.aspx?pid=7&cid=77` });

test('a bare-host ascent form is told to use www before any Peakbagger request', async () => {
    const send = bootWorker();
    const reply = await send({ type: 'GPX_PROCESS_START', segments: [], waypoints: [], ...selection }, senderFor('https://peakbagger.com'));
    assert.equal((reply.error as { code?: string })?.code, 'peakbagger-host');
    assert.match(String((reply.error as { message?: string })?.message), /www\.peakbagger\.com/);
});

test('a www ascent form is not refused for its host', async () => {
    const send = bootWorker();
    const reply = await send({ type: 'GPX_PROCESS_START', segments: [], waypoints: [], ...selection }, senderFor('https://www.peakbagger.com'));
    assert.notEqual((reply.error as { code?: string })?.code, 'peakbagger-host');
});
