// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one rune module behind src/ui/svelte-island.ts: a reactive props object
// a mounted component reads, which plain TypeScript can update. Controllers
// never import this module; they go through the island adapter.

export interface IslandProps<Props extends object> {
    readonly value: Props;
    update(patch: Partial<Props>): void;
}

export function createIslandProps<Props extends object>(initial: Props): IslandProps<Props> {
    const value = $state({ ...initial });
    return {
        value,
        update(patch) { Object.assign(value, patch); },
    };
}
