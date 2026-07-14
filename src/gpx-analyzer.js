// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GPX Analyzer content script.
// Runs in the page's MAIN world (see manifest.json) so it can read the raw GPX
// link and reach into Peakbagger's same-origin MasterMap iframe for the hover
// marker. Chart.js is bundled at vendor/chart.umd.min.js and loaded immediately
// before this file, so the global `Chart` is available here.
//
// The MAIN world cannot read chrome.storage, so preferences come from the
// isolated-world bridge (src/bridge.js) over window.postMessage. Affected map
// and chart surfaces update live when settings change.

(async () => {
    'use strict';

    const METERS_PER_MILE = 1609.344;
    const FEET_PER_METER = 3.28084;
    const DIST_CONFIRM_M = 5;
    const ELEVATION_GAIN_THRESHOLD_M = 3;
    const ELEVATION_SMOOTH_WINDOW_M = 30;
    const ELEVATION_SMOOTH_POINT_RADIUS = 10;
    const GRADE_WINDOW_M = 60;
    const GRADE_MIN_DISTANCE_M = 10;
    const GRADE_MAX_LOOKBACK_POINTS = 50;
    const MAX_REASONABLE_SPEED_MPS = 10;
    const PAUSE_RESET_SECONDS = 300;
    const MAX_MAP_ROUTE_POINTS = 3000;
    const DEFAULT_MAP_ROUTE_STYLE = {
        color: '#d9483b', width: 5,
        casingColor: '#ffffff', casingWidth: 9
    };
    const MAP_VIEWPORT_DEFAULT = { width: 450, height: 450 };
    const MAP_VIEWPORT_MIN_WIDTH = 320;
    const MAP_VIEWPORT_MAX_WIDTH = 4096;
    const MAP_VIEWPORT_MIN_HEIGHT = 240;
    const MAP_VIEWPORT_MAX_HEIGHT = 720;
    const MAP_RESIZE_RAIL_HEIGHT = 18;
    const TERRAIN_LOAD_TIMEOUT_MS = 17000;
    const TERRAIN_CACHE_DEFAULT_MB = 256;

    const toRad = x => x * Math.PI / 180;

    const calcDistMeters = (l1, n1, l2, n2) => {
        const a = Math.sin(toRad(l2 - l1) / 2) ** 2 + Math.cos(toRad(l1)) * Math.cos(toRad(l2)) * Math.sin(toRad(n2 - n1) / 2) ** 2;
        return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const median = values => {
        if (!values.length) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const calculatePositiveGainM = elevations => elevations.reduce((gain, ele, index) => {
        if (index === 0) return gain;
        const delta = ele - elevations[index - 1];
        return delta > 0 ? gain + delta : gain;
    }, 0);

    const calculateConfirmedGainM = elevations => {
        if (elevations.length < 2) return 0;

        let gainM = 0;
        let valley = elevations[0];
        let peak = elevations[0];
        let state = 'unknown';

        elevations.forEach(ele => {
            if (state === 'rising') {
                if (ele > peak) {
                    peak = ele;
                } else if (peak - ele >= ELEVATION_GAIN_THRESHOLD_M) {
                    gainM += peak - valley;
                    state = 'falling';
                    valley = ele;
                    peak = ele;
                }
                return;
            }

            if (ele < valley) {
                valley = ele;
                peak = ele;
                return;
            }

            if (ele - valley >= ELEVATION_GAIN_THRESHOLD_M) {
                state = 'rising';
                peak = ele;
            }
        });

        if (state === 'rising') {
            gainM += peak - valley;
        }

        return gainM;
    };

    const smoothElevations = (points, distMByIndex) => {
        const medianElevations = points.map((point, index) => {
            const start = Math.max(0, index - 2);
            const end = Math.min(points.length, index + 3);
            return median(points.slice(start, end).map(p => p.rawEleM));
        });

        const halfWindowM = ELEVATION_SMOOTH_WINDOW_M / 2;
        return medianElevations.map((ele, index) => {
            const centerDistM = distMByIndex[index];
            const windowValues = [];

            for (let i = index; i >= Math.max(0, index - ELEVATION_SMOOTH_POINT_RADIUS); i--) {
                if (centerDistM - distMByIndex[i] > halfWindowM) break;
                windowValues.push(medianElevations[i]);
            }

            for (let i = index + 1; i < Math.min(medianElevations.length, index + ELEVATION_SMOOTH_POINT_RADIUS + 1); i++) {
                if (distMByIndex[i] - centerDistM > halfWindowM) break;
                windowValues.push(medianElevations[i]);
            }

            if (!windowValues.length) return ele;
            return windowValues.reduce((sum, value) => sum + value, 0) / windowValues.length;
        });
    };

    const computeAdjustedDistances = (points, hasTime) => {
        const distMByIndex = new Array(points.length).fill(0);
        if (points.length < 2) {
            return { distanceM: 0, rawDistanceM: 0, distMByIndex };
        }

        let distanceM = 0;
        let rawDistanceM = 0;
        let anchor = points[0];
        let prev = points[0];
        let pendingSteps = [];
        let pendingIndices = [];

        const resetPending = current => {
            pendingSteps = [];
            pendingIndices = [];
            anchor = current;
        };

        for (let i = 1; i < points.length; i++) {
            const current = points[i];
            const stepM = calcDistMeters(prev.lat, prev.lon, current.lat, current.lon);
            const elapsedSeconds = hasTime ? (current.ms - prev.ms) / 1000 : 0;
            const isBadJump = elapsedSeconds > 0 && stepM > DIST_CONFIRM_M && stepM / elapsedSeconds > MAX_REASONABLE_SPEED_MPS;

            rawDistanceM += stepM;
            // Provisional: every point starts at the last *confirmed* cumulative
            // distance and is back-filled to its real value only once the pending
            // run is confirmed (>= DIST_CONFIRM_M of displacement). Points that
            // are still pending at the end of the track -- or that were dropped as
            // bad GPS jumps -- keep this last-confirmed value, which can slightly
            // under-count distance for a short tail. Acceptable for trail stats.
            distMByIndex[i] = distanceM;

            if (isBadJump) {
                resetPending(current);
                prev = current;
                continue;
            }

            pendingSteps.push(stepM);
            pendingIndices.push(i);

            const pendingDisplacementM = calcDistMeters(anchor.lat, anchor.lon, current.lat, current.lon);
            const isLongPauseNoise = elapsedSeconds >= PAUSE_RESET_SECONDS && pendingDisplacementM < DIST_CONFIRM_M;

            if (isLongPauseNoise) {
                resetPending(current);
            } else if (pendingDisplacementM >= DIST_CONFIRM_M) {
                let runningDistanceM = distanceM;
                pendingIndices.forEach((index, pendingIndex) => {
                    runningDistanceM += pendingSteps[pendingIndex];
                    distMByIndex[index] = runningDistanceM;
                });
                distanceM = runningDistanceM;
                resetPending(current);
            }

            prev = current;
        }

        return { distanceM, rawDistanceM, distMByIndex };
    };

    const calculateGrade = (index, distMByIndex, elevations) => {
        const centerDistM = distMByIndex[index];
        let baselineIndex = index;

        while (baselineIndex > 0 && index - baselineIndex < GRADE_MAX_LOOKBACK_POINTS && centerDistM - distMByIndex[baselineIndex] < GRADE_WINDOW_M) {
            baselineIndex--;
        }

        const distDiffM = centerDistM - distMByIndex[baselineIndex];
        if (distDiffM < GRADE_MIN_DISTANCE_M) return 0;
        return ((elevations[index] - elevations[baselineIndex]) / distDiffM) * 100;
    };

    const computeMetrics = points => {
        const validPoints = points
            .map((point, index) => ({ ...point, index }))
            .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon) && Number.isFinite(point.rawEleM));

        if (!validPoints.length) {
            return {
                hasTime: false,
                distanceM: 0,
                gainM: 0,
                rawDistanceM: 0,
                rawGainM: 0,
                points: [],
                chartPoints: [],
                startMs: 0,
                endMs: 0,
                summitMs: 0,
                maxEleM: -Infinity
            };
        }

        const hasTime = validPoints.every(point => Number.isFinite(point.ms) && point.ms > 0);
        const sortedPoints = validPoints.slice().sort((a, b) => {
            if (hasTime && a.ms !== b.ms) return a.ms - b.ms;
            return a.index - b.index;
        });

        const { distanceM, rawDistanceM, distMByIndex } = computeAdjustedDistances(sortedPoints, hasTime);
        const smoothedElevations = smoothElevations(sortedPoints, distMByIndex);
        const rawGainM = calculatePositiveGainM(sortedPoints.map(point => point.rawEleM));
        const gainM = calculateConfirmedGainM(smoothedElevations);

        let maxEleM = -Infinity;
        let summitMs = 0;
        const adjustedPoints = sortedPoints.map((point, index) => {
            const eleM = smoothedElevations[index];
            if (eleM > maxEleM) {
                maxEleM = eleM;
                summitMs = point.ms || 0;
            }

            return {
                lat: point.lat,
                lon: point.lon,
                ms: point.ms || 0,
                rawEleM: point.rawEleM,
                eleM,
                distM: distMByIndex[index],
                grade: calculateGrade(index, distMByIndex, smoothedElevations)
            };
        });

        return {
            hasTime,
            distanceM,
            gainM,
            rawDistanceM,
            rawGainM,
            points: adjustedPoints,
            chartPoints: adjustedPoints.filter((point, index) => index % 3 === 0 || index === adjustedPoints.length - 1),
            startMs: hasTime ? adjustedPoints[0].ms : 0,
            endMs: hasTime ? adjustedPoints[adjustedPoints.length - 1].ms : 0,
            summitMs,
            maxEleM
        };
    };

    const sampleRouteSegment = (points, targetCount) => {
        if (points.length <= targetCount) return points;
        if (targetCount <= 2) return [points[0], points[points.length - 1]];

        return Array.from({ length: targetCount }, (_, index) => {
            const sourceIndex = Math.round(index * (points.length - 1) / (targetCount - 1));
            return points[sourceIndex];
        });
    };

    const limitMapRouteSegments = segments => {
        const pointCount = segments.reduce((sum, segment) => sum + segment.length, 0);
        if (pointCount <= MAX_MAP_ROUTE_POINTS) return segments;

        // Every segment needs both endpoints or the overlay would either bridge
        // a gap or silently truncate it. Pathological GPX with more than 1,500
        // usable segments keeps Peakbagger's native route instead of drawing an
        // incomplete enhancement.
        if (segments.length * 2 > MAX_MAP_ROUTE_POINTS) return [];

        const extraBudget = MAX_MAP_ROUTE_POINTS - segments.length * 2;
        const totalExtraPoints = pointCount - segments.length * 2;
        const targetCounts = segments.map(segment => {
            const proportional = Math.floor(extraBudget * (segment.length - 2) / totalExtraPoints);
            return Math.min(segment.length, 2 + proportional);
        });

        let remaining = MAX_MAP_ROUTE_POINTS - targetCounts.reduce((sum, count) => sum + count, 0);
        for (let index = 0; remaining > 0; index = (index + 1) % segments.length) {
            if (targetCounts[index] >= segments[index].length) continue;
            targetCounts[index]++;
            remaining--;
        }

        return segments.map((segment, index) => sampleRouteSegment(segment, targetCounts[index]));
    };

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

        return limitMapRouteSegments(segments);
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
        const FALLBACK = { units: 'auto', theme: 'system' };
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
    const resolveMapRouteStyle = settings => {
        const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
        const integer = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
        const width = integer(settings.mapRouteWidth, 1, 12, DEFAULT_MAP_ROUTE_STYLE.width);
        return {
            color: color(settings.mapRouteColor) ? settings.mapRouteColor : DEFAULT_MAP_ROUTE_STYLE.color,
            width,
            casingColor: color(settings.mapRouteCasingColor) ? settings.mapRouteCasingColor : DEFAULT_MAP_ROUTE_STYLE.casingColor,
            casingWidth: Math.max(integer(settings.mapRouteCasingWidth, 3, 20, DEFAULT_MAP_ROUTE_STYLE.casingWidth), width + 2)
        };
    };
    const resolveMapViewportSize = settings => {
        const integer = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
        return {
            width: integer(settings.mapViewportWidth, MAP_VIEWPORT_MIN_WIDTH, MAP_VIEWPORT_MAX_WIDTH, MAP_VIEWPORT_DEFAULT.width),
            height: integer(settings.mapViewportHeight, MAP_VIEWPORT_MIN_HEIGHT, MAP_VIEWPORT_MAX_HEIGHT, MAP_VIEWPORT_DEFAULT.height)
        };
    };
    const resolveTerrainCacheLimitMb = settings => Number.isInteger(settings.terrainCacheLimitMb)
        && settings.terrainCacheLimitMb >= 0 && settings.terrainCacheLimitMb <= 2048
        ? settings.terrainCacheLimitMb
        : TERRAIN_CACHE_DEFAULT_MB;

    const initChart = async () => {
        // 1. Locate GPX link and build UI
        const gpxLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('Download this GPS track'));
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

        const persistMapViewportSize = () => {
            BPB.set({
                mapViewportWidth: mapViewportSize.width,
                mapViewportHeight: mapViewportSize.height
            });
            appliedSettings = { ...BPB.get() };
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
                persistMapViewportSize();
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
        stats.innerText = "Analyzing GPX data...";

        const subStats = document.createElement('div');
        Object.assign(subStats.style, { fontFamily: 'sans-serif', fontSize: '0.9em', color: '#444', marginTop: '4px', fontStyle: 'italic' });

        statsContainer.append(stats, subStats);

        const controlsContainer = document.createElement('div');
        Object.assign(controlsContainer.style, { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' });

        const unitSelect = document.createElement('select');
        Object.assign(unitSelect.style, { padding: '2px 6px', borderRadius: '4px', border: '1px solid #ccc', cursor: 'pointer', outline: 'none' });
        unitSelect.innerHTML = '<option value="imperial">Imperial</option><option value="metric">Metric</option>';

        const terrainButton = document.createElement('button');
        terrainButton.id = 'bpb-terrain-toggle';
        terrainButton.type = 'button';
        terrainButton.disabled = true;
        terrainButton.textContent = '3D terrain';
        terrainButton.title = 'Available after the GPX route loads';
        terrainButton.setAttribute('aria-pressed', 'false');
        Object.assign(terrainButton.style, {
            marginBottom: '7px', padding: '5px 10px', border: '1px solid transparent', borderRadius: '6px',
            background: '#2457a7', color: '#ffffff', fontWeight: '600', cursor: 'pointer'
        });

        const routeStyleControls = document.createElement('div');
        Object.assign(routeStyleControls.style, { display: 'flex', gap: '8px', marginTop: '7px', fontSize: '0.8em' });

        const createColorControl = (id, text) => {
            const label = document.createElement('label');
            Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
            label.htmlFor = id;
            const caption = document.createElement('span');
            caption.innerText = text;
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
        hintText.innerText = "Double-click point to copy coordinates";

        controlsContainer.append(terrainButton, unitSelect, routeStyleControls, hintText);
        headerBox.append(statsContainer, controlsContainer);

        const terrainDisclosure = document.createElement('div');
        terrainDisclosure.id = 'bpb-terrain-disclosure';
        terrainDisclosure.setAttribute('role', 'group');
        terrainDisclosure.setAttribute('aria-label', '3D terrain privacy notice');
        Object.assign(terrainDisclosure.style, {
            display: 'none', margin: '0 0 10px', padding: '9px 10px', border: '1px solid #b8c7d9',
            borderRadius: '6px', background: '#eef4fa', fontFamily: 'sans-serif', fontSize: '0.88em'
        });
        const terrainDisclosureText = document.createElement('span');
        terrainDisclosureText.append('3D terrain requests elevation tiles from Mapterhorn and may re-request your selected map layer from its provider. Those services receive the viewed map area and request metadata. ');
        const terrainPrivacyLink = document.createElement('a');
        terrainPrivacyLink.href = 'https://mapterhorn.com/privacy-policy/';
        terrainPrivacyLink.target = '_blank';
        terrainPrivacyLink.rel = 'noopener noreferrer';
        terrainPrivacyLink.textContent = 'Privacy policy';
        terrainDisclosureText.append(terrainPrivacyLink);

        const terrainDisclosureActions = document.createElement('span');
        Object.assign(terrainDisclosureActions.style, { display: 'inline-flex', gap: '6px', marginLeft: '10px' });
        const terrainLoadButton = document.createElement('button');
        terrainLoadButton.type = 'button';
        terrainLoadButton.textContent = 'Load 3D terrain';
        Object.assign(terrainLoadButton.style, {
            padding: '4px 8px', border: '1px solid transparent', borderRadius: '5px',
            background: '#2457a7', color: '#ffffff', fontWeight: '600', cursor: 'pointer'
        });
        const terrainCancelButton = document.createElement('button');
        terrainCancelButton.type = 'button';
        terrainCancelButton.textContent = 'Cancel';
        Object.assign(terrainCancelButton.style, {
            padding: '4px 8px', border: '1px solid #aab3bd', borderRadius: '5px',
            background: '#ffffff', color: '#222222', cursor: 'pointer'
        });
        terrainDisclosureActions.append(terrainLoadButton, terrainCancelButton);
        terrainDisclosure.append(terrainDisclosureText, terrainDisclosureActions);

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
        container.append(headerBox, terrainDisclosure, terrainMessage, canvasContainer);
        const fullScreenMapLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('Full Screen Map'));
        if (fullScreenMapLink) fullScreenMapLink.before(container);
        else gpxLink.after(container);

        // Panel palette follows the current theme setting; re-applied on render.
        const panelPalette = () => PALETTES[effectiveTheme(BPB.get().theme)];
        const applyPanelTheme = () => {
            const p = panelPalette();
            Object.assign(container.style, { background: p.panelBg, borderColor: p.panelBorder, color: p.text });
            Object.assign(unitSelect.style, { background: p.inputBg, color: p.text, borderColor: p.selBorder });
            Object.assign(terrainCancelButton.style, { background: p.inputBg, color: p.text, borderColor: p.selBorder });
            Object.assign(terrainDisclosure.style, {
                background: effectiveTheme(BPB.get().theme) === 'dark' ? '#202f3a' : '#eef4fa',
                borderColor: effectiveTheme(BPB.get().theme) === 'dark' ? '#3e617a' : '#b8c7d9',
                color: p.text
            });
            terrainPrivacyLink.style.color = effectiveTheme(BPB.get().theme) === 'dark' ? '#9fc7f5' : '#174f91';
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
                        hintText.innerHTML = `<span style="color: #2e8b57; font-weight: bold;">✓ Copied: ${text}</span>`;
                        setTimeout(() => { hintText.innerText = "Double-click point to copy coordinates"; applyPanelTheme(); }, 2500);
                    }).catch(err => console.error('Failed to copy', err));
                }
            }
        });

        // 2. Formatting Helpers
        const fmtTime = ms => ms > 0 ? `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m` : '0m';
        const getRelativeDay = (ms, startMs) => {
            const startDate = new Date(startMs);
            const currDate = new Date(ms);
            const startMidnight = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
            const currMidnight = new Date(currDate.getFullYear(), currDate.getMonth(), currDate.getDate());
            const diffMs = currMidnight - startMidnight;
            return Math.round(diffMs / 86400000) + 1;
        };
        const formatTimeStr = (ms, startMs, isMultiDay) => {
            const timeStr = new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
        let terrainConsentGranted = false;
        let terrainLoadTimer = null;

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
            if (terrainState === 'loading') {
                terrainButton.disabled = true;
                terrainButton.textContent = 'Loading 3D…';
                terrainButton.title = 'Loading terrain';
                terrainButton.setAttribute('aria-pressed', 'false');
            } else if (terrainState === 'active') {
                terrainButton.disabled = false;
                terrainButton.textContent = '2D map';
                terrainButton.title = 'Return to the Peakbagger map';
                terrainButton.setAttribute('aria-pressed', 'true');
            } else {
                terrainButton.disabled = !hasRoute;
                terrainButton.textContent = '3D terrain';
                terrainButton.title = hasRoute ? 'View this route on 3D terrain' : 'Available after the GPX route loads';
                terrainButton.setAttribute('aria-pressed', 'false');
            }
            terrainButton.style.cursor = terrainButton.disabled ? 'default' : 'pointer';
            terrainButton.style.opacity = terrainButton.disabled ? '0.55' : '1';
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
            restoreNativeMap();
            postTerrain('destroy');
            updateTerrainButton();
            showTerrainMessage(message, 'error');
        };

        const terrainFailureMessage = reason => ({
            frame: '3D terrain could not start in this browser. The 2D map is unchanged.',
            unavailable: '3D terrain is unavailable in this browser. The 2D map is unchanged.',
            maplibre: 'Your browser could not render 3D terrain. The 2D map is unchanged.',
            renderer: 'Your browser could not render 3D terrain. The 2D map is unchanged.',
            timeout: '3D terrain took too long to load. The 2D map is unchanged.'
        })[reason] || '3D terrain could not load. The 2D map is unchanged.';

        const startTerrain = () => {
            if (terrainState !== 'idle' || !mapViewport || !mapIframe || !mapRouteSegments.length) return;
            terrainState = 'loading';
            terrainDisclosure.style.display = 'none';
            showTerrainMessage('Loading 3D terrain…');
            updateTerrainButton();
            postTerrain('init', {
                routeSegments: mapRouteSegments,
                routeStyle: resolveMapRouteStyle(BPB.get()),
                theme: effectiveTheme(BPB.get().theme),
                basemap: getTerrainBasemap(),
                cacheLimitMb: resolveTerrainCacheLimitMb(BPB.get())
            });
            terrainLoadTimer = setTimeout(() => {
                if (terrainState === 'loading') failTerrain('3D terrain took too long to load. The 2D map is unchanged.');
            }, TERRAIN_LOAD_TIMEOUT_MS);
        };

        const stopTerrain = () => {
            clearTerrainLoadTimer();
            terrainState = 'idle';
            restoreNativeMap();
            postTerrain('destroy');
            showTerrainMessage('');
            updateTerrainButton();
        };

        terrainButton.addEventListener('click', () => {
            if (terrainState === 'active') {
                stopTerrain();
                return;
            }
            if (terrainState !== 'idle') return;
            if (terrainConsentGranted) {
                startTerrain();
                return;
            }
            showTerrainMessage('');
            terrainDisclosure.style.display = 'block';
            terrainLoadButton.focus();
        });

        terrainLoadButton.addEventListener('click', () => {
            terrainConsentGranted = true;
            startTerrain();
        });

        terrainCancelButton.addEventListener('click', () => {
            terrainDisclosure.style.display = 'none';
            terrainButton.focus();
        });

        window.addEventListener('message', event => {
            if (event.source !== window || event.origin !== location.origin) return;
            const data = event.data;
            if (!data || data.__bpbTerrain !== true || data.dir !== 'toPage') return;

            if (data.type === 'loaded' && terrainState === 'loading') {
                clearTerrainLoadTimer();
                terrainState = 'active';
                mapIframe.style.visibility = 'hidden';
                mapIframe.setAttribute('aria-hidden', 'true');
                showTerrainMessage('');
                updateTerrainButton();
            } else if (data.type === 'error' && terrainState === 'loading') {
                failTerrain(terrainFailureMessage(data.reason));
            }
        });

        updateTerrainButton();

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

        const expandLeafletTileUrl = (layer, iframeWin) => {
            const options = layer && layer.options && typeof layer.options === 'object' ? layer.options : {};
            if (!layer || typeof layer._url !== 'string' || !layer._url || layer.wmsParams
                || options.zoomReverse === true || (Number.isFinite(options.zoomOffset) && options.zoomOffset !== 0)) return null;

            let template = layer._url;
            if (template.includes('{s}')) {
                const subdomains = Array.isArray(options.subdomains)
                    ? options.subdomains
                    : typeof options.subdomains === 'string' ? options.subdomains.split('') : [];
                const subdomain = subdomains.find(value => /^[a-z0-9-]{1,20}$/i.test(String(value)));
                if (!subdomain) return null;
                template = template.replaceAll('{s}', String(subdomain));
            }
            template = template.replaceAll('{r}', iframeWin.L && iframeWin.L.Browser && iframeWin.L.Browser.retina ? '@2x' : '');

            const placeholders = { z: '__BPB_TILE_Z__', x: '__BPB_TILE_X__', y: '__BPB_TILE_Y__' };
            const protectedUrl = template.replace(/\{([zxy])\}/g, (match, token) => placeholders[token]);
            let absolute;
            try { absolute = new URL(protectedUrl, iframeWin.location && iframeWin.location.href || location.href).href; } catch (error) { return null; }
            template = absolute
                .replaceAll(placeholders.z, '{z}')
                .replaceAll(placeholders.x, '{x}')
                .replaceAll(placeholders.y, '{y}');

            const tokens = Array.from(template.matchAll(/\{([^{}]+)\}/g), match => match[1]);
            return ['z', 'x', 'y'].every(token => tokens.includes(token))
                && tokens.every(token => ['z', 'x', 'y'].includes(token))
                ? template
                : null;
        };

        const getTerrainBasemap = () => {
            try {
                const iframe = findMapIframe();
                const iframeWin = iframe && iframe.contentWindow;
                const map = iframeWin && iframeWin.mapsPlaceholder;
                const select = iframeWin && iframeWin.document && iframeWin.document.getElementById('selmap');
                const option = select && select.options && select.options[select.selectedIndex];
                if (!map || !option) return null;

                const selectedLayer = typeof select.value === 'string' ? iframeWin[select.value] : null;
                const activeLayers = Object.values(map._layers || {})
                    .sort((left, right) => (Number(left && left.options && left.options.zIndex) || 0)
                        - (Number(right && right.options && right.options.zIndex) || 0));
                const candidates = [selectedLayer, ...activeLayers]
                    .filter(layer => layer && typeof layer._url === 'string'
                        && (typeof map.hasLayer !== 'function' || map.hasLayer(layer)))
                    .filter((layer, index, layers) => layers.indexOf(layer) === index);

                for (const layer of candidates) {
                    const tiles = expandLeafletTileUrl(layer, iframeWin);
                    if (!tiles) continue;
                    const options = layer.options || {};
                    const minzoom = Number.isInteger(options.minZoom) ? Math.min(22, Math.max(0, options.minZoom)) : 0;
                    const maxzoom = Number.isInteger(options.maxZoom) ? Math.min(24, Math.max(minzoom, options.maxZoom)) : 19;
                    return {
                        name: String(option.textContent || '').trim().slice(0, 80),
                        tiles: [tiles],
                        tileSize: Number(options.tileSize) === 512 ? 512 : 256,
                        minzoom,
                        maxzoom,
                        scheme: options.tms === true ? 'tms' : 'xyz',
                        attribution: typeof options.attribution === 'string' ? options.attribution.slice(0, 600) : ''
                    };
                }
            } catch (error) { /* Peakbagger may replace or restrict its map frame. */ }
            return null;
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
            let txt = `Interactive Stats: ${formatDistanceM(metrics.distanceM)} | ${formatElevationM(metrics.gainM)} gain`;
            const subParts = [`<div style="color: ${p.muted}; font-size: 0.95em; margin-bottom: 2px;">${buildMetricNote()}</div>`];
            if (hasTime) {
                txt += ` | Time: ${fmtTime(totalMs)}`;
                if (summitMs > startMs) {
                    const timeToSummit = summitMs - startMs;
                    const timeBack = endMs - summitMs;
                    let campingHtml = "";
                    if (campingSpots.length > 0) {
                        const spotStrs = campingSpots.map(s => `Day ${s.day} (${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})`).join(' | ');
                        campingHtml = `<div style="color: ${p.faint}; font-size: 0.95em; margin-top: 2px;">Possible Camping: ${spotStrs}</div>`;
                    }
                    subParts.push(`
                        <div style="color: ${p.sub}; margin-bottom: 2px;">Start time: ${formatTimeStr(startMs, startMs, isMultiDay)} | Summit time: ${formatTimeStr(summitMs, startMs, isMultiDay)} | Back to car: ${formatTimeStr(endMs, startMs, isMultiDay)}</div>
                        <div style="color: ${p.faint}; font-size: 0.95em;">Time to summit: ${fmtTime(timeToSummit)} | Time back: ${fmtTime(timeBack)}</div>
                        ${campingHtml}
                    `);
                }
            }
            stats.innerHTML = `<span style="color:${p.text};">${txt}</span>`;
            subStats.innerHTML = subParts.join('');

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

                        if (activeElements.length > 0) {
                            const datasetIndex = activeElements[0].datasetIndex;
                            const idx = activeElements[0].index;
                            const dataArray = datasetIndex === 0 ? eleDistData : eleTimeData;
                            const candidate = dataArray[idx] ? dataArray[idx]._raw : null;
                            fillColor = datasetIndex === 0 ? '#FF0000' : '#0055FF';
                            if (candidate && Number.isFinite(candidate.lat) && Number.isFinite(candidate.lon)) hoveredPoint = candidate;
                        }

                        if (terrainState === 'active') {
                            postTerrain('highlight', {
                                coordinates: hoveredPoint ? [hoveredPoint.lon, hoveredPoint.lat] : null
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
            const xml = new DOMParser().parseFromString(await (await fetch(gpxLink.href)).text(), "text/xml");
            const trkpts = Array.from(xml.querySelectorAll('trkpt'));
            if (!trkpts.length) return stats.innerText = "No track points found.";

            mapRouteSegments = parseMapRouteSegments(xml);
            updateTerrainButton();

            const parsedPoints = trkpts.map(pt => {
                const eleNode = pt.querySelector('ele');
                const timeNode = pt.querySelector('time');
                const parsedMs = timeNode ? new Date(timeNode.textContent).getTime() : 0;
                const rawEleM = eleNode ? parseFloat(eleNode.textContent) : 0;

                return {
                    lat: parseFloat(pt.getAttribute('lat')),
                    lon: parseFloat(pt.getAttribute('lon')),
                    rawEleM: Number.isFinite(rawEleM) ? rawEleM : 0,
                    ms: Number.isFinite(parsedMs) ? parsedMs : 0
                };
            });

            metrics = computeMetrics(parsedPoints);
            if (!metrics.points.length) return stats.innerText = "No valid track points found.";

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
            stats.innerText = "Error parsing GPX file.";
            console.error(e);
        }
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initChart);
    } else {
        initChart();
    }
})();
