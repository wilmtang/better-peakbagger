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
} = {}) => {
    const instant = MountainTime.civilToInstant(zone, date, minute);
    return {
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
            sunriseMs: MountainTime.civilToInstant(zone, date, 5 * 60 + 30).ms,
            sunriseDate: date,
            sunriseDayRelation: 'same-day',
            sunsetMs: MountainTime.civilToInstant(zone, date, 20 * 60 + 30).ms,
            sunsetDate: date,
            sunsetDayRelation: 'same-day',
            daylightState,
        },
        unavailable: null,
    };
};

const timeValueText = root => root.querySelector('.bpb-sun-calculator__clock').textContent;

test('Peak calculator is collapsed, labelled, keyboard-native, and emits only time actions', () => withDom(dom => {
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
    assert.match(button.textContent, /Sun position/);
    assert.match(button.textContent, /282° WNW · 17° above horizon/);
    assert.ok(button.querySelector('.bpb-sun-calculator__icon'));
    button.click();
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.hidden, false);

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
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__direction strong').textContent,
        '282° WNW');
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__elevation strong').textContent,
        '17° above horizon');
    assert.equal(calculator.element.querySelectorAll('.bpb-sun-calculator__event-time').length, 2);
    assert.match(calculator.element.querySelector('.bpb-sun-calculator__event-marker').style.insetInlineStart,
        /%$/);
    assert.match(calculator.element.textContent, /Astronomical position at this location/);
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
    calculator.render(ordinaryState({ elevationDeg: -4.6 }));
    frames.shift()();
    assert.equal(calculator.element.querySelector('input[type="date"]'), null);
    assert.match(calculator.element.textContent, /Sun at selected point/);
    assert.match(calculator.element.textContent, /5° below horizon/);
    assert.match(calculator.element.textContent, /GPX point/);
    assert.match(calculator.element.textContent,
        /Recorded at selected GPX point · Mountain Daylight Time \(MDT\)/);
    assert.match(calculator.element.textContent, /Level-horizon sunrise/);

    calculator.render(ordinaryState({ daylightState: 'polar-night' }));
    assert.match(calculator.element.textContent, /does not rise.*polar night/i);
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

test('GPX prompts and unavailable selections stay inspectable without retaining a stale reading', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'gpx',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    calculator.setPrompt('Select a chart point to calculate the sun.');
    const button = calculator.element.querySelector('button');
    const panel = calculator.element.querySelector('.bpb-sun-calculator__panel');
    assert.equal(button.disabled, false);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__summary').textContent,
        'Select a chart point');
    button.click();
    assert.equal(panel.hidden, false);
    assert.match(calculator.element.querySelector('.bpb-sun-calculator__empty').textContent,
        /Select a chart point/);

    calculator.render({ unavailable: 'No track or ascent date is available.' });
    assert.equal(button.disabled, false);
    assert.match(calculator.element.textContent, /No track or ascent date is available/);

    calculator.render({ ...ordinaryState(), zone: null });
    assert.equal(button.disabled, false);
    assert.doesNotMatch(calculator.element.textContent, /Level-horizon sunrise/);

    calculator.render(ordinaryState());
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__layout').hidden, false);
    assert.equal(calculator.element.querySelector('.bpb-sun-calculator__empty').hidden, true);
}));

test('non-actionable unavailable state stays collapsed and disabled', () => withDom(dom => {
    const calculator = SunCalculator.create({
        mount: dom.window.document.getElementById('mount'), mode: 'peak',
        requestFrame: callback => { callback(); return 1; }, cancelFrame: () => {},
    });
    calculator.setUnavailable('Sun position is unavailable.');
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
    assert.match(css, /max-inline-size:\s*100%/);
    assert.match(css, /min-inline-size:\s*0/);
    assert.match(css, /overflow-wrap:\s*anywhere/);
    assert.match(css, /@media \(max-width: 680px\)/);
    assert.match(css, /@media \(max-width: 440px\)/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    calculator.dispose();
    assert.equal(dom.window.document.querySelector('.bpb-sun-calculator'), null);
}, { width: 390 }));
