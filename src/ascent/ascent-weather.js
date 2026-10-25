// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { createStableText } from '../ui/stable-text.js';
import { createWeatherIcon } from '../weather/weather-icon.js';
import { units } from '../ui/units.js';
import { settings } from '../settings/settings.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { createCardReadGate } from '../ui/card-read-gate.js';
import { createCardDrag } from '../ui/card-drag.js';
import { createRetryCooldown } from '../ui/retry-cooldown.js';
import { requestDeadline } from '../net/request-deadline.js';
import { fetchPeakbaggerDocument } from '../peakbagger/peakbagger-request.js';
import { mountainTime } from '../time/mountain-time.js';
import { peakbaggerError } from '../peakbagger/peakbagger-error.js';
import { peakbaggerCloudflare } from '../peakbagger/peakbagger-cloudflare.js';
import { readWeatherSubject, readWeatherSummit } from './ascent-weather-subject.js';
import { ascentPage } from './ascent-page.js';
import { weatherDayWindow, summarizeWeatherDay, hourlyWeatherCondition } from '../weather/weather-day.js';
import { ARCHIVE_BEST_MATCH, WEATHER_MODELS, eligibleWeatherModels } from '../weather/weather-models.js';
import { createWeatherClient } from '../weather/open-meteo-client.js';
import { createWeatherHourlyTable, hourlyWeatherSeries } from '../weather/weather-hourly-table.js';
import { weatherChartRange, weatherChartTicks } from '../weather/weather-chart-scale.js';
import { GPX_TIME_CURSOR_REQUEST, readGpxTimeCursor } from '../gpx/gpx-time-cursor.js';

const ID = 'bpb-ascent-weather', SVG_NS = 'http://www.w3.org/2000/svg';
const POSITION_KEY = 'bpbAscentWeatherColumn';
const SLOT_KEY = 'bpbAscentWeatherSlot';
const MODEL_KEY = 'bpbAscentWeatherModel';
const element = dom.element;
const numeric = value => Number.isFinite(value);
const clean = text => (text || '').replace(/\s+/g, ' ').trim();
const displayDate = date => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export function mountAscentWeather() {
    if (document.getElementById(ID) || peakbaggerCloudflare.isChallengeDocument(document)) return;
    const subject = readWeatherSubject(document, location.href);
    const card = element('section', { id: ID, hidden: '', 'data-bpb-card': 'weather', 'aria-labelledby': `${ID}-heading`, 'aria-busy': 'false' });
    const heading = element('h2', { id: `${ID}-heading`, text: 'Weather archive' });
    const moveHandle = element('button', { type: 'button', class: 'bpb-card-drag-handle', hidden: '',
        'aria-label': 'Move weather below trip report', 'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowLeft ArrowRight Home End' }, [
        element('span', { class: 'bpb-card-drag-dots', 'aria-hidden': 'true' }),
    ]);
    const moveStatus = element('span', { class: 'bpb-card-drag-status', role: 'status', 'aria-live': 'polite' });
    const date = element('span', { class: 'bpb-weather-date', text: subject.date ? displayDate(subject.date) : 'Ascent date unavailable' });
    const previousDay = element('button', { type: 'button', class: 'bpb-weather-day-button', 'aria-label': 'Previous day', text: '‹', hidden: '', 'aria-disabled': 'true' });
    const nextDay = element('button', { type: 'button', class: 'bpb-weather-day-button', 'aria-label': 'Next day', text: '›', hidden: '', 'aria-disabled': 'true' });
    const dateNavigation = element('div', { class: 'bpb-weather-date-navigation', role: 'group', 'aria-label': 'Archive day' }, [previousDay, date, nextDay]);
    const locationLabel = element('div', { class: 'bpb-weather-location', text: subject.peak ? `${subject.peak.name} · At the summit` : 'At the summit' });
    const status = element('div', { class: 'bpb-weather-status', role: 'status', 'aria-live': 'polite' });
    const retry = element('button', { type: 'button', class: 'bpb-weather-retry', text: 'Retry', hidden: '' });
    const condition = element('h3');
    const conditionIcon = element('span', { class: 'bpb-weather-icon', 'aria-hidden': 'true' });
    const conditionDetail = element('div', { class: 'bpb-weather-sub' });
    const metrics = element('dl', { class: 'bpb-weather-metrics' });
    const readings = {};
    for (const [key, label] of [['temperature', 'Temperature'], ['precipitation', 'Precipitation'], ['wind', 'Wind'], ['gust', 'Gusts']]) {
        const value = element('dd', { text: '—', 'data-weather-value': key });
        const detail = element('span', { class: 'bpb-weather-sub', text: key === 'temperature' ? 'Daily low / high' : key === 'precipitation' ? 'Water equivalent' : 'Daily maximum' });
        readings[key] = { value, detail };
        metrics.append(element('div', {}, [element('dt', { text: label }), value, detail]));
    }
    const select = element('select', { id: `${ID}-model`, 'aria-label': 'Weather model' }, [element('option', { value: ARCHIVE_BEST_MATCH.id, text: 'Best Match (Open-Meteo)' })]);
    const modelName = element('span', { hidden: '' }), modelType = element('span', { class: 'bpb-weather-sub' });
    const modelRow = element('div', { class: 'bpb-weather-model' }, [
        element('div', {}, [element('label', { for: select.id, text: 'Weather model' }), select]),
        element('div', { class: 'bpb-weather-model-description', role: 'status', 'aria-live': 'polite' }, [modelName, modelType]),
    ]);
    const disclosureLabel = element('span', { text: 'Show hourly weather' });
    const disclosure = element('button', { type: 'button', class: 'bpb-weather-disclosure', 'aria-expanded': 'false', 'aria-controls': `${ID}-hourly` }, [
        disclosureLabel, element('span', { class: 'bpb-weather-disclosure-chevron', 'aria-hidden': 'true', text: '▾' }),
    ]);
    const tabs = element('div', { class: 'bpb-weather-tabs', role: 'tablist', 'aria-label': 'Hourly weather views' });
    for (const [key, text] of [['conditions', 'Conditions'], ['temperature', 'Temperature'], ['precipitation', 'Rain/snow'], ['wind', 'Wind']]) {
        tabs.append(element('button', { type: 'button', role: 'tab', tabindex: key === 'conditions' ? '0' : '-1', id: `${ID}-tab-${key}`, 'aria-controls': `${ID}-plot`, 'aria-selected': String(key === 'conditions'), 'data-metric': key, text }));
    }
    const zoneText = element('span', { class: 'bpb-weather-sub' });
    const chart = document.createElementNS(SVG_NS, 'svg');
    chart.setAttribute('class', 'bpb-weather-chart'); chart.setAttribute('role', 'img');
    const readout = element('div', { id: `${ID}-readout`, class: 'bpb-weather-readout', 'aria-live': 'off', 'aria-atomic': 'true' });
    const readingText = createStableText(readout);
    const readingHint = element('p', { id: `${ID}-reading-hint`, class: 'bpb-weather-sub', text: 'Hover, tap or use ← → for readings. Escape clears selection.' });
    const chartFrame = element('div', { class: 'bpb-weather-chart-frame', tabindex: '0', role: 'group',
        'aria-describedby': `${readout.id} ${readingHint.id}` }, [chart]);
    const cursorLabel = element('div', { class: 'bpb-weather-cursor-label' });
    const cursor = document.createElementNS(SVG_NS, 'line');
    cursor.setAttribute('class', 'bpb-weather-cursor'); cursor.setAttribute('aria-hidden', 'true');
    const conditions = element('div', { class: 'bpb-weather-conditions bpb-weather-hourly-scroll', role: 'region', 'aria-label': 'Hourly weather in summit local time. Scroll horizontally for all hours.', tabindex: '0', hidden: '' });
    const conditionsEmpty = element('div', { class: 'bpb-weather-sub', hidden: '' });
    const conditionsNote = element('p', { class: 'bpb-weather-sub', hidden: '' });
    const plot = element('div', { id: `${ID}-plot`, role: 'tabpanel', 'aria-labelledby': `${ID}-tab-conditions` }, [cursorLabel, readout, chartFrame, readingHint, conditionsEmpty, conditions, conditionsNote]);
    const hourly = element('div', { id: `${ID}-hourly`, hidden: '' }, [element('div', { class: 'bpb-weather-hourly-controls' }, [tabs, zoneText]), plot]);
    const sourceText = element('div', { class: 'bpb-weather-source-text' });
    const sources = element('details', { class: 'bpb-weather-sources' }, [element('summary', { text: 'Source details' }), sourceText]);
    const resultArea = element('div', { class: 'bpb-weather-result', hidden: '' }, [
        element('div', { class: 'bpb-weather-condition' }, [conditionIcon, element('div', {}, [condition, conditionDetail])]), metrics,
    ]);
    const detailsArea = element('div', { hidden: '' }, [element('div', { class: 'bpb-weather-hourly' }, [disclosure, hourly]), sources]);
    modelRow.hidden = true;
    const attribution = element('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo' });
    const header = element('header', {}, [heading, dateNavigation, moveHandle]);
    card.append(header, moveStatus, locationLabel, element('div', { class: 'bpb-weather-feedback' }, [retry, status]), resultArea, modelRow, detailsArea,
        element('footer', {}, [element('span', { text: 'Model estimate · Route conditions may differ' }),
            element('span', { class: 'bpb-weather-attribution' }, [document.createTextNode('Powered by '), attribution])]));

    // Keep weather with the right-hand summary, independently of report height
    // or a later GPX explorer. Unrecognized layouts retain the map fallback.
    const nativeMap = [...document.querySelectorAll('iframe[src]')].find(frame => {
        try { return /\/MasterMap\.aspx$/i.test(new URL(frame.getAttribute('src'), location.href).pathname); } catch { return false; }
    });
    const mountParent = document.querySelector('#page') || subject.table?.parentElement || nativeMap?.parentElement || document.body;
    let preference = settings.DEFAULTS, settingsReady = false;
    const enabled = () => settingsReady && preference.showWeather;
    let column = 'summary', slot = 'after', positionRevision = 0, positionWrites = Promise.resolve(), cardDrag = null;
    let gpsDetails = null;
    const gpsOrigins = [];
    const restoreGpsDetails = () => {
        for (const { node, marker, parent } of gpsOrigins.splice(0)) {
            if (marker.parentNode) marker.before(node);
            else (parent.isConnected ? parent : mountParent).append(node);
            marker.remove();
        }
        gpsDetails?.remove(); gpsDetails = null;
    };
    const placeGpsDetails = () => {
        if (!enabled()) return;
        if (!gpsDetails) {
            const trackLink = ascentPage.gpxLink(document);
            const safe = node => node && node !== mountParent && !node.contains(card)
                && !subject.table?.contains(node)
                && !node.closest('.bpb-ascent-table-split__report')
                && !node.querySelector('iframe, table, #bpb-map-viewport, #bpb-route-explorer, #bpb-gpx-analysis, input, select, textarea')
                && [...node.querySelectorAll('a')].every(link => link === trackLink);
            const download = trackLink?.closest('p, #gpxlinks') || trackLink?.parentElement;
            if (!safe(download)) return;
            // Move dedicated native footer blocks, never the map/table that
            // contains them. Reparenting preserves provider button handlers.
            const notes = [...document.querySelectorAll('p, span, font, small, div')].filter(node =>
                /^Note:\s*GPS Tracks may not be accurate\b/i.test(clean(node.textContent)) && safe(node)
                && (node.contains(trackLink) || (node.compareDocumentPosition(trackLink) & Node.DOCUMENT_POSITION_FOLLOWING)));
            const blocks = notes.filter(node => !notes.some(other => other !== node && other.contains(node)));
            gpsDetails = element('div', { id: 'bpb-ascent-gpx-details' });
            const move = node => {
                const marker = document.createComment('bpb-weather-gps-position');
                const parent = node.parentNode;
                node.before(marker); gpsOrigins.push({ node, marker, parent }); gpsDetails.append(node);
            };
            const note = blocks.length === 1 ? blocks[0] : null;
            if (note?.contains(download)) move(note);
            else {
                if (note && !download.contains(note)) move(note);
                move(download);
            }
        }
        const summary = document.querySelector('#bpb-ascent-summary-column > .bpb-ascent-table-split__summary');
        if (summary) {
            if (gpsDetails.parentElement !== summary.parentElement) summary.after(gpsDetails);
        } else if (card.previousElementSibling !== gpsDetails) card.before(gpsDetails);
    };
    const place = () => {
        const summary = document.querySelector('#bpb-ascent-summary-column > .bpb-ascent-table-split__summary');
        if (summary) {
            placeGpsDetails();
            const report = document.querySelector('#bpb-ascent-report-column > .bpb-ascent-table-split__report');
            const base = column === 'report' && report ? report : summary;
            if (slot === 'before') {
                if (base.previousElementSibling !== card) base.before(card);
            } else {
                const anchor = slot === 'gps' || base === report ? base
                    : gpsDetails?.parentElement === summary.parentElement ? gpsDetails : summary;
                if (anchor.nextElementSibling !== card) anchor.after(card);
            }
            cardDrag?.refresh();
            return;
        }
        let anchor = document.getElementById('bpb-route-explorer');
        if (!anchor && nativeMap?.isConnected) {
            anchor = document.getElementById('bpb-map-viewport') || nativeMap;
            const fullMap = [...anchor.parentElement.querySelectorAll('a')].find(link => /Full Screen Map/i.test(link.textContent) && link.parentElement === anchor.parentElement);
            if (fullMap) anchor = fullMap;
        }
        if (!anchor) anchor = document.getElementById('bpb-ascent-table-split')
            || [...mountParent.children].filter(node => node.matches('table')).at(-1) || subject.table;
        if (anchor && !card.contains(anchor)) {
            if (anchor.nextElementSibling !== card
                && !(anchor.nextElementSibling === gpsDetails && gpsDetails?.nextElementSibling === card)) anchor.after(card);
        } else if (!card.isConnected) mountParent.append(card);
        placeGpsDetails();
        cardDrag?.refresh();
    };
    place();
    const placementObserver = new MutationObserver(place);
    placementObserver.observe(mountParent, { childList: true, subtree: true });

    let summit = null, dayWindow = null, candidates = [], current = null;
    let retryDate = subject.date, refreshLabel = '';
    let metric = 'conditions', generation = 0, controller = null, started = false;
    const client = createWeatherClient();
    let lifecycle;
    const readGate = createCardReadGate({ card, enabled: () => enabled() && !subject.reason && subject.date >= '1940-01-01',
        active: () => lifecycle?.state === 'active', onChange: eligible => {
            if (!eligible) { cancel(); cooldown.suspend(); }
            else { cooldown.resume(); if (!current && !controller) beginWhenVisible(); }
        } });
    let rememberedModel = ARCHIVE_BEST_MATCH.id, modelRevision = 0, modelSaveError = '';
    let modelWrites = Promise.resolve();
    const modelReadDeadline = requestDeadline.createRequestDeadline(2000);
    const modelReady = (async () => {
        const revision = modelRevision;
        try {
            const saved = (await modelReadDeadline.run(settings.preferences(MODEL_KEY)))?.[MODEL_KEY];
            if (modelRevision === revision && lifecycle?.state !== 'disposed'
                && WEATHER_MODELS.some(model => model.id === saved)) rememberedModel = saved;
        } catch { /* Missing, invalid or unavailable storage keeps Best Match usable. */ }
        finally { modelReadDeadline.clear(); }
    })();
    const cooldown = createRetryCooldown(blocked => { retry.disabled = blocked || card.getAttribute('aria-busy') === 'true'; updateNavigation(); });
    function adjacentDay(direction) {
        if (!dayWindow) return null;
        // Step by civil dates, not 24-hour instants. Skip a nonexistent civil
        // day (such as Samoa's date-line change) without crossing model bounds.
        for (let step = 1; step <= 2; step++) {
            const target = new Date(Date.parse(`${dayWindow.date}T00:00:00Z`) + direction * step * 86400_000).toISOString().slice(0, 10);
            if (target < '1940-01-01' || !eligibleWeatherModels(summit, target).some(model => model.id === select.value)) return null;
            try { return weatherDayWindow(target, dayWindow.zone); } catch { /* Try the following civil date. */ }
        }
        return null;
    }
    function updateNavigation() {
        for (const [button, direction] of [[previousDay, -1], [nextDay, 1]]) {
            const target = adjacentDay(direction);
            button.hidden = !dayWindow;
            // Keep focus on the control while its request is pending or its
            // archive boundary is reached. The click handler enforces this gate.
            button.setAttribute('aria-disabled', String(!target || card.getAttribute('aria-busy') === 'true' || cooldown.active()));
            button.title = target ? `${direction < 0 ? 'Previous' : 'Next'} day · ${displayDate(target.date)}`
                : `No ${direction < 0 ? 'earlier' : 'later'} archived days for this model`;
        }
    }
    let cursorState = { hovering: false, hoverTime: null, selected: false, selectionTime: null };
    let cursorFrame = null, chartBounds = null, chartDescription = '';
    let conditionColumns = new Map(), activeConditionColumn = null;
    const cancelCursorFrame = () => { if (cursorFrame !== null) cancelAnimationFrame(cursorFrame); cursorFrame = null; };
    function drawCursor() {
        cursor.style.display = 'none';
        if (activeConditionColumn) {
            for (const cell of activeConditionColumn) { cell.removeAttribute('aria-current'); delete cell.dataset.mode; }
            activeConditionColumn = null;
        }
        const mode = cursorState.hovering ? 'hover' : cursorState.selected ? 'selected' : null;
        const time = cursorState.hovering ? cursorState.hoverTime : cursorState.selectionTime;
        let label = '';
        if (mode && dayWindow) {
            if (time === null) label = 'GPX time unavailable';
            else if (time < dayWindow.start || time >= dayWindow.end) label = dayWindow.date === subject.date ? 'Outside ascent day' : 'Outside displayed day';
            else {
                label = `${mode === 'hover' ? 'Hover' : 'Selected'} · ${mountainTime.formatClock(dayWindow.zone, time)} ${mountainTime.zoneLabel(dayWindow.zone, time)}`;
                if (metric === 'conditions' && !hourly.hidden) {
                    activeConditionColumn = conditionColumns.get(Math.max(dayWindow.start, Math.floor(time / 3600_000) * 3600_000)) || null;
                    if (activeConditionColumn) {
                        activeConditionColumn[0].setAttribute('aria-current', 'time');
                        for (const cell of activeConditionColumn) cell.dataset.mode = mode;
                    }
                }
                if (chartBounds && !hourly.hidden) {
                    const { left, right, top, bottom } = chartBounds;
                    const x = left + (right - left) * (time - dayWindow.start) / (dayWindow.end - dayWindow.start);
                    for (const [key, value] of Object.entries({ x1: x, x2: x, y1: top, y2: bottom, 'data-mode': mode, 'data-time': time })) cursor.setAttribute(key, String(value));
                    cursor.style.display = '';
                }
            }
        }
        cursorLabel.textContent = label;
        chart.setAttribute('aria-label', `${chartDescription}${label ? ` ${label}.` : ''}`);
    }
    const receiveCursor = event => {
        const next = readGpxTimeCursor(event);
        if (!next || lifecycle?.state !== 'active') return;
        cursorState = next;
        if (cursorFrame === null) cursorFrame = requestAnimationFrame(() => { cursorFrame = null; drawCursor(); });
    };
    const listenForCursor = () => {
        window.addEventListener('message', receiveCursor);
        window.postMessage({ type: GPX_TIME_CURSOR_REQUEST }, location.origin);
    };
    const stopCursor = () => { window.removeEventListener('message', receiveCursor); cancelCursorFrame(); };
    const unitSystem = (measurement = 'elevation') => units.resolveUnits(preference, () => {
        const elevationText = clean(document.querySelector('.peakinfo')?.textContent || subject.table?.textContent);
        return /\d\s*(?:meters|m)\b/i.test(elevationText) && !/\d\s*(?:feet|ft)\b/i.test(elevationText) ? 'metric' : 'imperial';
    }, measurement);
    const convert = (value, key) => units.convertWeather(value, key, unitSystem(key));
    const unit = key => units.symbol(key, unitSystem(key));
    const format = (value, key) => units.formatWeather(value, key, unitSystem(key));

    let readingRows = [], readingSelected = null, readingHover = null, readingGeometry = null;
    const readingLabel = (row, key = metric) => {
        const local = time => `${mountainTime.formatClock(dayWindow.zone, time)} ${mountainTime.zoneLabel(dayWindow.zone, time)}`;
        const timeLabel = key === 'precipitation' ? `${local(row.start)} – ${local(row.time)}${row.time === dayWindow.end ? ' (next midnight)' : ''}` : local(row.time);
        return `${timeLabel} · ${numeric(row.value) ? format(row.value, key) : 'Unavailable'}${row.partialInterval ? ' · Estimated boundary interval' : ''}`;
    };
    const readingPosition = row => metric === 'precipitation' ? (row.start + row.time) / 2 : row.time;
    function drawReading() {
        chart.querySelector('.bpb-weather-reading-cursor')?.remove();
        const row = readingRows.find(sample => sample.sourceTime === (readingHover ?? readingSelected));
        const values = readingRows.map(sample => sample.value).filter(numeric);
        readingText.set(row ? readingLabel(row) : values.length
            ? `Low ${format(Math.min(...values), metric)} · High ${format(Math.max(...values), metric)}` : 'Hourly readings unavailable');
        if (!row || !readingGeometry) return;
        const { x, y, top, bottom } = readingGeometry;
        const group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('class', 'bpb-weather-reading-cursor'); group.setAttribute('aria-hidden', 'true');
        for (const [tag, attributes] of [['line', { x1: x(readingPosition(row)), x2: x(readingPosition(row)), y1: top, y2: bottom }],
            ...(numeric(row.value) ? [['circle', { cx: x(readingPosition(row)), cy: y(row.value), r: 4 }]] : [])]) {
            const node = document.createElementNS(SVG_NS, tag);
            Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value)); group.append(node);
        }
        chart.append(group);
    }
    const pointerReading = event => {
        if (!readingGeometry || !readingRows.length) return null;
        const bounds = chart.getBoundingClientRect();
        if (!bounds.width) return null;
        const position = (event.clientX - bounds.left) / bounds.width * readingGeometry.width;
        const time = dayWindow.start + (position - readingGeometry.left) / (readingGeometry.right - readingGeometry.left) * (dayWindow.end - dayWindow.start);
        return readingRows.reduce((nearest, row) => Math.abs(readingPosition(row) - time) < Math.abs(readingPosition(nearest) - time) ? row : nearest).sourceTime;
    };
    chartFrame.addEventListener('pointermove', event => { readingHover = pointerReading(event); readout.setAttribute('aria-live', 'off'); drawReading(); });
    chartFrame.addEventListener('pointerleave', () => { readingHover = null; drawReading(); });
    chartFrame.addEventListener('click', event => { readingSelected = pointerReading(event); readingHover = null; drawReading(); });
    chartFrame.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key) || !readingRows.length) return;
        event.preventDefault(); readingHover = null; readout.setAttribute('aria-live', 'polite');
        const index = readingRows.findIndex(row => row.sourceTime === readingSelected);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? readingRows.length - 1
            : index < 0 ? event.key === 'ArrowRight' ? 0 : readingRows.length - 1
                : Math.max(0, Math.min(readingRows.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
        readingSelected = event.key === 'Escape' ? null : readingRows[next].sourceTime;
        drawReading();
    });

    function drawChart() {
        if (!enabled() || !current || hourly.hidden || lifecycle?.state !== 'active') return;
        chartFrame.dataset.weatherMetric = metric;
        const showConditions = metric === 'conditions';
        chartFrame.hidden = readout.hidden = readingHint.hidden = showConditions;
        chart.toggleAttribute('hidden', showConditions); conditions.hidden = conditionsNote.hidden = !showConditions; conditionsEmpty.hidden = true;
        if (showConditions) {
            chartBounds = null;
            chartDescription = 'Hourly weather conditions, summit local time.';
            const scrollLeft = conditions.scrollLeft;
            const { table, columns } = createWeatherHourlyTable({ window: dayWindow, samples: current.data.samples,
                zone: dayWindow.zone, format, gustTiming: current.data.gustTiming,
                keys: ['code', ...[['temperature', 'temperature_2m'], ['precipitation', 'precipitation'], ['wind', 'wind_speed_10m'], ['gust', 'wind_gusts_10m']]
                    .filter(([, field]) => current.model.fields.includes(field)).map(([key]) => key)] });
            conditions.replaceChildren(table); conditionColumns = columns; conditions.scrollLeft = scrollLeft;
            conditionsNote.textContent = ['Summit local time · Scroll for all hours.',
                ...(current.model.fields.includes('precipitation') ? ['Rain/snow is water equivalent for the hour starting at the shown time.'] : []),
                ...(current.model.fields.includes('wind_gusts_10m') ? [current.data.gustTiming === 'instant' ? 'Gusts are instantaneous estimates.' : 'Gusts cover the hour starting at the shown time.'] : [])].join(' ');
            if (!current.day.hourly.some(row => hourlyWeatherCondition(row.code).icon !== 'unknown')) {
                conditionsEmpty.hidden = false;
                conditionsEmpty.textContent = current.model.fields.includes('weather_code') ? 'Hourly conditions unavailable.' : 'This model does not provide hourly conditions.';
            }
            drawCursor(); return;
        }
        const width = chart.getBoundingClientRect().width;
        if (width < 100) return;
        const rows = hourlyWeatherSeries(dayWindow, current.data.samples, metric, current.data.gustTiming);
        readingRows = rows; readingGeometry = null;
        readingText.reserve(['Hourly readings unavailable', ...['temperature', 'precipitation', 'wind'].flatMap(key => {
            const sizingRows = key === 'precipitation' ? current.day.precipitationHours
                : current.day.hourly.map(row => ({ ...row, value: row[key] }));
            const values = sizingRows.map(row => row.value).filter(numeric);
            return [...sizingRows.map(row => readingLabel(row, key)), ...(values.length
                ? [`Low ${format(Math.min(...values), key)} · High ${format(Math.max(...values), key)}`] : [])];
        })]);
        if (!rows.some(row => row.sourceTime === readingSelected)) readingSelected = null;
        readingHover = null;
        const finite = rows.filter(row => numeric(row.value));
        chartBounds = null;
        chart.replaceChildren(); chart.setAttribute('viewBox', `0 0 ${width} 164`);
        const add = (tag, attributes, text) => {
            const node = document.createElementNS(SVG_NS, tag);
            Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
            if (text != null) node.textContent = text;
            chart.append(node); return node;
        };
        const chartLabel = `${metric === 'temperature' ? 'Temperature' : metric === 'precipitation' ? 'Preceding-hour precipitation' : 'Wind'} (${unit(metric)}), summit local time.`;
        chartDescription = chartLabel;
        chartFrame.setAttribute('aria-label', `${chartLabel} Use left and right arrows to explore readings; Escape clears selection.`);
        chart.setAttribute('aria-label', chartLabel);
        add('title', {}, chartLabel);
        if (!finite.length) { add('text', { x: width / 2, y: 70, 'text-anchor': 'middle' }, 'Hourly data unavailable'); drawCursor(); drawReading(); return; }
        const values = finite.map(row => convert(row.value, metric));
        const { low, high } = weatherChartRange(values, metric, { roundTemperatureLow: true });
        const left = 42, right = width - 16, top = 26, bottom = 124;
        const x = time => left + (right - left) * (time - dayWindow.start) / (dayWindow.end - dayWindow.start);
        const y = value => bottom - (convert(value, metric) - low) / (high - low) * (bottom - top);
        readingGeometry = { x, y, left, right, top, bottom, width };
        add('text', { x: left, y: 12 }, unit(metric));
        for (const value of weatherChartTicks({ low, high })) {
            const yy = bottom - (value - low) / (high - low) * (bottom - top);
            add('line', { x1: left, x2: right, y1: yy, y2: yy, class: 'bpb-weather-grid' });
            add('text', { x: left - 7, y: yy + 4, 'text-anchor': 'end' }, value.toFixed(units.weatherDigits(metric, unitSystem(metric))));
        }
        const tickCount = width < 200 ? 2 : width < 400 ? 3 : 5;
        for (let index = 0; index < tickCount; index++) {
            const time = dayWindow.start + (dayWindow.end - dayWindow.start) * index / (tickCount - 1);
            const label = index === tickCount - 1 ? '24:00' : mountainTime.formatClock(dayWindow.zone, time, { locales: 'en-GB' });
            add('text', { x: x(time), y: 150, 'text-anchor': index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle' }, label);
        }
        if (metric === 'precipitation') {
            for (const row of finite) if (row.value > 0) {
                const barWidth = (x(row.time) - x(row.start)) * .65;
                add('rect', { x: x(row.start) + (x(row.time) - x(row.start) - barWidth) / 2, y: y(row.value),
                    width: barWidth, height: bottom - y(row.value), class: 'bpb-weather-bar', 'data-value': row.value });
            }
        } else {
            let path = '', previous = null;
            for (const row of rows) {
                if (!numeric(row.value)) { previous = null; continue; }
                path += `${previous !== null && row.time - previous <= 3600_000 ? 'L' : 'M'}${x(row.time)},${y(row.value)} `;
                previous = row.time;
            }
            add('path', { d: path, class: 'bpb-weather-line' });
        }
        for (const row of finite) {
            const label = readingLabel(row);
            const point = add('circle', { cx: x(metric === 'precipitation' ? (row.start + row.time) / 2 : row.time), cy: y(row.value), r: 8, class: 'bpb-weather-hover' });
            const title = document.createElementNS(SVG_NS, 'title'); title.textContent = label; point.append(title);
        }
        chartBounds = { left, right, top, bottom };
        chart.append(cursor);
        drawCursor();
        drawReading();
    }

    function renderResult() {
        if (!current) return;
        const { day, model, data } = current;
        resultArea.hidden = false; detailsArea.hidden = false;
        condition.textContent = day.condition.label;
        conditionIcon.replaceChildren(createWeatherIcon(day.condition.icon));
        conditionDetail.textContent = day.condition.complete && !dayWindow.partial
            ? dayWindow.date === subject.date ? 'Conditions during the ascent day' : 'Conditions during this day'
            : 'Conditions in available hours';
        readings.temperature.value.replaceChildren(...(numeric(day.temperature.low) ? [
            element('span', { class: 'bpb-weather-low', text: `${convert(day.temperature.low, 'temperature').toFixed(0)}°`.replaceAll('-', '−') }),
            element('span', { class: 'bpb-weather-temperature-divider', text: ' / ' }), element('span', { class: 'bpb-weather-high', text: `${convert(day.temperature.high, 'temperature').toFixed(0)}${unit('temperature')}`.replaceAll('-', '−') }),
        ] : [document.createTextNode('—')]));
        readings.precipitation.value.textContent = format(day.precipitation.total, 'precipitation');
        readings.wind.value.textContent = format(day.wind.high, 'wind'); readings.gust.value.textContent = format(day.gust.high, 'wind');
        for (const key of ['temperature', 'wind', 'gust']) readings[key].detail.textContent = !day[key].complete || dayWindow.partial ? 'Available hours' : key === 'temperature' ? 'Daily low / high' : 'Daily maximum';
        readings.precipitation.detail.textContent = !day.precipitation.complete ? 'Partial total' : 'Water equivalent';
        if (day.precipitation.total === null) readings.precipitation.detail.textContent = 'Unavailable';
        locationLabel.textContent = `${subject.peak.name} · At the summit${summit.elevation === null ? '' : ` · ${units.formatElevation(summit.elevation, unitSystem())}`}`;
        updateModelDescription();
        zoneText.textContent = mountainTime.zoneLabel(dayWindow.zone, dayWindow.start);
        const modelDetails = model === ARCHIVE_BEST_MATCH ? 'Open-Meteo combines ECMWF IFS, ERA5 and ERA5-Land according to available dates and variables. The API does not identify the source of each value.'
            : `Native ${model.intervalHours}-hour data${model.intervalHours > 1 ? ', interpolated to hourly' : ''}.`;
        sourceText.textContent = `${model.label}, ${model.resolution}. ${model.type}. ${modelDetails} Summit timezone: ${dayWindow.zone.timeZone || zoneText.textContent}. Selected grid: ${data.grid.latitude.toFixed(4)}, ${data.grid.longitude.toFixed(4)}. ${summit.elevation === null ? 'Provider terrain elevation' : 'Summit elevation supplied for temperature downscaling'}: ${data.grid.elevation.toFixed(0)} m.${day.precipitation.allocationEstimated ? ' Precipitation at fractional-hour day boundaries is proportionally allocated.' : ''} Model estimates cannot establish the climber’s summit time or route conditions.`;
        drawChart();
    }
    function updateModelDescription() {
        if (!current) return;
        const { model } = current, refreshing = card.hasAttribute('data-refreshing');
        modelName.textContent = refreshing ? refreshLabel : modelSaveError ? 'Not remembered locally' : `Using ${model.label} · ${model.resolution}`;
        modelName.hidden = !refreshing && !modelSaveError && model.id === select.value;
        modelName.title = modelSaveError;
        modelType.textContent = `${model.resolution} · ${model.type}`;
    }
    const busy = value => {
        card.setAttribute('aria-busy', String(value));
        card.toggleAttribute('data-refreshing', value && !!current);
        retry.disabled = value || cooldown.active();
        updateModelDescription();
        updateNavigation();
    };
    const cancel = () => { generation++; controller?.abort(); controller = null; busy(false); };
    const updateModels = (targetDate, restore = false) => {
        const selected = restore ? rememberedModel : select.value;
        candidates = eligibleWeatherModels(summit, targetDate)
            .sort((a, b) => Number(b === ARCHIVE_BEST_MATCH) - Number(a === ARCHIVE_BEST_MATCH));
        select.replaceChildren(...candidates.map(model => element('option', { value: model.id,
            text: model === ARCHIVE_BEST_MATCH ? 'Best Match (Open-Meteo)' : `${model.label} · ${model.resolution}` })));
        // Only startup can fall back for a different ascent's coverage. Do not
        // persist that fallback or silently switch an explicit in-page choice.
        select.value = restore && !candidates.some(model => model.id === selected) ? ARCHIVE_BEST_MATCH.id : selected;
        modelRow.hidden = false;
    };
    const prepare = async signal => {
        if (summit) return;
        const response = await fetchPeakbaggerDocument(subject.peak.url, { kind: 'html', signal, init: { referrerPolicy: 'no-referrer' } });
        if (response.kind !== 'ok') throw peakbaggerError.exception(response.error);
        summit = readWeatherSummit(response.document, subject, response.url);
        const zone = mountainTime.resolve(summit.latitude, summit.longitude);
        dayWindow = weatherDayWindow(subject.date, zone);
        updateModels(subject.date, true);
    };
    async function load(targetDate = dayWindow?.date || subject.date) {
        if (!readGate.eligible()) return;
        readGate.cancelWait();
        cancel(); const ownGeneration = generation; controller = new AbortController(); const signal = controller.signal;
        retryDate = targetDate;
        refreshLabel = current ? targetDate === dayWindow.date ? `Updating… Showing ${current.model.label}`
            : `Loading ${displayDate(targetDate)}… Showing ${displayDate(dayWindow.date)}.` : '';
        busy(true); started = true;
        // Refresh feedback replaces the existing model description. Preserve
        // the result, hourly view and feedback area's footprint until it settles.
        if (!current) {
            delete status.dataset.kind;
            resultArea.hidden = false; condition.textContent = 'Weather conditions'; conditionDetail.textContent = 'Ascent-day model estimate';
            status.textContent = 'Loading ascent-day weather…';
        }
        try {
            await modelReady;
            if (ownGeneration !== generation || signal.aborted) return;
            await prepare(signal);
            if (ownGeneration !== generation) return;
            const requestedWindow = weatherDayWindow(targetDate, mountainTime.resolve(summit.latitude, summit.longitude));
            const model = eligibleWeatherModels(summit, targetDate).find(candidate => candidate.id === select.value);
            if (!model) throw new Error('This model does not cover the selected archive day. Choose another model.');
            let data;
            try { data = await client.request(summit, requestedWindow, model, { signal }); }
            catch (error) {
                if (ownGeneration !== generation) return;
                if (error.code === 'unavailable' && targetDate === dayWindow.date) {
                    const option = [...select.options].find(candidate => candidate.value === model.id);
                    if (option) {
                        option.disabled = true;
                        if (!option.textContent.endsWith(' — unavailable')) option.textContent += ' — unavailable';
                    }
                }
                throw error;
            }
            if (ownGeneration !== generation) return;
            const day = summarizeWeatherDay(data, requestedWindow);
            if (!day.useful) throw new Error('No weather data is available for this model and archive day. Choose another model.');
            if (targetDate !== dayWindow.date) {
                readingSelected = readingHover = null;
                conditions.scrollLeft = 0;
                updateModels(targetDate);
            }
            dayWindow = requestedWindow;
            date.textContent = displayDate(targetDate);
            current = { model, day, data }; renderResult();
            delete status.dataset.kind;
            status.textContent = dayWindow.partial ? 'Partial day · Weather so far' : day.partial ? 'Partial data · Some hours or measurements are unavailable' : '';
            retry.hidden = !day.partial && !dayWindow.partial;
        } catch (error) {
            if (ownGeneration !== generation || signal.aborted) return;
            if (!current) resultArea.hidden = true;
            delete status.dataset.kind;
            if (error.code === 'rate-limit') { status.dataset.kind = 'rate-limit'; cooldown.set(error.retryAt); }
            status.textContent = `${current ? targetDate === dayWindow.date ? `Showing ${current.model.label}. `
                : `Could not load ${displayDate(targetDate)}. Showing ${displayDate(dayWindow.date)}. ` : ''}${error.message}`; retry.hidden = false;
        } finally {
            if (ownGeneration === generation) busy(false);
        }
    }
    select.addEventListener('change', () => {
        if (!enabled() || lifecycle.state !== 'active' || !candidates.some(model => model.id === select.value)) return;
        rememberedModel = select.value; modelSaveError = '';
        const revision = ++modelRevision, choice = rememberedModel;
        // Persist explicit model IDs only, independently of sync and of the
        // other weather surfaces. Serialize rapid selections in intent order.
        modelWrites = modelWrites.catch(() => {}).then(() => settings.set({ [MODEL_KEY]: choice })).catch(() => {
            if (revision === modelRevision && lifecycle.state !== 'disposed') {
                modelSaveError = 'For this visit only · Model choice could not be saved';
                updateModelDescription();
            }
        });
        void load();
    });
    for (const [button, direction] of [[previousDay, -1], [nextDay, 1]]) button.addEventListener('click', () => {
        if (button.getAttribute('aria-disabled') === 'true') return;
        const target = adjacentDay(direction);
        if (target) void load(target.date);
    });
    retry.addEventListener('click', () => {
        client.clear();
        for (const model of candidates) {
            const option = [...select.options].find(candidate => candidate.value === model.id);
            if (option) { option.disabled = false; option.textContent = model === ARCHIVE_BEST_MATCH ? 'Best Match (Open-Meteo)' : `${model.label} · ${model.resolution}`; }
        }
        void load(retryDate);
    });
    disclosure.addEventListener('click', () => {
        hourly.hidden = !hourly.hidden;
        disclosure.setAttribute('aria-expanded', String(!hourly.hidden));
        disclosureLabel.textContent = hourly.hidden ? 'Show hourly weather' : 'Hide hourly weather';
        drawChart();
    });
    tabs.querySelectorAll('button').forEach(button => {
        button.addEventListener('click', () => {
            metric = button.dataset.metric;
            readingSelected = readingHover = null;
            tabs.querySelectorAll('button').forEach(tab => { tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; });
            plot.setAttribute('aria-labelledby', button.id); drawChart();
            // An explicit tab switch may reveal the selected hour inside this
            // scroll region. GPX hover never scrolls the page or this table.
            if (metric === 'conditions' && activeConditionColumn) {
                const cell = activeConditionColumn[0];
                conditions.scrollLeft = Math.max(0, cell.offsetLeft - (conditions.clientWidth + 94 - cell.clientWidth) / 2);
            }
        });
        button.addEventListener('keydown', event => {
            if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const buttons = [...tabs.querySelectorAll('button')], index = buttons.indexOf(button);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next].focus({ preventScroll: true }); buttons[next].click();
        });
    });
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(drawChart) : null;
    resizeObserver?.observe(chart);
    const beginWhenVisible = () => {
        readGate.waitForViewport(() => { void load(); });
    };
    const applyPreference = next => {
        const wasEnabled = enabled();
        preference = next; settingsReady = true;
        card.hidden = !enabled();
        if (!enabled()) {
            cardDrag?.cancel(); cardDrag?.refresh();
            restoreGpsDetails();
            cooldown.suspend(); stopCursor(); cancel();
            readGate.cancelWait();
        } else if (lifecycle.state === 'active') {
            place();
            cooldown.resume(); renderResult();
            if (!wasEnabled) { listenForCursor(); beginWhenVisible(); }
        }
        readGate.refresh();
    };
    const unsubscribe = settings.subscribe(applyPreference);
    lifecycle = createPageLifecycle({
        onSuspend: () => { cardDrag?.cancel(); cooldown.suspend(); stopCursor(); cursorState = { ...cursorState, hovering: false, hoverTime: null }; cancel(); placementObserver.disconnect(); readGate.refresh(); },
        onResume: () => { place(); placementObserver.observe(mountParent, { childList: true, subtree: true }); readGate.refresh(); if (enabled()) { cooldown.resume(); listenForCursor(); drawChart(); if (!current || started) beginWhenVisible(); } },
        onDispose: () => { readGate.dispose(); modelReadDeadline.clear(); cardDrag?.dispose(); cooldown.dispose(); stopCursor(); cancel(); placementObserver.disconnect(); restoreGpsDetails(); resizeObserver?.disconnect(); unsubscribe(); client.clear(); },
    });
    cardDrag = createCardDrag({ card, handle: moveHandle, surface: header, status: moveStatus, name: 'Weather',
        enabled: () => enabled() && lifecycle.state === 'active', getPosition: () => `${column}:${slot === 'gps' && (column === 'report' || !gpsDetails) ? 'after' : slot}`,
        getTargets: () => {
            const split = document.getElementById('bpb-ascent-table-split');
            const report = document.getElementById('bpb-ascent-report-column'), summary = document.getElementById('bpb-ascent-summary-column');
            if (!split || report?.parentElement !== split || summary?.parentElement !== split) return [];
            return [['report', report, 'trip report'], ['summary', summary, 'summary']].flatMap(([id, targetColumn, label]) => {
                const base = targetColumn.querySelector('.bpb-ascent-table-split__table');
                if (!base) return [];
                const gps = id === 'summary' && gpsDetails?.parentElement === targetColumn ? gpsDetails : null;
                const entries = [{ slot: 'before', label: `above ${label}`, node: base, before: true },
                    ...(gps ? [{ slot: 'gps', label: 'above GPS links', node: gps, before: true }] : []),
                    { slot: 'after', label: `below ${gps ? 'GPS links' : label}`, node: gps || base, before: false }];
                const middle = node => { const rect = node.getBoundingClientRect(); return rect.top + rect.height / 2; };
                return entries.map((entry, index) => ({ id: `${id}:${entry.slot}`, column: id, element: targetColumn, label: entry.label,
                    bounds: () => {
                        const rect = targetColumn.getBoundingClientRect(), area = getComputedStyle(split).display === 'grid' ? split.getBoundingClientRect() : rect;
                        return { left: rect.left, right: rect.right, width: rect.width,
                            top: index === 0 ? area.top : middle(entries[index - 1].node),
                            bottom: index === entries.length - 1 ? area.bottom : middle(entry.node) };
                    },
                    previewBounds: () => {
                        const rect = entry.node.getBoundingClientRect(), columnRect = targetColumn.getBoundingClientRect();
                        const top = Math.max(8, Math.min(window.innerHeight - 12, entry.before ? rect.top : rect.bottom));
                        return { left: columnRect.left, width: columnRect.width, top, bottom: top + 3 };
                    },
                }));
            });
        },
        onMove: next => {
            const [nextColumn, nextSlot] = next.split(':');
            if (!['report', 'summary'].includes(nextColumn) || !['before', 'gps', 'after'].includes(nextSlot)) return false;
            moveStatus.classList.remove('bpb-card-drag-status-visible');
            column = nextColumn; slot = nextSlot; const revision = ++positionRevision;
            place(); drawChart();
            positionWrites = positionWrites.catch(() => {}).then(() => settings.set({ [POSITION_KEY]: nextColumn, [SLOT_KEY]: nextSlot })).catch(() => {
                if (revision === positionRevision && lifecycle.state !== 'disposed') {
                    moveStatus.textContent = 'Weather moved for this visit. Position could not be saved.';
                    moveStatus.classList.add('bpb-card-drag-status-visible');
                }
            });
            return true;
        },
    });
    // A delayed read cannot undo a gesture or completed move. Only the portable
    // column identifier is stored; ascent data never enters preferences.
    const startupPositionRevision = positionRevision;
    void (async () => {
        try {
            const saved = await settings.preferences([POSITION_KEY, SLOT_KEY]);
            if (positionRevision !== startupPositionRevision || lifecycle.state === 'disposed' || cardDrag.dragging) return;
            if (saved?.[POSITION_KEY] === 'report' || saved?.[POSITION_KEY] === 'summary') column = saved[POSITION_KEY];
            if (['before', 'gps', 'after'].includes(saved?.[SLOT_KEY])) slot = saved[SLOT_KEY];
            if (lifecycle.state === 'active') place();
        } catch { /* A storage failure retains the usable default placement. */ }
    })();
    // Preserve an already-published GPX selection while the initial settings
    // read is pending. An opt-out removes this listener before any request.
    listenForCursor();
    if (subject.reason) status.textContent = subject.reason;
    else if (subject.date < '1940-01-01') status.textContent = 'Historical weather is available from 1940.';
    // A newer sync notification owns the preference if startup's read is late.
    settings.requireCurrent().then(next => { if (!settingsReady && lifecycle.state !== 'disposed') applyPreference(next); }).catch(() => {});
    return { card, lifecycle };
}

mountAscentWeather();
