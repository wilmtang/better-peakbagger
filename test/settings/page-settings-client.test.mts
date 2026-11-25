// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { pageSettingsClient as PageSettingsClient, type PageSettingsValues } from '../../src/settings/page-settings-client.ts';

const ownerLocation = new URL('https://www.peakbagger.com/climber/ascent.aspx?aid=1');

interface BridgeFixtureMessage {
    kind?: 'push' | 'setResult';
    requestId?: number | null;
    ok?: boolean;
    message?: string;
    settings?: Record<string, unknown>;
    snapshotRevision?: number;
    throughRequestId?: number | null;
}

function createTransport(t: TestContext) {
    // Use the same port as the listener owner and the native event's source.
    const { port1, port2 } = new MessageChannel();
    let dispose: (() => void) | undefined;
    t.after(() => {
        try { dispose?.(); }
        finally {
            port1.close();
            port2.close();
        }
    });
    const posted: Record<string, unknown>[] = [];
    const ownerWindow = Object.assign(port1, {
        postMessage(message: unknown) {
            assert.ok(message && typeof message === 'object');
            posted.push(message as Record<string, unknown>);
        },
    });
    return { ownerWindow, posted, onClose(cleanup: () => void) { dispose = cleanup; } };
}

const createTimers = () => {
    let now = 0;
    let nextId = 1;
    const tasks = new Map<number, { at: number; callback: () => void }>();
    return {
        set(callback: () => void, delay: number) {
            const id = nextId++;
            tasks.set(id, { at: now + delay, callback });
            return id;
        },
        clear(id: number) { tasks.delete(id); },
        advance(duration: number) {
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

const setup = async (t: TestContext) => {
    const transport = createTransport(t);
    const { ownerWindow, posted } = transport;
    const timers = createTimers();
    const failures: string[] = [];
    const notifications: { settings: PageSettingsValues; unitsChanged: boolean; colorChanged: boolean }[] = [];
    let snapshotRevision = 0;
    const fallback = { units: 'metric', mapRouteColor: '#2457a7' };
    const client = PageSettingsClient.create({
        fallback,
        ownerWindow,
        ownerLocation,
        readyTimeoutMs: 20,
        writeAckTimeoutMs: 100,
        setTimer: timers.set,
        clearTimer: timers.clear,
    });
    transport.onClose(client.dispose);
    client.onWriteFailed(message => failures.push(message));
    client.subscribe((settings, changed) => notifications.push({
        settings: structuredClone(settings),
        unitsChanged: changed(['units']),
        colorChanged: changed(['mapRouteColor']),
    }));
    const dispatch = (data: BridgeFixtureMessage) => {
        const revision = data.settings
            ? (data.snapshotRevision ?? ++snapshotRevision)
            : undefined;
        if (revision !== undefined && Number.isSafeInteger(revision)) snapshotRevision = Math.max(snapshotRevision, revision);
        ownerWindow.dispatchEvent(new MessageEvent('message', {
            source: ownerWindow,
            origin: ownerLocation.origin,
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
        failures,
        notifications,
        posted,
        timers,
    };
};

test('pre-init reads and optimistic writes use the cleaned fallback', t => {
    const { ownerWindow, posted, onClose } = createTransport(t);
    const client = PageSettingsClient.create({
        fallback: { units: 'spoofed', mapRouteWidth: 999 },
        ownerWindow,
        ownerLocation,
    });
    onClose(client.dispose);

    assert.equal(client.get().units, 'auto');
    assert.equal(client.get().mapRouteWidth, 12);
    client.set({ units: 'still spoofed', theme: 'dark' });
    assert.equal(client.get().units, 'auto');
    assert.equal(client.get().theme, 'dark');
    assert.equal(posted.at(-1)?.kind, 'set');
});

test('refresh requests an authoritative snapshot until the client is disposed', async t => {
    const fixture = await setup(t);
    const before = fixture.posted.length;
    assert.equal(fixture.client.refresh(), true);
    assert.deepEqual(fixture.posted.at(-1), {
        __bpb: true, dir: 'toCS', kind: 'get',
    });
    assert.equal(fixture.posted.length, before + 1);
    fixture.client.dispose();
    assert.equal(fixture.client.refresh(), false);
    assert.equal(fixture.posted.length, before + 1);
});

test('track unit writes preserve the default and weather preferences, including on rollback', async t => {
    const fixture = await setup(t);
    fixture.dispatch({ kind: 'push', settings: { units: 'metric', temperatureUnits: 'imperial', precipitationUnits: 'metric' } });
    const requestId = fixture.client.setTrackUnits('imperial');
    assert.equal(fixture.client.get().units, 'metric');
    assert.equal(fixture.client.get().temperatureUnits, 'imperial');
    assert.equal(fixture.client.get().precipitationUnits, 'metric');
    assert.equal(fixture.client.get().distanceUnits, 'imperial');
    assert.equal(fixture.client.get().elevationUnits, 'imperial');
    assert.deepEqual(fixture.posted.at(-1)?.patch, { units: 'imperial' });
    fixture.dispatch({ kind: 'setResult', requestId, ok: false });
    assert.equal(fixture.client.get().distanceUnits, 'default');
    assert.equal(fixture.client.get().elevationUnits, 'default');
    assert.equal(fixture.client.get().units, 'metric');
    assert.equal(fixture.client.get().temperatureUnits, 'imperial');
    assert.equal(fixture.client.setTrackUnits('custom'), null);
});

test('a missing settings acknowledgement rolls back, while its late snapshot remains usable', async t => {
    const fixture = await setup(t);
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
});

test('a newer storage push cannot be overwritten by an older write acknowledgement', async t => {
    const fixture = await setup(t);
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
});

test('a same-write push advances the base while acknowledgements settle ordered requests', async t => {
    const fixture = await setup(t);
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
});

test('out-of-order successes and disposal cannot revive an older bridge snapshot', async t => {
    const fixture = await setup(t);
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
});

test('an explicit settings failure clears its timer and uses the bridge message once', async t => {
    const fixture = await setup(t);
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
});

test('an older timeout never reverts a newer optimistic write to the same key', async t => {
    const fixture = await setup(t);
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
});

test('overlapping writes to different keys reconcile independently', async t => {
    const fixture = await setup(t);
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
});

test('a newer success snapshot settles an older lost reply without rolling backward', async t => {
    const fixture = await setup(t);
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
});

test('every bridge snapshot is schema-cleaned before becoming confirmed state', async t => {
    const fixture = await setup(t);

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
});

test('equal array preferences do not notify subscribers again', async t => {
    const fixture = await setup(t);
    const settings = { ...fixture.client.get(), mapProviderOrder: ['caltopo', 'gaia', 'onx', 'alltrails'] };
    fixture.dispatch({ kind: 'push', settings, snapshotRevision: 2, throughRequestId: 0 });
    const count = fixture.notifications.length;
    fixture.dispatch({ kind: 'push', settings: structuredClone(settings), snapshotRevision: 3, throughRequestId: 0 });
    assert.equal(fixture.notifications.length, count);
});


test('equal column maps do not replay settings notifications and a changed column notifies once', async t => {
    const fixture = await setup(t);
    const settings = { ...fixture.client.get(), peakCardColumns: { sun: 'map', snow: 'map', weather: 'details' } };
    fixture.dispatch({ kind: 'push', settings, snapshotRevision: 2, throughRequestId: 0 });
    const count = fixture.notifications.length;
    fixture.dispatch({ kind: 'push', settings: structuredClone(settings), snapshotRevision: 3, throughRequestId: 0 });
    assert.equal(fixture.notifications.length, count);
    fixture.dispatch({ kind: 'push', settings: { ...settings, peakCardColumns: { ...settings.peakCardColumns, snow: 'details' } }, snapshotRevision: 4, throughRequestId: 0 });
    assert.equal(fixture.notifications.length, count + 1);
});
