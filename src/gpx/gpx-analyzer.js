// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GPX Analyzer content script.
// Runs in the page's MAIN world (see manifest.json) so it can read the raw GPX
// link and reach into Peakbagger's same-origin MasterMap iframe for the hover
// marker. Chart.js (vendor/chart.umd.min.js) and the pure metrics pipeline
// (src/gpx/gpx-metrics.js) are loaded immediately before this file, so the globals
// `Chart` and `BPBGpxMetrics` are available here.
//
// The MAIN world cannot read chrome.storage, so preferences come from the
// isolated-world bridge (src/settings/bridge.js) over window.postMessage. Affected map
// and chart surfaces update live when settings change.

import { gpxMetrics as GpxMetrics } from './gpx-metrics.js';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.js';
import { fetchPeakbaggerDocument } from '../peakbagger/peakbagger-request.js';
import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { themeResolve as ThemeResolve } from '../theme/theme-resolve.js';
import { pageSettingsClient as PageSettingsClient } from '../settings/page-settings-client.js';
import { peakMarkers } from '../maps/peak-markers.js';
import { terrainBasemap } from '../terrain/terrain-basemap.js';
import { terrainCompass as TerrainCompass } from '../terrain/terrain-compass.js';
import { terrainCoordinator as TerrainCoordinator } from '../terrain/terrain-coordinator.js';
import { terrainFailure as TerrainFailure } from '../terrain/terrain-failure.js';
import { units as Units } from '../ui/units.js';
import { mapViewport as MapViewport } from './map-viewport.js';
import { mapFrameLifecycle as MapFrameLifecycle } from './map-frame-lifecycle.js';
import { mapOverlay as MapOverlay } from './map-overlay.js';
import { gpxPanelCss } from './gpx-panel-css.js';

// Chart and tzlookup remain separately-loaded vendor globals (see manifest).
const run = async () => {
    const { METERS_PER_MILE, FEET_PER_METER } = Units;
    const MAP_VIEWPORT_MIN_WIDTH = Schema.BOUNDS.viewportWidth.min;
    const MAP_VIEWPORT_MAX_WIDTH = Schema.BOUNDS.viewportWidth.max;
    const MAP_VIEWPORT_MIN_HEIGHT = Schema.BOUNDS.viewportHeight.min;
    const MAP_VIEWPORT_MAX_HEIGHT = Schema.BOUNDS.viewportHeight.max;
    const MAP_RESIZE_RAIL_HEIGHT = 18;
    const COORDINATE_HINT = 'Click the chart or use \u2190/\u2192 to select a point';
    const MAP_RESIZE_PERSIST_DELAY_MS = 400;
    const parseMapRouteSegments = xml => {
        const segments = Array.from(xml.querySelectorAll('trkseg'), segmentNode =>
            Array.from(segmentNode.children)
                .filter(node => node.localName === 'trkpt')
                .map(node => [
                    parseFloat(node.getAttribute('lat')),
                    parseFloat(node.getAttribute('lon')),
                ]));
        return GpxMetrics.sanitizeMapRouteSegments(segments);
    };

    // === Better Peakbagger: theming + centralized settings (via bridge) ===
    // Chart.js takes colors as JS options, not CSS, so these have to stay in
    // JS. Everything the panel's *DOM* is painted with moved to
    // src/gpx/gpx-panel-css.js, so this is no longer a second theming system
    // beside a stylesheet — it is the one place JS values are genuinely needed.
    const CHART_PALETTES = {
        light: { chartText: '#666666', chartGrid: 'rgba(0,0,0,0.1)', axisTitle: '#000000', timeAxis: '#007fb6' },
        dark: { chartText: '#b6b0a6', chartGrid: 'rgba(255,255,255,0.12)', axisTitle: '#e6e1d8', timeAxis: '#6ab0de' }
    };
    const effectiveTheme = preference => ThemeResolve.resolve(preference);

    // The isolated bridge owns storage; this MAIN-world client owns optimistic
    // ordering, acknowledgement deadlines, and rollback notifications.
    const BPB = PageSettingsClient.create({ fallback: Schema.clean({}) });

    const detectPageMetric = () => {
        const elevTd = Array.from(document.querySelectorAll('td')).find(td => td.textContent.trim() === 'Elevation:');
        return !!(elevTd && elevTd.nextElementSibling && /^[\d,.]+\s*m/.test(elevTd.nextElementSibling.textContent.trim()));
    };
    const unitPreference = settings => Schema.clean(settings).units;
    // detectPageMetric reads this page's own Elevation cell; the preference
    // logic around it belongs to the shared resolver, not to a second copy.
    const resolveUnits = settings => Units.resolveUnits(
        Schema.clean(settings),
        () => (detectPageMetric() ? Units.METRIC : Units.IMPERIAL)
    );
    // Which series to show on load. Only the initial visibility is bound to the
    // setting; the legend's own click handler toggles visibility for the current
    // view without writing it back, so a temporary peek never changes the pref.
    const resolveChartSeries = settings => Schema.chartDefaultSeries(settings.chartDefaultSeries);
    // Settings arrive over postMessage, so they are re-validated here rather
    // than trusted; the shared schema keeps those checks identical to the ones
    // src/settings/settings.js applies on the way into storage.
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

        const MAP_IFRAME_SELECTOR = 'iframe[src*="MasterMap.aspx"], iframe[src*="mastermap.aspx"]';
        const frameLifecycle = MapFrameLifecycle.create({ selector: MAP_IFRAME_SELECTOR });
        const currentMapIframe = () => frameLifecycle.current();
        let terrainCoordinator = null;

        // Resize, persist, and Leaflet invalidation now live in
        // src/gpx/map-viewport.js. Bounds come from the settings schema rather
        // than a local copy, and the debounced persist is the module's, so this
        // file only says what to do with the result.
        const viewport = MapViewport.create({
            iframe: currentMapIframe(),
            size: resolveMapViewportSize(BPB.get()),
            bounds: {
                minWidth: MAP_VIEWPORT_MIN_WIDTH,
                maxWidth: MAP_VIEWPORT_MAX_WIDTH,
                minHeight: MAP_VIEWPORT_MIN_HEIGHT,
                maxHeight: MAP_VIEWPORT_MAX_HEIGHT,
            },
            railHeight: MAP_RESIZE_RAIL_HEIGHT,
            persistDelayMs: MAP_RESIZE_PERSIST_DELAY_MS,
            onPersist: size => BPB.set({
                mapViewportWidth: size.width,
                mapViewportHeight: size.height
            }),
            onInvalidated: () => terrainCoordinator?.position(),
        });
        let mapViewport = viewport.element;
        const scheduleMapInvalidate = viewport.scheduleInvalidate;
        const applyMapViewportSize = viewport.applySize;

        if (!document.getElementById('bpb-gpx-panel-style')) {
            const panelStyle = document.createElement('style');
            panelStyle.id = 'bpb-gpx-panel-style';
            panelStyle.textContent = gpxPanelCss;
            document.head.appendChild(panelStyle);
        }

        const container = document.createElement('div');
        container.id = 'bpb-gpx-analysis';
        // Colors come from gpx-panel-css.js; only layout stays inline.
        Object.assign(container.style, { marginTop: '15px', padding: '10px', borderWidth: '1px', borderStyle: 'solid', borderRadius: '5px', maxWidth: '800px' });

        const headerBox = document.createElement('div');
        headerBox.className = 'bpb-gpx-header';
        Object.assign(headerBox.style, {
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            flexWrap: 'wrap', gap: '10px', marginBottom: '10px'
        });

        const statsContainer = document.createElement('div');
        const stats = document.createElement('div');
        stats.className = 'bpb-gpx-stats';
        Object.assign(stats.style, { fontFamily: 'sans-serif', fontWeight: 'bold' });
        stats.textContent = 'Analyzing GPX data…';

        const subStats = document.createElement('div');
        subStats.className = 'bpb-gpx-substats';
        Object.assign(subStats.style, { fontFamily: 'sans-serif', fontSize: '0.9em', marginTop: '4px', fontStyle: 'italic' });

        statsContainer.append(stats, subStats);

        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'bpb-gpx-controls';
        Object.assign(controlsContainer.style, { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' });

        const unitSelect = document.createElement('select');
        unitSelect.id = 'bpb-gpx-units';
        unitSelect.setAttribute('aria-label', 'Units');
        Object.assign(unitSelect.style, { padding: '2px 6px', borderRadius: '4px', borderWidth: '1px', borderStyle: 'solid', cursor: 'pointer', outline: 'none' });
        const unitOption = (value, label) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            return option;
        };
        unitSelect.append(
            unitOption('auto', 'Auto (match page)'),
            unitOption('imperial', 'Imperial'),
            unitOption('metric', 'Metric')
        );

        // A floating control on the map itself (bottom-right, stacked just above
        // the zoom controls), styled by src/terrain/terrain-map.css. Clicking flips the
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
            label.className = 'bpb-gpx-control-label';
            Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
            label.htmlFor = id;
            const caption = document.createElement('span');
            caption.textContent = text;
            const input = document.createElement('input');
            input.id = id;
            input.type = 'color';
            input.setAttribute('aria-label', `${text} color`);
            Object.assign(input.style, { width: '26px', height: '22px', padding: '2px', borderWidth: '1px', borderStyle: 'solid', borderRadius: '5px', cursor: 'pointer' });
            label.append(caption, input);
            routeStyleControls.append(label);
            return { label, input };
        };

        const routeColorControl = createColorControl('bpb-map-route-color', 'Route');
        const routeCasingColorControl = createColorControl('bpb-map-route-casing-color', 'Outline');

        const coordinateControls = document.createElement('div');
        coordinateControls.className = 'bpb-gpx-coordinate-controls';

        const copyCoordinatesButton = document.createElement('button');
        copyCoordinatesButton.id = 'bpb-gpx-copy-coordinates';
        copyCoordinatesButton.className = 'bpb-gpx-copy-coordinates';
        copyCoordinatesButton.type = 'button';
        copyCoordinatesButton.disabled = true;
        copyCoordinatesButton.textContent = 'Copy coordinates';

        const hintText = document.createElement('div');
        hintText.id = 'bpb-gpx-coordinate-status';
        hintText.className = 'bpb-gpx-hint';
        hintText.setAttribute('role', 'status');
        hintText.setAttribute('aria-live', 'polite');
        Object.assign(hintText.style, { fontSize: '0.8em', fontStyle: 'italic' });
        hintText.textContent = COORDINATE_HINT;

        const coordinateFallback = document.createElement('input');
        coordinateFallback.className = 'bpb-gpx-coordinate-fallback';
        coordinateFallback.type = 'text';
        coordinateFallback.readOnly = true;
        coordinateFallback.hidden = true;
        coordinateFallback.setAttribute('aria-label', 'Selected coordinates');

        coordinateControls.append(copyCoordinatesButton, hintText, coordinateFallback);
        controlsContainer.append(unitSelect, routeStyleControls, coordinateControls);
        headerBox.append(statsContainer, controlsContainer);
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
        canvas.tabIndex = 0;
        canvas.setAttribute('role', 'application');
        canvas.setAttribute('aria-label', 'Interactive elevation chart. Use Left and Right Arrow keys to select a point.');
        canvas.setAttribute('aria-describedby', hintText.id);
        canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
        canvasContainer.append(canvas);
        container.append(headerBox, terrainMessage, canvasContainer);
        const fullScreenMapLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('Full Screen Map'));
        if (fullScreenMapLink) fullScreenMapLink.before(container);
        else gpxLink.after(container);

        // One theming system for the whole surface: the panel and the floating
        // 3D toggle now take the same data-theme attribute, and the panel's
        // stylesheet reassigns its tokens under it. This used to paint eight
        // elements with inline styles from a JS palette while the toggle beside
        // it was themed by CSS.
        const panelPalette = () => CHART_PALETTES[effectiveTheme(BPB.get().theme)];
        const applyPanelTheme = () => {
            const theme = effectiveTheme(BPB.get().theme);
            container.dataset.theme = theme;
            terrainButton.dataset.theme = theme;
        };
        applyPanelTheme();

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
        unitSelect.value = unitPreference(BPB.get());
        const syncRouteStyleControls = () => {
            const style = resolveMapRouteStyle(BPB.get());
            routeColorControl.input.value = style.color;
            routeCasingColorControl.input.value = style.casingColor;
        };
        syncRouteStyleControls();

        // Processing Arrays & Core Metrics
        let chartInstance = null;
        let chartData = [];
        let selectedCoordinateIndex = -1;
        let coordinateFeedbackTimer = null;
        let metrics = { distanceM: 0, gainM: 0, rawDistanceM: 0, rawGainM: 0 };
        let totalMs = 0, hasTime = false;
        let startMs = 0, endMs = 0, summitMs = 0;
        let campingSpots = [];
        let mapRouteSegments = [];
        let hoverMarker = null;

        const isCoordinatePoint = point =>
            point && Number.isFinite(point.lat) && Number.isFinite(point.lon);
        const coordinateText = point => `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
        const coordinateIndexes = () => chartData
            .map((point, index) => isCoordinatePoint(point) ? index : -1)
            .filter(index => index >= 0);
        const clearCoordinateFeedbackTimer = () => {
            if (coordinateFeedbackTimer !== null) {
                clearTimeout(coordinateFeedbackTimer);
                coordinateFeedbackTimer = null;
            }
        };
        const setCoordinateStatus = (text, state = '') => {
            hintText.textContent = text;
            if (state) hintText.dataset.state = state;
            else delete hintText.dataset.state;
        };
        const selectedCoordinateAnnouncement = () => {
            const point = chartData[selectedCoordinateIndex];
            if (!isCoordinatePoint(point)) return COORDINATE_HINT;
            const selectable = coordinateIndexes();
            const position = selectable.indexOf(selectedCoordinateIndex);
            return `Selected point ${position + 1} of ${selectable.length}: ${coordinateText(point)}`;
        };
        const syncCoordinateSelection = ({ unavailable = false } = {}) => {
            const selectedPoint = chartData[selectedCoordinateIndex];
            const hasSelection = isCoordinatePoint(selectedPoint);
            copyCoordinatesButton.disabled = !hasSelection;
            if (!hasSelection) {
                selectedCoordinateIndex = -1;
                coordinateFallback.hidden = true;
                coordinateFallback.value = '';
                setCoordinateStatus(unavailable
                    ? 'No chart point with coordinates is available.'
                    : COORDINATE_HINT);
            }
            canvas.setAttribute('aria-label', hasSelection
                ? `Interactive elevation chart. ${selectedCoordinateAnnouncement()}. Use Left and Right Arrow keys to move.`
                : 'Interactive elevation chart. Use Left and Right Arrow keys to select a point.');
        };
        const selectCoordinateIndex = index => {
            if (!isCoordinatePoint(chartData[index])) return false;
            clearCoordinateFeedbackTimer();
            selectedCoordinateIndex = index;
            coordinateFallback.hidden = true;
            coordinateFallback.value = '';
            copyCoordinatesButton.disabled = false;
            setCoordinateStatus(selectedCoordinateAnnouncement());
            canvas.setAttribute(
                'aria-label',
                `Interactive elevation chart. ${selectedCoordinateAnnouncement()}. Use Left and Right Arrow keys to move.`
            );
            if (chartInstance) chartInstance.update('none');
            return true;
        };
        const selectCoordinateFromEvent = event => {
            if (!chartInstance || typeof chartInstance.getElementsAtEventForMode !== 'function') return false;
            const activeElements = chartInstance.getElementsAtEventForMode(
                event,
                'nearest',
                { intersect: false, axis: 'xy' },
                true
            );
            for (const active of activeElements) {
                const point = chartInstance.data.datasets[active.datasetIndex]?.data[active.index]?._raw;
                const index = chartData.indexOf(point);
                if (selectCoordinateIndex(index)) return true;
            }
            return false;
        };
        const showCopyFallback = text => {
            coordinateFallback.value = text;
            coordinateFallback.hidden = false;
            coordinateFallback.focus();
            coordinateFallback.select();
            setCoordinateStatus('Copy unavailable. The coordinates are selected; press Ctrl/Cmd+C.', 'error');
        };
        const copySelectedCoordinate = async () => {
            const point = chartData[selectedCoordinateIndex];
            if (!isCoordinatePoint(point)) {
                syncCoordinateSelection({ unavailable: coordinateIndexes().length === 0 });
                return;
            }
            clearCoordinateFeedbackTimer();
            const text = coordinateText(point);
            try {
                if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                    throw new Error('Clipboard API unavailable');
                }
                await navigator.clipboard.writeText(text);
                coordinateFallback.hidden = true;
                setCoordinateStatus(`Copied: ${text}`, 'success');
                coordinateFeedbackTimer = setTimeout(() => {
                    coordinateFeedbackTimer = null;
                    setCoordinateStatus(selectedCoordinateAnnouncement());
                }, 2500);
            } catch (error) {
                showCopyFallback(text);
            }
        };

        canvas.addEventListener('click', selectCoordinateFromEvent);
        canvas.addEventListener('dblclick', event => {
            if (selectCoordinateFromEvent(event) || selectedCoordinateIndex >= 0) {
                void copySelectedCoordinate();
            }
        });
        canvas.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const selectable = coordinateIndexes();
            if (!selectable.length) {
                syncCoordinateSelection({ unavailable: true });
                return;
            }
            const currentPosition = selectable.indexOf(selectedCoordinateIndex);
            const nextPosition = currentPosition < 0
                ? (event.key === 'ArrowRight' ? 0 : selectable.length - 1)
                : Math.max(0, Math.min(
                    selectable.length - 1,
                    currentPosition + (event.key === 'ArrowRight' ? 1 : -1)
                ));
            selectCoordinateIndex(selectable[nextPosition]);
        });
        copyCoordinatesButton.addEventListener('click', () => {
            void copySelectedCoordinate();
        });

        let terrainConsentPending = false;
        let terrainCompass = null;

        const nativeLeafletMap = () => {
            try {
                const mapIframe = currentMapIframe();
                return mapIframe && mapIframe.contentWindow && mapIframe.contentWindow.mapsPlaceholder;
            } catch (error) {
                return null;
            }
        };

        // Float the toggle just above the zoom stack in whichever map is showing:
        // the 3D frame reports its stack height (it is cross-origin), while the
        // native 2D zoom is same-origin and measured directly. A null result
        // leaves the CSS fallback offset in place.
        const TERRAIN_TOGGLE_GAP = 8;
        const measureNative2dZoomTop = () => {
            try {
                const mapIframe = currentMapIframe();
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
        const positionTerrainToggle = ({ state, navTop }) => {
            let bottom = null;
            if (state === 'active') {
                const frame = document.getElementById('bpb-terrain-frame');
                if (frame && mapViewport && navTop != null) {
                    const inset = Math.max(0, mapViewport.getBoundingClientRect().bottom - frame.getBoundingClientRect().bottom);
                    bottom = inset + navTop;
                }
            } else {
                bottom = measureNative2dZoomTop();
            }
            terrainButton.style.bottom = bottom != null && bottom > 0 ? `${Math.round(bottom + TERRAIN_TOGGLE_GAP)}px` : '';
            if (terrainCompass) terrainCompass.position();
        };

        const postTerrain = (type, detail = {}) => window.postMessage({
            __bpbTerrain: true,
            dir: 'toCS',
            type,
            ...detail
        }, location.origin);

        const attachMapControls = () => {
            mapViewport = viewport.element;
            if (!mapViewport) return;
            if (terrainButton.parentElement !== mapViewport) mapViewport.append(terrainButton);
            if (!terrainCompass) terrainCompass = TerrainCompass.create({
                container: mapViewport,
                toggle: terrainButton,
                onReset: () => postTerrain('resetNorth')
            });
        };
        attachMapControls();

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

        // A rejected write from an inline control (unit dropdown, route colour)
        // rolls the control back; this is the panel's only status region, so it
        // is where the reason belongs.
        BPB.onWriteFailed(message => showTerrainMessage(message, 'error'));

        const restoreNativeMap = () => {
            const mapIframe = currentMapIframe();
            if (!mapIframe) return;
            mapIframe.style.visibility = 'visible';
            mapIframe.removeAttribute('aria-hidden');
            scheduleMapInvalidate();
        };

        const buildTerrainInit = () => {
            const mapIframe = currentMapIframe();
            if (!mapViewport || !mapIframe || !mapRouteSegments.length) return null;
            return {
                routeSegments: mapRouteSegments,
                routeStyle: resolveMapRouteStyle(BPB.get()),
                theme: effectiveTheme(BPB.get().theme),
                basemap: getTerrainBasemap(),
                basemaps: enumerateTerrainBasemaps(),
                cacheLimitMb: resolveTerrainCacheLimitMb(BPB.get())
            };
        };

        terrainCoordinator = TerrainCoordinator.create({
            toggle: terrainButton,
            compass: terrainCompass,
            isEnabled: () => BPB.get().enable3dMap === true,
            idleUi: () => {
                const hasRoute = mapRouteSegments.length > 0;
                return {
                    disabled: !hasRoute,
                    title: hasRoute ? 'View this route on 3D terrain' : 'Available after the GPX route loads',
                    ariaLabel: hasRoute ? 'Show 3D terrain' : '3D terrain available after the route loads'
                };
            },
            buildInit: buildTerrainInit,
            nativeMap: nativeLeafletMap,
            hideNativeMap: () => {
                const mapIframe = currentMapIframe();
                if (!mapIframe) return;
                mapIframe.style.visibility = 'hidden';
                mapIframe.setAttribute('aria-hidden', 'true');
            },
            restoreNativeMap,
            post: postTerrain,
            requestConsent: () => {
                if (terrainConsentPending || !mapRouteSegments.length) return;
                terrainConsentPending = true;
                postTerrain('requestConsent');
            },
            // The toggle's spinner is the loading cue. Reserve the panel message
            // for actionable errors and the drape-unsupported notice.
            clearFailure: () => showTerrainMessage(''),
            showFailure: reason => showTerrainMessage(TerrainFailure.message(reason), 'error'),
            theme: () => effectiveTheme(BPB.get().theme),
            position: positionTerrainToggle
        });

        const syncTerrainAvailability = settings => {
            const enabled = settings.enable3dMap === true;
            if (!enabled) {
                if (terrainCoordinator.isOpen()) terrainCoordinator.stop();
                else showTerrainMessage('');
            }
            terrainCoordinator.update();
            if (enabled && terrainConsentPending && terrainCoordinator.isIdle()) {
                terrainConsentPending = false;
                terrainCoordinator.start();
            }
        };

        // The 3D frame asks for Peakbagger's peak dots as its camera settles;
        // the request is served by the same-origin PLLBB feed the native 2D
        // map uses, with the parameters read from the MasterMap iframe URL. A
        // surface without a usable feed answers `unavailable` once so the
        // frame stops asking.
        let peaksClient = null;
        let peaksClientResolved = false;
        let peaksClientGeneration = 0;
        const answerPeaksRequest = data => {
            const requestId = data.requestId;
            if (!Number.isFinite(requestId)) return;
            if (!peaksClientResolved) {
                peaksClientResolved = true;
                const mapIframe = currentMapIframe();
                peaksClient = peakMarkers && mapIframe
                    ? peakMarkers.createClient(mapIframe.src)
                    : null;
            }
            if (!peaksClient) {
                postTerrain('peaks', { requestId, peaks: [], unavailable: true });
                return;
            }
            const generation = peaksClientGeneration;
            peaksClient.request(data.bounds).then(peaks => {
                // A superseded request resolves null and stays silent; the
                // newer request answers instead.
                if (peaks && generation === peaksClientGeneration) postTerrain('peaks', { requestId, peaks });
            });
        };

        window.addEventListener('message', event => {
            if (event.source !== window || event.origin !== location.origin) return;
            const data = event.data;
            if (!data || data.__bpbTerrain !== true || data.dir !== 'toPage') return;

            if (data.type === 'consentResult' && terrainConsentPending) {
                terrainConsentPending = false;
                if (data.enabled === true) terrainCoordinator.start(true);
            } else if (data.type === 'peaksRequest' && !terrainCoordinator.isIdle()) {
                answerPeaksRequest(data);
            } else terrainCoordinator.handleMessage(data);
        });

        syncTerrainAvailability(BPB.get());

        // The route overlay and the remembered map layer live in
        // src/gpx/map-overlay.js. Both reach into a frame the extension does
        // not own, so keeping them together — and behind one narrow interface —
        // makes their shared fail-closed contract reviewable in one place.
        const overlay = MapOverlay.create({
            frameLifecycle,
            getSettings: () => BPB.get(),
            setSettings: patch => BPB.set(patch),
            getRouteSegments: () => mapRouteSegments,
            routeStyleFor: resolveMapRouteStyle,
            scheduleInvalidate: scheduleMapInvalidate,
            terrainBasemap,
            // The chart's hover marker belongs to a map that no longer exists.
            onFrameReload: () => { hoverMarker = null; },
        });
        const removeRouteOverlay = overlay.removeRouteOverlay;
        const scheduleRouteOverlay = overlay.scheduleRouteOverlay;
        const scheduleMapLayerSync = overlay.scheduleMapLayerSync;
        const ensureRouteOverlay = overlay.ensureRouteOverlay;
        const getTerrainBasemap = overlay.getTerrainBasemap;
        const enumerateTerrainBasemaps = overlay.enumerateTerrainBasemaps;

        const resetFrameConsumers = ({ frame, previous, reason }) => {
            if (hoverMarker) {
                try {
                    if (typeof hoverMarker.remove === 'function') hoverMarker.remove();
                    else if (hoverMarker._map?.removeLayer) hoverMarker._map.removeLayer(hoverMarker);
                } catch (error) { /* The old frame may already be gone. */ }
                hoverMarker = null;
            }
            peaksClient = null;
            peaksClientResolved = false;
            peaksClientGeneration++;
            if (reason === 'identity') {
                viewport.attach(frame);
                mapViewport = viewport.element;
                attachMapControls();
                if (previous && previous !== frame) {
                    previous.style.visibility = '';
                    previous.removeAttribute('aria-hidden');
                }
            }
            overlay.handleFrameChange();
            if (frame) {
                if (terrainCoordinator.isActive()) {
                    frame.style.visibility = 'hidden';
                    frame.setAttribute('aria-hidden', 'true');
                } else {
                    frame.style.visibility = 'visible';
                    frame.removeAttribute('aria-hidden');
                }
            }
            scheduleMapInvalidate();
            terrainCoordinator.position();
        };
        frameLifecycle.subscribe(resetFrameConsumers);
        frameLifecycle.start();
        window.addEventListener('pagehide', () => {
            clearCoordinateFeedbackTimer();
            BPB.dispose();
            overlay.dispose();
            frameLifecycle.dispose();
        }, { once: true });

        // Chart.js runs `onHover` only while the pointer is inside the plot
        // rectangle, and it never replays it on the way out: leaving the canvas
        // clears the chart's own point and tooltip without telling us, so the
        // marker this panel puts on the map — or the 3D highlight — would sit
        // frozen on the last hovered location. Clearing on exit is the missing
        // half of that contract. The boundary is the canvas rather than the
        // plot rectangle so the marker and Chart.js's tooltip disappear
        // together; Chart.js deliberately keeps the tooltip alive while the
        // pointer crosses the axis gutter and legend below the plot.
        let hoverHighlightShown = false;
        const clearHoverHighlight = () => {
            if (!hoverHighlightShown) return;
            hoverHighlightShown = false;
            if (terrainCoordinator.isActive()) postTerrain('highlight', { coordinates: null, series: 'distance' });
            if (hoverMarker) hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        };
        canvas.addEventListener('mouseleave', clearHoverHighlight);

        // 4. Chart & UI Renderer Engine
        const renderData = () => {
            const p = panelPalette();
            applyPanelTheme();

            const isMet = resolveUnits(BPB.get()) === 'metric';
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
            // Built fresh each render, so these keep inline styles — but the
            // colors read the panel stylesheet's tokens rather than a JS
            // palette, so there is still only one place a theme value lives.
            const TONE = {
                sub: 'var(--bpb-gpx-sub)',
                muted: 'var(--bpb-gpx-muted)',
                faint: 'var(--bpb-gpx-faint)',
            };
            const subLine = (text, styles) => {
                const line = document.createElement('div');
                Object.assign(line.style, styles);
                line.textContent = text;
                return line;
            };
            let txt = `Interactive Stats: ${formatDistanceM(metrics.distanceM)} | ${formatElevationM(metrics.gainM)} gain`;
            const subLines = [subLine(buildMetricNote(), { color: TONE.muted, fontSize: '0.95em', marginBottom: '2px' })];
            if (hasTime) {
                txt += ` | Time: ${fmtTime(totalMs)}`;
                if (summitMs > startMs) {
                    const timeToSummit = summitMs - startMs;
                    const timeBack = endMs - summitMs;
                    subLines.push(subLine(
                        `Start time: ${formatTimeStr(startMs, startMs, isMultiDay)} | Summit time: ${formatTimeStr(summitMs, startMs, isMultiDay)} | Back to car: ${formatTimeStr(endMs, startMs, isMultiDay)}`,
                        { color: TONE.sub, marginBottom: '2px' }));
                    subLines.push(subLine(
                        `Time to summit: ${fmtTime(timeToSummit)} | Time back: ${fmtTime(timeBack)}`,
                        { color: TONE.faint, fontSize: '0.95em' }));
                }
                if (campingSpots.length > 0) {
                    const spotStrs = campingSpots.map(s => `Day ${s.day} (${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})`).join(' | ');
                    subLines.push(subLine(`Possible Camping: ${spotStrs}`, { color: TONE.faint, fontSize: '0.95em', marginTop: '2px' }));
                }
                subLines.push(subLine(
                    `Times in the mountain’s local time (${mountainZoneLabel(startMs)})`,
                    { color: TONE.faint, fontSize: '0.95em', marginTop: '2px' }));
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

            const selectedPointRadius = context =>
                context.raw?._raw === chartData[selectedCoordinateIndex] ? 5 : 0;
            const datasets = [{
                label: 'Elevation by Distance',
                data: eleDistData,
                hidden: hideDistance,
                borderColor: '#fc4c02',
                backgroundColor: 'rgba(252, 76, 2, 0.15)',
                borderWidth: 2, fill: true, tension: 0.2, yAxisID: 'y', xAxisID: 'x',
                pointRadius: selectedPointRadius, pointHoverRadius: 5, hitRadius: 40
            }];

            if (hasTime) {
                datasets.push({
                    label: 'Elevation by Time',
                    data: eleTimeData,
                    hidden: hideTime,
                    borderColor: '#6ab0de',
                    backgroundColor: 'rgba(0, 127, 182, 0.15)',
                    borderWidth: 2, fill: true, tension: 0.2, yAxisID: 'y', xAxisID: 'xTime',
                    pointRadius: selectedPointRadius, pointHoverRadius: 5, hitRadius: 40
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
                        const hoverFrame = currentMapIframe();
                        const iframeWin = hoverFrame ? hoverFrame.contentWindow : null;
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

                        // Only a highlight this handler actually placed needs
                        // clearing when the pointer leaves the canvas.
                        hoverHighlightShown = hoveredPoint !== null;

                        if (terrainCoordinator.isActive()) {
                            postTerrain('highlight', {
                                coordinates: hoveredPoint ? [hoveredPoint.lon, hoveredPoint.lat] : null,
                                series: hoverSeries
                            });
                        }

                        if (hoveredPoint && !terrainCoordinator.isActive() && iframeWin && iframeWin.mapsPlaceholder && iframeWin.L) {
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
            syncCoordinateSelection();
        };

        unitSelect.addEventListener('change', () => {
            BPB.set({ units: unitSelect.value });
            renderData();
        });

        const bindRouteColor = (control, key) => control.input.addEventListener('change', () => {
            BPB.set({ [key]: control.input.value });
            syncRouteStyleControls();
            removeRouteOverlay();
            scheduleRouteOverlay();
        });
        bindRouteColor(routeColorControl, 'mapRouteColor');
        bindRouteColor(routeCasingColorControl, 'mapRouteCasingColor');

        // Live updates are scoped by setting owner. In particular, changing a
        // map layer must not needlessly rebuild the chart or route overlay.
        BPB.subscribe((settings, changed) => {

            if (changed(['mapViewportWidth', 'mapViewportHeight'])) {
                applyMapViewportSize(resolveMapViewportSize(settings));
            }
            if (changed(['mapRouteColor', 'mapRouteWidth', 'mapRouteCasingColor', 'mapRouteCasingWidth'])) {
                syncRouteStyleControls();
                removeRouteOverlay();
                scheduleRouteOverlay();
            }
            if (changed(['enable3dMap'])) syncTerrainAvailability(settings);
            if (terrainCoordinator.isOpen()) {
                if (changed(['mapRouteColor', 'mapRouteWidth', 'mapRouteCasingColor', 'mapRouteCasingWidth', 'theme'])) {
                    postTerrain('update', {
                        routeStyle: resolveMapRouteStyle(settings),
                        theme: effectiveTheme(settings.theme)
                    });
                }
            }
            if (changed(['rememberMapLayer', 'mapLastLayer'])) scheduleMapLayerSync();
            if (changed(['units', 'theme', 'chartDefaultSeries'])) {
                unitSelect.value = unitPreference(settings);
                if (chartInstance) renderData(); else applyPanelTheme();
            }
        });

        // 5. Native DOM XML Extraction Engine
        scheduleMapLayerSync();
        try {
            const response = await fetchPeakbaggerDocument(gpxLink.href, {
                kind: 'gpx',
                mimeType: 'text/xml',
            });
            if (response.kind !== 'ok') {
                stats.textContent = PeakbaggerError.message(response.error);
                return;
            }
            const xml = response.document;
            const trkpts = Array.from(xml.querySelectorAll('trkpt'));
            if (!trkpts.length) return stats.textContent = 'No track points found.';

            mapRouteSegments = parseMapRouteSegments(xml);
            terrainCoordinator.update();

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
                syncCoordinateSelection({ unavailable: true });
                const hasValidCoordinates = parsedPoints.some(point =>
                    GpxMetrics.isValidCoordinate(point.lat, point.lon));
                return stats.textContent = hasValidCoordinates
                    ? 'This GPS track has no usable elevation data.'
                    : 'No valid track points found.';
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
                // A zone id from the packaged raster may be unknown to this
                // browser's ICU after a tzdata rename. Keep the labelled solar
                // estimate instead of losing the analyzer.
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
            stats.textContent = 'Error parsing GPX file.';
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
