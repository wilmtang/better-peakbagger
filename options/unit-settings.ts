// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountIsland } from '../src/ui/svelte-island.ts';
import UnitSettingsPanel from './UnitSettingsPanel.svelte';
import {
    projectUnitSettings,
    type UnitSettings, type UnitSettingsOptions, type UnitSettingsOwner, type UnitSettingsPatch,
} from './unit-settings-contract.ts';

export function initUnitSettings({ save }: UnitSettingsOptions): UnitSettingsOwner {
    const root = document.querySelector<HTMLElement>('#general-units');
    const host = root?.querySelector<HTMLElement>('[data-unit-settings]');
    if (!root || !host) throw new Error('Units settings markup is missing [data-unit-settings].');

    let current: UnitSettings = projectUnitSettings({});
    const island = mountIsland(UnitSettingsPanel, {
        target: host,
        ownerWindow: window,
        props: {
            settings: current,
            onSave(patch: UnitSettingsPatch) {
                current = projectUnitSettings({ ...current, ...patch });
                island.update({ settings: current });
                // The owning options controller restores the confirmed snapshot and
                // shows the shared error if persistence fails.
                void save(patch);
            },
        },
    });

    return {
        populate(settings: unknown) {
            current = projectUnitSettings(settings);
            island.update({ settings: current });
        },
    };
}
