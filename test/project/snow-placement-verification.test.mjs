// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readSnowCardPlacement } from '../../scripts/verify-peak-snow-cases.mjs';

const row = id => `<tr id="${id}"><td>Card</td></tr>`;
const weather = row('bpb-peak-weather-row'), snow = row('bpb-peak-snow-row');
const read = html => {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    try { return dom.window.eval(`(${readSnowCardPlacement})()`); }
    finally { dom.window.close(); }
};

test('the default snow stack allows other registered cards between weather and snow', () => {
    for (const middle of ['', row('bpb-summit-cloud-row'), row('future-card')]) {
        const state = read(`<table>${weather}${middle}${snow}</table>`);
        assert.ok(state.sameStack && state.followsWeather);
    }
});

test('missing, reversed, and different-column cards still fail the placement contract', () => {
    for (const html of [
        `<table>${snow}${weather}</table>`, `<table>${snow}</table>`,
        `<table>${weather}</table><table>${snow}</table>`, '',
    ]) {
        const state = read(html);
        assert.equal(state.sameStack && state.followsWeather, false, html);
    }
});
