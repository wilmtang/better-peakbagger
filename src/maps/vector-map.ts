// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MAPTOOLKIT_BASEMAP, VECTOR_BASEMAPS, VECTOR_MESSAGE, readVectorView, readVectorPaint, vectorBasemap } from './vector-basemap.ts';
import type { VectorPaint } from './vector-basemap.ts';
import { createPageLifecycle } from '../ui/page-lifecycle.ts';
import { readRetryAt } from '../net/rate-limit.js';

// The minimal Leaflet contract used here; Peakbagger's page owns the library.
interface LeafletPoint {
    x: number; y: number; add(other: LeafletPoint): LeafletPoint; subtract(other: LeafletPoint): LeafletPoint;
    multiplyBy(factor: number): LeafletPoint; round(): LeafletPoint;
}
interface LeafletLatLng { lat: number; lng: number; wrap(): LeafletLatLng; }
interface LeafletLayer { options?: { bpbVector?: boolean; bpbOverlay?: boolean; pane?: string }; addTo(map: LeafletMap): LeafletLayer; }
interface LeafletMap {
    getContainer(): HTMLElement; getPane(name: string): HTMLElement | undefined; createPane(name: string): HTMLElement;
    getSize(): LeafletPoint; getCenter(): LeafletLatLng; getZoom(): number; getZoomScale(to: number, from: number): number;
    latLngToLayerPoint(point: LeafletLatLng): LeafletPoint; layerPointToContainerPoint(point: LeafletPoint): LeafletPoint;
    containerPointToLayerPoint(point: LeafletPoint): LeafletPoint;
    _latLngToNewLayerPoint(point: LeafletLatLng, zoom: number, center: LeafletLatLng): LeafletPoint;
    _animatingZoom?: boolean; attributionControl?: { getContainer(): HTMLElement | undefined };
    hasLayer(layer: LeafletLayer): boolean; addLayer(layer: LeafletLayer): unknown; removeLayer(layer: LeafletLayer): unknown;
    eachLayer(callback: (layer: LeafletLayer) => void): void;
    on(type: string, callback: () => void): unknown; off(type: string, callback: () => void): unknown; once(type: string, callback: () => void): unknown;
    options?: { crs?: unknown };
}
interface LeafletZoomEvent { zoom: number; center: LeafletLatLng; }
interface VectorLayerInstance extends LeafletLayer {
    element?: HTMLElement; surface?: HTMLCanvasElement; context?: ImageBitmapRenderingContext | CanvasRenderingContext2D | null;
    painted?: VectorPaint | null; motion?: number | null; hostPosition: LeafletPoint;
    moving(): void; clearPaint(): void; paintedCenter(paint?: VectorPaint): LeafletLatLng;
    geometry(paint: VectorPaint): { scale: number; offset: LeafletPoint; coverage: number; zoomError: number };
    position(): void; paint(data: PaintMessage): boolean; update(): void; animateZoom(event: LeafletZoomEvent): void;
}
interface PaintMessage extends Partial<VectorPaint> { bitmap: ImageBitmap; }
interface LeafletNamespace {
    Layer: { extend<T>(properties: T & ThisType<VectorLayerInstance>): new () => VectorLayerInstance };
    GridLayer: new () => LeafletLayer; CRS?: { EPSG3857?: unknown };
    DomEvent: { disableClickPropagation(element: HTMLElement): void };
    DomUtil: { setPosition(element: HTMLElement, point: LeafletPoint): void; setTransform(element: HTMLElement, offset: LeafletPoint, scale: number): void };
    point(x: number, y: number): LeafletPoint; latLng(value: [number, number]): LeafletLatLng;
}
type LeafletWindow = Window & typeof globalThis & {
    L: LeafletNamespace; mapsPlaceholder?: LeafletMap; map?: LeafletMap; [leafletMaps: symbol]: LeafletMap[] | undefined;
};
interface VectorBinding { dispose(): void; reset(): void; select: HTMLSelectElement; map: LeafletMap; }

export function bindVectorMap(win: LeafletWindow, map: LeafletMap, select: HTMLSelectElement): VectorBinding {
    const L = win.L, doc = win.document, container = map.getContainer();
    const id = win.crypto.randomUUID(), native: LeafletLayer[] = [], elements = new Map<string, HTMLElement>(), previousId = select.dataset.bpbVectorMap;
    const options = VECTOR_BASEMAPS.map(basemap => { const option = doc.createElement('option'); option.value = basemap.code; option.textContent = basemap.name; return option; });
    select.append(...options); select.dataset.bpbVectorMap = id;
    const previousWidth = select.style.width, pickerStyle = win.getComputedStyle(select);
    const surround = select.closest<HTMLElement>('#selboxdiv'), previousSurroundId = surround?.dataset.bpbVectorPicker;
    if (surround) surround.dataset.bpbVectorPicker = id;
    const metrics = doc.createElement('canvas').getContext('2d')!;
    metrics.font = `${pickerStyle.fontStyle} ${pickerStyle.fontWeight} ${pickerStyle.fontSize} ${pickerStyle.fontFamily}`;
    // Firefox can defer the new option's intrinsic width until selection.
    // Reserve its label and native arrow before interaction, bounded to the map.
    // Size the native surround with its select. A min-width on the child alone
    // overflows Peakbagger's fixed 170px wrapper and can hide the native arrow.
    select.style.width = `${Math.ceil(Math.max(...[...select.options].map(item => metrics.measureText(item.textContent).width)) + 40)}px`;
    const reservedPickerWidth = select.style.width;
    let previous = select.value, layer: VectorLayerInstance | null = null, paused = false, launching = false, replacing = false, disposed = false, attributionReservation: { element: HTMLElement; minHeight: string; visibility: string } | null = null;
    let basemap = MAPTOOLKIT_BASEMAP, retryTimer: number | null = null;
    const cooldowns = new Map<string, number>();
    const status = doc.createElement('div'); status.className = 'bpb-vector-status'; status.hidden = true;
    const message = doc.createElement('span'); message.setAttribute('role', 'status');
    const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.dataset.bpbVectorMap = id;
    retry.dataset.bpbVectorBasemap = basemap.id;
    const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Dismiss vector map error');
    status.append(retry, message, dismiss); container.append(status);
    L.DomEvent.disableClickPropagation(status);
    const credits = doc.createElement('div'); credits.className = 'leaflet-control-attribution bpb-vector-credits';
    const creditLink = (href: string, text: string) => { const link = doc.createElement('a'); link.href = href; link.textContent = text; return link; };
    const logo = creditLink('https://www.maptoolkit.org/', ''); logo.className = 'bpb-vector-maptoolkit-logo'; logo.id = `bpb-vector-logo-${id}`; logo.setAttribute('aria-label', 'Maptoolkit'); logo.hidden = true;
    logo.target = '_blank'; logo.rel = 'noopener noreferrer';
    container.append(logo); L.DomEvent.disableClickPropagation(logo);
    const renderCredits = () => {
        credits.dataset.provider = basemap.id;
        credits.replaceChildren('© ', creditLink('https://www.maptoolkit.com/copyright/', 'Maptoolkit'), ' © ', creditLink('https://www.openstreetmap.org/copyright', 'Openstreetmap'));
        for (const link of credits.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    };
    renderCredits();
    credits.hidden = true; container.append(credits);
    L.DomEvent.disableClickPropagation(credits);
    const creditResize = new win.ResizeObserver(() => {
        if (!credits.hidden) container.style.setProperty('--bpb-vector-credit-height', `${credits.offsetHeight}px`);
    });
    creditResize.observe(credits);
    const pickerKey = (event: Event) => event.stopPropagation();
    // Some native shells place the picker inside Leaflet's keyboard target.
    // Arrow keys belong to that picker while it has focus, not to map panning.
    select.addEventListener('keydown', pickerKey);
    const post = (type: string, view?: unknown) => win.postMessage({ [VECTOR_MESSAGE]: true, dir: 'toCS', id, type, view }, win.location.origin);
    const view = () => {
        const point = map.getCenter().wrap();
        return readVectorView({ center: [point.lat, point.lng], zoom: map.getZoom() - 1 });
    };
    const pending = (retrying = false) => {
        status.hidden = false; message.textContent = 'Loading vector map…'; retry.hidden = !retrying; dismiss.hidden = true;
        retry.setAttribute('aria-disabled', String(retrying)); select.setAttribute('aria-busy', 'true');
    };
    const cooldown = () => {
        win.clearTimeout(retryTimer!);
        const until = readRetryAt(cooldowns.get(basemap.id));
        retry.setAttribute('aria-disabled', String(!!until));
        message.textContent = until ? `${basemap.provider} is busy. Retry after ${new Date(until).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : 'Vector map unavailable.';
        if (until) retryTimer = win.setTimeout(cooldown, until - Date.now());
    };
    const restore = () => {
        for (const item of native.splice(0)) if (!map.hasLayer(item)) map.addLayer(item);
        if (attributionReservation) {
            attributionReservation.element.style.minHeight = attributionReservation.minHeight;
            attributionReservation.element.style.visibility = attributionReservation.visibility;
            attributionReservation = null;
        }
        credits.hidden = true; logo.hidden = true;
    };
    const holdNative = () => {
        const attribution = map.attributionControl?.getContainer();
        if (attribution && !attributionReservation) {
            attributionReservation = { element: attribution, minHeight: attribution.style.minHeight, visibility: attribution.style.visibility };
            attribution.style.minHeight = `${attribution.offsetHeight}px`;
        }
        map.eachLayer((item: LeafletLayer) => {
            if (item instanceof L.GridLayer && !item.options?.bpbOverlay && (!item.options?.pane || item.options.pane === 'tilePane')) {
                native.push(item); map.removeLayer(item);
            }
        });
        // Credits wrap independently of Leaflet's bottom-right control stack.
        // The zoom buttons retain their native position even on narrow maps.
        credits.hidden = false;
        logo.hidden = basemap !== MAPTOOLKIT_BASEMAP;
        if (attribution && basemap === MAPTOOLKIT_BASEMAP) attribution.style.visibility = 'hidden';
    };
    const VectorLayer = L.Layer.extend({
        options: { bpbVector: true },
        onAdd() {
            const pane = map.getPane('bpb-vector') || map.createPane('bpb-vector');
            pane.style.zIndex = '201'; pane.style.pointerEvents = 'none';
            this.element = elements.get(basemap.id);
            if (!this.element) {
                this.element = doc.createElement('div'); this.element.id = `bpb-vector-slot-${id}-${basemap.id}`;
                elements.set(basemap.id, this.element); pane.append(this.element);
            }
            this.element.className = 'bpb-vector-slot'; this.element.hidden = false; this.element.style.opacity = '0';
            this.surface = this.element.querySelector('canvas') || doc.createElement('canvas');
            this.surface.className = 'leaflet-zoom-animated bpb-vector-surface'; this.element.prepend(this.surface);
            this.surface.setAttribute('aria-hidden', 'true');
            this.context = this.surface.getContext('bitmaprenderer') || this.surface.getContext('2d');
            this.painted = null;
            this.update();
        },
        onRemove() {
            win.cancelAnimationFrame(this.motion!); this.element!.hidden = true; this.element!.className = 'bpb-vector-parked';
            this.clearPaint();
            if (!replacing) post('stop');
        },
        getEvents() { return { move: this.moving, moveend: this.update, resize: this.update, zoomanim: this.animateZoom }; },
        moving() {
            if (paused || map._animatingZoom || this.motion != null) return;
            this.motion = win.requestAnimationFrame(() => { this.motion = null; if (!paused && !map._animatingZoom) this.update(); });
        },
        clearPaint() { this.painted = null; if (this.surface) { this.surface.width = 0; this.surface.height = 0; } },
        paintedCenter(this: VectorLayerInstance, paint: VectorPaint = this.painted!) {
            const center = L.latLng(paint.view.center);
            center.lng += Math.round((map.getCenter().lng - center.lng) / 360) * 360;
            return center;
        },
        geometry(paint: VectorPaint) {
            const scale = map.getZoomScale(map.getZoom(), paint.view.zoom + 1), size = L.point(paint.width, paint.height).multiplyBy(scale);
            const offset = map.latLngToLayerPoint(this.paintedCenter(paint)).subtract(size.multiplyBy(.5));
            const origin = map.layerPointToContainerPoint(offset), viewport = map.getSize();
            const width = Math.max(0, Math.min(viewport.x, origin.x + size.x) - Math.max(0, origin.x));
            const height = Math.max(0, Math.min(viewport.y, origin.y + size.y) - Math.max(0, origin.y));
            return { scale, offset, coverage: width * height / (viewport.x * viewport.y), zoomError: Math.abs(map.getZoom() - paint.view.zoom - 1) };
        },
        position() {
            if (!this.painted) return;
            const { offset, scale } = this.geometry(this.painted);
            L.DomUtil.setTransform(this.surface!, offset.subtract(this.hostPosition), scale);
        },
        paint(data: PaintMessage) {
            const paint = readVectorPaint(data);
            if (!paint || map._animatingZoom) { data.bitmap.close(); return false; }
            const incoming = this.geometry(paint), current = this.painted && this.geometry(this.painted);
            // A coupled older view is useful during a fast pan. Keep it unless
            // it would replace better coverage/resolution after a reversal.
            if (!Number.isFinite(incoming.coverage) || !current && !(incoming.coverage >= .999)
                || current && (incoming.coverage + 1e-6 < current.coverage
                    || Math.abs(incoming.coverage - current.coverage) < 1e-6 && incoming.zoomError > current.zoomError)) {
                data.bitmap.close(); return false;
            }
            if (!this.context) throw new Error('Vector map canvas unavailable.');
            if (this.surface!.width !== data.bitmap.width) this.surface!.width = data.bitmap.width;
            if (this.surface!.height !== data.bitmap.height) this.surface!.height = data.bitmap.height;
            this.surface!.style.width = `${paint.width}px`; this.surface!.style.height = `${paint.height}px`;
            const context = this.context as ImageBitmapRenderingContext & CanvasRenderingContext2D;
            if (typeof context.transferFromImageBitmap === 'function') context.transferFromImageBitmap(data.bitmap);
            else { context.clearRect(0, 0, this.surface!.width, this.surface!.height); context.drawImage(data.bitmap, 0, 0); data.bitmap.close(); }
            // Image and camera change in this one task. The iframe's later
            // repaint can never be exposed under an earlier Leaflet transform.
            this.painted = paint; this.position(); return true;
        },
        update() {
            if (!this.element) return;
            // Overscan lets Leaflet translate this layer with its native panes
            // during a drag. Refresh at most once per paint so a long drag
            // cannot exhaust that buffer and expose an empty strip.
            const viewport = map.getSize(), padding = viewport.multiplyBy(.25).round();
            const size = viewport.add(padding.multiplyBy(2));
            // Keep the rendering document in the viewport. Chromium throttles
            // a cross-origin iframe moved offscreen by an older painted camera.
            // Only the visible surface follows that camera; its hidden renderer
            // must keep painting so a distant pan can replace the old image.
            this.hostPosition = map.containerPointToLayerPoint(padding.multiplyBy(-1));
            L.DomUtil.setPosition(this.element, this.hostPosition);
            this.position();
            this.element.style.width = `${size.x}px`; this.element.style.height = `${size.y}px`;
            // Leaving 3D moves the camera before the native map is shown.
            if (paused) dropStalePaint();
            else post('view', view());
        },
        animateZoom(event: LeafletZoomEvent) {
            if (!this.painted) return;
            const scale = map.getZoomScale(event.zoom, this.painted.view.zoom + 1);
            const offset = map._latLngToNewLayerPoint(this.paintedCenter(), event.zoom, event.center).subtract(L.point(this.painted.width, this.painted.height).multiplyBy(.5 * scale));
            L.DomUtil.setTransform(this.surface!, offset.subtract(this.hostPosition), scale);
        },
    });
    // 3D may have moved the camera off the kept paint or far past its detail.
    // Native tiles then cover the map until a full vector paint replaces them,
    // which after the renderer's keep-alive is a cold start.
    const dropStalePaint = () => {
        const painted = layer?.painted && layer.geometry(layer.painted);
        if (!painted || painted.coverage >= .999 && painted.zoomError < 1) return;
        layer!.clearPaint(); layer!.element!.style.opacity = '0'; restore();
    };
    const stop = () => {
        win.clearTimeout(retryTimer!); retryTimer = null;
        if (layer) map.removeLayer(layer);
        layer = null; restore(); status.hidden = true; select.removeAttribute('aria-busy');
    };
    const start = (retrying = false, selected = basemap) => {
        replacing = true; stop(); replacing = false; basemap = selected; retry.dataset.bpbVectorBasemap = basemap.id; renderCredits();
        paused = false; pending(retrying); layer = new VectorLayer().addTo(map) as VectorLayerInstance;
    };
    const change = (event: Event) => {
        const selected = vectorBasemap(select.value);
        if (selected) {
            // Peakbagger's switch has no such code. Do not let it remove its
            // native basemap or serialize an unsupported layer into its links.
            event.stopImmediatePropagation();
            if (!event.isTrusted) { if (!layer) select.value = previous; return; }
            start(false, selected);
        } else { stop(); previous = select.value; }
    };
    const retryClick = (event: Event) => { if (event.isTrusted && !readRetryAt(cooldowns.get(basemap.id)) && retry.getAttribute('aria-disabled') !== 'true') { select.value = basemap.code; start(true); } };
    const receive = (event: MessageEvent) => {
        const data = event.data;
        if (event.source !== win || event.origin !== win.location.origin || data?.[VECTOR_MESSAGE] !== true
            || data.dir !== 'toPage' || data.id !== id) return;
        if (data.type === 'painted' && typeof win.ImageBitmap === 'function' && data.bitmap instanceof win.ImageBitmap) {
            if (!layer || paused || data.basemap !== basemap.id) { data.bitmap.close(); return; }
            try { if (!layer.paint(data)) return; }
            catch { data.bitmap.close(); post('stop'); unavailable(); return; }
            layer.element!.style.opacity = '1'; holdNative(); status.hidden = true; select.removeAttribute('aria-busy');
            if (doc.activeElement === retry) select.focus({ preventScroll: true });
        } else if (data.type === 'error' && layer && !paused && data.basemap === basemap.id) unavailable(data.retryAt);
    };
    const unavailable = (retryAt?: unknown) => {
        cooldowns.set(basemap.id, Math.max(cooldowns.get(basemap.id) || 0, readRetryAt(retryAt) || 0));
        stop(); select.value = previous; status.hidden = false; retry.hidden = false; dismiss.hidden = false; cooldown();
    };
    // 3D covers this map only once its frame is ready. Until then the 2D paint
    // stays on screen: restoring native tiles here would flash an empty map and
    // request raster imagery nobody sees. The last paint also stays in place,
    // hidden with the native map, so returning from 3D never shows a blank map.
    const pause = () => {
        if (!layer || paused) return;
        paused = true; post('pause'); status.hidden = true; select.removeAttribute('aria-busy');
    };
    const resume = () => {
        if (!layer || !paused) return;
        dropStalePaint();
        paused = false;
        if (!layer.painted) pending();
        layer.update(); post('resume', view());
    };
    // Lend 3D a copy of what is on screen, to drape until its own tiles arrive.
    // Missing or refused, 3D simply starts without it.
    const lendPaint = () => {
        const paint = layer?.painted, surface = layer?.surface;
        if (!paint || paused || !surface?.width || !surface.height) return;
        void win.createImageBitmap(surface).then(bitmap => {
            try { win.parent.postMessage({ __bpbTerrain: true, dir: 'toCS', type: 'drape', bitmap, ...paint }, win.location.origin, [bitmap]); }
            catch { bitmap.close(); }
        }, () => {});
    };
    const terrain = (event: MessageEvent) => {
        if (event.source !== win.parent || event.origin !== win.location.origin || event.data?.__bpbTerrain !== true) return;
        const { dir, type } = event.data;
        // A 'loaded' already queued when the user cancels can arrive after
        // 'destroy'; only a launch still open may take the map from 2D.
        if (dir === 'toCS' && type === 'init') { launching = true; lendPaint(); }
        if (dir === 'toPage' && type === 'loaded' && launching) { launching = false; pause(); }
        if (dir === 'toCS' && type === 'destroy') { launching = false; resume(); }
    };
    // Capture runs before the native select's inline onchange handler.
    select.addEventListener('change', change, true); retry.addEventListener('click', retryClick);
    const dismissError = () => { status.hidden = true; select.focus({ preventScroll: true }); };
    dismiss.addEventListener('click', dismissError);
    win.addEventListener('message', receive);
    try { win.parent.addEventListener('message', terrain); } catch { /* Standalone map. */ }
    const dispose = () => {
        if (disposed) return; disposed = true;
        win.clearTimeout(retryTimer!);
        stop(); post('dispose'); for (const element of elements.values()) element.remove(); elements.clear();
        if (vectorBasemap(select.value)) select.value = previous;
        for (const option of options) option.remove(); status.remove(); credits.remove(); logo.remove(); creditResize.disconnect();
        container.style.removeProperty('--bpb-vector-credit-height');
        if (select.style.width === reservedPickerWidth) select.style.width = previousWidth;
        if (surround?.dataset.bpbVectorPicker === id) {
            if (previousSurroundId === undefined) delete surround.dataset.bpbVectorPicker;
            else surround.dataset.bpbVectorPicker = previousSurroundId;
        }
        if (previousId === undefined) delete select.dataset.bpbVectorMap; else select.dataset.bpbVectorMap = previousId;
        select.removeEventListener('change', change, true); retry.removeEventListener('click', retryClick); win.removeEventListener('message', receive);
        select.removeEventListener('keydown', pickerKey);
        dismiss.removeEventListener('click', dismissError);
        try { win.parent.removeEventListener('message', terrain); } catch { /* Standalone map. */ }
        map.off('unload', dispose);
    };
    map.on('unload', dispose);
    return { dispose, reset() { stop(); select.value = previous; }, select, map };
}

export function installVectorMaps(win = window as LeafletWindow) {
    const bindings = new Map<LeafletMap, VectorBinding>(), unloaded = new WeakSet<LeafletMap>(); let timer: number | null = null, active = true;
    const scan = () => {
        if (!active || !win.L?.Layer || !win.L?.GridLayer || !win.L?.CRS?.EPSG3857) return;
        for (const [map, binding] of bindings) if (!map.getContainer().isConnected || !binding.select.isConnected) { binding.dispose(); bindings.delete(map); }
        const maps = new Set<LeafletMap | undefined>([win.mapsPlaceholder, win.map, ...win[Symbol.for('bpb.leafletMaps')] || []]);
        for (const map of maps) {
            if (!map?.getContainer || !map.getContainer().isConnected || bindings.has(map) || unloaded.has(map)
                || map.options?.crs !== win.L.CRS.EPSG3857) continue;
            const select = (map.getContainer().querySelector('#selmap') || win.document.getElementById('selmap')) as HTMLSelectElement | null;
            if (select && !select.dataset.bpbVectorMap) {
                bindings.set(map, bindVectorMap(win, map, select));
                map.once('unload', () => { unloaded.add(map); bindings.delete(map); });
            }
        }
    };
    const schedule = () => { if (timer === null) timer = win.setTimeout(() => { timer = null; scan(); }, 0); };
    const observer = new win.MutationObserver(schedule);
    observer.observe(win.document.documentElement, { childList: true, subtree: true });
    win.addEventListener('bpb-map-ready', schedule); scan();
    return createPageLifecycle({ ownerWindow: win,
        onSuspend() { active = false; for (const binding of bindings.values()) binding.reset(); },
        onResume() { active = true; scan(); },
        onDispose() {
            active = false; observer.disconnect(); clearTimeout(timer!); win.removeEventListener('bpb-map-ready', schedule);
            for (const binding of bindings.values()) binding.dispose(); bindings.clear();
        },
    });
}
if (typeof window !== 'undefined') installVectorMaps();
