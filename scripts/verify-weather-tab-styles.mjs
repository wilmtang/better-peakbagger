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
}
