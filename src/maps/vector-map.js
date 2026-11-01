// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { VECTOR_BASEMAP, VECTOR_MESSAGE, readVectorView } from './vector-basemap.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';

export function bindVectorMap(win, map, select) {
    const L = win.L, doc = win.document, container = map.getContainer();
    const id = win.crypto.randomUUID(), native = [], previousId = select.dataset.bpbVectorMap;
    const option = doc.createElement('option'); option.value = VECTOR_BASEMAP.code; option.textContent = VECTOR_BASEMAP.name;
    select.append(option); select.dataset.bpbVectorMap = id;
    const previousMinWidth = select.style.minWidth, pickerStyle = win.getComputedStyle(select);
    const metrics = doc.createElement('canvas').getContext('2d');
    metrics.font = `${pickerStyle.fontStyle} ${pickerStyle.fontWeight} ${pickerStyle.fontSize} ${pickerStyle.fontFamily}`;
    // Firefox can defer the new option's intrinsic width until selection.
    // Reserve its label and native arrow before interaction, bounded to the map.
    const pickerMinWidth = `min(${Math.ceil(metrics.measureText(VECTOR_BASEMAP.name).width + 40)}px, calc(100vw - 20px))`;
    select.style.minWidth = pickerMinWidth;
    const reservedPickerWidth = select.style.minWidth;
    let previous = select.value, layer = null, paused = false, replacing = false, disposed = false, attributionReservation = null, center, size, zoom;
    const status = doc.createElement('div'); status.className = 'bpb-vector-status'; status.hidden = true;
    const message = doc.createElement('span'); message.setAttribute('role', 'status');
    const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.dataset.bpbVectorMap = id;
    const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Dismiss vector map error');
    status.append(retry, message, dismiss); container.append(status);
    L.DomEvent.disableClickPropagation(status);
    const credits = doc.createElement('div'); credits.className = 'leaflet-control-attribution bpb-vector-credits';
    const creditLink = (href, text) => { const link = doc.createElement('a'); link.href = href; link.textContent = text; return link; };
    credits.append(creditLink('https://openfreemap.org', 'OpenFreeMap'), ' © ',
        creditLink('https://openmaptiles.org', 'OpenMapTiles'), ', data from ',
        creditLink('https://www.openstreetmap.org/copyright', 'OpenStreetMap'));
    credits.hidden = true; container.append(credits);
    L.DomEvent.disableClickPropagation(credits);
    const pickerKey = event => event.stopPropagation();
    // Some native shells place the picker inside Leaflet's keyboard target.
    // Arrow keys belong to that picker while it has focus, not to map panning.
    select.addEventListener('keydown', pickerKey);
    const post = (type, view) => win.postMessage({ [VECTOR_MESSAGE]: true, dir: 'toCS', id, type, view }, win.location.origin);
    const view = () => {
        const point = map.getCenter().wrap();
        return readVectorView({ center: [point.lat, point.lng], zoom: map.getZoom() - 1 });
    };
    const pending = (retrying = false) => {
        status.hidden = false; message.textContent = 'Loading vector map…'; retry.hidden = !retrying; dismiss.hidden = true;
        retry.setAttribute('aria-disabled', String(retrying)); select.setAttribute('aria-busy', 'true');
    };
    const restore = () => {
        for (const item of native.splice(0)) if (!map.hasLayer(item)) map.addLayer(item);
        if (attributionReservation) { attributionReservation.element.style.minHeight = attributionReservation.minHeight; attributionReservation = null; }
        credits.hidden = true;
    };
    const holdNative = () => {
        const attribution = map.attributionControl?.getContainer();
        if (attribution && !attributionReservation) {
            attributionReservation = { element: attribution, minHeight: attribution.style.minHeight };
            attribution.style.minHeight = `${attribution.offsetHeight}px`;
        }
        map.eachLayer(item => {
            if (item instanceof L.GridLayer && !item.options?.bpbOverlay && (!item.options?.pane || item.options.pane === 'tilePane')) {
                native.push(item); map.removeLayer(item);
            }
        });
        // Credits wrap independently of Leaflet's bottom-right control stack.
        // The zoom buttons retain their native position even on narrow maps.
        credits.hidden = false;
    };
    const VectorLayer = L.Layer.extend({
        options: { bpbVector: true },
        onAdd() {
            const pane = map.getPane('bpb-vector') || map.createPane('bpb-vector');
            pane.style.zIndex = '201'; pane.style.pointerEvents = 'none';
            this.element = doc.createElement('div'); this.element.className = 'leaflet-zoom-animated bpb-vector-slot';
            this.element.id = `bpb-vector-slot-${id}`; this.element.style.opacity = '0'; pane.append(this.element);
            this.update();
        },
        onRemove() { win.cancelAnimationFrame(this.motion); this.element.remove(); if (!replacing) post('stop'); },
        getEvents() { return { move: this.moving, moveend: this.update, resize: this.update, zoomanim: this.animateZoom }; },
        moving() {
            if (paused || map._animatingZoom || this.motion != null) return;
            this.motion = win.requestAnimationFrame(() => { this.motion = null; this.update(); });
        },
        update() {
            if (!this.element) return;
            // Overscan lets Leaflet translate this layer with its native panes
            // during a drag. Refresh at most once per paint so a long drag
            // cannot exhaust that buffer and expose an empty strip.
            const viewport = map.getSize(), padding = viewport.multiplyBy(.25).round();
            size = viewport.add(padding.multiplyBy(2)); center = map.getCenter(); zoom = map.getZoom();
            L.DomUtil.setPosition(this.element, map.containerPointToLayerPoint(padding.multiplyBy(-1)));
            this.element.style.width = `${size.x}px`; this.element.style.height = `${size.y}px`;
            if (!paused) post('view', view());
        },
        animateZoom(event) {
            const scale = map.getZoomScale(event.zoom, zoom);
            const offset = map._latLngToNewLayerPoint(center, event.zoom, event.center).subtract(size.multiplyBy(.5 * scale));
            L.DomUtil.setTransform(this.element, offset, scale);
        },
    });
    const stop = () => {
        if (layer) map.removeLayer(layer);
        layer = null; restore(); status.hidden = true; select.removeAttribute('aria-busy');
    };
    const start = (retrying = false) => { replacing = true; stop(); replacing = false; paused = false; pending(retrying); layer = new VectorLayer().addTo(map); };
    const change = event => {
        if (select.value === VECTOR_BASEMAP.code) {
            // Peakbagger's switch has no such code. Do not let it remove its
            // native basemap or serialize an unsupported layer into its links.
            event.stopImmediatePropagation();
            if (!event.isTrusted) { if (!layer) select.value = previous; return; }
            start();
        } else { stop(); previous = select.value; }
    };
    const retryClick = event => { if (event.isTrusted && retry.getAttribute('aria-disabled') !== 'true') { select.value = VECTOR_BASEMAP.code; start(true); } };
    const receive = event => {
        const data = event.data;
        if (event.source !== win || event.origin !== win.location.origin || data?.[VECTOR_MESSAGE] !== true
            || data.dir !== 'toPage' || data.id !== id || !layer || paused) return;
        if (data.type === 'loaded') {
            layer.element.style.opacity = '1'; holdNative(); status.hidden = true; select.removeAttribute('aria-busy');
            if (doc.activeElement === retry) select.focus({ preventScroll: true });
        } else if (data.type === 'error') {
            stop(); select.value = previous; status.hidden = false; message.textContent = 'Vector map unavailable.'; retry.hidden = false; dismiss.hidden = false; retry.setAttribute('aria-disabled', 'false');
        }
    };
    const pause = () => {
        if (!layer || paused) return;
        paused = true; post('pause'); layer.element.style.opacity = '0'; restore(); status.hidden = true;
    };
    const resume = () => {
        if (!layer || !paused) return;
        paused = false; pending(); layer.update(); post('resume', view());
    };
    const terrain = event => {
        if (event.source !== win.parent || event.origin !== win.location.origin || event.data?.__bpbTerrain !== true) return;
        if (event.data.dir === 'toCS' && event.data.type === 'init') pause();
        if (event.data.dir === 'toCS' && event.data.type === 'destroy') resume();
    };
    // Capture runs before the native select's inline onchange handler.
    select.addEventListener('change', change, true); retry.addEventListener('click', retryClick);
    const dismissError = () => { status.hidden = true; select.focus({ preventScroll: true }); };
    dismiss.addEventListener('click', dismissError);
    win.addEventListener('message', receive);
    try { win.parent.addEventListener('message', terrain); } catch { /* Standalone map. */ }
    const dispose = () => {
        if (disposed) return; disposed = true;
        stop(); if (select.value === VECTOR_BASEMAP.code) select.value = previous;
        option.remove(); status.remove(); credits.remove();
        if (select.style.minWidth === reservedPickerWidth) select.style.minWidth = previousMinWidth;
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

export function installVectorMaps(win = window) {
    const bindings = new Map(), unloaded = new WeakSet(); let timer = null, active = true;
    const scan = () => {
        if (!active || !win.L?.Layer || !win.L?.GridLayer || !win.L?.CRS?.EPSG3857) return;
        for (const [map, binding] of bindings) if (!map.getContainer().isConnected || !binding.select.isConnected) { binding.dispose(); bindings.delete(map); }
        const maps = new Set([win.mapsPlaceholder, win.map, ...win[Symbol.for('bpb.leafletMaps')] || []]);
        for (const map of maps) {
            if (!map?.getContainer || !map.getContainer().isConnected || bindings.has(map) || unloaded.has(map)
                || map.options?.crs !== win.L.CRS.EPSG3857) continue;
            const select = map.getContainer().querySelector('#selmap') || win.document.getElementById('selmap');
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
            active = false; observer.disconnect(); clearTimeout(timer); win.removeEventListener('bpb-map-ready', schedule);
            for (const binding of bindings.values()) binding.dispose(); bindings.clear();
        },
    });
}
if (typeof window !== 'undefined') installVectorMaps();
