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

import { gpxParse as GpxParse } from './gpx-parse.js';
import { gpxMetrics as GpxMetrics } from './gpx-metrics.js';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.js';
import { fetchPeakbaggerDocument } from '../peakbagger/peakbagger-request.js';
import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { themeResolve as ThemeResolve } from '../theme/theme-resolve.js';
import { pageSettingsClient as PageSettingsClient } from '../settings/page-settings-client.js';
import { peakMarkers } from '../maps/peak-markers.js';
import { mountainTime as MountainTime } from '../time/mountain-time.js';
import { terrainBasemap } from '../terrain/terrain-basemap.js';
import { terrainCompass as TerrainCompass } from '../terrain/terrain-compass.js';
import { terrainCoordinator as TerrainCoordinator } from '../terrain/terrain-coordinator.js';
import { terrainFailure as TerrainFailure } from '../terrain/terrain-failure.js';
import { units as Units } from '../ui/units.js';
import { pageLifecycle as PageLifecycle } from '../ui/page-lifecycle.js';
import { mapViewport as MapViewport } from './map-viewport.js';
import { mapFrameLifecycle as MapFrameLifecycle } from './map-frame-lifecycle.js';
import { mapOverlay as MapOverlay } from './map-overlay.js';
import { gpxPanelCss } from './gpx-panel-css.js';
import { ascentPage as AscentPage } from '../ascent/ascent-page.js';
import { sunState as SunState } from '../sun/sun-state.js';
import { sunCalculator as SunCalculator } from '../sun/sun-calculator.js';

// Chart remains a separately-loaded vendor global (see manifest). The mountain
// time module owns the bundled offline timezone resolver.
const run = async () => {
    const { METERS_PER_MILE, FEET_PER_METER } = Units;
    const MAP_VIEWPORT_MIN_WIDTH = Schema.BOUNDS.viewportWidth.min;
    const MAP_VIEWPORT_MAX_WIDTH = Schema.BOUNDS.viewportWidth.max;
    const MAP_VIEWPORT_MIN_HEIGHT = Schema.BOUNDS.viewportHeight.min;
    const MAP_VIEWPORT_MAX_HEIGHT = Schema.BOUNDS.viewportHeight.max;
    const MAP_RESIZE_RAIL_HEIGHT = 44;
    const COORDINATE_HINT = 'Click the chart or use \u2190/\u2192 to select a point';
    const SUN_SELECTION_PROMPT = 'Select a chart point to calculate the Sun and Moon.';
    const MAP_RESIZE_PERSIST_DELAY_MS = 400;
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
        let routeExplorer = null;
        let mapColumn = null;
        let mapViewport = null;
        let syncRouteExplorerLayout = () => {};

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
            onInvalidated: () => {
                syncRouteExplorerLayout();
                terrainCoordinator?.position();
            },
            // The map gains a shrink-wrapped flex column after the analyzer
            // mounts. Resize against the full route explorer so dragging can
            // still grow the map until the layout naturally wraps.
            getResizeBoundary: () => routeExplorer || mapViewport?.parentElement,
        });
        mapViewport = viewport.element;
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
        stats.setAttribute('role', 'status');
        stats.setAttribute('aria-live', 'polite');
        stats.setAttribute('aria-atomic', 'true');
        Object.assign(stats.style, { fontFamily: 'sans-serif', fontWeight: 'bold' });
        stats.textContent = 'Analyzing GPX data…';

        const subStats = document.createElement('div');
        subStats.className = 'bpb-gpx-substats';
        Object.assign(subStats.style, { fontFamily: 'sans-serif', fontSize: '0.9em', marginTop: '4px', fontStyle: 'italic' });

        const retryButton = document.createElement('button');
        retryButton.className = 'bpb-gpx-retry';
        retryButton.type = 'button';
        retryButton.textContent = 'Try loading again';
        retryButton.hidden = true;

        statsContainer.append(stats, subStats, retryButton);

        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'bpb-gpx-controls';
        controlsContainer.hidden = true;
        Object.assign(controlsContainer.style, {
            display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end',
            alignItems: 'center', gap: '6px 10px'
        });

        const unitSelect = document.createElement('select');
        unitSelect.id = 'bpb-gpx-units';
        unitSelect.setAttribute('aria-label', 'Units');
        Object.assign(unitSelect.style, { padding: '2px 6px', borderRadius: '4px', borderWidth: '1px', borderStyle: 'solid', cursor: 'pointer' });
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
        routeStyleControls.className = 'bpb-gpx-route-style-controls';
        Object.assign(routeStyleControls.style, {
            display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8em'
        });

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
        coordinateControls.hidden = true;

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
        Object.assign(hintText.style, { fontSize: '0.8em' });
        hintText.textContent = COORDINATE_HINT;

        const coordinateFallback = document.createElement('input');
        coordinateFallback.className = 'bpb-gpx-coordinate-fallback';
        coordinateFallback.type = 'text';
        coordinateFallback.readOnly = true;
        coordinateFallback.hidden = true;
        coordinateFallback.setAttribute('aria-label', 'Selected coordinates');

        coordinateControls.append(copyCoordinatesButton, hintText, coordinateFallback);
        controlsContainer.append(unitSelect, routeStyleControls);
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
        canvasContainer.hidden = true;
        Object.assign(canvasContainer.style, { position: 'relative', height: '300px', width: '100%' });

        const canvas = document.createElement('canvas');

        const chartLegend = document.createElement('div');
        chartLegend.id = 'bpb-gpx-chart-legend';
        chartLegend.className = 'bpb-gpx-chart-legend';
        chartLegend.setAttribute('role', 'group');
        chartLegend.setAttribute('aria-label', 'Chart series');
        chartLegend.hidden = true;

        canvasContainer.append(canvas);
        container.append(headerBox, terrainMessage, coordinateControls, chartLegend, canvasContainer);
        const ascentDate = AscentPage.parseDate(document);
        const sunState = SunState.create();
        let sunCalculator = null;
        let hoverSunState = null;
        let hoverSunPoint = null;
        let pendingHoverSunPoint = null;
        let hoverSunFrameHandle = null;
        const clearHoverSunPreview = () => {
            if (hoverSunFrameHandle !== null) window.cancelAnimationFrame(hoverSunFrameHandle);
            hoverSunFrameHandle = null;
            pendingHoverSunPoint = null;
            hoverSunPoint = null;
            hoverSunState = null;
        };
        const renderSun = state => sunCalculator?.render(state);
        const setSunBearing = bearing => {
            const nextBearing = Number.isFinite(bearing) ? bearing : 0;
            const selectedState = sunState.setMapBearing(nextBearing);
            const visibleState = hoverSunState
                ? hoverSunState.setMapBearing(nextBearing)
                : selectedState;
            sunCalculator?.setMapBearing(visibleState);
        };
        const resetSun = message => {
            clearHoverSunPreview();
            sunState.resetSubject();
            sunCalculator?.setUnavailable(message || 'Sun position is unavailable.');
        };
        const promptSunSelection = () => {
            clearHoverSunPreview();
            sunState.resetSubject();
            sunCalculator?.setPrompt(SUN_SELECTION_PROMPT);
        };
        const selectedPointForSun = point => metrics.timeQuality?.reason === 'not-progressing'
            ? { ...point, timeState: 'suspect' }
            : point;
        const applyHoverSunPreview = () => {
            hoverSunFrameHandle = null;
            const point = pendingHoverSunPoint;
            pendingHoverSunPoint = null;
            if (!point) return;

            const preview = SunState.create();
            preview.setMapBearing(sunState.get().mapBearing);
            let previewState = preview.selectRoutePoint(
                selectedPointForSun(point), ascentDate, mountainZone
            );
            const selectedMinute = sunState.get().minute;
            if (point.timeState !== 'valid' && Number.isInteger(selectedMinute)) {
                previewState = preview.setPreviewMinute(selectedMinute);
            }
            hoverSunPoint = point;
            hoverSunState = preview;
            renderSun(previewState);
        };
        const previewSunPoint = point => {
            if (point === hoverSunPoint && hoverSunState) return;
            pendingHoverSunPoint = point;
            if (hoverSunFrameHandle === null) {
                hoverSunFrameHandle = window.requestAnimationFrame(applyHoverSunPreview);
            }
        };
        const selectSunPoint = point => renderSun(sunState.selectRoutePoint(
            selectedPointForSun(point), ascentDate, mountainZone
        ));
        sunCalculator = SunCalculator.create({
            mount: container,
            mode: 'gpx',
            onMinuteChange: minute => renderSun(sunState.setPreviewMinute(minute)),
        });
        const fullScreenMapLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('Full Screen Map'));
        if (fullScreenMapLink) {
            fullScreenMapLink.before(container);
            if (mapViewport?.parentNode === fullScreenMapLink.parentNode) {
                const mapDetailsNodes = [];
                for (let node = mapViewport.nextSibling; node && node !== fullScreenMapLink;
                    node = node.nextSibling) {
                    if (node !== container && node !== gpxLink) mapDetailsNodes.push(node);
                }
                routeExplorer = document.createElement('div');
                routeExplorer.id = 'bpb-route-explorer';
                routeExplorer.setAttribute('role', 'region');
                routeExplorer.setAttribute('aria-label', 'Route explorer');
                mapColumn = document.createElement('div');
                mapColumn.className = 'bpb-route-explorer__map-column';
                const mapDetails = document.createElement('div');
                mapDetails.className = 'bpb-route-explorer__map-details';
                mapViewport.before(routeExplorer);
                routeExplorer.append(mapColumn, container);
                mapColumn.append(mapViewport, mapDetails);
                mapDetails.append(...mapDetailsNodes, fullScreenMapLink);
                syncRouteExplorerLayout = () => {
                    const mapRect = mapColumn?.getBoundingClientRect();
                    const analysisRect = container.getBoundingClientRect();
                    if (!mapRect || !analysisRect) return;
                    const sideBySide = mapRect.right <= analysisRect.left + 1;
                    routeExplorer.dataset.layout = sideBySide ? 'side' : 'stacked';
                };
                scheduleMapInvalidate();
            }
        } else gpxLink.after(container);

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
            sunCalculator?.setTheme(theme);
        };
        applyPanelTheme();

        // 2. Formatting Helpers
        // Clock times and day boundaries use the climb's local time, not the
        // viewer's. The track's starting coordinate resolves to an IANA zone
        // via the offline tz-lookup raster bundled into this script, so
        // Intl applies the political zone and DST rules for the trip's date.
        // If the resolver or formatter throws, the offset falls back to solar time
        // rounded to the whole hour from the start longitude, and the stats
        // bar labels that estimate. GPX timestamps are UTC; the fallback
        // shifts the epoch and formats in UTC to get the same wall clock.
        // See docs/mountain-local-time.md.
        let mountainZone = null;
        const mountainZoneLabel = referenceMs => MountainTime.zoneLabel(mountainZone, referenceMs);
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
                dayNumber = MountainTime.localDayNumber(mountainZone, ms);
                mountainDayCache.set(key, dayNumber);
            }
            return dayNumber;
        };
        const getRelativeDay = (ms, startMs) => mountainDayNumber(ms) - mountainDayNumber(startMs) + 1;
        const formatTimeStr = (ms, startMs, isMultiDay) => {
            const timeStr = MountainTime.formatClock(mountainZone, ms);
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
        let timeChartData = [];
        let lastChartPointBudget = 0;
        let chartResizeObserver = null;
        let chartResizeFrame = null;
        let chartMode = 'elevation';
        let hasTimeSeries = false;
        let selectedCoordinateIndex = -1;
        let selectedCoordinateSeries = 'distance';
        let selectedChartValues = () => [];
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
        const chartDatasetVisible = (chart, index) =>
            typeof chart?.isDatasetVisible === 'function'
                ? chart.isDatasetVisible(index)
                : chart?.data?.datasets?.[index]?.hidden !== true;
        const coordinatePointsFor = series => (series === 'time' && hasTimeSeries ? timeChartData : chartData)
            .filter(isCoordinatePoint);
        const chartDescription = () => chartMode === 'elevation'
            ? 'elevation chart'
            : chartMode === 'progress' ? 'route progress chart' : 'route position chart';
        const defaultCoordinateSeries = () => {
            if (!hasTimeSeries) return chartMode === 'progress' ? 'time' : 'distance';
            if (chartInstance && Array.isArray(chartInstance.data?.datasets)
                && typeof chartInstance.isDatasetVisible === 'function') {
                const visibleSeries = chartInstance.data.datasets
                    .map((dataset, index) => chartDatasetVisible(chartInstance, index)
                        ? dataset._bpbSeries
                        : null)
                    .filter(Boolean);
                if (visibleSeries.length === 1) return visibleSeries[0];
            }
            return resolveChartSeries(BPB.get()) === 'time' ? 'time' : 'distance';
        };
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
            const selectable = coordinatePointsFor(selectedCoordinateSeries);
            const position = selectable.indexOf(point);
            const values = selectedChartValues(point);
            return `Selected point ${position + 1} of ${selectable.length}: ${coordinateText(point)}`
                + (values.length ? `. ${values.join('. ')}` : '');
        };
        const syncCoordinateSelection = ({ unavailable = false } = {}) => {
            const selectedPoint = chartData[selectedCoordinateIndex];
            const hasSelection = isCoordinatePoint(selectedPoint);
            copyCoordinatesButton.disabled = !hasSelection;
            if (!hasSelection) {
                selectedCoordinateIndex = -1;
                selectedCoordinateSeries = defaultCoordinateSeries();
                coordinateFallback.hidden = true;
                coordinateFallback.value = '';
                setCoordinateStatus(unavailable
                    ? 'No chart point with coordinates is available.'
                    : COORDINATE_HINT);
                if (unavailable) resetSun('No selected track point is available.');
                else promptSunSelection();
            }
            canvas.setAttribute('aria-label', hasSelection
                ? `Interactive ${chartDescription()}. ${selectedCoordinateAnnouncement()}. Use Left and Right Arrow keys to move.`
                : `Interactive ${chartDescription()}. Use Left and Right Arrow keys to select a point.`);
        };
        const restoreSelectedSun = () => {
            clearHoverSunPreview();
            if (isCoordinatePoint(chartData[selectedCoordinateIndex])) renderSun(sunState.get());
            else promptSunSelection();
        };
        const selectCoordinateIndex = (index, series = 'distance') => {
            if (!isCoordinatePoint(chartData[index])) return false;
            clearHoverSunPreview();
            clearCoordinateFeedbackTimer();
            selectedCoordinateIndex = index;
            selectedCoordinateSeries = series === 'time' && hasTimeSeries ? 'time' : 'distance';
            coordinateFallback.hidden = true;
            coordinateFallback.value = '';
            copyCoordinatesButton.disabled = false;
            setCoordinateStatus(selectedCoordinateAnnouncement());
            canvas.setAttribute(
                'aria-label',
                `Interactive ${chartDescription()}. ${selectedCoordinateAnnouncement()}. Use Left and Right Arrow keys to move.`
            );
            if (chartInstance) chartInstance.update('none');
            renderRouteHighlight(chartData[index], selectedCoordinateSeries);
            selectSunPoint(chartData[index]);
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
                const dataset = chartInstance.data.datasets[active.datasetIndex];
                const point = dataset?.data[active.index]?._raw;
                const index = chartData.indexOf(point);
                const series = dataset?._bpbSeries || 'distance';
                if (selectCoordinateIndex(index, series)) return true;
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
                syncCoordinateSelection({ unavailable: coordinatePointsFor(defaultCoordinateSeries()).length === 0 });
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
            const series = selectedCoordinateIndex >= 0
                ? selectedCoordinateSeries
                : defaultCoordinateSeries();
            const selectable = coordinatePointsFor(series);
            if (!selectable.length) {
                syncCoordinateSelection({ unavailable: true });
                return;
            }
            const currentPoint = chartData[selectedCoordinateIndex];
            const currentPosition = selectable.indexOf(currentPoint);
            const nextPosition = currentPosition < 0
                ? (event.key === 'ArrowRight' ? 0 : selectable.length - 1)
                : Math.max(0, Math.min(
                    selectable.length - 1,
                    currentPosition + (event.key === 'ArrowRight' ? 1 : -1)
                ));
            selectCoordinateIndex(chartData.indexOf(selectable[nextPosition]), series);
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
            queueMicrotask(() => restoreSelectedRouteHighlight());
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
                queueMicrotask(() => restoreSelectedRouteHighlight());
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
            onView: setSunBearing,
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
            onFrameReload: () => {
                hoverMarker = null;
                queueMicrotask(() => restoreSelectedRouteHighlight());
            },
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
                const selectedPoint = chartData[selectedCoordinateIndex];
                if (isCoordinatePoint(selectedPoint)) selectSunPoint(selectedPoint);
                else promptSunSelection();
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
        PageLifecycle.create({
            onSuspend: () => {
                clearCoordinateFeedbackTimer();
                clearHoverSunPreview();
                // A loading frame owns a deadline that cannot advance while
                // the document is frozen. Discard that transient attempt; an
                // already-active 3D surface remains intact in the cached DOM.
                if (terrainCoordinator.isOpen() && !terrainCoordinator.isActive()) {
                    terrainCoordinator.reset();
                }
            },
            onResume: () => {
                BPB.refresh();
                const frame = frameLifecycle.refresh();
                if (frame) viewport.attach(frame);
                scheduleMapLayerSync();
                scheduleRouteOverlay();
                scheduleMapInvalidate();
                terrainCoordinator.update();
                terrainCoordinator.position();
            },
            onDispose: () => {
                clearCoordinateFeedbackTimer();
                clearHoverSunPreview();
                if (terrainCoordinator.isOpen()) terrainCoordinator.reset();
                sunState.resetSubject();
                sunCalculator?.dispose();
                sunCalculator = null;
                BPB.dispose();
                overlay.dispose();
                frameLifecycle.dispose();
                viewport.dispose();
                if (chartResizeObserver) chartResizeObserver.disconnect();
                if (chartResizeFrame !== null) cancelAnimationFrame(chartResizeFrame);
                if (chartInstance) chartInstance.destroy();
            },
        });

        // Chart.js runs `onHover` only while the pointer is inside the plot
        // rectangle. On exit, restore the point the user deliberately selected
        // (if any) instead of letting a transient hover replace it. The boundary
        // is the canvas rather than the plot rectangle so Chart.js can retain
        // its own tooltip while the pointer crosses the axis gutter and legend.
        let routeHighlightShown = false;
        const renderRouteHighlight = (point, series = 'distance') => {
            const highlightedPoint = isCoordinatePoint(point) ? point : null;
            if (!highlightedPoint && !routeHighlightShown) return;
            routeHighlightShown = highlightedPoint !== null;
            const fillColor = series === 'time' ? '#0055FF' : '#FF0000';
            const hoverFrame = currentMapIframe();
            const iframeWin = hoverFrame ? hoverFrame.contentWindow : null;

            if (terrainCoordinator.isActive()) {
                postTerrain('highlight', {
                    coordinates: highlightedPoint ? [highlightedPoint.lon, highlightedPoint.lat] : null,
                    series
                });
            }

            if (highlightedPoint && !terrainCoordinator.isActive()
                && iframeWin && iframeWin.mapsPlaceholder && iframeWin.L) {
                ensureRouteOverlay();
                const L = iframeWin.L;
                const map = iframeWin.mapsPlaceholder;

                // Recreate marker if it doesn't match the current map instance (e.g. iframe reloaded)
                if (hoverMarker) {
                    try {
                        if (hoverMarker._map !== map) hoverMarker = null;
                    } catch (e) {
                        hoverMarker = null;
                    }
                }

                if (!hoverMarker) {
                    hoverMarker = L.circleMarker([highlightedPoint.lat, highlightedPoint.lon], {
                        radius: 9,
                        color: '#FFFFFF',
                        fillColor,
                        fillOpacity: 1,
                        opacity: 1,
                        weight: 2
                    }).addTo(map);
                } else {
                    hoverMarker.setLatLng([highlightedPoint.lat, highlightedPoint.lon]);
                    hoverMarker.setStyle({ color: '#FFFFFF', fillColor, opacity: 1, fillOpacity: 1 });
                }
            } else if (hoverMarker) {
                hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
            }
        };
        const restoreSelectedRouteHighlight = () => renderRouteHighlight(
            chartData[selectedCoordinateIndex],
            selectedCoordinateSeries
        );
        canvas.addEventListener('mouseleave', () => {
            restoreSelectedRouteHighlight();
            restoreSelectedSun();
        });

        const renderUnavailable = (message, { retryable = false } = {}) => {
            clearCoordinateFeedbackTimer();
            if (chartInstance) {
                chartInstance.destroy();
                chartInstance = null;
            }
            renderRouteHighlight(null);
            mapRouteSegments = [];
            removeRouteOverlay();
            terrainCoordinator.reset();
            resetSun('Sun position is unavailable.');

            chartData = [];
            timeChartData = [];
            hasTimeSeries = false;
            selectedCoordinateIndex = -1;
            selectedCoordinateSeries = 'distance';
            selectedChartValues = () => [];
            metrics = { distanceM: 0, gainM: 0, rawDistanceM: 0, rawGainM: 0 };
            totalMs = 0;
            hasTime = false;
            startMs = 0;
            endMs = 0;
            summitMs = 0;
            campingSpots = [];
            mountainZone = null;
            mountainDayCache.clear();

            coordinateFallback.hidden = true;
            coordinateFallback.value = '';
            copyCoordinatesButton.disabled = true;
            setCoordinateStatus('');
            controlsContainer.hidden = true;
            coordinateControls.hidden = true;
            chartLegend.hidden = true;
            chartLegend.replaceChildren();
            canvasContainer.hidden = true;
            canvas.tabIndex = -1;
            canvas.removeAttribute('role');
            canvas.removeAttribute('aria-label');
            canvas.removeAttribute('aria-describedby');
            canvas.removeAttribute('aria-keyshortcuts');
            subStats.replaceChildren();
            stats.dataset.state = 'error';
            stats.textContent = message;
            retryButton.hidden = !retryable;
            retryButton.disabled = false;
        };

        // 4. Chart & UI Renderer Engine
        const chartPointBudget = () => {
            const width = canvasContainer.getBoundingClientRect().width
                || container.getBoundingClientRect().width
                || 640;
            return Math.max(256, Math.min(1200, Math.ceil(width)));
        };
        const sampleChartData = selectedPoint => {
            const budget = chartPointBudget();
            lastChartPointBudget = budget;
            const required = selectedPoint ? [selectedPoint] : [];

            if (chartMode === 'elevation') {
                const distanceSource = metrics.points;
                const timeSource = hasTime
                    ? metrics.points.filter(point => point.timeState === 'valid')
                        .sort((a, b) => a.ms - b.ms)
                    : [];
                const distanceBudget = timeSource.length ? Math.ceil(budget / 2) : budget;
                const timeBudget = timeSource.length ? Math.floor(budget / 2) : 0;
                const included = new Set(GpxMetrics.sampleChartPoints(distanceSource, distanceBudget, {
                    groupProperty: 'coordinateGroup',
                    valueProperty: 'eleM',
                    required,
                }));
                GpxMetrics.sampleChartPoints(timeSource, timeBudget, {
                    groupProperty: 'timeCoordinateGroup',
                    valueProperty: 'eleM',
                    required,
                }).forEach(point => included.add(point));
                chartData = distanceSource.filter(point => included.has(point));
                timeChartData = timeSource.filter(point => included.has(point));
            } else if (chartMode === 'progress') {
                timeChartData = GpxMetrics.sampleChartPoints(metrics.timePoints, budget, {
                    groupProperty: 'timeCoordinateGroup',
                    valueProperty: 'distM',
                    required,
                });
                const included = new Set(timeChartData);
                chartData = metrics.routePoints.filter(point => included.has(point));
            } else {
                chartData = GpxMetrics.sampleChartPoints(metrics.routePoints, budget, {
                    groupProperty: 'coordinateGroup',
                    valueProperty: 'distM',
                    required,
                });
                timeChartData = [];
            }
            hasTimeSeries = chartMode === 'progress'
                ? timeChartData.length >= 2
                : hasTime && timeChartData.length >= 2;
        };

        const renderData = ({ resetSeriesVisibility = false } = {}) => {
            const selectedBeforeRebuild = chartData[selectedCoordinateIndex];
            sampleChartData(selectedBeforeRebuild);
            selectedCoordinateIndex = selectedBeforeRebuild
                ? chartData.indexOf(selectedBeforeRebuild)
                : -1;
            clearHoverSunPreview();
            if (selectedBeforeRebuild) promptSunSelection();
            const p = panelPalette();
            applyPanelTheme();
            controlsContainer.hidden = false;
            retryButton.hidden = true;
            delete stats.dataset.state;
            canvasContainer.hidden = false;
            canvasContainer.style.height = chartMode === 'route' ? '110px'
                : chartMode === 'progress' ? '260px' : '300px';
            canvas.tabIndex = 0;
            canvas.setAttribute('role', 'application');
            canvas.setAttribute('aria-describedby', hintText.id);
            canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
            coordinateControls.hidden = false;
            chartLegend.hidden = false;

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
                const gainWorthShowing = chartMode === 'elevation'
                    && Math.abs(gainDeltaM) >= Math.max(0.05 * Math.max(metrics.gainM, 1), 100 / FEET_PER_METER);
                const parts = [];

                if (distWorthShowing) parts.push(`${formatSignedDistanceDelta(distDeltaM)} distance`);
                if (gainWorthShowing) parts.push(`${formatSignedElevationDelta(gainDeltaM)} gain`);

                if (parts.length) return `Adjusted GPX metrics (raw GPX ${parts.join(', ')})`;
                return chartMode === 'elevation' ? 'Adjusted GPX metrics' : '';
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
            const qualityIssues = (quality, type) => {
                const parts = [];
                if (quality.missingPoints) parts.push(`${quality.missingPoints} missing`);
                if (quality.invalidPoints) parts.push(`${quality.invalidPoints} malformed`);
                if (quality.suspectPoints) {
                    parts.push(`${quality.suspectPoints} outside the plausible ${type} range`);
                }
                return parts.join(', ');
            };
            const qualityPercent = quality => Math.round(quality.coverage * 100);
            const qualityLines = [];
            if (metrics.coordinateQuality.invalidPoints) {
                const count = metrics.coordinateQuality.invalidPoints;
                qualityLines.push(`${count} track ${count === 1 ? 'point has' : 'points have'} invalid coordinates and ${count === 1 ? 'was' : 'were'} excluded.`);
            }
            if (metrics.elevationQuality.status !== 'complete') {
                const quality = metrics.elevationQuality;
                if (quality.validPoints) {
                    qualityLines.push(
                        `Elevation: ${quality.validPoints} of ${quality.totalPoints} route points (${qualityPercent(quality)}%); ${qualityIssues(quality, 'elevation')}. Gaps mark unavailable data.`
                    );
                } else {
                    const issues = qualityIssues(quality, 'elevation');
                    qualityLines.push(`Elevation data is unavailable in this GPX.${issues ? ` ${issues}.` : ''}`);
                }
            }
            if (metrics.timeQuality.status !== 'complete') {
                const quality = metrics.timeQuality;
                if (quality.status === 'partial') {
                    qualityLines.push(
                        `Time: ${quality.validPoints} of ${quality.totalPoints} route points (${qualityPercent(quality)}%); ${qualityIssues(quality, 'time')}. Gaps mark unavailable timestamps.`
                    );
                } else if (quality.reason === 'not-progressing') {
                    qualityLines.push('Time data is unavailable because the timestamps do not progress.');
                } else if (quality.reason === 'insufficient') {
                    qualityLines.push('Time data is unavailable because fewer than two distinct timestamps are usable.');
                } else {
                    const issues = qualityIssues(quality, 'time');
                    qualityLines.push(`Time data is unavailable in this GPX.${issues ? ` ${issues}.` : ''}`);
                }
            }

            let txt = chartMode === 'elevation'
                ? `Interactive Stats: ${formatDistanceM(metrics.distanceM)} | ${formatElevationM(metrics.gainM)} gain`
                : chartMode === 'progress'
                    ? `Route Progress: ${formatDistanceM(metrics.distanceM)}`
                    : `Route: ${formatDistanceM(metrics.distanceM)}`;
            const subLines = [];
            const metricNote = buildMetricNote();
            if (metricNote) {
                subLines.push(subLine(metricNote, { color: TONE.muted, fontSize: '0.95em', marginBottom: '2px' }));
            }
            if (hasTime) {
                const completeTime = metrics.timeQuality.status === 'complete';
                txt += ` | ${completeTime ? 'Time' : 'Known time span'}: ${fmtTime(totalMs)}`;
                if (completeTime && summitMs > startMs) {
                    const timeToSummit = summitMs - startMs;
                    const timeBack = endMs - summitMs;
                    subLines.push(subLine(
                        `Start time: ${formatTimeStr(startMs, startMs, isMultiDay)} | Summit time: ${formatTimeStr(summitMs, startMs, isMultiDay)} | Back to car: ${formatTimeStr(endMs, startMs, isMultiDay)}`,
                        { color: TONE.sub, marginBottom: '2px' }));
                    subLines.push(subLine(
                        `Time to summit: ${fmtTime(timeToSummit)} | Time back: ${fmtTime(timeBack)}`,
                        { color: TONE.faint, fontSize: '0.95em' }));
                } else if (completeTime) {
                    subLines.push(subLine(
                        `Start time: ${formatTimeStr(startMs, startMs, isMultiDay)} | Back to car: ${formatTimeStr(endMs, startMs, isMultiDay)}`,
                        { color: TONE.sub, marginBottom: '2px' }));
                } else {
                    subLines.push(subLine(
                        `First known time: ${formatTimeStr(startMs, startMs, isMultiDay)} | Last known time: ${formatTimeStr(endMs, startMs, isMultiDay)}`,
                        { color: TONE.sub, marginBottom: '2px' }));
                }
                if (campingSpots.length > 0) {
                    const spotStrs = campingSpots.map(s => `Day ${s.day} (${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})`).join(' | ');
                    subLines.push(subLine(`Possible Camping: ${spotStrs}`, { color: TONE.faint, fontSize: '0.95em', marginTop: '2px' }));
                }
                subLines.push(subLine(
                    `Times in the mountain’s local time (${mountainZoneLabel(startMs)})`,
                    { color: TONE.faint, fontSize: '0.95em', marginTop: '2px' }));
            }
            qualityLines.forEach(text => {
                subLines.push(subLine(text, {
                    color: TONE.sub,
                    fontSize: '0.95em',
                    marginTop: '3px',
                    fontStyle: 'normal'
                }));
            });
            stats.textContent = txt;
            subStats.replaceChildren(...subLines);

            // Map adjusted arrays
            const distanceData = [], timeData = [];
            const appendChartPoint = (target, point, x, y, groupProperty = 'coordinateGroup') => {
                const previous = target.at(-1)?._raw;
                if (previous && previous[groupProperty] !== point[groupProperty]) {
                    target.push({ x, y: null, _raw: null });
                }
                target.push({ x, y, _raw: point });
            };
            if (chartMode === 'elevation') {
                chartData.forEach(d => {
                    const eleConv = parseFloat((d.eleM * eMult).toFixed(0));
                    appendChartPoint(
                        distanceData,
                        d,
                        parseFloat((d.distM * dMult).toFixed(2)),
                        eleConv
                    );
                });
                timeChartData.forEach(d => {
                    const eleConv = parseFloat((d.eleM * eMult).toFixed(0));
                    appendChartPoint(timeData, d, d.ms, eleConv, 'timeCoordinateGroup');
                });
            } else if (chartMode === 'progress') {
                timeChartData.forEach(d => {
                    appendChartPoint(
                        timeData,
                        d,
                        d.ms,
                        parseFloat((d.distM * dMult).toFixed(2)),
                        'timeCoordinateGroup'
                    );
                });
            } else {
                chartData.forEach(d => {
                    appendChartPoint(
                        distanceData,
                        d,
                        parseFloat((d.distM * dMult).toFixed(2)),
                        0
                    );
                });
            }

            // Initial series visibility follows the setting, but only when both
            // series exist (a time series needs timestamps). The legend's click
            // handler can still reveal the hidden one for this view; it doesn't
            // write the setting, so the peek is transient.
            const seriesPref = resolveChartSeries(BPB.get());
            const splittable = chartMode === 'elevation' && hasTimeSeries;
            const hideDistance = splittable && seriesPref === 'time';
            const hideTime = splittable && seriesPref === 'distance';

            const selectedPointRadius = context =>
                context.raw?._raw === chartData[selectedCoordinateIndex] ? 5 : 0;
            const datasets = [];
            if (chartMode === 'elevation') {
                datasets.push({
                    label: 'Elevation by Distance',
                    data: distanceData,
                    hidden: hideDistance,
                    _bpbSeries: 'distance',
                    borderColor: '#fc4c02',
                    backgroundColor: 'rgba(252, 76, 2, 0.15)',
                    borderWidth: 2, fill: true, tension: 0.2, yAxisID: 'y', xAxisID: 'x',
                    pointRadius: selectedPointRadius, pointHoverRadius: 5, hitRadius: 40
                });
                if (hasTimeSeries) {
                    datasets.push({
                        label: 'Elevation by Time',
                        data: timeData,
                        hidden: hideTime,
                        _bpbSeries: 'time',
                        borderColor: '#6ab0de',
                        backgroundColor: 'rgba(0, 127, 182, 0.15)',
                        borderWidth: 2, fill: true, tension: 0.2, yAxisID: 'y', xAxisID: 'xTime',
                        pointRadius: selectedPointRadius, pointHoverRadius: 5, hitRadius: 40
                    });
                }
            } else if (chartMode === 'progress') {
                datasets.push({
                    label: 'Distance over Time',
                    data: timeData,
                    _bpbSeries: 'time',
                    borderColor: '#6ab0de',
                    backgroundColor: 'rgba(0, 127, 182, 0.12)',
                    borderWidth: 2, fill: false, tension: 0.15, yAxisID: 'yDistance', xAxisID: 'xTime',
                    pointRadius: selectedPointRadius, pointHoverRadius: 5, hitRadius: 40
                });
            } else {
                datasets.push({
                    label: 'Route Position',
                    data: distanceData,
                    _bpbSeries: 'distance',
                    borderColor: '#fc4c02',
                    backgroundColor: 'rgba(252, 76, 2, 0.15)',
                    borderWidth: 3, fill: false, tension: 0, yAxisID: 'yRoute', xAxisID: 'x',
                    pointRadius: selectedPointRadius, pointHoverRadius: 5, hitRadius: 40
                });
            }

            // One formatter owns the visual tooltip and the semantic selected-
            // point announcement. A missing elevation, time, or grade stays
            // absent instead of being restated as zero or inferred data.
            const formatChartPoint = (point, dataset, y) => {
                if (!point) return { title: '', label: '', afterBody: [] };
                const title = chartMode === 'progress'
                    ? `Time: ${formatTimeStr(point.ms, startMs, isMultiDay)}`
                    : `Distance: ${(point.distM * dMult).toFixed(2)} ${dUnit}`;
                let label;
                if (chartMode === 'progress') {
                    label = `Distance traveled: ${(point.distM * dMult).toFixed(2)} ${dUnit}`;
                } else if (chartMode === 'route') {
                    label = 'Recorded route position';
                } else {
                    label = `${dataset.label}: ${y} ${eUnit}`;
                    if (Number.isFinite(point.grade)) label += ` (Grade: ${point.grade.toFixed(1)}%)`;
                }
                const afterBody = chartMode !== 'progress'
                    && hasTime && Number.isFinite(point.ms) && point.ms > 0
                    ? [`Time: ${formatTimeStr(point.ms, startMs, isMultiDay)}`]
                    : [];
                return { title, label, afterBody };
            };

            selectedChartValues = point => {
                const values = [];
                const add = value => {
                    if (value && !values.includes(value)) values.push(value);
                };
                datasets.forEach((dataset, index) => {
                    if (chartInstance && !chartDatasetVisible(chartInstance, index)) return;
                    const plotted = dataset.data.find(candidate => candidate?._raw === point);
                    if (!plotted || plotted.y == null) return;
                    const formatted = formatChartPoint(point, dataset, plotted.y);
                    add(formatted.title);
                    add(formatted.label);
                    formatted.afterBody.forEach(add);
                });
                return values;
            };

            // Match the legend handler's rule: one series visible -> index mode.
            const startsSingle = datasets.length === 1 || hideDistance || hideTime;

            const maxDist = parseFloat((metrics.distanceM * dMult).toFixed(2));
            const distanceAxis = {
                type: 'linear',
                position: 'bottom',
                min: 0,
                max: maxDist > 0 ? maxDist : 1,
                title: { display: true, text: `Distance (${dUnit})`, color: p.axisTitle },
                grid: { color: p.chartGrid },
                ticks: { maxTicksLimit: 10, color: p.chartText, callback: function (v) { return parseFloat(v).toFixed(1) + ` ${dUnit}`; } }
            };
            const timeAxis = position => ({
                type: 'linear',
                position,
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
                grid: position === 'top' ? { drawOnChartArea: false } : { color: p.chartGrid }
            });
            const scales = chartMode === 'elevation'
                ? {
                    x: distanceAxis,
                    ...(hasTimeSeries && { xTime: timeAxis('top') }),
                    y: {
                        type: 'linear', position: 'left',
                        title: { display: true, text: `Elevation (${eUnit})`, color: p.axisTitle },
                        grid: { color: p.chartGrid },
                        ticks: { color: p.chartText }
                    }
                }
                : chartMode === 'progress'
                    ? {
                        xTime: timeAxis('bottom'),
                        yDistance: {
                            type: 'linear', position: 'left', min: 0,
                            max: maxDist > 0 ? maxDist : 1,
                            title: { display: true, text: `Distance traveled (${dUnit})`, color: p.axisTitle },
                            grid: { color: p.chartGrid },
                            ticks: { color: p.chartText }
                        }
                    }
                    : {
                        x: distanceAxis,
                        yRoute: { display: false, min: -1, max: 1 }
                    };

            const syncChartInteraction = () => {
                const visible = datasets.reduce((count, dataset, index) =>
                    count + (chartDatasetVisible(chartInstance, index) ? 1 : 0), 0);
                chartInstance.options.interaction = visible === 1
                    ? { mode: 'index', intersect: false }
                    : { mode: 'nearest', intersect: true, axis: 'xy' };
            };
            const syncChartLegend = () => {
                chartLegend.querySelectorAll('[data-dataset-index]').forEach(button => {
                    const index = Number(button.dataset.datasetIndex);
                    button.setAttribute('aria-pressed', String(chartDatasetVisible(chartInstance, index)));
                });
            };
            const toggleChartSeries = index => {
                const visible = !chartDatasetVisible(chartInstance, index);
                if (typeof chartInstance.setDatasetVisibility === 'function') {
                    chartInstance.setDatasetVisibility(index, visible);
                } else {
                    chartInstance.data.datasets[index].hidden = !visible;
                }
                syncChartInteraction();
                syncChartLegend();

                const selectedPoint = chartData[selectedCoordinateIndex];
                const selectedSeriesVisible = datasets.some((dataset, datasetIndex) =>
                    dataset._bpbSeries === selectedCoordinateSeries
                    && chartDatasetVisible(chartInstance, datasetIndex));
                if (selectedPoint && !selectedSeriesVisible) {
                    const fallback = datasets.find((dataset, datasetIndex) =>
                        chartDatasetVisible(chartInstance, datasetIndex)
                        && coordinatePointsFor(dataset._bpbSeries).includes(selectedPoint));
                    if (fallback) {
                        selectedCoordinateSeries = fallback._bpbSeries;
                    } else {
                        selectedCoordinateIndex = -1;
                        syncCoordinateSelection();
                    }
                }
                if (selectedCoordinateIndex >= 0) {
                    setCoordinateStatus(selectedCoordinateAnnouncement());
                }
                chartInstance.update('none');
                restoreSelectedRouteHighlight();
            };

            const chartOptions = {
                responsive: true, maintainAspectRatio: false,
                animation: false,
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
                    let hoveredPoint = null;
                    let hoverSeries = 'distance';

                    if (activeElements.length > 0) {
                        const datasetIndex = activeElements[0].datasetIndex;
                        const idx = activeElements[0].index;
                        const dataset = datasets[datasetIndex];
                        const candidate = dataset?.data[idx]?._raw;
                        hoverSeries = dataset?._bpbSeries || 'distance';
                        if (candidate && Number.isFinite(candidate.lat) && Number.isFinite(candidate.lon)) hoveredPoint = candidate;
                    }

                    if (hoveredPoint) {
                        renderRouteHighlight(hoveredPoint, hoverSeries);
                        previewSunPoint(hoveredPoint);
                    } else {
                        restoreSelectedRouteHighlight();
                        restoreSelectedSun();
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        filter: (tooltipItem, index) => index === 0,
                        callbacks: {
                            title: items => {
                                const item = items[0];
                                return formatChartPoint(
                                    item.raw._raw,
                                    item.dataset,
                                    item.parsed.y
                                ).title;
                            },
                            label: item => {
                                return formatChartPoint(
                                    item.raw._raw,
                                    item.dataset,
                                    item.parsed.y
                                ).label;
                            },
                            afterBody: items => {
                                const item = items[0];
                                return formatChartPoint(
                                    item.raw._raw,
                                    item.dataset,
                                    item.parsed.y
                                ).afterBody;
                            }
                        }
                    }
                },
                scales
            };
            if (chartInstance?.data && chartInstance?.options) {
                chartInstance.data.datasets = datasets;
                Object.assign(chartInstance.options, chartOptions);
                if (resetSeriesVisibility && typeof chartInstance.setDatasetVisibility === 'function') {
                    datasets.forEach((dataset, index) =>
                        chartInstance.setDatasetVisibility(index, dataset.hidden !== true));
                }
                syncChartInteraction();
                chartInstance.update('none');
            } else {
                if (chartInstance) chartInstance.destroy();
                chartInstance = new Chart(canvas.getContext('2d'), {
                    type: 'line',
                    data: { datasets },
                    options: chartOptions
                });
            }
            chartLegend.replaceChildren(...datasets.map((dataset, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.datasetIndex = String(index);
                const swatch = document.createElement('span');
                swatch.className = 'bpb-gpx-legend-swatch';
                swatch.setAttribute('aria-hidden', 'true');
                swatch.style.backgroundColor = dataset.borderColor;
                const label = document.createElement('span');
                label.textContent = dataset.label;
                button.append(swatch, label);
                button.addEventListener('click', () => toggleChartSeries(index));
                return button;
            }));
            syncChartLegend();
            syncCoordinateSelection();
            if (isCoordinatePoint(chartData[selectedCoordinateIndex])) {
                selectSunPoint(chartData[selectedCoordinateIndex]);
            }
        };

        if (typeof ResizeObserver === 'function') {
            chartResizeObserver = new ResizeObserver(() => {
                if (!metrics.routePoints?.length || chartPointBudget() === lastChartPointBudget) return;
                if (chartResizeFrame !== null) cancelAnimationFrame(chartResizeFrame);
                chartResizeFrame = requestAnimationFrame(() => {
                    chartResizeFrame = null;
                    if (metrics.routePoints?.length) renderData();
                });
            });
            chartResizeObserver.observe(canvasContainer);
        }

        unitSelect.addEventListener('change', () => {
            BPB.set({ units: unitSelect.value });
            if (metrics.routePoints?.length) renderData();
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
                if (metrics.routePoints?.length) {
                    renderData({ resetSeriesVisibility: changed(['chartDefaultSeries']) });
                }
                else applyPanelTheme();
            }
        });

        // 5. Native DOM XML Extraction Engine
        scheduleMapLayerSync();
        const RETRYABLE_GPX_ERRORS = new Set([
            'cloudflare', 'signed-out', 'network', 'timeout', 'response-read', 'rate-limit', 'server'
        ]);
        let loadGeneration = 0;
        const loadGpx = async () => {
            const generation = ++loadGeneration;
            resetSun('Loading GPX data…');
            retryButton.hidden = true;
            retryButton.disabled = true;
            delete stats.dataset.state;
            stats.textContent = 'Analyzing GPX data…';
            try {
                const response = await fetchPeakbaggerDocument(gpxLink.href, {
                    kind: 'gpx',
                    mimeType: 'text/xml',
                });
                if (generation !== loadGeneration) return;
                if (response.kind !== 'ok') {
                    renderUnavailable(PeakbaggerError.message(response.error), {
                        retryable: RETRYABLE_GPX_ERRORS.has(response.error?.code),
                    });
                    return;
                }
                const xml = response.document;
                const parsedGpx = GpxParse.parseGpxDocument(xml, {
                    includeQuality: true,
                    allowEmpty: true,
                });
                const trackPointCount = parsedGpx.segments
                    .reduce((count, segment) => count + segment.length, 0);
                if (!trackPointCount) {
                    renderUnavailable('No track points found. Download the GPX to inspect its recorded data.');
                    return;
                }
                const routeSegments = parsedGpx.segments.map(segment =>
                    segment.map(point => [point.lat, point.lon]));
                mapRouteSegments = GpxMetrics.sanitizeMapRouteSegments(routeSegments);
                terrainCoordinator.update();
                scheduleRouteOverlay();

                const parsedPoints = parsedGpx.segments.flatMap((segment, coordinateGroup) =>
                    segment.map(parsed => ({
                        lat: parsed.lat,
                        lon: parsed.lon,
                        rawEleM: parsed.ele,
                        elevationState: parsed.elevationState,
                        ms: parsed.time,
                        timeState: parsed.timeState,
                        coordinateGroup,
                    })));

                metrics = GpxMetrics.computeMetrics(parsedPoints);
                hasTime = metrics.hasTime;
                chartMode = metrics.points.length
                    ? 'elevation'
                    : hasTime ? 'progress' : 'route';
                chartData = chartMode === 'elevation'
                    ? metrics.chartPoints
                    : metrics.routeChartPoints;
                timeChartData = chartMode === 'elevation'
                    ? metrics.timeChartPoints
                    : metrics.timeProgressChartPoints;
                startMs = metrics.startMs;
                endMs = metrics.endMs;
                summitMs = metrics.summitMs;
                totalMs = hasTime ? endMs - startMs : 0;
                campingSpots = [];

                // The trailhead decides the climb's civil time. routePoints is
                // already ordered by the metrics layer's safe whole-segment
                // sequencing; timestamp availability must not move timezone
                // ownership to a later point in a partially timed route.
                const startPoint = metrics.routePoints[0];
                if (startPoint) {
                    mountainZone = MountainTime.resolve(startPoint.lat, startPoint.lon);
                    mountainDayCache.clear();
                }

                if (hasTime && metrics.timeQuality.status === 'complete') {
                    metrics.timePoints.forEach((point, index) => {
                        if (index === 0) return;
                        const prev = metrics.timePoints[index - 1];
                        const prevDay = getRelativeDay(prev.ms, startMs);
                        const currDay = getRelativeDay(point.ms, startMs);
                        if (currDay > prevDay) {
                            campingSpots.push({ day: prevDay, lat: prev.lat, lon: prev.lon });
                        }
                    });
                }

                if (!metrics.points.length) {
                    if (metrics.routePoints.length) {
                        renderData();
                        return;
                    }
                    renderUnavailable('No valid track points found. Download the GPX to inspect its recorded data.');
                    return;
                }

                renderData();

            } catch (e) {
                if (generation !== loadGeneration) return;
                const knownMessage = e?.code === 'invalid-gpx' || e?.code === 'gpx-too-large'
                    ? e.message
                    : 'Better Peakbagger could not parse the GPS track. Download the GPX to inspect it.';
                renderUnavailable(knownMessage);
                if (!e?.code) console.error(e);
            }
        };
        retryButton.addEventListener('click', () => { void loadGpx(); });
        void loadGpx();
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initChart);
    } else {
        initChart();
    }
};
run();
