/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { defineDomSuite } from '../../../scripts/dom-tier.mts';

interface FrameMessage { type?: string; generation?: number; view?: unknown; width?: number; height?: number; }
interface FrameSnapshot { width: number; height: number; close(): void; }
interface FrameRenderer { usable: boolean; ready: boolean; resizes?: number; jumps?: number; lastStyle: { sources: object }; emit(type: string): void; }
type FrameWindow = Window & typeof globalThis & {
    renderer: FrameRenderer;
    protocol(parameters: { url: string; type?: string }, controller: AbortController): Promise<unknown>;
};

export default defineDomSuite({
    name: 'vector map frame',
    cases: [{
        name: 'initial partial failure waits for usable tiles after the one-time load event',
        async run(context) {
            const { outputFiles } = await build({
                entryPoints: ['src/maps/vector-map-frame.ts'],
                bundle: true,
                write: false,
                format: 'iife',
                plugins: [{
                    name: 'frame-boundaries',
                    setup(builder) {
                        builder.onResolve({ filter: /^maplibre-gl$/ }, () => ({ path: 'renderer', namespace: 'fixture' }));
                        builder.onResolve({ filter: /terrain-style\.ts$/ }, () => ({ path: 'style', namespace: 'fixture' }));
                        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'renderer' ? `
                            export const setWorkerUrl = () => {}, addProtocol = (_name, handler) => { window.protocol = handler; };
                            export class Map {
                                constructor() { window.renderer = this; this.events = {}; this.ready = false;
                                    this.style = { tileManagers: { base: { getSource: () => ({ type: 'vector' }), getTileByID: () => ({ tileID: { canonical: { z: 0, x: 0, y: 0 } } }), getIds: () => ['failed', 'pending'], getRenderableIds: () => this.usable || this.ready ? ['good'] : [] } } }; }
                                on(type, listener) { (this.events[type] ||= []).push(listener); }
                                once(type, listener) { this.on(type, listener); }
                                emit(type) { for (const listener of this.events[type] || []) listener(); }
                                redraw() { this.emit('render'); }
                                resize() { this.resizes = (this.resizes || 0) + 1; } jumpTo() { this.jumps = (this.jumps || 0) + 1; } setStyle(style) { this.lastStyle = style; } remove() {} areTilesLoaded() { return this.ready; }
                                getCanvas() { return document.getElementById('map'); }
                            }` : 'export const terrainStyle = { renderingStyle: style => style, createVectorStyleLoader: () => ({ load: async () => ({}) }) };' }));
                    },
                }],
            });

            await context.route('/fixture/vector-map-frame.js', outputFiles[0]!.text, 'text/javascript');
            await context.route('/map/MasterMap.aspx', '<!doctype html><html><body style="margin:0"><div id="map" style="width:640px;height:480px"></div></body></html>');
            await context.open('/map/MasterMap.aspx');

            const report = await context.page.evaluate(async () => {
                const win = window as unknown as FrameWindow;
                const messages: FrameMessage[] = [];
                const snapshots: ((snapshot: FrameSnapshot) => void)[] = [];
                const deadlines: (() => void)[] = [];
                const nativeSetTimeout = win.setTimeout.bind(win);
                const tick = () => new Promise(resolve => nativeSetTimeout(resolve, 0));

                win.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
                    if (ms === 15000 && typeof callback === 'function') deadlines.push(callback as () => void);
                    return nativeSetTimeout(callback, ms, ...args);
                }) as typeof win.setTimeout;
                (win as unknown as { createImageBitmap: () => Promise<FrameSnapshot> }).createImageBitmap =
                    () => new Promise<FrameSnapshot>(resolve => { snapshots.push(resolve); });
                let fetches = 0;
                let pendingSignal: AbortSignal | undefined;
                (win as unknown as { fetch: (_url: string, init: { signal: AbortSignal }) => Promise<never> }).fetch =
                    (_url: string, { signal }: { signal: AbortSignal }) => {
                        fetches++;
                        pendingSignal = signal;
                        return new Promise((_resolve, reject) => {
                            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
                        });
                    };
                (win as unknown as { postMessage: (data: FrameMessage) => void }).postMessage = (data: FrameMessage) => {
                    messages.push(data);
                };
                const ext = {
                    runtime: {
                        sendMessage: async () => ({ ok: true }),
                        getURL: (value: string) => `chrome-extension://fixture/${value}`,
                    },
                };
                (win as unknown as { chrome: unknown; browser: unknown }).chrome = ext;
                (win as unknown as { chrome: unknown; browser: unknown }).browser = ext;

                await new Promise<void>((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = '/fixture/vector-map-frame.js';
                    script.onload = () => resolve();
                    script.onerror = () => reject(new Error('Failed to load fixture script'));
                    document.head.append(script);
                });

                const send = (data: Record<string, unknown>) => win.dispatchEvent(new win.MessageEvent('message', {
                    source: win,
                    origin: win.location.origin,
                    data: { __bpbVectorMap: true, dir: 'toFrame', ...data },
                }));

                send({ type: 'init', activation: 'opaque', generation: 1, basemap: 'maptoolkit', view: { center: [0, 0], zoom: 3 } });
                await tick();
                const hasRenderer = Boolean(win.renderer);

                // MapLibre's source-error flag can satisfy Map.loaded() while other
                // tiles are still pending; areTilesLoaded() correctly remains false.
                win.renderer.emit('load');
                const loadedAfterLoadEvent = messages.some(message => message.type === 'loaded');

                win.renderer.usable = true;
                win.renderer.emit('render');
                const loadedBeforeCapture = messages.some(message => message.type === 'loaded');
                win.renderer.emit('render');
                const snapshotsInFlight = snapshots.length;

                snapshots.shift()!({ width: 640, height: 480, close() {} });
                await tick();
                const painted = messages.find(message => message.type === 'painted');
                const loadedAfterCapture = messages.some(message => message.type === 'loaded');
                const paintedSummary = painted
                    ? { view: JSON.parse(JSON.stringify(painted.view)), width: painted.width, height: painted.height, generation: painted.generation }
                    : null;

                win.renderer.ready = true;
                win.renderer.emit('idle');
                const loadedAfterIdle = messages.some(message => message.type === 'loaded');

                const beforeSameView = { resizes: win.renderer.resizes, jumps: win.renderer.jumps };
                send({ type: 'view', view: { center: [0, 0], zoom: 3 } });
                const afterSameView = { resizes: win.renderer.resizes, jumps: win.renderer.jumps };

                const ticks: unknown[] = [];
                const cancelled = win.requestAnimationFrame(() => ticks.push('cancelled'));
                win.cancelAnimationFrame(cancelled);
                win.requestAnimationFrame((timestamp: number) => { ticks.push(timestamp); win.requestAnimationFrame(() => ticks.push('next')); });
                send({ type: 'render', generation: 0 });
                const ticksAfterOldGen = ticks.length;
                send({ type: 'render', generation: 1 });
                const ticksAfterGen1 = { count: ticks.length, firstType: typeof ticks[0] };
                send({ type: 'render', generation: 1 });
                const ticksRest = ticks.slice(1);

                win.renderer.emit('render');
                const countBeforeObsolete = messages.filter(message => message.type === 'painted').length;
                send({ type: 'view', view: { center: [2, 2], zoom: 4 } });
                let obsoleteClosed = false;
                snapshots.shift()!({ width: 640, height: 480, close() { obsoleteClosed = true; } });
                await tick();
                const countAfterObsolete = messages.filter(message => message.type === 'painted').length;
                const lastPaintedView = JSON.parse(JSON.stringify(messages.at(-1)!.view));

                const request = win.protocol({ url: 'bpb-vector://https://tiles.maptoolkit.org/tile.pbf', type: 'arrayBuffer' }, new win.AbortController());
                let abortErrorName: string | null = null;
                const rejected = request.then(() => null, (error: Error) => { abortErrorName = error.name; });
                send({ type: 'release' });
                await rejected;
                const signalAborted = Boolean(pendingSignal?.aborted);
                const parkedSourceCount = Object.keys(win.renderer.lastStyle.sources).length;

                let inactiveErrorMessage = '';
                try {
                    await win.protocol({ url: 'bpb-vector://https://tiles.maptoolkit.org/tile.pbf' }, new win.AbortController());
                } catch (error) {
                    inactiveErrorMessage = (error as Error).message;
                }
                const fetchesWhileParked = fetches;

                const original = win.renderer;
                send({ type: 'resume', activation: 'fresh', generation: 2, view: { center: [1, 1], zoom: 4 } });
                await tick();
                win.renderer.emit('render');
                snapshots.shift()!({ width: 640, height: 480, close() {} });
                await tick();
                const reusedRenderer = win.renderer === original;
                const warmGeneration = messages.at(-1)!.generation;

                win.renderer.emit('render');
                let closedAfterRelease = false;
                send({ type: 'release' });
                snapshots.shift()!({ width: 640, height: 480, close() { closedAfterRelease = true; } });
                await tick();

                send({ type: 'resume', activation: 'fresh-again', generation: 3, view: { center: [1, 1], zoom: 4 } });
                await tick();
                win.renderer.emit('render');
                deadlines.at(-1)!();
                const errorAfterDeadline = messages.at(-1)!.type;
                let expiredClosed = false;
                snapshots.shift()!({ width: 640, height: 480, close() { expiredClosed = true; } });
                await tick();

                win.dispatchEvent(new win.Event('pagehide'));

                return {
                    hasRenderer,
                    loadedAfterLoadEvent,
                    loadedBeforeCapture,
                    snapshotsInFlight,
                    loadedAfterCapture,
                    paintedSummary,
                    loadedAfterIdle,
                    beforeSameView,
                    afterSameView,
                    ticksAfterOldGen,
                    ticksAfterGen1,
                    ticksRest,
                    obsoleteClosed,
                    paintedIncreasedBy: countAfterObsolete - countBeforeObsolete,
                    lastPaintedView,
                    abortErrorName,
                    signalAborted,
                    parkedSourceCount,
                    inactiveErrorMessage,
                    fetchesWhileParked,
                    reusedRenderer,
                    warmGeneration,
                    closedAfterRelease,
                    errorAfterDeadline,
                    expiredClosed,
                };
            });

            assert.equal(report.hasRenderer, true);
            assert.equal(report.loadedAfterLoadEvent, false);
            assert.equal(report.loadedBeforeCapture, false, 'Loading must include image capture, rather than only renderer readiness');
            assert.equal(report.snapshotsInFlight, 1, 'Bitmap creation is bounded to one in-flight capture');
            assert.equal(report.loadedAfterCapture, true, 'Usable imagery appears while secondary tiles are still pending');
            assert.deepEqual(report.paintedSummary, { view: { center: [0, 0], zoom: 3 }, width: 640, height: 480, generation: 1 });
            assert.equal(report.loadedAfterIdle, true, 'Settled usable data must finish initial loading without waiting for a second load event');
            assert.deepEqual(report.afterSameView, report.beforeSameView, 'Identical view messages do not resize or reapply the camera');
            assert.equal(report.ticksAfterOldGen, 0, 'An old activation cannot drive the renderer clock');
            assert.deepEqual(report.ticksAfterGen1, { count: 1, firstType: 'number' });
            assert.deepEqual(report.ticksRest, ['next'], 'Reentrant callbacks wait for the next visible frame');
            assert.equal(report.obsoleteClosed, false, 'An older coupled image remains useful while the next camera loads');
            assert.equal(report.paintedIncreasedBy, 1);
            assert.deepEqual(report.lastPaintedView, { center: [0, 0], zoom: 3 }, 'The image keeps its actual painted camera');
            assert.equal(report.abortErrorName, 'AbortError');
            assert.equal(report.signalAborted, true, 'Parking aborts the actual provider socket');
            assert.equal(report.parkedSourceCount, 0, 'A parked renderer owns no provider sources');
            assert.match(report.inactiveErrorMessage, /inactive/);
            assert.equal(report.fetchesWhileParked, 1, 'A renderer cannot start requests while parked');
            assert.equal(report.reusedRenderer, true);
            assert.equal(report.warmGeneration, 2, 'Warm output belongs to its new activation');
            assert.equal(report.closedAfterRelease, true, 'A snapshot completing after suspension releases its GPU bitmap');
            assert.equal(report.errorAfterDeadline, 'error', 'A hung GPU capture has a deadline, including after the initial load');
            assert.equal(report.expiredClosed, true, 'An image arriving after the deadline is closed');
        },
    }],
});
