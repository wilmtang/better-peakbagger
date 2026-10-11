// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { units } from '../ui/units.js';
import { settings } from '../settings/settings.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { createRetryCooldown } from '../ui/retry-cooldown.js';
import { mountainTime } from '../time/mountain-time.js';
import { createPeakHourlyChart } from './peak-weather-hourly.js';
import { PEAK_FORECAST_DAYS, weatherPeakWindow, summarizeWeatherWeek } from './weather-week.js';
import { createPeakWeatherClient } from './open-meteo-client.js';
import { readPeakWeatherSubject } from './peak-weather-subject.js';

const ID = 'bpb-peak-weather', element = dom.element;
const icons = { sun: '☀', cloud: '☁', partly: '⛅', rain: '☂', snow: '❄', fog: '≋', storm: 'ϟ', unknown: '—' };
const dateLabel = (date, options) => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { ...options, timeZone: 'UTC' });

export function mountPeakWeather() {
    if (document.getElementById(ID)) return;
    const subject = readPeakWeatherSubject(document, location.href);
    if (!subject) return;
    const zone = mountainTime.resolve(subject.latitude, subject.longitude);
    const card = element('section', { id: ID, hidden: '', 'aria-labelledby': `${ID}-heading`, 'aria-busy': 'false' });
    const refresh = element('button', { type: 'button', class: 'bpb-week-refresh', text: 'Refresh', 'aria-label': 'Refresh summit weather' });
    const periods = [['forecast', `${PEAK_FORECAST_DAYS}-day forecast`], ['past', `Past ${PEAK_FORECAST_DAYS} days`]];
    const periodTabs = element('div', { class: 'bpb-week-periods', role: 'tablist', 'aria-label': 'Weather period' });
    const periodButtons = periods.map(([key, text]) => element('button', { type: 'button', role: 'tab', text,
        id: `${ID}-${key}`, 'data-period': key, 'aria-controls': `${ID}-period` }));
    periodTabs.append(...periodButtons);
    const range = element('p', { class: 'bpb-week-range' });
    const locationLabel = element('p', { class: 'bpb-week-sub' });
    const accuracy = element('p', { class: 'bpb-week-accuracy', text: 'Forecasts may be inaccurate, especially farther ahead or at mountain summits. Check local mountain forecasts before your climb.' });
    const status = element('p', { class: 'bpb-week-status', role: 'status', 'aria-live': 'polite' });
    const days = element('div', { class: 'bpb-week-days' });
    const help = element('p', { class: 'bpb-week-help', hidden: '', text: 'Select a day for hourly weather. Rain/snow is water equivalent; wind is the daily maximum.' });
    const sourceText = element('p');
    const modelText = element('p', { class: 'bpb-week-models', text: 'Open-Meteo Best Match selects models automatically. US coverage may use NOAA HRRR for short-range forecasts and NOAA GFS farther ahead, with DWD ICON as a fallback. Elsewhere, ECMWF IFS and regional models may be used. The mix varies by location, weather variable and forecast hour; the API does not identify the model behind each value.' });
    const source = element('details', { class: 'bpb-week-source', hidden: '' }, [element('summary', { text: 'Models & source details' }), modelText, sourceText]);
    const periodPanel = element('div', { id: `${ID}-period`, role: 'tabpanel' }, [range, locationLabel, accuracy, days, help]);
    card.append(element('header', {}, [element('h2', { id: `${ID}-heading`, text: 'Summit weather' }), refresh]), periodTabs, status, periodPanel,
        source, element('footer', {}, [element('span', { text: 'Estimates may be inaccurate · Route conditions may differ' }),
            element('span', { class: 'bpb-week-attribution' }, [document.createTextNode('Powered by '), element('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo' })])]));
    const cell = element('td', { colspan: '2', class: 'bpb-week-cell' }, [card]);
    const row = element('tr', { id: `${ID}-row`, hidden: '' }, [cell]);
    subject.table.tBodies[0].append(row);

    const client = createPeakWeatherClient();
    let preference = settings.DEFAULTS, current = null, controller = null, generation = 0, visibilityObserver = null, lifecycle;
    let settingsReady = false;
    const enabled = () => settingsReady && preference.showWeather;
    let started = false, pending = false, hourlyChart = null, activeDay = null, hourlyMetric = 'temperature';
    let period = 'forecast', notice = null, requestedWindow = null;
    const openDates = new Map();
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
        const interval = period === 'past' ? `${week.days.length} completed days · Today excluded`
            : week.days[0].date === mountainTime.localDate(zone, Date.now()) ? `Today + ${PEAK_FORECAST_DAYS - 1} days` : `${PEAK_FORECAST_DAYS}-day forecast · Previous dates`;
        locationLabel.textContent = `At the summit${subject.elevation === null ? '' : ` · ${units.formatElevation(subject.elevation, unitSystem())}`} · ${interval}${zone.estimated ? ' · Estimated local time' : ''}`;
    };
    const paintStatus = () => {
        const summaries = current?.days[period];
        status.textContent = notice?.text || (summaries && !summaries.some(day => day.useful)
            ? `${period === 'forecast' ? 'Forecast' : 'Past weather'} is unavailable for this summit. Try the other weather period.`
            : summaries?.some(day => day.partial) ? 'Some days have incomplete hours.' : '');
        if (notice?.kind === 'rate-limit') status.dataset.kind = 'rate-limit';
        else delete status.dataset.kind;
    };
    const clearChart = () => { hourlyChart?.dispose(); hourlyChart = null; activeDay = null; };
    const renderHours = (day, detail, container) => {
        if (activeDay === detail && hourlyChart) return;
        clearChart(); activeDay = detail;
        hourlyChart = createPeakHourlyChart({ container, day, samples: current.data.samples, zone, metric: hourlyMetric, format,
            onMetric: metric => { hourlyMetric = metric; } });
    };
    function renderResult(openDate = days.querySelector('details[open]')?.dataset.date) {
        if (!current) return;
        const summaries = current.days[period], forecast = period === 'forecast';
        help.hidden = !summaries.some(day => day.useful); source.hidden = false;
        help.textContent = `Select a day for hourly ${forecast ? 'forecast' : 'weather'}. Rain/snow is water equivalent; wind is the daily maximum.`;
        renderLabels(current.window[period]);
        clearChart();
        days.replaceChildren();
        for (const day of help.hidden ? [] : forecast ? summaries : [...summaries].reverse()) {
            const date = day.window.date;
            const detail = element('details', { class: 'bpb-week-day', 'data-date': date });
            const summary = element('summary', {}, [
                element('span', { class: 'bpb-week-date' }, [element('strong', { text: forecast && date === mountainTime.localDate(zone, Date.now()) ? 'Today' : dateLabel(date, { weekday: 'short' }) }), element('span', { text: dateLabel(date, { month: 'short', day: 'numeric' }) })]),
                element('span', { class: 'bpb-week-icon', 'aria-hidden': 'true', text: icons[day.condition.icon] }),
                element('span', { class: 'bpb-week-condition', text: forecast ? day.condition.label.replace('occurred', 'expected') : day.condition.label }),
                element('span', { class: 'bpb-week-temp', title: 'Daily low / high', text: day.temperature.low === null ? '—' : `${format(day.temperature.low, 'temperature')} / ${format(day.temperature.high, 'temperature')}` }),
                element('span', { class: 'bpb-week-metrics', text: `Rain/snow ${format(day.precipitation.total, 'precipitation')}${day.precipitation.total !== null && !day.precipitation.complete ? ' (partial)' : ''} · Wind ${format(day.wind.high, 'wind')}` }),
                element('span', { class: 'bpb-week-chevron', 'aria-hidden': 'true', text: '⌄' }),
            ]);
            if (!day.useful || day.partial || (day.gust.high !== null && !day.gust.complete)) summary.append(element('span', { class: 'bpb-week-partial', text: day.useful ? 'Incomplete hours' : 'Data unavailable' }));
            const hourly = element('div', { class: 'bpb-week-hourly' });
            detail.append(summary, hourly);
            detail.addEventListener('toggle', () => {
                if (!enabled() || !detail.isConnected || lifecycle.state !== 'active') return;
                if (!detail.open) { if (activeDay === detail) clearChart(); return; }
                days.querySelectorAll('details[open]').forEach(other => { if (other !== detail) other.open = false; });
                renderHours(day, detail, hourly);
            });
            days.append(detail);
            if (date === openDate) { detail.open = true; renderHours(day, detail, hourly); }
        }
        const loaded = `${mountainTime.localDate(zone, current.loadedAt)} ${mountainTime.formatClock(zone, current.loadedAt)} ${mountainTime.zoneLabel(zone, current.loadedAt)}`;
        sourceText.textContent = `${forecast ? `Up to ${PEAK_FORECAST_DAYS} days of forecast model estimates; today includes the whole local day. The final day may have incomplete hours where the forecast ends.` : 'Recent model estimates, not weather-station observations.'} Loaded ${loaded}. Summit timezone: ${zone.timeZone || mountainTime.zoneLabel(zone, current.window[period].days[0].start)}${zone.estimated ? ' (longitude estimate)' : ''}. Daily conditions highlight the most severe condition in available hours. Rain/snow totals include rain, showers and snow water equivalent${summaries.some(day => day.precipitation.allocationEstimated) ? '; fractional-hour day boundaries are proportionally allocated' : ''}. ${subject.elevation === null ? 'Provider terrain elevation' : 'Temperature adjusted for summit elevation'}: ${current.data.grid.elevation.toFixed(0)} m. Selected grid: ${current.data.grid.latitude.toFixed(4)}, ${current.data.grid.longitude.toFixed(4)}.`;
        paintStatus();
    }
    const choosePeriod = next => {
        if (next !== period) {
            openDates.set(period, days.querySelector('details[open]')?.dataset.date);
            period = next;
            if (current) renderResult(openDates.get(period) || null);
            else if (requestedWindow) renderLabels(requestedWindow[period]);
        }
        for (const button of periodButtons) {
            const active = button.dataset.period === period;
            button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
        }
        periodPanel.setAttribute('aria-labelledby', `${ID}-${period}`);
        accuracy.hidden = period !== 'forecast';
    };
    periodButtons.forEach(button => button.addEventListener('click', () => choosePeriod(button.dataset.period)));
    periodTabs.addEventListener('keydown', event => {
        const index = periodButtons.indexOf(event.target);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? periodButtons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + periodButtons.length) % periodButtons.length;
        choosePeriod(periodButtons[next].dataset.period); periodButtons[next].focus();
    });
    choosePeriod(period);
    const cancel = () => { generation++; controller?.abort(); controller = null; pending = false; card.setAttribute('aria-busy', 'false'); refresh.disabled = cooldown.active(); };
    async function load({ clear = false } = {}) {
        if (!enabled() || lifecycle.state !== 'active' || pending) return;
        visibilityObserver?.disconnect(); visibilityObserver = null;
        started = true; pending = true;
        controller = new AbortController(); const owner = ++generation;
        card.setAttribute('aria-busy', 'true'); refresh.disabled = true;
        notice = { text: current ? 'Refreshing summit weather…' : 'Loading summit weather…' }; paintStatus();
        try {
            const window = weatherPeakWindow(zone); requestedWindow = window;
            if (!current) renderLabels(window[period]);
            if (clear) client.clear();
            const data = await client.request(subject, window, { signal: controller.signal });
            if (owner !== generation || lifecycle.state !== 'active') return;
            const summaries = { past: summarizeWeatherWeek(data, window.past), forecast: summarizeWeatherWeek(data, window.forecast) };
            if (!Object.values(summaries).some(list => list.some(day => day.useful))) throw new Error('Weather is unavailable for this summit.');
            current = { window, data, days: summaries, loadedAt: Date.now() }; notice = null;
            renderResult();
        } catch (error) {
            if (owner !== generation || lifecycle.state !== 'active' || error.name === 'AbortError') return;
            if (error.code === 'rate-limit') cooldown.set(error.retryAt);
            notice = { kind: error.code, text: `${error.message || 'Weather could not be loaded.'}${current ? ' Showing the previous result.' : ' Use Refresh to try again.'}` }; paintStatus();
        } finally {
            if (owner === generation) { pending = false; controller = null; card.setAttribute('aria-busy', 'false'); cooldown.refresh(); }
        }
    }
    const beginWhenVisible = () => {
        visibilityObserver?.disconnect();
        if (!enabled() || lifecycle.state !== 'active') return;
        if (typeof IntersectionObserver !== 'function') { void load(); return; }
        visibilityObserver = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { visibilityObserver?.disconnect(); visibilityObserver = null; void load(); }
        }, { rootMargin: '200px' });
        visibilityObserver.observe(card);
    };
    const visibility = () => {
        if (!enabled() || document.visibilityState !== 'visible' || lifecycle.state !== 'active' || !started || pending || notice?.kind) return;
        const today = mountainTime.localDate(zone, Date.now());
        if (!current || today !== current.window.today || Date.now() - current.loadedAt >= 5 * 60_000) beginWhenVisible();
    };
    refresh.addEventListener('click', () => { void load({ clear: true }); });
    const applyPreference = next => {
        const wasEnabled = enabled();
        preference = next; settingsReady = true;
        row.hidden = card.hidden = !enabled();
        if (!enabled()) {
            cooldown.suspend(); cancel(); clearChart();
            visibilityObserver?.disconnect(); visibilityObserver = null;
        } else if (lifecycle.state === 'active') {
            cooldown.resume(); renderResult();
            if (!wasEnabled) beginWhenVisible();
        }
    };
    const unsubscribe = settings.subscribe(applyPreference);
    const stop = () => { cooldown.suspend(); cancel(); clearChart(); visibilityObserver?.disconnect(); document.removeEventListener('visibilitychange', visibility); };
    lifecycle = createPageLifecycle({ onSuspend: stop,
        onResume: () => { document.addEventListener('visibilitychange', visibility); if (enabled()) { cooldown.resume(); renderResult(); beginWhenVisible(); } },
        onDispose: () => { stop(); cooldown.dispose(); unsubscribe(); client.clear(); },
    });
    document.addEventListener('visibilitychange', visibility);
    // A newer sync notification owns the preference if startup's read is late.
    settings.requireCurrent().then(next => { if (!settingsReady && lifecycle.state !== 'disposed') applyPreference(next); }).catch(() => {});
    return { card, lifecycle };
}

mountPeakWeather();
