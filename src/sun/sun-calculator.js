// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime as MountainTime } from '../time/mountain-time.js';
import { sunPosition as SunPosition } from './sun-position.js';

let nextId = 1;

const element = (tag, className, text = null) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
};

const roundedDegrees = value => `${Math.round(value)}°`;
const elevationText = value => `${roundedDegrees(Math.abs(value))} ${value >= 0 ? 'above' : 'below'} horizon`;

export function createSunCalculator({
    mount,
    mode,
    onDateChange = () => {},
    onMinuteChange = () => {},
    requestFrame = callback => requestAnimationFrame(callback),
    cancelFrame = handle => cancelAnimationFrame(handle),
    statusDelayMs = 160,
} = {}) {
    if (!(mount instanceof Element) || (mode !== 'peak' && mode !== 'gpx')) return null;

    const id = `bpb-sun-panel-${nextId++}`;
    const root = element('section', `bpb-sun-calculator bpb-sun-calculator--${mode}`);
    root.dataset.theme = 'light';

    const toggle = element('button', 'bpb-sun-calculator__toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', id);
    const title = element('span', 'bpb-sun-calculator__title',
        mode === 'peak' ? 'Sun position' : 'Sun at selected point');
    const summary = element('span', 'bpb-sun-calculator__summary', 'Unavailable');
    const chevron = element('span', 'bpb-sun-calculator__chevron', '›');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.append(title, summary, chevron);

    const panel = element('div', 'bpb-sun-calculator__panel');
    panel.id = id;
    panel.hidden = true;

    const controls = element('div', 'bpb-sun-calculator__controls');
    const dateRow = element('div', 'bpb-sun-calculator__field');
    const dateLabel = element('label', 'bpb-sun-calculator__label', 'Date');
    const dateValue = mode === 'peak'
        ? element('input', 'bpb-sun-calculator__date')
        : element('output', 'bpb-sun-calculator__date-value');
    if (mode === 'peak') {
        dateValue.type = 'date';
        dateValue.id = `${id}-date`;
        dateLabel.htmlFor = dateValue.id;
    }
    const dateMeta = element('span', 'bpb-sun-calculator__meta');
    dateRow.append(dateLabel, dateValue, dateMeta);

    const timeRow = element('div', 'bpb-sun-calculator__field');
    const timeLabel = element('label', 'bpb-sun-calculator__label', 'Mountain time');
    const timeValue = element('output', 'bpb-sun-calculator__clock');
    const slider = element('input', 'bpb-sun-calculator__time');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1439';
    slider.step = '1';
    slider.id = `${id}-time`;
    timeLabel.htmlFor = slider.id;
    timeValue.htmlFor = slider.id;
    const timeMeta = element('span', 'bpb-sun-calculator__meta');
    timeRow.append(timeLabel, timeValue, slider, timeMeta);
    controls.append(dateRow, timeRow);

    const reading = element('div', 'bpb-sun-calculator__reading');
    const compass = element('div', 'bpb-sun-calculator__compass');
    compass.setAttribute('aria-hidden', 'true');
    const compassRing = element('div', 'bpb-sun-calculator__compass-ring');
    const sun = element('span', 'bpb-sun-calculator__sun');
    const cardinals = new Map();
    for (const [label, azimuth] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
        const cardinal = element('span', 'bpb-sun-calculator__cardinal', label);
        cardinal.dataset.azimuth = String(azimuth);
        cardinals.set(azimuth, cardinal);
        compassRing.append(cardinal);
    }
    compassRing.append(sun);
    compass.append(compassRing);

    const facts = element('div', 'bpb-sun-calculator__facts');
    const direction = element('div', 'bpb-sun-calculator__direction');
    const events = element('div', 'bpb-sun-calculator__events');
    facts.append(direction, events);
    reading.append(compass, facts);

    const limitation = element('p', 'bpb-sun-calculator__limitation',
        'Astronomical position at this location. Nearby terrain may block the sun.');
    const status = element('div', 'bpb-sun-calculator__status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    panel.append(controls, reading, limitation, status);
    root.append(toggle, panel);
    mount.append(root);

    let disposed = false;
    let frameHandle = null;
    let pendingCompass = null;
    let unboundedBearing = null;
    let statusTimer = null;
    let announcedText = '';

    const applyCompass = () => {
        frameHandle = null;
        const next = pendingCompass;
        pendingCompass = null;
        if (!next || disposed) return;
        const normalizedBearing = SunPosition.normalizeDegrees(next.bearing);
        if (unboundedBearing === null) unboundedBearing = normalizedBearing;
        else {
            const current = SunPosition.normalizeDegrees(unboundedBearing);
            const delta = ((normalizedBearing - current + 540) % 360) - 180;
            unboundedBearing += delta;
        }
        for (const [worldAzimuth, cardinal] of cardinals) {
            const angle = worldAzimuth - unboundedBearing;
            cardinal.style.transform = `rotate(${angle}deg) translateY(-2.65rem) rotate(${-angle}deg)`;
        }
        sun.hidden = !Number.isFinite(next.sunAzimuth);
        if (!sun.hidden) {
            const angle = next.sunAzimuth - unboundedBearing;
            sun.style.transform = `rotate(${angle}deg) translateY(-2.65rem)`;
        }
    };

    const scheduleCompass = state => {
        pendingCompass = {
            bearing: Number.isFinite(state?.mapBearing) ? state.mapBearing : 0,
            sunAzimuth: state?.result?.azimuthDeg,
        };
        if (frameHandle === null) frameHandle = requestFrame(applyCompass);
    };

    const announce = text => {
        if (text === announcedText) return;
        if (statusTimer !== null) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
            statusTimer = null;
            if (disposed) return;
            announcedText = text;
            status.textContent = text;
        }, statusDelayMs);
    };

    const showUnavailable = message => {
        const text = message || 'Sun position is unavailable.';
        summary.textContent = 'Unavailable';
        direction.textContent = text;
        events.textContent = '';
        if (mode === 'peak') dateValue.value = '';
        else dateValue.textContent = '';
        dateMeta.textContent = '';
        timeValue.textContent = '';
        timeMeta.textContent = '';
        toggle.disabled = true;
        slider.disabled = true;
        if (mode === 'peak') dateValue.disabled = true;
        scheduleCompass(null);
        announce(text);
    };

    const render = state => {
        if (disposed) return;
        if (!state?.result || !state.zone || !state.date || !Number.isInteger(state.minute)) {
            showUnavailable(state?.unavailable);
            return;
        }
        const clock = MountainTime.formatClock(state.zone, state.instant?.ms);
        const label = MountainTime.zoneLabel(state.zone, state.instant?.ms);
        if (!clock || !label) {
            showUnavailable('Sun position is unavailable.');
            return;
        }

        toggle.disabled = false;
        slider.disabled = false;
        slider.value = String(state.minute);
        if (mode === 'peak') {
            dateValue.disabled = false;
            dateValue.value = state.date;
        } else dateValue.textContent = state.date;
        dateMeta.textContent = `${state.dateSource} · ${label}`;
        timeValue.textContent = `${clock} (${label})`;
        timeMeta.textContent = state.timeSource;

        const azimuth = roundedDegrees(state.result.azimuthDeg);
        const elevation = elevationText(state.result.elevationDeg);
        summary.textContent = `${azimuth} ${state.result.directionLabel} · ${elevation}`;
        direction.textContent = `Azimuth ${azimuth} ${state.result.directionLabel} · ${elevation}`;
        if (state.result.daylightState === 'polar-day') {
            events.textContent = `The sun does not set on this date (polar day, ${label}).`;
        } else if (state.result.daylightState === 'polar-night') {
            events.textContent = `The sun does not rise on this date (polar night, ${label}).`;
        } else {
            const sunrise = MountainTime.formatClock(state.zone, state.result.sunriseMs);
            const sunset = MountainTime.formatClock(state.zone, state.result.sunsetMs);
            if (!sunrise || !sunset) {
                showUnavailable('Sun position is unavailable.');
                return;
            }
            events.textContent = `Level-horizon sunrise ${sunrise} · sunset ${sunset} (${label})`;
        }
        scheduleCompass(state);
        announce(`${summary.textContent}. ${events.textContent}`);
    };

    const setExpanded = expanded => {
        if (toggle.disabled) return;
        toggle.setAttribute('aria-expanded', String(expanded));
        panel.hidden = !expanded;
    };
    const onToggle = () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true');
    const onDateInput = () => onDateChange(dateValue.value);
    const onTimeInput = () => onMinuteChange(Number(slider.value));
    toggle.addEventListener('click', onToggle);
    if (mode === 'peak') dateValue.addEventListener('change', onDateInput);
    slider.addEventListener('input', onTimeInput);
    showUnavailable('Sun position is unavailable.');

    return Object.freeze({
        element: root,
        render,
        setSubject: render,
        setPreviewMinute: minute => {
            if (validMinute(minute)) slider.value = String(minute);
        },
        setMapBearing: state => scheduleCompass(state),
        setTheme: theme => { root.dataset.theme = theme === 'dark' ? 'dark' : 'light'; },
        setUnavailable: showUnavailable,
        setExpanded,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            toggle.removeEventListener('click', onToggle);
            if (mode === 'peak') dateValue.removeEventListener('change', onDateInput);
            slider.removeEventListener('input', onTimeInput);
            if (frameHandle !== null) cancelFrame(frameHandle);
            if (statusTimer !== null) clearTimeout(statusTimer);
            root.remove();
        },
    });
}

const validMinute = minute => Number.isInteger(minute) && minute >= 0 && minute <= 1439;

export const sunCalculator = Object.freeze({ create: createSunCalculator });
