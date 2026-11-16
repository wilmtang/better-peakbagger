// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the Units settings panel's boundary.
//
// The panel reads a projection of the settings and writes only its own keys.
// Values are validated through the shared settings schema, never a local copy
// of its allowed values. Patches are rebuilt as frozen plain data from the
// allowlist, so a reactive proxy or an object carrying unrelated fields can be
// handed in and only cloneable, approved fields reach `set` and the wire.

import { settingsSchema as Schema } from '../src/settings/settings-schema.ts';

export type UnitDefault = 'auto' | 'imperial' | 'metric';
export type UnitOverride = 'default' | 'imperial' | 'metric';
export type UnitMeasurement = keyof typeof Schema.UNIT_KEYS;
export type UnitOverrideKey = (typeof Schema.UNIT_KEYS)[UnitMeasurement];
export type UnitSettingKey = 'units' | UnitOverrideKey;

export type UnitSettings = { readonly units: UnitDefault } & { readonly [Key in UnitOverrideKey]: UnitOverride };
export type UnitSettingsPatch = Partial<UnitSettings>;

export const UNIT_SETTING_KEYS: readonly UnitSettingKey[] = Object.freeze(['units', ...Object.values(Schema.UNIT_KEYS)]);

export const isUnitMeasurement = (value: unknown): value is UnitMeasurement =>
    typeof value === 'string' && Object.hasOwn(Schema.UNIT_KEYS, value);

// Any stored, imported or replied settings value becomes the panel's view.
export const projectUnitSettings = (settings: unknown): UnitSettings => {
    const current = Schema.clean(settings) as Record<UnitSettingKey, string>;
    return Object.freeze(Object.fromEntries(UNIT_SETTING_KEYS.map(key => [key, current[key]]))) as UnitSettings;
};

// Builds the only patch shape the panel may send. Unapproved keys are dropped;
// an approved key with a value the schema would rewrite is a programming error.
export const unitSettingsPatch = (input: { readonly [Key in UnitSettingKey]?: unknown }): UnitSettingsPatch => {
    const patch: Partial<Record<UnitSettingKey, string>> = {};
    for (const key of UNIT_SETTING_KEYS) {
        if (!Object.hasOwn(input, key)) continue;
        const value = input[key];
        if (typeof value !== 'string' || (Schema.clean({ [key]: value }) as Record<string, unknown>)[key] !== value) {
            throw new RangeError(`Unsupported ${key} setting.`);
        }
        patch[key] = value;
    }
    return Object.freeze(patch) as UnitSettingsPatch;
};

// Every override back to the default unit; the default system is untouched.
export const resetUnitOverridesPatch = (): UnitSettingsPatch =>
    unitSettingsPatch(Object.fromEntries(Object.values(Schema.UNIT_KEYS).map(key => [key, 'default'])));

// The options controller owns persistence: its write queue, confirmed
// snapshot, rollback and feedback. The panel only hands it validated patches.
export type UnitSettingsSave = (patch: UnitSettingsPatch) => Promise<unknown>;

export interface UnitSettingsOptions {
    readonly save: UnitSettingsSave;
}

export interface UnitSettingsOwner {
    populate(settings: unknown): void;
}
