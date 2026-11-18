// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../src/settings/settings-schema.ts';
import { units as Units } from '../src/ui/units.js';
import {
    isUnitMeasurement, projectUnitSettings, resetUnitOverridesPatch, unitSettingsPatch,
    type UnitMeasurement, type UnitSettings, type UnitSettingsOptions, type UnitSettingsOwner, type UnitSettingsPatch,
} from './unit-settings-contract.ts';

const required = <T extends Element>(root: ParentNode, selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Units settings markup is missing ${selector}.`);
    return element;
};

export function initUnitSettings({ save }: UnitSettingsOptions): UnitSettingsOwner {
    const root = required<HTMLElement>(document, '#general-units');
    const defaultControl = required<HTMLSelectElement>(root, '#units');
    const details = required<HTMLDetailsElement>(root, 'details');
    const countLabel = required<HTMLElement>(root, '.unit-custom-count');
    const reset = required<HTMLButtonElement>(root, '#unit-reset');
    const controls = [...root.querySelectorAll<HTMLSelectElement>('[data-unit]')].map(control => {
        const measurement = control.dataset.unit;
        if (!isUnitMeasurement(measurement)) throw new Error(`Unknown unit control ${String(measurement)}.`);
        return { control, measurement, key: Schema.UNIT_KEYS[measurement] };
    });
    let current: UnitSettings = projectUnitSettings({});
    let previousCount: number | null = null;
    const sizing = [
        ['.unit-example-heading', 'Example readings · Imperial Peakbagger page'],
        ['#unit-example-gpx', `${Units.formatDistance(20000, 'metric')} · ${Units.formatElevation(800, 'imperial')} ascent`],
        ['#unit-example-weather', `${Units.formatWeather(9, 'temperature', 'imperial')} · ${Units.formatWeather(4.2, 'precipitation', 'metric')} · ${Units.formatWeather(16, 'wind', 'metric')}`],
    ] as const;
    for (const [selector, label] of sizing) {
        const element = required<HTMLElement>(root, selector);
        element.dataset.sizingLabel = label;
        element.replaceChildren(document.createElement('span'));
    }
    const example = (selector: string) => required<HTMLSpanElement>(root, `${selector} > span`);

    const populate = (settings: unknown) => {
        current = projectUnitSettings(settings);
        defaultControl.value = current.units;
        const count = controls.filter(({ key }) => current[key] !== 'default').length;
        countLabel.textContent = count ? `${count} custom ${count === 1 ? 'unit' : 'units'}` : 'All use default';
        if (count && (previousCount === null || previousCount === 0)) details.open = true;
        previousCount = count;
        reset.disabled = count === 0;
        for (const { control, measurement, key } of controls) {
            control.value = current[key];
            control.options[0]!.textContent = current.units === 'auto'
                ? 'Default (Peakbagger)' : `Default (${Units.symbol(measurement, current.units)})`;
        }
        const system = (measurement: UnitMeasurement) => Units.resolveUnits(current, null, measurement);
        example('.unit-example-heading').textContent = current.units === 'auto'
            ? 'Example readings · Imperial Peakbagger page' : 'Example readings';
        example('#unit-example-gpx').textContent = `${Units.formatDistance(20000, system('distance'))} · ${Units.formatElevation(800, system('elevation'))} ascent`;
        example('#unit-example-weather').textContent = [
            Units.formatWeather(9, 'temperature', system('temperature')),
            Units.formatWeather(4.2, 'precipitation', system('precipitation')),
            Units.formatWeather(16, 'wind', system('wind'))
        ].join(' · ');
    };
    const update = (patch: UnitSettingsPatch) => {
        populate({ ...current, ...patch });
        // The owning options controller restores the confirmed snapshot and
        // shows the shared error if persistence fails.
        void save(patch);
    };
    defaultControl.addEventListener('change', () => update(unitSettingsPatch({ units: defaultControl.value })));
    for (const { control, key } of controls) control.addEventListener('change', () => update(unitSettingsPatch({
        [key]: control.value
    })));
    reset.addEventListener('click', () => update(resetUnitOverridesPatch()));
    return { populate };
}
