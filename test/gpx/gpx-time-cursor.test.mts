import test from 'node:test';
import assert from 'node:assert/strict';
import { GPX_TIME_CURSOR, GPX_TIME_CURSOR_REQUEST, gpxCursorTime, readGpxTimeCursor, createGpxTimeCursorPublisher } from '../../src/gpx/gpx-time-cursor.ts';

const time = Date.parse('2024-07-12T13:32:00Z');
const point = { timeState: 'valid', ms: time, lat: 46, lon: -121 };
const quality = { hasProgress: true };
// The window members the cursor uses, recorded; owners take it as a Window.
type Listener = (event: MessageEvent) => void;
const fakeWindow = () => {
    const frames = new Map<number, () => void>(), listeners = new Set<Listener>();
    const messages: { value: { hovering?: boolean; hoverTime?: number | null; selectionTime?: number | null }; origin: string }[] = [];
    let id = 0;
    return {
        location: { origin: 'https://www.peakbagger.com' }, messages, frames, listeners,
        requestAnimationFrame: (fn: () => void) => { frames.set(++id, fn); return id; },
        cancelAnimationFrame: (frame: number) => frames.delete(frame),
        addEventListener: (_: string, fn: Listener) => listeners.add(fn), removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
        postMessage: (value: (typeof messages)[number]['value'], origin: string) => messages.push({ value, origin }),
        flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    };
};
type FakeWindow = ReturnType<typeof fakeWindow>;
const asWindow = (win: FakeWindow) => win as unknown as Window;
// A message event carries only the fields the reader checks.
const asEvent = (fields: { source: unknown; origin: string; data: unknown }) => fields as unknown as MessageEvent;
const event = (win: FakeWindow, data: unknown) => asEvent({ source: win, origin: win.location.origin, data });

test('cursor only admits valid timestamps from a progressing track', () => {
    assert.equal(gpxCursorTime(point, quality), time);
    for (const invalid of [null, { ...point, timeState: 'missing' }, { ...point, timeState: 'suspect' }, { ...point, ms: NaN }, { ...point, ms: 0 }, { ...point, ms: 1e20 }]) {
        assert.equal(gpxCursorTime(invalid, quality), null);
    }
    assert.equal(gpxCursorTime(point, { hasProgress: false, reason: 'not-progressing' } as { hasProgress: boolean }), null);
    assert.equal(gpxCursorTime(point), null);
});

test('receiver validates same-window origin, flags, timestamps and exact scalar shape', () => {
    const win = fakeWindow(), value = { type: GPX_TIME_CURSOR, hovering: true, hoverTime: time, selected: true, selectionTime: null };
    assert.deepEqual(readGpxTimeCursor(event(win, value), asWindow(win)), { hovering: true, hoverTime: time, selected: true, selectionTime: null });
    for (const data of [{ ...value, lat: 46 }, { ...value, hovering: 'true' }, { ...value, hoverTime: -1 }, { ...value, selectionTime: Infinity }, { ...value, hovering: false }, { ...value, selected: false, selectionTime: time }, { type: GPX_TIME_CURSOR }]) {
        assert.equal(readGpxTimeCursor(event(win, data), asWindow(win)), null);
    }
    assert.equal(readGpxTimeCursor(asEvent({ source: {}, origin: win.location.origin, data: value }), asWindow(win)), null);
    assert.equal(readGpxTimeCursor(asEvent({ source: win, origin: 'https://example.com', data: value }), asWindow(win)), null);
});

test('publisher coalesces hover, retains selection, replays late subscriptions and disposes', () => {
    const win = fakeWindow(), publisher = createGpxTimeCursorPublisher(asWindow(win));
    publisher.select(point, quality);
    publisher.hover({ ...point, ms: time + 60_000 }, quality);
    publisher.hover({ ...point, ms: time + 120_000 }, quality);
    assert.equal(win.frames.size, 1); win.flush();
    assert.deepEqual(win.messages[0], { origin: win.location.origin, value: {
        type: GPX_TIME_CURSOR, hovering: true, hoverTime: time + 120_000, selected: true, selectionTime: time,
    } });
    publisher.hover(null); win.flush();
    assert.equal(win.messages.at(-1)?.value.hoverTime, null);
    assert.equal(win.messages.at(-1)?.value.selectionTime, time);
    const request = { type: GPX_TIME_CURSOR_REQUEST };
    for (const invalid of [asEvent({ source: {}, origin: win.location.origin, data: request }), event(win, { ...request, coordinates: [] })]) win.listeners.forEach(fn => fn(invalid));
    assert.equal(win.frames.size, 0);
    win.listeners.forEach(fn => fn(event(win, request))); win.flush();
    assert.equal(win.messages.length, 3);
    publisher.hover(point, quality); publisher.suspend();
    assert.equal(win.frames.size, 0);
    publisher.resume(); win.flush();
    assert.equal(win.messages.at(-1)?.value.hovering, false);
    assert.equal(win.messages.at(-1)?.value.selectionTime, time);
    publisher.select(null); publisher.dispose();
    assert.equal(win.frames.size, 0); assert.equal(win.listeners.size, 0);
    publisher.resume(); assert.equal(win.frames.size, 0);
});
