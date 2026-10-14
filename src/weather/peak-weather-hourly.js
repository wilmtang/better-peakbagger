// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { createStableText } from '../ui/stable-text.js';
import { mountainTime } from '../time/mountain-time.js';
import { createWeatherHourlyTable, hourlyWeatherSeries } from './weather-hourly-table.js';

const HOUR = 3600_000, element = dom.element;
const metrics = [['code', 'Conditions'], ['temperature', 'Temperature'], ['precipitation', 'Rain/snow'], ['wind', 'Wind'], ['gust', 'Gusts']];
const svgElement = (tag, attrs = {}, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
};

export const resolvePeakHourlyMetric = value => metrics.some(([key]) => key === value) ? value : 'code';

export function createPeakHourlyChart({ container, day, samples, zone, metric = 'code', format, onMetric, state }) {
    const id = `bpb-week-${day.window.date}`;
    metric = resolvePeakHourlyMetric(metric);
    let disposed = false, observer, rows = [], geometry, hover = -1, selected = -1;
    const tabs = element('div', { class: 'bpb-week-tabs', role: 'tablist', 'aria-label': 'Hourly weather data' });
    const buttons = metrics.map(([key, label]) => element('button', { type: 'button', role: 'tab', id: `${id}-${key}`, 'data-metric': key,
        'aria-controls': `${id}-panel`, 'aria-label': label, 'data-label': label }, [element('span', { class: 'bpb-week-tab-label', text: label })]));
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
    panel.append(readout, frame, conditions, note);
    container.replaceChildren(tabs, panel);
    const localTime = time => `${mountainTime.formatClock(zone, time)} ${mountainTime.zoneLabel(zone, time)}`;
    const timeLabel = (row, key = metric) => key === 'precipitation' || key === 'gust'
        ? `${localTime(row.start)} – ${localTime(row.time)}${row.time === day.window.end ? ' (next midnight)' : ''}` : localTime(row.time);
    const valueLabel = (value, key = metric) => format(value, key === 'gust' ? 'wind' : key);
    const readingLabel = (row, key = metric) => `${timeLabel(row, key)} · ${Number.isFinite(row.value) ? valueLabel(row.value, key) : 'Unavailable'}${row.partialInterval ? key === 'precipitation' ? ' · Estimated boundary interval' : ' · Gust for the overlapping hour' : ''}`;
    readingText.reserve(['Hourly readings unavailable', ...metrics.filter(([key]) => key !== 'code').flatMap(([key]) => {
        const candidates = hourlyWeatherSeries(day.window, samples, key);
        const values = candidates.map(row => row.value).filter(Number.isFinite);
        return [...candidates.map(row => readingLabel(row, key)), ...(values.length
            ? [`Low ${valueLabel(Math.min(...values), key)} · High ${valueLabel(Math.max(...values), key)}`] : [])];
    })]);
    const overview = () => {
        const values = rows.map(row => row.value).filter(Number.isFinite);
        if (!values.length) return 'Hourly readings unavailable';
        return `Low ${valueLabel(Math.min(...values))} · High ${valueLabel(Math.max(...values))}`;
    };
    function drawCursor() {
        svg.querySelector('.bpb-week-cursor')?.remove();
        const index = hover >= 0 ? hover : selected, row = rows[index];
        readingText.set(row ? readingLabel(row) : overview());
        if (!row || !geometry || empty.hidden === false) return;
        const { x, y, top, bottom } = geometry;
        const group = svgElement('g', { class: 'bpb-week-cursor', 'aria-hidden': 'true' });
        group.append(svgElement('line', { x1: x(row.time), x2: x(row.time), y1: top, y2: bottom }));
        if (Number.isFinite(row.value)) group.append(svgElement('circle', { cx: x(row.time), cy: y(row.value), r: 4 }));
        svg.append(group);
    }
    function draw() {
        if (disposed || metric === 'code') return;
        const width = Math.max(240, frame.getBoundingClientRect().width || 320), height = 184;
        const left = 44, right = width - 20, top = 16, bottom = 148;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.replaceChildren();
        const values = rows.map(row => row.value).filter(Number.isFinite);
        empty.hidden = values.length > 0; svg.toggleAttribute('hidden', !values.length);
        frame.tabIndex = values.length ? 0 : -1;
        empty.textContent = `${metrics.find(([key]) => key === metric)[1]} readings are unavailable for this day.`;
        frame.setAttribute('aria-label', `${metrics.find(([key]) => key === metric)[1]} hourly graph. Use left and right arrows to explore readings; Escape clears selection.`);
        svg.setAttribute('aria-label', `${metrics.find(([key]) => key === metric)[1]} in summit local time. ${overview()}. Missing readings leave gaps.`);
        if (!values.length) { geometry = null; drawCursor(); return; }
        const low = metric === 'temperature' ? Math.min(...values) - 2 : 0;
        // Keep rounded axis labels distinct even for a dry or calm day, in
        // either unit system (1 mm of rain, 4 km/h of wind).
        const high = Math.max(low + (metric === 'temperature' ? 4 : metric === 'precipitation' ? 1 : 4), Math.max(...values) + (metric === 'temperature' ? 2 : Math.max(...values) * .15));
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
            note.textContent = 'Summit local time · Scroll for all hours. Rain/snow and gusts cover the hour starting at the shown time; rain/snow is water equivalent.';
        } else {
            const boundary = rows.some(row => row.partialInterval);
            const intervalNote = metric === 'precipitation' ? `. Rain/snow is preceding-hour water equivalent${boundary ? '; boundary intervals are proportionally estimated' : ''}.`
                : metric === 'gust' ? `. Gusts are maxima for the preceding hour${boundary ? '; boundary intervals extend outside this day' : ''}.` : '.';
            note.textContent = `Summit local time · Hover, tap or use ← → for readings${intervalNote}`;
            draw();
        }
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
        return rows.reduce((nearest, row, index) => Math.abs(row.time - time) < Math.abs(rows[nearest].time - time) ? index : nearest, 0);
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
        drawCursor();
    }
    if (typeof ResizeObserver === 'function') { observer = new ResizeObserver(draw); observer.observe(frame); }
    return { snapshot: () => ({ metric, selectedTime: rows[selected]?.sourceTime ?? null, conditionsScrollLeft: conditions.scrollLeft }), dispose() {
        disposed = true; observer?.disconnect();
        tabs.onclick = tabs.onkeydown = frame.onpointermove = frame.onpointerleave = frame.onclick = frame.onkeydown = null;
        container.replaceChildren();
    } };
}
