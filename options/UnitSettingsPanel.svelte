<!-- Copyright (C) 2026 wilmtang <wilm.tang@outlook.com> -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
    import { settingsSchema as Schema } from '../src/settings/settings-schema.ts';
    import { units as Units } from '../src/ui/units.js';
    import {
        resetUnitOverridesPatch, unitSettingsPatch,
        type UnitMeasurement, type UnitSettings, type UnitSettingsPatch,
    } from './unit-settings-contract.ts';

    interface Props {
        settings: UnitSettings;
        onSave: (patch: UnitSettingsPatch) => void;
    }

    interface MeasurementControl {
        readonly id: string;
        readonly measurement: UnitMeasurement;
        readonly key: (typeof Schema.UNIT_KEYS)[UnitMeasurement];
        readonly title: string;
        readonly description?: string;
        readonly imperialLabel: string;
        readonly metricLabel: string;
    }

    const MEASUREMENT_CONTROLS: readonly MeasurementControl[] = [
        {
            id: 'distance-units',
            measurement: 'distance',
            key: Schema.UNIT_KEYS.distance,
            title: 'Distance',
            imperialLabel: 'Miles (mi)',
            metricLabel: 'Kilometers (km)',
        },
        {
            id: 'elevation-units',
            measurement: 'elevation',
            key: Schema.UNIT_KEYS.elevation,
            title: 'Elevation',
            description: 'Includes ascent and descent.',
            imperialLabel: 'Feet (ft)',
            metricLabel: 'Meters (m)',
        },
        {
            id: 'temperature-units',
            measurement: 'temperature',
            key: Schema.UNIT_KEYS.temperature,
            title: 'Temperature',
            description: 'Includes feels like.',
            imperialLabel: 'Fahrenheit (°F)',
            metricLabel: 'Celsius (°C)',
        },
        {
            id: 'precipitation-units',
            measurement: 'precipitation',
            key: Schema.UNIT_KEYS.precipitation,
            title: 'Precipitation',
            description: 'Rain and snow water equivalent.',
            imperialLabel: 'Inches (in)',
            metricLabel: 'Millimeters (mm)',
        },
        {
            id: 'wind-units',
            measurement: 'wind',
            key: Schema.UNIT_KEYS.wind,
            title: 'Wind speed',
            description: 'Includes gusts.',
            imperialLabel: 'Miles per hour (mph)',
            metricLabel: 'Kilometers per hour (km/h)',
        },
    ];

    const HEADING_SIZING_LABEL = 'Example readings · Imperial Peakbagger page';
    const GPX_SIZING_LABEL = `${Units.formatDistance(20000, 'metric')} · ${Units.formatElevation(800, 'imperial')} ascent`;
    const WEATHER_SIZING_LABEL = [
        Units.formatWeather(9, 'temperature', 'imperial'),
        Units.formatWeather(4.2, 'precipitation', 'metric'),
        Units.formatWeather(16, 'wind', 'metric'),
    ].join(' · ');

    const { settings, onSave }: Props = $props();

    let detailsElement: HTMLDetailsElement | undefined;
    let previousCount: number | null = null;

    const customCount = $derived(
        MEASUREMENT_CONTROLS.filter(({ key }) => settings[key] !== 'default').length,
    );
    const customCountLabel = $derived(
        customCount ? `${customCount} custom ${customCount === 1 ? 'unit' : 'units'}` : 'All use default',
    );
    const system = (measurement: UnitMeasurement) => Units.resolveUnits(settings, null, measurement);
    const defaultOptionLabel = (measurement: UnitMeasurement) => settings.units === 'auto'
        ? 'Default (Peakbagger)' : `Default (${Units.symbol(measurement, settings.units)})`;

    const exampleHeading = $derived(
        settings.units === 'auto' ? HEADING_SIZING_LABEL : 'Example readings',
    );
    const gpxExample = $derived(
        `${Units.formatDistance(20000, system('distance'))} · ${Units.formatElevation(800, system('elevation'))} ascent`,
    );
    const weatherExample = $derived([
        Units.formatWeather(9, 'temperature', system('temperature')),
        Units.formatWeather(4.2, 'precipitation', system('precipitation')),
        Units.formatWeather(16, 'wind', system('wind')),
    ].join(' · '));

    $effect(() => {
        const count = customCount;
        if (count > 0 && (previousCount === null || previousCount === 0) && detailsElement) {
            detailsElement.open = true;
        }
        previousCount = count;
    });

    const listen = (eventName: string, handler: (event: Event) => void) => (element: HTMLElement) => {
        element.addEventListener(eventName, handler);
        return () => element.removeEventListener(eventName, handler);
    };

    const handleDefaultChange = (event: Event) => {
        const control = event.currentTarget as HTMLSelectElement;
        onSave(unitSettingsPatch({ units: control.value }));
    };

    const handleMeasurementChange = (
        key: MeasurementControl['key'],
        event: Event,
    ) => {
        const control = event.currentTarget as HTMLSelectElement;
        onSave(unitSettingsPatch({ [key]: control.value }));
    };

    const handleReset = () => {
        onSave(resetUnitOverridesPatch());
    };
</script>

<div class="card">
    <div class="row">
        <label class="label" for="units">
            <span class="title">Default units</span>
            <span class="desc">Display units across Better Peakbagger, unless you choose a specific unit below.</span>
        </label>
        <div class="control">
            <select id="units" value={settings.units} {@attach listen('change', handleDefaultChange)}>
                <option value="auto">Follow Peakbagger</option>
                <option value="imperial">Imperial</option>
                <option value="metric">Metric</option>
            </select>
        </div>
    </div>
    <div class="unit-example" aria-live="polite" aria-atomic="true">
        <div class="unit-example-heading" data-sizing-label={HEADING_SIZING_LABEL}><span>{exampleHeading}</span></div>
        <dl>
            <dt>GPX</dt><dd id="unit-example-gpx" data-sizing-label={GPX_SIZING_LABEL}><span>{gpxExample}</span></dd>
            <dt>Weather</dt><dd id="unit-example-weather" data-sizing-label={WEATHER_SIZING_LABEL}><span>{weatherExample}</span></dd>
        </dl>
    </div>
    <details id="unit-customize" class="unit-customize" bind:this={detailsElement}>
        <summary>Customize units<span class="unit-custom-count">{customCountLabel}</span></summary>
        {#each MEASUREMENT_CONTROLS as control (control.id)}
            <div class="row">
                <label class="label" for={control.id}>
                    <span class="title">{control.title}</span>
                    {#if control.description}
                        <span class="desc">{control.description}</span>
                    {/if}
                </label>
                <div class="control">
                    <select
                        id={control.id}
                        data-unit={control.measurement}
                        value={settings[control.key]}
                        {@attach listen('change', event => handleMeasurementChange(control.key, event))}
                    >
                        <option value="default">{defaultOptionLabel(control.measurement)}</option>
                        <option value="imperial">{control.imperialLabel}</option>
                        <option value="metric">{control.metricLabel}</option>
                    </select>
                </div>
            </div>
        {/each}
        <div class="unit-reset-row">
            <button
                type="button"
                class="panel-button secondary"
                id="unit-reset"
                disabled={customCount === 0}
                onclick={handleReset}
            >Use default for all</button>
        </div>
    </details>
</div>
