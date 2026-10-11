import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryCooldown } from '../../src/ui/retry-cooldown.js';

test('known cooldown expires without a request and parks its timer on page suspension', () => {
    let now = 1000, queued = null, blocked = false;
    const gate = createRetryCooldown(value => { blocked = value; }, { now: () => now,
        schedule: fn => { queued = fn; return 1; }, cancel: () => { queued = null; } });
    gate.set(2000); assert.equal(blocked, true); assert.equal(gate.active(), true);
    gate.suspend(); assert.equal(queued, null);
    now = 2001; gate.resume(); assert.equal(blocked, false); assert.equal(queued, null);
    gate.set(now + 100); now += 101; queued(); assert.equal(blocked, false);
    gate.set(now + 100); gate.dispose(); assert.equal(queued, null); assert.equal(gate.active(), false);
});
test('missing or unreasonable retry timestamps never leave an action permanently disabled', () => {
    const values = [];
    const gate = createRetryCooldown(value => values.push(value), { now: () => 1000 });
    for (const value of [null, undefined, NaN, 0, 1000 + 25 * 3600_000]) gate.set(value);
    assert.equal(values.every(value => value === false), true); gate.dispose();
});
