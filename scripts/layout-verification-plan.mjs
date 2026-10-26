// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';

export function layoutVerificationPlan(args, surfaces) {
    assert.ok(surfaces.length && new Set(surfaces).size === surfaces.length, 'Layout surfaces must be nonempty and unique');
    for (const argument of args) assert.ok(/^(--chrome-only|--firefox-only|--preflight|--surface=.+|--shard=\d+\/\d+)$/.test(argument), `Unknown layout argument: ${argument}`);
    for (const prefix of ['--surface=', '--shard=']) assert.ok(args.filter(arg => arg.startsWith(prefix)).length <= 1, `Duplicate layout selection: ${prefix}`);
    assert.ok(!(args.includes('--chrome-only') && args.includes('--firefox-only')), 'Choose only one layout browser');
    const surface = args.find(arg => arg.startsWith('--surface='))?.slice('--surface='.length);
    const preflight = args.includes('--preflight');
    assert.ok(!preflight || !args.some(arg => arg.startsWith('--surface=') || arg.startsWith('--shard=')), 'Preflight cannot be combined with surface or shard selections');
    assert.ok(!surface || surfaces.includes(surface), `Unknown layout surface: ${surface}`);
    const shard = args.find(arg => arg.startsWith('--shard='))?.slice('--shard='.length).split('/').map(Number) || [1, 1];
    const zooms = ['timestamps', 'ascent-columns', 'peak-columns', 'report-filter'].includes(surface) ? [1, 1.5] : [1];
    const variants = preflight ? [{ theme: 'light', width: 390, zoom: 1 }]
        : ['light', 'dark'].flatMap(theme => [390, 1280].flatMap(width => zooms.map(zoom => ({ theme, width, zoom }))));
    assert.ok(shard.every(Number.isSafeInteger) && shard[0] >= 1 && shard[0] <= shard[1] && shard[1] <= variants.length,
        'Invalid layout shard: select a nonempty partition of the variants');
    const browsers = args.includes('--chrome-only') ? ['chrome'] : args.includes('--firefox-only') ? ['firefox'] : ['chrome', 'firefox'];
    const selectedSurfaces = preflight ? ['popup', 'timestamps', 'settings', 'maps'] : surface ? [surface] : surfaces;
    assert.ok(selectedSurfaces.every(value => surfaces.includes(value)), 'Preflight requires registered production fixtures');
    const cases = browsers.flatMap(browser => variants.flatMap((variant, index) => index % shard[1] !== shard[0] - 1 ? []
        : selectedSurfaces.map(surface => ({ browser, surface, ...variant,
            name: `${browser}-${variant.theme}-${variant.width}${variant.zoom === 1 ? '' : '-zoom150'}` }))));
    assert.ok(cases.length > 0, 'Layout verification must select at least one case');
    return { cases, shard: shard.join('/'), surface };
}
