// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { settings } from '../settings/settings.js';
import { units } from '../ui/units.js';
import { readPeakUnitSystem } from '../peakbagger/peak-units.js';
import { mountainTime } from '../time/mountain-time.js';
import { createPageLifecycle } from '../ui/page-lifecycle.ts';
import { createCardReadGate } from '../ui/card-read-gate.ts';
import { createLatestRead } from '../ui/latest-read.ts';
import { createRetryCooldown } from '../ui/retry-cooldown.js';
import { createStableText } from '../ui/stable-text.js';
import { readPeakWeatherSubject } from './peak-weather-subject.js';
import { weatherDayWindow } from './weather-day.js';
import { createWeatherIcon } from './weather-icon.js';
import { summitCloudModel, eligibleSummitCloudModels, resolveSummitCloudModels } from './summit-cloud-models.js';
import { createSummitCloudClient } from './summit-cloud-client.js';
import { CLOUD_STATES, predictSummitCloud } from './summit-cloud-core.js';

const ID = 'bpb-summit-cloud', HOUR = 3600000, DAY = 24 * HOUR, element = dom.element;
const dateLabel = date => new Date(`${date}T12:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const addDays = (date, count) => new Date(Date.parse(`${date}T00:00Z`) + count * DAY).toISOString().slice(0, 10);
const messages = ['Loading cloud profiles…', 'Cloud profiles updated.', 'Refresh failed. Showing the previous result.',
    'Cloud forecast unavailable. Try Refresh.', 'Cloud requests limited. Try again later.', 'Choose another model for this summit.',
    'Summit elevation is unavailable.', 'Model choice could not be saved.', 'Forecast paused. Expand to continue.'];

export function mountSummitCloud() {
    if (document.getElementById(ID)) return;
    const subject = readPeakWeatherSubject(document, location.href);
    if (!subject) return;
    const zone = mountainTime.resolve(subject.latitude, subject.longitude);
    const card = element('section', { id: ID, hidden: '', 'aria-labelledby': `${ID}-heading`, 'aria-busy': 'false' });
    const modelSelect = element('select', { id: `${ID}-model`, form: '' });
    const dateSelect = element('select', { id: `${ID}-date`, form: '' });
    const refresh = element('button', { type: 'button', class: 'bpb-cloud-refresh', text: 'Refresh', 'aria-label': 'Refresh summit cloud forecast' });
    const control = (label, input) => element('label', { class: 'bpb-cloud-control', for: input.id }, [element('span', { text: label }), input]);
    const status = element('p', { class: 'bpb-cloud-status', role: 'status', 'aria-live': 'polite' });
    const statusText = createStableText(status); statusText.reserve(messages); statusText.set('Loading cloud profiles…');
    const source = element('p', { class: 'bpb-cloud-source' }), sourceText = createStableText(source);
    const earlier = element('button', { type: 'button', class: 'bpb-cloud-page', text: '‹', 'aria-label': 'Show earlier hours' });
    const later = element('button', { type: 'button', class: 'bpb-cloud-page', text: '›', 'aria-label': 'Show later hours' });
    const range = element('div', { class: 'bpb-cloud-range' });
    const dayLabel = element('strong', { class: 'bpb-cloud-day' }), dayText = createStableText(dayLabel);
    const timeContext = element('span', { class: 'bpb-cloud-time-context' }), contextText = createStableText(timeContext);
    range.append(dayLabel, timeContext);
    const hours = element('div', { class: 'bpb-cloud-hours', role: 'group', 'aria-label': 'Hourly summit cloud predictions. Use left and right arrows to select an hour.' });
    const hourNodes = [];
    const selectedClock = element('time', { class: 'bpb-cloud-selected-clock' }), selectedClockText = createStableText(selectedClock);
    const title = element('strong', { class: 'bpb-cloud-prediction' }), titleText = createStableText(title);
    titleText.reserve(Object.values(CLOUD_STATES).map(value => value.title));
    const confidence = element('span', { class: 'bpb-cloud-confidence' });
    const reason = element('p', { class: 'bpb-cloud-reason' }), reasonText = createStableText(reason);
    reasonText.reserve(['Moist air approaching higher terrain could form cloud on the ridge.',
        'The summit and sampled surroundings are relatively dry at summit height. Lower valleys may still contain cloud.',
        'The model has no complete atmospheric layers bracketing this summit.']);
    const evidence = element('ul', { class: 'bpb-cloud-evidence' });
    const details = element('details', { class: 'bpb-cloud-details' }, [element('summary', { text: 'Why this prediction' }), reason, evidence,
        element('p', { text: 'We compare cloud and moisture at summit height, four surrounding profiles and moist air blowing toward higher terrain. Most model cloud values are derived from humidity. Small cap clouds and valley fog may be missed; this is not an exact view in every direction.' })]);
    card.append(element('header', {}, [element('h2', { id: `${ID}-heading` }, [createWeatherIcon('cloud'),
        element('span', { class: 'bpb-cloud-heading-label' }, [element('span', { text: 'Summit Cloud Cover' }), element('span', { class: 'bpb-cloud-badge', text: 'Experimental' })])])]),
    element('div', { class: 'bpb-cloud-controls' }, [control('Model', modelSelect), control('Date', dateSelect), refresh]), status, source,
    element('div', { class: 'bpb-cloud-navigation' }, [earlier, range, later]), hours,
    element('div', { class: 'bpb-cloud-result' }, [selectedClock, title, confidence]), details,
    element('footer', {}, [element('span', { text: 'Cloud estimates only · Accuracy not yet validated' }),
        element('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo · data attribution' })]));
    const row = element('tr', { id: `${ID}-row`, hidden: '' }, [element('td', { colspan: '2', class: 'bpb-cloud-cell' }, [card])]);
    const mapRow = document.getElementById('Gmap')?.closest('tr');
    if (mapRow?.closest('table') === subject.table) mapRow.after(row); else subject.table.tBodies[0].append(row);

    const client = createSummitCloudClient();
    const reads = createLatestRead();
    let preference = settings.DEFAULTS, ready = false, selection = 'auto', requestedDate = '', current = null;
    let pending = false, lifecycle, writeGeneration = 0;
    let selectedIndex = 0, revealSelection = true, failed = false, savingChoice = false, clockTimer;
    const enabled = () => ready && preference.showSummitCloud;
    const readGate = createCardReadGate({ card, enabled, active: () => lifecycle?.state === 'active',
        collapsed: () => preference.peakCloudCollapsed, onChange: () => visibility() });
    const active = readGate.eligible;
    const cooldown = createRetryCooldown(blocked => {
        refresh.setAttribute('aria-disabled', String(pending || blocked));
        modelSelect.setAttribute('aria-disabled', String(blocked)); dateSelect.setAttribute('aria-disabled', String(blocked));
    });
    const elevation = value => units.formatElevation(value, units.resolveUnits(preference, () => readPeakUnitSystem(document), 'elevation'));
    const clock = time => `${mountainTime.formatClock(zone, time)} ${mountainTime.zoneLabel(zone, time)}`;
    const relativeDate = (date, now = Date.now()) => {
        const today = mountainTime.localDate(zone, now);
        const relative = date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : date === addDays(today, -1) ? 'Yesterday' : '';
        return `${relative ? `${relative} · ` : ''}${dateLabel(date)}`;
    };
    const temporalLabel = (time, now) => time + HOUR <= now ? 'Past forecast' : time <= now ? 'Current hour' : 'Future forecast';
    const horizon = () => selection === 'auto' ? 10 : Math.ceil(summitCloudModel(selection)?.days || 1);
    function populateControls() {
        const models = eligibleSummitCloudModels(subject);
        modelSelect.replaceChildren(element('option', { value: 'auto', text: 'Automatic · compare models' }), ...models.map(model => element('option', {
            value: model.id, text: `${model.label} · ${model.gridKm} km · up to ${model.days} days` })));
        if (![...modelSelect.options].some(option => option.value === selection)) modelSelect.append(element('option', {
            value: selection, text: `${summitCloudModel(selection)?.label || 'Saved model'} · unavailable here`, disabled: '' }));
        modelSelect.value = selection;
        const today = mountainTime.localDate(zone, Date.now());
        const dates = Array.from({ length: horizon() }, (_, index) => addDays(today, index));
        if (!dates.includes(requestedDate)) requestedDate = today;
        dateSelect.replaceChildren(...dates.map(date => element('option', { value: date, text: relativeDate(date) })));
        dateSelect.value = requestedDate;
        sourceText.reserve(['Showing: HRRR + GEM HRDPS · Summit 29,029 ft', ...models.map(model => `Showing: ${model.label} · Summit 29,029 ft`)]);
    }
    function placeholder() {
        const day = weatherDayWindow(requestedDate, zone, Date.now(), { forecast: true });
        const times = [];
        for (let time = Math.ceil(day.start / HOUR) * HOUR; time < day.end; time += HOUR) times.push(time);
        let models = [];
        try { models = resolveSummitCloudModels(subject, selection, (Date.parse(requestedDate) - Date.parse(mountainTime.localDate(zone, Date.now()))) / DAY); } catch { /* Preserve an unsupported saved choice. */ }
        return { day, times, models, datasets: [], expected: models.length || 1, label: selection === 'auto' ? 'Automatic' : summitCloudModel(selection)?.label || 'Saved model', loadedAt: null };
    }
    const displayed = () => current || placeholder();
    function selectNearNow(data) {
        selectedIndex = Math.max(0, Math.min(data.times.length - 1, Math.floor((Date.now() - data.times[0]) / HOUR)));
        revealSelection = true;
    }
    function updateNavigation() {
        earlier.setAttribute('aria-disabled', String(hours.scrollLeft <= 1));
        later.setAttribute('aria-disabled', String(hours.scrollLeft + hours.clientWidth >= hours.scrollWidth - 1));
    }
    function revealHour() {
        if (!hours.clientWidth) return;
        const button = hourNodes[selectedIndex]?.button;
        if (!button) return;
        const viewport = hours.getBoundingClientRect(), cell = button.getBoundingClientRect();
        if (cell.left < viewport.left || cell.right > viewport.right) {
            // Scroll only the timeline. scrollIntoView can move the host page.
            const scale = viewport.width / hours.offsetWidth || 1;
            hours.scrollLeft += (cell.left - viewport.left) / scale - (hours.clientWidth - cell.width / scale) / 2;
        }
        revealSelection = false;
    }
    function populateHours(count) {
        while (hourNodes.length > count) hourNodes.pop().button.remove();
        while (hourNodes.length < count) {
            const marker = element('span', { class: 'bpb-cloud-hour-context', 'aria-hidden': 'true' });
            const clockNode = element('time', { class: 'bpb-cloud-clock' }), clockText = createStableText(clockNode);
            const timezone = element('span', { class: 'bpb-cloud-hour-zone', 'aria-hidden': 'true' });
            const label = element('span', { class: 'bpb-cloud-hour-state' }), text = createStableText(label);
            text.reserve(Object.values(CLOUD_STATES).map(value => value.short));
            const button = element('button', { type: 'button', class: 'bpb-cloud-hour', 'aria-pressed': 'false' }, [marker, clockNode, timezone, label]);
            button.addEventListener('click', () => { selectedIndex = Number(button.dataset.index); paint(); });
            hours.append(button); hourNodes.push({ button, marker, clock: clockNode, clockText, timezone, text });
        }
    }
    function paint() {
        if (!requestedDate) return;
        const now = Date.now(), data = displayed(), times = data.times;
        selectedIndex = Math.min(selectedIndex, times.length - 1);
        const predictions = times.map(time => predictSummitCloud(data.datasets, subject, time, now, data.expected));
        sourceText.set(`${current ? 'Showing' : 'Requested'}: ${data.label} · Summit ${Number.isFinite(subject.elevation) ? elevation(subject.elevation) : 'height unknown'}`);
        source.title = data.loadedAt ? `Retrieved ${relativeDate(mountainTime.localDate(zone, data.loadedAt), now)} · ${clock(data.loadedAt)}. Provider metadata does not identify each hour's model run.` : '';
        dayText.reserve([relativeDate(data.day.date, now), `Tomorrow · ${dateLabel(data.day.date)}`]);
        dayText.set(relativeDate(data.day.date, now));
        const context = time => `Summit time · Now ${clock(time)}${zone.estimated ? ' · estimated zone' : ''}`;
        contextText.reserve(times.map(context)); contextText.set(context(now));
        hours.setAttribute('aria-label', `${relativeDate(data.day.date, now)} · ${times.length} hours of summit cloud predictions. Use left and right arrows to select an hour.`);
        for (const option of dateSelect.options) option.textContent = relativeDate(option.value, now);
        populateHours(times.length);
        const compactClocks = times.map(time => mountainTime.formatClock(zone, time).replace(/^0(?=\d)/, '').replace(':00', '').replace(/\s+/g, ' '));
        const selectionLabel = (time, temporal = temporalLabel(time, now)) => `${relativeDate(mountainTime.localDate(zone, time), now)} · ${clock(time).replace(/^0(?=\d)/, '')} · ${temporal}`;
        hourNodes.forEach(({ button, marker, clock: clockNode, clockText, timezone, text }, index) => {
            const time = times[index], prediction = predictions[index], temporal = temporalLabel(time, now);
            button.dataset.index = String(index); button.dataset.state = prediction.key;
            button.dataset.time = String(time); button.dataset.temporal = temporal === 'Current hour' ? 'now' : temporal === 'Past forecast' ? 'past' : 'future';
            button.setAttribute('aria-pressed', String(index === selectedIndex));
            button.tabIndex = index === selectedIndex ? 0 : -1;
            button.setAttribute('aria-label', `${selectionLabel(time)}: ${prediction.title}`);
            marker.textContent = temporal === 'Current hour' ? 'Now' : temporal === 'Past forecast' ? 'Past' : '';
            clockNode.dateTime = new Date(time).toISOString(); timezone.textContent = mountainTime.zoneLabel(zone, time);
            clockText.reserve(compactClocks); clockText.set(compactClocks[index]); text.set(prediction.short);
        });
        if (revealSelection) revealHour();
        updateNavigation();
        const prediction = predictions[selectedIndex];
        selectedClock.dateTime = new Date(times[selectedIndex]).toISOString();
        selectedClockText.reserve(times.flatMap(time => ['Past forecast', 'Current hour', 'Future forecast'].map(temporal => selectionLabel(time, temporal)))); selectedClockText.set(selectionLabel(times[selectedIndex]));
        titleText.set(prediction.title); title.dataset.state = prediction.key; confidence.textContent = prediction.confidence;
        reasonText.set(prediction.reason);
        evidence.replaceChildren(...data.models.map(model => {
            const estimate = prediction.estimates.find(item => item.model.id === model.id);
            const heading = element('strong'), headingText = createStableText(heading);
            headingText.reserve(Object.values(CLOUD_STATES).map(state => `${model.label}: ${state.title}`));
            headingText.set(`${model.label}: ${(estimate || CLOUD_STATES.unavailable).title}`);
            const measurements = element('p'), measurementsText = createStableText(measurements);
            const measurementLabel = (humidity, cloud, nearby, total, lower, upper) => `${humidity}% humidity and ${cloud}% modeled cloud at summit height; ${nearby}/${total} surrounding profiles cloudy. Layers ${lower}–${upper}; grid ~${model.gridKm} km.`;
            measurementsText.reserve([measurementLabel(100, 100, 4, 4, elevation(19999), elevation(19999)), 'No complete atmospheric profile is available for this model and hour.']);
            measurementsText.set(estimate?.summit ? measurementLabel(Math.round(estimate.summit.humidity), Math.round(estimate.summit.cloud), estimate.cloudyNeighbors, estimate.neighbors,
                elevation(estimate.summit.lower), elevation(estimate.summit.upper)) : 'No complete atmospheric profile is available for this model and hour.');
            return element('li', {}, [heading, measurements]);
        }));
        clearTimeout(clockTimer);
        if (active()) clockTimer = setTimeout(() => { if (active()) paint(); }, 60000 - now % 60000);
    }
    function cancel() {
        if (pending) statusText.set('Forecast paused. Expand to continue.');
        reads.cancel(); pending = false; clearTimeout(clockTimer);
        card.setAttribute('aria-busy', 'false'); cooldown.refresh(); readGate.cancelWait();
    }
    async function load({ refresh: force = false } = {}) {
        if (!active() || pending || cooldown.active()) return;
        populateControls();
        if (!Number.isFinite(subject.elevation)) { statusText.set('Summit elevation is unavailable.'); paint(); return; }
        let models;
        const day = weatherDayWindow(requestedDate, zone, Date.now(), { forecast: true });
        try { models = resolveSummitCloudModels(subject, selection, (Date.parse(requestedDate) - Date.parse(mountainTime.localDate(zone, Date.now()))) / DAY); }
        catch { failed = true; statusText.set('Choose another model for this summit.'); paint(); return; }
        cancel(); const request = reads.start();
        pending = true; failed = false; card.setAttribute('aria-busy', 'true'); cooldown.refresh(); statusText.set('Loading cloud profiles…');
        if (!current) { selectNearNow(displayed()); paint(); }
        const results = await Promise.allSettled(models.map(model => {
            // API horizon bounds are UTC dates. The local day's remaining hours
            // remain visible as unavailable instead of rejecting the whole day.
            const end = Math.min(day.end, Date.parse(new Date().toISOString().slice(0, 10)) + Math.ceil(model.days) * DAY);
            return client.request(subject, { ...day, end }, model, { signal: request.signal, refresh: force });
        }));
        if (!request.isCurrent() || !active()) return;
        request.finish(); pending = false; card.setAttribute('aria-busy', 'false');
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        const datasets = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        const limited = errors.find(error => error.code === 'rate-limit'); if (limited) cooldown.set(limited.retryAt);
        if (datasets.length) {
            const changedDay = !current || current.day.date !== day.date;
            current = { ...placeholder(), day, models, datasets, selection, expected: models.length, label: models.map(model => model.label).join(' + '), loadedAt: Date.now() };
            if (changedDay) selectNearNow(current);
            statusText.set(limited ? 'Cloud requests limited. Try again later.' : 'Cloud profiles updated.');
        } else { failed = true; statusText.set(limited ? 'Cloud requests limited. Try again later.' : current ? 'Refresh failed. Showing the previous result.' : 'Cloud forecast unavailable. Try Refresh.'); }
        cooldown.refresh(); paint();
    }
    function begin() {
        if (!active() || pending || failed) return;
        readGate.waitForViewport(() => { void load(); });
    }
    hours.addEventListener('keydown', event => {
        if (!event.target.matches('.bpb-cloud-hour') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        selectedIndex = event.key === 'Home' ? 0 : event.key === 'End' ? hourNodes.length - 1
            : Math.max(0, Math.min(hourNodes.length - 1, Number(event.target.dataset.index) + (event.key === 'ArrowRight' ? 1 : -1)));
        revealSelection = true; paint(); hourNodes[selectedIndex].button.focus({ preventScroll: true });
    });
    hours.addEventListener('scroll', updateNavigation, { passive: true });
    for (const [button, direction] of [[earlier, -1], [later, 1]]) button.addEventListener('click', () => {
        if (button.getAttribute('aria-disabled') === 'true') return;
        hours.scrollLeft += direction * Math.max(1, hours.clientWidth - (hourNodes[0]?.button.offsetWidth || 0));
        updateNavigation();
    });
    const timelineObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { revealHour(); updateNavigation(); }) : null;
    timelineObserver?.observe(hours);
    refresh.addEventListener('click', () => { if (!pending && !cooldown.active()) { failed = false; void load({ refresh: true }); } });
    modelSelect.addEventListener('change', () => {
        if (cooldown.active()) { modelSelect.value = selection; return; }
        selection = modelSelect.value; const choice = selection, write = ++writeGeneration; savingChoice = true;
        cancel(); failed = false; populateControls(); void load();
        settings.set({ bpbSummitCloudModel: choice }).catch(() => { if (write === writeGeneration && lifecycle.state !== 'disposed') statusText.set('Model choice could not be saved.'); })
            .finally(() => { if (write === writeGeneration) savingChoice = false; });
    });
    dateSelect.addEventListener('change', () => {
        if (cooldown.active()) { dateSelect.value = requestedDate; return; }
        requestedDate = dateSelect.value; cancel(); failed = false; void load();
    });
    const visibility = () => {
        if (!active()) { cancel(); cooldown.suspend(); return; }
        cooldown.resume(); if (!current || current.selection !== selection || current.day.date !== requestedDate || Date.now() - current.loadedAt >= 300000) begin(); else paint();
    };
    const applyPreference = next => {
        if (lifecycle.state === 'disposed') return;
        const wasEnabled = enabled(), wasCollapsed = preference.peakCloudCollapsed, priorSelection = selection;
        const changedModel = ready && next.bpbSummitCloudModel !== preference.bpbSummitCloudModel;
        preference = next;
        if (!ready || changedModel && !savingChoice) selection = next.bpbSummitCloudModel || 'auto';
        ready = true; row.hidden = card.hidden = !enabled(); populateControls(); paint();
        if (!active()) { cancel(); cooldown.suspend(); }
        else if (!wasEnabled || wasCollapsed || priorSelection !== selection) { cancel(); failed = false; cooldown.resume(); begin(); }
        readGate.refresh();
    };
    const unsubscribe = settings.subscribe(applyPreference);
    const stop = () => { cancel(); cooldown.suspend(); readGate.refresh(); };
    lifecycle = createPageLifecycle({ onSuspend: stop, onResume: () => { if (!readGate.refresh()) visibility(); },
        onDispose: () => { stop(); timelineObserver?.disconnect(); readGate.dispose(); unsubscribe(); cooldown.dispose(); client.clear(); } });
    settings.requireCurrent().then(next => { if (!ready && lifecycle.state !== 'disposed') applyPreference(next); }).catch(() => {});
    return { card, lifecycle };
}

mountSummitCloud();
