// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { sunCalculator as SunCalculator } from '../../src/sun/sun-calculator.js';
import { mountainTime as MountainTime } from '../../src/time/mountain-time.js';
import { sunPosition as SunPosition } from '../../src/sun/sun-position.js';

const css = await readFile(new URL('../../src/sun/sun-calculator.css', import.meta.url), 'utf8');

function withDom(callback, { width = 798 } = {}) {
    const dom = new JSDOM('<!doctype html><body><main id="mount"></main></body>', {
        url: 'https://www.peakbagger.com/Peak.aspx?pid=1',
        pretendToBeVisual: true,
    });
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: width });
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        Element: globalThis.Element,
    };
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Element = dom.window.Element;
    try {
        return callback(dom);
    } finally {
        globalThis.window = previous.window;
        globalThis.document = previous.document;
        globalThis.Element = previous.Element;
        dom.window.close();
    }
}

const ordinaryState = ({
    elevationDeg = 17.2,
    azimuthDeg = 281.6,
    directionLabel = 'WNW',
    mapBearing = 0,
    zone = MountainTime.resolve(39.7392, -104.9903),
    date = '2026-07-10',
    minute = 13 * 60,
    daylightState = 'ordinary',
    moonAzimuthDeg = 315.2,
    moonDirectionLabel = 'NW',
    moonElevationDeg = 24.1,
    moonIlluminationFraction = 0.186,
    moonPhaseIndex = 7,
    moonPhaseLabel = 'Waning Crescent',
} = {}) => {
    const instant = MountainTime.civilToInstant(zone, date, minute);
    return {
        mode: 'peak',
        subject: { lat: 39.7392, lon: -104.9903 },
        zone, date, minute, instant,
        dateSource: 'GPX point',
        timeSource: 'Recorded at selected GPX point',
        mapBearing,
        result: {
            azimuthDeg,
            directionLabel,
            elevationDeg,
            isAboveHorizon: elevationDeg >= 0,
            screenAzimuthDeg: ((azimuthDeg - mapBearing) % 360 + 360) % 360,
            moonAzimuthDeg,
            moonDirectionLabel,
            moonElevationDeg,
            moonIsAboveHorizon: moonElevationDeg >= 0,
            moonScreenAzimuthDeg: ((moonAzimuthDeg - mapBearing) % 360 + 360) % 360,
            solarNoonAzimuthDeg: 180,
            sunriseMs: MountainTime.civilToInstant(zone, date, 5 * 60 + 30).ms,
            sunriseAzimuthDeg: 60,
            sunriseDate: date,
            sunriseDayRelation: 'same-day',
            sunsetMs: MountainTime.civilToInstant(zone, date, 20 * 60 + 30).ms,
            sunsetAzimuthDeg: 300,
            sunsetDate: date,
            sunsetDayRelation: 'same-day',
            daylightState,
            moonIlluminationFraction,
            moonPhase: 0.858,
            moonPhaseIndex,
            moonPhaseLabel,
        },
        unavailable: null,
        availability: 'ready',
    };
};

const timeValueText = root => root.querySelector('.bpb-sun-calculator__clock').textContent;
const rotationAngle = element => Number(
    /^rotate\((-?[\d.]+)deg\)$/.exec(element?.style.transform || '')?.[1],
);

test('Peak calculator opens once by default, stays user-collapsible, and emits only time actions', () => withDom(dom => {
    const dates = [];
    const minutes = [];
    const frames = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'),
        mode: 'peak',
        onDateChange: value => dates.push(value),
        onMinuteChange: value => minutes.push(value),
        requestFrame: callback => { frames.push(callback); return frames.length; },
        cancelFrame: () => {},
    });
    const button = calculator.element.querySelector('.bpb-sun-calculator__toggle');
    const panel = calculator.element.querySelector('.bpb-sun-calculator__panel');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-controls'), panel.id);
    assert.equal(panel.hidden, true);

    const state = ordinaryState();
    calculator.render(state);
    frames.shift()();
    assert.equal(button.disabled, false);
    assert.match(button.textContent, /Sun & Moon/);
    assert.match(button.textContent, /282° WNW · 17° above horizon/);
    assert.ok(button.querySelector('.bpb-sun-calculator__icon'));
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.hidden, false);
    button.click();
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(panel.hidden, true);
    calculator.render(ordinaryState({ minute: 13 * 60 + 1 }));
    frames.shift()();
    assert.equal(button.getAttribute('aria-expanded'), 'false',
        'a later render must not override the user collapsing the calculator');
    button.click();
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.hidden, false);
    assert.match(css, /aria-expanded="true"[^}]*chevron[^}]*rotate\(180deg\)/s);

    const date = calculator.element.querySelector('input[type="date"]');
    const slider = calculator.element.querySelector('input[type="range"]');
    date.value = '2026-07-11';
    date.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    slider.value = '825';
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.deepEqual(dates, ['2026-07-11']);
    assert.deepEqual(minutes, [], 'slider astronomy waits for the next frame');
    assert.match(timeValueText(calculator.element), /1:45\s*PM/i,
        'the visible wall clock follows the thumb immediately');
    frames.shift()();
    assert.deepEqual(minutes, [825]);
    assert.equal(slider.min, '0');
    assert.equal(slider.max, '1439');
    assert.match(slider.getAttribute('aria-valuetext'), /1:45\s*PM/i);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__direction strong').textContent,
        '282° WNW');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__elevation strong').textContent,
        '17° above horizon');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-direction').textContent,
        '315° NW');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-elevation').textContent,
        '24° above horizon');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon .bpb-sun-calculator__fact-label').textContent,
        'Moon phase');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-name').textContent,
        'Waning Crescent');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-illumination').textContent,
        '19% illuminated');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-icon').textContent, '🌘');
    assert.ok(calculator.element.querySelector('.bpb-sun-calculator__moon-value')
        .contains(calculator.element.querySelector('.bpb-sun-calculator__moon-name')),
    'Moon phase remains the primary value');
    assert.ok(calculator.element.querySelector('.bpb-sun-calculator__moon-position')
        .classList.contains('bpb-sun-calculator__fact-detail'),
    'Moon direction and elevation use the supporting-detail size');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-position')
        .getAttribute('aria-label'), '315° NW, 24° above horizon');
    const moonMarker = calculator.element.querySelector('.bpb-sun-calculator__moon-marker');
    assert.equal(moonMarker.hidden, false);
    assert.ok(Math.abs(rotationAngle(moonMarker) - 315.2) < 0.001);
    assert.equal(calculator.element.dataset.moonPhase, '7');
    assert.equal(calculator.element.querySelectorAll('.bpb-sun-calculator__event-time').length, 2);
    assert.match(calculator.element.querySelector('.bpb-sun-calculator__event-marker').style.insetInlineStart,
        /%$/);
    assert.match(calculator.element.textContent, /Astronomical Sun and Moon positions/);
}));

test('slider value text follows authoritative ordinary, gap, fold, and estimated clocks', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    const slider = calculator.element.querySelector('input[type="range"]');
    const label = calculator.element.querySelector('label[for="' + slider.id + '"]');
    assert.equal(label.textContent, 'Mountain time');
    assert.deepEqual([slider.min, slider.max, slider.step], ['0', '1439', '1']);

    const denver = MountainTime.resolve(39.7392, -104.9903);
    for (const [date, requestedMinute, expectedMinute, expected] of [
        ['2026-07-10', 13 * 60, 13 * 60, /1:00\s*PM MDT/i],
        ['2026-03-08', 2 * 60 + 30, 3 * 60, /3:00\s*AM MDT/i],
        ['2026-11-01', 1 * 60 + 30, 1 * 60 + 30, /1:30\s*AM MDT/i],
    ]) {
        const instant = MountainTime.civilToInstant(denver, date, requestedMinute);
        const result = SunPosition.calculate({
            lat: 39.7392, lon: -104.9903, ms: instant.ms, date: instant.date, zone: denver,
        });
        calculator.render({
            ...ordinaryState({ zone: denver, date: instant.date, minute: instant.minute }),
            instant, result,
        });
        assert.equal(slider.value, String(expectedMinute));
        assert.match(slider.getAttribute('aria-valuetext'), expected);
    }

    const estimated = Object.freeze({ timeZone: null, offsetMs: -8 * 3_600_000, estimated: true });
    calculator.render(ordinaryState({ zone: estimated, minute: 9 * 60 + 15 }));
    assert.match(slider.getAttribute('aria-valuetext'), /9:15\s*AM UTC−8, estimated from longitude/i);
}));

test('live status cancels stale text before duplicate checks and disposal', () => withDom(dom => {
    let nextTimer = 1;
    const timers = new Map();
    const cancelled = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
        scheduleStatus: callback => {
            const id = nextTimer++;
            timers.set(id, callback);
            return id;
        },
        cancelStatus: id => {
            cancelled.push(id);
            timers.delete(id);
        },
    });
    const status = calculator.element.querySelector('[role="status"]');
    const publishOnlyTimer = () => {
        assert.equal(timers.size, 1);
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        callback();
    };
    const a = ordinaryState({ azimuthDeg: 100, directionLabel: 'E' });
    const b = ordinaryState({ azimuthDeg: 200, directionLabel: 'SSW' });
    const c = ordinaryState({ azimuthDeg: 300, directionLabel: 'WNW' });
    calculator.render(a);
    publishOnlyTimer();
    assert.match(status.textContent, /100° E/);

    calculator.render(b);
    calculator.render(a);
    assert.equal(timers.size, 0, 'returning to published A cancels pending B');
    assert.match(status.textContent, /100° E/);

    calculator.render(b);
    calculator.render(c);
    publishOnlyTimer();
    assert.match(status.textContent, /300° WNW/);
    assert.doesNotMatch(status.textContent, /200° SSW/);

    calculator.render(b);
    calculator.dispose();
    assert.equal(timers.size, 0);
    assert.ok(cancelled.length >= 3);
}));

test('rapid slider input publishes only the final minute and cancels pending work on disposal', () => withDom(dom => {
    const frames = [];
    const cancelled = [];
    const minutes = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        onMinuteChange: minute => minutes.push(minute),
        requestFrame: callback => { frames.push(callback); return frames.length; },
        cancelFrame: handle => cancelled.push(handle),
    });
    calculator.render(ordinaryState());
    frames.shift()();
    const slider = calculator.element.querySelector('input[type="range"]');
    for (const minute of [1, 600, 825, 1439]) {
        slider.value = String(minute);
        slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    assert.equal(frames.length, 1, 'one calculation frame is pending');
    assert.equal(slider.value, '1439');
    assert.match(timeValueText(calculator.element), /11:59\s*PM/i);
    frames.shift()();
    assert.deepEqual(minutes, [1439], 'the final minute wins');

    slider.value = '300';
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    calculator.dispose();
    assert.ok(cancelled.length >= 1);
    frames.shift()();
    assert.deepEqual(minutes, [1439], 'disposed calculators publish no pending minute');
}));

test('GPX calculator has no date picker and honestly renders sources, below-horizon, and polar states', () => withDom(dom => {
    const frames = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'),
        mode: 'gpx',
        requestFrame: callback => { frames.push(callback); return frames.length; },
        cancelFrame: () => {},
    });
    calculator.render(ordinaryState({ elevationDeg: -4.6, moonElevationDeg: -2.4 }));
    frames.shift()();
    assert.equal(calculator.element.querySelector('input[type="date"]'), null);
    assert.match(calculator.element.textContent, /Sun & Moon at selected point/);
    assert.match(calculator.element.textContent, /5° below horizon/);
    assert.match(calculator.element.textContent, /GPX point/);
    assert.match(calculator.element.textContent,
        /Recorded at selected GPX point · Mountain Daylight Time \(MDT\)/);
    assert.match(calculator.element.textContent, /Level-horizon sunrise/);
    assert.equal(calculator.element.dataset.horizon, 'below');
    assert.equal(calculator.element.dataset.daylight, 'ordinary');
    assert.ok(calculator.element.querySelector('.bpb-sun-calculator__sun--below-horizon'));
    assert.ok(calculator.element.querySelector('.bpb-sun-calculator__moon-marker--below-horizon'));

    calculator.render(ordinaryState({ daylightState: 'polar-night' }));
    assert.match(calculator.element.textContent, /does not rise.*polar night/i);
    assert.equal(calculator.element.dataset.daylight, 'polar-night');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__event-marker').hidden, true);
}));

test('daylight progress is visible only from exact sunrise through exact sunset', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    const marker = calculator.element.querySelector('.bpb-sun-calculator__event-marker');
    for (const [minute, hidden, progress] of [
        [5 * 60 + 29, true, null],
        [5 * 60 + 30, false, '0%'],
        [13 * 60, false, '50%'],
        [20 * 60 + 30, false, '100%'],
        [20 * 60 + 31, true, null],
    ]) {
        calculator.render(ordinaryState({ minute }));
        assert.equal(marker.hidden, hidden, `marker visibility at minute ${minute}`);
        if (progress !== null) assert.equal(marker.style.insetInlineStart, progress);
    }
    calculator.render(ordinaryState({ daylightState: 'polar-day' }));
    assert.equal(calculator.element.dataset.daylight, 'polar-day');
    assert.equal(marker.hidden, true);
}));

test('compass draws the daylight direction range through solar noon and rotates it with the map', () => withDom(dom => {
    const frames = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { frames.push(callback); return frames.length; },
        cancelFrame: () => {},
    });
    const range = calculator.element.querySelector('.bpb-sun-calculator__daylight-range');
    const path = calculator.element.querySelector('.bpb-sun-calculator__daylight-path');
    const moonMarker = calculator.element.querySelector('.bpb-sun-calculator__moon-marker');

    calculator.render(ordinaryState());
    frames.shift()();
    assert.equal(range.hidden, false);
    assert.match(path.getAttribute('d'), / A 37 37 0 1 1 /,
        'Denver daylight follows the long clockwise arc through the southern sky');
    assert.equal(range.querySelectorAll('.bpb-sun-calculator__daylight-endpoint').length, 2);
    assert.ok(Math.abs(rotationAngle(moonMarker) - 315.2) < 0.001);

    calculator.render(ordinaryState({
        mapBearing: 25,
        azimuthDeg: 10,
        directionLabel: 'N',
    }));
    frames.shift()();
    assert.equal(range.style.transform, 'rotate(-25deg)');
    assert.ok(Math.abs(rotationAngle(moonMarker) - 290.2) < 0.001);

    const equatorial = ordinaryState();
    calculator.render({
        ...equatorial,
        result: {
            ...equatorial.result,
            sunriseAzimuthDeg: 66,
            solarNoonAzimuthDeg: 0,
            sunsetAzimuthDeg: 294,
        },
    });
    frames.shift()();
    assert.match(path.getAttribute('d'), / A 37 37 0 0 0 /,
        'a northern midday Sun chooses the counterclockwise arc across north');

    const unavailable = ordinaryState();
    calculator.render({
        ...unavailable,
        result: {
            ...unavailable.result,
            sunriseAzimuthDeg: null,
            solarNoonAzimuthDeg: null,
            sunsetAzimuthDeg: null,
            daylightState: 'unavailable',
        },
    });
    frames.shift()();
    assert.equal(range.hidden, true);
}));

test('event clocks own their DST labels and adjacent-day relation', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    const denver = MountainTime.resolve(39.7392, -104.9903);
    for (const [date, minute, selectedLabel, eventLabel] of [
        ['2026-03-08', 90, 'MST', 'MDT'],
        ['2026-03-08', 210, 'MDT', 'MDT'],
        ['2026-11-01', 30, 'MDT', 'MST'],
        ['2026-11-01', 150, 'MST', 'MST'],
    ]) {
        const instant = MountainTime.civilToInstant(denver, date, minute);
        const result = SunPosition.calculate({
            lat: 39.7392, lon: -104.9903, ms: instant.ms, date, zone: denver,
        });
        calculator.render({ ...ordinaryState({ zone: denver, date, minute }), instant, result });
        assert.match(calculator.element.querySelectorAll('.bpb-sun-calculator__meta')[1].textContent,
            new RegExp(selectedLabel));
        const text = calculator.element.querySelector('.bpb-sun-calculator__events-text').textContent;
        assert.match(text, new RegExp(`sunrise .*${eventLabel}`));
        if (selectedLabel !== eventLabel) {
            assert.doesNotMatch(text, new RegExp(`\\(${selectedLabel}\\)$`),
                'a selected-time label from another offset must not own the events');
        }
    }

    const denali = MountainTime.resolve(63.0695, -151.0074);
    const date = '2026-06-21';
    const instant = MountainTime.civilToInstant(denali, date, 12 * 60);
    const result = SunPosition.calculate({
        lat: 63.0695, lon: -151.0074, ms: instant.ms, date, zone: denali,
    });
    calculator.render({ ...ordinaryState({ zone: denali, date }), instant, result });
    assert.match(calculator.element.querySelector('.bpb-sun-calculator__events-text').textContent,
        /sunset .*\(next day\).*\(AKDT\)$/);
}));

test('finite position remains visible when rise and set metadata is unavailable', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    const state = ordinaryState();
    calculator.render({
        ...state,
        result: {
            ...state.result,
            solarNoonMs: null,
            sunriseMs: null,
            sunsetMs: null,
            daylightState: 'unavailable',
        },
    });
    assert.match(calculator.element.querySelector('.bpb-sun-calculator__summary').textContent, /282° WNW/);
    assert.match(calculator.element.textContent, /Rise and set times unavailable for this date/);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__layout').hidden, false);
}));

test('finite Sun and Moon positions remain visible when Moon phase metadata is unavailable', () => withDom(dom => {
    const frames = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { frames.push(callback); return frames.length; }, cancelFrame: () => {},
    });
    const state = ordinaryState();
    calculator.render({
        ...state,
        result: {
            ...state.result,
            moonIlluminationFraction: null,
            moonPhase: null,
            moonPhaseIndex: null,
            moonPhaseLabel: null,
        },
    });
    frames.shift()();
    assert.match(calculator.element.querySelector('.bpb-sun-calculator__summary').textContent, /282° WNW/);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-direction').textContent,
        '315° NW');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-name').textContent,
        'Phase unavailable');
    assert.equal(calculator.element.dataset.moonPhase, undefined);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-marker').hidden, false);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__reading').hidden, false);
}));

test('finite Moon phase remains visible when Moon position metadata is unavailable', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    const state = ordinaryState();
    calculator.render({
        ...state,
        result: {
            ...state.result,
            moonAzimuthDeg: null,
            moonDirectionLabel: null,
            moonElevationDeg: null,
            moonIsAboveHorizon: null,
            moonScreenAzimuthDeg: null,
        },
    });
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-direction').textContent,
        'Position unavailable');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-name').textContent,
        'Waning Crescent');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__moon-marker').hidden, true);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__reading').hidden, false);
}));

test('GPX prompts and unavailable selections stay inspectable without retaining a stale reading', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'gpx',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    calculator.setPrompt('Select a chart point to calculate the Sun and Moon.');
    const button = calculator.element.querySelector('button');
    const panel = calculator.element.querySelector('.bpb-sun-calculator__panel');
    assert.equal(button.disabled, false);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__summary').textContent,
        'Select a chart point');
    button.click();
    assert.equal(panel.hidden, false);
    assert.match(calculator.element.querySelector('.bpb-sun-calculator__empty').textContent,
        /Select a chart point/);
    const placeholder = calculator.element.querySelector('.bpb-sun-calculator__layout');
    assert.equal(placeholder.hidden, false,
        'the prompt keeps the populated layout in flow so chart hover cannot move itself');
    assert.equal(placeholder.inert, true);
    assert.equal(placeholder.getAttribute('aria-hidden'), 'true');
    assert.equal(calculator.element.dataset.layoutState, 'placeholder');

    calculator.render({ unavailable: 'No track or ascent date is available.' });
    assert.equal(button.disabled, false);
    assert.match(calculator.element.textContent, /No track or ascent date is available/);

    calculator.render({ ...ordinaryState(), zone: null });
    assert.equal(button.disabled, false);
    assert.doesNotMatch(calculator.element.textContent, /Level-horizon sunrise/);

    calculator.render(ordinaryState());
    assert.equal(placeholder.hidden, false);
    assert.equal(placeholder.inert, false);
    assert.equal(placeholder.hasAttribute('aria-hidden'), false);
    assert.equal(calculator.element.dataset.layoutState, undefined);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__empty').hidden, true);
    assert.match(css, /bpb-sun-calculator__summary\s*\{[\s\S]*block-size:\s*2\.7em/);
    assert.match(css, /data-layout-state="placeholder"[\s\S]*visibility:\s*hidden/);
}));

test('recoverable Peak failures retain controls and clear cleanly after a valid selection', () => withDom(dom => {
    const dates = [];
    const minutes = [];
    const frames = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        onDateChange: date => dates.push(date),
        onMinuteChange: minute => minutes.push(minute),
        requestFrame: callback => { frames.push(callback); return frames.length; }, cancelFrame: () => {},
    });
    calculator.render(ordinaryState());
    frames.shift()();
    calculator.setExpanded(true);
    const failed = {
        ...ordinaryState(), result: null, availability: 'recoverable',
        unavailable: 'Sun position is unavailable for this date and time.',
    };
    calculator.render(failed);
    const button = calculator.element.querySelector('button');
    const date = calculator.element.querySelector('input[type="date"]');
    const slider = calculator.element.querySelector('input[type="range"]');
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(date.disabled, false);
    assert.equal(slider.disabled, false);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__reading').hidden, true);
    assert.match(calculator.element.textContent, /unavailable for this date and time/i);

    date.value = '2026-07-11';
    date.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    slider.value = '825';
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    while (frames.length) frames.shift()();
    assert.deepEqual(dates, ['2026-07-11']);
    assert.deepEqual(minutes, [825]);

    calculator.render(ordinaryState({ date: '2026-07-11', minute: 825 }));
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__reading').hidden, false);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__empty').hidden, true);
    assert.match(calculator.element.textContent, /282° WNW/);
}));

test('timezone formatting failure is recoverable but an invalid subject remains terminal', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    const brokenZone = Object.freeze({ timeZone: 'Etc/Unknown', offsetMs: 0, estimated: false });
    calculator.render({ ...ordinaryState(), zone: brokenZone, availability: 'ready' });
    assert.equal(calculator.element.querySelector('button').disabled, false);
    assert.equal(calculator.element.querySelector('input[type="date"]').disabled, false);
    assert.equal(calculator.element.querySelector('input[type="range"]').disabled, false);
    assert.match(calculator.element.textContent, /unavailable for this date and time/i);

    calculator.render({ availability: 'terminal', unavailable: 'Sun position is unavailable.' });
    assert.equal(calculator.element.querySelector('button').disabled, true);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__panel').hidden, true);
}));

test('bearing frames coalesce and cardinal text follows the shortest arc without status spam', () => withDom(dom => {
    const frames = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak', statusDelayMs: 0,
        requestFrame: callback => { frames.push(callback); return frames.length; },
        cancelFrame: () => {},
    });
    calculator.render(ordinaryState({ azimuthDeg: 1, directionLabel: 'N', mapBearing: 359 }));
    calculator.setMapBearing(ordinaryState({ azimuthDeg: 1, directionLabel: 'N', mapBearing: 0 }));
    assert.equal(frames.length, 1, 'multiple bearing writes before paint use one frame');
    frames.shift()();

    calculator.setMapBearing(ordinaryState({ azimuthDeg: 1, directionLabel: 'N', mapBearing: 1 }));
    frames.shift()();
    const north = calculator.element.querySelector('[data-azimuth="0"]');
    assert.match(north.style.transform, /rotate\(-1deg\)/,
        '359 to 1 advances through north by two degrees, not backwards by 358');
    const statusText = calculator.element.querySelector('[role="status"]').textContent;
    calculator.setMapBearing(ordinaryState({ azimuthDeg: 1, directionLabel: 'N', mapBearing: 90 }));
    frames.shift()();
    assert.equal(calculator.element.querySelector('[role="status"]').textContent, statusText);
}));

test('Sun and Moon indicators follow the shortest arc when their azimuth crosses north', () => withDom(dom => {
    const frames = [];
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { frames.push(callback); return frames.length; },
        cancelFrame: () => {},
    });
    const sun = calculator.element.querySelector('.bpb-sun-calculator__sun');
    const moon = calculator.element.querySelector('.bpb-sun-calculator__moon-marker');

    calculator.render(ordinaryState({
        azimuthDeg: 359, directionLabel: 'N', moonAzimuthDeg: 359, moonDirectionLabel: 'N',
    }));
    frames.shift()();
    assert.equal(sun.style.transform, 'rotate(359deg)');
    assert.equal(moon.style.transform, 'rotate(359deg)');

    calculator.render(ordinaryState({
        azimuthDeg: 1, directionLabel: 'N', moonAzimuthDeg: 1, moonDirectionLabel: 'N',
    }));
    frames.shift()();
    assert.equal(sun.style.transform, 'rotate(361deg)',
        '359 to 1 advances through north by two degrees instead of reversing by 358');
    assert.equal(moon.style.transform, 'rotate(361deg)',
        'Moon position uses the same continuous north crossing as the Sun');
}));

test('theme, long timezone fallback, cleanup, and responsive CSS preserve the narrow layout contract', () => withDom(dom => {
    const zone = Object.freeze({ timeZone: null, offsetMs: -8 * 3_600_000, estimated: true });
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'gpx',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    calculator.setTheme('dark');
    calculator.render(ordinaryState({ zone }));
    assert.equal(calculator.element.dataset.theme, 'dark');
    assert.match(calculator.element.textContent, /UTC−8, estimated from longitude/);
    assert.match(calculator.element.querySelector('.bpb-sun-calculator__events-text').textContent,
        /sunrise .* · sunset .* \(UTC−8, estimated from longitude\)$/);
    assert.match(css, /max-inline-size:\s*min\(100%,\s*calc\(100vw - 1rem\)\)/);
    assert.match(css, /min-inline-size:\s*0/);
    assert.match(css, /overflow-wrap:\s*anywhere/);
    assert.match(css, /@media \(max-width: 680px\)/);
    assert.match(css, /@media \(max-width: 440px\)/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /sun--below-horizon/);
    assert.match(css, /moon-marker--below-horizon/);
    assert.match(css, /event-marker\[hidden\]/);
    assert.match(css, /prefers-reduced-motion: reduce[^}]*[\s\S]*moon-marker[^}]*[\s\S]*chevron\s*\{\s*transition:\s*none/s);
    assert.match(css, /bpb-sun-calculator__time\s*\{[^}]*block-size:\s*2\.75rem/s);
    assert.match(css, /::-webkit-slider-runnable-track/);
    assert.match(css, /::-moz-range-track/);
    calculator.dispose();
    assert.equal(dom.window.document.querySelector('.bpb-sun-calculator'), null);
}, { width: 390 }));
