// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import type test from 'node:test';

export interface CardDragEnvironment {
    position(): string | undefined;
    active(): boolean;
    start(): void;
    smallMove(): void;
    move(pointerId: number): void;
    finish(pointerId: number): void;
    interrupt(reason: string): void;
    close(): void;
}

// Run the same input invariants against real layout adapters and their native
// fixtures. The adapter supplies destinations; this contract never moves nodes.
export function registerCardDragContract(register: typeof test, name: string, setup: () => CardDragEnvironment | Promise<CardDragEnvironment>) {
    register(`${name}: shared pointer threshold and ownership contract`, async () => {
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
        register(`${name}: shared ${reason} cancellation contract`, async () => {
            const env = await setup();
            try {
                const before = env.position(); env.start(); env.move(1); assert.equal(env.active(), true);
                env.interrupt(reason); assert.equal(env.active(), false); assert.equal(env.position(), before);
                env.finish(1); assert.equal(env.position(), before, 'release after cancellation never commits');
            } finally { env.close(); }
        });
    }
}
