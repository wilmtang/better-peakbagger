// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountainTime as MountainTime } from '../time/mountain-time.ts';
import type { MountainZone } from '../time/mountain-time.ts';
import { sunPosition as SunPosition } from './sun-position.ts';
import type { DayRelation, DaylightState, MoonVisibilitySelection, MoonVisibilityState } from './sun-position.ts';

export type SunCalculatorMode = 'peak' | 'gpx';

export interface SunCalculatorResult {
    readonly azimuthDeg: number;
    readonly directionLabel: string | null;
    readonly elevationDeg: number;
    readonly isAboveHorizon: boolean;
    readonly daylightState?: DaylightState | string;
    readonly sunriseMs?: number | null;
    readonly sunriseAzimuthDeg?: number | null;
    readonly sunriseDayRelation?: DayRelation | string | null;
    readonly solarNoonAzimuthDeg?: number | null;
    readonly sunsetMs?: number | null;
    readonly sunsetAzimuthDeg?: number | null;
    readonly sunsetDayRelation?: DayRelation | string | null;
    readonly moonAzimuthDeg?: number | null;
    readonly moonDirectionLabel?: string | null;
    readonly moonElevationDeg?: number | null;
    readonly moonPhaseIndex?: number | null;
    readonly moonPhaseLabel?: string | null;
    readonly moonIlluminationFraction?: number | null;
    readonly moonVisibilityState?: MoonVisibilityState | string | null;
    readonly moonVisibilitySelection?: MoonVisibilitySelection | string | null;
    readonly moonriseMs?: number | null;
    readonly moonriseAzimuthDeg?: number | null;
    readonly moonriseDayRelation?: DayRelation | string | null;
    readonly moonVisibleMidpointAzimuthDeg?: number | null;
    readonly moonsetMs?: number | null;
    readonly moonsetAzimuthDeg?: number | null;
    readonly moonsetDayRelation?: DayRelation | string | null;
}

export interface SunCalculatorState {
    readonly subject?: { readonly lat: number; readonly lon: number } | null;
    readonly zone?: MountainZone | null;
    readonly date?: string | null;
    readonly minute?: number | null;
    readonly dateSource?: string | null;
    readonly timeSource?: string | null;
    readonly contextLabel?: string | null;
    readonly mapBearing?: number | null;
    readonly instant?: { readonly ms: number } | null;
    readonly result?: SunCalculatorResult | null;
    readonly unavailable?: string | null;
    readonly availability?: string | null;
}

export interface SunCalculatorOptions<
    FrameHandle = number,
    StatusHandle = ReturnType<typeof setTimeout>,
> {
    mount?: Element | null;
    mode?: SunCalculatorMode | string;
    onDateChange?: (date: string) => void;
    onMinuteChange?: (minute: number) => void;
    requestFrame?: (callback: () => void) => FrameHandle;
    cancelFrame?: (handle: FrameHandle) => void;
    statusDelayMs?: number;
    scheduleStatus?: (callback: () => void, delay: number) => StatusHandle;
    cancelStatus?: (handle: StatusHandle) => void;
}

export interface SunCalculator {
    readonly element: HTMLElement;
    readonly render: (state: SunCalculatorState | null | undefined) => void;
    readonly setSubject: (state: SunCalculatorState | null | undefined) => void;
    readonly setPreviewMinute: (minute: number | null | undefined) => void;
    readonly setMapBearing: (state: SunCalculatorState | null | undefined) => void;
    readonly setTheme: (theme?: string | null) => void;
    readonly setUnavailable: (
        message?: string | null,
        options?: { expandable?: boolean; summaryText?: string },
    ) => void;
    readonly setPrompt: (message?: string | null) => void;
    readonly setExpanded: (expanded: boolean) => void;
    readonly dispose: () => void;
}

interface PendingCompass {
    bearing: number;
    sunAzimuth: number | null | undefined;
    moonAzimuth: number | null | undefined;
    sunriseAzimuthDeg: number | null | undefined;
    solarNoonAzimuthDeg: number | null | undefined;
    sunsetAzimuthDeg: number | null | undefined;
    moonriseAzimuthDeg: number | null | undefined;
    moonVisibleMidpointAzimuthDeg: number | null | undefined;
    moonsetAzimuthDeg: number | null | undefined;
}

type HidableSvg = SVGSVGElement & { hidden: boolean };

let nextId = 1;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text: string | null = null,
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
};

const svgElement = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
    document.createElementNS('http://www.w3.org/2000/svg', tag);

const sunIcon = (): SVGSVGElement => {
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

const chevronIcon = (): SVGSVGElement => {
    const icon = svgElement('svg');
    icon.classList.add('bpb-sun-calculator__chevron');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    const line = svgElement('polyline');
    line.setAttribute('points', '3 6 8 11 13 6');
    icon.append(line);
    return icon;
};

const roundedDegrees = (value: number): string => `${Math.round(value)}°`;
const elevationText = (value: number): string =>
    `${roundedDegrees(Math.abs(value))} ${value >= 0 ? 'above' : 'below'} horizon`;
const MOON_PHASE_ICONS = Object.freeze(['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘']);
const DAYLIGHT_ARC_RADIUS = 37;
const MOON_VISIBILITY_ARC_RADIUS = 28;
const eventDaySuffix = (relation: string | null | undefined): string =>
    relation === 'previous-day' ? ' (previous day)'
        : relation === 'next-day' ? ' (next day)' : '';
const compactDate = (date: string): string => {
    const [, month, day] = date.split('-').map(Number);
    const name = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1];
    return `${name} ${day}`;
};

const compassPoint = (azimuth: number, radius: number) => {
    const radians = (SunPosition.normalizeDegrees(azimuth) - 90) * Math.PI / 180;
    return Object.freeze({
        x: 50 + radius * Math.cos(radians),
        y: 50 + radius * Math.sin(radians),
    });
};

function compassArc(
    startAzimuth: number | null | undefined,
    middleAzimuth: number | null | undefined,
    endAzimuth: number | null | undefined,
    radius: number,
) {
    if (!isFiniteNumber(startAzimuth) || !isFiniteNumber(middleAzimuth)
        || !isFiniteNumber(endAzimuth) || !isFiniteNumber(radius)) return null;
    const clockwiseSpan = SunPosition.normalizeDegrees(endAzimuth - startAzimuth);
    if (clockwiseSpan < 0.01 || clockwiseSpan > 359.99) return null;
    const clockwiseToMiddle = SunPosition.normalizeDegrees(middleAzimuth - startAzimuth);
    const clockwise = clockwiseToMiddle <= clockwiseSpan;
    const span = clockwise ? clockwiseSpan : 360 - clockwiseSpan;
    const start = compassPoint(startAzimuth, radius);
    const end = compassPoint(endAzimuth, radius);
    return Object.freeze({
        d: `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${radius} ${radius} 0 ${span > 180 ? 1 : 0} ${clockwise ? 1 : 0} ${end.x.toFixed(3)} ${end.y.toFixed(3)}`,
        start,
        end,
    });
}

const daylightArc = (result: PendingCompass | null | undefined) => compassArc(
    result?.sunriseAzimuthDeg,
    result?.solarNoonAzimuthDeg,
    result?.sunsetAzimuthDeg,
    DAYLIGHT_ARC_RADIUS,
);

const moonVisibilityArc = (result: PendingCompass | null | undefined) => compassArc(
    result?.moonriseAzimuthDeg,
    result?.moonVisibleMidpointAzimuthDeg,
    result?.moonsetAzimuthDeg,
    MOON_VISIBILITY_ARC_RADIUS,
);

function moonPositionDisplay(result: SunCalculatorResult) {
    const azimuth = result?.moonAzimuthDeg;
    const elevation = result?.moonElevationDeg;
    const direction = result?.moonDirectionLabel;
    if (!isFiniteNumber(azimuth) || !isFiniteNumber(elevation)
        || typeof direction !== 'string') return null;
    const directionText = `${roundedDegrees(azimuth)} ${direction}`;
    const elevationDescription = elevationText(elevation);
    return Object.freeze({
        direction: directionText,
        elevation: elevationDescription,
        isAboveHorizon: elevation >= 0,
        announcement: `Moon ${directionText}, ${elevationDescription}`,
    });
}

function moonPhaseDisplay(result: SunCalculatorResult) {
    const phaseIndex = result?.moonPhaseIndex;
    const fraction = result?.moonIlluminationFraction;
    const phaseLabel = result?.moonPhaseLabel;
    if (typeof phaseIndex !== 'number' || !Number.isInteger(phaseIndex)
        || phaseIndex < 0 || phaseIndex >= MOON_PHASE_ICONS.length
        || typeof phaseLabel !== 'string'
        || !isFiniteNumber(fraction) || fraction < 0 || fraction > 1) return null;
    const illumination = `${Math.round(fraction * 100)}% illuminated`;
    return Object.freeze({
        icon: MOON_PHASE_ICONS[phaseIndex],
        label: phaseLabel,
        illumination,
        announcement: `${phaseLabel}, ${illumination}`,
    });
}

function eventDisplay(
    zone: MountainZone,
    ms: number | null | undefined,
    dayRelation: string | null | undefined,
) {
    const clock = MountainTime.formatClock(zone, ms);
    const label = MountainTime.zoneLabel(zone, ms);
    if (!clock || !label) return null;
    return Object.freeze({
        clock,
        label,
        daySuffix: dayRelation && ['earlier-day', 'later-day'].includes(dayRelation)
            ? ` (${MountainTime.localDate(zone, ms)})` : eventDaySuffix(dayRelation),
    });
}

function eventSummary(zone: MountainZone, result: SunCalculatorResult) {
    const sunriseMs = result.sunriseMs;
    const sunsetMs = result.sunsetMs;
    if (!isFiniteNumber(sunriseMs) || !isFiniteNumber(sunsetMs)) return null;
    const sunrise = eventDisplay(zone, sunriseMs, result.sunriseDayRelation);
    const sunset = eventDisplay(zone, sunsetMs, result.sunsetDayRelation);
    if (!sunrise || !sunset) return null;
    if (sunrise.label === sunset.label) {
        return Object.freeze({
            sunriseMs,
            sunsetMs,
            text: `Level-horizon sunrise ${sunrise.clock}${sunrise.daySuffix} · sunset ${sunset.clock}${sunset.daySuffix} (${sunrise.label})`,
            sunriseText: `${sunrise.clock}${sunrise.daySuffix}`,
            sunsetText: `${sunset.clock}${sunset.daySuffix}`,
        });
    }
    return Object.freeze({
        sunriseMs,
        sunsetMs,
        text: `Level-horizon sunrise ${sunrise.clock} ${sunrise.label}${sunrise.daySuffix} · sunset ${sunset.clock} ${sunset.label}${sunset.daySuffix}`,
        sunriseText: `${sunrise.clock} ${sunrise.label}${sunrise.daySuffix}`,
        sunsetText: `${sunset.clock} ${sunset.label}${sunset.daySuffix}`,
    });
}

function moonEventSummary(zone: MountainZone, result: SunCalculatorResult, selectedLabel: string): string {
    if (result?.moonVisibilityState === 'always-up') {
        return `Moon stays above the level horizon all day (${selectedLabel}); no rise/set band.`;
    }
    if (result?.moonVisibilityState === 'always-down') {
        return `Moon stays below the level horizon all day (${selectedLabel}); no rise/set band.`;
    }
    if (result?.moonVisibilityState !== 'ordinary') {
        return 'Moon rise and set times unavailable for this date.';
    }
    const rise = eventDisplay(zone, result.moonriseMs, result.moonriseDayRelation);
    const set = eventDisplay(zone, result.moonsetMs, result.moonsetDayRelation);
    if (!rise || !set) return 'Moon rise and set times unavailable for this date.';
    const context = result.moonVisibilitySelection === 'active' ? 'Moon up now (gray band)'
        : result.moonVisibilitySelection === 'upcoming' ? 'Next Moon-up gray band'
            : 'Earlier Moon-up gray band';
    if (rise.label === set.label) {
        return `${context}: rise ${rise.clock}${rise.daySuffix} · set ${set.clock}${set.daySuffix} (${rise.label}).`;
    }
    return `${context}: rise ${rise.clock} ${rise.label}${rise.daySuffix} · set ${set.clock} ${set.label}${set.daySuffix}.`;
}

export function createSunCalculator<
    FrameHandle = number,
    StatusHandle = ReturnType<typeof setTimeout>,
>(options: SunCalculatorOptions<FrameHandle, StatusHandle> = {}): SunCalculator | null {
    const {
        mount,
        mode,
        onDateChange = () => {},
        onMinuteChange = () => {},
        requestFrame = (callback => requestAnimationFrame(callback)) as (callback: () => void) => FrameHandle,
        cancelFrame = (handle => cancelAnimationFrame(handle as unknown as number)) as (handle: FrameHandle) => void,
        statusDelayMs = 160,
        scheduleStatus = ((callback, delay) => setTimeout(callback, delay)) as (callback: () => void, delay: number) => StatusHandle,
        cancelStatus = (handle => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)) as (handle: StatusHandle) => void,
    } = options;

    if (!(mount instanceof Element) || (mode !== 'peak' && mode !== 'gpx')) return null;

    const id = `bpb-sun-panel-${nextId++}`;
    const root = element('section', `bpb-sun-calculator bpb-sun-calculator--${mode}`);
    root.dataset.theme = 'light';

    const toggle = element('button', 'bpb-sun-calculator__toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', id);
    const icon = sunIcon();
    const title = element('span', 'bpb-sun-calculator__title', 'Sun & Moon');
    const summary = element('span', 'bpb-sun-calculator__summary', 'Unavailable');
    const chevron = chevronIcon();
    toggle.append(icon, title, summary, chevron);
    const headerEvents = mode === 'gpx' ? element('span', 'bpb-sun-calculator__header-events') : null;
    const headerMessage = element('span', 'bpb-sun-calculator__header-message');
    const headerTimes = ['Sunrise', 'Sunset'].map(name => {
        const item = element('span', 'bpb-sun-calculator__header-event');
        const label = element('span', 'bpb-sun-calculator__header-label', name);
        const time = element('span', 'bpb-sun-calculator__header-time');
        item.append(label, time);
        return { item, label, time, name };
    });
    if (headerEvents) {
        headerEvents.append(...headerTimes.map(({ item }) => item), headerMessage);
        toggle.append(headerEvents);
    }
    const setHeaderEvents = (state: SunCalculatorState | null, message = '') => {
        if (!headerEvents) return;
        const displays = state?.zone && state?.result?.daylightState === 'ordinary'
            ? [eventDisplay(state.zone, state.result.sunriseMs, state.result.sunriseDayRelation),
                eventDisplay(state.zone, state.result.sunsetMs, state.result.sunsetDayRelation)]
            : [];
        const first = displays[0] ?? null;
        const second = displays[1] ?? null;
        const available = Boolean(first && second);
        headerMessage.hidden = available;
        headerMessage.textContent = available ? '' : message;
        headerTimes.forEach(({ item, label, time, name }, index) => {
            const display = index === 0 ? first : second;
            item.hidden = !available;
            label.textContent = display && available ? `${name}${display.daySuffix} · ${display.label}` : '';
            time.textContent = display && available ? display.clock : '';
            if (display && available) item.title = `${name} ${display.clock}${display.daySuffix} (${display.label}), level horizon`;
            else item.removeAttribute('title');
        });
    };

    const panel = element('div', 'bpb-sun-calculator__panel');
    panel.id = id;
    panel.hidden = true;

    const layout = element('div', 'bpb-sun-calculator__layout');
    const controls = element('div', 'bpb-sun-calculator__controls');
    const dateRow = element('div', 'bpb-sun-calculator__field');
    const dateLabel = element('label', 'bpb-sun-calculator__label', 'Date');
    const dateInput = mode === 'peak' ? element('input', 'bpb-sun-calculator__date') : null;
    const dateValue = dateInput ?? element('output', 'bpb-sun-calculator__date-value');
    if (dateInput) {
        dateInput.type = 'date';
        dateInput.id = `${id}-date`;
        dateLabel.htmlFor = dateInput.id;
    }
    const dateMeta = element('span', 'bpb-sun-calculator__meta');
    dateMeta.classList.add('bpb-sun-calculator__meta--date');
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
    timeMeta.classList.add('bpb-sun-calculator__meta--time');
    timeRow.append(timeLabel, timeValue, slider, timeMeta);
    controls.append(dateRow, timeRow);

    const reading = element('div', 'bpb-sun-calculator__reading');
    const compass = element('div', 'bpb-sun-calculator__compass');
    compass.setAttribute('aria-hidden', 'true');
    const compassRing = element('div', 'bpb-sun-calculator__compass-ring');
    const daylightRange = svgElement('svg') as HidableSvg;
    daylightRange.classList.add('bpb-sun-calculator__daylight-range');
    daylightRange.setAttribute('viewBox', '0 0 100 100');
    daylightRange.setAttribute('preserveAspectRatio', 'none');
    const daylightPath = svgElement('path');
    daylightPath.classList.add('bpb-sun-calculator__daylight-path');
    const sunriseMarker = svgElement('circle');
    sunriseMarker.classList.add('bpb-sun-calculator__daylight-endpoint',
        'bpb-sun-calculator__daylight-endpoint--sunrise');
    sunriseMarker.setAttribute('r', '2.5');
    const sunsetMarker = svgElement('circle');
    sunsetMarker.classList.add('bpb-sun-calculator__daylight-endpoint',
        'bpb-sun-calculator__daylight-endpoint--sunset');
    sunsetMarker.setAttribute('r', '2.5');
    daylightRange.append(daylightPath, sunriseMarker, sunsetMarker);
    const moonVisibilityRange = svgElement('svg') as HidableSvg;
    moonVisibilityRange.classList.add('bpb-sun-calculator__moon-visibility-range');
    moonVisibilityRange.setAttribute('viewBox', '0 0 100 100');
    moonVisibilityRange.setAttribute('preserveAspectRatio', 'none');
    moonVisibilityRange.hidden = true;
    const moonVisibilityPath = svgElement('path');
    moonVisibilityPath.classList.add('bpb-sun-calculator__moon-visibility-path');
    const moonriseMarker = svgElement('circle');
    moonriseMarker.classList.add('bpb-sun-calculator__moon-visibility-endpoint',
        'bpb-sun-calculator__moon-visibility-endpoint--rise');
    moonriseMarker.setAttribute('r', '2');
    const moonsetMarker = svgElement('circle');
    moonsetMarker.classList.add('bpb-sun-calculator__moon-visibility-endpoint',
        'bpb-sun-calculator__moon-visibility-endpoint--set');
    moonsetMarker.setAttribute('r', '2');
    moonVisibilityRange.append(moonVisibilityPath, moonriseMarker, moonsetMarker);
    compassRing.append(daylightRange, moonVisibilityRange);
    const center = element('span', 'bpb-sun-calculator__compass-center');
    const moonMarker = element('span', 'bpb-sun-calculator__moon-marker');
    const moonMarkerDisc = element('span', 'bpb-sun-calculator__moon-marker-disc');
    moonMarker.hidden = true;
    moonMarker.append(moonMarkerDisc);
    const sun = element('span', 'bpb-sun-calculator__sun');
    const sunDisc = element('span', 'bpb-sun-calculator__sun-disc');
    sun.append(sunDisc);
    const cardinals = new Map<number, { cardinal: HTMLSpanElement; label: HTMLSpanElement }>();
    for (const [labelText, azimuth] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
        const cardinal = element('span', 'bpb-sun-calculator__cardinal');
        const cardinalLabel = element('span', 'bpb-sun-calculator__cardinal-label', labelText);
        cardinal.dataset.azimuth = String(azimuth);
        cardinal.append(cardinalLabel);
        cardinals.set(azimuth, { cardinal, label: cardinalLabel });
        compassRing.append(cardinal);
    }
    compassRing.append(moonMarker, sun, center);
    compass.append(compassRing);

    const facts = element('div', 'bpb-sun-calculator__facts');
    const direction = element('div', 'bpb-sun-calculator__direction');
    const directionLabel = element('span', 'bpb-sun-calculator__fact-label', 'Sun direction');
    const directionValue = element('strong', 'bpb-sun-calculator__fact-value');
    direction.append(directionLabel, directionValue);
    const elevationFact = element('div', 'bpb-sun-calculator__elevation');
    const elevationLabel = element('span', 'bpb-sun-calculator__fact-label', 'Sun elevation');
    const elevationValue = element('strong', 'bpb-sun-calculator__fact-value');
    elevationFact.append(elevationLabel, elevationValue);
    const moonFact = element('div', 'bpb-sun-calculator__moon');
    const moonLabel = element('span', 'bpb-sun-calculator__fact-label', 'Moon phase');
    const moonValue = element('strong', 'bpb-sun-calculator__fact-value bpb-sun-calculator__moon-value');
    const moonIcon = element('span', 'bpb-sun-calculator__moon-icon');
    moonIcon.setAttribute('aria-hidden', 'true');
    const moonName = element('span', 'bpb-sun-calculator__moon-name');
    moonValue.append(moonIcon, moonName);
    const moonIllumination = element('span',
        'bpb-sun-calculator__fact-detail bpb-sun-calculator__moon-illumination');
    const moonPositionDetail = element('span',
        'bpb-sun-calculator__fact-detail bpb-sun-calculator__moon-position');
    const moonDirection = element('span', 'bpb-sun-calculator__moon-direction');
    const moonPositionSeparator = element('span', 'bpb-sun-calculator__moon-position-separator', ' · ');
    moonPositionSeparator.setAttribute('aria-hidden', 'true');
    moonPositionSeparator.hidden = true;
    const moonElevation = element('span', 'bpb-sun-calculator__moon-elevation');
    moonPositionDetail.append(moonDirection, moonPositionSeparator, moonElevation);
    moonFact.append(moonLabel, moonValue, moonIllumination, moonPositionDetail);
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
    const moonEventsText = element('span', 'bpb-sun-calculator__moon-events-text');
    events.append(eventsText, eventsVisual, moonEventsText);

    const limitation = element('p', 'bpb-sun-calculator__limitation',
        'Astronomical Sun and Moon positions. Nearby terrain may block either object from view.');
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
    let frameHandle: FrameHandle | null = null;
    let framePending = false;
    let pendingCompass: PendingCompass | null = null;
    let previewFrameHandle: FrameHandle | null = null;
    let previewFramePending = false;
    let pendingMinute: number | null = null;
    let unboundedBearing: number | null = null;
    let unboundedSunAzimuth: number | null = null;
    let unboundedMoonAzimuth: number | null = null;
    let statusTimer: StatusHandle | null = null;
    let announcedText = '';
    let appliedInitialExpansion = false;

    const setSliderMinute = (minute: number) => {
        slider.value = String(minute);
        slider.style.setProperty('--bpb-sun-progress', `${minute / 1439 * 100}%`);
    };

    const applyCompass = () => {
        framePending = false;
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
        for (const [worldAzimuth, { cardinal, label }] of cardinals) {
            const angle = worldAzimuth - unboundedBearing;
            cardinal.style.transform = `rotate(${angle}deg)`;
            label.style.transform = `translateX(-50%) rotate(${-angle}deg)`;
        }
        const arc = daylightArc(next);
        daylightRange.hidden = !arc;
        if (arc) {
            daylightPath.setAttribute('d', arc.d);
            sunriseMarker.setAttribute('cx', arc.start.x.toFixed(3));
            sunriseMarker.setAttribute('cy', arc.start.y.toFixed(3));
            sunsetMarker.setAttribute('cx', arc.end.x.toFixed(3));
            sunsetMarker.setAttribute('cy', arc.end.y.toFixed(3));
            daylightRange.style.transform = `rotate(${-unboundedBearing}deg)`;
        }
        const moonArc = moonVisibilityArc(next);
        moonVisibilityRange.hidden = !moonArc;
        if (moonArc) {
            moonVisibilityPath.setAttribute('d', moonArc.d);
            moonriseMarker.setAttribute('cx', moonArc.start.x.toFixed(3));
            moonriseMarker.setAttribute('cy', moonArc.start.y.toFixed(3));
            moonsetMarker.setAttribute('cx', moonArc.end.x.toFixed(3));
            moonsetMarker.setAttribute('cy', moonArc.end.y.toFixed(3));
            moonVisibilityRange.style.transform = `rotate(${-unboundedBearing}deg)`;
        }
        const sunAzimuth = next.sunAzimuth;
        sun.hidden = !isFiniteNumber(sunAzimuth);
        if (isFiniteNumber(sunAzimuth)) {
            const normalizedAzimuth = SunPosition.normalizeDegrees(sunAzimuth);
            if (unboundedSunAzimuth === null) unboundedSunAzimuth = normalizedAzimuth;
            else {
                const current = SunPosition.normalizeDegrees(unboundedSunAzimuth);
                const delta = ((normalizedAzimuth - current + 540) % 360) - 180;
                unboundedSunAzimuth += delta;
            }
            const angle = unboundedSunAzimuth - unboundedBearing;
            sun.style.transform = `rotate(${angle}deg)`;
        }
        const moonAzimuth = next.moonAzimuth;
        moonMarker.hidden = !isFiniteNumber(moonAzimuth);
        if (!isFiniteNumber(moonAzimuth)) unboundedMoonAzimuth = null;
        else {
            const normalizedAzimuth = SunPosition.normalizeDegrees(moonAzimuth);
            if (unboundedMoonAzimuth === null) unboundedMoonAzimuth = normalizedAzimuth;
            else {
                const current = SunPosition.normalizeDegrees(unboundedMoonAzimuth);
                const delta = ((normalizedAzimuth - current + 540) % 360) - 180;
                unboundedMoonAzimuth += delta;
            }
            const angle = unboundedMoonAzimuth - unboundedBearing;
            moonMarker.style.transform = `rotate(${angle}deg)`;
            moonMarkerDisc.style.transform = `rotate(${-angle}deg)`;
        }
    };

    const scheduleCompass = (state: SunCalculatorState | null | undefined) => {
        pendingCompass = {
            bearing: isFiniteNumber(state?.mapBearing) ? state.mapBearing : 0,
            sunAzimuth: state?.result?.azimuthDeg,
            moonAzimuth: state?.result?.moonAzimuthDeg,
            sunriseAzimuthDeg: state?.result?.sunriseAzimuthDeg,
            solarNoonAzimuthDeg: state?.result?.solarNoonAzimuthDeg,
            sunsetAzimuthDeg: state?.result?.sunsetAzimuthDeg,
            moonriseAzimuthDeg: state?.result?.moonriseAzimuthDeg,
            moonVisibleMidpointAzimuthDeg: state?.result?.moonVisibleMidpointAzimuthDeg,
            moonsetAzimuthDeg: state?.result?.moonsetAzimuthDeg,
        };
        if (frameHandle !== null || framePending) return;
        framePending = true;
        const handle = requestFrame(applyCompass);
        if (framePending) {
            framePending = false;
            frameHandle = handle;
        }
    };

    const announce = (text: string) => {
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
        moonDirection.textContent = '';
        moonElevation.textContent = '';
        moonPositionDetail.removeAttribute('aria-label');
        moonPositionSeparator.hidden = true;
        moonIcon.textContent = '';
        moonName.textContent = '';
        moonIllumination.textContent = '';
        delete root.dataset.moonPhase;
        delete root.dataset.moonVisibility;
        delete root.dataset.moonVisibilitySelection;
    };
    const setExpanded = (expanded: boolean) => {
        if (toggle.disabled) return;
        toggle.setAttribute('aria-expanded', String(expanded));
        panel.hidden = !expanded;
    };
    const applyInitialExpansion = () => {
        if (appliedInitialExpansion) return;
        appliedInitialExpansion = true;
        if (mode === 'peak') setExpanded(true);
    };

    const setLayoutPresentation = ({ hidden = false, placeholder = false } = {}) => {
        layout.hidden = hidden;
        layout.inert = placeholder;
        if (placeholder) layout.setAttribute('aria-hidden', 'true');
        else layout.removeAttribute('aria-hidden');
        if (placeholder) root.dataset.layoutState = 'placeholder';
        else delete root.dataset.layoutState;
    };

    const showUnavailable = (
        message?: string | null,
        { expandable = false, summaryText = 'Unavailable' }: { expandable?: boolean; summaryText?: string } = {},
    ) => {
        const text = message || 'Sun position is unavailable.';
        const reserveLayout = mode === 'gpx' && expandable;
        summary.textContent = summaryText;
        summary.removeAttribute('title');
        setHeaderEvents(null, 'Rise and set times unavailable');
        setLayoutPresentation({ hidden: !reserveLayout, placeholder: reserveLayout });
        controls.hidden = false;
        reading.hidden = false;
        empty.hidden = false;
        empty.textContent = text;
        directionValue.textContent = '';
        elevationValue.textContent = '';
        elevationFact.hidden = true;
        clearMoon();
        eventsText.textContent = '';
        moonEventsText.textContent = '';
        events.classList.remove('bpb-sun-calculator__events--text');
        eventsVisual.hidden = true;
        if (dateInput) dateInput.value = '';
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
        moonMarker.classList.remove('bpb-sun-calculator__moon-marker--below-horizon');
        eventMarker.hidden = true;
        slider.style.setProperty('--bpb-sun-progress', '0%');
        if (dateInput) dateInput.disabled = true;
        scheduleCompass(null);
        announce(text);
    };
    const showSubjectUnavailable = (message?: string | null) => showUnavailable(message, {
        expandable: mode === 'gpx',
    });

    const showRecoverable = (
        state: SunCalculatorState,
        message = 'Sun position is unavailable for this date and time.',
    ) => {
        summary.textContent = 'Unavailable for this date and time';
        summary.removeAttribute('title');
        setHeaderEvents(null, 'Rise and set times unavailable');
        toggle.disabled = false;
        applyInitialExpansion();
        setLayoutPresentation();
        controls.hidden = false;
        reading.hidden = true;
        empty.hidden = false;
        empty.textContent = message;
        directionValue.textContent = '';
        elevationValue.textContent = '';
        elevationFact.hidden = true;
        clearMoon();
        eventsText.textContent = '';
        moonEventsText.textContent = '';
        eventsVisual.hidden = true;
        events.classList.remove('bpb-sun-calculator__events--text');
        const dateText = typeof state?.date === 'string' ? state.date : null;
        const hasDate = dateText !== null;
        const minute = state?.minute;
        const hasMinute = validMinute(minute);
        if (dateInput) {
            dateInput.disabled = !hasDate;
            dateInput.value = dateText ?? '';
        } else dateValue.textContent = dateText ?? '';
        dateMeta.textContent = mode === 'peak' ? '' : state?.dateSource || '';
        slider.disabled = !hasDate || !hasMinute;
        if (hasMinute) {
            setSliderMinute(minute);
            const instantMs = state?.instant?.ms;
            const hasInstantMs = isFiniteNumber(instantMs);
            const clock = hasInstantMs && state?.zone
                ? MountainTime.formatClock(state.zone, instantMs)
                : null;
            const label = hasInstantMs && state?.zone
                ? MountainTime.zoneLabel(state.zone, instantMs)
                : null;
            timeValue.textContent = clock || MountainTime.formatCivilClock(minute) || '';
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

    const render = (state: SunCalculatorState | null | undefined) => {
        if (disposed) return;
        if (!state?.result || !state.zone || !state.date
            || typeof state.minute !== 'number' || !Number.isInteger(state.minute)) {
            if (state?.availability === 'recoverable' && state?.subject && state?.zone) {
                showRecoverable(state, state.unavailable ?? undefined);
            } else showSubjectUnavailable(state?.unavailable);
            return;
        }
        const instantMs = state.instant?.ms;
        if (!isFiniteNumber(instantMs)) {
            showRecoverable(state, 'Sun position is unavailable for this date and time.');
            return;
        }
        const clock = MountainTime.formatClock(state.zone, instantMs);
        const label = MountainTime.zoneLabel(state.zone, instantMs);
        if (!clock || !label) {
            showRecoverable(state, 'Sun position is unavailable for this date and time.');
            return;
        }

        toggle.disabled = false;
        applyInitialExpansion();
        setLayoutPresentation();
        controls.hidden = false;
        reading.hidden = false;
        empty.hidden = true;
        empty.textContent = '';
        slider.disabled = false;
        setSliderMinute(state.minute);
        slider.setAttribute('aria-valuetext', `${clock} ${label}`);
        if (dateInput) {
            dateInput.disabled = false;
            dateInput.value = state.date;
        } else dateValue.textContent = state.date;
        dateMeta.textContent = mode === 'peak' ? '' : state.dateSource ?? '';
        timeValue.textContent = clock;
        const zoneText = MountainTime.zoneDescription(state.zone, instantMs) || label;
        timeMeta.textContent = mode === 'peak' ? zoneText : `${state.timeSource} · ${zoneText}`;

        const azimuth = roundedDegrees(state.result.azimuthDeg);
        const elevation = elevationText(state.result.elevationDeg);
        root.dataset.horizon = state.result.isAboveHorizon ? 'above' : 'below';
        root.dataset.daylight = state.result.daylightState;
        sun.classList.toggle('bpb-sun-calculator__sun--below-horizon',
            !state.result.isAboveHorizon);
        const positionSummary = `${azimuth} ${state.result.directionLabel} · ${elevation}`;
        const dateSummary = mode === 'gpx' ? compactDate(state.date) : '';
        summary.textContent = mode === 'gpx'
            ? `${dateSummary} · ${state.contextLabel || 'Selected point'} · ${positionSummary}`
            : positionSummary;
        summary.title = mode === 'gpx' ? `${state.date} · ${summary.textContent}` : positionSummary;
        directionValue.textContent = `${azimuth} ${state.result.directionLabel}`;
        elevationFact.hidden = false;
        elevationValue.textContent = elevation;
        const moonPosition = moonPositionDisplay(state.result);
        const moonPhaseDisplayValue = moonPhaseDisplay(state.result);
        moonDirection.textContent = moonPosition?.direction || 'Position unavailable';
        moonElevation.textContent = moonPosition?.elevation || '';
        moonPositionDetail.setAttribute('aria-label', moonPosition
            ? `${moonPosition.direction}, ${moonPosition.elevation}`
            : 'Moon position unavailable');
        moonPositionSeparator.hidden = !moonPosition;
        moonMarker.classList.toggle('bpb-sun-calculator__moon-marker--below-horizon',
            moonPosition !== null && !moonPosition.isAboveHorizon);
        if (moonPhaseDisplayValue) {
            moonIcon.textContent = moonPhaseDisplayValue.icon;
            moonName.textContent = moonPhaseDisplayValue.label;
            moonIllumination.textContent = moonPhaseDisplayValue.illumination;
            root.dataset.moonPhase = String(state.result.moonPhaseIndex);
        } else {
            moonIcon.textContent = '';
            moonName.textContent = 'Phase unavailable';
            moonIllumination.textContent = '';
            delete root.dataset.moonPhase;
        }
        const moonPositionAnnouncement = moonPosition?.announcement || 'Moon position unavailable';
        const moonPhaseAnnouncement = moonPhaseDisplayValue?.announcement || 'Moon phase unavailable';
        const moonEventsAnnouncement = moonEventSummary(state.zone, state.result, label);
        moonEventsText.textContent = moonEventsAnnouncement;
        root.dataset.moonVisibility = state.result.moonVisibilityState || 'unavailable';
        root.dataset.moonVisibilitySelection = state.result.moonVisibilitySelection || 'unavailable';
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
                setHeaderEvents(null, eventsText.textContent);
                scheduleCompass(state);
                announce(`${summary.textContent}. ${moonPositionAnnouncement}. ${moonPhaseAnnouncement}. ${moonEventsAnnouncement} ${eventsText.textContent}`);
                return;
            }
            eventsText.textContent = eventDetails.text;
            sunrise.textContent = eventDetails.sunriseText;
            sunset.textContent = eventDetails.sunsetText;
            const daylightMs = eventDetails.sunsetMs - eventDetails.sunriseMs;
            const inDaylight = daylightMs > 0 && instantMs >= eventDetails.sunriseMs
                && instantMs <= eventDetails.sunsetMs;
            const progress = inDaylight
                ? (instantMs - eventDetails.sunriseMs) / daylightMs
                : 0;
            eventMarker.style.insetInlineStart = `${progress * 100}%`;
            eventMarker.hidden = !inDaylight;
            eventsVisual.hidden = false;
        }
        setHeaderEvents(state, eventsText.textContent);
        scheduleCompass(state);
        announce(`${summary.textContent}. ${moonPositionAnnouncement}. ${moonPhaseAnnouncement}. ${moonEventsAnnouncement} ${eventsText.textContent}`);
    };
    const onToggle = () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true');
    const onDateInput = () => {
        if (dateInput) onDateChange(dateInput.value);
    };
    const applyPreviewMinute = () => {
        previewFramePending = false;
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
        if (previewFrameHandle !== null || previewFramePending) return;
        // Keep this correct under synchronous frame stubs as well as browsers.
        previewFramePending = true;
        const handle = requestFrame(applyPreviewMinute);
        if (previewFramePending) {
            previewFramePending = false;
            previewFrameHandle = handle;
        }
    };
    toggle.addEventListener('click', onToggle);
    if (dateInput) dateInput.addEventListener('change', onDateInput);
    slider.addEventListener('input', onTimeInput);
    showUnavailable('Sun position is unavailable.');

    return Object.freeze({
        element: root,
        render,
        setSubject: render,
        setPreviewMinute: (minute: number | null | undefined) => {
            if (validMinute(minute)) setSliderMinute(minute);
        },
        setMapBearing: (state: SunCalculatorState | null | undefined) => scheduleCompass(state),
        setTheme: (theme?: string | null) => { root.dataset.theme = theme === 'dark' ? 'dark' : 'light'; },
        setUnavailable: showUnavailable,
        setPrompt: (message?: string | null) => showUnavailable(message, {
            expandable: mode === 'gpx',
            summaryText: mode === 'gpx' ? 'Select a chart point' : 'Unavailable',
        }),
        setExpanded,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            toggle.removeEventListener('click', onToggle);
            if (dateInput) dateInput.removeEventListener('change', onDateInput);
            slider.removeEventListener('input', onTimeInput);
            framePending = false;
            previewFramePending = false;
            if (frameHandle !== null) cancelFrame(frameHandle);
            if (previewFrameHandle !== null) cancelFrame(previewFrameHandle);
            if (statusTimer !== null) cancelStatus(statusTimer);
            root.remove();
        },
    });
}

const validMinute = (minute: unknown): minute is number =>
    typeof minute === 'number' && Number.isInteger(minute) && minute >= 0 && minute <= 1439;

export const sunCalculator = Object.freeze({ create: createSunCalculator });
