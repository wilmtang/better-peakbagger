// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GPX Analyzer content script.
// Runs in the page's MAIN world (see manifest.json) so it can read the raw GPX
// link and reach into Peakbagger's same-origin MasterMap iframe for the hover
// marker. Chart.js (vendor/chart.umd.min.js) and the pure metrics pipeline
// (src/gpx-metrics.js) are loaded immediately before this file, so the globals
// `Chart` and `BPBGpxMetrics` are available here.
//
// The MAIN world cannot read chrome.storage, so preferences come from the
// isolated-world bridge (src/bridge.js) over window.postMessage. Affected map
// and chart surfaces update live when settings change.

import { gpxMetrics as GpxMetrics } from './gpx-metrics.js';
import { settingsSchema as Schema } from './settings-schema.js';
import { peakMarkers } from './peak-markers.js';
import { terrainBasemap } from './terrain-basemap.js';
import { terrainCamera as TerrainCamera } from './terrain-camera.js';
import { terrainFailure as TerrainFailure } from './terrain-failure.js';

// Chart and tzlookup remain separately-loaded vendor globals (see manifest).
const run = async () => {
    const METERS_PER_MILE = 1609.344;
    const FEET_PER_METER = 3.28084;
    const MAP_VIEWPORT_MIN_WIDTH = Schema.BOUNDS.viewportWidth.min;
    const MAP_VIEWPORT_MAX_WIDTH = Schema.BOUNDS.viewportWidth.max;
    const MAP_VIEWPORT_MIN_HEIGHT = Schema.BOUNDS.viewportHeight.min;
    const MAP_VIEWPORT_MAX_HEIGHT = Schema.BOUNDS.viewportHeight.max;
    const MAP_RESIZE_RAIL_HEIGHT = 18;
    const MAP_RESIZE_PERSIST_DELAY_MS = 400;
    const TERRAIN_LOAD_TIMEOUT_MS = 17000;
    const TERRAIN_CAMERA_TIMEOUT_MS = 1000;

    const parseMapRouteSegments = xml => {
        const segments = [];

        Array.from(xml.querySelectorAll('trkseg')).forEach(segmentNode => {
            let current = [];

            Array.from(segmentNode.children).forEach(node => {
                if (node.localName !== 'trkpt') return;
                const lat = parseFloat(node.getAttribute('lat'));
                const lon = parseFloat(node.getAttribute('lon'));

                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    current.push([lat, lon]);
                    return;
                }

                if (current.length >= 2) segments.push(current);
                current = [];
            });

            if (current.length >= 2) segments.push(current);
        });

        return GpxMetrics.limitMapRouteSegments(segments);
    };

    // === Better Peakbagger: theming + centralized settings (via bridge) ===
    const PALETTES = {
        light: {
            panelBg: '#fafafa', panelBorder: '#cccccc', inputBg: '#ffffff', selBorder: '#cccccc',
            text: '#000000', sub: '#444444', muted: '#777777', faint: '#888888',
            chartText: '#666666', chartGrid: 'rgba(0,0,0,0.1)', axisTitle: '#000000', timeAxis: '#007fb6'
        },
        dark: {
            panelBg: '#23262a', panelBorder: '#3a3f45', inputBg: '#2b2f34', selBorder: '#4a5058',
            text: '#e6e1d8', sub: '#b6b0a6', muted: '#9a948a', faint: '#8b857c',
            chartText: '#b6b0a6', chartGrid: 'rgba(255,255,255,0.12)', axisTitle: '#e6e1d8', timeAxis: '#6ab0de'
        }
    };
    const prefersDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const effectiveTheme = pref => (pref === 'light' || pref === 'dark') ? pref : (prefersDark() ? 'dark' : 'light');

    // Bridge client: swaps settings with the isolated-world bridge over postMessage.
    const BPB = (() => {
        const FALLBACK = { units: 'auto', theme: 'system', enable3dMap: false };
        let settings = null;
        const subs = new Set();
        let resolveReady;
        const ready = new Promise(r => { resolveReady = r; });

        window.addEventListener('message', event => {
            if (event.source !== window || event.origin !== location.origin) return;
            const data = event.data;
            if (!data || data.__bpb !== true || data.dir !== 'toPage' || !data.settings) return;
            settings = data.settings;
            resolveReady(settings);
            subs.forEach(fn => { try { fn(settings); } catch (e) { /* ignore */ } });
        });

        return {
            init: async () => {
                window.postMessage({ __bpb: true, dir: 'toCS', kind: 'get' }, location.origin);
                await Promise.race([ready, new Promise(r => setTimeout(r, 800))]);
                if (!settings) settings = { ...FALLBACK };
                return settings;
            },
            get: () => settings || FALLBACK,
            set: patch => {
                settings = { ...(settings || FALLBACK), ...patch };
                window.postMessage({ __bpb: true, dir: 'toCS', kind: 'set', patch }, location.origin);
            },
            subscribe: fn => { subs.add(fn); return () => subs.delete(fn); }
        };
    })();

    const detectPageMetric = () => {
        const elevTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Elevation:');
        return !!(elevTd && elevTd.nextElementSibling && /^[\d,.]+\s*m/.test(elevTd.nextElementSibling.textContent.trim()));
    };
    const resolveUnits = s => s.units === 'metric' ? 'metric' : s.units === 'imperial' ? 'imperial' : (detectPageMetric() ? 'metric' : 'imperial');
    // Which series to show on load. Only the initial visibility is bound to the
    // setting; the legend's own click handler toggles visibility for the current
    // view without writing it back, so a temporary peek never changes the pref.
    const resolveChartSeries = s => (s.chartDefaultSeries === 'distance' || s.chartDefaultSeries === 'time') ? s.chartDefaultSeries : 'both';
    // Settings arrive over postMessage, so they are re-validated here rather
    // than trusted; the shared schema keeps those checks identical to the ones
    // src/settings.js applies on the way into storage.
    const resolveMapRouteStyle = Schema.routeStyleFromSettings;
    const resolveMapViewportSize = Schema.viewportSizeFromSettings;
    const resolveTerrainCacheLimitMb = settings => Schema.terrainCacheLimitMb(settings.terrainCacheLimitMb);

    const initChart = async () => {
        // 1. Locate GPX link and build UI. The link text is the primary signal;
        // match the href (GPXFile.aspx, plus the legacy GetAscentGPX.aspx) as a
        // fallback so a future rewording does not silently disable the analyzer.
        const gpxLink = Array.from(document.querySelectorAll('a')).find(a =>
            a.textContent.includes('Download this GPS track')
            || /GPXFile\.aspx|GetAscentGPX\.aspx/i.test(a.getAttribute('href') || ''));
        if (!gpxLink) return;

        await BPB.init();
        let appliedSettings = { ...BPB.get() };

        const mapIframe = document.querySelector('iframe[src*="MasterMap.aspx"], iframe[src*="mastermap.aspx"]');
        let mapViewport = null;
        let mapResizeHandle = null;
        let mapViewportSize = resolveMapViewportSize(BPB.get());
        let mapInvalidateFrame = null;

        const renderedMapWidth = () => {
            if (!mapViewport) return mapViewportSize.width;
            const width = mapViewport.getBoundingClientRect().width;
            return width > 0 ? Math.round(width) : mapViewportSize.width;
        };

        const syncMapResizeHandleLabel = () => {
            if (!mapResizeHandle) return;
            mapResizeHandle.setAttribute('aria-label', `Resize map. Current size ${renderedMapWidth()} pixels wide by ${mapViewportSize.height} pixels high. Use arrow keys for small steps.`);
        };

        const scheduleMapInvalidate = () => {
            if (!mapIframe || mapInvalidateFrame !== null) return;
            const invalidate = () => {
                mapInvalidateFrame = null;
                try {
                    const map = mapIframe.contentWindow && mapIframe.contentWindow.mapsPlaceholder;
                    if (map && typeof map.invalidateSize === 'function') map.invalidateSize(false);
                } catch (e) { /* Peakbagger may replace or discard its map while resizing. */ }
                // Re-anchor the floating toggle: the native zoom's position (2D)
                // and the viewport size can change as the map settles or resizes.
                positionTerrainToggle();
            };
            mapInvalidateFrame = typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame(invalidate)
                : setTimeout(invalidate, 0);
        };

        const applyMapViewportSize = size => {
            mapViewportSize = {
                width: Math.min(MAP_VIEWPORT_MAX_WIDTH, Math.max(MAP_VIEWPORT_MIN_WIDTH, Math.round(size.width))),
                height: Math.min(MAP_VIEWPORT_MAX_HEIGHT, Math.max(MAP_VIEWPORT_MIN_HEIGHT, Math.round(size.height)))
            };
            if (!mapViewport) return;
            mapViewport.style.width = `${mapViewportSize.width}px`;
            mapViewport.style.height = `${mapViewportSize.height + MAP_RESIZE_RAIL_HEIGHT}px`;
            syncMapResizeHandleLabel();
            scheduleMapInvalidate();
        };

        let mapViewportPersistTimer = null;
        const persistMapViewportSize = () => {
            if (mapViewportPersistTimer !== null) {
                clearTimeout(mapViewportPersistTimer);
                mapViewportPersistTimer = null;
            }
            BPB.set({
                mapViewportWidth: mapViewportSize.width,
                mapViewportHeight: mapViewportSize.height
            });
            appliedSettings = { ...BPB.get() };
        };

        // Keyboard resize fires per key repeat; persisting each step would
        // burn through chrome.storage.sync's write-per-minute quota and the
        // final size could silently fail to stick. Persist once, shortly
        // after the last keystroke.
        const schedulePersistMapViewportSize = () => {
            if (mapViewportPersistTimer !== null) clearTimeout(mapViewportPersistTimer);
            mapViewportPersistTimer = setTimeout(() => {
                mapViewportPersistTimer = null;
                persistMapViewportSize();
            }, MAP_RESIZE_PERSIST_DELAY_MS);
        };

        if (mapIframe && mapIframe.parentElement) {
            mapViewport = document.createElement('div');
            mapViewport.id = 'bpb-map-viewport';
            Object.assign(mapViewport.style, {
                position: 'relative',
                maxWidth: '100%',
                minWidth: 'min(320px, 100%)',
                minHeight: `${MAP_VIEWPORT_MIN_HEIGHT + MAP_RESIZE_RAIL_HEIGHT}px`,
                maxHeight: `${MAP_VIEWPORT_MAX_HEIGHT + MAP_RESIZE_RAIL_HEIGHT}px`,
                boxSizing: 'border-box'
            });

            mapIframe.before(mapViewport);
            mapViewport.append(mapIframe);
            Object.assign(mapIframe.style, {
                display: 'block',
                width: '100%',
                maxWidth: '100%',
                height: `calc(100% - ${MAP_RESIZE_RAIL_HEIGHT}px)`,
                boxSizing: 'border-box'
            });

            mapResizeHandle = document.createElement('button');
            mapResizeHandle.id = 'bpb-map-resize-handle';
            mapResizeHandle.type = 'button';
            mapResizeHandle.title = 'Drag to resize map';
            mapResizeHandle.textContent = '◢';
            Object.assign(mapResizeHandle.style, {
                position: 'absolute',
                right: '0',
                bottom: '0',
                width: '24px',
                height: `${MAP_RESIZE_RAIL_HEIGHT}px`,
                padding: '0',
                border: '0',
                background: 'transparent',
                color: 'currentColor',
                lineHeight: `${MAP_RESIZE_RAIL_HEIGHT}px`,
                cursor: 'nwse-resize',
                opacity: '0.72'
            });
            mapViewport.append(mapResizeHandle);

            let drag = null;
            mapResizeHandle.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                const parentRect = mapViewport.parentElement.getBoundingClientRect();
                const viewportRect = mapViewport.getBoundingClientRect();
                const parentWidth = parentRect.width;
                const viewportWidth = viewportRect.width;
                if (!(parentWidth > 0) || !(viewportWidth > 0)) return;
                const leftGap = viewportRect.left - parentRect.left;
                const rightGap = parentRect.right - viewportRect.right;
                drag = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    startWidth: viewportWidth,
                    startHeight: mapViewportSize.height,
                    parentWidth,
                    // Peakbagger centers its fixed-width map. In that layout a
                    // 1 px pointer movement moves the right edge only 0.5 px
                    // unless the requested width changes by 2 px.
                    widthScale: Number.isFinite(leftGap) && Number.isFinite(rightGap) && Math.abs(leftGap - rightGap) <= 2 ? 2 : 1
                };
                if (mapResizeHandle.setPointerCapture) mapResizeHandle.setPointerCapture(event.pointerId);
                event.preventDefault();
            });
            mapResizeHandle.addEventListener('pointermove', event => {
                if (!drag || event.pointerId !== drag.pointerId) return;
                const minWidth = Math.min(drag.parentWidth, MAP_VIEWPORT_MIN_WIDTH);
                const widthPx = Math.min(MAP_VIEWPORT_MAX_WIDTH, drag.parentWidth, Math.max(minWidth, drag.startWidth + (event.clientX - drag.startX) * drag.widthScale));
                applyMapViewportSize({
                    width: widthPx,
                    height: drag.startHeight + event.clientY - drag.startY
                });
            });
            const finishDrag = event => {
                if (!drag || event.pointerId !== drag.pointerId) return;
                if (mapResizeHandle.releasePointerCapture && mapResizeHandle.hasPointerCapture && mapResizeHandle.hasPointerCapture(event.pointerId)) {
                    mapResizeHandle.releasePointerCapture(event.pointerId);
                }
                drag = null;
                persistMapViewportSize();
            };
            mapResizeHandle.addEventListener('pointerup', finishDrag);
            mapResizeHandle.addEventListener('pointercancel', finishDrag);
            mapResizeHandle.addEventListener('keydown', event => {
                const largeStep = event.shiftKey;
                let next = { ...mapViewportSize };
                if (event.key === 'ArrowLeft') next.width = renderedMapWidth() - (largeStep ? 50 : 10);
                else if (event.key === 'ArrowRight') next.width = renderedMapWidth() + (largeStep ? 50 : 10);
                else if (event.key === 'ArrowUp') next.height -= largeStep ? 50 : 10;
                else if (event.key === 'ArrowDown') next.height += largeStep ? 50 : 10;
                else return;
                event.preventDefault();
                applyMapViewportSize(next);
                schedulePersistMapViewportSize();
            });

            applyMapViewportSize(mapViewportSize);
            window.addEventListener('resize', scheduleMapInvalidate);
            if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
                syncMapResizeHandleLabel();
                scheduleMapInvalidate();
            }).observe(mapViewport);
        }

        const container = document.createElement('div');
        container.id = 'bpb-gpx-analysis';
        Object.assign(container.style, { marginTop: '15px', padding: '10px', border: '1px solid #ccc', background: '#fafafa', borderRadius: '5px', maxWidth: '800px' });

        const headerBox = document.createElement('div');
        Object.assign(headerBox.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' });

        const statsContainer = document.createElement('div');
        const stats = document.createElement('div');
        Object.assign(stats.style, { fontFamily: 'sans-serif', fontWeight: 'bold' });
        stats.textContent = "Analyzing GPX data...";

        const subStats = document.createElement('div');
        Object.assign(subStats.style, { fontFamily: 'sans-serif', fontSize: '0.9em', color: '#444', marginTop: '4px', fontStyle: 'italic' });

        statsContainer.append(stats, subStats);

        const controlsContainer = document.createElement('div');
        Object.assign(controlsContainer.style, { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' });

        const unitSelect = document.createElement('select');
        Object.assign(unitSelect.style, { padding: '2px 6px', borderRadius: '4px', border: '1px solid #ccc', cursor: 'pointer', outline: 'none' });
        const unitOption = (value, label) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            return option;
        };
        unitSelect.append(unitOption('imperial', 'Imperial'), unitOption('metric', 'Metric'));

        // A floating control on the map itself (bottom-right, stacked just above
        // the zoom controls), styled by src/terrain-map.css. Clicking flips the
        // map between 2D and 3D in place. Placed into the map viewport below so
        // it overlays both the native map and the terrain frame.
        const terrainButton = document.createElement('button');
        terrainButton.id = 'bpb-terrain-toggle';
        terrainButton.className = 'bpb-map-3d-toggle';
        terrainButton.type = 'button';
        terrainButton.disabled = true;
        terrainButton.textContent = '3D';
        terrainButton.title = 'Available after the GPX route loads';
        terrainButton.setAttribute('aria-label', '3D terrain available after the route loads');
        terrainButton.setAttribute('aria-pressed', 'false');

        const routeStyleControls = document.createElement('div');
        Object.assign(routeStyleControls.style, { display: 'flex', gap: '8px', marginTop: '7px', fontSize: '0.8em' });

        const createColorControl = (id, text) => {
            const label = document.createElement('label');
            Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
            label.htmlFor = id;
            const caption = document.createElement('span');
            caption.textContent = text;
            const input = document.createElement('input');
            input.id = id;
            input.type = 'color';
            input.setAttribute('aria-label', `${text} color`);
            Object.assign(input.style, { width: '26px', height: '22px', padding: '2px', border: '1px solid #ccc', borderRadius: '5px', cursor: 'pointer' });
            label.append(caption, input);
            routeStyleControls.append(label);
            return { label, input };
        };

        const routeColorControl = createColorControl('bpb-map-route-color', 'Route');
        const routeCasingColorControl = createColorControl('bpb-map-route-casing-color', 'Casing');

        const hintText = document.createElement('div');
        Object.assign(hintText.style, { fontSize: '0.8em', color: '#888', marginTop: '4px', fontStyle: 'italic' });
        hintText.textContent = "Double-click point to copy coordinates";

        controlsContainer.append(unitSelect, routeStyleControls, hintText);
        headerBox.append(statsContainer, controlsContainer);
        // The 3D/2D toggle floats over the map, not in the panel below it. If
        // there is no map viewport there is no native map to overlay, so the
        // control simply stays out of the DOM (terrain is unavailable anyway).
        if (mapViewport) mapViewport.append(terrainButton);

        const terrainMessage = document.createElement('div');
        terrainMessage.id = 'bpb-terrain-message';
        terrainMessage.setAttribute('role', 'status');
        terrainMessage.setAttribute('aria-live', 'polite');
        Object.assign(terrainMessage.style, {
            display: 'none', margin: '0 0 10px', padding: '7px 9px', borderRadius: '6px',
            fontFamily: 'sans-serif', fontSize: '0.88em'
        });

        const canvasContainer = document.createElement('div');
        Object.assign(canvasContainer.style, { position: 'relative', height: '300px', width: '100%' });

        const canvas = document.createElement('canvas');
        canvasContainer.append(canvas);
        container.append(headerBox, terrainMessage, canvasContainer);
        const fullScreenMapLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('Full Screen Map'));
        if (fullScreenMapLink) fullScreenMapLink.before(container);
        else gpxLink.after(container);

        // Panel palette follows the current theme setting; re-applied on render.
        const panelPalette = () => PALETTES[effectiveTheme(BPB.get().theme)];
        const applyPanelTheme = () => {
            const p = panelPalette();
            // The floating toggle is styled by CSS; steer its light/dark variant
            // with the extension theme, mirroring the terrain frame.
            terrainButton.dataset.theme = effectiveTheme(BPB.get().theme);
            Object.assign(container.style, { background: p.panelBg, borderColor: p.panelBorder, color: p.text });
            Object.assign(unitSelect.style, { background: p.inputBg, color: p.text, borderColor: p.selBorder });
            [routeColorControl, routeCasingColorControl].forEach(control => {
                control.label.style.color = p.sub;
                Object.assign(control.input.style, { background: p.inputBg, borderColor: p.selBorder });
            });
            stats.style.color = p.text;
            subStats.style.color = p.sub;
            hintText.style.color = p.faint;
        };
        applyPanelTheme();

        canvas.addEventListener('dblclick', (e) => {
            if (!chartInstance) return;
            const activeElements = chartInstance.getElementsAtEventForMode(e, chartInstance.options.interaction.mode, chartInstance.options.interaction, true);
            if (activeElements.length > 0) {
                const datasetIndex = activeElements[0].datasetIndex;
                const idx = activeElements[0].index;
                const d = chartInstance.data.datasets[datasetIndex].data[idx]._raw;
                if (d && d.lat !== undefined && d.lon !== undefined) {
                    const text = `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`;
                    navigator.clipboard.writeText(text).then(() => {
                        const copied = document.createElement('span');
                        Object.assign(copied.style, { color: '#2e8b57', fontWeight: 'bold' });
                        copied.textContent = `✓ Copied: ${text}`;
                        hintText.replaceChildren(copied);
                        setTimeout(() => { hintText.textContent = "Double-click point to copy coordinates"; applyPanelTheme(); }, 2500);
                    }).catch(err => console.error('Failed to copy', err));
                }
            }
        });

        // 2. Formatting Helpers
        // Clock times and day boundaries use the climb's local time, not the
        // viewer's. The track's starting coordinate resolves to an IANA zone
        // via the bundled offline tz-lookup raster (vendor/tz-lookup.js), so
        // Intl applies the political zone and DST rules for the trip's date.
        // If the lookup is unavailable the offset falls back to solar time
        // rounded to the whole hour from the start longitude, and the stats
        // bar labels that estimate. GPX timestamps are UTC; the fallback
        // shifts the epoch and formats in UTC to get the same wall clock.
        // See docs/mountain-local-time.md.
        let mountainTimeZone = null;
        let mountainDayFormatter = null;
        let mountainOffsetMs = 0;
        const mountainZoneLabel = referenceMs => {
            if (mountainTimeZone) {
                try {
                    const part = new Intl.DateTimeFormat([], { timeZone: mountainTimeZone, timeZoneName: 'short' })
                        .formatToParts(referenceMs).find(candidate => candidate.type === 'timeZoneName');
                    if (part && part.value) return part.value;
                } catch (e) { /* Fall back to the zone id itself. */ }
                return mountainTimeZone;
            }
            const hours = Math.round(mountainOffsetMs / 3600000);
            return `UTC${hours < 0 ? '−' : '+'}${Math.abs(hours)}, estimated from longitude`;
        };
        const fmtTime = ms => ms > 0 ? `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m` : '0m';
        // The camping-spot scan asks for the day of every track point, and
        // Intl formatting per point is too slow for full-resolution tracks.
        // Memoize per UTC minute: modern IANA offsets are whole minutes, so a
        // minute bucket never straddles the mountain's local midnight.
        const mountainDayCache = new Map();
        const mountainDayNumber = ms => {
            const key = Math.floor(ms / 60000);
            let dayNumber = mountainDayCache.get(key);
            if (dayNumber === undefined) {
                const [year, month, day] = mountainDayFormatter.format(ms).split('-').map(Number);
                dayNumber = Date.UTC(year, month - 1, day) / 86400000;
                mountainDayCache.set(key, dayNumber);
            }
            return dayNumber;
        };
        const getRelativeDay = (ms, startMs) => mountainDayFormatter
            ? mountainDayNumber(ms) - mountainDayNumber(startMs) + 1
            : Math.floor((ms + mountainOffsetMs) / 86400000) - Math.floor((startMs + mountainOffsetMs) / 86400000) + 1;
        const formatTimeStr = (ms, startMs, isMultiDay) => {
            const timeStr = mountainTimeZone
                ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: mountainTimeZone })
                : new Date(ms + mountainOffsetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
            if (isMultiDay) {
                return `Day ${getRelativeDay(ms, startMs)} ${timeStr}`;
            }
            return timeStr;
        };

        // 3. Centralized unit setting ('auto' detects from the page).
        unitSelect.value = resolveUnits(BPB.get());
        const syncRouteStyleControls = () => {
            const style = resolveMapRouteStyle(BPB.get());
            routeColorControl.input.value = style.color;
            routeCasingColorControl.input.value = style.casingColor;
        };
        syncRouteStyleControls();

        // Processing Arrays & Core Metrics
        let chartInstance = null;
        let chartData = [];
        let metrics = { distanceM: 0, gainM: 0, rawDistanceM: 0, rawGainM: 0 };
        let totalMs = 0, hasTime = false;
        let startMs = 0, endMs = 0, summitMs = 0;
        let campingSpots = [];
        let mapRouteSegments = [];
        let hoverMarker = null;
        let routeOverlay = null;
        let boundMapIframe = null;
        let boundMapLayerSelect = null;
        let mapLayerChangeHandler = null;
        let mapRetryTimer = null;
        let mapLayerRetryTimer = null;
        let terrainState = 'idle';
        let terrainConsentPending = false;
        let terrainLoadTimer = null;
        let terrainNavTop = null;
        let terrainViewCamera = null;
        let terrainStopPending = false;
        let terrainCameraRequestId = 0;

        const nativeLeafletMap = () => {
            try {
                return mapIframe && mapIframe.contentWindow && mapIframe.contentWindow.mapsPlaceholder;
            } catch (error) {
                return null;
            }
        };

        const rememberTerrainCamera = value => {
            const camera = TerrainCamera.clean(value);
            if (camera) terrainViewCamera = camera;
        };

        // Float the toggle just above the zoom stack in whichever map is showing:
        // the 3D frame reports its stack height (it is cross-origin), while the
        // native 2D zoom is same-origin and measured directly. A null result
        // leaves the CSS fallback offset in place.
        const TERRAIN_TOGGLE_GAP = 8;
        const measureNative2dZoomTop = () => {
            try {
                if (!mapViewport || !mapIframe) return null;
                const doc = mapIframe.contentWindow && mapIframe.contentWindow.document;
                const zoom = doc && doc.querySelector('.leaflet-control-zoom');
                const zoomRect = zoom && zoom.getBoundingClientRect();
                if (!zoomRect || !(zoomRect.height > 0)) return null;
                const iframeRect = mapIframe.getBoundingClientRect();
                const viewportRect = mapViewport.getBoundingClientRect();
                return viewportRect.bottom - (iframeRect.top + zoomRect.top);
            } catch (e) {
                return null;
            }
        };
        const positionTerrainToggle = () => {
            let bottom = null;
            if (terrainState === 'active') {
                const frame = document.getElementById('bpb-terrain-frame');
                if (frame && mapViewport && terrainNavTop != null) {
                    const inset = Math.max(0, mapViewport.getBoundingClientRect().bottom - frame.getBoundingClientRect().bottom);
                    bottom = inset + terrainNavTop;
                }
            } else {
                bottom = measureNative2dZoomTop();
            }
            terrainButton.style.bottom = bottom != null && bottom > 0 ? `${Math.round(bottom + TERRAIN_TOGGLE_GAP)}px` : '';
        };

        const clearTerrainLoadTimer = () => {
            if (terrainLoadTimer !== null) {
                clearTimeout(terrainLoadTimer);
                terrainLoadTimer = null;
            }
        };

        const postTerrain = (type, detail = {}) => window.postMessage({
            __bpbTerrain: true,
            dir: 'toCS',
            type,
            ...detail
        }, location.origin);

        const showTerrainMessage = (text, tone = 'info') => {
            if (!text) {
                terrainMessage.style.display = 'none';
                terrainMessage.textContent = '';
                return;
            }
            const dark = effectiveTheme(BPB.get().theme) === 'dark';
            const error = tone === 'error';
            Object.assign(terrainMessage.style, {
                display: 'block',
                color: dark ? '#f1eee7' : '#222222',
                background: error ? (dark ? '#43282a' : '#fff0f0') : (dark ? '#213546' : '#eef4fa'),
                border: `1px solid ${error ? (dark ? '#885359' : '#dfb6b6') : (dark ? '#3e617a' : '#b8c7d9')}`
            });
            terrainMessage.textContent = text;
        };

        const updateTerrainButton = () => {
            const hasRoute = mapRouteSegments.length > 0;
            // The compact glyph ('3D'/'2D') is the label; the full intent lives
            // in the title/aria-label. A spinner class covers the load.
            terrainButton.classList.remove('bpb-map-3d-toggle-loading');
            terrainButton.removeAttribute('aria-busy');
            if (terrainStopPending) {
                terrainButton.disabled = true;
                terrainButton.textContent = '2D';
                terrainButton.title = 'Returning to the 2D map…';
                terrainButton.setAttribute('aria-label', 'Returning to the 2D map');
                terrainButton.setAttribute('aria-pressed', 'true');
            } else if (terrainState === 'loading') {
                terrainButton.disabled = false;
                terrainButton.textContent = '3D';
                terrainButton.classList.add('bpb-map-3d-toggle-loading');
                terrainButton.setAttribute('aria-busy', 'true');
                terrainButton.title = 'Cancel loading 3D terrain';
                terrainButton.setAttribute('aria-label', 'Cancel loading 3D terrain');
                terrainButton.setAttribute('aria-pressed', 'false');
            } else if (terrainState === 'active') {
                terrainButton.disabled = false;
                terrainButton.textContent = '2D';
                terrainButton.title = 'Return to the 2D map';
                terrainButton.setAttribute('aria-label', 'Return to the 2D map');
                terrainButton.setAttribute('aria-pressed', 'true');
            } else {
                terrainButton.disabled = !hasRoute;
                terrainButton.textContent = '3D';
                terrainButton.title = hasRoute ? 'View this route on 3D terrain' : 'Available after the GPX route loads';
                terrainButton.setAttribute('aria-label', hasRoute ? 'Show 3D terrain' : '3D terrain available after the route loads');
                terrainButton.setAttribute('aria-pressed', 'false');
            }
            positionTerrainToggle();
        };

        const restoreNativeMap = () => {
            if (!mapIframe) return;
            mapIframe.style.visibility = 'visible';
            mapIframe.removeAttribute('aria-hidden');
            scheduleMapInvalidate();
        };

        const failTerrain = message => {
            clearTerrainLoadTimer();
            terrainState = 'idle';
            terrainViewCamera = null;
            terrainStopPending = false;
            restoreNativeMap();
            postTerrain('destroy');
            updateTerrainButton();
            showTerrainMessage(message, 'error');
        };

        const startTerrain = (consentGranted = false) => {
            if ((!consentGranted && BPB.get().enable3dMap !== true)
                || terrainState !== 'idle' || !mapViewport || !mapIframe || !mapRouteSegments.length) return;
            terrainState = 'loading';
            // The toggle button's own "Loading 3D…" state is the loading cue;
            // a second full-width banner would be redundant. The message box is
            // reserved for errors and the drape-unsupported notice.
            showTerrainMessage('');
            updateTerrainButton();
            terrainViewCamera = TerrainCamera.fromLeaflet(nativeLeafletMap());
            postTerrain('init', {
                routeSegments: mapRouteSegments,
                routeStyle: resolveMapRouteStyle(BPB.get()),
                theme: effectiveTheme(BPB.get().theme),
                basemap: getTerrainBasemap(),
                basemaps: enumerateTerrainBasemaps(),
                cacheLimitMb: resolveTerrainCacheLimitMb(BPB.get()),
                ...(terrainViewCamera ? { camera: terrainViewCamera } : {})
            });
            terrainLoadTimer = setTimeout(() => {
                if (terrainState === 'loading') failTerrain(TerrainFailure.message('timeout'));
            }, TERRAIN_LOAD_TIMEOUT_MS);
        };

        const finishTerrainStop = () => {
            clearTerrainLoadTimer();
            if (terrainState === 'active' && terrainViewCamera) {
                TerrainCamera.applyToLeaflet(nativeLeafletMap(), terrainViewCamera);
            }
            terrainState = 'idle';
            terrainViewCamera = null;
            terrainStopPending = false;
            restoreNativeMap();
            postTerrain('destroy');
            showTerrainMessage('');
            updateTerrainButton();
        };

        const stopTerrain = () => {
            if (terrainState !== 'active') {
                finishTerrainStop();
                return;
            }
            if (terrainStopPending) return;
            clearTerrainLoadTimer();
            terrainStopPending = true;
            updateTerrainButton();
            terrainCameraRequestId++;
            postTerrain('cameraRequest', { requestId: terrainCameraRequestId });
            terrainLoadTimer = setTimeout(finishTerrainStop, TERRAIN_CAMERA_TIMEOUT_MS);
        };

        const syncTerrainAvailability = settings => {
            const enabled = settings.enable3dMap === true;
            if (!enabled) {
                if (terrainState === 'loading' || terrainState === 'active') stopTerrain();
                else showTerrainMessage('');
            }
            updateTerrainButton();
            if (enabled && terrainConsentPending && terrainState === 'idle') {
                terrainConsentPending = false;
                startTerrain();
            }
        };

        terrainButton.addEventListener('click', () => {
            if (terrainState === 'active' || terrainState === 'loading') {
                stopTerrain();
                return;
            }
            if (terrainState !== 'idle') return;
            if (BPB.get().enable3dMap !== true) {
                if (terrainConsentPending || !mapRouteSegments.length) return;
                terrainConsentPending = true;
                postTerrain('requestConsent');
                return;
            }
            startTerrain();
        });

        // The 3D frame asks for Peakbagger's peak dots as its camera settles;
        // the request is served by the same-origin PLLBB feed the native 2D
        // map uses, with the parameters read from the MasterMap iframe URL. A
        // surface without a usable feed answers `unavailable` once so the
        // frame stops asking.
        let peaksClient = null;
        let peaksClientResolved = false;
        const answerPeaksRequest = data => {
            const requestId = data.requestId;
            if (!Number.isFinite(requestId)) return;
            if (!peaksClientResolved) {
                peaksClientResolved = true;
                peaksClient = peakMarkers && mapIframe
                    ? peakMarkers.createClient(mapIframe.src)
                    : null;
            }
            if (!peaksClient) {
                postTerrain('peaks', { requestId, peaks: [], unavailable: true });
                return;
            }
            peaksClient.request(data.bounds).then(peaks => {
                // A superseded request resolves null and stays silent; the
                // newer request answers instead.
                if (peaks) postTerrain('peaks', { requestId, peaks });
            });
        };

        window.addEventListener('message', event => {
            if (event.source !== window || event.origin !== location.origin) return;
            const data = event.data;
            if (!data || data.__bpbTerrain !== true || data.dir !== 'toPage') return;

            if (data.type === 'consentResult' && terrainConsentPending) {
                terrainConsentPending = false;
                if (data.enabled === true) startTerrain(true);
            } else if (data.type === 'loaded' && terrainState === 'loading') {
                clearTerrainLoadTimer();
                rememberTerrainCamera(data.camera);
                terrainState = 'active';
                terrainNavTop = Number.isFinite(data.navTop) ? data.navTop : null;
                mapIframe.style.visibility = 'hidden';
                mapIframe.setAttribute('aria-hidden', 'true');
                showTerrainMessage('');
                updateTerrainButton();
            } else if (data.type === 'metrics' && terrainState === 'active') {
                if (Number.isFinite(data.navTop)) terrainNavTop = data.navTop;
                positionTerrainToggle();
            } else if (data.type === 'camera' && terrainState === 'active') {
                rememberTerrainCamera(data.camera);
                if (terrainStopPending && data.requestId === terrainCameraRequestId) finishTerrainStop();
            } else if (data.type === 'peaksRequest' && terrainState !== 'idle') {
                answerPeaksRequest(data);
            } else if (data.type === 'error' && terrainState === 'loading') {
                failTerrain(TerrainFailure.message(data.reason));
            }
        });

        syncTerrainAvailability(BPB.get());

        const findMapIframe = () => document.querySelector('iframe[src*="MasterMap.aspx"], iframe[src*="mastermap.aspx"]');

        const removeOverlayLayers = (map, layers) => {
            layers.forEach(layer => {
                try {
                    if (map && typeof map.removeLayer === 'function') map.removeLayer(layer);
                    else if (layer && typeof layer.remove === 'function') layer.remove();
                } catch (e) { /* Peakbagger may already have discarded the old map. */ }
            });
        };

        const removeRouteOverlay = () => {
            if (!routeOverlay) return;
            removeOverlayLayers(routeOverlay.map, routeOverlay.layers);
            routeOverlay = null;
        };

        const findMapLayerSelect = () => {
            try {
                const iframe = findMapIframe();
                const iframeWin = iframe && iframe.contentWindow;
                const select = iframeWin && iframeWin.document && iframeWin.document.getElementById('selmap');
                return select && select.tagName === 'SELECT' ? select : null;
            } catch (e) {
                return null;
            }
        };

        // Drape/basemap logic is shared with the Full Screen BigMap via
        // src/terrain-basemap.js (terrainBasemap) so the 2D layer
        // menu and the 3D drape picker cannot diverge. These wrappers only
        // resolve the Ascent page's MasterMap frame and delegate.
        const getTerrainBasemap = () => {
            const B = terrainBasemap;
            if (!B) return null;
            try {
                const iframe = findMapIframe();
                const iframeWin = iframe && iframe.contentWindow;
                const map = iframeWin && iframeWin.mapsPlaceholder;
                const select = iframeWin && iframeWin.document && iframeWin.document.getElementById('selmap');
                return B.active(iframeWin, map, select);
            } catch (error) { /* Peakbagger may replace or restrict its map frame. */ }
            return null;
        };

        const enumerateTerrainBasemaps = () => {
            const B = terrainBasemap;
            return B ? B.enumerate(findMapLayerSelect()) : [];
        };

        const mapLayerExists = (select, value) =>
            !!value && Array.from(select.options).some(option => option.value === value);

        const syncMapLayerPreference = () => {
            const select = findMapLayerSelect();
            if (!select) return false;

            if (select !== boundMapLayerSelect) {
                if (boundMapLayerSelect && mapLayerChangeHandler) {
                    try { boundMapLayerSelect.removeEventListener('change', mapLayerChangeHandler); } catch (e) { /* old frame discarded */ }
                }
                boundMapLayerSelect = select;
                mapLayerChangeHandler = () => {
                    const settings = BPB.get();
                    if (!settings.rememberMapLayer || !mapLayerExists(select, select.value) || settings.mapLastLayer === select.value) return;
                    BPB.set({ mapLastLayer: select.value });
                    appliedSettings = { ...BPB.get() };
                };
                select.addEventListener('change', mapLayerChangeHandler);
            }

            const settings = BPB.get();
            if (!settings.rememberMapLayer) return true;

            if (mapLayerExists(select, settings.mapLastLayer)) {
                if (select.value !== settings.mapLastLayer) {
                    select.value = settings.mapLastLayer;
                    const iframeWin = select.ownerDocument && select.ownerDocument.defaultView;
                    const ChangeEvent = iframeWin && iframeWin.Event ? iframeWin.Event : window.Event;
                    select.dispatchEvent(new ChangeEvent('change', { bubbles: true }));
                    scheduleMapInvalidate();
                }
            } else if (mapLayerExists(select, select.value)) {
                BPB.set({ mapLastLayer: select.value });
                appliedSettings = { ...BPB.get() };
            }
            return true;
        };

        const ensureRouteOverlay = () => {
            if (!mapRouteSegments.length) return false;

            try {
                const iframe = findMapIframe();
                const iframeWin = iframe ? iframe.contentWindow : null;
                const map = iframeWin && iframeWin.mapsPlaceholder;
                const L = iframeWin && iframeWin.L;
                if (!map || !L || typeof L.polyline !== 'function') return false;

                if (routeOverlay && routeOverlay.map === map && routeOverlay.layers.every(layer => layer && layer._map === map)) {
                    return true;
                }

                removeRouteOverlay();
                const layers = [];

                try {
                    const routeGeometry = mapRouteSegments.length === 1 ? mapRouteSegments[0] : mapRouteSegments;
                    const routeStyle = resolveMapRouteStyle(BPB.get());
                    const outline = L.polyline(routeGeometry, {
                        color: routeStyle.casingColor,
                        weight: routeStyle.casingWidth,
                        opacity: 0.92,
                        interactive: false,
                        lineCap: 'round',
                        lineJoin: 'round',
                        className: 'bpb-route-outline'
                    }).addTo(map);
                    layers.push(outline);
                    const route = L.polyline(routeGeometry, {
                        color: routeStyle.color,
                        weight: routeStyle.width,
                        opacity: 1,
                        interactive: false,
                        lineCap: 'round',
                        lineJoin: 'round',
                        className: 'bpb-route-highlight'
                    }).addTo(map);
                    layers.push(route);

                    // Keep native markers and Peakbagger's own thin route on
                    // top. Calling these in reverse order preserves the white
                    // casing beneath the red line in Leaflet's shared path pane.
                    if (typeof route.bringToBack === 'function') route.bringToBack();
                    if (typeof outline.bringToBack === 'function') outline.bringToBack();
                } catch (e) {
                    removeOverlayLayers(map, layers);
                    return false;
                }

                routeOverlay = { map, layers };
                return true;
            } catch (e) {
                // Same-origin access and Leaflet globals are Peakbagger-owned.
                // If either changes, retain the native map without disruption.
                return false;
            }
        };

        function handleMapIframeLoad() {
            hoverMarker = null;
            removeRouteOverlay();
            scheduleRouteOverlay();
            scheduleMapLayerSync();
        }

        const bindMapIframeLoad = () => {
            const iframe = findMapIframe();
            if (iframe && iframe !== boundMapIframe) {
                if (boundMapIframe) boundMapIframe.removeEventListener('load', handleMapIframeLoad);
                boundMapIframe = iframe;
                boundMapIframe.addEventListener('load', handleMapIframeLoad);
            }
        };

        function scheduleMapLayerSync() {
            bindMapIframeLoad();
            if (syncMapLayerPreference() || mapLayerRetryTimer) return;

            let attempts = 0;
            mapLayerRetryTimer = setInterval(() => {
                attempts++;
                if (syncMapLayerPreference() || attempts >= 20) {
                    clearInterval(mapLayerRetryTimer);
                    mapLayerRetryTimer = null;
                }
            }, 250);
        }

        function scheduleRouteOverlay() {
            bindMapIframeLoad();
            if (!mapRouteSegments.length) return;

            if (ensureRouteOverlay() || mapRetryTimer) return;

            let attempts = 0;
            mapRetryTimer = setInterval(() => {
                attempts++;
                if (ensureRouteOverlay() || attempts >= 20) {
                    clearInterval(mapRetryTimer);
                    mapRetryTimer = null;
                }
            }, 250);
        }

        // 4. Chart & UI Renderer Engine
        const renderData = () => {
            const p = panelPalette();
            applyPanelTheme();

            const isMet = unitSelect.value === 'metric';
            const dMult = isMet ? 0.001 : 1 / METERS_PER_MILE, eMult = isMet ? 1 : FEET_PER_METER;
            const dUnit = isMet ? 'km' : 'miles', eUnit = isMet ? 'm' : 'ft';
            const formatDistanceM = meters => `${(meters * dMult).toFixed(2)} ${dUnit}`;
            const formatElevationM = meters => `${(meters * eMult).toFixed(0)} ${eUnit}`;
            const formatSignedDistanceDelta = meters => `${meters >= 0 ? '+' : '-'}${formatDistanceM(Math.abs(meters))}`;
            const formatSignedElevationDelta = meters => `${meters >= 0 ? '+' : '-'}${formatElevationM(Math.abs(meters))}`;
            const buildMetricNote = () => {
                const distDeltaM = metrics.rawDistanceM - metrics.distanceM;
                const gainDeltaM = metrics.rawGainM - metrics.gainM;
                const distWorthShowing = Math.abs(distDeltaM) >= Math.max(0.03 * Math.max(metrics.distanceM, 1), 0.1 * METERS_PER_MILE);
                const gainWorthShowing = Math.abs(gainDeltaM) >= Math.max(0.05 * Math.max(metrics.gainM, 1), 100 / FEET_PER_METER);
                const parts = [];

                if (distWorthShowing) parts.push(`${formatSignedDistanceDelta(distDeltaM)} distance`);
                if (gainWorthShowing) parts.push(`${formatSignedElevationDelta(gainDeltaM)} gain`);

                return parts.length ? `Adjusted GPX metrics (raw GPX ${parts.join(', ')})` : 'Adjusted GPX metrics';
            };

            const isMultiDay = hasTime && (getRelativeDay(endMs, startMs) > 1);

            // Format Stats Bar
            const subLine = (text, styles) => {
                const line = document.createElement('div');
                Object.assign(line.style, styles);
                line.textContent = text;
                return line;
            };
            let txt = `Interactive Stats: ${formatDistanceM(metrics.distanceM)} | ${formatElevationM(metrics.gainM)} gain`;
            const subLines = [subLine(buildMetricNote(), { color: p.muted, fontSize: '0.95em', marginBottom: '2px' })];
            if (hasTime) {
                txt += ` | Time: ${fmtTime(totalMs)}`;
                if (summitMs > startMs) {
                    const timeToSummit = summitMs - startMs;
                    const timeBack = endMs - summitMs;
                    subLines.push(subLine(
                        `Start time: ${formatTimeStr(startMs, startMs, isMultiDay)} | Summit time: ${formatTimeStr(summitMs, startMs, isMultiDay)} | Back to car: ${formatTimeStr(endMs, startMs, isMultiDay)}`,
                        { color: p.sub, marginBottom: '2px' }));
                    subLines.push(subLine(
                        `Time to summit: ${fmtTime(timeToSummit)} | Time back: ${fmtTime(timeBack)}`,
                        { color: p.faint, fontSize: '0.95em' }));
                }
                if (campingSpots.length > 0) {
                    const spotStrs = campingSpots.map(s => `Day ${s.day} (${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})`).join(' | ');
                    subLines.push(subLine(`Possible Camping: ${spotStrs}`, { color: p.faint, fontSize: '0.95em', marginTop: '2px' }));
                }
                subLines.push(subLine(
                    `Times in the mountain’s local time (${mountainZoneLabel(startMs)})`,
                    { color: p.faint, fontSize: '0.95em', marginTop: '2px' }));
            }
            stats.textContent = txt;
            subStats.replaceChildren(...subLines);

            // Map adjusted arrays
            const eleDistData = [], eleTimeData = [];
            chartData.forEach(d => {
                const eleConv = parseFloat((d.eleM * eMult).toFixed(0));
                eleDistData.push({ x: parseFloat((d.distM * dMult).toFixed(2)), y: eleConv, _raw: d });
                if (hasTime && d.ms) {
                    eleTimeData.push({ x: d.ms, y: eleConv, _raw: d });
                }
            });

            if (chartInstance) chartInstance.destroy();

            // Initial series visibility follows the setting, but only when both
            // series exist (a time series needs timestamps). The legend's click
            // handler can still reveal the hidden one for this view; it doesn't
            // write the setting, so the peek is transient.
            const seriesPref = resolveChartSeries(BPB.get());
            const splittable = hasTime;
            const hideDistance = splittable && seriesPref === 'time';
            const hideTime = splittable && seriesPref === 'distance';

            const datasets = [{
                label: `Elevation by Distance`,
                data: eleDistData,
                hidden: hideDistance,
                borderColor: '#fc4c02',
                backgroundColor: 'rgba(252, 76, 2, 0.15)',
                borderWidth: 2, fill: true, tension: 0.2, yAxisID: 'y', xAxisID: 'x', pointRadius: 0, pointHoverRadius: 5, hitRadius: 40
            }];

            if (hasTime) {
                datasets.push({
                    label: `Elevation by Time`,
                    data: eleTimeData,
                    hidden: hideTime,
                    borderColor: '#6ab0de',
                    backgroundColor: 'rgba(0, 127, 182, 0.15)',
                    borderWidth: 2, fill: true, tension: 0.2, yAxisID: 'y', xAxisID: 'xTime', pointRadius: 0, pointHoverRadius: 5, hitRadius: 40
                });
            }

            // Match the legend handler's rule: one series visible -> index mode.
            const startsSingle = hideDistance || hideTime;

            const maxDist = parseFloat((metrics.distanceM * dMult).toFixed(2));

            chartInstance = new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: { datasets },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: startsSingle ? { mode: 'index', intersect: false } : { mode: 'nearest', intersect: true, axis: 'xy' },
                    onHover: (event, activeElements) => {
                        // FRAGILE DEPENDENCY: the hover-to-highlight-on-map
                        // feature reaches into Peakbagger's own MasterMap iframe
                        // and uses two private, undocumented globals it defines
                        // there -- the Leaflet instance `mapsPlaceholder` and
                        // Leaflet itself as `L`. These are same-origin (so
                        // reachable) but outside our control; if Peakbagger
                        // renames or restructures them this feature stops
                        // working. It fails closed (the guard below simply skips
                        // the marker), so the chart itself is unaffected.
                        const mapIframe = document.querySelector('iframe[src*="MasterMap.aspx"], iframe[src*="mastermap.aspx"]');
                        const iframeWin = mapIframe ? mapIframe.contentWindow : null;
                        let hoveredPoint = null;
                        let fillColor = '#FF0000';
                        let hoverSeries = 'distance';

                        if (activeElements.length > 0) {
                            const datasetIndex = activeElements[0].datasetIndex;
                            const idx = activeElements[0].index;
                            const dataArray = datasetIndex === 0 ? eleDistData : eleTimeData;
                            const candidate = dataArray[idx] ? dataArray[idx]._raw : null;
                            fillColor = datasetIndex === 0 ? '#FF0000' : '#0055FF';
                            hoverSeries = datasetIndex === 0 ? 'distance' : 'time';
                            if (candidate && Number.isFinite(candidate.lat) && Number.isFinite(candidate.lon)) hoveredPoint = candidate;
                        }

                        if (terrainState === 'active') {
                            postTerrain('highlight', {
                                coordinates: hoveredPoint ? [hoveredPoint.lon, hoveredPoint.lat] : null,
                                series: hoverSeries
                            });
                        }

                        if (hoveredPoint && terrainState !== 'active' && iframeWin && iframeWin.mapsPlaceholder && iframeWin.L) {
                            ensureRouteOverlay();
                            const L = iframeWin.L;
                            const map = iframeWin.mapsPlaceholder;

                            // Recreate marker if it doesn't match the current map instance (e.g. iframe reloaded)
                            if (hoverMarker) {
                                try {
                                    if (hoverMarker._map !== map) {
                                        hoverMarker = null;
                                    }
                                } catch (e) {
                                    hoverMarker = null;
                                }
                            }

                            if (!hoverMarker) {
                                hoverMarker = L.circleMarker([hoveredPoint.lat, hoveredPoint.lon], {
                                    radius: 9,
                                    color: '#FFFFFF',
                                    fillColor: fillColor,
                                    fillOpacity: 1,
                                    opacity: 1,
                                    weight: 2
                                }).addTo(map);
                            } else {
                                hoverMarker.setLatLng([hoveredPoint.lat, hoveredPoint.lon]);
                                hoverMarker.setStyle({ color: '#FFFFFF', fillColor: fillColor, opacity: 1, fillOpacity: 1 });
                            }
                        } else {
                            if (hoverMarker) {
                                hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'bottom',
                            labels: { usePointStyle: true, boxWidth: 8, color: p.chartText },
                            onClick: function (e, legendItem, legend) {
                                const index = legendItem.datasetIndex;
                                const chart = legend.chart;

                                chart.setDatasetVisibility(index, !chart.isDatasetVisible(index));

                                let visibleCount = 0;
                                chart.data.datasets.forEach((dataset, i) => {
                                    if (chart.isDatasetVisible(i)) visibleCount++;
                                });

                                if (visibleCount === 1) {
                                    chart.options.interaction = { mode: 'index', intersect: false };
                                } else {
                                    chart.options.interaction = { mode: 'nearest', intersect: true, axis: 'xy' };
                                }
                                chart.update('none');
                            }
                        },
                        tooltip: {
                            filter: (tooltipItem, index) => index === 0,
                            callbacks: {
                                title: items => {
                                    const d = items[0].raw._raw;
                                    return `Dist: ${(d.distM * dMult).toFixed(2)} ${dUnit}`;
                                },
                                label: item => {
                                    const d = item.raw._raw;
                                    let lbl = `${item.dataset.label}: ${item.parsed.y} ${eUnit}`;
                                    if (d.grade !== undefined) lbl += ` (Grade: ${d.grade.toFixed(1)}%)`;
                                    return lbl;
                                },
                                afterBody: items => {
                                    const d = items[0].raw._raw;
                                    if (hasTime && d.ms) {
                                        return [`Time: ${formatTimeStr(d.ms, startMs, isMultiDay)}`];
                                    }
                                    return [];
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            position: 'bottom',
                            min: 0,
                            max: maxDist > 0 ? maxDist : 1,
                            title: { display: true, text: `Distance (${dUnit})`, color: p.axisTitle },
                            grid: { color: p.chartGrid },
                            ticks: { maxTicksLimit: 10, color: p.chartText, callback: function (v) { return parseFloat(v).toFixed(1) + ` ${dUnit}`; } }
                        },
                        ...(hasTime && {
                            xTime: {
                                type: 'linear',
                                position: 'top',
                                min: startMs,
                                max: endMs > startMs ? endMs : startMs + 1000,
                                title: { display: true, text: 'Time', color: p.timeAxis },
                                ticks: {
                                    maxTicksLimit: 10,
                                    color: p.timeAxis,
                                    callback: function (v) {
                                        return formatTimeStr(v, startMs, isMultiDay);
                                    }
                                },
                                grid: { drawOnChartArea: false }
                            }
                        }),
                        y: {
                            type: 'linear', position: 'left',
                            title: { display: true, text: `Elevation (${eUnit})`, color: p.axisTitle },
                            grid: { color: p.chartGrid },
                            ticks: { color: p.chartText }
                        }
                    }
                }
            });
        };

        unitSelect.addEventListener('change', () => {
            BPB.set({ units: unitSelect.value });
            appliedSettings = { ...BPB.get() };
            renderData();
        });

        const bindRouteColor = (control, key) => control.input.addEventListener('change', () => {
            BPB.set({ [key]: control.input.value });
            appliedSettings = { ...BPB.get() };
            syncRouteStyleControls();
            removeRouteOverlay();
            scheduleRouteOverlay();
        });
        bindRouteColor(routeColorControl, 'mapRouteColor');
        bindRouteColor(routeCasingColorControl, 'mapRouteCasingColor');

        // Live updates are scoped by setting owner. In particular, changing a
        // map layer must not needlessly rebuild the chart or route overlay.
        BPB.subscribe(settings => {
            const previous = appliedSettings;
            appliedSettings = { ...settings };
            const changed = keys => keys.some(key => previous[key] !== settings[key]);

            if (changed(['mapViewportWidth', 'mapViewportHeight'])) {
                applyMapViewportSize(resolveMapViewportSize(settings));
            }
            if (changed(['mapRouteColor', 'mapRouteWidth', 'mapRouteCasingColor', 'mapRouteCasingWidth'])) {
                syncRouteStyleControls();
                removeRouteOverlay();
                scheduleRouteOverlay();
            }
            if (changed(['enable3dMap'])) syncTerrainAvailability(settings);
            if (terrainState === 'loading' || terrainState === 'active') {
                if (changed(['mapRouteColor', 'mapRouteWidth', 'mapRouteCasingColor', 'mapRouteCasingWidth', 'theme'])) {
                    postTerrain('update', {
                        routeStyle: resolveMapRouteStyle(settings),
                        theme: effectiveTheme(settings.theme)
                    });
                }
            }
            if (changed(['rememberMapLayer', 'mapLastLayer'])) scheduleMapLayerSync();
            if (changed(['units', 'theme', 'chartDefaultSeries'])) {
                unitSelect.value = resolveUnits(settings);
                if (chartInstance) renderData(); else applyPanelTheme();
            }
        });

        // 5. Native DOM XML Extraction Engine
        scheduleMapLayerSync();
        try {
            const response = await fetch(gpxLink.href);
            if (!response.ok) return stats.textContent = `The GPS track download failed (HTTP ${response.status}).`;
            const xml = new DOMParser().parseFromString(await response.text(), "text/xml");
            const trkpts = Array.from(xml.querySelectorAll('trkpt'));
            if (!trkpts.length) return stats.textContent = "No track points found.";

            mapRouteSegments = parseMapRouteSegments(xml);
            updateTerrainButton();

            const parsedPoints = trkpts.map(pt => {
                const eleNode = pt.querySelector('ele');
                const timeNode = pt.querySelector('time');
                const parsedMs = timeNode ? new Date(timeNode.textContent).getTime() : 0;
                const rawEleM = eleNode ? parseFloat(eleNode.textContent) : Number.NaN;

                return {
                    lat: parseFloat(pt.getAttribute('lat')),
                    lon: parseFloat(pt.getAttribute('lon')),
                    rawEleM,
                    ms: Number.isFinite(parsedMs) ? parsedMs : 0
                };
            });

            metrics = GpxMetrics.computeMetrics(parsedPoints);
            if (!metrics.points.length) {
                const hasValidCoordinates = parsedPoints.some(point =>
                    Number.isFinite(point.lat) && Number.isFinite(point.lon));
                return stats.textContent = hasValidCoordinates
                    ? "This GPS track has no usable elevation data."
                    : "No valid track points found.";
            }

            // The climb's timezone comes from the track's starting point: the
            // trailhead decides which side of a zone border (or of a border
            // peak) the trip's civil time belongs to.
            const startPoint = metrics.points[0];
            mountainOffsetMs = Math.round(startPoint.lon / 15) * 3600000;
            try {
                if (typeof globalThis.tzlookup === 'function') {
                    mountainTimeZone = globalThis.tzlookup(startPoint.lat, startPoint.lon);
                    mountainDayFormatter = new Intl.DateTimeFormat('en-CA', {
                        timeZone: mountainTimeZone, year: 'numeric', month: '2-digit', day: '2-digit'
                    });
                }
            } catch (e) {
                // Reachable: malformed GPX can carry finite out-of-range
                // coordinates (tzlookup throws on |lat| > 90), and a zone id
                // from the raster may be unknown to this browser's ICU after
                // a tzdata rename. Both keep the labelled solar estimate.
                mountainTimeZone = null;
                mountainDayFormatter = null;
            }

            chartData = metrics.chartPoints;
            hasTime = metrics.hasTime;
            startMs = metrics.startMs;
            endMs = metrics.endMs;
            summitMs = metrics.summitMs;
            campingSpots = [];

            if (hasTime) {
                totalMs = endMs - startMs;
                metrics.points.forEach((point, index) => {
                    if (index === 0) return;
                    const prev = metrics.points[index - 1];
                    const prevDay = getRelativeDay(prev.ms, startMs);
                    const currDay = getRelativeDay(point.ms, startMs);
                    if (currDay > prevDay) {
                        campingSpots.push({ day: prevDay, lat: prev.lat, lon: prev.lon });
                    }
                });
            }

            renderData();
            scheduleRouteOverlay();

        } catch (e) {
            stats.textContent = "Error parsing GPX file.";
            console.error(e);
        }
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initChart);
    } else {
        initChart();
    }
};
run();
