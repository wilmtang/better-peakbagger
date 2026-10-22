// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { createStableText } from '../ui/stable-text.js';
import { mountainTime } from '../time/mountain-time.js';
import { createWeatherHourlyTable, hourlyWeatherSeries } from './weather-hourly-table.js';

const HOUR = 3600_000, element = dom.element;
const metrics = [['code', 'Conditions'], ['temperature', 'Temperature'], ['precipitation', 'Rain/snow'], ['snowfall', 'Snowfall'], ['freezing', 'Freezing level'], ['cloud', 'Clouds'], ['wind', 'Wind'], ['gust', 'Gusts']];
const svgElement = (tag, attrs = {}, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
};

export const resolvePeakHourlyMetric = value => metrics.some(([key]) => key === value) ? value : 'code';

export function createPeakHourlyChart({ container, day, samples, zone, metric = 'code', format, onMetric, state, referenceElevation, referenceLabel = 'Summit' }) {
    const id = `bpb-week-${day.window.date}`;
    metric = resolvePeakHourlyMetric(metric);
    let disposed = false, observer, rows = [], geometry, hover = -1, selected = -1;
    const tabs = element('div', { class: 'bpb-week-tabs', role: 'tablist', 'aria-label': 'Hourly weather data' });
    const buttons = metrics.map(([key, label]) => element('button', { type: 'button', role: 'tab', id: `${id}-${key}`, 'data-metric': key,
        'aria-controls': `${id}-panel`, 'aria-label': label, 'data-label': label }, [element('span', { class: 'bpb-week-tab-label',
        'data-compact': key === 'temperature' ? 'Temp' : key === 'freezing' ? 'Freezing' : null, text: label })]));
    tabs.append(...buttons);
    const panel = element('div', { class: 'bpb-week-panel', id: `${id}-panel`, role: 'tabpanel' });
    const readout = element('p', { class: 'bpb-week-readout', 'aria-live': 'off', 'aria-atomic': 'true' });
    const readingText = createStableText(readout);
    const frame = element('div', { class: 'bpb-week-chart', tabindex: '0', role: 'group', 'aria-describedby': `${id}-hint` });
    const svg = svgElement('svg', { role: 'img', preserveAspectRatio: 'xMidYMid meet' });
    const empty = element('p', { class: 'bpb-week-chart-empty', hidden: '' });
    frame.append(svg, empty);
    const conditions = element('div', { class: 'bpb-week-conditions bpb-weather-hourly-scroll', tabindex: '0', role: 'region', 'aria-label': 'Hourly weather in summit local time. Scroll horizontally for all hours.' });
    const note = element('p', { class: 'bpb-week-sub', id: `${id}-hint` });
    const info = element('button', { type: 'button', class: 'bpb-week-info', 'aria-expanded': 'false', 'aria-controls': `${id}-info` },
        [element('span', { 'aria-hidden': 'true', text: 'ⓘ' })]);
    const explanation = element('div', { class: 'bpb-week-explanation', id: `${id}-info`, role: 'tooltip', hidden: '' });
    const help = element('div', { class: 'bpb-week-chart-help' }, [note, info, explanation]);
    const closeInfo = () => {
        explanation.hidden = true; info.setAttribute('aria-expanded', 'false'); info.removeAttribute('aria-describedby');
        document.removeEventListener('pointerdown', outsideInfo, true); document.removeEventListener('keydown', escapeInfo);
    };
    const outsideInfo = event => { if (!help.contains(event.target)) closeInfo(); };
    const escapeInfo = event => { if (event.key === 'Escape') { event.preventDefault(); closeInfo(); info.focus({ preventScroll: true }); } };
    const positionInfo = () => {
        if (explanation.hidden) return;
        const host = help.getBoundingClientRect(), button = info.getBoundingClientRect(), box = explanation.getBoundingClientRect();
        const width = document.documentElement.clientWidth || window.innerWidth;
        const left = Math.max(8, Math.min(button.right - box.width, width - box.width - 8));
        const above = host.top - box.height - 6;
        const top = above >= 8 ? above : Math.max(8, Math.min(host.bottom + 6, window.innerHeight - box.height - 8));
        explanation.style.right = `${host.right - left - box.width}px`;
        explanation.style.top = `${top - host.top}px`;
    };
    const openInfo = () => {
        explanation.hidden = false; info.setAttribute('aria-expanded', 'true'); info.setAttribute('aria-describedby', explanation.id);
        positionInfo();
        document.addEventListener('pointerdown', outsideInfo, true); document.addEventListener('keydown', escapeInfo);
    };
    info.onclick = () => { if (explanation.hidden) openInfo(); else closeInfo(); };
    panel.append(readout, frame, conditions, help);
    container.replaceChildren(tabs, panel);
    const localTime = time => `${mountainTime.formatClock(zone, time)} ${mountainTime.zoneLabel(zone, time)}`;
    const accumulation = key => key === 'precipitation' || key === 'snowfall';
    const timeLabel = (row, key = metric) => accumulation(key) || key === 'gust'
        ? `${localTime(row.start)} – ${localTime(row.time)}${row.time === day.window.end ? ' (next midnight)' : ''}` : localTime(row.time);
    const valueLabel = (value, key = metric) => format(value, key === 'gust' ? 'wind' : key);
    const readingLabel = (row, key = metric) => `${timeLabel(row, key)} · ${Number.isFinite(row.value) ? `${valueLabel(row.value, key)}${key === 'snowfall' ? ' new snow' : ''}` : 'Unavailable'}${row.partialInterval ? accumulation(key) ? ' · Estimated boundary interval' : ' · Gust for the overlapping hour' : ''}`;
    const overviewFor = (key, candidates) => {
        const values = candidates.map(row => row.value).filter(Number.isFinite);
        if (!values.length) return 'Hourly readings unavailable';
        if (key === 'snowfall') return `New snow depth · ${valueLabel(values.reduce((sum, value) => sum + value, 0), key)} total${values.length !== candidates.length ? ' (partial)' : ''}`;
        return `Low ${valueLabel(Math.min(...values), key)} · High ${valueLabel(Math.max(...values), key)}`;
    };
    readingText.reserve(['Hourly readings unavailable', ...metrics.filter(([key]) => key !== 'code').flatMap(([key]) => {
        const candidates = hourlyWeatherSeries(day.window, samples, key);
        return [...candidates.map(row => readingLabel(row, key)), overviewFor(key, candidates)];
    })]);
    const overview = () => overviewFor(metric, rows);
    const rowTime = row => metric === 'snowfall' ? (row.start + row.time) / 2 : row.time;
    function drawCursor() {
        svg.querySelector('.bpb-week-cursor')?.remove();
        const index = hover >= 0 ? hover : selected, row = rows[index];
        readingText.set(row ? readingLabel(row) : overview());
        if (!row || !geometry || empty.hidden === false) return;
        const { x, y, top, bottom } = geometry;
        const group = svgElement('g', { class: 'bpb-week-cursor', 'aria-hidden': 'true' });
        group.append(svgElement('line', { x1: x(rowTime(row)), x2: x(rowTime(row)), y1: top, y2: bottom }));
        if (Number.isFinite(row.value)) group.append(svgElement('circle', { cx: x(rowTime(row)), cy: y(row.value), r: 4 }));
        svg.append(group);
    }
    function draw() {
        if (disposed || metric === 'code') return;
        const width = Math.max(240, frame.getBoundingClientRect().width || 320), height = 184;
        const left = 56, right = width - 20, top = 16, bottom = 148;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.replaceChildren();
        const values = rows.map(row => row.value).filter(Number.isFinite);
        empty.hidden = values.length > 0; svg.toggleAttribute('hidden', !values.length);
        frame.tabIndex = values.length ? 0 : -1;
        empty.textContent = metric === 'cloud' ? 'Cloud cover is unavailable for this day.'
            : `${metrics.find(([key]) => key === metric)[1]} readings are unavailable for this day.`;
        frame.setAttribute('aria-label', `${metrics.find(([key]) => key === metric)[1]} hourly graph. Use left and right arrows to explore readings; Escape clears selection.`);
        svg.setAttribute('aria-label', `${metrics.find(([key]) => key === metric)[1]} in summit local time. ${overview()}. Missing readings leave gaps.`);
        if (!values.length) { geometry = null; drawCursor(); return; }
        const references = metric === 'freezing' && Number.isFinite(referenceElevation) ? [referenceElevation] : [];
        const low = metric === 'freezing' ? Math.min(...values, ...references) - 200 : metric === 'temperature' ? Math.min(...values) - 2 : 0;
        // Keep rounded axis labels distinct even for a dry or calm day, in
        // either unit system (1 mm of rain, 4 km/h of wind).
        const high = metric === 'freezing' ? Math.max(...values, ...references) + 200 : metric === 'cloud' ? 100
            : Math.max(low + (metric === 'temperature' ? 4 : accumulation(metric) ? 1 : 4), Math.max(...values) + (metric === 'temperature' ? 2 : Math.max(...values) * .15));
        const x = time => left + (time - day.window.start) / (day.window.end - day.window.start) * (right - left);
        const y = value => bottom - (value - low) / (high - low) * (bottom - top);
        geometry = { x, y, top, bottom, left, right, width };
        for (let i = 0; i < 3; i++) {
            const value = low + (high - low) * i / 2, position = y(value);
            svg.append(svgElement('line', { class: 'bpb-week-grid', x1: left, x2: right, y1: position, y2: position }),
                svgElement('text', { class: 'bpb-week-axis', x: left - 6, y: position + 4, 'text-anchor': 'end' }, valueLabel(value)));
        }
        const tickHours = width < 470 ? [0, 12, 24] : [0, 6, 12, 18, 24];
        for (const hour of tickHours) {
            const time = hour === 24 ? day.window.end : mountainTime.civilToInstant(zone, day.window.date, hour * 60)?.ms;
            if (!Number.isFinite(time)) continue;
            svg.append(svgElement('text', { class: 'bpb-week-axis', x: x(time), y: bottom + 24, 'text-anchor': hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle' }, `${String(hour).padStart(2, '0')}:00`));
        }
        if (references.length) {
            const position = y(referenceElevation);
            svg.append(svgElement('line', { class: 'bpb-week-reference', x1: left, x2: right, y1: position, y2: position }),
                svgElement('text', { class: 'bpb-week-axis', x: right, y: position > top + 20 ? position - 6 : position + 14, 'text-anchor': 'end' }, `${referenceLabel} ${valueLabel(referenceElevation, 'freezing')}`));
        }
        if (metric === 'snowfall') {
            for (const row of rows.filter(sample => Number.isFinite(sample.value))) {
                const bar = svgElement('rect', { class: 'bpb-week-snowfall', x: x(row.start) + 1, y: y(row.value),
                    width: Math.max(1, x(row.time) - x(row.start) - 2), height: Math.max(0, bottom - y(row.value)), 'data-time': row.sourceTime });
                bar.append(svgElement('title', {}, readingLabel(row))); svg.append(bar);
            }
            drawCursor(); return;
        }
        let path = '', previous = null;
        for (const row of rows) {
            if (!Number.isFinite(row.value)) { previous = null; continue; }
            path += `${previous && row.sourceTime - previous.sourceTime === HOUR ? 'L' : 'M'}${x(row.time).toFixed(2)},${y(row.value).toFixed(2)} `;
            previous = row;
        }
        svg.append(svgElement('path', { class: 'bpb-week-line', d: path.trim() }));
        // Dots retain isolated readings and expose exact local times in SVG titles.
        for (const row of rows.filter(sample => Number.isFinite(sample.value))) {
            const point = svgElement('circle', { class: 'bpb-week-point', cx: x(row.time), cy: y(row.value), r: 2, 'data-time': row.sourceTime });
            point.append(svgElement('title', {}, `${timeLabel(row)} · ${valueLabel(row.value)}`)); svg.append(point);
        }
        drawCursor();
    }
    function choose(next, remember = true) {
        closeInfo();
        metric = next; hover = -1; selected = -1;
        if (remember) onMetric(metric);
        frame.dataset.weatherMetric = metric;
        rows = hourlyWeatherSeries(day.window, samples, metric);
        for (const button of buttons) {
            const active = button.dataset.metric === metric;
            button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
        }
        panel.setAttribute('aria-labelledby', `${id}-${metric}`);
        const isConditions = metric === 'code';
        conditions.hidden = !isConditions; frame.hidden = isConditions; readout.hidden = isConditions;
        if (isConditions) {
            const { table } = createWeatherHourlyTable({ window: day.window, samples, zone, format });
            conditions.replaceChildren(table);
            note.textContent = 'Summit local time · Scroll for all hours.';
        } else {
            note.textContent = 'Summit local time · Hover, tap or use ← → for readings.';
            draw();
        }
        const information = {
            snowfall: 'Snowfall is the depth of newly fallen snow, in centimeters or inches, not its water equivalent or existing snow depth. Bars cover the preceding hour; the total adds the shown intervals. Open-Meteo uses an approximate 7:1 snow-to-liquid ratio. Partial boundary intervals are estimated.',
            freezing: 'Freezing level is the altitude above sea level where air temperature is 0°C (32°F), not snow depth or the snowline. Snow can fall below this level. The dashed reference marks the summit or selected location when its elevation is known.',
            precipitation: 'Rain/snow is total precipitation as liquid water equivalent, including rain, showers and melted snow. Values cover the preceding hour. Partial boundary intervals are proportionally estimated.',
            gust: 'Gusts are maxima for the preceding hour. A partial boundary hour can include time outside this day.',
            cloud: 'Cloud cover is the percentage of sky covered by clouds: 0% is clear and 100% is overcast. It does not indicate cloud-base height or whether the summit is inside cloud.',
            code: 'Hourly model estimates in local time. Rain/snow is water equivalent; new snow depth is separate. Rain/snow, snowfall and gusts cover the hour starting at the shown time. Freezing level is altitude above sea level. Missing readings stay unavailable.',
            temperature: 'Air temperature at two meters above ground, adjusted to the requested elevation when available. These are model estimates, not station observations.',
            wind: 'Wind speed at ten meters above ground. These are model estimates; terrain and exposure can change local conditions.',
        };
        explanation.textContent = information[metric];
        info.setAttribute('aria-label', `About ${metrics.find(([key]) => key === metric)[1].toLowerCase()}${metric === 'snowfall' ? ' depth' : ''}`);
    }
    tabs.onclick = event => {
        const button = event.target.closest('button[data-metric]');
        if (button && tabs.contains(button)) choose(button.dataset.metric);
    };
    tabs.onkeydown = event => {
        const index = buttons.indexOf(event.target);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        choose(buttons[next].dataset.metric); buttons[next].focus({ preventScroll: true });
    };
    const pointerIndex = event => {
        if (!geometry || !rows.length) return -1;
        const bounds = svg.getBoundingClientRect();
        if (!bounds.width) return -1;
        const position = (event.clientX - bounds.left) / bounds.width * geometry.width;
        const time = day.window.start + (position - geometry.left) / (geometry.right - geometry.left) * (day.window.end - day.window.start);
        return rows.reduce((nearest, row, index) => Math.abs(rowTime(row) - time) < Math.abs(rowTime(rows[nearest]) - time) ? index : nearest, 0);
    };
    frame.onpointermove = event => { hover = pointerIndex(event); readout.setAttribute('aria-live', 'off'); drawCursor(); };
    frame.onpointerleave = () => { hover = -1; drawCursor(); };
    frame.onclick = event => { selected = pointerIndex(event); hover = -1; drawCursor(); };
    frame.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
        event.preventDefault(); hover = -1; readout.setAttribute('aria-live', 'polite');
        if (event.key === 'Escape') selected = -1;
        else if (event.key === 'Home') selected = 0;
        else if (event.key === 'End') selected = rows.length - 1;
        else selected = Math.max(0, Math.min(rows.length - 1, selected < 0 ? event.key === 'ArrowRight' ? 0 : rows.length - 1 : selected + (event.key === 'ArrowRight' ? 1 : -1)));
        drawCursor();
    };
    choose(metric, false);
    if (state) {
        selected = rows.findIndex(row => row.sourceTime === state.selectedTime);
        conditions.scrollLeft = state.conditionsScrollLeft || 0;
        if (state.infoOpen) openInfo();
        drawCursor();
    }
    if (typeof ResizeObserver === 'function') { observer = new ResizeObserver(() => { draw(); positionInfo(); }); observer.observe(frame); observer.observe(help); }
    return { snapshot: () => ({ metric, selectedTime: rows[selected]?.sourceTime ?? null, conditionsScrollLeft: conditions.scrollLeft, infoOpen: !explanation.hidden }), dispose() {
        closeInfo(); info.onclick = null;
        disposed = true; observer?.disconnect();
        tabs.onclick = tabs.onkeydown = frame.onpointermove = frame.onpointerleave = frame.onclick = frame.onkeydown = null;
        container.replaceChildren();
    } };
}
