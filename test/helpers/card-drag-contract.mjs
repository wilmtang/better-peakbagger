import assert from 'node:assert/strict';

// Run the same input invariants against real layout adapters and their native
// fixtures. The adapter supplies destinations; this contract never moves nodes.
export function registerCardDragContract(test, name, setup) {
    test(`${name}: shared pointer threshold and ownership contract`, async () => {
        const env = await setup();
        try {
            const before = env.position(); env.start(); env.smallMove(); assert.equal(env.active(), false);
            env.move(2); assert.equal(env.active(), false, 'another pointer cannot activate the gesture');
            env.move(1); assert.equal(env.active(), true); assert.equal(env.position(), before);
            env.finish(2); assert.equal(env.active(), true, 'another pointer cannot drop the card');
            env.finish(1); assert.equal(env.active(), false); assert.notEqual(env.position(), before);
        } finally { env.close(); }
    });
    for (const reason of ['Escape', 'blur', 'resize', 'pointercancel', 'lostpointercapture']) {
        test(`${name}: shared ${reason} cancellation contract`, async () => {
            const env = await setup();
            try {
                const before = env.position(); env.start(); env.move(1); assert.equal(env.active(), true);
                env.interrupt(reason); assert.equal(env.active(), false); assert.equal(env.position(), before);
                env.finish(1); assert.equal(env.position(), before, 'release after cancellation never commits');
            } finally { env.close(); }
        });
    }
}
