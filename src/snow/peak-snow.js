// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';
import { units } from '../ui/units.js';
import { createStableText } from '../ui/stable-text.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { createRetryCooldown } from '../ui/retry-cooldown.js';
import { settings } from '../settings/settings.js';
import { readPeakWeatherSubject } from '../weather/peak-weather-subject.js';
import { readPeakNations } from '../avalanche/avalanche-location.js';
import { createSnotelClient } from './snotel-client.js';
import { createSnotelMapSource } from './snotel-map-source.js';
import { nearbySnotelStations, latestSnotelReading, snotelReportUrl, SNOTEL_RADIUS_METERS } from './snotel-data.js';

const ID = 'bpb-peak-snow', element = dom.element;
const labels = {
    idle: 'Snow observations from nearby NRCS stations.',
    loading: 'Loading NRCS snow observations…',
    replacing: 'Loading selected station…',
    refreshing: 'Refreshing NRCS observations… Previous readings shown.',
    ready: 'Hourly readings are provisional. Route conditions may differ.',
    error: 'Could not load NRCS observations. Use Refresh to try again.',
    retained: 'Could not load NRCS observations. Previous readings shown.',
    limited: 'NRCS request limit reached. Wait a few minutes, then refresh.',
};
const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function mountPeakSnow() {
    if (document.getElementById(ID)) return;
    const subject = readPeakWeatherSubject(document, location.href);
    if (!subject) return;
    const coordinates = [...document.querySelectorAll('tr')].find(row =>
        row.cells.length === 2 && row.cells[0].textContent.trim().toLowerCase() === 'latitude/longitude (wgs84)');
    // Do not add an empty regional panel to peaks around the world. Include
    // Alaska across the date line; precise coverage comes from the catalog.
    if (!coordinates || !readPeakNations(coordinates.closest('table')).includes('united states')
        || (subject.longitude > -100 && subject.longitude < 170)) return;

    const refresh = element('button', { type: 'button', class: 'bpb-snow-refresh', text: 'Refresh', 'aria-label': 'Refresh snow observations', 'aria-disabled': 'false' });
    // An explicit empty form owner keeps native selection/Enter behavior while
    // preventing implicit submission of Peakbagger's surrounding ASP.NET form.
    const select = element('select', { id: `${ID}-station`, form: '', 'aria-label': 'SNOTEL station', 'aria-describedby': `${ID}-status`, disabled: '' }, [element('option', { text: 'Loading stations…', value: '' })]);
    const note = element('p', { class: 'bpb-snow-context', text: 'Nearby station observations, not summit measurements.' });
    const status = element('p', { id: `${ID}-status`, class: 'bpb-snow-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const stableStatus = createStableText(status);
    stableStatus.reserve([...Object.values(labels), 'No SNOTEL station within 50 km of this peak.',
        'No SNOTEL station within 31.1 mi of this peak.', 'NRCS request limit reached. Try again after Sep 30, 12:59 PM.']);
    stableStatus.set(labels.idle);
    const metrics = ['Snow depth', 'Water equivalent'].map(label => {
        const value = element('strong', { text: '—' }), time = element('span', { class: 'bpb-snow-time', text: 'No reading in past 48 hours' });
        const stableValue = createStableText(value), stableTime = createStableText(time);
        stableValue.reserve(['3810.0 cm', '1500.0 in', '12700.0 mm', '500.00 in', '—']);
        stableTime.reserve(['No reading in past 48 hours', 'Older reading · Sep 30, 12:59 PM · UTC−09']);
        return { value, time, stableValue, stableTime,
            node: element('div', { class: 'bpb-snow-metric' }, [element('span', { class: 'bpb-snow-label', text: label }), value, time]) };
    });
    const graph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    graph.setAttribute('viewBox', '0 0 320 80'); graph.setAttribute('aria-hidden', 'true'); graph.setAttribute('focusable', 'false');
    graph.setAttribute('preserveAspectRatio', 'none');
    const emptyGraph = element('p', { text: 'Daily snow-depth trend' });
    const graphMax = element('span', { class: 'bpb-snow-graph-max', 'aria-hidden': 'true', hidden: '' });
    const graphZero = element('span', { class: 'bpb-snow-graph-zero', 'aria-hidden': 'true', text: '0', hidden: '' });
    const graphFrame = element('div', { class: 'bpb-snow-graph' }, [graph, emptyGraph, graphMax, graphZero]);
    const range = element('p', { class: 'bpb-snow-range', text: 'Past 7 days · Snow depth' });
    const stableRange = createStableText(range);
    stableRange.reserve(['Sep 30 – Sep 30 · Snow depth', 'Past 7 days · Snow depth']);
    const tbody = element('tbody');
    const details = element('details', { class: 'bpb-snow-details' }, [element('summary', { text: 'Daily readings and source details' }),
        element('div', { class: 'bpb-snow-table-wrap' }, [element('table', {}, [element('caption', { text: 'Daily observations · NRCS end-of-day dates' }),
            element('thead', {}, [element('tr', {}, ['Date', 'Snow depth', 'Water equivalent'].map(text => element('th', { scope: 'col', text })))]), tbody])]),
        element('p', { text: 'Water equivalent is the water held in the snowpack. Depth changes include settling and melting; they are not fresh snowfall. Gaps remain unavailable.' }),
        element('p', { text: 'Nearby stations may be much lower or across a ridge. Hourly readings are provisional; the daily series receives more review. Source quality flags appear with each daily value.' }),
    ]);
    const source = element('a', { href: 'https://nwcc-apps.sc.egov.usda.gov/imap/', target: '_blank', rel: 'noopener noreferrer', text: 'NRCS · SNOTEL' });
    const observations = element('div', { class: 'bpb-snow-observations' }, [
        element('label', { for: select.id, class: 'bpb-snow-label', text: 'SNOTEL station' }), select, note,
        element('div', { class: 'bpb-snow-metrics' }, metrics.map(metric => metric.node)), range, graphFrame,
    ]);
    const card = element('section', { id: ID, 'aria-labelledby': `${ID}-heading`, 'aria-busy': 'false', hidden: '' }, [
        element('header', {}, [element('h2', { id: `${ID}-heading`, text: 'Nearby snow' }), refresh]),
        observations, status, details,
        element('footer', {}, [element('span', { text: 'Observations within 50 km' }), source]),
    ]);
    const row = element('tr', { id: `${ID}-row`, hidden: '' }, [element('td', { colspan: '2', class: 'bpb-snow-cell' }, [card])]);
    const weatherRow = document.getElementById('bpb-peak-weather-row');
    const mapRow = document.getElementById('Gmap')?.closest('tr');
    if (weatherRow?.closest('table') === subject.table) weatherRow.after(row);
    else if (mapRow?.closest('table') === subject.table) mapRow.after(row);
    else subject.table.tBodies[0].append(row);

    const client = createSnotelClient({ storage: chrome.storage.local });
    const mapSource = createSnotelMapSource({ client, subject, onSelect: (station, nearby) => {
        if (!enabled()) return;
        // This explicit map action reveals the card even before its lazy load.
        // Keep the ordinary three choices plus the chosen nearby map station.
        if (!cooldown.active()) {
            observer?.disconnect(); observer = null;
            noStations = false; observations.hidden = details.hidden = false;
            candidates = nearby.slice(0, 3);
            if (!candidates.some(candidate => candidate.id === station.id)) candidates.push(station);
            if (!pending || requested?.id !== station.id) { requested = station; void load(station); }
        }
        card.scrollIntoView({ block: 'start' });
        select.focus({ preventScroll: true });
    } });
    let preference = settings.DEFAULTS, settingsReady = false, candidates = null, current = null, requested = null;
    let controller = null, generation = 0, pending = false, observer = null, notice = null, noStations = false;
    let lifecycle;
    const enabled = () => settingsReady && preference.showWeather && lifecycle.state === 'active';
    const system = measurement => units.resolveUnits(preference, () => 'imperial', measurement);
    const depthText = mm => mm === null ? '—' : system('precipitation') === 'metric' ? `${(mm / 10).toFixed(1)} cm` : `${(mm / 25.4).toFixed(1)} in`;
    const waterText = mm => units.formatWeather(mm, 'precipitation', system('precipitation'));
    const availability = () => {
        refresh.setAttribute('aria-disabled', String(pending || cooldown.active() || noStations));
        select.setAttribute('aria-disabled', String(cooldown.active()));
    };
    const cooldown = createRetryCooldown(availability);
    const setStatus = text => { stableStatus.set(text); };
    const fillStations = () => {
        if (!candidates?.length) return;
        const previous = current?.station.id || requested?.id || candidates[0].id;
        // A failed map replacement must still name the station whose retained
        // readings are shown, even when it is outside the default three.
        const choices = current && !candidates.some(station => station.id === current.station.id)
            ? [...candidates, current.station] : candidates;
        select.replaceChildren(...choices.map(station => element('option', { value: station.id,
            text: `${station.name} · ${units.formatDistance(station.distance, system('distance'))} away · ${units.formatElevation(station.elevation, system('elevation'))}` })));
        select.value = previous; select.disabled = false;
    };
    const readingTime = (reading, station) => {
        if (!reading) return 'No reading in past 48 hours';
        const clock = new Date(reading.time + station.offset * 3600_000).toLocaleString([], {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
        const offset = `UTC${station.offset < 0 ? '−' : '+'}${String(Math.abs(station.offset)).padStart(2, '0')}`;
        return `${Date.now() - reading.time > 6 * 3600_000 ? 'Older reading · ' : ''}${clock} · ${offset}`;
    };
    const render = (view = current) => {
        fillStations();
        card.querySelector('footer > span').textContent = `Observations within ${units.formatDistance(SNOTEL_RADIUS_METERS, system('distance'))}`;
        const shownStation = view?.station || requested;
        if (shownStation) { select.value = shownStation.id; source.href = snotelReportUrl(shownStation); }
        for (const [index, code] of ['SNWD', 'WTEQ'].entries()) {
            const reading = latestSnotelReading(view?.data.hourly[code] || []);
            metrics[index].stableValue.set(index === 0 ? depthText(reading?.value ?? null) : waterText(reading?.value ?? null));
            metrics[index].stableTime.set(readingTime(reading, view?.station));
            metrics[index].time.title = reading ? `NRCS quality flags: QC ${reading.qc || 'unavailable'}, QA ${reading.qa || 'unavailable'}` : '';
        }
        const today = new Date(Date.now() + (shownStation?.offset || 0) * 3600_000).toISOString().slice(0, 10);
        const dates = Array.from({ length: 8 }, (_, i) => new Date(Date.parse(today) - (7 - i) * 86400_000).toISOString().slice(0, 10));
        const data = code => new Map((view?.data.daily[code] || []).map(reading => [reading.date, reading]));
        const snow = data('SNWD'), water = data('WTEQ');
        tbody.replaceChildren(...dates.map(date => element('tr', {}, [element('th', { scope: 'row', text: dateLabel(date) }),
            ...[snow.get(date), water.get(date)].map((reading, index) => {
                const value = element('span', { text: index === 0 ? depthText(reading?.value ?? null) : waterText(reading?.value ?? null) });
                const flags = element('small', { text: reading?.value != null ? `QC ${reading.qc || '—'} · QA ${reading.qa || '—'}` : 'Unavailable' });
                createStableText(value).reserve(['1500.0 in', '3810.0 cm', '12700.0 mm', '—']);
                createStableText(flags).reserve(['QC V · QA P', 'Unavailable']);
                return element('td', {}, [value, flags]);
            })])));
        const values = dates.map(date => snow.get(date)?.value ?? null);
        const max = Math.max(1, ...values.filter(value => value !== null));
        let path = '', connected = false;
        values.forEach((value, index) => {
            if (value === null) { connected = false; return; }
            const x = 8 + index * 304 / 7, y = 68 - value / max * 44;
            path += `${connected ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`; connected = true;
        });
        graph.replaceChildren();
        if (values.some(value => value !== null)) {
            const baseline = document.createElementNS(graph.namespaceURI, 'path');
            baseline.setAttribute('d', 'M8,68H312'); baseline.setAttribute('class', 'bpb-snow-baseline'); graph.append(baseline);
        }
        const line = document.createElementNS(graph.namespaceURI, 'path'); line.setAttribute('d', path); graph.append(line);
        values.forEach((value, index) => {
            if (value === null) return;
            const dot = document.createElementNS(graph.namespaceURI, 'circle');
            dot.setAttribute('cx', String(8 + index * 304 / 7)); dot.setAttribute('cy', String(68 - value / max * 44)); dot.setAttribute('r', '2'); graph.append(dot);
        });
        emptyGraph.hidden = values.some(value => value !== null);
        graphMax.hidden = graphZero.hidden = !emptyGraph.hidden;
        graphMax.textContent = depthText(Math.max(0, ...values.filter(value => value !== null)));
        emptyGraph.textContent = view ? 'No daily snow-depth readings' : 'Daily snow-depth trend';
        stableRange.set(view ? `${dateLabel(dates[0])} – ${dateLabel(dates.at(-1))} · Snow depth` : 'Past 7 days · Snow depth');
    };
    const cancel = () => {
        generation++; controller?.abort(); controller = null; pending = false;
        card.setAttribute('aria-busy', 'false'); availability();
    };
    const load = async (target = requested, { refresh: force = false } = {}) => {
        if (!enabled() || cooldown.active()) return;
        cancel(); controller = new AbortController(); const signal = controller.signal, owner = generation;
        pending = true; notice = null; availability(); card.setAttribute('aria-busy', 'true');
        setStatus(current ? target?.id && target.id !== current.station.id ? labels.replacing : labels.refreshing : labels.loading);
        try {
            if (!candidates) {
                candidates = nearbySnotelStations(await client.stations({ signal }), subject);
                if (owner !== generation || !enabled()) return;
                fillStations();
            }
            if (!candidates.length) {
                noStations = true; select.options[0].textContent = 'No nearby stations';
                // A first coverage result may compact the panel once. Do not
                // leave a full empty readings/chart surface with no usable data.
                if (observations.contains(document.activeElement) || details.contains(document.activeElement)) refresh.focus({ preventScroll: true });
                observations.hidden = details.hidden = true;
                setStatus(`No SNOTEL station within ${units.formatDistance(SNOTEL_RADIUS_METERS, system('distance'))} of this peak.`);
                return;
            }
            requested = candidates.find(station => station.id === target?.id) || candidates[0];
            render(current?.station.id === requested.id ? current : null);
            const data = await client.observations(requested, { signal, refresh: force });
            if (owner !== generation || !enabled()) return;
            current = { station: requested, data }; render(); setStatus(labels.ready);
        } catch (error) {
            if (owner !== generation || !enabled() || error.name === 'AbortError') return;
            notice = error;
            if (!candidates) select.options[0].textContent = 'Stations unavailable';
            if (current) render(current);
            setStatus(error.code === 'rate-limit' ? error.message : current ? labels.retained : labels.error);
            if (error.code === 'rate-limit') cooldown.set(error.retryAt);
        } finally {
            if (owner === generation) { pending = false; controller = null; card.setAttribute('aria-busy', 'false'); availability(); }
        }
    };
    select.addEventListener('change', () => {
        if (cooldown.active()) { select.value = current?.station.id || requested?.id || ''; return; }
        const target = candidates?.find(station => station.id === select.value);
        if (pending && target?.id === requested?.id) return;
        if (target) { requested = target; void load(target); }
    });
    select.addEventListener('pointerdown', event => { if (cooldown.active()) event.preventDefault(); });
    select.addEventListener('keydown', event => {
        if (cooldown.active() && !['Tab', 'Escape'].includes(event.key) && !event.ctrlKey && !event.metaKey) event.preventDefault();
    });
    refresh.addEventListener('click', () => { if (!pending && !cooldown.active() && !noStations) void load(requested, { refresh: true }); });
    const beginVisible = () => {
        observer?.disconnect(); observer = null;
        if (!enabled()) return;
        if (typeof IntersectionObserver !== 'function') { void load(); return; }
        const nextObserver = new IntersectionObserver(entries => {
            if (observer !== nextObserver) return;
            if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); observer = null; void load(); }
        }, { rootMargin: '200px' });
        observer = nextObserver;
        observer.observe(card);
    };
    const visibility = () => {
        if (enabled() && document.visibilityState === 'visible' && !pending && !notice && current && Date.now() - current.data.loadedAt >= 30 * 60_000) beginVisible();
    };
    const stop = () => { cancel(); mapSource.suspend(); observer?.disconnect(); observer = null; cooldown.suspend(); document.removeEventListener('visibilitychange', visibility); };
    lifecycle = createPageLifecycle({ onSuspend: stop,
        onResume: () => { mapSource.resume(); document.addEventListener('visibilitychange', visibility); if (enabled()) { cooldown.resume(); beginVisible(); } },
        onDispose: () => { stop(); mapSource.dispose(); cooldown.dispose(); unsubscribe(); client.clear(); },
    });
    const applyPreference = next => {
        if (lifecycle.state === 'disposed') return;
        const wasEnabled = enabled(); preference = next; settingsReady = true;
        mapSource.setEnabled(preference.showWeather);
        card.hidden = row.hidden = !preference.showWeather;
        if (!enabled()) { cancel(); observer?.disconnect(); observer = null; cooldown.suspend(); }
        else { cooldown.resume(); render(pending && requested?.id !== current?.station.id ? null : current); if (!wasEnabled) beginVisible(); }
    };
    const unsubscribe = settings.subscribe(applyPreference);
    document.addEventListener('visibilitychange', visibility);
    settings.requireCurrent().then(next => { if (!settingsReady) applyPreference(next); }).catch(() => {});
    return { card, lifecycle };
}

mountPeakSnow();
