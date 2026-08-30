// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { pageSettingsClient as PageSettingsClient } from '../../src/settings/page-settings-client.js';

const createTimers = () => {
    let now = 0;
    let nextId = 1;
    const tasks = new Map();
    return {
        set(callback, delay) {
            const id = nextId++;
            tasks.set(id, { at: now + delay, callback });
            return id;
        },
        clear(id) { tasks.delete(id); },
        advance(duration) {
            const target = now + duration;
            while (true) {
                const due = [...tasks.entries()]
                    .filter(([, task]) => task.at <= target)
                    .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
                if (!due) break;
                const [id, task] = due;
                tasks.delete(id);
                now = task.at;
                task.callback();
            }
            now = target;
        },
        get size() { return tasks.size; }
    };
};

const setup = async () => {
    const dom = new JSDOM('<!doctype html>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1'
    });
    const { window } = dom;
    const timers = createTimers();
    const posted = [];
    const failures = [];
    const notifications = [];
    let snapshotRevision = 0;
    const fallback = { units: 'metric', mapRouteColor: '#2457a7' };
    window.postMessage = message => posted.push(message);
    const client = PageSettingsClient.create({
        fallback,
        ownerWindow: window,
        ownerLocation: window.location,
        readyTimeoutMs: 20,
        writeAckTimeoutMs: 100,
        setTimer: timers.set,
        clearTimer: timers.clear,
    });
    client.onWriteFailed(message => failures.push(message));
    client.subscribe((settings, changed) => notifications.push({
        settings: structuredClone(settings),
        unitsChanged: changed(['units']),
        colorChanged: changed(['mapRouteColor']),
    }));
    const dispatch = data => {
        const revision = data.settings
            ? (data.snapshotRevision ?? ++snapshotRevision)
            : undefined;
        if (Number.isSafeInteger(revision)) snapshotRevision = Math.max(snapshotRevision, revision);
        window.dispatchEvent(new window.MessageEvent('message', {
            source: window,
            origin: window.location.origin,
            data: {
                __bpb: true,
                dir: 'toPage',
                ...data,
                ...(data.settings && {
                    snapshotRevision: revision,
                    throughRequestId: data.throughRequestId
                        ?? (data.kind === 'setResult' ? data.requestId : 0),
                }),
            }
        }));
    };
    const ready = client.init();
    dispatch({ settings: fallback });
    await ready;
    notifications.length = 0;
    return {
        client,
        dispatch,
        dom,
        failures,
        notifications,
        posted,
        timers,
        close() {
            client.dispose();
            dom.window.close();
        }
    };
};

test('pre-init reads and optimistic writes use the cleaned fallback', () => {
    const dom = new JSDOM('<!doctype html>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1'
    });
    const posted = [];
    dom.window.postMessage = message => posted.push(message);
    const client = PageSettingsClient.create({
        fallback: { units: 'spoofed', mapRouteWidth: 999 },
        ownerWindow: dom.window,
        ownerLocation: dom.window.location,
    });

    assert.equal(client.get().units, 'auto');
    assert.equal(client.get().mapRouteWidth, 12);
    client.set({ units: 'still spoofed', theme: 'dark' });
    assert.equal(client.get().units, 'auto');
    assert.equal(client.get().theme, 'dark');
    assert.equal(posted.at(-1).kind, 'set');
    client.dispose();
    dom.window.close();
});

test('a missing settings acknowledgement rolls back, while its late snapshot remains usable', async () => {
    const fixture = await setup();
    const requestId = fixture.client.set({ units: 'imperial' });
    assert.equal(fixture.client.get().units, 'imperial');

    fixture.timers.advance(100);

    assert.equal(fixture.client.get().units, 'metric');
    assert.deepEqual(fixture.failures, ['That setting couldn’t be saved.']);

    fixture.dispatch({
        kind: 'setResult',
        requestId,
        ok: true,
        settings: { units: 'imperial', mapRouteColor: '#2457a7' }
    });
    assert.equal(fixture.client.get().units, 'imperial',
        'a late success snapshot is processed as an ordinary confirmed update');
    fixture.close();
});

test('a newer storage push cannot be overwritten by an older write acknowledgement', async () => {
    const fixture = await setup();
    const requestId = fixture.client.set({ units: 'imperial' });

    fixture.dispatch({
        kind: 'push',
        settings: { units: 'auto', mapRouteColor: '#2457a7' },
        snapshotRevision: 3,
        throughRequestId: 0,
    });
    fixture.dispatch({
        kind: 'setResult',
        requestId,
        ok: true,
        settings: { units: 'imperial', mapRouteColor: '#2457a7' },
        snapshotRevision: 2,
        throughRequestId: requestId,
    });

    assert.equal(fixture.client.get().units, 'auto');
    assert.equal(fixture.timers.size, 0, 'the stale acknowledgement still settles its own request');
    assert.deepEqual(fixture.failures, []);
    assert.deepEqual(fixture.notifications.map(entry => ({
        units: entry.settings.units,
        unitsChanged: entry.unitsChanged,
    })), [{ units: 'auto', unitsChanged: true }]);
    fixture.close();
});

test('a same-write push advances the base while acknowledgements settle ordered requests', async () => {
    const fixture = await setup();
    const unitsId = fixture.client.set({ units: 'imperial' });
    const colorId = fixture.client.set({ mapRouteColor: '#347a3f' });

    fixture.dispatch({
        kind: 'push',
        settings: { units: 'imperial', mapRouteColor: '#2457a7' },
        snapshotRevision: 3,
        throughRequestId: 0,
    });
    assert.equal(fixture.client.get().units, 'imperial');
    assert.equal(fixture.client.get().mapRouteColor, '#347a3f',
        'the request newer than the push boundary remains optimistic');
    assert.equal(fixture.timers.size, 2,
        'an uncorrelated storage event cannot settle either pending request');

    fixture.dispatch({
        kind: 'setResult',
        requestId: unitsId,
        ok: true,
        settings: { units: 'imperial', mapRouteColor: '#2457a7' },
        snapshotRevision: 2,
        throughRequestId: unitsId,
    });
    fixture.dispatch({
        kind: 'setResult',
        requestId: colorId,
        ok: true,
        settings: { units: 'imperial', mapRouteColor: '#347a3f' },
        snapshotRevision: 4,
        throughRequestId: colorId,
    });

    assert.equal(fixture.client.get().units, 'imperial');
    assert.equal(fixture.client.get().mapRouteColor, '#347a3f');
    assert.equal(fixture.timers.size, 0);
    assert.deepEqual(fixture.failures, []);
    fixture.close();
});

test('out-of-order successes and disposal cannot revive an older bridge snapshot', async () => {
    const fixture = await setup();
    const olderId = fixture.client.set({ units: 'imperial' });
    const newerId = fixture.client.set({ units: 'auto' });
    fixture.dispatch({
        kind: 'setResult',
        requestId: newerId,
        ok: true,
        settings: { units: 'auto', mapRouteColor: '#2457a7' },
        snapshotRevision: 3,
        throughRequestId: newerId,
    });
    fixture.dispatch({
        kind: 'setResult',
        requestId: olderId,
        ok: true,
        settings: { units: 'imperial', mapRouteColor: '#2457a7' },
        snapshotRevision: 2,
        throughRequestId: olderId,
    });
    assert.equal(fixture.client.get().units, 'auto');

    fixture.client.dispose();
    fixture.dispatch({
        kind: 'push',
        settings: { units: 'metric', mapRouteColor: '#2457a7' },
        snapshotRevision: 4,
        throughRequestId: newerId,
    });
    assert.equal(fixture.client.get().units, 'auto');
    fixture.dom.window.close();
});

test('an explicit settings failure clears its timer and uses the bridge message once', async () => {
    const fixture = await setup();
    const requestId = fixture.client.set({ units: 'imperial' });
    fixture.dispatch({
        kind: 'setResult',
        requestId,
        ok: false,
        message: 'Settings couldn’t be saved. Try again.'
    });

    assert.equal(fixture.client.get().units, 'metric');
    assert.deepEqual(fixture.failures, ['Settings couldn’t be saved. Try again.']);
    fixture.timers.advance(500);
    assert.deepEqual(fixture.failures, ['Settings couldn’t be saved. Try again.'],
        'the cleared timer cannot report the same failure twice');
    fixture.close();
});

test('an older timeout never reverts a newer optimistic write to the same key', async () => {
    const fixture = await setup();
    fixture.client.set({ units: 'imperial' });
    fixture.timers.advance(50);
    const newerId = fixture.client.set({ units: 'auto' });

    fixture.timers.advance(50);

    assert.equal(fixture.client.get().units, 'auto');
    assert.equal(fixture.failures.length, 1);
    fixture.dispatch({
        kind: 'setResult',
        requestId: newerId,
        ok: true,
        settings: { units: 'auto', mapRouteColor: '#2457a7' }
    });
    fixture.timers.advance(500);
    assert.equal(fixture.client.get().units, 'auto');
    assert.equal(fixture.failures.length, 1);
    fixture.close();
});

test('overlapping writes to different keys reconcile independently', async () => {
    const fixture = await setup();
    const unitsId = fixture.client.set({ units: 'imperial' });
    const colorId = fixture.client.set({ mapRouteColor: '#347a3f' });
    fixture.dispatch({
        kind: 'setResult',
        requestId: unitsId,
        ok: false,
        message: 'Settings couldn’t be saved. Try again.'
    });

    assert.equal(fixture.client.get().units, 'metric');
    assert.equal(fixture.client.get().mapRouteColor, '#347a3f');
    fixture.dispatch({
        kind: 'setResult',
        requestId: colorId,
        ok: true,
        settings: { units: 'metric', mapRouteColor: '#347a3f' }
    });
    fixture.timers.advance(500);
    assert.equal(fixture.client.get().units, 'metric');
    assert.equal(fixture.client.get().mapRouteColor, '#347a3f');
    assert.equal(fixture.failures.length, 1);
    fixture.close();
});

test('a newer success snapshot settles an older lost reply without rolling backward', async () => {
    const fixture = await setup();
    const olderId = fixture.client.set({ units: 'imperial' });
    const newerId = fixture.client.set({ units: 'auto' });
    fixture.dispatch({
        kind: 'setResult',
        requestId: newerId,
        ok: true,
        settings: { units: 'auto', mapRouteColor: '#2457a7' }
    });

    fixture.timers.advance(500);
    assert.equal(fixture.client.get().units, 'auto');
    assert.deepEqual(fixture.failures, []);
    fixture.dispatch({
        kind: 'setResult',
        requestId: olderId,
        ok: false,
        message: 'late failure'
    });
    assert.equal(fixture.client.get().units, 'auto');
    assert.deepEqual(fixture.failures, []);
    fixture.close();
});

test('every bridge snapshot is schema-cleaned before becoming confirmed state', async () => {
    const fixture = await setup();

    fixture.dispatch({
        settings: {
            units: 'spoofed',
            enable3dMap: 'yes',
            mapRouteWidth: 999,
            mapRouteCasingWidth: 1,
        },
    });
    assert.equal(fixture.client.get().units, 'auto');
    assert.equal(fixture.client.get().enable3dMap, false);
    assert.equal(fixture.client.get().mapRouteWidth, 12);
    assert.equal(fixture.client.get().mapRouteCasingWidth, 14);

    const pendingId = fixture.client.set({ units: 'imperial' });
    fixture.dispatch({
        kind: 'setResult',
        requestId: pendingId,
        ok: true,
        settings: { units: 'invalid acknowledgement', mapViewportHeight: 9000 },
    });
    assert.equal(fixture.client.get().units, 'auto');
    assert.equal(fixture.client.get().mapViewportHeight, 720);

    const lateId = fixture.client.set({ units: 'metric' });
    fixture.timers.advance(100);
    fixture.dispatch({
        kind: 'setResult',
        requestId: lateId,
        ok: true,
        settings: { units: 'invalid late acknowledgement', mapRouteColor: 'red' },
    });
    assert.equal(fixture.client.get().units, 'auto');
    assert.equal(fixture.client.get().mapRouteColor, '#d9483b');
    fixture.close();
});
