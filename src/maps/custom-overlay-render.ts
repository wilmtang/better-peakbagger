// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCustomClient } from './custom-overlay-client.ts';
import { createPagePrivateFetch, createPrivateLayerFetch } from './custom-private-client.ts';
import type { CustomMvtFeature, CustomParseRequest } from './custom-overlay-data.ts';

export type CustomGeometryKind = 'point' | 'line' | 'polygon';
export type CustomSourceKind = 'raster' | 'mvt' | 'geojson';

export interface CustomRenderRule {
    sourceLayer?: string;
    geometry: CustomGeometryKind;
    color: string;
    width?: number;
    radius?: number;
    fillOpacity?: number;
}

export interface CustomRenderSource {
    id: string;
    revision: number;
    name?: string;
    kind: CustomSourceKind;
    privateRequests?: boolean;
    source: {
        dataUrl?: string;
        metadataUrl?: string;
        tiles?: string[];
        minNativeZoom?: number;
        maxNativeZoom?: number;
        scheme?: string;
        tileSize?: number;
        bounds?: number[] | null;
    };
    approvedOrigins?: string[];
    attribution: {
        text: string;
        url?: string;
    };
    appearance: {
        opacity: number;
        rules: CustomRenderRule[];
    };
}

export interface CustomOverlayStatus {
    pending: boolean;
    error: boolean;
    partial: boolean;
    lower: boolean;
    message: string;
    code?: string;
    status?: number;
    retryAt: number;
}

export interface CustomMapLibreApi {
    addProtocol(
        protocol: string,
        handler: (
            request: { url: string },
            abort: AbortController,
        ) => Promise<{ data: ArrayBuffer | ImageBitmap | HTMLImageElement | string | object }>,
    ): void;
    removeProtocol(protocol: string): void;
}

export type CustomRendererWindow = Window & { L?: unknown };

export interface CustomRendererMap {
    getBounds?(): { getNorth(): number; getSouth(): number; getEast(): number; getWest(): number };
}

export interface CustomRendererOptions {
    win: CustomRendererWindow | null | undefined;
    map: CustomRendererMap;
    maplibre?: CustomMapLibreApi | null;
    parse: (job: CustomParseRequest, signal?: AbortSignal | null) => Promise<unknown>;
    pool?: NonNullable<Parameters<typeof createCustomClient>[0]>['pool'];
    onStatus: (id: string, status: CustomOverlayStatus) => void;
    requestWindow?: CustomRendererWindow | null;
}

interface CustomErrorFields {
    name?: string;
    message?: string;
    code?: string;
    status?: number;
    retryAt?: number;
}

interface TileOutcome {
    loaded?: boolean;
    lower?: boolean;
    error?: CustomErrorFields;
}

interface LeafletCanvasRenderer {
    _container?: HTMLElement;
}

interface LeafletGeoJsonGroup {
    setStyle(style: { opacity: number; fillOpacity: number }): void;
}

interface LeafletTileEntry {
    el: HTMLCanvasElement;
    coords: { x: number; y: number; z: number };
    loaded?: boolean;
}

interface LeafletOverlayLayer {
    _container?: HTMLElement;
    _tiles?: Record<string, LeafletTileEntry>;
    options?: { minZoom?: number };
    retired?: boolean;
    getAttribution?: () => string;
    setOpacity(opacity: number): void;
    addTo(map: LeafletMapLike): unknown;
    on(event: string, listener: (event: { tile: HTMLCanvasElement }) => void): void;
    off(event: string, listener: () => void): void;
    isLoading(): boolean;
    getLayers?(): LeafletGeoJsonGroup[];
}

interface LeafletMapLike {
    getPane(name: string): HTMLElement | undefined;
    createPane(name: string): HTMLElement;
    removeLayer(layer: unknown): void;
    getBounds?(): { getNorth(): number; getSouth(): number; getEast(): number; getWest(): number };
    getZoom(): number;
    on(event: string, listener: () => void): void;
    off(event: string, listener: () => void): void;
}

interface LeafletApi {
    canvas(options: { pane: string }): LeafletCanvasRenderer;
    geoJSON(data: unknown, options: {
        pane: string;
        interactive: boolean;
        renderer: LeafletCanvasRenderer;
        filter: (feature: { geometry?: { type: string } | null }) => boolean;
        style: Record<string, unknown>;
        pointToLayer: (feature: unknown, latlng: unknown) => unknown;
    }): LeafletGeoJsonGroup;
    circleMarker(latlng: unknown, options: Record<string, unknown>): unknown;
    layerGroup(groups: LeafletGeoJsonGroup[]): LeafletOverlayLayer;
    GridLayer: {
        extend(proto: {
            createTile(
                coordinates: { x: number; y: number; z: number },
                done: (error: Error | null, tile: HTMLCanvasElement) => void,
            ): HTMLCanvasElement;
        }): new (options: Record<string, unknown>) => LeafletOverlayLayer;
    };
}

interface TerrainTileCoord {
    canonical: { z: number; x: number; y: number };
}

interface TerrainTileEvent {
    sourceId?: string;
    tile?: { state?: string; aborted?: boolean };
    coord?: { canonical?: { z: number; x: number; y: number } };
    error?: { name?: string };
}

interface TerrainSourceLike {
    setTiles?(tiles: string[]): void;
    setData?(data: unknown): void;
}

interface TerrainMapLike {
    getStyle(): { layers: { id: string; type?: string }[] };
    getLayer(id: string): { id: string; type?: string } | undefined;
    moveLayer(id: string, beforeId?: string): void;
    removeLayer(id: string): void;
    removeSource(id: string): void;
    getSource(id: string): TerrainSourceLike | undefined;
    addSource(id: string, source: Record<string, unknown>): void;
    addLayer(layer: Record<string, unknown>, beforeId?: string): void;
    setPaintProperty(id: string, name: string, value: number): void;
    getBounds?(): { getNorth(): number; getSouth(): number; getEast(): number; getWest(): number };
    coveringTiles?(options: { tileSize: number; minzoom: number; maxzoom: number }): TerrainTileCoord[];
    isSourceLoaded?(id: string): boolean;
    on?(type: string, listener: (event: TerrainTileEvent) => void): unknown;
    off?(type: string, listener: (event: TerrainTileEvent) => void): unknown;
}

interface StageState {
    error?: string;
    dispose(): void;
    loaded?(): void;
}

interface PaintTarget {
    source: CustomRenderSource;
    key?: string;
    layers?: string[];
    layer?: LeafletOverlayLayer;
    renderers?: LeafletCanvasRenderer[];
}

interface RenderEntry extends PaintTarget {
    definition: CustomRenderSource;
    generation: number;
    baseKey: string;
    opacity: number;
    reload: number | undefined;
    key: string;
    layers: string[];
    controller: AbortController;
    tiles: Map<HTMLCanvasElement, AbortController>;
    outcomes: Map<unknown, TileOutcome>;
    pending: number;
    failed: number;
    loaded: number;
    lower: boolean;
    painting?: boolean;
    empty?: boolean;
    failure?: string;
    code?: string;
    httpStatus?: number;
    retryAt?: number;
    blocked?: CustomErrorFields | null;
    refresh?: Record<string, never>;
    refreshTiles?: Set<string>;
    retained?: PaintTarget | null;
    stage?: StageState | null;
    data?: unknown;
    drawTile?: (
        canvas: HTMLCanvasElement,
        coordinates: { x: number; y: number; z: number },
        done: (error: Error | null, tile: HTMLCanvasElement) => void,
        tileRefresh?: Record<string, never> | null,
    ) => void;
}

type TileDataResult =
    | { canvas: HTMLCanvasElement; lower: boolean; data?: undefined; features?: undefined }
    | { features: CustomMvtFeature[]; data: ArrayBuffer; lower: boolean; canvas?: undefined };

const geometryType = (type: string): CustomGeometryKind =>
    /Point$/.test(type) ? 'point' : /LineString$/.test(type) ? 'line' : 'polygon';

const attribution = (source: CustomRenderSource): string => {
    const escapeHtml = (value: string): string =>
        value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const label = escapeHtml(source.attribution.text);
    return source.attribution.url
        ? `<a href="${escapeHtml(source.attribution.url)}" target="_blank" rel="noopener noreferrer">${label || 'Source'}</a>`
        : label;
};

export function drawCustomVector(
    context: CanvasRenderingContext2D,
    features: readonly CustomMvtFeature[],
    rules: readonly CustomRenderRule[],
    size: number,
): void {
    for (const rule of rules) {
        for (const feature of features) {
            if (feature.layer !== rule.sourceLayer || feature.type !== { point: 1, line: 2, polygon: 3 }[rule.geometry]) continue;
            context.strokeStyle = context.fillStyle = rule.color;
            context.lineWidth = rule.width ?? 2;
            context.lineJoin = 'round';
            context.lineCap = 'round';
            context.beginPath();
            const radius = rule.radius ?? 5;
            for (const path of feature.paths) {
                if (feature.type === 1) {
                    for (const [x, y] of path) {
                        context.moveTo(x * size + radius, y * size);
                        context.arc(x * size, y * size, radius, 0, Math.PI * 2);
                    }
                } else {
                    path.forEach(([x, y], i) => i ? context.lineTo(x * size, y * size) : context.moveTo(x * size, y * size));
                    if (feature.type === 3) context.closePath();
                }
            }
            if (feature.type === 3) {
                context.globalAlpha = rule.fillOpacity ?? 0.3;
                context.fill('evenodd');
                context.globalAlpha = 1;
                context.stroke();
            } else if (feature.type === 1) {
                context.fill();
            } else {
                context.stroke();
            }
        }
    }
}

export function createCustomRenderer({
    win: initialWin,
    map,
    maplibre,
    parse,
    pool,
    onStatus,
    requestWindow = initialWin,
}: CustomRendererOptions) {
    if (!initialWin) throw new Error('Custom overlay renderer requires a window.');
    const win = initialWin;
    const reqWin = requestWindow || win;
    const terrain = !!maplibre;
    const terrainMap = map as unknown as TerrainMapLike;
    const leafletMap = map as unknown as LeafletMapLike;
    const entries = new Map<string, RenderEntry>();
    const protocol = `bpb-custom-${Math.random().toString(36).slice(2)}`;
    // The BigMap owner runs in its parent realm while drawing in MasterMap.
    // postMessage must use the executing owner window, not the canvas window:
    // invoking child.postMessage from the parent sets event.source=parent.
    const transport = terrain ? null : createPagePrivateFetch(reqWin, win.fetch.bind(win));
    const fetchImpl = terrain
        ? createPrivateLayerFetch({
            send: (message: unknown) => (globalThis.browser || globalThis.chrome).runtime.sendMessage(message),
            fallback: win.fetch.bind(win),
        })
        : transport!.fetch;
    const client = createCustomClient({
        fetchImpl,
        parse: parse as NonNullable<Parameters<typeof createCustomClient>[0]>['parse'],
        pool,
        bitmap: win.createImageBitmap?.bind(win),
    });
    let disposed = false;
    let canvasBytes = 0;
    let lastUpdate: [readonly CustomRenderSource[], Record<string, unknown>, Record<string, number | undefined>] | null = null;

    const before = (): string | undefined =>
        terrainMap.getStyle().layers.find(layer =>
            layer.type === 'symbol' || /^(bpb-(?:route|peaks|highlight|fire|snotel))/.test(layer.id))?.id;

    const order = (): void => {
        // The first saved row is the topmost custom overlay in either renderer.
        for (const source of (lastUpdate?.[0] || []).slice().reverse()) {
            const entry = entries.get(source.id);
            if (!entry) continue;
            if (terrain) {
                for (const id of entry.layers) if (terrainMap.getLayer(id)) terrainMap.moveLayer(id, before());
            } else {
                const pane = leafletMap.getPane('bpb-custom-overlays');
                for (const container of entry.renderers?.map(item => item._container) || [entry.layer?._container]) {
                    if (pane && container && container.parentNode === pane) {
                        container.style.zIndex = '0';
                        pane.appendChild(container);
                    }
                }
            }
        }
    };

    const eligibleViewport = (entry: RenderEntry): boolean | null => {
        const bounds = entry.source.source.bounds;
        const view = (terrain ? terrainMap.getBounds?.() : leafletMap.getBounds?.());
        if (bounds && view) {
            if (view.getNorth() < bounds[1] || view.getSouth() > bounds[3]) return false;
            const width = view.getEast() - view.getWest();
            if (width < 360) {
                const west = ((view.getWest() + 180) % 360 + 360) % 360 - 180;
                const east = west + width;
                if (east <= 180 ? east < bounds[0] || west > bounds[2] : west > bounds[2] && east - 360 < bounds[0]) return false;
            }
        }
        if (terrain) {
            if (!terrainMap.coveringTiles) return null;
            const size = entry.source.kind === 'raster' ? entry.source.source.tileSize ?? 256 : 512;
            return terrainMap.coveringTiles({
                tileSize: size,
                minzoom: entry.source.source.minNativeZoom ?? 0,
                maxzoom: entry.source.source.maxNativeZoom ?? 18,
            }).length > 0;
        }
        return leafletMap.getZoom() >= (entry.layer?.options?.minZoom ?? Infinity);
    };

    const status = (entry: RenderEntry): void => {
        if (!disposed && entries.get(entry.source.id) === entry) {
            if (entry.empty && eligibleViewport(entry) === true) entry.empty = false;
            onStatus(entry.source.id, {
                pending: entry.pending > 0 || !!entry.retained && !entry.failed && !entry.stage?.error,
                error: entry.failed > 0 || !!entry.stage?.error,
                partial: (entry.failed > 0 || !!entry.stage?.error) && entry.loaded > 0,
                lower: entry.lower,
                message: entry.stage?.error || entry.failure || (
                    entry.empty
                        ? 'No tiles in this area.'
                        : entry.retained
                            ? 'Loading replacement…'
                            : entry.lower
                                ? 'Showing enlarged tiles from a lower zoom level.'
                                : entry.loaded ? 'Loaded' : ''
                ),
                code: entry.code,
                status: entry.httpStatus,
                retryAt: entry.retryAt || 0,
            });
        }
    };

    const removePaint = (target: PaintTarget): void => {
        if (terrain) {
            if (target.layers) {
                for (const layer of target.layers.slice().reverse()) {
                    if (terrainMap.getLayer(layer)) terrainMap.removeLayer(layer);
                }
            }
            if (target.key && terrainMap.getSource(target.key)) terrainMap.removeSource(target.key);
        } else {
            if (target.layer) leafletMap.removeLayer(target.layer);
            for (const item of target.renderers || []) leafletMap.removeLayer(item);
        }
    };

    const clearStage = (entry: RenderEntry): void => {
        entry.stage?.dispose();
        entry.stage = null;
    };

    const remove = (id: string): void => {
        const entry = entries.get(id);
        if (!entry) return;
        entries.delete(id);
        clearStage(entry);
        entry.controller.abort();
        for (const controller of entry.tiles.values()) controller.abort();
        removePaint(entry);
        if (entry.retained) removePaint(entry.retained);
    };

    const tally = (entry: RenderEntry): void => {
        const outcomes = [...entry.outcomes.values()];
        entry.loaded = outcomes.filter(value => value.loaded).length;
        entry.failed = Math.max(entry.blocked ? 1 : 0, outcomes.filter(value => value.error).length);
        entry.lower = outcomes.some(value => value.lower);
        const failure = outcomes.find(value => value.error)?.error || entry.blocked;
        entry.failure = failure?.message || '';
        entry.code = failure?.code;
        entry.httpStatus = failure?.status;
    };

    const tiledOpacity = (target: PaintTarget, opacity: number): void => {
        if (!terrain) {
            target.layer?.setOpacity(opacity / 100);
        } else if (target.layers) {
            for (const id of target.layers) {
                const type = terrainMap.getLayer(id)?.type;
                if (type) {
                    terrainMap.setPaintProperty(
                        id,
                        `${type}-opacity`,
                        opacity / 100 * (type === 'fill' ? target.source.appearance.rules[Number(id.split('-').at(-1))]?.fillOpacity ?? 0.3 : 1),
                    );
                }
            }
        }
    };

    const finishStage = (entry: RenderEntry): void => {
        if (entries.get(entry.source.id) !== entry || !entry.retained) return;
        entry.empty = eligibleViewport(entry) === false;
        clearStage(entry);
        tiledOpacity(entry, entry.opacity);
        removePaint(entry.retained);
        entry.retained = null;
        status(entry);
    };

    const watchTerrainStage = (entry: RenderEntry): void => {
        const generation = entry.generation;
        const key = entry.key;
        const accepted = new Map<string, { state?: string; aborted?: boolean }>();
        const current = (): boolean =>
            entries.get(entry.source.id) === entry && entry.generation === generation && entry.key === key && !!entry.retained;
        const loaded = (event: TerrainTileEvent): void => {
            if (!current() || event.sourceId !== key || event.tile?.state !== 'loaded' || event.tile.aborted || !event.coord?.canonical) return;
            const { z, x, y } = event.coord.canonical;
            accepted.set(`${z}/${x}/${y}`, event.tile);
        };
        const failed = (event: TerrainTileEvent): void => {
            if (!current() || event.sourceId !== key || event.error?.name === 'AbortError' || !entry.stage) return;
            entry.stage.error = 'Couldn’t render the replacement. Your previous map is still shown. Choose Retry.';
            status(entry);
        };
        const rendered = (): void => {
            if (!current()) return;
            if (eligibleViewport(entry) === false) { finishStage(entry); return; }
            if (entry.failed || entry.stage?.error || entry.pending || !terrainMap.isSourceLoaded?.(key)) return;
            const size = entry.source.kind === 'raster' ? entry.source.source.tileSize ?? 256 : 512;
            const visible = terrainMap.coveringTiles?.({
                tileSize: size,
                minzoom: entry.source.source.minNativeZoom ?? 0,
                maxzoom: entry.source.source.maxNativeZoom ?? 18,
            }) || [];
            const keys = new Set(visible.map(tile => `${tile.canonical.z}/${tile.canonical.x}/${tile.canonical.y}`));
            for (const id of accepted.keys()) if (!keys.has(id)) accepted.delete(id);
            if (visible.some(tile => {
                const { z, x, y } = tile.canonical;
                const value = accepted.get(`${z}/${x}/${y}`);
                return value && !value.aborted && value.state === 'loaded';
            })) finishStage(entry);
        };
        terrainMap.on?.('sourcedata', loaded);
        terrainMap.on?.('render', rendered);
        terrainMap.on?.('error', failed);
        entry.stage = {
            dispose() {
                terrainMap.off?.('sourcedata', loaded);
                terrainMap.off?.('render', rendered);
                terrainMap.off?.('error', failed);
            },
        };
    };

    const perform = async <T>(entry: RenderEntry, work: () => Promise<T>, key: unknown = 'data'): Promise<T> => {
        const generation = entry.generation;
        const current = (): boolean =>
            !disposed && entries.get(entry.source.id) === entry && entry.generation === generation && !entry.controller.signal.aborted;
        entry.pending++;
        status(entry);
        try {
            const result = await work();
            if (!current()) {
                (result as { image?: ImageBitmap } | null | undefined)?.image?.close();
                throw new DOMException('Cancelled.', 'AbortError');
            }
            entry.outcomes.set(key, {
                loaded: true,
                lower: Boolean((result as { lower?: boolean } | null | undefined)?.lower),
            });
            return result;
        } catch (error) {
            const failure = error as CustomErrorFields | null | undefined;
            if (current() && failure?.name !== 'AbortError') {
                entry.outcomes.set(key, { loaded: entry.outcomes.get(key)?.loaded, error: failure || {} });
                entry.retryAt = Math.max(entry.retryAt || 0, failure?.retryAt || 0);
                if (failure?.code === 'access' || failure?.code === 'rate-limit') {
                    entry.blocked = failure;
                    for (const controller of entry.tiles.values()) controller.abort();
                }
            }
            throw error;
        } finally {
            if (current()) {
                entry.pending--;
                tally(entry);
                status(entry);
            }
        }
    };

    const refreshViewport = (entry: RenderEntry): void => {
        const size = entry.source.kind === 'raster' ? entry.source.source.tileSize ?? 256 : 512;
        entry.refreshTiles = new Set(
            terrainMap.coveringTiles?.({
                tileSize: size,
                minzoom: entry.source.source.minNativeZoom ?? 0,
                maxzoom: entry.source.source.maxNativeZoom ?? 18,
            }).map(tile => `${tile.canonical.z}/${tile.canonical.x}/${tile.canonical.y}`) || [],
        );
    };

    const tileData = async (
        entry: RenderEntry,
        coordinates: { z: number; x: number; y: number },
        signal: AbortSignal,
        key: unknown = `${coordinates.z}/${coordinates.x}/${coordinates.y}`,
        refresh: Record<string, never> | null = null,
    ): Promise<TileDataResult> => {
        if (entry.blocked) throw entry.blocked;
        const combined = AbortSignal.any([signal, entry.controller.signal]);
        const result = await perform(entry, async () => {
            const value = await client.tile(
                entry.source as Parameters<typeof client.tile>[0],
                coordinates,
                combined,
                true,
                refresh,
            );
            if (combined.aborted) {
                (value as { image?: ImageBitmap } | null | undefined)?.image?.close();
                throw new DOMException('Cancelled.', 'AbortError');
            }
            return value;
        }, key);
        if (entry.source.kind === 'mvt') {
            return result as { features: CustomMvtFeature[]; data: ArrayBuffer; lower: boolean };
        }
        const raster = result as { image: ImageBitmap; scale: number; x: number; y: number; lower: boolean };
        const canvas = win.document.createElement('canvas');
        canvas.width = canvas.height = entry.source.source.tileSize ?? 256;
        const image = raster.image;
        const size = image.width / raster.scale;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context unavailable.');
        context.drawImage(image, raster.x * size, raster.y * size, size, size, 0, 0, canvas.width, canvas.height);
        image.close();
        return { canvas, lower: raster.lower };
    };

    if (maplibre) {
        maplibre.addProtocol(protocol, async (request, abort) => {
            const match = /\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
            const entry = match && [...entries.values()].find(item => `${item.key}~${item.reload || 0}` === match[1]);
            if (!entry) throw new DOMException('Cancelled.', 'AbortError');
            const key = `${match[2]}/${match[3]}/${match[4]}`;
            const refresh = entry.refreshTiles?.has(key) ? entry.refresh ?? null : null;
            const result = await tileData(entry, { z: +match[2], x: +match[3], y: +match[4] }, abort.signal, key, refresh);
            if (refresh && entry.refresh === refresh) entry.refreshTiles?.delete(key);
            if (result.data) return { data: result.data };
            const blob = await new Promise<Blob | null>(resolve => result.canvas.toBlob(resolve, 'image/png'));
            if (!blob) throw new DOMException('Cancelled.', 'AbortError');
            return { data: await blob.arrayBuffer() };
        });
    }

    const paint = async (entry: RenderEntry, refresh = false): Promise<void> => {
        if (entry.painting) return;
        entry.painting = true;
        const generation = entry.generation;
        const previousSource = entry.source;
        let source = refresh ? entry.definition : entry.source;
        const signal = entry.controller.signal;
        const current = (): boolean =>
            !signal.aborted && !disposed && entry.generation === generation && entries.get(source.id) === entry;
        try {
            if (source.kind !== 'geojson' && (!source.source.tiles?.length || refresh && source.source.metadataUrl)) {
                const resolved = await perform(entry, () => client.resolve(
                    source as Parameters<typeof client.resolve>[0],
                    signal,
                    true,
                    { refresh: refresh ? entry.refresh ?? null : null },
                )) as { source: CustomRenderSource; origins: string[] };
                if (resolved.origins.length) {
                    throw Object.assign(new Error('Review the tile provider hosts in Edit source.'), { code: 'origins' });
                }
                source = resolved.source;
            }
            if (!current()) return;
            const data = source.kind === 'geojson'
                ? await perform(entry, () => client.geojson(
                    source as Parameters<typeof client.geojson>[0],
                    signal,
                    refresh ? entry.refresh ?? null : null,
                ))
                : null;
            if (!current()) return;
            entry.source = source;
            if (terrain && refresh && !data) refreshViewport(entry);
            const sameGeometry = JSON.stringify([
                previousSource.kind,
                previousSource.source.tileSize,
                previousSource.source.bounds,
                previousSource.source.minNativeZoom,
                previousSource.source.maxNativeZoom,
                previousSource.appearance.rules,
            ]) === JSON.stringify([
                source.kind,
                source.source.tileSize,
                source.source.bounds,
                source.source.minNativeZoom,
                source.source.maxNativeZoom,
                source.appearance.rules,
            ]);
            if (refresh && !data && sameGeometry && (terrain ? terrainMap.getSource(entry.key) : entry.layer) && !entry.retained) {
                if (terrain) {
                    terrainMap.getSource(entry.key)?.setTiles?.([`${protocol}://tile/${entry.key}~${entry.reload || 0}/{z}/{x}/{y}`]);
                } else {
                    for (const tile of Object.values(entry.layer?._tiles || {})) {
                        entry.drawTile?.(tile.el, tile.coords, () => {}, entry.refresh);
                    }
                }
                order();
                status(entry);
                return;
            }
            if (!data && entry.retained) {
                removePaint(entry);
                Object.assign(entry, {
                    key: entry.retained.key,
                    layers: entry.retained.layers,
                    layer: entry.retained.layer,
                    renderers: entry.retained.renderers,
                });
            }
            if (!terrain) {
                const L = win.L as unknown as LeafletApi;
                const pane = 'bpb-custom-overlays';
                if (!leafletMap.getPane(pane)) {
                    leafletMap.createPane(pane);
                    const paneEl = leafletMap.getPane(pane);
                    if (paneEl) paneEl.style.cssText = 'z-index:280;pointer-events:none';
                }
                if (data) {
                    const renderers = source.appearance.rules.map(() => L.canvas({ pane }));
                    let layer: LeafletOverlayLayer | undefined;
                    try {
                        const groups = source.appearance.rules.map((rule, index) => L.geoJSON(data, {
                            pane,
                            interactive: false,
                            renderer: renderers[index],
                            filter: feature => !!feature.geometry && geometryType(feature.geometry.type) === rule.geometry,
                            style: {
                                color: rule.color,
                                weight: rule.width ?? 2,
                                opacity: entry.opacity / 100,
                                fillColor: rule.color,
                                fillOpacity: (rule.fillOpacity ?? 0.3) * entry.opacity / 100,
                                interactive: false,
                            },
                            pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
                                pane,
                                renderer: renderers[index],
                                radius: rule.radius ?? 5,
                                color: rule.color,
                                fillColor: rule.color,
                                fillOpacity: entry.opacity / 100,
                                opacity: entry.opacity / 100,
                                interactive: false,
                            }),
                        }));
                        layer = L.layerGroup(groups);
                        layer.getAttribution = () => attribution(source);
                        layer.addTo(leafletMap);
                    } catch (error) {
                        if (layer) leafletMap.removeLayer(layer);
                        for (const item of renderers) leafletMap.removeLayer(item);
                        throw error;
                    }
                    if (entry.layer) leafletMap.removeLayer(entry.layer);
                    for (const item of entry.renderers || []) leafletMap.removeLayer(item);
                    entry.layer = layer;
                    entry.renderers = renderers;
                    entry.data = data;
                } else {
                    const size = source.kind === 'raster' ? source.source.tileSize ?? 256 : 512;
                    const offset = size === 512 ? 1 : 0;
                    let initialRefresh = refresh ? entry.refresh ?? null : null;
                    const accepted = new Set<HTMLCanvasElement>();
                    const drawTile = (
                        canvas: HTMLCanvasElement,
                        coordinates: { x: number; y: number; z: number },
                        done: (error: Error | null, tile: HTMLCanvasElement) => void,
                        tileRefresh: Record<string, never> | null = null,
                    ): void => {
                        if (layer.retired) return;
                        entry.tiles.get(canvas)?.abort();
                        const controller = new AbortController();
                        entry.tiles.set(canvas, controller);
                        tileData(
                            entry,
                            { x: coordinates.x, y: coordinates.y, z: coordinates.z - offset },
                            controller.signal,
                            canvas,
                            tileRefresh,
                        ).then(result => {
                            if (controller.signal.aborted || signal.aborted) return;
                            const context = canvas.getContext('2d');
                            if (!context) {
                                done(new Error('Canvas 2D context unavailable.'), canvas);
                                return;
                            }
                            context.clearRect(0, 0, size, size);
                            if (result.canvas) context.drawImage(result.canvas, 0, 0);
                            else drawCustomVector(context, result.features, entry.source.appearance.rules, size);
                            accepted.add(canvas);
                            done(null, canvas);
                        }, error => {
                            if (!controller.signal.aborted && !signal.aborted) {
                                done(error instanceof Error ? error : new Error('Tile failed.'), canvas);
                            }
                        });
                    };
                    const Grid = L.GridLayer.extend({
                        createTile(coordinates, done) {
                            const canvas = win.document.createElement('canvas');
                            if (canvasBytes + size * size * 4 > 24 * 1024 * 1024) {
                                queueMicrotask(() => done(new Error('Overlay memory limit. Zoom in.'), canvas));
                                return canvas;
                            }
                            canvas.width = canvas.height = size;
                            canvasBytes += size * size * 4;
                            drawTile(canvas, coordinates, done, initialRefresh);
                            return canvas;
                        },
                    });
                    const previousLayer = entry.layer;
                    const layer = new Grid({
                        pane,
                        tileSize: size,
                        minZoom: (source.source.minNativeZoom ?? 0) + offset,
                        // Redraw vector geometry at display resolution on overzoom;
                        // scaling a parent canvas would also scale stroke/radius sizes.
                        ...(source.kind === 'raster' ? { maxNativeZoom: (source.source.maxNativeZoom ?? 18) + offset } : {}),
                        maxZoom: 24,
                        attribution: attribution(source),
                        opacity: previousLayer ? 0 : entry.opacity / 100,
                        updateWhenIdle: true,
                        keepBuffer: 0,
                        bpbOverlay: true,
                        bounds: source.source.bounds
                            ? [[source.source.bounds[1], source.source.bounds[0]], [source.source.bounds[3], source.source.bounds[2]]]
                            : undefined,
                    });
                    layer.on('tileunload', event => {
                        accepted.delete(event.tile);
                        entry.tiles.get(event.tile)?.abort();
                        if (entry.tiles.delete(event.tile)) canvasBytes -= event.tile.width * event.tile.height * 4;
                        entry.outcomes.delete(event.tile);
                        tally(entry);
                        status(entry);
                    });
                    if (previousLayer) {
                        const loaded = (): void => {
                            if (entry.layer !== layer || entry.generation !== generation || !entry.retained) return;
                            const visible = Object.values(layer._tiles || {}).some(tile => tile.loaded && accepted.has(tile.el));
                            if (eligibleViewport(entry) === false || !layer.isLoading() && !entry.failed && visible) finishStage(entry);
                        };
                        layer.on('load', loaded);
                        leafletMap.on('moveend zoomend', loaded);
                        entry.stage = {
                            dispose() {
                                layer.off('load', loaded);
                                leafletMap.off('moveend zoomend', loaded);
                            },
                            loaded,
                        };
                    }
                    try {
                        layer.addTo(leafletMap);
                        initialRefresh = null;
                    } catch (error) {
                        leafletMap.removeLayer(layer);
                        clearStage(entry);
                        throw error;
                    }
                    entry.layer = layer;
                    entry.drawTile = drawTile;
                    if (previousLayer) {
                        previousLayer.retired = true;
                        entry.retained ||= { layer: previousLayer, source: previousSource };
                        entry.stage?.loaded?.();
                    }
                }
            } else {
                const previousKey = entry.key;
                const previousLayers = entry.layers;
                const key = refresh && !data && terrainMap.getSource(previousKey) ? `${entry.baseKey}-${generation}` : previousKey;
                if (terrainMap.getSource(key)) {
                    if (data) terrainMap.getSource(key)?.setData?.(data);
                    status(entry);
                    return;
                }
                entry.key = key;
                entry.layers = [];
                try {
                    terrainMap.addSource(key, data ? { type: 'geojson', data } : {
                        type: source.kind === 'raster' ? 'raster' : 'vector',
                        tiles: [`${protocol}://tile/${key}~${entry.reload || 0}/{z}/{x}/{y}`],
                        ...(source.kind === 'raster' ? { tileSize: source.source.tileSize ?? 256 } : {}),
                        minzoom: source.source.minNativeZoom ?? 0,
                        maxzoom: source.source.maxNativeZoom ?? 18,
                        ...(source.source.bounds ? { bounds: source.source.bounds } : {}),
                        attribution: attribution(source),
                    });
                    const specs: Record<string, unknown>[] = source.kind === 'raster'
                        ? [{
                            id: key + '-raster',
                            type: 'raster',
                            paint: { 'raster-opacity': entry.opacity / 100, 'raster-fade-duration': 0 },
                        }]
                        : source.appearance.rules.flatMap((rule, i): Record<string, unknown>[] => {
                            const base = {
                                id: `${key}-${i}`,
                                ...(source.kind === 'mvt' ? { 'source-layer': rule.sourceLayer } : {}),
                                filter: ['==', ['geometry-type'], { point: 'Point', line: 'LineString', polygon: 'Polygon' }[rule.geometry]],
                            };
                            const width = rule.width ?? 2;
                            const radius = rule.radius ?? 5;
                            const fillOpacity = rule.fillOpacity ?? 0.3;
                            return rule.geometry === 'point'
                                ? [{
                                    ...base,
                                    type: 'circle',
                                    paint: {
                                        'circle-color': rule.color,
                                        'circle-radius': radius,
                                        'circle-opacity': entry.opacity / 100,
                                        'circle-pitch-alignment': 'map',
                                    },
                                }]
                                : rule.geometry === 'line'
                                    ? [{
                                        ...base,
                                        type: 'line',
                                        paint: {
                                            'line-color': rule.color,
                                            'line-width': width,
                                            'line-opacity': entry.opacity / 100,
                                        },
                                    }]
                                    : [{
                                        ...base,
                                        type: 'fill',
                                        paint: {
                                            'fill-color': rule.color,
                                            'fill-opacity': fillOpacity * entry.opacity / 100,
                                        },
                                    }, {
                                        ...base,
                                        id: base.id + '-outline',
                                        type: 'line',
                                        paint: {
                                            'line-color': rule.color,
                                            'line-width': width,
                                            'line-opacity': entry.opacity / 100,
                                        },
                                    }];
                        });
                    for (const spec of specs) {
                        terrainMap.addLayer({ ...spec, source: key }, before());
                        entry.layers.push(spec.id as string);
                    }
                } catch (error) {
                    for (const id of entry.layers.slice().reverse()) {
                        if (terrainMap.getLayer(id)) terrainMap.removeLayer(id);
                    }
                    if (terrainMap.getSource(key)) terrainMap.removeSource(key);
                    entry.key = previousKey;
                    entry.layers = previousLayers;
                    throw error;
                }
                if (key !== previousKey) {
                    entry.retained ||= { key: previousKey, layers: previousLayers, source: previousSource };
                    tiledOpacity(entry, 0);
                    watchTerrainStage(entry);
                }
            }
            order();
            status(entry);
        } catch (error) {
            const failure = error as CustomErrorFields | null | undefined;
            if (current() && failure?.name !== 'AbortError') {
                entry.source = previousSource;
                entry.failed++;
                entry.failure = failure?.message || '';
                entry.code = failure?.code;
                status(entry);
            }
        } finally {
            if (entry.generation === generation) entry.painting = false;
        }
    };

    const visibility = (): void => {
        if (win.document.hidden) {
            client.clear();
            for (const id of [...entries.keys()]) remove(id);
        } else if (lastUpdate) {
            renderer.update(...lastUpdate);
        }
    };

    win.document.addEventListener('visibilitychange', visibility);

    const renderer = {
        client,
        update(
            sources: readonly CustomRenderSource[],
            preferences: Record<string, unknown> = {},
            reloads: Record<string, number | undefined> = {},
        ): void {
            lastUpdate = [sources, preferences, reloads];
            if (disposed || win.document.hidden) return;
            const opacityFor = (source: CustomRenderSource): number => {
                const raw = preferences[source.id];
                return typeof raw === 'number' && Number.isFinite(raw) ? raw : source.appearance.opacity;
            };
            const selected = new Set(sources.filter(source => opacityFor(source) > 0).map(source => source.id));
            for (const id of entries.keys()) if (!selected.has(id)) remove(id);
            for (const source of sources) {
                const opacity = opacityFor(source);
                if (opacity === 0) continue;
                let entry = entries.get(source.id);
                if (entry && entry.source.revision !== source.revision) {
                    remove(source.id);
                    entry = undefined;
                }
                if (entry && entry.reload !== reloads[source.id]) {
                    entry.reload = reloads[source.id];
                    if (entry.painting) continue;
                    clearStage(entry);
                    entry.empty = false;
                    client.evict(`${source.id}:${source.revision}`);
                    entry.generation++;
                    entry.pending = 0;
                    entry.refresh = {};
                    if (terrain && source.kind !== 'geojson') refreshViewport(entry);
                    for (const controller of entry.tiles.values()) controller.abort();
                    entry.blocked = null;
                    entry.failed = 0;
                    entry.failure = '';
                    entry.code = '';
                    entry.httpStatus = 0;
                    entry.lower = false;
                    for (const [key, outcome] of entry.outcomes) entry.outcomes.set(key, { loaded: outcome.loaded });
                    if (source.kind === 'geojson' || source.source.metadataUrl || (terrain ? !terrainMap.getSource(entry.key) : !entry.layer)) {
                        void paint(entry, true);
                    } else if (terrain) {
                        terrainMap.getSource(entry.key)?.setTiles?.([`${protocol}://tile/${entry.key}~${entry.reload || 0}/{z}/{x}/{y}`]);
                    } else {
                        for (const tile of Object.values(entry.layer?._tiles || {})) {
                            entry.drawTile?.(tile.el, tile.coords, () => {}, entry.refresh);
                        }
                    }
                }
                if (entry) {
                    if (entry.opacity !== opacity) {
                        entry.opacity = opacity;
                        if (entry.retained) {
                            tiledOpacity(entry.retained, opacity);
                            continue;
                        }
                        if (!terrain) {
                            if (source.kind === 'geojson') {
                                entry.layer?.getLayers?.().forEach((group, i) => {
                                    const rule = source.appearance.rules[i];
                                    group.setStyle({
                                        opacity: opacity / 100,
                                        fillOpacity: opacity / 100 * (rule.geometry === 'point' ? 1 : rule.fillOpacity ?? 0.3),
                                    });
                                });
                            } else {
                                entry.layer?.setOpacity(opacity / 100);
                            }
                        } else {
                            for (const id of entry.layers) {
                                const type = terrainMap.getLayer(id)?.type;
                                if (type) {
                                    terrainMap.setPaintProperty(
                                        id,
                                        `${type}-opacity`,
                                        opacity / 100 * (type === 'fill' ? source.appearance.rules[Number(id.split('-').at(-1))]?.fillOpacity ?? 0.3 : 1),
                                    );
                                }
                            }
                        }
                    }
                    continue;
                }
                const baseKey = 'bpb-custom-' + source.id.slice(7) + '-' + source.revision;
                entry = {
                    source,
                    definition: source,
                    generation: 0,
                    baseKey,
                    opacity,
                    reload: reloads[source.id],
                    key: baseKey + '-0',
                    controller: new AbortController(),
                    tiles: new Map(),
                    outcomes: new Map(),
                    layers: [],
                    pending: 0,
                    failed: 0,
                    loaded: 0,
                    lower: false,
                };
                entries.set(source.id, entry);
                void paint(entry);
            }
            order();
        },
        report(): void {
            for (const entry of entries.values()) status(entry);
        },
        refresh(): void {
            if (!terrain || !terrainMap.coveringTiles) return;
            for (const entry of entries.values()) {
                if (entry.source.kind === 'geojson') continue;
                const size = entry.source.kind === 'raster' ? entry.source.source.tileSize ?? 256 : 512;
                const visible = new Set(
                    terrainMap.coveringTiles({
                        tileSize: size,
                        minzoom: entry.source.source.minNativeZoom ?? 0,
                        maxzoom: entry.source.source.maxNativeZoom ?? 18,
                    }).map(tile => `${tile.canonical.z}/${tile.canonical.x}/${tile.canonical.y}`),
                );
                for (const key of entry.outcomes.keys()) {
                    if (key !== 'data' && !visible.has(String(key))) entry.outcomes.delete(key);
                }
                tally(entry);
                status(entry);
            }
        },
        dispose(): void {
            disposed = true;
            lastUpdate = null;
            win.document.removeEventListener('visibilitychange', visibility);
            client.clear();
            transport?.dispose();
            for (const id of [...entries.keys()]) remove(id);
            if (maplibre) maplibre.removeProtocol(protocol);
        },
    };
    return renderer;
}
