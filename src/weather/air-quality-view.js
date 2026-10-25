// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { dom } from '../ui/dom.js';
import { createStableText } from '../ui/stable-text.js';
import { mountainTime } from '../time/mountain-time.js';
import { createAirQualityClient, airQualityCategory } from './air-quality-client.js';

export function createAirQualityView({ readLocation, available }) {
    const el = dom.element, client = createAirQualityClient();
    const panel = el('div', { id: 'bpb-peak-weather-air', role: 'tabpanel', 'aria-labelledby': 'bpb-peak-weather-aqi', hidden: '' });
    const refresh = el('button', { type: 'button', text: 'Refresh', 'aria-label': 'Refresh air quality' });
    const status = el('p', { class: 'bpb-week-status', role: 'status', 'aria-live': 'polite' });
    const feedback = createStableText(status);
    feedback.reserve(['Loading…', 'Refreshing…', 'Refresh failed.', 'Service busy.', 'Forecast expired.']);
    const summary = el('p', { class: 'bpb-air-summary', text: 'Regional air-quality forecast' });
    const summaryText = createStableText(summary);
    summaryText.reserve(['10000 US AQI', 'Unavailable']);
    const body = el('tbody');
    const table = el('table', { class: 'bpb-air-table' }, [el('caption', { text: 'Hourly regional forecast · US AQI' }),
        el('thead', {}, [el('tr', {}, ['Local time', 'US AQI', 'PM2.5 (µg/m³)'].map(text => el('th', { scope: 'col', text })))]), body]);
    const list = el('div', { class: 'bpb-air-hours', tabindex: '0', role: 'region', 'aria-label': 'Hourly air-quality forecast' }, [table]);
    const loaded = el('span');
    const source = el('p', { class: 'bpb-week-sub' }, [document.createTextNode('Regional surface model, not a summit measurement. CAMS uses approximately 45 km globally and 11 km in Europe. '),
        el('a', { href: 'https://open-meteo.com/en/docs/air-quality-api', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo / CAMS' }), document.createTextNode(' · '), loaded]);
    panel.append(el('div', { class: 'bpb-air-heading' }, [el('strong', { text: 'Air quality · 5-day forecast' }), refresh]), status, summary, list, source);
    let selected = false, controller = null, generation = 0, result = null, resultKey = '', retryAt = 0, expiry = null;
    const key = point => `${point.latitude}/${point.longitude}`;
    const stop = () => { clearTimeout(expiry); expiry = null; generation++; controller?.abort(); controller = null; panel.setAttribute('aria-busy', 'false'); refresh.setAttribute('aria-disabled', String(retryAt > Date.now())); };
    const paint = () => {
        if (!result) { body.replaceChildren(); summaryText.set('Regional forecast'); loaded.textContent = ''; return; }
        const point = readLocation(), zone = mountainTime.resolve(point.latitude, point.longitude), now = Date.now();
        const samples = result.samples.filter(sample => sample.time + 3600000 > now);
        const first = samples[0];
        summaryText.set(first?.aqi === null || !first ? 'Unavailable' : `${Math.round(first.aqi)} US AQI`);
        body.replaceChildren(...samples.map(sample => {
            const date = mountainTime.localDate(zone, sample.time), clock = mountainTime.formatClock(zone, sample.time);
            return el('tr', {}, [el('th', { scope: 'row', text: `${date.slice(5)} ${clock}` }),
                el('td', {}, [el('span', { class: 'bpb-air-category', 'data-band': sample.aqi === null ? 'unknown' : String(sample.aqi <= 50 ? 0 : sample.aqi <= 100 ? 1 : sample.aqi <= 150 ? 2 : sample.aqi <= 200 ? 3 : sample.aqi <= 300 ? 4 : 5),
                    text: sample.aqi === null ? 'Unavailable' : `${Math.round(sample.aqi)} · ${airQualityCategory(sample.aqi)}` })]),
                el('td', { text: sample.pm === null ? '—' : sample.pm.toFixed(1) })]);
        }));
        list.setAttribute('aria-label', `Hourly air-quality forecast · ${mountainTime.zoneLabel(zone, first?.time || now)}`);
        loaded.textContent = `Loaded ${new Date(result.loadedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        source.title = `Grid ${result.grid.latitude.toFixed(3)}, ${result.grid.longitude.toFixed(3)}. Loaded ${mountainTime.formatClock(zone, result.loadedAt)} ${mountainTime.zoneLabel(zone, result.loadedAt)}.`;
    };
    const armExpiry = () => {
        clearTimeout(expiry);
        if (result) expiry = setTimeout(() => { result = null; resultKey = ''; paint(); loaded.textContent = ''; feedback.set('Forecast expired.'); }, Math.max(0, 1800000 - (Date.now() - result.loadedAt)));
    };
    async function load(force = false) {
        if (!selected || !available() || controller || retryAt > Date.now()) return;
        const point = readLocation(), locationKey = key(point);
        if (resultKey !== locationKey || result && Date.now() - result.loadedAt >= 1800000) { result = null; resultKey = ''; paint(); }
        if (!force && result && Date.now() - result.loadedAt < 300000) { paint(); armExpiry(); return; }
        const owner = ++generation, request = new AbortController(); controller = request;
        panel.setAttribute('aria-busy', 'true'); refresh.setAttribute('aria-disabled', 'true');
        feedback.set(result ? 'Refreshing…' : 'Loading…');
        try {
            const data = await client.request(point, { signal: request.signal, refresh: force });
            if (owner !== generation || !selected || !available()) return;
            result = data; resultKey = locationKey; paint(); armExpiry(); feedback.set('');
        } catch (error) {
            if (owner !== generation || error.name === 'AbortError') return;
            retryAt = Math.max(retryAt, error.retryAt || 0);
            feedback.set(result ? 'Refresh failed.' : error.name === 'TimeoutError' ? 'Timed out.' : 'Could not load.');
            if (retryAt > Date.now()) feedback.set('Service busy.');
        } finally { if (owner === generation) { controller = null; panel.setAttribute('aria-busy', 'false'); refresh.setAttribute('aria-disabled', String(retryAt > Date.now())); } }
    }
    refresh.addEventListener('click', () => { void load(true); });
    return { panel,
        select(value) { selected = value; panel.hidden = !value; if (value) void load(); else stop(); },
        resume() { if (selected) void load(); },
        locationChanged() { stop(); result = null; resultKey = ''; feedback.set(''); paint(); if (selected) void load(); },
        suspend: stop,
        dispose() { selected = false; stop(); client.clear(); },
    };
}
