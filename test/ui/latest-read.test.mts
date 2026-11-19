import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestRead, type LatestReadTransaction } from '../../src/ui/latest-read.ts';

test('superseded successes, errors and finalizers cannot own a newer read', () => {
    const reads = createLatestRead(), first = reads.start(), second = reads.start();
    assert.equal(first.signal.aborted, true); assert.equal(first.isCurrent(), false);
    assert.equal(first.finish(), false); assert.equal(reads.pending, true); assert.equal(second.isCurrent(), true);
    assert.equal(second.finish(), true); assert.equal(reads.pending, false);
    assert.equal(second.signal.aborted, false, 'completing a read does not abort a successful transport');
    assert.equal(second.finish(), false);
});
test('cancel invalidates ownership before dispatching abort, including reentrant readers', () => {
    const reads = createLatestRead(), first = reads.start();
    let replacement: LatestReadTransaction | undefined;
    first.signal.addEventListener('abort', () => { assert.equal(first.isCurrent(), false); replacement = reads.start(); });
    reads.cancel();
    assert.ok(replacement, 'the abort listener must start a replacement');
    assert.equal(replacement.isCurrent(), true); assert.equal(reads.pending, true);
    reads.cancel(); assert.equal(replacement.signal.aborted, true); assert.equal(reads.pending, false);
});
test('starting a read publishes its ownership before aborting the previous reader', () => {
    const reads = createLatestRead(), first = reads.start();
    let newest: LatestReadTransaction | undefined;
    first.signal.addEventListener('abort', () => { newest = reads.start(); });
    const superseded = reads.start();
    assert.ok(newest, 'the abort listener must start a reentrant read');
    assert.equal(superseded.signal.aborted, true); assert.equal(superseded.finish(), false); assert.equal(newest.isCurrent(), true);
    reads.cancel();
});
