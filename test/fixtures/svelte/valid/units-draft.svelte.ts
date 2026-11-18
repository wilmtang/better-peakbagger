// Test-only rune module: an editable draft of the Units projection, held as
// nested $state so saves exercise the patch builder with real Svelte proxies.

import type { UnitSettings } from '../../../../options/unit-settings-contract.ts';

export type UnitsDraftState = { -readonly [Key in keyof UnitSettings]: UnitSettings[Key] } & { history: { edits: number } };

export function createUnitsDraft(read: () => UnitSettings) {
    const state: UnitsDraftState = $state({ ...read(), history: { edits: 0 } });
    $effect.pre(() => { Object.assign(state, read()); });
    const customCount = $derived(Object.entries(state)
        .filter(([key, value]) => key !== 'units' && key !== 'history' && value !== 'default').length);
    return {
        state,
        get customCount() { return customCount; },
    };
}
