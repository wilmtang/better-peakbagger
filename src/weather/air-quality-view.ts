// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { dom } from '../ui/dom.js';
import { createStableText } from '../ui/stable-text.js';
import { mountainTime } from '../time/mountain-time.js';
import { createAirQualityClient, airQualityCategory } from './air-quality-client.js';
import { compactWeatherHours, sizeWeatherStrip } from './weather-hourly-table.ts';

interface AirPoint { latitude: number; longitude: number }
interface AirSample { time: number; aqi: number | null; pm: number | null }
interface AirResult { samples: AirSample[]; loadedAt: number; grid: AirPoint }
interface AirClient { request: (point: AirPoint, options: { signal: AbortSignal; refresh: boolean }) => Promise<AirResult>; clear: () => void }
const bands = [
    ['0–50', 'Good'], ['51–100', 'Moderate'], ['101–150', 'Unhealthy for sensitive groups'],
    ['151–200', 'Unhealthy'], ['201–300', 'Very unhealthy'], ['301+', 'Hazardous'],
];
const airBand = (aqi: number) => aqi <= 50 ? 0 : aqi <= 100 ? 1 : aqi <= 150 ? 2 : aqi <= 200 ? 3 : aqi <= 300 ? 4 : 5;
const pmLabel = (value: number | null) => value === null ? 'Unavailable' : `${value.toFixed(1)} µg/m³`;
const reading = (sample: AirSample) => `${sample.aqi === null ? 'AQI unavailable' : `${Math.round(sample.aqi)} US AQI · ${airQualityCategory(sample.aqi)}`} · PM2.5 ${pmLabel(sample.pm)}`;
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function createAirQualityView({ readLocation, available }: { readLocation: () => AirPoint; available: () => boolean }) {
    const el = dom.element as <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, unknown>, children?: Node[]) => HTMLElementTagNameMap[K];
    // The untouched client validates every field before this view sees it.
    const client = createAirQualityClient() as AirClient;
    const panel = el('div', { id: 'bpb-peak-weather-air', role: 'tabpanel', 'aria-labelledby': 'bpb-peak-weather-aqi', hidden: '' });
    const refresh = el('button', { type: 'button', text: 'Refresh', 'aria-label': 'Refresh air quality' });
    const status = el('p', { class: 'bpb-week-status', role: 'status', 'aria-live': 'polite' });
    const feedback = createStableText(status);
    feedback.reserve(['Loading…', 'Refreshing…', 'Refresh failed.', 'Service busy.', 'Forecast expired.', 'Timed out.', 'Could not load.']);
    const summary = el('p', { class: 'bpb-air-summary', text: 'Regional air-quality forecast' });
    const summaryText = createStableText(summary);
    summaryText.reserve(['Regional forecast unavailable', 'AQI unavailable · PM2.5 Unavailable',
        ...bands.map(([, category]) => `10000 US AQI · ${category} · PM2.5 10000.0 µg/m³`)]);
    const time = el('p', { class: 'bpb-air-time' }), timeText = createStableText(time);
    const readout = el('div', { class: 'bpb-air-readout', role: 'group', 'aria-label': 'Selected hour', 'aria-live': 'polite', 'aria-atomic': 'true' }, [summary, time]);
    const head = el('thead'), body = el('tbody');
    const table = el('table', { class: 'bpb-air-table bpb-weather-strip', 'aria-label': 'Hourly regional air-quality forecast · US AQI and PM2.5' }, [head, body]);
    const list = el('div', { class: 'bpb-air-hours bpb-weather-strip-scroll', tabindex: '0', role: 'region', 'aria-label': 'Hourly air-quality forecast. Use left and right arrows to select an hour; scroll horizontally for all hours.' }, [table]);
    const scale = el('ul', { class: 'bpb-air-scale', 'aria-label': 'US AQI categories' }, bands.map(([range, category], index) => el('li', {
        title: `${range}: ${category}`, 'aria-label': `${category}: ${range} US AQI`,
    }, [el('span', { class: 'bpb-air-swatch', 'data-band': index, 'aria-hidden': 'true' }), document.createTextNode(range)])));
    const loaded = el('span', { class: 'bpb-air-loaded' }), loadedText = createStableText(loaded);
    // Erasing expired metadata must not shorten a bottom-scrolled page while
    // its replacement request is pending. Reserve only a generic UTC label.
    loaded.style.display = 'inline-grid';
    loadedText.reserve([' · Loaded 2000-12-28 23:58 UTC']);
    const source = el('p', { class: 'bpb-week-sub' }, [document.createTextNode('Regional surface model, not a summit measurement. CAMS uses approximately 45 km globally and 11 km in Europe. '),
        el('a', { href: 'https://open-meteo.com/en/docs/air-quality-api', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo / CAMS' }), loaded]);
    panel.append(el('div', { class: 'bpb-air-heading' }, [el('strong', { text: 'Air quality · 5-day forecast' }), refresh]), readout, list, scale, status, source);
    let selected = false, controller: AbortController | null = null, generation = 0, result: AirResult | null = null, resultKey = '', retryAt = 0;
    let expiry: ReturnType<typeof setTimeout> | null = null, selectedTime: number | null = null;
    let displayed: AirSample[] = [];
    const columns = new Map<number, HTMLTableCellElement[]>();
    const key = (point: AirPoint) => `${point.latitude}/${point.longitude}`;
    const clearExpiry = () => { if (expiry !== null) clearTimeout(expiry); expiry = null; };
    const stop = () => { clearExpiry(); generation++; controller?.abort(); controller = null; panel.setAttribute('aria-busy', 'false'); refresh.setAttribute('aria-disabled', String(retryAt > Date.now())); };
    const timeLabel = (sample: AirSample) => {
        const point = readLocation(), zone = mountainTime.resolve(point.latitude, point.longitude)!;
        return `${dateLabel(mountainTime.localDate(zone, sample.time)!)} · ${mountainTime.formatClock(zone, sample.time)} ${mountainTime.zoneLabel(zone, sample.time)}`;
    };
    const reserveTimes = () => {
        const year = new Date(Date.now()).getUTCFullYear();
        timeText.reserve(Array.from({ length: 24 }, (_, index) => timeLabel({ time: Date.UTC(year, Math.floor(index / 2), 28, index % 2 ? 12 : 0), aqi: null, pm: null })));
    };
    reserveTimes();
    const selectHour = (sample: AirSample, reveal = false) => {
        selectedTime = sample.time;
        for (const [timestamp, cells] of columns) for (const cell of cells) {
            cell.toggleAttribute('data-selected', timestamp === selectedTime);
            if (cell.tagName === 'TH') { if (timestamp === selectedTime) cell.setAttribute('aria-current', 'time'); else cell.removeAttribute('aria-current'); }
        }
        summaryText.set(reading(sample)); timeText.set(timeLabel(sample));
        if (reveal) {
            const cell = columns.get(sample.time)?.[0];
            if (!cell) return;
            const viewport = list.getBoundingClientRect(), bounds = cell.getBoundingClientRect();
            const pinned = head.rows[1]?.cells[0].getBoundingClientRect().width || 0;
            if (bounds.left < viewport.left + pinned) list.scrollLeft += bounds.left - viewport.left - pinned;
            else if (bounds.right > viewport.right) list.scrollLeft += bounds.right - viewport.right;
        }
    };
    const paint = (clear = false) => {
        if (!result) {
            // Expiry erases stale values while preserving the grid geometry.
            // A different requested point also clears the old timezone headers.
            if (clear) { head.replaceChildren(); body.replaceChildren(); table.querySelector('colgroup')?.remove(); columns.clear(); displayed = []; selectedTime = null; }
            else for (const row of body.rows) for (const cell of [...row.cells].slice(1)) {
                cell.textContent = '—'; cell.removeAttribute('data-band'); cell.removeAttribute('data-selected'); cell.setAttribute('aria-label', 'Unavailable'); cell.title = 'Unavailable';
            }
            displayed = displayed.map(sample => ({ time: sample.time, aqi: null, pm: null }));
            head.querySelector('[aria-current]')?.removeAttribute('aria-current');
            head.querySelectorAll('[data-selected]').forEach(cell => cell.removeAttribute('data-selected'));
            summaryText.set('Regional forecast unavailable'); timeText.set(''); loadedText.set(''); source.removeAttribute('title'); return;
        }
        const oldScroll = list.scrollLeft, viewportLeft = list.getBoundingClientRect().left;
        const pinned = head.rows[1]?.cells[0].getBoundingClientRect().width || 0;
        const anchor = [...columns.entries()].find(([, cells]) => cells[0].getBoundingClientRect().right > viewportLeft + pinned);
        const anchorLeft = anchor ? anchor[1][0].getBoundingClientRect().left - viewportLeft : 0;
        const point = readLocation(), zone = mountainTime.resolve(point.latitude, point.longitude)!, now = Date.now();
        displayed = result.samples.filter(sample => sample.time + 3600000 > now);
        const labels = compactWeatherHours(zone, displayed.map(sample => sample.time));
        const days = el('tr', { class: 'bpb-air-days' }, [el('th', { scope: 'col', text: 'Date' })]);
        for (let index = 0; index < labels.length;) {
            const first = labels[index]; let end = index + 1;
            while (end < labels.length && labels[end].date === first.date) end++;
            days.append(el('th', { scope: 'colgroup', colspan: end - index, text: first.date.slice(5), title: first.date, 'aria-label': dateLabel(first.date) })); index = end;
        }
        const hours = el('tr', {}, [el('th', { scope: 'col', text: 'Time' })]);
        columns.clear();
        labels.forEach(label => {
            const cell = el('th', { scope: 'col', 'data-air-time': label.time }, [el('time', { datetime: new Date(label.time).toISOString(), title: label.title, text: label.clock }),
                el('span', { class: 'bpb-weather-hour-zone', ...(label.showZone ? {} : { 'data-sizing-only': '', 'aria-hidden': 'true' }), text: label.showZone ? label.displayZone : 'UTC' })]);
            hours.append(cell); columns.set(label.time, [cell]);
        });
        head.replaceChildren(days, hours); body.replaceChildren();
        table.querySelector('colgroup')?.remove(); sizeWeatherStrip(table, displayed.length);
        for (const metric of ['aqi', 'pm'] as const) {
            const heading = el('th', { scope: 'row', text: metric === 'aqi' ? 'US AQI' : 'PM2.5' });
            if (metric === 'pm') heading.append(el('span', { class: 'bpb-weather-strip-unit', text: 'µg/m³' }));
            const row = el('tr', { 'data-air-row': metric }, [heading]);
            displayed.forEach(sample => {
                const value = sample[metric], cell = el('td', { 'data-air-time': sample.time,
                    text: value === null ? '—' : metric === 'aqi' ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '') });
                if (metric === 'aqi' && value !== null) cell.dataset.band = String(airBand(value));
                cell.title = `${timeLabel(sample)} · ${metric === 'aqi' ? value === null ? 'AQI unavailable' : `${Math.round(value)} US AQI · ${airQualityCategory(value)}` : `PM2.5 ${pmLabel(value)}`}`;
                cell.setAttribute('aria-label', cell.title); row.append(cell); columns.get(sample.time)!.push(cell);
            }); body.append(row);
        }
        const sample = displayed.find(item => item.time === selectedTime) || displayed[0];
        if (sample) selectHour(sample); else { selectedTime = null; summaryText.set('Regional forecast unavailable'); timeText.set(''); }
        list.scrollLeft = oldScroll;
        if (anchor) {
            const cell = columns.get(anchor[0])?.[0];
            if (cell) list.scrollLeft += cell.getBoundingClientRect().left - list.getBoundingClientRect().left - anchorLeft;
        }
        list.setAttribute('aria-label', `Hourly air-quality forecast · ${mountainTime.zoneLabel(zone, sample?.time || now)}. Use left and right arrows to select an hour; scroll horizontally for all hours.`);
        loadedText.set(` · Loaded ${new Date(result.loadedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
        source.title = `Grid ${result.grid.latitude.toFixed(3)}, ${result.grid.longitude.toFixed(3)}. Loaded ${mountainTime.formatClock(zone, result.loadedAt)} ${mountainTime.zoneLabel(zone, result.loadedAt)}.`;
    };
    const armExpiry = () => {
        clearExpiry();
        if (result) expiry = setTimeout(() => { result = null; resultKey = ''; paint(); feedback.set('Forecast expired.'); }, Math.max(0, 1800000 - (Date.now() - result.loadedAt)));
    };
    async function load(force = false) {
        if (!selected || !available() || controller || retryAt > Date.now()) return;
        const point = readLocation(), locationKey = key(point);
        if (resultKey !== locationKey || result && Date.now() - result.loadedAt >= 1800000) {
            const changedPoint = resultKey !== '' && resultKey !== locationKey;
            result = null; resultKey = ''; paint(changedPoint);
        }
        if (!force && result && Date.now() - result.loadedAt < 300000) { paint(); armExpiry(); feedback.set(''); return; }
        const owner = ++generation, request = new AbortController(); controller = request;
        panel.setAttribute('aria-busy', 'true'); refresh.setAttribute('aria-disabled', 'true');
        if (!result) summaryText.set('Regional air-quality forecast');
        feedback.set(result ? 'Refreshing…' : 'Loading…');
        try {
            const data = await client.request(point, { signal: request.signal, refresh: force });
            if (owner !== generation || !selected || !available()) return;
            result = data; resultKey = locationKey; paint(); armExpiry(); feedback.set('');
        } catch (error) {
            const failure = error as { name?: string; retryAt?: number };
            if (owner !== generation || failure?.name === 'AbortError') return;
            retryAt = Math.max(retryAt, failure?.retryAt || 0);
            if (!result) summaryText.set('Regional forecast unavailable');
            feedback.set(result ? 'Refresh failed.' : failure?.name === 'TimeoutError' ? 'Timed out.' : 'Could not load.');
            if (retryAt > Date.now()) feedback.set('Service busy.');
        } finally { if (owner === generation) { controller = null; panel.setAttribute('aria-busy', 'false'); refresh.setAttribute('aria-disabled', String(retryAt > Date.now())); } }
    }
    refresh.addEventListener('click', () => { void load(true); });
    list.addEventListener('click', event => {
        if (!result || !(event.target instanceof Element)) return;
        const cell = event.target.closest<HTMLElement>('[data-air-time]');
        const sample = displayed.find(item => item.time === Number(cell?.dataset.airTime));
        if (sample) selectHour(sample);
    });
    list.addEventListener('keydown', event => {
        if (!result || !displayed.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = Math.max(0, displayed.findIndex(sample => sample.time === selectedTime));
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? displayed.length - 1 : Math.max(0, Math.min(displayed.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
        selectHour(displayed[next], true);
    });
    return { panel,
        select(value: boolean) { selected = value; panel.hidden = !value; if (value) void load(); else stop(); },
        resume() { if (selected) void load(); },
        locationChanged() { stop(); result = null; resultKey = ''; feedback.set(''); reserveTimes(); paint(true); if (selected) void load(); },
        suspend: stop,
        dispose() { selected = false; stop(); client.clear(); },
    };
}
