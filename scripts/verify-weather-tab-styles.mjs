// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, getComputedStyle */
import assert from 'node:assert/strict';

export async function verifyWeatherTabStyles(evaluate, selector) {
    const styles = await evaluate(selector => [...document.querySelectorAll(selector)].map(button => ({
        selected: button.getAttribute('aria-selected') === 'true',
        background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color,
    })), selector);
    const selected = styles.find(style => style.selected), idle = styles.find(style => !style.selected);
    assert.ok(selected && idle, `missing weather tabs: ${JSON.stringify(styles)}`);
    assert.notEqual(selected.background, idle.background, `selected weather pill erased: ${JSON.stringify(styles)}`);
    assert.notEqual(selected.color, idle.color, `selected weather label erased: ${JSON.stringify(styles)}`);
    const palette = await evaluate(selector => {
        const card = document.querySelector(selector).closest('#bpb-ascent-weather, #bpb-peak-weather');
        const low = card.querySelector('.bpb-week-low, .bpb-weather-low'), high = card.querySelector('.bpb-week-high, .bpb-weather-high');
        const cloud = card.querySelector('.bpb-weather-symbol__cloud');
        return { text: getComputedStyle(card).color, title: getComputedStyle(card.querySelector('h2')).color,
            low: low && getComputedStyle(low).color, high: high && getComputedStyle(high).color,
            cloud: cloud && getComputedStyle(cloud).fill };
    }, selector);
    assert.equal(palette.title, palette.text, `site heading repaint overrides weather title: ${JSON.stringify(palette)}`);
    if (palette.low && palette.high) {
        assert.equal(palette.low, palette.text, `daily low must use normal text color: ${JSON.stringify(palette)}`);
        assert.equal(palette.high, palette.text, `daily high must use normal text color: ${JSON.stringify(palette)}`);
    }
    if (palette.cloud) assert.notEqual(palette.cloud, palette.text, `weather illustration lost its palette: ${JSON.stringify(palette)}`);
}
