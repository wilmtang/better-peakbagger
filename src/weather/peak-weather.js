// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { createStableText } from '../ui/stable-text.js';
import { units } from '../ui/units.js';
import { settings } from '../settings/settings.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { createRetryCooldown } from '../ui/retry-cooldown.js';
import { mountainTime } from '../time/mountain-time.js';
import { createPeakHourlyChart, resolvePeakHourlyMetric } from './peak-weather-hourly.js';
import { PEAK_FORECAST_DAYS, weatherPeakWindow, summarizeWeatherWeek } from './weather-week.js';
import { createPeakWeatherClient } from './open-meteo-client.js';
import { readPeakWeatherSubject } from './peak-weather-subject.js';
import { PEAK_BEST_MATCH, eligiblePeakWeatherModels, resolvePeakWeatherModels, peakModelHorizon } from './peak-weather-models.js';
import { createPeakModelUpdateClient, peakModelUpdateDomains } from './peak-weather-updates.js';
import { createWeatherIcon } from './weather-icon.js';
import { createWeatherLocationMenu, weatherLocationLabel } from './peak-weather-location.js';

const ID = 'bpb-peak-weather', element = dom.element;
const modelKeys = { past: 'bpbPeakWeatherModelPast', forecast: 'bpbPeakWeatherModelForecast' };
const hourlyMetricKey = 'bpbPeakWeatherHourlyMetric';
const dateLabel = (date, options) => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { ...options, timeZone: 'UTC' });
const updateIntervalLabel = seconds => {
    if (seconds % 86400 === 0) {
        const days = seconds / 86400;
        return `Every ${days} ${days === 1 ? 'day' : 'days'}`;
    }
    if (seconds % 3600 === 0) return `Every ${seconds / 3600} h`;
    if (seconds % 60 === 0) return `Every ${seconds / 60} min`;
    return `Every ${seconds} s`;
};

export function mountPeakWeather() {
    if (document.getElementById(ID)) return;
    let subject = readPeakWeatherSubject(document, location.href);
    if (!subject) return;
    const summit = subject;
    let requestedSubject = summit, summitResult = null;
    let zone = mountainTime.resolve(subject.latitude, subject.longitude);
    const card = element('section', { id: ID, hidden: '', 'aria-labelledby': `${ID}-heading`, 'aria-busy': 'false' });
    const refresh = element('button', { type: 'button', class: 'bpb-week-refresh', 'data-label': 'Refresh', 'aria-label': 'Refresh summit weather' },
        [element('span', { text: 'Refresh' })]);
    const selectedLocation = element('span', { class: 'bpb-week-location-name', role: 'status', 'aria-label': 'Weather location', 'aria-live': 'polite', 'aria-atomic': 'true', text: 'At the summit' });
    const mapHint = element('span', { class: 'bpb-week-map-hint', text: 'Right-click the map for weather at any point.' });
    mapHint.hidden = !document.querySelector('iframe#Gmap');
    const resetLocation = element('button', { type: 'button', class: 'bpb-week-location-reset', text: 'Reset to summit', disabled: '' });
    const periods = [['forecast', `${PEAK_FORECAST_DAYS}-day forecast`], ['past', `Past ${PEAK_FORECAST_DAYS} days`]];
    const periodTabs = element('div', { class: 'bpb-week-periods', role: 'tablist', 'aria-label': 'Weather period' });
    const periodButtons = periods.map(([key, text]) => element('button', { type: 'button', role: 'tab', 'aria-label': text, 'data-label': text,
        id: `${ID}-${key}`, 'data-period': key, 'aria-controls': `${ID}-period` }, [element('span', { class: 'bpb-week-tab-label', text })]));
    periodTabs.append(...periodButtons);
    const range = element('p', { class: 'bpb-week-range' });
    const locationLabel = element('p', { class: 'bpb-week-sub' });
    const accuracy = element('p', { class: 'bpb-week-accuracy', text: 'Forecasts may be inaccurate farther ahead and at mountain summits. Check a local mountain forecast before your climb.' });
    const status = element('p', { id: `${ID}-status`, class: 'bpb-week-status', role: 'status', 'aria-live': 'polite' });
    const statusText = createStableText(status);
    const days = element('div', { class: 'bpb-week-days' });
    const help = element('p', { class: 'bpb-week-help', hidden: '', text: 'Select a day for hourly weather. Rain/snow is water equivalent; wind is the daily maximum.' });
    const sourceText = element('p', { class: 'bpb-week-models' });
    const sourceLocation = element('p', { class: 'bpb-week-source-location' });
    const select = element('select', { id: `${ID}-model` });
    const modelControl = element('div', { class: 'bpb-week-model-control' }, [element('label', { for: select.id, text: 'Weather model' }), select]);
    const updatesBody = element('tbody');
    const updates = element('div', { class: 'bpb-week-updates', tabindex: '0', role: 'region', 'aria-label': 'Model update times' }, [
        element('table', { class: 'bpb-week-updates-table' }, [element('caption', { text: 'Model updates' }),
            element('thead', {}, [element('tr', {}, ['Model', 'Last update', 'Next expected', 'Update interval'].map(text => element('th', { scope: 'col', text })))]), updatesBody]),
    ]);
    const updatesNote = element('p', { class: 'bpb-week-updates-note', text: 'Summit local time. Next updates are estimates. Provider-wide availability may vary between servers.' });
    const source = element('details', { class: 'bpb-week-source', hidden: '' }, [element('summary', { text: 'Source details' }), sourceLocation, sourceText, updates, updatesNote]);
    const overview = element('div', { class: 'bpb-week-overview' }, [element('div', {}, [range, locationLabel]), modelControl]);
    const periodPanel = element('div', { id: `${ID}-period`, role: 'tabpanel' }, [overview, status, accuracy, days, help]);
    const headingText = document.createTextNode('Summit weather');
    card.append(element('header', {}, [
        element('div', { class: 'bpb-week-heading' }, [element('h2', { id: `${ID}-heading` }, [createWeatherIcon('partly'), headingText]), selectedLocation, mapHint]),
        element('div', { class: 'bpb-week-actions' }, [resetLocation, refresh]),
    ]), periodTabs, periodPanel,
    source, element('footer', {}, [element('span', { text: 'Estimates may be inaccurate · Route conditions may differ' }),
        element('span', { class: 'bpb-week-attribution' }, [document.createTextNode('Powered by '), element('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo' })])]));
    const cell = element('td', { colspan: '2', class: 'bpb-week-cell' }, [card]);
    const row = element('tr', { id: `${ID}-row`, hidden: '' }, [cell]);
    const mapRow = document.getElementById('Gmap')?.closest('tr');
    if (mapRow?.closest('table') === subject.table) mapRow.after(row);
    else subject.table.tBodies[0].append(row);

    const client = createPeakWeatherClient();
    const updateClient = createPeakModelUpdateClient();
    let updatesController = null, updatesGeneration = 0;
    let preference = settings.DEFAULTS, current = null, controller = null, generation = 0, visibilityObserver = null, lifecycle;
    let settingsReady = false, modelsReady = false, locationMenu = null;
    const enabled = () => settingsReady && modelsReady && preference.showWeather;
    const cancelUpdates = () => { updatesGeneration++; updatesController?.abort(); updatesController = null; };
    async function loadUpdates() {
        if (!enabled() || lifecycle.state !== 'active' || !source.open || !current) return;
        cancelUpdates();
        const updateController = new AbortController(); updatesController = updateController;
        const owner = updatesGeneration;
        // Keep update clocks tied to the displayed weather, including when
        // a failed model change retains the previous result.
        const models = [current.models[period]];
        const targets = new Map();
        updatesBody.replaceChildren();
        for (const model of models) {
            const domains = peakModelUpdateDomains(model);
            for (const domain of domains.length ? domains : [null]) {
                const label = model.id === 'gfs_global' ? `${model.label} · ${domain === 'ncep_gfs013' ? '13' : '25'} km` : model.label;
                const unavailable = model === PEAK_BEST_MATCH ? 'Varies by model' : 'Unavailable';
                const last = element('td', { text: domain ? 'Loading…' : unavailable }), next = element('td', { text: domain ? 'Loading…' : unavailable }), interval = element('td', { text: domain ? 'Loading…' : unavailable });
                updatesBody.append(element('tr', { 'data-update-model': model.id }, [element('th', { scope: 'row', text: label }), last, next, interval]));
                if (domain) targets.set(domain, [...(targets.get(domain) || []), { last, next, interval }]);
            }
        }
        const queue = [...targets.keys()];
        const label = time => `${dateLabel(mountainTime.localDate(zone, time), { month: 'short', day: 'numeric' })} ${mountainTime.formatClock(zone, time)} ${mountainTime.zoneLabel(zone, time)}`;
        // Fetch only when the disclosure is open, with at most three metadata
        // requests in flight. A failure never replaces usable weather data.
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
            while (queue.length && !updateController.signal.aborted) {
                const domain = queue.shift();
                let result;
                try { result = await updateClient.request(domain, { signal: updateController.signal }); }
                catch { return; }
                if (owner !== updatesGeneration || updateController.signal.aborted) return;
                for (const { last, next, interval } of targets.get(domain)) {
                    last.textContent = result.data ? label(result.data.lastUpdate) : 'Unavailable';
                    next.textContent = result.data ? `${label(result.data.nextExpected)}${result.data.nextExpected < Date.now() ? ' (delayed)' : ''}` : 'Unavailable';
                    interval.textContent = result.data ? updateIntervalLabel(result.data.updateIntervalSeconds) : 'Unavailable';
                    if (result.data) last.title = `Model initialized ${label(result.data.run)}`;
                }
            }
        }));
        if (owner === updatesGeneration) updatesController = null;
    }
    source.addEventListener('toggle', () => { if (source.open) void loadUpdates(); else cancelUpdates(); });
    let started = false, pending = false, hourlyChart = null, activeDay = null, hourlyMetric = 'code';
    let period = 'forecast', notice = null, requestedWindow = null;
    const choices = { past: 'gfs_global', forecast: 'gfs_global' };
    let summitChoices = null;
    const openDates = new Map();
    const cooldown = createRetryCooldown(blocked => { refresh.disabled = blocked || pending; select.disabled = blocked; locationMenu?.updateAvailability(); });
    const populateModels = () => {
        const window = requestedWindow || weatherPeakWindow(zone);
        const models = eligiblePeakWeatherModels(requestedSubject, window, period);
        // Size the existing feedback row for loading copy before a model is
        // chosen. Errors can still wrap and grow; neither gets clipped.
        statusText.reserve(['Refreshing summit weather…', 'Refreshing location weather…',
            ...models.map(model => `Updating… Showing ${model.label} · ${model.resolution}.`)]);
        select.replaceChildren(...models.map(model => element('option', { value: model.id,
            text: `${model === PEAK_BEST_MATCH ? 'Best Match (Open-Meteo)' : `${model.label} · ${model.resolution}`}${period === 'forecast' ? ` · up to ${peakModelHorizon(model)}` : ''}` })));
        // Keep a now-ineligible selection visible so a date rollover cannot
        // silently turn an explicit choice into GFS.
        if (![...select.options].some(option => option.value === choices[period])) select.append(element('option', {
            value: choices[period], text: 'Selected model — date range unavailable', disabled: '',
        }));
        select.value = choices[period];
    };
    const unitSystem = (measurement = 'elevation') => units.resolveUnits(preference, () => {
        const heading = [...document.querySelectorAll('h2')].find(node => /^Elevation:/i.test(node.textContent.trim()));
        return /Elevation:\s*[\d,.]+\s*m\b/i.test(heading?.textContent || '') ? 'metric' : 'imperial';
    }, measurement);
    const format = (value, kind) => units.formatWeather(value, kind, unitSystem(kind));
    const unitSignature = () => ['elevation', 'temperature', 'precipitation', 'wind'].map(unitSystem).join('/');
    const renderLabels = week => {
        const first = week.days[0].date, last = week.days.at(-1).date;
        range.textContent = `${dateLabel(first, { month: 'short', day: 'numeric', ...(first.slice(0, 4) !== last.slice(0, 4) ? { year: 'numeric' } : {}) })} – ${dateLabel(last, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        const interval = period === 'past' ? `${week.days.length} completed days · Today excluded`
            : week.days[0].date === mountainTime.localDate(zone, Date.now()) ? week.days.length === 1 ? 'Today' : `Today + ${week.days.length - 1} ${week.days.length === 2 ? 'day' : 'days'}` : `${week.days.length}-day forecast · Previous dates`;
        const atSummit = subject === summit;
        headingText.textContent = atSummit ? 'Summit weather' : 'Location weather';
        selectedLocation.textContent = atSummit ? 'At the summit' : weatherLocationLabel(subject);
        selectedLocation.title = atSummit ? summit.name : `Selected map location: ${weatherLocationLabel(subject)}`;
        updatesNote.textContent = `${atSummit ? 'Summit' : 'Selected location'} local time. Next updates are estimates. Provider-wide availability may vary between servers.`;
        locationLabel.textContent = `${subject.elevation === null ? 'Terrain elevation' : units.formatElevation(subject.elevation, unitSystem())} · ${interval}${zone.estimated ? ' · Estimated local time' : ''}`;
    };
    const updateLocationControls = () => {
        resetLocation.disabled = requestedSubject === summit && (pending || subject === summit);
        const retry = notice?.kind && requestedSubject !== subject;
        refresh.firstElementChild.textContent = retry ? 'Retry' : 'Refresh';
        refresh.setAttribute('aria-label', `${retry ? 'Retry' : 'Refresh'} ${requestedSubject === summit ? 'summit weather' : `weather for ${weatherLocationLabel(requestedSubject)}`}`);
    };
    const paintStatus = () => {
        updateLocationControls();
        const summaries = current?.days[period];
        const partialCount = summaries?.filter(day => day.partial).length || 0;
        const message = notice?.text || (summaries && !summaries.some(day => day.useful)
            ? `${period === 'forecast' ? 'Forecast' : 'Past weather'} is unavailable for this ${subject === summit ? 'summit' : 'location'}. Try the other weather period.`
            : partialCount ? `${partialCount} ${partialCount === 1 ? 'day has' : 'days have'} incomplete hours.` : '');
        const model = current?.models[period], changedModel = model && model.id !== select.value;
        const retained = model && (changedModel || (notice && !pending));
        const showing = retained ? `Showing ${model.label} · ${model.resolution}.` : '';
        const feedback = pending && changedModel && requestedSubject === subject
            ? `Updating… ${showing}` : `${message}${showing ? ` ${showing}` : ''}`.trim();
        statusText.set(feedback);
        if (feedback) select.setAttribute('aria-describedby', status.id);
        else select.removeAttribute('aria-describedby');
        if (notice?.kind === 'rate-limit') status.dataset.kind = 'rate-limit';
        else delete status.dataset.kind;
    };
    const clearChart = () => { hourlyChart?.dispose(); hourlyChart = null; activeDay = null; };
    const renderHours = (day, detail, container, state) => {
        if (activeDay === detail && hourlyChart) return;
        clearChart(); activeDay = detail;
        hourlyChart = createPeakHourlyChart({ container, day, samples: current.data[period].samples, zone, metric: hourlyMetric, format,
            onMetric: metric => {
                hourlyMetric = metric;
                // Persist explicit choices only; mounting or redrawing a day
                // must not overwrite a newer choice from another open page.
                try { void chrome.storage.local.set({ [hourlyMetricKey]: metric }).catch(() => {}); } catch { /* Storage failure keeps the tabs usable. */ }
            }, state });
    };
    function renderResult(openDate = days.querySelector('details[open]')?.dataset.date) {
        if (!current) return;
        const focused = days.contains(document.activeElement) ? document.activeElement : null;
        const focusedDate = focused?.closest('details')?.dataset.date;
        const focusSelector = focused?.matches('summary') ? 'summary' : focused?.matches('.bpb-week-chart') ? '.bpb-week-chart'
            : focused?.matches('.bpb-week-conditions') ? '.bpb-week-conditions' : focused?.dataset.metric ? `[data-metric="${focused.dataset.metric}"]` : null;
        const stateDate = activeDay?.dataset.date, chartState = hourlyChart?.snapshot();
        const summaries = current.days[period], forecast = period === 'forecast';
        const model = current.models[period], data = current.data[period];
        const forecastLabel = `${current.window.forecast.days.length}-day forecast`;
        (periodButtons[0].querySelector('.bpb-week-tab-label') || periodButtons[0]).textContent = forecastLabel;
        periodButtons[0].setAttribute('aria-label', forecastLabel); periodButtons[0].dataset.label = forecastLabel;
        const modelDetails = model === PEAK_BEST_MATCH
            ? 'Best Match. Open-Meteo automatic blend; source models vary.'
            : `${model.label}, ${model.resolution}.`;
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
                createWeatherIcon(day.condition.icon, { className: 'bpb-week-icon' }),
                element('span', { class: 'bpb-week-condition', text: forecast ? day.condition.label.replace('occurred', 'expected') : day.condition.label }),
                element('span', { class: 'bpb-week-temp' }, [
                    element('span', { class: 'bpb-week-low', text: `Low ${format(day.temperature.low, 'temperature')}` }),
                    document.createTextNode(' '), element('span', { class: 'bpb-week-high', text: `High ${format(day.temperature.high, 'temperature')}` }),
                ]),
                element('span', { class: 'bpb-week-metrics', text: `Rain/snow ${format(day.precipitation.total, 'precipitation')}${day.precipitation.total !== null && !day.precipitation.complete ? ' (partial)' : ''} · Max wind ${format(day.wind.high, 'wind')}` }),
                element('span', { class: 'bpb-week-chevron', 'aria-hidden': 'true', text: '⌄' }),
            ]);
            if (!day.useful || day.partial || (day.gust.high !== null && !day.gust.complete)) summary.append(element('span', { class: 'bpb-week-partial', text: day.useful ? 'Incomplete hours' : 'Data unavailable' }));
            const hourly = element('div', { class: 'bpb-week-hourly' });
            detail.append(summary, hourly);
            // Native toggle is asynchronous: opening first paints an empty
            // panel beside the old one. Handle native summary activation's
            // click (including Enter/Space) as a single update instead.
            summary.addEventListener('click', event => {
                if (!enabled() || lifecycle.state !== 'active' || event.button > 0) return;
                event.preventDefault();
                const opening = !detail.open;
                const top = summary.getBoundingClientRect().top;
                clearChart();
                days.querySelectorAll('details[open]').forEach(other => { other.open = false; });
                detail.open = opening;
                if (opening) renderHours(day, detail, hourly);
                summary.focus({ preventScroll: true });
                // Keep the heading under the pointer. Revealing the entire
                // hourly panel forcibly scrolled the page on every activation.
                const displacement = summary.getBoundingClientRect().top - top;
                if (Math.abs(displacement) > 1) window.scrollBy({ top: displacement, behavior: 'instant' });
            });
            detail.addEventListener('toggle', () => {
                if (!enabled() || !detail.isConnected || lifecycle.state !== 'active') return;
                if (!detail.open) { if (activeDay === detail) clearChart(); return; }
                if (activeDay === detail) return;
                days.querySelectorAll('details[open]').forEach(other => { if (other !== detail) other.open = false; });
                renderHours(day, detail, hourly);
            });
            days.append(detail);
            if (date === openDate) { detail.open = true; renderHours(day, detail, hourly, date === stateDate ? chartState : undefined); }
        }
        if (focused && focusSelector) {
            const target = [...days.children].find(day => day.dataset.date === focusedDate)?.querySelector(focusSelector);
            (target || periodButtons.find(button => button.dataset.period === period)).focus({ preventScroll: true });
        }
        const loaded = `${mountainTime.localDate(zone, current.loadedAt)} ${mountainTime.formatClock(zone, current.loadedAt)} ${mountainTime.zoneLabel(zone, current.loadedAt)}`;
        sourceLocation.textContent = `${subject === summit ? 'Summit' : 'Selected location'}: ${weatherLocationLabel(subject)}. Weather grid point: ${weatherLocationLabel(data.grid)}. Weather is calculated on a grid, so this point can differ from your location.${current.sharedGrid ? ' Model grids may differ.' : ''}`;
        sourceText.textContent = `${modelDetails} ${forecast ? 'Hourly forecast estimates.' : 'Model estimates, not station observations.'} ${subject === summit ? 'Summit' : 'Selected location'} timezone: ${zone.timeZone || mountainTime.zoneLabel(zone, current.window[period].days[0].start)}${zone.estimated ? ' (longitude estimate)' : ''}. ${subject.elevation === null ? 'Terrain elevation' : 'Temperature adjusted to'} ${data.grid.elevation.toFixed(0)} m. Loaded ${loaded}.${summaries.some(day => day.precipitation.allocationEstimated) ? ' Partial-hour rain/snow totals are estimated.' : ''}`;
        paintStatus();
        if (source.open) void loadUpdates();
    }
    const choosePeriod = next => {
        if (next !== period) {
            openDates.set(period, days.querySelector('details[open]')?.dataset.date);
            period = next;
            populateModels();
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
    populateModels();
    const cancel = () => { generation++; controller?.abort(); controller = null; pending = false; card.setAttribute('aria-busy', 'false'); refresh.disabled = cooldown.active(); };
    async function load({ clear = false } = {}) {
        if (!enabled() || lifecycle.state !== 'active' || pending || cooldown.active()) return;
        visibilityObserver?.disconnect(); visibilityObserver = null;
        started = true; pending = true;
        controller = new AbortController(); const owner = ++generation;
        card.setAttribute('aria-busy', 'true'); refresh.disabled = true;
        const target = requestedSubject, targetZone = mountainTime.resolve(target.latitude, target.longitude);
        const changingLocation = target !== subject;
        notice = { text: changingLocation ? `Loading ${target === summit ? 'summit weather' : weatherLocationLabel(target)}…`
            : current ? `Refreshing ${target === summit ? 'summit' : 'location'} weather…` : 'Loading summit weather…' }; paintStatus();
        try {
            const window = weatherPeakWindow(targetZone); requestedWindow = window;
            populateModels();
            if (!current) { subject = target; zone = targetZone; renderLabels(window[period]); }
            if (clear) { client.clear(); cancelUpdates(); updateClient.clear(); }
            const models = resolvePeakWeatherModels(target, window, choices);
            const response = await client.request(target, window, [...new Set(Object.values(models))], { signal: controller.signal });
            if (owner !== generation || lifecycle.state !== 'active') return;
            // Short-range choices must not display sixteen empty future days.
            // Retain full-day expectations through their last useful day so
            // unavailable boundary hours remain labelled as incomplete.
            const data = { past: response.models[models.past.id], forecast: response.models[models.forecast.id] };
            const summaries = { past: summarizeWeatherWeek(data.past, window.past), forecast: summarizeWeatherWeek(data.forecast, window.forecast) };
            if (models.forecast.forecastDays < PEAK_FORECAST_DAYS) {
                const lastUseful = summaries.forecast.findLastIndex(day => day.useful);
                const count = lastUseful >= 0 ? lastUseful + 1 : Math.ceil(models.forecast.forecastDays);
                summaries.forecast = summaries.forecast.slice(0, count);
                window.forecast = { ...window.forecast, days: window.forecast.days.slice(0, count) };
            }
            if (!Object.values(summaries).some(list => list.some(day => day.useful))) throw new Error(`Weather is unavailable for this ${target === summit ? 'summit' : 'location'}.`);
            subject = target; zone = targetZone;
            current = { subject, zone, window, data, models, sharedGrid: response.sharedGrid, days: summaries, loadedAt: Date.now() }; notice = null;
            if (subject === summit) summitResult = current;
            renderResult();
        } catch (error) {
            if (owner !== generation || lifecycle.state !== 'active' || error.name === 'AbortError') return;
            if (error.code === 'rate-limit') cooldown.set(error.retryAt);
            notice = { kind: error.code, text: `${changingLocation ? `Could not load ${target === summit ? 'summit weather' : weatherLocationLabel(target)}. ` : ''}${error.message || 'Weather could not be loaded.'}${current ? '' : ' Use Refresh to try again.'}` }; paintStatus();
            if (source.open) void loadUpdates();
        } finally {
            if (owner === generation) { pending = false; controller = null; card.setAttribute('aria-busy', 'false'); cooldown.refresh(); paintStatus(); }
        }
    }
    select.addEventListener('change', () => {
        if (!enabled() || lifecycle.state !== 'active' || cooldown.active()) return;
        if (!eligiblePeakWeatherModels(requestedSubject, requestedWindow || weatherPeakWindow(zone), period).some(model => model.id === select.value)) return;
        choices[period] = select.value;
        // Separate keys avoid overwriting the other period's choice from a
        // concurrently open tab. Store only the allowlisted model identifier.
        try { void chrome.storage.local.set({ [modelKeys[period]]: select.value }).catch(() => {}); } catch { /* Storage failure keeps the page usable. */ }
        cancelUpdates(); cancel(); void load();
    });
    const chooseLocation = next => {
        if (!enabled() || lifecycle.state !== 'active' || (next !== summit && cooldown.active())) return;
        const sameLocation = (left, right) => left.latitude === right.latitude && left.longitude === right.longitude && left.elevation === right.elevation;
        if (sameLocation(next, requestedSubject) && (pending || (current && sameLocation(next, subject) && !notice?.kind))) return;
        if (next !== summit && requestedSubject === summit) summitChoices = { ...choices };
        if (next === summit && summitChoices) { Object.assign(choices, summitChoices); summitChoices = null; }
        cancelUpdates(); cancel(); requestedSubject = next;
        requestedWindow = weatherPeakWindow(mountainTime.resolve(next.latitude, next.longitude));
        for (const key of Object.keys(choices)) {
            if (!eligiblePeakWeatherModels(next, requestedWindow, key).some(model => model.id === choices[key])) choices[key] = 'gfs_global';
        }
        populateModels();
        if (next === summit && summitResult) {
            current = summitResult; subject = summit; zone = current.zone;
            notice = cooldown.active() ? { kind: 'rate-limit', text: 'Weather requests are temporarily limited. Showing summit weather. Try again after the cooldown.' } : null;
            requestedWindow = current.window; renderResult();
        } else void load();
    };
    locationMenu = createWeatherLocationMenu({ enabled: () => enabled() && lifecycle.state === 'active', canSelect: () => !cooldown.active(), onSelect: chooseLocation });
    resetLocation.addEventListener('click', () => chooseLocation(summit));
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
        const wasEnabled = !row.hidden && enabled();
        const previousUnits = unitSignature();
        preference = next; settingsReady = true;
        row.hidden = card.hidden = !enabled();
        if (!enabled()) {
            locationMenu.close();
            cooldown.suspend(); cancel(); cancelUpdates(); clearChart();
            visibilityObserver?.disconnect(); visibilityObserver = null;
        } else if (lifecycle.state === 'active') {
            cooldown.resume();
            if (!wasEnabled || previousUnits !== unitSignature()) renderResult();
            if (!wasEnabled) beginWhenVisible();
        }
    };
    const unsubscribe = settings.subscribe(applyPreference);
    const stop = () => { locationMenu.close(); cooldown.suspend(); cancel(); cancelUpdates(); clearChart(); visibilityObserver?.disconnect(); document.removeEventListener('visibilitychange', visibility); };
    lifecycle = createPageLifecycle({ onSuspend: stop,
        onResume: () => { document.addEventListener('visibilitychange', visibility); if (enabled()) { cooldown.resume(); renderResult(); beginWhenVisible(); } },
        onDispose: () => { stop(); locationMenu.dispose(); cooldown.dispose(); unsubscribe(); client.clear(); updateClient.clear(); },
    });
    document.addEventListener('visibilitychange', visibility);
    // Resolve local choices before the first request, including a late sync
    // settings read/notification. Regional choices may not cover this summit.
    void (async () => {
        try {
            const saved = await chrome.storage.local.get([...Object.values(modelKeys), hourlyMetricKey]);
            hourlyMetric = resolvePeakHourlyMetric(saved?.[hourlyMetricKey]);
            const window = weatherPeakWindow(zone);
            for (const key of Object.keys(modelKeys)) {
                const value = saved?.[modelKeys[key]];
                if (eligiblePeakWeatherModels(subject, window, key).some(model => model.id === value)) choices[key] = value;
            }
        } catch { /* Use GFS and Conditions when local storage is unavailable. */ }
        if (lifecycle.state === 'disposed') return;
        modelsReady = true; populateModels();
        if (settingsReady) applyPreference(preference);
    })();
    // A newer sync notification owns the preference if startup's read is late.
    settings.requireCurrent().then(next => { if (!settingsReady && lifecycle.state !== 'disposed') applyPreference(next); }).catch(() => {});
    return { card, lifecycle };
}

mountPeakWeather();
