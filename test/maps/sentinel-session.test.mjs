// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentinelSession } from '../../src/maps/sentinel-session.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const now = Date.now() - 86400000;
const capture = (key, time = now) => ({ key, time, platform: 'Sentinel-2B', orbit: '13', coverage: 1, cloud: 0,
    scenes: [{ id: key, bounds: [-122, 46, -121, 47] }] });
const bounds = { getWest: () => -122, getEast: () => -121, getSouth: () => 46, getNorth: () => 47 };
function setup(search, { holdTiles = false } = {}) {
    const statuses = [], scenes = [], selections = []; let cleared = 0, retries = 0, view = { bounds, zoom: 13 };
    const session = createSentinelSession({ readView: () => view, search, onStatus: status => statuses.push(status),
        replaceScenes: value => { scenes.push(value); if (!holdTiles) queueMicrotask(() => session.tileActivity({ pending: false, error: false, complete: true })); },
        clearScenes: () => cleared++, retryTiles: () => retries++, onCapture: value => selections.push(value), debounceMs: 5 });
    return { session, statuses, scenes, selections, status: () => statuses.at(-1), cleared: () => cleared, retries: () => retries, view: value => { view = value; } };
}
test('the headless Sentinel model retains identical sources and updates only fresh coverage', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
    const env = setup(async () => [{ ...capture('same'), coverage: ++calls === 1 ? 1 : 0.5 }]);
    try {
        env.session.activate(); await tick(); assert.equal(env.scenes.length, 1); assert.match(env.status().message, /Coverage 100% · Clouds 0%/);
        env.session.refresh(); assert.equal(env.status().pending, true); assert.doesNotMatch(env.status().message, /Coverage/);
        t.mock.timers.tick(5); await tick(); assert.equal(env.scenes.length, 1); assert.match(env.status().message, /Coverage 50%/);
        assert.match(env.status().captures[0].label, /☁ 0%/); assert.match(env.status().captures[0].title, /Clouds 0%/);
    } finally { env.session.dispose(); }
});
test('Sentinel loading includes imagery tiles while dated capture choices remain usable', async () => {
    const env = setup(async () => [capture('new'), capture('old', now - 86400000)], { holdTiles: true });
    try {
        env.session.activate(); await tick(); assert.equal(env.status().pending, true); assert.equal(env.status().capturePending, false);
        assert.equal(env.status().message, 'Loading imagery'); assert.equal(env.status().captures.length, 2);
        env.session.tileActivity({ pending: true, error: false, complete: false });
        env.session.tileError(new Error('offline')); assert.equal(env.status().pending, false); assert.equal(env.status().retry, true);
        env.session.retry(); await tick(); assert.equal(env.status().pending, true); assert.equal(env.status().retry, true, 'recovery action remains anchored until imagery finishes');
        env.session.tileActivity({ pending: false, error: false, complete: true });
        assert.equal(env.status().pending, false); assert.equal(env.status().retry, false); assert.match(env.status().message, /Coverage/);
    } finally { env.session.dispose(); }
});

test('the overlay capture list preserves the original date, cloud and accessible tooltip format', async () => {
    let searches = 0;
    const captures = [3.4, 0, 100, null].map((cloud, index) => ({ ...capture(`capture-${index}`,
        Date.parse('2026-10-08T01:27:00Z') - index * 86400000), cloud }));
    const env = setup(async () => { searches++; return captures; });
    try {
        env.session.activate(); await tick();
        assert.deepEqual(env.status().captures.map(choice => choice.label), [
            'Latest · 10-07 18:27 · ☁ 3%', '2026-10-06 18:27 · ☁ 0%',
            '2026-10-05 18:27 · ☁ 100%', '2026-10-04 18:27 · ☁ ?',
        ]);
        assert.equal(env.status().captures[0].title, 'Latest · 2026-10-07 18:27 PDT · Clouds 3%');
        assert.equal(env.status().captures[3].title, '2026-10-04 18:27 PDT · Clouds unknown');
        for (const item of captures) env.session.select(item === captures[0] ? 'latest' : item.key);
        assert.equal(searches, 1, 'cloud labels reuse the existing capture catalog');
    } finally { env.session.dispose(); }
});

test('imagery recovery retries the selected capture without another search or source replacement', async () => {
    let calls = 0;
    const env = setup(async () => { calls++; return [capture('new'), capture('old', now - 86400000)]; }, { holdTiles: true });
    try {
        env.session.activate(); await tick(); env.session.select('old');
        env.session.tileActivity({ pending: false, error: true, partial: true, complete: false });
        assert.equal(env.status().partial, true); assert.equal(env.status().captureError, false);
        const before = env.scenes.length; env.session.retry();
        assert.equal(env.retries(), 1); assert.equal(env.scenes.length, before, 'recovery preserves already painted sources');
        assert.equal(calls, 1); assert.equal(env.status().capture, 'old'); assert.equal(env.status().capturePending, false);
        env.session.tileActivity({ pending: false, error: false, complete: true });
        assert.equal(env.status().error, false); assert.equal(env.status().partial, false); assert.match(env.status().message, /Coverage/);
    } finally { env.session.dispose(); }
});
test('catalog failure retains imagery, but choosing a pass cannot reuse coverage from the old view', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0; const pending = [];
    const env = setup(() => ++calls === 1 ? Promise.resolve([capture('new'), capture('old', now - 86400000)])
        : new Promise((resolve, reject) => pending.push({ resolve, reject })));
    try {
        env.session.activate(); await tick(); const count = env.cleared();
        env.session.refresh(); t.mock.timers.tick(5); pending[0].reject(new Error('offline')); await tick();
        assert.equal(env.cleared(), count); assert.match(env.status().message, /Previous imagery/); assert.doesNotMatch(env.status().message, /Coverage/);
        env.session.select('old'); assert.equal(pending.length, 2); assert.equal(env.status().pending, true);
        assert.doesNotMatch(env.status().message, /Coverage/); assert.equal(env.scenes.length, 1);
        pending[1].resolve([{ ...capture('old', now - 86400000), coverage: 0.25 }]); await tick();
        assert.match(env.status().message, /Coverage 25%/); assert.equal(env.scenes.length, 2);
    } finally { env.session.dispose(); }
});
test('a missing pinned pass clears imagery and stays pinned until Latest is explicitly selected', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const old = capture('old', now - 86400000); let catalog = [capture('new'), old];
    const env = setup(async () => catalog);
    try {
        env.session.activate(old); await tick(); assert.equal(env.status().capture, 'old');
        catalog = [capture('new')]; env.session.refresh(); t.mock.timers.tick(5); await tick();
        assert.equal(env.status().capture, 'missing'); assert.match(env.status().message, /does not cover/); assert.equal(env.selections.length, 0);
        env.session.select('latest'); assert.equal(env.selections.at(-1), null); assert.equal(env.status().capture, 'latest');
    } finally { env.session.dispose(); }
});
test('catalog cooldown survives off/on and ignores refresh and retry activation', async () => {
    let calls = 0; const retryAt = Date.now() + 120000;
    const env = setup(async () => { calls++; throw Object.assign(new Error('limited'), { code: 'rate-limit', retryAt }); });
    try {
        env.session.activate(); await tick(); assert.equal(env.status().retryAt, retryAt);
        env.session.deactivate(); env.session.activate(); env.session.refresh(); env.session.retry(); await tick();
        assert.equal(calls, 1); assert.equal(env.status().retry, true);
    } finally { env.session.dispose(); }
});
test('overlapping imagery failures cannot shorten or erase an active capture cooldown', async () => {
    let calls = 0;
    const retryAt = Date.now() + 600000;
    const env = setup(async () => { calls++; return [capture('new')]; });
    try {
        env.session.activate(); await tick();
        for (const deadline of [retryAt, Date.now() + 5000, undefined]) {
            env.session.tileError(Object.assign(new Error('limited'), { code: 'rate-limit', retryAt: deadline }));
            assert.equal(env.status().retryAt, retryAt);
        }
        env.session.deactivate(); env.session.activate(); env.session.retry(); await tick(); assert.equal(calls, 1);
    } finally { env.session.dispose(); }
});
test('imagery rate limits without Retry-After receive the standard fallback cooldown', async () => {
    const now = Date.now(), env = setup(async () => [capture('new')]);
    try {
        env.session.activate(); await tick(); env.session.tileError(Object.assign(new Error('limited'), { code: 'rate-limit' }));
        assert.ok(env.status().retryAt >= now + 300000);
    } finally { env.session.dispose(); }
});
test('off aborts the owner and stale catalog replies cannot install imagery', async () => {
    const pending = []; const env = setup((_bounds, options) => new Promise(resolve => pending.push({ options, resolve })));
    try {
        env.session.activate(); env.session.deactivate(); assert.equal(pending[0].options.signal.aborted, true);
        env.session.activate(); pending[0].resolve([capture('stale')]); await tick(); assert.equal(env.scenes.length, 0);
        pending[1].resolve([capture('current')]); await tick(); assert.equal(env.scenes[0][0].id, 'current');
    } finally { env.session.dispose(); }
});
