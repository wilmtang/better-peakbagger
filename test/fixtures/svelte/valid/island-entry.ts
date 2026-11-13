// Test-only bundle entry for the browser DOM tier: exposes the typed island
// adapter with the fixture component to a page beside legacy DOM.

import { mountIsland, type Island } from '../../../../src/ui/svelte-island.ts';
import { projectUnitSettings, type UnitSettingsPatch } from '../../../../options/unit-settings-contract.ts';
import UnitsIsland from './UnitsIsland.svelte';

type Props = { settings: ReturnType<typeof projectUnitSettings>; onSave: (patch: UnitSettingsPatch, draft: object) => void };

export interface IslandFixture {
    mount(selector: string, settings: unknown, anchorSelector?: string): void;
    update(settings: unknown): void;
    dispose(): void;
    readonly state: string | null;
    readonly saves: { patch: UnitSettingsPatch; frozen: boolean; plainPrototype: boolean; cloned: unknown; draftCloneError: string | null }[];
}

let island: Island<Props> | null = null;
const saves: IslandFixture['saves'] = [];

const fixture: IslandFixture = {
    mount(selector, settings, anchorSelector) {
        const target = document.querySelector(selector)!;
        island = mountIsland(UnitsIsland, {
            target, ownerWindow: window,
            anchor: anchorSelector ? target.querySelector(anchorSelector) : null,
            props: {
                settings: projectUnitSettings(settings),
                onSave(patch: UnitSettingsPatch, draft: object) {
                    let draftCloneError: string | null = null;
                    try { structuredClone(draft); } catch (error) { draftCloneError = (error as Error).name; }
                    saves.push({ patch, frozen: Object.isFrozen(patch), plainPrototype: Object.getPrototypeOf(patch) === Object.prototype,
                        cloned: structuredClone(patch), draftCloneError });
                },
            },
        });
    },
    update(settings) { island?.update({ settings: projectUnitSettings(settings) }); },
    dispose() { island?.dispose(); },
    get state() { return island?.state ?? null; },
    saves,
};
Object.defineProperty(globalThis, '__bpbIslandFixture', { value: fixture, configurable: true });
