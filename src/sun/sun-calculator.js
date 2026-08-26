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

const svgElement = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);

const sunIcon = () => {
    const icon = svgElement('svg');
    icon.classList.add('bpb-sun-calculator__icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const circle = svgElement('circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '4');
    icon.append(circle);
    for (const [x1, y1, x2, y2] of [
        ['12', '1', '12', '4'], ['12', '20', '12', '23'],
        ['1', '12', '4', '12'], ['20', '12', '23', '12'],
        ['4.2', '4.2', '6.3', '6.3'], ['17.7', '17.7', '19.8', '19.8'],
        ['17.7', '6.3', '19.8', '4.2'], ['4.2', '19.8', '6.3', '17.7'],
    ]) {
        const ray = svgElement('line');
        ray.setAttribute('x1', x1);
        ray.setAttribute('y1', y1);
        ray.setAttribute('x2', x2);
        ray.setAttribute('y2', y2);
        icon.append(ray);
    }
    return icon;
};

const chevronIcon = () => {
    const icon = svgElement('svg');
    icon.classList.add('bpb-sun-calculator__chevron');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    const line = svgElement('polyline');
    line.setAttribute('points', '3 6 8 11 13 6');
    icon.append(line);
    return icon;
};

const roundedDegrees = value => `${Math.round(value)}°`;
const elevationText = value => `${roundedDegrees(Math.abs(value))} ${value >= 0 ? 'above' : 'below'} horizon`;
const MOON_PHASE_ICONS = Object.freeze(['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘']);
const eventDaySuffix = relation => relation === 'previous-day' ? ' (previous day)'
    : relation === 'next-day' ? ' (next day)' : '';

function moonDisplay(result) {
    const phaseIndex = result?.moonPhaseIndex;
    const fraction = result?.moonIlluminationFraction;
    if (!Number.isInteger(phaseIndex) || phaseIndex < 0 || phaseIndex >= MOON_PHASE_ICONS.length
        || typeof result?.moonPhaseLabel !== 'string'
        || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
    const illumination = `${Math.round(fraction * 100)}% illuminated`;
    return Object.freeze({
        icon: MOON_PHASE_ICONS[phaseIndex],
        label: result.moonPhaseLabel,
        illumination,
        announcement: `${result.moonPhaseLabel}, ${illumination}`,
    });
}

function eventDisplay(zone, ms, dayRelation) {
    const clock = MountainTime.formatClock(zone, ms);
    const label = MountainTime.zoneLabel(zone, ms);
    if (!clock || !label) return null;
    return Object.freeze({ clock, label, daySuffix: eventDaySuffix(dayRelation) });
}

function eventSummary(zone, result) {
    const sunrise = eventDisplay(zone, result.sunriseMs, result.sunriseDayRelation);
    const sunset = eventDisplay(zone, result.sunsetMs, result.sunsetDayRelation);
    if (!sunrise || !sunset) return null;
    if (sunrise.label === sunset.label) {
        return Object.freeze({
            text: `Level-horizon sunrise ${sunrise.clock}${sunrise.daySuffix} · sunset ${sunset.clock}${sunset.daySuffix} (${sunrise.label})`,
            sunriseText: `${sunrise.clock}${sunrise.daySuffix}`,
            sunsetText: `${sunset.clock}${sunset.daySuffix}`,
        });
    }
    return Object.freeze({
        text: `Level-horizon sunrise ${sunrise.clock} ${sunrise.label}${sunrise.daySuffix} · sunset ${sunset.clock} ${sunset.label}${sunset.daySuffix}`,
        sunriseText: `${sunrise.clock} ${sunrise.label}${sunrise.daySuffix}`,
        sunsetText: `${sunset.clock} ${sunset.label}${sunset.daySuffix}`,
    });
}

export function createSunCalculator({
    mount,
    mode,
    onDateChange = () => {},
    onMinuteChange = () => {},
    requestFrame = callback => requestAnimationFrame(callback),
    cancelFrame = handle => cancelAnimationFrame(handle),
    statusDelayMs = 160,
    scheduleStatus = (callback, delay) => setTimeout(callback, delay),
    cancelStatus = handle => clearTimeout(handle),
} = {}) {
    if (!(mount instanceof Element) || (mode !== 'peak' && mode !== 'gpx')) return null;

    const id = `bpb-sun-panel-${nextId++}`;
    const root = element('section', `bpb-sun-calculator bpb-sun-calculator--${mode}`);
    root.dataset.theme = 'light';

    const toggle = element('button', 'bpb-sun-calculator__toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', id);
    const icon = sunIcon();
    const title = element('span', 'bpb-sun-calculator__title',
        mode === 'peak' ? 'Sun & Moon' : 'Sun & Moon at selected point');
    const summary = element('span', 'bpb-sun-calculator__summary', 'Unavailable');
    const chevron = chevronIcon();
    toggle.append(icon, title, summary, chevron);

    const panel = element('div', 'bpb-sun-calculator__panel');
    panel.id = id;
    panel.hidden = true;

    const layout = element('div', 'bpb-sun-calculator__layout');
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
    const center = element('span', 'bpb-sun-calculator__compass-center');
    const sun = element('span', 'bpb-sun-calculator__sun');
    const sunDisc = element('span', 'bpb-sun-calculator__sun-disc');
    sun.append(sunDisc);
    const cardinals = new Map();
    for (const [label, azimuth] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
        const cardinal = element('span', 'bpb-sun-calculator__cardinal');
        const cardinalLabel = element('span', 'bpb-sun-calculator__cardinal-label', label);
        cardinal.dataset.azimuth = String(azimuth);
        cardinal.append(cardinalLabel);
        cardinals.set(azimuth, cardinal);
        compassRing.append(cardinal);
    }
    compassRing.append(sun, center);
    compass.append(compassRing);

    const facts = element('div', 'bpb-sun-calculator__facts');
    const direction = element('div', 'bpb-sun-calculator__direction');
    const directionLabel = element('span', 'bpb-sun-calculator__fact-label', 'Direction');
    const directionValue = element('strong', 'bpb-sun-calculator__fact-value');
    direction.append(directionLabel, directionValue);
    const elevationFact = element('div', 'bpb-sun-calculator__elevation');
    const elevationLabel = element('span', 'bpb-sun-calculator__fact-label', 'Elevation');
    const elevationValue = element('strong', 'bpb-sun-calculator__fact-value');
    elevationFact.append(elevationLabel, elevationValue);
    const moonFact = element('div', 'bpb-sun-calculator__moon');
    const moonLabel = element('span', 'bpb-sun-calculator__fact-label', 'Moon phase');
    const moonValue = element('strong', 'bpb-sun-calculator__fact-value bpb-sun-calculator__moon-value');
    const moonIcon = element('span', 'bpb-sun-calculator__moon-icon');
    moonIcon.setAttribute('aria-hidden', 'true');
    const moonName = element('span', 'bpb-sun-calculator__moon-name');
    moonValue.append(moonIcon, moonName);
    const moonIllumination = element('span', 'bpb-sun-calculator__fact-detail');
    moonFact.append(moonLabel, moonValue, moonIllumination);
    facts.append(direction, elevationFact, moonFact);
    const events = element('div', 'bpb-sun-calculator__events');
    const eventsText = element('span', 'bpb-sun-calculator__events-text');
    const eventsVisual = element('span', 'bpb-sun-calculator__event-line');
    eventsVisual.setAttribute('aria-hidden', 'true');
    const sunrise = element('span', 'bpb-sun-calculator__event-time');
    const eventTrack = element('span', 'bpb-sun-calculator__event-track');
    const eventMarker = element('span', 'bpb-sun-calculator__event-marker');
    eventTrack.append(eventMarker);
    const sunset = element('span', 'bpb-sun-calculator__event-time');
    eventsVisual.append(sunrise, eventTrack, sunset);
    events.append(eventsText, eventsVisual);

    const limitation = element('p', 'bpb-sun-calculator__limitation',
        'Astronomical sun position and moon phase. Nearby terrain may block either object from view.');
    const empty = element('p', 'bpb-sun-calculator__empty');
    empty.hidden = true;
    const status = element('div', 'bpb-sun-calculator__status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    reading.append(compass, facts, events, limitation);
    layout.append(controls, reading);
    panel.append(layout, empty, status);
    root.append(toggle, panel);
    mount.append(root);

    let disposed = false;
    let frameHandle = null;
    let pendingCompass = null;
    let previewFrameHandle = null;
    let pendingMinute = null;
    let unboundedBearing = null;
    let unboundedSunAzimuth = null;
    let statusTimer = null;
    let announcedText = '';
    let appliedInitialExpansion = false;

    const setSliderMinute = minute => {
        slider.value = String(minute);
        slider.style.setProperty('--bpb-sun-progress', `${minute / 1439 * 100}%`);
    };

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
            cardinal.style.transform = `rotate(${angle}deg)`;
            cardinal.firstElementChild.style.transform = `translateX(-50%) rotate(${-angle}deg)`;
        }
        sun.hidden = !Number.isFinite(next.sunAzimuth);
        if (!sun.hidden) {
            const normalizedAzimuth = SunPosition.normalizeDegrees(next.sunAzimuth);
            if (unboundedSunAzimuth === null) unboundedSunAzimuth = normalizedAzimuth;
            else {
                const current = SunPosition.normalizeDegrees(unboundedSunAzimuth);
                const delta = ((normalizedAzimuth - current + 540) % 360) - 180;
                unboundedSunAzimuth += delta;
            }
            const angle = unboundedSunAzimuth - unboundedBearing;
            sun.style.transform = `rotate(${angle}deg)`;
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
        if (statusTimer !== null) {
            cancelStatus(statusTimer);
            statusTimer = null;
        }
        if (text === announcedText) return;
        statusTimer = scheduleStatus(() => {
            statusTimer = null;
            if (disposed) return;
            announcedText = text;
            status.textContent = text;
        }, statusDelayMs);
    };

    const clearMoon = () => {
        moonIcon.textContent = '';
        moonName.textContent = '';
        moonIllumination.textContent = '';
        delete root.dataset.moonPhase;
    };
    const setExpanded = expanded => {
        if (toggle.disabled) return;
        toggle.setAttribute('aria-expanded', String(expanded));
        panel.hidden = !expanded;
    };
    const applyInitialExpansion = () => {
        if (appliedInitialExpansion) return;
        appliedInitialExpansion = true;
        if (mode === 'peak') setExpanded(true);
    };

    const showUnavailable = (message, { expandable = false, summaryText = 'Unavailable' } = {}) => {
        const text = message || 'Sun position is unavailable.';
        summary.textContent = summaryText;
        layout.hidden = true;
        empty.hidden = false;
        empty.textContent = text;
        directionValue.textContent = '';
        elevationValue.textContent = '';
        elevationFact.hidden = true;
        clearMoon();
        eventsText.textContent = '';
        events.classList.remove('bpb-sun-calculator__events--text');
        eventsVisual.hidden = true;
        if (mode === 'peak') dateValue.value = '';
        else dateValue.textContent = '';
        dateMeta.textContent = '';
        timeValue.textContent = '';
        timeMeta.textContent = '';
        toggle.disabled = !expandable;
        if (!expandable) {
            toggle.setAttribute('aria-expanded', 'false');
            panel.hidden = true;
        }
        slider.disabled = true;
        slider.removeAttribute('aria-valuetext');
        delete root.dataset.horizon;
        delete root.dataset.daylight;
        sun.classList.remove('bpb-sun-calculator__sun--below-horizon');
        eventMarker.hidden = true;
        slider.style.setProperty('--bpb-sun-progress', '0%');
        if (mode === 'peak') dateValue.disabled = true;
        scheduleCompass(null);
        announce(text);
    };
    const showSubjectUnavailable = message => showUnavailable(message, {
        expandable: mode === 'gpx',
    });

    const showRecoverable = (state, message = 'Sun position is unavailable for this date and time.') => {
        summary.textContent = 'Unavailable for this date and time';
        toggle.disabled = false;
        applyInitialExpansion();
        layout.hidden = false;
        controls.hidden = false;
        reading.hidden = true;
        empty.hidden = false;
        empty.textContent = message;
        directionValue.textContent = '';
        elevationValue.textContent = '';
        elevationFact.hidden = true;
        clearMoon();
        eventsText.textContent = '';
        eventsVisual.hidden = true;
        events.classList.remove('bpb-sun-calculator__events--text');
        const hasDate = typeof state?.date === 'string';
        const hasMinute = validMinute(state?.minute);
        if (mode === 'peak') {
            dateValue.disabled = !hasDate;
            dateValue.value = hasDate ? state.date : '';
        } else dateValue.textContent = hasDate ? state.date : '';
        dateMeta.textContent = mode === 'peak' ? '' : state?.dateSource || '';
        slider.disabled = !hasDate || !hasMinute;
        if (hasMinute) {
            setSliderMinute(state.minute);
            const clock = Number.isFinite(state?.instant?.ms)
                ? MountainTime.formatClock(state.zone, state.instant.ms)
                : null;
            const label = Number.isFinite(state?.instant?.ms)
                ? MountainTime.zoneLabel(state.zone, state.instant.ms)
                : null;
            timeValue.textContent = clock || MountainTime.formatCivilClock(state.minute) || '';
            const valueText = clock && label ? `${clock} ${label}` : timeValue.textContent;
            if (valueText) slider.setAttribute('aria-valuetext', valueText);
            else slider.removeAttribute('aria-valuetext');
        } else {
            slider.style.setProperty('--bpb-sun-progress', '0%');
            timeValue.textContent = '';
            slider.removeAttribute('aria-valuetext');
        }
        timeMeta.textContent = state?.timeSource || '';
        scheduleCompass(null);
        announce(message);
    };

    const render = state => {
        if (disposed) return;
        if (!state?.result || !state.zone || !state.date || !Number.isInteger(state.minute)) {
            if (state?.availability === 'recoverable' && state?.subject && state?.zone) {
                showRecoverable(state, state.unavailable);
            } else showSubjectUnavailable(state?.unavailable);
            return;
        }
        const clock = MountainTime.formatClock(state.zone, state.instant?.ms);
        const label = MountainTime.zoneLabel(state.zone, state.instant?.ms);
        if (!clock || !label) {
            showRecoverable(state, 'Sun position is unavailable for this date and time.');
            return;
        }

        toggle.disabled = false;
        applyInitialExpansion();
        layout.hidden = false;
        controls.hidden = false;
        reading.hidden = false;
        empty.hidden = true;
        empty.textContent = '';
        slider.disabled = false;
        setSliderMinute(state.minute);
        slider.setAttribute('aria-valuetext', `${clock} ${label}`);
        if (mode === 'peak') {
            dateValue.disabled = false;
            dateValue.value = state.date;
        } else dateValue.textContent = state.date;
        dateMeta.textContent = mode === 'peak' ? '' : state.dateSource;
        timeValue.textContent = clock;
        const zoneText = MountainTime.zoneDescription(state.zone, state.instant.ms) || label;
        timeMeta.textContent = mode === 'peak' ? zoneText : `${state.timeSource} · ${zoneText}`;

        const azimuth = roundedDegrees(state.result.azimuthDeg);
        const elevation = elevationText(state.result.elevationDeg);
        root.dataset.horizon = state.result.isAboveHorizon ? 'above' : 'below';
        root.dataset.daylight = state.result.daylightState;
        sun.classList.toggle('bpb-sun-calculator__sun--below-horizon',
            !state.result.isAboveHorizon);
        summary.textContent = `${azimuth} ${state.result.directionLabel} · ${elevation}`;
        directionValue.textContent = `${azimuth} ${state.result.directionLabel}`;
        elevationFact.hidden = false;
        elevationValue.textContent = elevation;
        const moon = moonDisplay(state.result);
        if (moon) {
            moonIcon.textContent = moon.icon;
            moonName.textContent = moon.label;
            moonIllumination.textContent = moon.illumination;
            root.dataset.moonPhase = String(state.result.moonPhaseIndex);
        } else {
            moonIcon.textContent = '';
            moonName.textContent = 'Unavailable';
            moonIllumination.textContent = '';
            delete root.dataset.moonPhase;
        }
        const moonAnnouncement = moon?.announcement || 'Moon phase unavailable';
        events.classList.toggle('bpb-sun-calculator__events--text',
            state.result.daylightState !== 'ordinary');
        eventsVisual.hidden = true;
        eventMarker.hidden = true;
        if (state.result.daylightState === 'polar-day') {
            eventsText.textContent = `The sun does not set on this date (polar day, ${label}).`;
        } else if (state.result.daylightState === 'polar-night') {
            eventsText.textContent = `The sun does not rise on this date (polar night, ${label}).`;
        } else if (state.result.daylightState === 'unavailable') {
            events.classList.add('bpb-sun-calculator__events--text');
            eventsText.textContent = 'Rise and set times unavailable for this date.';
        } else {
            const eventDetails = eventSummary(state.zone, state.result);
            if (!eventDetails) {
                events.classList.add('bpb-sun-calculator__events--text');
                eventsText.textContent = 'Rise and set times unavailable for this date.';
                scheduleCompass(state);
                announce(`${summary.textContent}. ${moonAnnouncement}. ${eventsText.textContent}`);
                return;
            }
            eventsText.textContent = eventDetails.text;
            sunrise.textContent = eventDetails.sunriseText;
            sunset.textContent = eventDetails.sunsetText;
            const daylightMs = state.result.sunsetMs - state.result.sunriseMs;
            const inDaylight = daylightMs > 0 && state.instant.ms >= state.result.sunriseMs
                && state.instant.ms <= state.result.sunsetMs;
            const progress = inDaylight
                ? (state.instant.ms - state.result.sunriseMs) / daylightMs
                : 0;
            eventMarker.style.insetInlineStart = `${progress * 100}%`;
            eventMarker.hidden = !inDaylight;
            eventsVisual.hidden = false;
        }
        scheduleCompass(state);
        announce(`${summary.textContent}. ${moonAnnouncement}. ${eventsText.textContent}`);
    };
    const onToggle = () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true');
    const onDateInput = () => onDateChange(dateValue.value);
    const applyPreviewMinute = () => {
        previewFrameHandle = null;
        const minute = pendingMinute;
        pendingMinute = null;
        if (disposed || !validMinute(minute)) return;
        onMinuteChange(minute);
    };
    const onTimeInput = () => {
        const minute = Number(slider.value);
        setSliderMinute(minute);
        const previewClock = MountainTime.formatCivilClock(minute);
        timeValue.textContent = previewClock || timeValue.textContent;
        if (previewClock) slider.setAttribute('aria-valuetext', previewClock);
        pendingMinute = minute;
        if (previewFrameHandle !== null) return;
        // Keep this correct under synchronous frame stubs as well as browsers.
        previewFrameHandle = true;
        const handle = requestFrame(applyPreviewMinute);
        if (previewFrameHandle !== null) previewFrameHandle = handle;
    };
    toggle.addEventListener('click', onToggle);
    if (mode === 'peak') dateValue.addEventListener('change', onDateInput);
    slider.addEventListener('input', onTimeInput);
    showUnavailable('Sun position is unavailable.');

    return Object.freeze({
        element: root,
        render,
        setSubject: render,
        setPreviewMinute: minute => {
            if (validMinute(minute)) setSliderMinute(minute);
        },
        setMapBearing: state => scheduleCompass(state),
        setTheme: theme => { root.dataset.theme = theme === 'dark' ? 'dark' : 'light'; },
        setUnavailable: showUnavailable,
        setPrompt: message => showUnavailable(message, {
            expandable: mode === 'gpx',
            summaryText: mode === 'gpx' ? 'Select a chart point' : 'Unavailable',
        }),
        setExpanded,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            toggle.removeEventListener('click', onToggle);
            if (mode === 'peak') dateValue.removeEventListener('change', onDateInput);
            slider.removeEventListener('input', onTimeInput);
            if (frameHandle !== null) cancelFrame(frameHandle);
            if (previewFrameHandle !== null) cancelFrame(previewFrameHandle);
            if (statusTimer !== null) cancelStatus(statusTimer);
            root.remove();
        },
    });
}

const validMinute = minute => Number.isInteger(minute) && minute >= 0 && minute <= 1439;

export const sunCalculator = Object.freeze({ create: createSunCalculator });
