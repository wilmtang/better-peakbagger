// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCustomClient } from './custom-overlay-client.js';
import { createPagePrivateFetch, createPrivateLayerFetch } from './custom-private-client.js';

const geometryType = type => /Point$/.test(type) ? 'point' : /LineString$/.test(type) ? 'line' : 'polygon';
const attribution = source => {
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const label = escape(source.attribution.text);
    return source.attribution.url ? `<a href="${escape(source.attribution.url)}" target="_blank" rel="noopener noreferrer">${label || 'Source'}</a>` : label;
};
export function drawCustomVector(context, features, rules, size) {
    for (const rule of rules) for (const feature of features) {
        if (feature.layer !== rule.sourceLayer || feature.type !== { point: 1, line: 2, polygon: 3 }[rule.geometry]) continue;
        context.strokeStyle = context.fillStyle = rule.color; context.lineWidth = rule.width; context.lineJoin = 'round'; context.lineCap = 'round';
        context.beginPath();
        for (const path of feature.paths) {
            if (feature.type === 1) { for (const [x, y] of path) { context.moveTo(x * size + rule.radius, y * size); context.arc(x * size, y * size, rule.radius, 0, Math.PI * 2); } }
            else { path.forEach(([x, y], i) => i ? context.lineTo(x * size, y * size) : context.moveTo(x * size, y * size)); if (feature.type === 3) context.closePath(); }
        }
        if (feature.type === 3) { context.globalAlpha = rule.fillOpacity; context.fill('evenodd'); context.globalAlpha = 1; context.stroke(); }
        else if (feature.type === 1) context.fill(); else context.stroke();
    }
}
export function createCustomRenderer({ win, map, maplibre, parse, pool, onStatus, requestWindow = win }) {
    const terrain = !!maplibre, entries = new Map(), protocol = `bpb-custom-${Math.random().toString(36).slice(2)}`;
    // The BigMap owner runs in its parent realm while drawing in MasterMap.
    // postMessage must use the executing owner window, not the canvas window:
    // invoking child.postMessage from the parent sets event.source=parent.
    const transport = terrain ? null : createPagePrivateFetch(requestWindow, win.fetch.bind(win));
    const fetchImpl = terrain ? createPrivateLayerFetch({ send: message => (globalThis.browser || globalThis.chrome).runtime.sendMessage(message), fallback: win.fetch.bind(win) }) : transport.fetch;
    const client = createCustomClient({ fetchImpl, parse, pool, bitmap: win.createImageBitmap?.bind(win) });
    let disposed = false, canvasBytes = 0, lastUpdate = null;
    const before = () => map.getStyle().layers.find(layer => layer.type === 'symbol' || /^(bpb-(?:route|peaks|highlight|fire|snotel))/.test(layer.id))?.id;
    const order = () => {
        // The first saved row is the topmost custom overlay in either renderer.
        for (const source of (lastUpdate?.[0] || []).slice().reverse()) {
            const entry = entries.get(source.id); if (!entry) continue;
            if (terrain) { for (const id of entry.layers) if (map.getLayer(id)) map.moveLayer(id, before()); }
            else {
                const pane = map.getPane('bpb-custom-overlays');
                for (const container of entry.renderers?.map(renderer => renderer._container) || [entry.layer?._container]) {
                    if (pane && container && container.parentNode === pane) { container.style.zIndex = '0'; pane.appendChild(container); }
                }
            }
        }
    };
    const status = entry => {
        if (!disposed && entries.get(entry.source.id) === entry) onStatus(entry.source.id, {
            pending: entry.pending > 0, error: entry.failed > 0, partial: entry.failed > 0 && entry.loaded > 0,
            lower: entry.lower, message: entry.failure || (entry.lower ? 'Showing enlarged tiles from a lower zoom level.' : entry.loaded ? 'Loaded' : ''),
            code: entry.code, status: entry.httpStatus, retryAt: entry.retryAt || 0,
        });
    };
    const removePaint = entry => {
        if (terrain) {
            for (const layer of entry.layers.slice().reverse()) if (map.getLayer(layer)) map.removeLayer(layer);
            if (map.getSource(entry.key)) map.removeSource(entry.key);
        } else {
            if (entry.layer) map.removeLayer(entry.layer);
            for (const renderer of entry.renderers || []) map.removeLayer(renderer);
        }
    };
    const remove = id => {
        const entry = entries.get(id); if (!entry) return;
        entries.delete(id); entry.controller.abort(); for (const controller of entry.tiles.values()) controller.abort();
        removePaint(entry); if (entry.retained) removePaint(entry.retained);
    };
    const tally = entry => {
        const outcomes = [...entry.outcomes.values()];
        entry.loaded = outcomes.filter(value => value.loaded).length;
        entry.failed = Math.max(entry.blocked ? 1 : 0, outcomes.filter(value => value.error).length);
        entry.lower = outcomes.some(value => value.lower);
        const failure = outcomes.find(value => value.error)?.error || entry.blocked;
        entry.failure = failure?.message || ''; entry.code = failure?.code; entry.httpStatus = failure?.status;
    };
    const tiledOpacity = (entry, opacity) => {
        if (!terrain) entry.layer?.setOpacity(opacity / 100);
        else for (const id of entry.layers) {
            const type = map.getLayer(id)?.type;
            if (type) map.setPaintProperty(id, `${type}-opacity`, opacity / 100 * (type === 'fill' ? entry.source.appearance.rules[Number(id.split('-').at(-1))]?.fillOpacity ?? .3 : 1));
        }
    };
    const perform = async (entry, work, key = 'data') => {
        const generation = entry.generation;
        const current = () => !disposed && entries.get(entry.source.id) === entry && entry.generation === generation && !entry.controller.signal.aborted;
        entry.pending++; status(entry);
        try {
            const result = await work();
            if (!current()) { result?.image?.close(); throw new DOMException('Cancelled.', 'AbortError'); }
            entry.outcomes.set(key, { loaded: true, lower: result?.lower }); return result;
        }
        catch (error) {
            if (current() && error.name !== 'AbortError') {
                entry.outcomes.set(key, { loaded: entry.outcomes.get(key)?.loaded, error });
                entry.retryAt = Math.max(entry.retryAt || 0, error.retryAt || 0);
                if (error.code === 'access' || error.code === 'rate-limit') { entry.blocked = error; for (const controller of entry.tiles.values()) controller.abort(); }
            }
            throw error;
        } finally {
            if (current()) {
                entry.pending--; tally(entry);
                if (key !== 'data' && entry.retained && !entry.pending && !entry.failed && entry.loaded) {
                    tiledOpacity(entry, entry.opacity); removePaint(entry.retained); entry.retained = null;
                }
                status(entry);
            }
        }
    };
    const tileData = async (entry, coordinates, signal, key = `${coordinates.z}/${coordinates.x}/${coordinates.y}`) => {
        if (entry.blocked) throw entry.blocked;
        const combined = AbortSignal.any([signal, entry.controller.signal]);
        const result = await perform(entry, () => client.tile(entry.source, coordinates, combined), key);
        if (entry.source.kind === 'mvt') return result;
        const canvas = win.document.createElement('canvas'); canvas.width = canvas.height = entry.source.source.tileSize;
        const image = result.image, size = image.width / result.scale;
        canvas.getContext('2d').drawImage(image, result.x * size, result.y * size, size, size, 0, 0, canvas.width, canvas.height); image.close();
        return { canvas, lower: result.lower };
    };
    if (terrain) maplibre.addProtocol(protocol, async (request, abort) => {
        const match = /\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
        const entry = match && [...entries.values()].find(item => `${item.key}~${item.reload || 0}` === match[1]);
        if (!entry) throw new DOMException('Cancelled.', 'AbortError');
        const result = await tileData(entry, { z: +match[2], x: +match[3], y: +match[4] }, abort.signal);
        if (result.data) return { data: result.data };
        const blob = await new Promise(resolve => result.canvas.toBlob(resolve, 'image/png'));
        return { data: await blob.arrayBuffer() };
    });
    const paint = async (entry, refresh = false) => {
        if (entry.painting) return;
        entry.painting = true;
        const generation = entry.generation, previousSource = entry.source;
        let source = refresh ? entry.definition : entry.source;
        const signal = entry.controller.signal;
        const current = () => !signal.aborted && !disposed && entry.generation === generation && entries.get(source.id) === entry;
        try {
            if (source.kind !== 'geojson' && (!source.source.tiles.length || refresh && source.source.metadataUrl)) {
                const resolved = await perform(entry, () => client.resolve(source, signal));
                if (resolved.origins.length) throw Object.assign(new Error('Review the tile provider hosts in Edit source.'), { code: 'origins' });
                source = resolved.source;
            }
            if (!current()) return;
            const data = source.kind === 'geojson' ? await perform(entry, () => client.geojson(source, signal)) : null;
            if (!current()) return;
            entry.source = source;
            const sameGeometry = JSON.stringify([previousSource.kind, previousSource.source.tileSize, previousSource.source.bounds, previousSource.source.minNativeZoom, previousSource.source.maxNativeZoom, previousSource.appearance.rules])
                === JSON.stringify([source.kind, source.source.tileSize, source.source.bounds, source.source.minNativeZoom, source.source.maxNativeZoom, source.appearance.rules]);
            if (refresh && !data && sameGeometry && (terrain ? map.getSource(entry.key) : entry.layer) && !entry.retained) {
                if (terrain) map.getSource(entry.key).setTiles([`${protocol}://tile/${entry.key}~${entry.reload || 0}/{z}/{x}/{y}`]);
                else for (const tile of Object.values(entry.layer._tiles || {})) entry.drawTile(tile.el, tile.coords, () => {});
                order(); status(entry); return;
            }
            if (!data && entry.retained) {
                removePaint(entry);
                Object.assign(entry, { key: entry.retained.key, layers: entry.retained.layers, layer: entry.retained.layer, renderers: entry.retained.renderers });
            }
            if (!terrain) {
                const L = win.L, pane = 'bpb-custom-overlays';
                if (!map.getPane(pane)) { map.createPane(pane); map.getPane(pane).style.cssText = 'z-index:280;pointer-events:none'; }
                if (data) {
                    const renderers = source.appearance.rules.map(() => L.canvas({ pane }));
                    let layer;
                    try {
                        const groups = source.appearance.rules.map((rule, index) => L.geoJSON(data, { pane, interactive: false,
                            renderer: renderers[index], filter: feature => feature.geometry && geometryType(feature.geometry.type) === rule.geometry,
                            style: { color: rule.color, weight: rule.width, opacity: entry.opacity / 100, fillColor: rule.color, fillOpacity: rule.fillOpacity * entry.opacity / 100, interactive: false },
                            pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { pane, renderer: renderers[index], radius: rule.radius, color: rule.color, fillColor: rule.color, fillOpacity: entry.opacity / 100, opacity: entry.opacity / 100, interactive: false }),
                        }));
                        layer = L.layerGroup(groups); layer.getAttribution = () => attribution(source); layer.addTo(map);
                    } catch (error) {
                        if (layer) map.removeLayer(layer);
                        for (const renderer of renderers) map.removeLayer(renderer);
                        throw error;
                    }
                    if (entry.layer) map.removeLayer(entry.layer);
                    for (const renderer of entry.renderers || []) map.removeLayer(renderer);
                    entry.layer = layer; entry.renderers = renderers; entry.data = data;
                } else {
                    const size = source.kind === 'raster' ? source.source.tileSize : 512, offset = size === 512 ? 1 : 0;
                    const drawTile = (canvas, coordinates, done) => {
                        if (layer.retired) return;
                        entry.tiles.get(canvas)?.abort();
                        const controller = new AbortController(); entry.tiles.set(canvas, controller);
                        tileData(entry, { x: coordinates.x, y: coordinates.y, z: coordinates.z - offset }, controller.signal, canvas).then(result => {
                            if (controller.signal.aborted || signal.aborted) return;
                            const context = canvas.getContext('2d'); context.clearRect(0, 0, size, size);
                            if (result.canvas) context.drawImage(result.canvas, 0, 0);
                            else drawCustomVector(context, result.features, entry.source.appearance.rules, size);
                            done(null, canvas);
                        }, error => { if (!controller.signal.aborted && !signal.aborted) done(error, canvas); });
                    };
                    const Grid = L.GridLayer.extend({ createTile(coordinates, done) {
                        const canvas = win.document.createElement('canvas');
                        if (canvasBytes + size * size * 4 > 24 * 1024 * 1024) { queueMicrotask(() => done(new Error('Overlay memory limit. Zoom in.'), canvas)); return canvas; }
                        canvas.width = canvas.height = size; canvasBytes += size * size * 4;
                        drawTile(canvas, coordinates, done);
                        return canvas;
                    } });
                    const previousLayer = entry.layer;
                    const layer = new Grid({ pane, tileSize: size,
                        minZoom: source.source.minNativeZoom + offset,
                        // Redraw vector geometry at display resolution on overzoom;
                        // scaling a parent canvas would also scale stroke/radius sizes.
                        ...(source.kind === 'raster' ? { maxNativeZoom: source.source.maxNativeZoom + offset } : {}), maxZoom: 24,
                        attribution: attribution(source),
                        opacity: previousLayer ? 0 : entry.opacity / 100, updateWhenIdle: true, keepBuffer: 0, bpbOverlay: true,
                        bounds: source.source.bounds ? [[source.source.bounds[1], source.source.bounds[0]], [source.source.bounds[3], source.source.bounds[2]]] : undefined,
                    });
                    layer.on('tileunload', event => { entry.tiles.get(event.tile)?.abort(); if (entry.tiles.delete(event.tile)) canvasBytes -= event.tile.width * event.tile.height * 4; entry.outcomes.delete(event.tile); tally(entry); status(entry); });
                    try { layer.addTo(map); } catch (error) { map.removeLayer(layer); throw error; }
                    entry.layer = layer; entry.drawTile = drawTile;
                    if (previousLayer) { previousLayer.retired = true; entry.retained ||= { layer: previousLayer, source: previousSource }; }
                }
            } else {
                const previousKey = entry.key, previousLayers = entry.layers;
                const key = refresh && !data && map.getSource(previousKey) ? `${entry.baseKey}-${generation}` : previousKey;
                if (map.getSource(key)) { if (data) map.getSource(key).setData(data); status(entry); return; }
                entry.key = key; entry.layers = [];
                try {
                    map.addSource(key, data ? { type: 'geojson', data } : { type: source.kind === 'raster' ? 'raster' : 'vector',
                        tiles: [`${protocol}://tile/${key}~${entry.reload || 0}/{z}/{x}/{y}`], ...(source.kind === 'raster' ? { tileSize: source.source.tileSize } : {}),
                        minzoom: source.source.minNativeZoom, maxzoom: source.source.maxNativeZoom,
                        ...(source.source.bounds ? { bounds: source.source.bounds } : {}), attribution: attribution(source) });
                    const specs = source.kind === 'raster' ? [{ id: key + '-raster', type: 'raster', paint: { 'raster-opacity': entry.opacity / 100, 'raster-fade-duration': 0 } }]
                        : source.appearance.rules.flatMap((rule, i) => {
                            const base = { id: `${key}-${i}`, ...(source.kind === 'mvt' ? { 'source-layer': rule.sourceLayer } : {}),
                                filter: ['==', ['geometry-type'], { point: 'Point', line: 'LineString', polygon: 'Polygon' }[rule.geometry]] };
                            return rule.geometry === 'point' ? [{ ...base, type: 'circle', paint: { 'circle-color': rule.color, 'circle-radius': rule.radius, 'circle-opacity': entry.opacity / 100, 'circle-pitch-alignment': 'map' } }]
                                : rule.geometry === 'line' ? [{ ...base, type: 'line', paint: { 'line-color': rule.color, 'line-width': rule.width, 'line-opacity': entry.opacity / 100 } }]
                                    : [{ ...base, type: 'fill', paint: { 'fill-color': rule.color, 'fill-opacity': rule.fillOpacity * entry.opacity / 100 } },
                                        { ...base, id: base.id + '-outline', type: 'line', paint: { 'line-color': rule.color, 'line-width': rule.width, 'line-opacity': entry.opacity / 100 } }];
                        });
                    for (const spec of specs) { map.addLayer({ ...spec, source: key }, before()); entry.layers.push(spec.id); }
                } catch (error) {
                    for (const id of entry.layers.slice().reverse()) if (map.getLayer(id)) map.removeLayer(id);
                    if (map.getSource(key)) map.removeSource(key);
                    entry.key = previousKey; entry.layers = previousLayers; throw error;
                }
                if (key !== previousKey) {
                    entry.retained ||= { key: previousKey, layers: previousLayers, source: previousSource };
                    tiledOpacity(entry, 0);
                }
            }
            order(); status(entry);
        } catch (error) { if (current() && error.name !== 'AbortError') { entry.source = previousSource; entry.failed++; entry.failure = error.message; entry.code = error.code; status(entry); } }
        finally { if (entry.generation === generation) entry.painting = false; }
    };
    const visibility = () => {
        if (win.document.hidden) { client.clear(); for (const id of [...entries.keys()]) remove(id); }
        else if (lastUpdate) renderer.update(...lastUpdate);
    };
    win.document.addEventListener('visibilitychange', visibility);
    const renderer = { client, update(sources, preferences = {}, reloads = {}) {
        lastUpdate = [sources, preferences, reloads];
        if (disposed || win.document.hidden) return;
        const selected = new Set(sources.filter(source => (preferences[source.id] ?? source.appearance.opacity) > 0).map(source => source.id));
        for (const id of entries.keys()) if (!selected.has(id)) remove(id);
        for (const source of sources) {
            const opacity = preferences[source.id] ?? source.appearance.opacity;
            if (opacity === 0) continue;
            let entry = entries.get(source.id);
            if (entry && entry.source.revision !== source.revision) { remove(source.id); entry = null; }
            if (entry && entry.reload !== reloads[source.id]) {
                entry.reload = reloads[source.id];
                if (entry.painting) continue;
                client.evict(`${source.id}:${source.revision}`); entry.generation++; entry.pending = 0;
                for (const controller of entry.tiles.values()) controller.abort();
                entry.blocked = null; entry.failed = 0; entry.failure = ''; entry.code = ''; entry.httpStatus = 0; entry.lower = false;
                for (const [key, outcome] of entry.outcomes) entry.outcomes.set(key, { loaded: outcome.loaded });
                if (source.kind === 'geojson' || source.source.metadataUrl || (terrain ? !map.getSource(entry.key) : !entry.layer)) void paint(entry, true);
                else if (terrain) map.getSource(entry.key)?.setTiles([`${protocol}://tile/${entry.key}~${entry.reload || 0}/{z}/{x}/{y}`]);
                else for (const tile of Object.values(entry.layer._tiles || {})) entry.drawTile(tile.el, tile.coords, () => {});
            }
            if (entry) {
                if (entry.opacity !== opacity) {
                    entry.opacity = opacity;
                    if (entry.retained) { tiledOpacity(entry.retained, opacity); continue; }
                    if (!terrain) {
                        if (source.kind === 'geojson') entry.layer?.getLayers().forEach((group, i) => { const rule = source.appearance.rules[i]; group.setStyle({ opacity: opacity / 100, fillOpacity: opacity / 100 * (rule.geometry === 'point' ? 1 : rule.fillOpacity) }); });
                        else entry.layer?.setOpacity(opacity / 100);
                    } else for (const id of entry.layers) {
                        const layer = map.getLayer(id), type = layer?.type;
                        if (type) map.setPaintProperty(id, `${type}-opacity`, opacity / 100 * (type === 'fill' ? source.appearance.rules[Number(id.split('-').at(-1))]?.fillOpacity ?? .3 : 1));
                    }
                }
                if (entry) continue;
            }
            const baseKey = 'bpb-custom-' + source.id.slice(7) + '-' + source.revision;
            entry = { source, definition: source, generation: 0, baseKey, opacity, reload: reloads[source.id], key: baseKey + '-0', controller: new AbortController(), tiles: new Map(), outcomes: new Map(), layers: [], pending: 0, failed: 0, loaded: 0, lower: false };
            entries.set(source.id, entry); void paint(entry);
        }
        order();
    }, report() { for (const entry of entries.values()) status(entry); }, refresh() {
        if (!terrain || !map.coveringTiles) return;
        for (const entry of entries.values()) {
            if (entry.source.kind === 'geojson') continue;
            const size = entry.source.kind === 'raster' ? entry.source.source.tileSize : 512;
            const visible = new Set(map.coveringTiles({ tileSize: size, minzoom: entry.source.source.minNativeZoom, maxzoom: entry.source.source.maxNativeZoom })
                .map(tile => `${tile.canonical.z}/${tile.canonical.x}/${tile.canonical.y}`));
            for (const key of entry.outcomes.keys()) if (key !== 'data' && !visible.has(key)) entry.outcomes.delete(key);
            tally(entry); status(entry);
        }
    }, dispose() { disposed = true; lastUpdate = null; win.document.removeEventListener('visibilitychange', visibility); client.clear();transport?.dispose(); for (const id of [...entries.keys()]) remove(id); if (terrain) maplibre.removeProtocol(protocol); } };
    return renderer;
}
