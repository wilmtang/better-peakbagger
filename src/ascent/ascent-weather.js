// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { units } from '../ui/units.js';
import { settings } from '../settings/settings.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { fetchPeakbaggerDocument } from '../peakbagger/peakbagger-request.js';
import { mountainTime } from '../time/mountain-time.js';
import { readWeatherSubject, readWeatherSummit } from './ascent-weather-subject.js';
import { weatherDayWindow, summarizeWeatherDay } from '../weather/weather-day.js';
import { eligibleWeatherModels, recommendedWeatherModels } from '../weather/weather-models.js';
import { createWeatherClient } from '../weather/open-meteo-client.js';

const ID = 'bpb-ascent-weather', SVG_NS = 'http://www.w3.org/2000/svg';
const element = dom.element;
const numeric = value => Number.isFinite(value);
const clean = text => (text || '').replace(/\s+/g, ' ').trim();
const displayDate = date => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export function mountAscentWeather() {
    if (document.getElementById(ID)) return;
    const subject = readWeatherSubject(document, location.href);
    const card = element('section', { id: ID, 'aria-labelledby': `${ID}-heading`, 'aria-busy': 'false' });
    const heading = element('h2', { id: `${ID}-heading`, text: 'Weather' });
    const date = element('span', { class: 'bpb-weather-date', text: subject.date ? displayDate(subject.date) : 'Ascent date unavailable' });
    const locationLabel = element('div', { class: 'bpb-weather-location', text: subject.peak ? `${subject.peak.name} · At the summit` : 'At the summit' });
    const status = element('div', { class: 'bpb-weather-status', role: 'status', 'aria-live': 'polite' });
    const retry = element('button', { type: 'button', class: 'bpb-weather-retry', text: 'Retry', hidden: '' });
    const condition = element('h3');
    // Unicode symbols are packaged text, never remotely requested images.
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
    const select = element('select', { id: `${ID}-model`, 'aria-label': 'Weather model' }, [element('option', { value: 'auto', text: 'Auto (recommended)' })]);
    const modelName = element('span'), modelType = element('span', { class: 'bpb-weather-sub' });
    const modelRow = element('div', { class: 'bpb-weather-model' }, [
        element('div', {}, [element('label', { for: select.id, text: 'Weather model' }), select]),
        element('div', { class: 'bpb-weather-model-description' }, [modelName, modelType]),
    ]);
    const disclosure = element('button', { type: 'button', class: 'bpb-weather-disclosure', 'aria-expanded': 'false', 'aria-controls': `${ID}-hourly` }, [
        element('span', { text: 'Hourly weather' }), element('span', { class: 'bpb-weather-sub', text: 'Summit local time ▾' }),
    ]);
    const tabs = element('div', { class: 'bpb-weather-tabs', role: 'tablist', 'aria-label': 'Hourly measurement' });
    for (const [key, text] of [['temperature', 'Temperature'], ['precipitation', 'Precipitation'], ['wind', 'Wind']]) {
        tabs.append(element('button', { type: 'button', role: 'tab', tabindex: key === 'temperature' ? '0' : '-1', id: `${ID}-tab-${key}`, 'aria-controls': `${ID}-plot`, 'aria-selected': String(key === 'temperature'), 'data-metric': key, text }));
    }
    const zoneText = element('span', { class: 'bpb-weather-sub' });
    const chart = document.createElementNS(SVG_NS, 'svg');
    chart.setAttribute('class', 'bpb-weather-chart'); chart.setAttribute('role', 'img');
    const plot = element('div', { id: `${ID}-plot`, role: 'tabpanel', 'aria-labelledby': `${ID}-tab-temperature` }, [chart]);
    const hourly = element('div', { id: `${ID}-hourly`, hidden: '' }, [element('div', { class: 'bpb-weather-hourly-controls' }, [tabs, zoneText]), plot]);
    const sourceText = element('div', { class: 'bpb-weather-source-text' });
    const sources = element('details', { class: 'bpb-weather-sources' }, [element('summary', { text: 'Source details' }), sourceText]);
    const resultArea = element('div', { class: 'bpb-weather-result', hidden: '' }, [
        element('div', { class: 'bpb-weather-condition' }, [conditionIcon, element('div', {}, [condition, conditionDetail])]), metrics,
    ]);
    const detailsArea = element('div', { hidden: '' }, [element('div', { class: 'bpb-weather-hourly' }, [disclosure, hourly]), sources]);
    modelRow.hidden = true;
    const attribution = element('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo' });
    card.append(element('header', {}, [heading, date]), locationLabel, element('div', { class: 'bpb-weather-feedback' }, [status, retry]), resultArea, modelRow, detailsArea,
        element('footer', {}, [element('span', { text: 'Model estimate · Route conditions may differ' }), attribution]));

    // Keep weather with the right-hand summary, independently of report height
    // or a later GPX explorer. Unrecognized layouts retain the map fallback.
    const nativeMap = [...document.querySelectorAll('iframe[src]')].find(frame => {
        try { return /\/MasterMap\.aspx$/i.test(new URL(frame.getAttribute('src'), location.href).pathname); } catch { return false; }
    });
    const mountParent = nativeMap?.parentElement || subject.table?.parentElement || document.querySelector('#page') || document.body;
    const place = () => {
        const summary = document.querySelector('#bpb-ascent-summary-column > .bpb-ascent-table-split__summary');
        if (summary) {
            if (summary.nextElementSibling !== card) summary.after(card);
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
            if (anchor.nextElementSibling !== card) anchor.after(card);
        } else if (!card.isConnected) mountParent.append(card);
    };
    place();
    const placementObserver = new MutationObserver(place);
    placementObserver.observe(mountParent, { childList: true, subtree: true });

    let preference = settings.DEFAULTS, summit = null, dayWindow = null, candidates = [], current = null;
    let metric = 'temperature', generation = 0, controller = null, started = false, visibilityObserver = null;
    const failed = new Set(), client = createWeatherClient();
    let lifecycle;
    const unitSystem = () => units.resolveUnits(preference, () => {
        const elevationText = clean(document.querySelector('.peakinfo')?.textContent || subject.table?.textContent);
        return /\d\s*(?:meters|m)\b/i.test(elevationText) && !/\d\s*(?:feet|ft)\b/i.test(elevationText) ? 'metric' : 'imperial';
    });
    const convert = (value, key) => unitSystem() === 'imperial' ? (key === 'temperature' ? value * 9 / 5 + 32 : key === 'precipitation' ? value / 25.4 : value / 1.609344) : value;
    const unit = key => key === 'temperature' ? (unitSystem() === 'imperial' ? '°F' : '°C') : key === 'precipitation' ? (unitSystem() === 'imperial' ? 'in' : 'mm') : (unitSystem() === 'imperial' ? 'mph' : 'km/h');
    const format = (value, key) => numeric(value) ? `${convert(value, key).toFixed(key === 'precipitation' ? (unitSystem() === 'imperial' ? 2 : 1) : 0).replace('-', '−')}${key === 'temperature' ? '' : ' '}${unit(key)}` : '—';

    function drawChart() {
        if (!current || hourly.hidden || lifecycle?.state !== 'active') return;
        const width = chart.getBoundingClientRect().width;
        if (width < 100) return;
        const rows = metric === 'precipitation' ? current.day.precipitationHours.map(row => ({ time: row.time, value: row.value }))
            : current.day.hourly.map(row => ({ time: row.time, value: row[metric] }));
        const finite = rows.filter(row => numeric(row.value));
        chart.replaceChildren(); chart.setAttribute('viewBox', `0 0 ${width} 164`);
        const add = (tag, attributes, text) => {
            const node = document.createElementNS(SVG_NS, tag);
            Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
            if (text != null) node.textContent = text;
            chart.append(node); return node;
        };
        const chartLabel = `${metric === 'temperature' ? 'Temperature' : metric === 'precipitation' ? 'Preceding-hour precipitation' : 'Wind'} (${unit(metric)}), summit local time.`;
        chart.setAttribute('aria-label', chartLabel);
        add('title', {}, chartLabel);
        if (!finite.length) { add('text', { x: width / 2, y: 70, 'text-anchor': 'middle' }, 'Hourly data unavailable'); return; }
        const values = finite.map(row => convert(row.value, metric));
        const low = metric === 'temperature' ? Math.floor(Math.min(...values) - 2) : 0;
        const high = Math.max(low + 1, Math.max(...values) + (metric === 'temperature' ? 2 : Math.max(...values) * .15));
        const left = 42, right = width - 16, top = 26, bottom = 124;
        const x = time => left + (right - left) * (time - dayWindow.start) / (dayWindow.end - dayWindow.start);
        const y = value => bottom - (convert(value, metric) - low) / (high - low) * (bottom - top);
        add('text', { x: left, y: 12 }, unit(metric));
        for (const value of [low, (low + high) / 2, high]) {
            const yy = bottom - (value - low) / (high - low) * (bottom - top);
            add('line', { x1: left, x2: right, y1: yy, y2: yy, class: 'bpb-weather-grid' });
            add('text', { x: left - 7, y: yy + 4, 'text-anchor': 'end' }, value.toFixed(metric === 'precipitation' ? (unitSystem() === 'imperial' ? 2 : 1) : 0));
        }
        const tickCount = width < 200 ? 2 : width < 400 ? 3 : 5;
        for (let index = 0; index < tickCount; index++) {
            const time = dayWindow.start + (dayWindow.end - dayWindow.start) * index / (tickCount - 1);
            const label = index === tickCount - 1 ? '24:00' : mountainTime.formatClock(dayWindow.zone, time, { locales: 'en-GB' });
            add('text', { x: x(time), y: 150, 'text-anchor': index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle' }, label);
        }
        if (metric === 'precipitation') {
            const barWidth = Math.max(2, (right - left) / 25 * .65);
            for (const row of finite) if (row.value > 0) add('rect', { x: Math.max(left, Math.min(right - barWidth, x(Math.min(dayWindow.end, row.time)) - barWidth / 2)), y: y(row.value), width: barWidth, height: bottom - y(row.value), class: 'bpb-weather-bar' });
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
            const label = `${mountainTime.formatClock(dayWindow.zone, row.time)} ${mountainTime.zoneLabel(dayWindow.zone, row.time)} · ${format(row.value, metric)}`;
            const point = add('circle', { cx: Math.min(right, x(row.time)), cy: y(row.value), r: 8, class: 'bpb-weather-hover' });
            const title = document.createElementNS(SVG_NS, 'title'); title.textContent = label; point.append(title);
        }
    }

    function renderResult() {
        if (!current) return;
        const { day, model, data } = current;
        resultArea.hidden = false; detailsArea.hidden = false;
        condition.textContent = day.condition.label;
        conditionIcon.textContent = { sun: '☀', cloud: '☁', partly: '⛅', rain: '☂', snow: '❄', fog: '≋', storm: 'ϟ', unknown: '—' }[day.condition.icon];
        conditionDetail.textContent = day.condition.complete && !dayWindow.partial ? 'Conditions during the ascent day' : 'Conditions in available hours';
        readings.temperature.value.textContent = numeric(day.temperature.low) ? `${convert(day.temperature.low, 'temperature').toFixed(0)}–${convert(day.temperature.high, 'temperature').toFixed(0)}${unit('temperature')}`.replaceAll('-', '−') : '—';
        readings.precipitation.value.textContent = format(day.precipitation.total, 'precipitation');
        readings.wind.value.textContent = format(day.wind.high, 'wind'); readings.gust.value.textContent = format(day.gust.high, 'wind');
        for (const key of ['temperature', 'wind', 'gust']) readings[key].detail.textContent = !day[key].complete || dayWindow.partial ? 'Available hours' : key === 'temperature' ? 'Daily low / high' : 'Daily maximum';
        readings.precipitation.detail.textContent = !day.precipitation.complete ? 'Partial total' : 'Water equivalent';
        if (day.precipitation.total === null) readings.precipitation.detail.textContent = 'Unavailable';
        locationLabel.textContent = `${subject.peak.name} · At the summit${summit.elevation === null ? '' : ` · ${units.formatElevation(summit.elevation, unitSystem())}`}`;
        modelName.textContent = `Using ${model.label} · ${model.resolution}`; modelType.textContent = model.type;
        zoneText.textContent = mountainTime.zoneLabel(dayWindow.zone, dayWindow.start);
        sourceText.textContent = `${model.label}, ${model.resolution}. ${model.type}; native ${model.intervalHours}-hour data${model.intervalHours > 1 ? ', interpolated to hourly' : ''}. Summit timezone: ${dayWindow.zone.timeZone || zoneText.textContent}. Selected grid: ${data.grid.latitude.toFixed(4)}, ${data.grid.longitude.toFixed(4)}. ${summit.elevation === null ? 'Provider terrain elevation' : 'Summit elevation supplied for temperature downscaling'}: ${data.grid.elevation.toFixed(0)} m.${day.precipitation.allocationEstimated ? ' Precipitation at fractional-hour day boundaries is proportionally allocated.' : ''} Model estimates cannot establish the climber’s summit time or route conditions.`;
        drawChart();
    }
    const busy = value => { card.setAttribute('aria-busy', String(value)); retry.hidden = true; };
    const cancel = () => { generation++; controller?.abort(); controller = null; busy(false); };
    const prepare = async signal => {
        if (summit) return;
        const response = await fetchPeakbaggerDocument(subject.peak.url, { kind: 'html', signal, init: { referrerPolicy: 'no-referrer' } });
        if (response.kind !== 'ok') throw new Error('Summit details could not be loaded. Try again.');
        summit = readWeatherSummit(response.document, subject, response.url);
        const zone = mountainTime.resolve(summit.latitude, summit.longitude);
        dayWindow = weatherDayWindow(subject.date, zone);
        candidates = eligibleWeatherModels(summit, subject.date);
        if (!candidates.length) throw new Error('No historical weather models cover this ascent date.');
        for (const model of candidates) select.append(element('option', { value: model.id, text: `${model.label} · ${model.resolution}` }));
        modelRow.hidden = false;
    };
    async function load() {
        if (subject.reason || subject.date < '1940-01-01' || lifecycle?.state !== 'active') return;
        cancel(); const ownGeneration = generation; controller = new AbortController(); const signal = controller.signal;
        busy(true); started = true;
        if (!current) { resultArea.hidden = false; condition.textContent = 'Weather conditions'; conditionDetail.textContent = 'Ascent-day model estimate'; }
        status.textContent = current ? `Showing ${current.model.label} while loading…` : 'Loading ascent-day weather…';
        try {
            await prepare(signal);
            if (ownGeneration !== generation) return;
            dayWindow = weatherDayWindow(subject.date, mountainTime.resolve(summit.latitude, summit.longitude));
            const automatic = select.value === 'auto';
            const chain = automatic ? recommendedWeatherModels(summit, subject.date).filter(model => !failed.has(model.id)).slice(0, 3) : candidates.filter(model => model.id === select.value);
            let result = null;
            for (const model of chain) {
                if (ownGeneration !== generation) return;
                let data;
                try { data = await client.request(summit, dayWindow, model, { signal }); }
                catch (error) {
                    if (error.code !== 'unavailable') { if (result) { current = result; renderResult(); } throw error; }
                    failed.add(model.id); const option = [...select.options].find(candidate => candidate.value === model.id);
                    if (option) { option.disabled = true; option.textContent += ' — unavailable'; }
                    if (!automatic) throw error;
                    continue;
                }
                if (ownGeneration !== generation) return;
                const day = summarizeWeatherDay(data, dayWindow);
                if (day.useful && !result) result = { model, day, data };
                if (day.coreComplete || (dayWindow.partial && day.useful)) { result = { model, day, data }; break; }
                if (!automatic) break;
            }
            if (ownGeneration !== generation) return;
            if (!result) throw new Error('No weather data is available for this model and ascent day. Choose another model.');
            current = result; renderResult(); status.textContent = dayWindow.partial ? 'Partial day · Weather so far' : result.day.partial ? 'Partial data · Some hours or measurements are unavailable' : '';
            retry.hidden = !result.day.partial && !dayWindow.partial;
        } catch (error) {
            if (ownGeneration !== generation || signal.aborted) return;
            if (!current) resultArea.hidden = true;
            status.textContent = `${current ? `Showing ${current.model.label}. ` : ''}${error.message}`; retry.hidden = false;
        } finally {
            if (ownGeneration === generation) card.setAttribute('aria-busy', 'false');
        }
    }
    select.addEventListener('change', load);
    retry.addEventListener('click', () => {
        client.clear(); failed.clear();
        for (const model of candidates) {
            const option = [...select.options].find(candidate => candidate.value === model.id);
            if (option) { option.disabled = false; option.textContent = `${model.label} · ${model.resolution}`; }
        }
        void load();
    });
    disclosure.addEventListener('click', () => { hourly.hidden = !hourly.hidden; disclosure.setAttribute('aria-expanded', String(!hourly.hidden)); drawChart(); });
    tabs.querySelectorAll('button').forEach(button => {
        button.addEventListener('click', () => {
            metric = button.dataset.metric;
            tabs.querySelectorAll('button').forEach(tab => { tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; });
            plot.setAttribute('aria-labelledby', button.id); drawChart();
        });
        button.addEventListener('keydown', event => {
            if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const buttons = [...tabs.querySelectorAll('button')], index = buttons.indexOf(button);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
            buttons[next].focus(); buttons[next].click();
        });
    });
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(drawChart) : null;
    resizeObserver?.observe(chart);
    const unsubscribe = settings.subscribe(next => { preference = next; renderResult(); });
    settings.get().then(next => { preference = next; if (lifecycle?.state === 'active') renderResult(); });
    const beginWhenVisible = () => {
        if (subject.reason || subject.date < '1940-01-01') return;
        if (typeof IntersectionObserver !== 'function') { void load(); return; }
        visibilityObserver?.disconnect();
        visibilityObserver = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { visibilityObserver.disconnect(); visibilityObserver = null; void load(); }
        }, { rootMargin: '200px' });
        visibilityObserver.observe(card);
    };
    lifecycle = createPageLifecycle({
        onSuspend: () => { cancel(); placementObserver.disconnect(); visibilityObserver?.disconnect(); },
        onResume: () => { place(); placementObserver.observe(mountParent, { childList: true, subtree: true }); if (!current || started) beginWhenVisible(); },
        onDispose: () => { cancel(); placementObserver.disconnect(); visibilityObserver?.disconnect(); resizeObserver?.disconnect(); unsubscribe(); client.clear(); },
    });
    if (subject.reason) status.textContent = subject.reason;
    else if (subject.date < '1940-01-01') status.textContent = 'Historical weather is available from 1940.';
    else beginWhenVisible();
    return { card, lifecycle };
}

mountAscentWeather();
