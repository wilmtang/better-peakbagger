import assert from 'node:assert/strict';
import test from 'node:test';
import {
    HIDDEN_TILE_TRANSIENT_BUDGET_MS,
    VISIBLE_TRANSIENT_BUDGET_MS,
    tiltTransientFailure,
} from '../../scripts/terrain-lod-criteria.mts';

const step = (overrides = {}) => ({
    visibleLevels: 0, visibleShortUntilMs: 0, tileLevels: 0, tileShortUntilMs: 0, ...overrides,
});

test('a deep visible fallback keeps the tight budget even when tiles are within theirs', () => {
    const atBudget = { visibleLevels: 2, visibleShortUntilMs: VISIBLE_TRANSIENT_BUDGET_MS, tileLevels: 2, tileShortUntilMs: VISIBLE_TRANSIENT_BUDGET_MS };
    assert.equal(tiltTransientFailure(step(atBudget)), null);
    assert.deepEqual(
        tiltTransientFailure(step({ ...atBudget, visibleShortUntilMs: VISIBLE_TRANSIENT_BUDGET_MS + 1, tileShortUntilMs: VISIBLE_TRANSIENT_BUDGET_MS + 1 })),
        { scope: 'visible', durationMs: VISIBLE_TRANSIENT_BUDGET_MS + 1, budgetMs: VISIBLE_TRANSIENT_BUDGET_MS },
    );
});

test('a deep hidden-tile fallback may outlast the visible budget but stays bounded', () => {
    const hidden = { tileLevels: 4, tileShortUntilMs: HIDDEN_TILE_TRANSIENT_BUDGET_MS };
    assert.ok(HIDDEN_TILE_TRANSIENT_BUDGET_MS > VISIBLE_TRANSIENT_BUDGET_MS);
    assert.equal(tiltTransientFailure(step(hidden)), null);
    assert.deepEqual(
        tiltTransientFailure(step({ ...hidden, tileShortUntilMs: HIDDEN_TILE_TRANSIENT_BUDGET_MS + 1 })),
        { scope: 'hidden tile', durationMs: HIDDEN_TILE_TRANSIENT_BUDGET_MS + 1, budgetMs: HIDDEN_TILE_TRANSIENT_BUDGET_MS },
    );
});

test('a one-level shortfall has no time limit', () => {
    assert.equal(tiltTransientFailure(step({
        visibleLevels: 1, visibleShortUntilMs: 5000, tileLevels: 1, tileShortUntilMs: 5000,
    })), null);
});
