// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { units } from '../ui/units.js';
import { settings } from '../settings/settings.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { createRetryCooldown } from '../ui/retry-cooldown.js';
import { mountainTime } from '../time/mountain-time.js';
import { createPeakHourlyChart } from './peak-weather-hourly.js';
import { weatherWeekWindow, summarizeWeatherWeek } from './weather-week.js';
import { createRecentWeatherClient } from './open-meteo-client.js';
import { readPeakWeatherSubject } from './peak-weather-subject.js';

const ID = 'bpb-peak-weather', element = dom.element;
const icons = { sun: '☀', cloud: '☁', partly: '⛅', rain: '☂', snow: '❄', fog: '≋', storm: 'ϟ', unknown: '—' };
const dateLabel = (date, options) => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { ...options, timeZone: 'UTC' });

export function mountPeakWeather() {
    if (document.getElementById(ID)) return;
    const subject = readPeakWeatherSubject(document, location.href);
    if (!subject) return;
    const zone = mountainTime.resolve(subject.latitude, subject.longitude);
    const card = element('section', { id: ID, 'aria-labelledby': `${ID}-heading`, 'aria-busy': 'false' });
    const refresh = element('button', { type: 'button', class: 'bpb-week-refresh', text: 'Refresh', 'aria-label': 'Refresh past week weather' });
    const range = element('p', { class: 'bpb-week-range' });
    const locationLabel = element('p', { class: 'bpb-week-sub' });
    const status = element('p', { class: 'bpb-week-status', role: 'status', 'aria-live': 'polite' });
    const days = element('div', { class: 'bpb-week-days' });
    const help = element('p', { class: 'bpb-week-help', hidden: '', text: 'Select a day for hourly weather. Rain/snow is water equivalent; wind is the daily maximum.' });
    const sourceText = element('p');
    const source = element('details', { class: 'bpb-week-source', hidden: '' }, [element('summary', { text: 'Source details' }), sourceText]);
    card.append(element('header', {}, [element('h2', { id: `${ID}-heading`, text: 'Past week weather' }), refresh]), range, locationLabel, status, days,
        help,
        source, element('footer', {}, [element('span', { text: 'Model estimates · Route conditions may differ' }),
            element('span', { class: 'bpb-week-attribution' }, [document.createTextNode('Powered by '), element('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo' })])]));
    const cell = element('td', { colspan: '2', class: 'bpb-week-cell' }, [card]);
    const row = element('tr', { id: `${ID}-row` }, [cell]);
    subject.table.tBodies[0].append(row);

    const client = createRecentWeatherClient();
    let preference = settings.DEFAULTS, current = null, controller = null, generation = 0, visibilityObserver = null, lifecycle;
    let started = false, pending = false, hourlyChart = null, activeDay = null, hourlyMetric = 'temperature';
    const cooldown = createRetryCooldown(blocked => { refresh.disabled = blocked || pending; });
    const unitSystem = () => units.resolveUnits(preference, () => {
        const heading = [...document.querySelectorAll('h2')].find(node => /^Elevation:/i.test(node.textContent.trim()));
        return /Elevation:\s*[\d,.]+\s*m\b/i.test(heading?.textContent || '') ? 'metric' : 'imperial';
    });
    const format = (value, kind) => {
        if (!Number.isFinite(value)) return '—';
        const imperial = unitSystem() === 'imperial';
        const number = kind === 'temperature' ? imperial ? value * 9 / 5 + 32 : value
            : kind === 'precipitation' ? imperial ? value / 25.4 : value : imperial ? value / 1.609344 : value;
        const suffix = kind === 'temperature' ? imperial ? '°F' : '°C' : kind === 'precipitation' ? imperial ? ' in' : ' mm' : imperial ? ' mph' : ' km/h';
        return `${number.toFixed(kind === 'precipitation' ? imperial ? 2 : 1 : 0)}${suffix}`.replaceAll('-', '−');
    };
    const renderLabels = week => {
        const first = week.days[0].date, last = week.days.at(-1).date;
        range.textContent = `${dateLabel(first, { month: 'short', day: 'numeric', ...(first.slice(0, 4) !== last.slice(0, 4) ? { year: 'numeric' } : {}) })} – ${dateLabel(last, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        locationLabel.textContent = `At the summit${subject.elevation === null ? '' : ` · ${units.formatElevation(subject.elevation, unitSystem())}`} · 7 completed days · Today excluded${zone.estimated ? ' · Estimated local time' : ''}`;
    };
    const clearChart = () => { hourlyChart?.dispose(); hourlyChart = null; activeDay = null; };
    const renderHours = (day, detail, container) => {
        if (activeDay === detail && hourlyChart) return;
        clearChart(); activeDay = detail;
        hourlyChart = createPeakHourlyChart({ container, day, samples: current.data.samples, zone, metric: hourlyMetric, format,
            onMetric: metric => { hourlyMetric = metric; } });
    };
    function renderResult() {
        if (!current) return;
        help.hidden = false; source.hidden = false;
        const openDate = days.querySelector('details[open]')?.dataset.date;
        renderLabels(current.window);
        clearChart();
        days.replaceChildren();
        for (const day of [...current.days].reverse()) {
            const date = day.window.date;
            const detail = element('details', { class: 'bpb-week-day', 'data-date': date });
            const summary = element('summary', {}, [
                element('span', { class: 'bpb-week-date' }, [element('strong', { text: dateLabel(date, { weekday: 'short' }) }), element('span', { text: dateLabel(date, { month: 'short', day: 'numeric' }) })]),
                element('span', { class: 'bpb-week-icon', 'aria-hidden': 'true', text: icons[day.condition.icon] }),
                element('span', { class: 'bpb-week-condition', text: day.condition.label }),
                element('span', { class: 'bpb-week-temp', title: 'Daily low / high', text: day.temperature.low === null ? '—' : `${format(day.temperature.low, 'temperature')} / ${format(day.temperature.high, 'temperature')}` }),
                element('span', { class: 'bpb-week-metrics', text: `Rain/snow ${format(day.precipitation.total, 'precipitation')}${day.precipitation.total !== null && !day.precipitation.complete ? ' (partial)' : ''} · Wind ${format(day.wind.high, 'wind')}` }),
                element('span', { class: 'bpb-week-chevron', 'aria-hidden': 'true', text: '⌄' }),
            ]);
            if (!day.useful || day.partial || (day.gust.high !== null && !day.gust.complete)) summary.append(element('span', { class: 'bpb-week-partial', text: day.useful ? 'Incomplete hours' : 'Data unavailable' }));
            const hourly = element('div', { class: 'bpb-week-hourly' });
            detail.append(summary, hourly);
            detail.addEventListener('toggle', () => {
                if (!detail.isConnected || lifecycle.state !== 'active') return;
                if (!detail.open) { if (activeDay === detail) clearChart(); return; }
                days.querySelectorAll('details[open]').forEach(other => { if (other !== detail) other.open = false; });
                renderHours(day, detail, hourly);
            });
            days.append(detail);
            if (date === openDate) { detail.open = true; renderHours(day, detail, hourly); }
        }
        sourceText.textContent = `Automatic regional model selection by Open-Meteo. Recent model estimates, not weather-station observations. Summit timezone: ${zone.timeZone || mountainTime.zoneLabel(zone, current.window.days[0].start)}${zone.estimated ? ' (longitude estimate)' : ''}. Daily conditions highlight the most severe condition in available hours. Rain/snow totals include rain, showers and snow water equivalent${current.days.some(day => day.precipitation.allocationEstimated) ? '; fractional-hour day boundaries are proportionally allocated' : ''}. ${subject.elevation === null ? 'Provider terrain elevation' : 'Summit elevation supplied for temperature downscaling'}: ${current.data.grid.elevation.toFixed(0)} m. Selected grid: ${current.data.grid.latitude.toFixed(4)}, ${current.data.grid.longitude.toFixed(4)}.`;
    }
    const cancel = () => { generation++; controller?.abort(); controller = null; pending = false; card.setAttribute('aria-busy', 'false'); refresh.disabled = cooldown.active(); };
    async function load({ clear = false } = {}) {
        if (lifecycle.state !== 'active' || pending) return;
        visibilityObserver?.disconnect(); visibilityObserver = null;
        started = true; pending = true;
        controller = new AbortController(); const owner = ++generation;
        card.setAttribute('aria-busy', 'true'); refresh.disabled = true;
        delete status.dataset.kind;
        status.textContent = current ? 'Refreshing weather…' : 'Loading past week weather…';
        try {
            const week = weatherWeekWindow(zone);
            if (!current) renderLabels(week);
            if (clear) client.clear();
            const data = await client.request(subject, week, { signal: controller.signal });
            if (owner !== generation || lifecycle.state !== 'active') return;
            const summaries = summarizeWeatherWeek(data, week);
            if (!summaries.some(day => day.useful)) throw new Error('Recent weather is unavailable for this summit.');
            current = { window: week, data, days: summaries };
            renderResult(); status.textContent = summaries.some(day => day.partial) ? 'Some days have incomplete hours.' : '';
        } catch (error) {
            if (owner !== generation || lifecycle.state !== 'active' || error.name === 'AbortError') return;
            if (error.code === 'rate-limit') { status.dataset.kind = 'rate-limit'; cooldown.set(error.retryAt); }
            status.textContent = `${error.message || 'Weather could not be loaded.'}${current ? ' Showing the previous result.' : ' Use Refresh to try again.'}`;
        } finally {
            if (owner === generation) { pending = false; controller = null; card.setAttribute('aria-busy', 'false'); cooldown.refresh(); }
        }
    }
    const beginWhenVisible = () => {
        visibilityObserver?.disconnect();
        if (typeof IntersectionObserver !== 'function') { void load(); return; }
        visibilityObserver = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { visibilityObserver.disconnect(); visibilityObserver = null; void load(); }
        }, { rootMargin: '200px' });
        visibilityObserver.observe(card);
    };
    const visibility = () => {
        if (document.visibilityState !== 'visible' || lifecycle.state !== 'active' || !started || pending) return;
        const today = mountainTime.localDate(zone, Date.now());
        if (!current || today !== mountainTime.localDate(zone, current.window.days.at(-1).end)) beginWhenVisible();
    };
    refresh.addEventListener('click', () => { void load({ clear: true }); });
    const unsubscribe = settings.subscribe(next => { preference = next; if (lifecycle.state === 'active') renderResult(); });
    settings.get().then(next => { preference = next; if (lifecycle.state === 'active') renderResult(); });
    const stop = () => { cooldown.suspend(); cancel(); clearChart(); visibilityObserver?.disconnect(); document.removeEventListener('visibilitychange', visibility); };
    lifecycle = createPageLifecycle({ onSuspend: stop,
        onResume: () => { cooldown.resume(); document.addEventListener('visibilitychange', visibility); renderResult(); beginWhenVisible(); },
        onDispose: () => { stop(); cooldown.dispose(); unsubscribe(); client.clear(); },
    });
    document.addEventListener('visibilitychange', visibility);
    beginWhenVisible();
    return { card, lifecycle };
}

mountPeakWeather();
