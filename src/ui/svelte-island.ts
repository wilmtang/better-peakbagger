// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed mount/update/dispose adapter for one Svelte component placed beside
// legacy DOM (an "island"). The owning controller keeps its own state and
// persistence; it hands the island props and receives callbacks.
//
// Lifetime follows src/ui/page-lifecycle.ts: a persisted pagehide (BFCache)
// suspends the island, holding prop updates until pageshow resumes it; a
// final pagehide or dispose() unmounts it and removes only the DOM it created.
// A disposed island ignores updates, and the same target can host a new island
// later, for example when a feature is re-enabled.

import { flushSync, mount, unmount, type Component } from 'svelte';
import { createIslandProps } from './svelte-island-props.svelte.ts';
import { createPageLifecycle, type PageLifecycleState, type PageLifecycleWindow } from './page-lifecycle.ts';

export interface IslandOptions<Props extends object> {
    readonly target: Element;
    readonly props: Props;
    readonly ownerWindow?: PageLifecycleWindow | null;
    // Insert before this child of target instead of appending, so the island
    // can sit between legacy siblings.
    readonly anchor?: Node | null;
}

export interface Island<Props extends object> {
    readonly state: PageLifecycleState;
    update(patch: Partial<Props>): void;
    dispose(): void;
}

export function mountIsland<Props extends object>(
    component: Component<Props>,
    { target, props, ownerWindow, anchor = null }: IslandOptions<Props>,
): Island<Props> {
    const reactive = createIslandProps(props);
    let instance: Record<string, unknown> | null = null;
    let held: Partial<Props> | null = null;
    // The lifecycle exists before anything renders, so a mount or first-flush
    // failure can dispose what was created instead of orphaning it.
    const lifecycle = createPageLifecycle({
        ownerWindow,
        onResume: () => {
            if (!held) return;
            const patch = held;
            held = null;
            reactive.update(patch);
            flushSync();
        },
        onDispose: () => {
            held = null;
            if (instance) void unmount(instance);
            instance = null;
        },
    });
    try {
        // Components declare props as interfaces, which svelte's
        // `Record<string, any>` constraint on mount() does not admit; the
        // component and its props were already checked against each other
        // through `Component<Props>`.
        instance = mount(component as unknown as Component<Record<string, unknown>>,
            { target, anchor: anchor ?? undefined, props: reactive.value as Record<string, unknown> });
        flushSync();
    } catch (error) {
        lifecycle.dispose();
        throw error;
    }
    return Object.freeze({
        get state() { return lifecycle.state; },
        update(patch: Partial<Props>) {
            if (lifecycle.state === 'disposed') return;
            if (lifecycle.state === 'suspended') {
                held = { ...held, ...patch };
                return;
            }
            reactive.update(patch);
            flushSync();
        },
        dispose: () => lifecycle.dispose(),
    });
}
