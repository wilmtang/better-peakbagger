import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryCooldown } from '../../src/ui/retry-cooldown.ts';

test('known cooldown expires without a request and parks its timer on page suspension', () => {
    let now = 1000, blocked = false;
    const timer: { queued: (() => void) | null } = { queued: null };
    const scheduled = () => timer.queued;
    const gate = createRetryCooldown(value => { blocked = value; }, { now: () => now,
        schedule: fn => { timer.queued = fn; return 1; }, cancel: () => { timer.queued = null; } });
    gate.set(2000); assert.equal(blocked, true); assert.equal(gate.active(), true);
    gate.suspend(); assert.equal(scheduled(), null);
    now = 2001; gate.resume(); assert.equal(blocked, false); assert.equal(scheduled(), null);
    gate.set(now + 100);
    now += 101;
    const callback = scheduled();
    assert.ok(callback, 'a known cooldown must schedule its expiry');
    callback();
    assert.equal(blocked, false);
    gate.set(now + 100); gate.dispose(); assert.equal(scheduled(), null); assert.equal(gate.active(), false);
});
test('missing or unreasonable retry timestamps never leave an action permanently disabled', () => {
    const values: boolean[] = [];
    const gate = createRetryCooldown(value => values.push(value), { now: () => 1000 });
    for (const value of [null, undefined, NaN, 0, 1000 + 25 * 3600_000]) gate.set(value);
    assert.equal(values.every(value => value === false), true); gate.dispose();
});
