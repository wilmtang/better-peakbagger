// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { readSnowCardPlacement } from '../../scripts/page-probes.mts';

const row = (id: string) => `<tr id="${id}"><td>Card</td></tr>`;
const weather = row('bpb-peak-weather-row'), snow = row('bpb-peak-snow-row');
const read = (html: string) => {
    const dom = new FixtureDom(html);
    try { return dom.window.eval(`(${readSnowCardPlacement})()`) as ReturnType<typeof readSnowCardPlacement>; }
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
