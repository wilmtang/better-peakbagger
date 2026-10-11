// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../src/settings/settings-schema.js';
import { units as Units } from '../src/ui/units.js';

export function initUnitSettings({ save }) {
    const root = document.getElementById('general-units');
    const defaultControl = root.querySelector('#units');
    const details = root.querySelector('details');
    const countLabel = root.querySelector('.unit-custom-count');
    const reset = root.querySelector('#unit-reset');
    const controls = [...root.querySelectorAll('[data-unit]')];
    let current = Schema.clean({});
    let previousCount = null;

    const populate = settings => {
        current = Schema.clean(settings);
        defaultControl.value = current.units;
        const count = controls.filter(control => current[Schema.UNIT_KEYS[control.dataset.unit]] !== 'default').length;
        countLabel.textContent = count ? `${count} custom ${count === 1 ? 'unit' : 'units'}` : 'All use default';
        if (count && (previousCount === null || previousCount === 0)) details.open = true;
        previousCount = count;
        reset.disabled = count === 0;
        for (const control of controls) {
            const measurement = control.dataset.unit;
            control.value = current[Schema.UNIT_KEYS[measurement]];
            control.options[0].textContent = current.units === 'auto'
                ? 'Default (Peakbagger)' : `Default (${Units.symbol(measurement, current.units)})`;
        }
        const system = measurement => Units.resolveUnits(current, null, measurement);
        root.querySelector('.unit-example-heading').textContent = current.units === 'auto'
            ? 'Example readings · Imperial Peakbagger page' : 'Example readings';
        root.querySelector('#unit-example-gpx').textContent = `${Units.formatDistance(20000, system('distance'))} · ${Units.formatElevation(800, system('elevation'))} ascent`;
        root.querySelector('#unit-example-weather').textContent = [
            Units.formatWeather(9, 'temperature', system('temperature')),
            Units.formatWeather(4.2, 'precipitation', system('precipitation')),
            Units.formatWeather(16, 'wind', system('wind'))
        ].join(' · ');
    };
    const update = patch => {
        populate({ ...current, ...patch });
        // The owning options controller restores the confirmed snapshot and
        // shows the shared error if persistence fails.
        void save(patch);
    };
    defaultControl.addEventListener('change', () => update({ units: defaultControl.value }));
    for (const control of controls) control.addEventListener('change', () => update({
        [Schema.UNIT_KEYS[control.dataset.unit]]: control.value
    }));
    reset.addEventListener('click', () => update(Object.fromEntries(Object.values(Schema.UNIT_KEYS).map(key => [key, 'default']))));
    return { populate };
}
