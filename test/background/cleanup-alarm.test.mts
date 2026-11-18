// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An MV3 worker restarts often. Re-creating a same-named alarm replaces it and
// restarts its period, so creating the cleanup alarm on every start would keep
// postponing the expiry PRIVACY.md promises every five minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../../dist/background.js', import.meta.url), 'utf8');
type Alarm = { name: string; periodInMinutes?: number };

const boot = (alarms: Map<string, Alarm>, creates: Alarm[]) => {
    const context = vm.createContext({
        console, Math, Date, URL, URLSearchParams, structuredClone, btoa, setTimeout, clearTimeout,
        fetch: async () => ({ ok: true, text: async () => '' }),
    }) as Record<string, unknown>;
    context.globalThis = context;
    context.self = context;
    context.chrome = {
        storage: {
            sync: { get: async () => ({}) },
            session: { get: async () => ({}), set: async () => {} },
            local: { get: async () => ({}), set: async () => {} },
            onChanged: { addListener: () => {} },
        },
        runtime: { getURL: (resource: string) => `chrome-extension://test-extension/${resource}`, onMessage: { addListener: () => {} } },
        tabs: { onRemoved: { addListener: () => {} } },
        action: {},
        alarms: {
            get: async (name: string) => alarms.get(name),
            create: (name: string, info: { periodInMinutes?: number }) => {
                const alarm = { name, ...info }; alarms.set(name, alarm); creates.push(alarm);
            },
            onAlarm: { addListener: () => {} },
        },
    };
    vm.runInContext(bundle, context, { filename: 'dist/background.js' });
};
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const cleanupCreates = (creates: Alarm[]) => creates.filter(alarm => alarm.name === 'bpb-capture-cleanup');

test('the capture cleanup alarm is created once and survives worker restarts', async () => {
    const alarms = new Map<string, Alarm>(), creates: Alarm[] = [];
    boot(alarms, creates); await settle();
    assert.deepEqual(cleanupCreates(creates).map(alarm => alarm.periodInMinutes), [5]);
    boot(alarms, creates); await settle();
    boot(alarms, creates); await settle();
    assert.equal(cleanupCreates(creates).length, 1, 'a restart must not restart the five-minute period');
});

test('a cleanup alarm with a different period is replaced', async () => {
    const alarms = new Map<string, Alarm>([['bpb-capture-cleanup', { name: 'bpb-capture-cleanup', periodInMinutes: 60 }]]);
    const creates: Alarm[] = [];
    boot(alarms, creates); await settle();
    assert.deepEqual(cleanupCreates(creates).map(alarm => alarm.periodInMinutes), [5]);
});
