// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GPX Analyzer content script.
// Runs in the page's MAIN world (see manifest.json) so it can read the raw GPX
// link and reach into Peakbagger's same-origin MasterMap iframe for the hover
// marker. Chart.js is bundled at vendor/chart.umd.min.js and loaded immediately
// before this file, so the global `Chart` is available here.
//
// The MAIN world cannot read chrome.storage, so units + theme come from the
// isolated-world bridge (src/bridge.js) over window.postMessage. The panel and
// chart re-theme / re-unit live when settings change.

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
        const FALLBACK = { units: 'auto', theme: 'system', defaultMinTrWords: 1 };
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

    const initChart = async () => {
        // 1. Locate GPX link and build UI
        const gpxLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('Download this GPS track'));
        if (!gpxLink) return;

        await BPB.init();

        const container = document.createElement('div');
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

        const hintText = document.createElement('div');
        Object.assign(hintText.style, { fontSize: '0.8em', color: '#888', marginTop: '4px', fontStyle: 'italic' });
        hintText.innerText = "Double-click point to copy coordinates";

        controlsContainer.append(unitSelect, hintText);
        headerBox.append(statsContainer, controlsContainer);

        const canvasContainer = document.createElement('div');
        Object.assign(canvasContainer.style, { position: 'relative', height: '300px', width: '100%' });

        const canvas = document.createElement('canvas');
        canvasContainer.append(canvas);
        container.append(headerBox, canvasContainer);
        gpxLink.after(container);

        // Panel palette follows the current theme setting; re-applied on render.
        const panelPalette = () => PALETTES[effectiveTheme(BPB.get().theme)];
        const applyPanelTheme = () => {
            const p = panelPalette();
            Object.assign(container.style, { background: p.panelBg, borderColor: p.panelBorder, color: p.text });
            Object.assign(unitSelect.style, { background: p.inputBg, color: p.text, borderColor: p.selBorder });
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

        // Processing Arrays & Core Metrics
        let chartInstance = null;
        let chartData = [];
        let metrics = { distanceM: 0, gainM: 0, rawDistanceM: 0, rawGainM: 0 };
        let totalMs = 0, hasTime = false;
        let startMs = 0, endMs = 0, summitMs = 0;
        let campingSpots = [];
        let hoverMarker = null;

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

            const datasets = [{
                label: `Elevation by Distance`,
                data: eleDistData,
                borderColor: '#fc4c02',
                backgroundColor: 'rgba(252, 76, 2, 0.15)',
                borderWidth: 2, fill: true, tension: 0.2, yAxisID: 'y', xAxisID: 'x', pointRadius: 0, pointHoverRadius: 5, hitRadius: 40
            }];

            if (hasTime) {
                datasets.push({
                    label: `Elevation by Time`,
                    data: eleTimeData,
                    borderColor: '#6ab0de',
                    backgroundColor: 'rgba(0, 127, 182, 0.15)',
                    borderWidth: 2, fill: true, tension: 0.2, yAxisID: 'y', xAxisID: 'xTime', pointRadius: 0, pointHoverRadius: 5, hitRadius: 40
                });
            }

            const maxDist = parseFloat((metrics.distanceM * dMult).toFixed(2));

            chartInstance = new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: { datasets },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'nearest', intersect: true, axis: 'xy' },
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

                        if (activeElements.length > 0 && iframeWin && iframeWin.mapsPlaceholder && iframeWin.L) {
                            const datasetIndex = activeElements[0].datasetIndex;
                            const idx = activeElements[0].index;
                            const dataArray = datasetIndex === 0 ? eleDistData : eleTimeData;
                            const d = dataArray[idx] ? dataArray[idx]._raw : null;
                            const isRed = datasetIndex === 0;
                            const fillColor = isRed ? '#FF0000' : '#0055FF';

                            if (d && d.lat !== undefined && d.lon !== undefined) {
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
                                    hoverMarker = L.circleMarker([d.lat, d.lon], {
                                        radius: 9,
                                        color: '#FFFFFF',
                                        fillColor: fillColor,
                                        fillOpacity: 1,
                                        opacity: 1,
                                        weight: 2
                                    }).addTo(map);
                                } else {
                                    hoverMarker.setLatLng([d.lat, d.lon]);
                                    hoverMarker.setStyle({ color: '#FFFFFF', fillColor: fillColor, opacity: 1, fillOpacity: 1 });
                                }
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
            renderData();
        });

        // Live updates: re-unit / re-theme when settings change elsewhere.
        BPB.subscribe(() => {
            unitSelect.value = resolveUnits(BPB.get());
            if (chartInstance) renderData(); else applyPanelTheme();
        });

        // 5. Native DOM XML Extraction Engine
        try {
            const xml = new DOMParser().parseFromString(await (await fetch(gpxLink.href)).text(), "text/xml");
            const trkpts = Array.from(xml.querySelectorAll('trkpt'));
            if (!trkpts.length) return stats.innerText = "No track points found.";

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
